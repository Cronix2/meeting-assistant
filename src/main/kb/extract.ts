import fs from 'node:fs'
import type { Dirent } from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

/**
 * Lecture des fichiers : on en tire du texte brut + un « type » (code ou texte) qui décide du découpage.
 * Aucun appel réseau. Le PDF passe par `unpdf` (chargé à la demande) avec un petit lecteur de secours.
 */

export type DocKind = 'code' | 'text'
export interface Extracted {
  text: string
  kind: DocKind
}

const CODE_EXT = new Set(
  (
    'c h cc cpp cxx hpp hh cs java kt kts scala go rs swift m mm py pyw rb php pl pm lua r jl dart ' +
    'js jsx mjs cjs ts tsx vue svelte astro css scss sass less sh bash zsh fish ps1 psm1 bat cmd ' +
    'sql graphql gql proto tf tfvars hcl yml yaml toml ini cfg conf env json jsonc json5 xml xsd xsl csv tsv log ' +
    'dockerfile makefile cmake gradle asm s nasm vb vbs ex exs erl hs ml fs clj lisp el nix ' +
    'html htm xhtml phtml php3 php4 php5 phps inc twig tpl hbs ejs pug haml erb jsp asp aspx cshtml razor pyi pyx pxd ino cu cuh ' +
    'zig nim sv vhd vhdl groovy sol tsv mk cjs mts cts svg' +
    ' ipynb rules yar yara sigma kql spl'
  ).split(' ')
)
const TEXT_EXT = new Set('txt md markdown rst adoc tex org text rtf'.split(' '))
const CODE_NAMES = new Set(['dockerfile', 'makefile', 'cmakelists.txt', 'jenkinsfile', 'vagrantfile', 'gemfile', 'rakefile'])

const BINARY_EXT = new Set(
  (
    'png jpg jpeg gif bmp ico webp tif tiff heic mp3 wav flac ogg m4a mp4 mkv avi mov webm ' +
    'zip rar 7z tar gz tgz bz2 xz iso exe dll so dylib bin obj o a lib class jar war pyc pyd wasm ' +
    'ttf otf woff woff2 eot psd ai sketch fig db sqlite sqlite3 mdb pcap pcapng dmp lock'
  ).split(' ')
)

const MAX_TEXT_BYTES = 3 * 1024 * 1024 // 3 Mo par fichier texte/code
const MAX_BINARY_DOC_BYTES = 80 * 1024 * 1024 // PDF / Word / PowerPoint

/** Extensions proposées dans la boîte de dialogue « Ajouter des fichiers ». */
export const KB_DIALOG_EXTENSIONS = ['*']

export function isIgnoredFileName(name: string): boolean {
  const n = name.toLowerCase()
  return (
    n === 'package-lock.json' ||
    n === 'yarn.lock' ||
    n === 'pnpm-lock.yaml' ||
    n === 'composer.lock' ||
    n === 'cargo.lock' ||
    n === 'poetry.lock' ||
    n === '.ds_store' ||
    n === 'thumbs.db' ||
    n.endsWith('.min.js') ||
    n.endsWith('.min.css') ||
    n.endsWith('.map') ||
    n.endsWith('.bundle.js')
  )
}

export const IGNORED_DIRS = new Set(
  (
    'node_modules .git .svn .hg dist build out target bin obj __pycache__ .venv venv env .tox .idea .vscode ' +
    '.next .nuxt .cache coverage .gradle .terraform vendor site-packages .pytest_cache .mypy_cache'
  ).split(' ')
)

function ext(file: string): string {
  return path.extname(file).slice(1).toLowerCase()
}

// ---------- Texte décodé ----------

function decode(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le').replace(/^﻿/, '')
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2))
    swapped.swap16()
    return swapped.toString('utf16le')
  }
  const utf8 = buf.toString('utf8')
  // Beaucoup de caractères de remplacement = probablement du Windows-1252 (vieux fichiers français).
  const bad = (utf8.match(/�/g) ?? []).length
  if (bad > 3 && bad > utf8.length / 200) return buf.toString('latin1')
  return utf8.replace(/^﻿/, '')
}

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192)
  let ctrl = 0
  for (let i = 0; i < n; i++) {
    const c = buf[i]
    if (c === 0) return true
    if (c < 9 || (c > 13 && c < 32)) ctrl++
  }
  return n > 0 && ctrl / n > 0.1
}

// ---------- Formats ----------

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', eacute: 'é', egrave: 'è', agrave: 'à', ecirc: 'ê', ccedil: 'ç' }
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, g: string) => {
    if (g[0] === '#') {
      const code = g[1].toLowerCase() === 'x' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m
    }
    return ENTITIES[g.toLowerCase()] ?? m
  })
}

function rtfToText(rtf: string): string {
  return rtf
    .replace(/\\'([0-9a-f]{2})/gi, (_m, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\(par|line|tab)\b ?/g, (_m, w: string) => (w === 'tab' ? '\t' : '\n'))
    .replace(/\{\\\*[^{}]*\}/g, '')
    .replace(/\\[a-z]+-?\d* ?/gi, '')
    .replace(/[{}]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function ipynbToText(raw: string): string {
  const nb = JSON.parse(raw) as { cells?: { cell_type?: string; source?: string | string[] }[] }
  const out: string[] = []
  for (const c of nb.cells ?? []) {
    const src = Array.isArray(c.source) ? c.source.join('') : String(c.source ?? '')
    if (!src.trim()) continue
    out.push(src)
  }
  return out.join('\n\n')
}

// ---------- ZIP minimal (docx / pptx) ----------

function zipEntries(buf: Buffer, want: (name: string) => boolean): Map<string, Buffer> {
  const out = new Map<string, Buffer>()
  // Fin de l'archive : signature 0x06054b50.
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('archive illisible')
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break
    const method = buf.readUInt16LE(p + 10)
    const csize = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const local = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    p += 46 + nameLen + extraLen + commentLen
    if (!want(name)) continue
    const lNameLen = buf.readUInt16LE(local + 26)
    const lExtraLen = buf.readUInt16LE(local + 28)
    const start = local + 30 + lNameLen + lExtraLen
    const data = buf.subarray(start, start + csize)
    out.set(name, method === 0 ? Buffer.from(data) : zlib.inflateRawSync(data))
  }
  return out
}

const xmlText = (xml: string, tag: string): string[] => {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`, 'g')
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(xml))) out.push(decodeEntities(m[1]))
  return out
}

function docxToText(buf: Buffer): string {
  const files = zipEntries(buf, (n) => n === 'word/document.xml' || /^word\/(footnotes|endnotes)\.xml$/.test(n))
  const parts: string[] = []
  for (const [, data] of files) {
    const xml = data.toString('utf8')
    for (const para of xml.split(/<\/w:p>/)) {
      const text = para
        .replace(/<w:tab\/>/g, '<w:t>\t</w:t>')
        .replace(/<w:br[^>]*\/>/g, '<w:t>\n</w:t>')
      const line = xmlText(text, 'w:t').join('')
      if (line.trim()) parts.push(line)
    }
  }
  return parts.join('\n')
}

function pptxToText(buf: Buffer): string {
  const files = zipEntries(buf, (n) => /^ppt\/(slides|notesSlides)\/[^/]+\.xml$/.test(n))
  const num = (n: string) => parseInt(n.match(/(\d+)\.xml$/)?.[1] ?? '0', 10)
  const order = (n: string) => num(n) * 2 + (n.includes('notes') ? 1 : 0)
  const names = [...files.keys()].sort((a, b) => order(a) - order(b))
  const out: string[] = []
  for (const name of names) {
    const xml = files.get(name)!.toString('utf8')
    const lines: string[] = []
    for (const para of xml.split(/<\/a:p>/)) {
      const line = xmlText(para, 'a:t').join('')
      if (line.trim()) lines.push(line)
    }
    if (lines.length) out.push(`${name.includes('notes') ? 'Notes' : 'Diapo'} ${num(name)}\n${lines.join('\n')}`)
  }
  return out.join('\n\n')
}

function xlsxToText(buf: Buffer): string {
  const files = zipEntries(buf, (n) => n === 'xl/sharedStrings.xml')
  const xml = files.get('xl/sharedStrings.xml')?.toString('utf8') ?? ''
  return xml
    .split('</si>')
    .map((si) => xmlText(si, 't').join(''))
    .filter((s) => s.trim())
    .join('\n')
}

// ---------- PDF ----------

/** Lecteur de secours : PDF simples (flux Flate ou bruts, polices non encodées). Renvoie '' si illisible. */
function pdfFallback(buf: Buffer): string {
  const raw = buf.toString('latin1')
  const out: string[] = []
  const re = /stream\r?\n/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw))) {
    if (raw.slice(Math.max(0, m.index - 3), m.index) === 'end') continue
    const start = m.index + m[0].length
    const end = raw.indexOf('endstream', start)
    if (end < 0) break
    re.lastIndex = end
    let content: string
    try {
      content = zlib.inflateSync(buf.subarray(start, end)).toString('latin1')
    } catch {
      content = raw.slice(start, end)
    }
    if (!content.includes('BT')) continue
    const lines: string[] = []
    for (const block of content.split('BT').slice(1)) {
      const et = block.indexOf('ET')
      const body = et >= 0 ? block.slice(0, et) : block
      let line = ''
      const op = /\(((?:\\.|[^\\)])*)\)\s*Tj|<([0-9A-Fa-f\s]+)>\s*Tj|\[((?:\\.|[^\]\\])*)\]\s*TJ|T\*|\bTd\b|\bTD\b/g
      let t: RegExpExecArray | null
      while ((t = op.exec(body))) {
        if (t[1] !== undefined) line += unescapePdf(t[1])
        else if (t[2] !== undefined) line += hexPdf(t[2])
        else if (t[3] !== undefined) {
          for (const s of t[3].matchAll(/\(((?:\\.|[^\\)])*)\)|<([0-9A-Fa-f\s]+)>|(-?\d+(?:\.\d+)?)/g)) {
            if (s[1] !== undefined) line += unescapePdf(s[1])
            else if (s[2] !== undefined) line += hexPdf(s[2])
            else if (Number(s[3]) < -200) line += ' '
          }
        } else if (line) {
          lines.push(line)
          line = ''
        }
      }
      if (line) lines.push(line)
    }
    out.push(lines.join('\n'))
  }
  const text = out.join('\n\n').trim()
  const letters = (text.match(/[A-Za-zÀ-ÿ]/g) ?? []).length
  return text.length > 40 && letters / text.length > 0.5 ? text : ''
}

function hexPdf(h: string): string {
  const clean = h.replace(/\s+/g, '')
  let s = ''
  for (let i = 0; i + 1 < clean.length; i += 2) s += String.fromCharCode(parseInt(clean.slice(i, i + 2), 16))
  return s
}

function unescapePdf(s: string): string {
  return s.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_m, g: string) => {
    if (/^[0-7]+$/.test(g)) return String.fromCharCode(parseInt(g, 8))
    return { n: '\n', r: '', t: '\t', b: '', f: '', '(': '(', ')': ')', '\\': '\\' }[g] ?? g
  })
}

async function pdfToText(buf: Buffer): Promise<string> {
  try {
    const modName = 'unpdf'
    const mod = (await import(/* @vite-ignore */ modName)) as {
      getDocumentProxy: (d: Uint8Array) => Promise<unknown>
      extractText: (pdf: unknown, o: { mergePages: boolean }) => Promise<{ text: string | string[] }>
    }
    const pdf = await mod.getDocumentProxy(new Uint8Array(buf))
    const { text } = await mod.extractText(pdf, { mergePages: true })
    const joined = Array.isArray(text) ? text.join('\n\n') : text
    if (joined.trim()) return joined
  } catch (e) {
    const fb = pdfFallback(buf)
    if (fb) return fb
    throw new Error(`PDF illisible (${e instanceof Error ? e.message : String(e)})`)
  }
  const fb = pdfFallback(buf)
  if (fb) return fb
  throw new Error('PDF sans texte (scanné ? il faut un PDF avec du texte sélectionnable)')
}

// ---------- Entrée principale ----------

/** Renvoie null si le fichier est volontairement ignoré (binaire, verrou…), lève une erreur s'il est illisible. */
export async function extractFile(file: string): Promise<Extracted | null> {
  const name = path.basename(file)
  const e = ext(file)
  const lname = name.toLowerCase()
  if (isIgnoredFileName(name) || BINARY_EXT.has(e)) return null
  const size = fs.statSync(file).size
  if (size === 0) return null

  if (e === 'pdf' || e === 'docx' || e === 'pptx' || e === 'xlsx') {
    if (size > MAX_BINARY_DOC_BYTES) throw new Error('fichier trop volumineux (80 Mo max)')
    const buf = fs.readFileSync(file)
    let text: string
    if (e === 'pdf') text = await pdfToText(buf)
    else if (e === 'docx') text = docxToText(buf)
    else if (e === 'pptx') text = pptxToText(buf)
    else text = xlsxToText(buf)
    text = text.replace(/\r\n?/g, '\n').replace(/\u0000/g, '').trim()
    if (!text) throw new Error('aucun texte trouvé')
    return { text, kind: 'text' }
  }
  if (e === 'doc' || e === 'ppt' || e === 'xls' || e === 'odt' || e === 'odp') {
    throw new Error(`format .${e} non pris en charge (enregistre-le en .docx / .pptx / .pdf)`)
  }

  if (size > MAX_TEXT_BYTES) throw new Error(`fichier texte trop gros (${Math.round(size / 1048576)} Mo, max 3 Mo)`)
  const buf = fs.readFileSync(file)
  if (looksBinary(buf)) return null
  let text = decode(buf).replace(/\r\n?/g, '\n')
  let kind: DocKind = CODE_EXT.has(e) || CODE_NAMES.has(lname) ? 'code' : 'text'
  if (!CODE_EXT.has(e) && !TEXT_EXT.has(e) && !CODE_NAMES.has(lname)) kind = 'code' // extension inconnue mais lisible : on traite comme du code
  if (e === 'ipynb') {
    try {
      text = ipynbToText(text)
    } catch {
      /* JSON brut */
    }
  }
  else if (e === 'rtf') text = rtfToText(text)
  if (e === 'json' || e === 'csv' || e === 'tsv' || e === 'log') {
    // Fichiers de données : on évite d'engloutir l'index avec des mégaoctets de lignes répétitives.
    if (text.length > 600_000) text = `${text.slice(0, 600_000)}\n… (tronqué : fichier de données volumineux)`
  }
  text = text.replace(/\u0000/g, '')
  if (!text.trim()) return null
  return { text, kind }
}

export function listFilesRecursive(root: string, limit = 25_000): { files: string[]; truncated: boolean } {
  const files: string[] = []
  let truncated = false
  const walk = (dir: string): void => {
    if (files.length >= limit) {
      truncated = true
      return
    }
    let entries: Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const ent of entries) {
      if (files.length >= limit) {
        truncated = true
        return
      }
      const full = path.join(dir, ent.name)
      if (ent.isDirectory()) {
        if (IGNORED_DIRS.has(ent.name.toLowerCase()) || (ent.name.startsWith('.') && ent.name !== '.github')) continue
        walk(full)
      } else if (ent.isFile()) {
        if (!isIgnoredFileName(ent.name) && !BINARY_EXT.has(ext(ent.name))) files.push(full)
      }
    }
  }
  walk(root)
  return { files, truncated }
}
