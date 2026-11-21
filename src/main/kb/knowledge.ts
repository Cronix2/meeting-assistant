import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { KbDocInfo, KbImportResult, KbInfo, KbPatch, KbProgress } from '../../shared/types'
import { ANSWER_MARK } from '../buffer'
import { chunkDocument } from './chunk'
import { extractFile, listFilesRecursive, type DocKind } from './extract'
import { SearchIndex } from './searchIndex'
import { queryTerms, tokenize } from './tokenize'

/**
 * Mémoire professionnelle : des « bases de connaissances » (projets de code, cours, textes de loi, PDF…).
 * Tout est stocké et indexé sur ce PC (dossier knowledge/ des données de l'appli) ; seuls la fiche de la base
 * et les quelques extraits les plus proches de la conversation partent avec chaque demande à Claude.
 */

const MAX_DOCS_PER_KB = 30_000
const CACHE_CHARS = 40_000_000
const SLICE_MS = 25

interface DocMeta {
  id: string
  label: string
  source: string
  kind: DocKind
  chars: number
  chunks: number
  addedAt: number
  size: number
  mtimeMs: number
  hash?: string
}

interface KbMeta {
  id: string
  name: string
  enabled: boolean
  about: string
  brief: string
  briefAt: number
  createdAt: number
  docs: DocMeta[]
}

interface Runtime {
  meta: KbMeta
  index: SearchIndex
  docNum: Map<string, number>
  numDoc: Map<number, DocMeta>
  /** Fichiers qui ont une note de résumé (fichier docs/<id>.sum.txt) */
  sumDocs: Set<string>
  nextNum: number
  indexing: boolean
  gen: number
}

type Emit = (p: KbProgress) => void

let root = ''
let logFn: (m: string) => void = () => {}
let emitFn: Emit = () => {}
const bases = new Map<string, Runtime>()
const cache = new Map<string, string>()
let cacheChars = 0

export function initKnowledge(dir: string, opts: { log?: (m: string) => void; emit?: Emit } = {}): void {
  root = dir
  logFn = opts.log ?? (() => {})
  emitFn = opts.emit ?? (() => {})
  fs.mkdirSync(root, { recursive: true })
  bases.clear()
  cache.clear()
  cacheChars = 0
  for (const name of fs.readdirSync(root)) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(root, name, 'meta.json'), 'utf8')) as KbMeta
      if (!meta?.id || !Array.isArray(meta.docs)) continue
      const rtNew = newRuntime({
          ...meta,
          about: typeof meta.about === 'string' ? meta.about : '',
          brief: typeof meta.brief === 'string' ? meta.brief : '',
          briefAt: Number(meta.briefAt) || 0,
          enabled: meta.enabled !== false
        })
      try {
        for (const f of fs.readdirSync(path.join(root, name, 'docs'))) if (f.endsWith('.sum.txt')) rtNew.sumDocs.add(f.slice(0, -8))
      } catch {
        /* pas encore de dossier docs */
      }
      bases.set(meta.id, rtNew)
    } catch {
      /* dossier étranger ou abîmé : ignoré */
    }
  }
}

function newRuntime(meta: KbMeta): Runtime {
  return { meta, index: new SearchIndex(), docNum: new Map(), numDoc: new Map(), sumDocs: new Set(), nextNum: 0, indexing: false, gen: 0 }
}

/** Lance (en arrière-plan) la construction de l'index de toutes les bases. */
export function startIndexing(): void {
  void (async () => {
    for (const rt of bases.values()) await reindex(rt)
  })()
}

const kbDir = (id: string) => path.join(root, id)
const docFile = (kb: string, doc: string) => path.join(kbDir(kb), 'docs', `${doc}.txt`)
const sumFile = (kb: string, doc: string) => path.join(kbDir(kb), 'docs', `${doc}.sum.txt`)
const tick = () => new Promise<void>((r) => setImmediate(r))

function persist(rt: Runtime): void {
  fs.mkdirSync(kbDir(rt.meta.id), { recursive: true })
  const file = path.join(kbDir(rt.meta.id), 'meta.json')
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(rt.meta), 'utf8')
  fs.renameSync(tmp, file)
}

function docText(kb: string, doc: string): string {
  const key = `${kb}/${doc}`
  const hit = cache.get(key)
  if (hit !== undefined) {
    cache.delete(key)
    cache.set(key, hit)
    return hit
  }
  let text = ''
  try {
    text = fs.readFileSync(docFile(kb, doc), 'utf8')
  } catch {
    return ''
  }
  cache.set(key, text)
  cacheChars += text.length
  while (cacheChars > CACHE_CHARS && cache.size > 1) {
    const oldest = cache.keys().next().value as string
    cacheChars -= cache.get(oldest)!.length
    cache.delete(oldest)
  }
  return text
}

/** Découpe + indexe un document, en rendant la main régulièrement pour ne pas figer l'application. */
async function indexDoc(rt: Runtime, doc: DocMeta, text: string, gen: number): Promise<number> {
  const num = rt.nextNum++
  rt.docNum.set(doc.id, num)
  rt.numDoc.set(num, doc)
  const chunks = chunkDocument(text, doc.kind)
  const pathTokens = tokenize(doc.label)
  let slice = Date.now()
  for (const c of chunks) {
    const symTokens = c.symbols?.length ? tokenize(c.symbols.join(' ')) : []
    rt.index.add(
      { doc: num, start: c.start, end: c.end, lineStart: c.lineStart, lineEnd: c.lineEnd, sym: c.symbols?.join(', ') || undefined },
      // Les noms de fonctions comptent double : retrouver `resolveCached` ramène tous les morceaux de la fonction.
      pathTokens.concat(symTokens, symTokens, tokenize(text.slice(c.start, c.end)))
    )
    if (Date.now() - slice > SLICE_MS) {
      await tick()
      if (rt.gen !== gen) return chunks.length
      slice = Date.now()
    }
  }
  return chunks.length
}

async function reindex(rt: Runtime): Promise<void> {
  const gen = ++rt.gen
  rt.index = new SearchIndex()
  rt.docNum = new Map()
  rt.numDoc = new Map()
  rt.nextNum = 0
  rt.indexing = true
  const total = rt.meta.docs.length
  let last = 0
  try {
    for (let i = 0; i < total; i++) {
      const d = rt.meta.docs[i]
      const text = docText(rt.meta.id, d.id)
      if (text) d.chunks = await indexDoc(rt, d, text, gen)
      if (rt.gen !== gen) return
      if (rt.sumDocs.has(d.id)) addNoteChunk(rt, d)
      if (Date.now() - last > 200) {
        last = Date.now()
        emitFn({ kbId: rt.meta.id, task: 'index', done: i + 1, total, label: d.label })
      }
    }
    persist(rt)
    emitFn({ kbId: rt.meta.id, task: 'index', done: total, total, label: '', finished: true })
  } finally {
    if (rt.gen === gen) rt.indexing = false
  }
}

/** Indexe la note de résumé d'un fichier comme un extrait à part (type « note »). */
function addNoteChunk(rt: Runtime, doc: DocMeta): void {
  const num = rt.docNum.get(doc.id)
  if (num === undefined) return
  let note = ''
  try {
    note = fs.readFileSync(sumFile(rt.meta.id, doc.id), 'utf8')
  } catch {
    return
  }
  const tokens = tokenize(doc.label).concat(tokenize(note))
  rt.index.add({ doc: num, start: 0, end: 0, lineStart: 0, lineEnd: 0, note: true }, tokens)
}

export function readSummary(kb: string, doc: string): string {
  const rt = bases.get(kb)
  if (!rt?.sumDocs.has(doc)) return ''
  try {
    return fs.readFileSync(sumFile(kb, doc), 'utf8')
  } catch {
    return ''
  }
}

/** Enregistre (et indexe) la note d'un fichier. */
export function setSummary(kb: string, doc: string, note: string): void {
  const rt = bases.get(kb)
  const d = rt?.meta.docs.find((x) => x.id === doc)
  if (!rt || !d) return
  const clean = note.trim().slice(0, 1600)
  if (!clean) return
  fs.writeFileSync(sumFile(kb, doc), clean, 'utf8')
  if (!rt.sumDocs.has(doc)) {
    rt.sumDocs.add(doc)
    addNoteChunk(rt, d)
  }
}

/** Fichiers de la base qui n'ont pas encore de note (les fichiers minuscules sont laissés de côté). */
export function docsToSummarize(id: string, minChars = 200): { id: string; label: string; kind: DocKind; chars: number }[] {
  const rt = bases.get(id)
  if (!rt) return []
  return rt.meta.docs
    .filter((d) => !rt.sumDocs.has(d.id) && d.chars >= minChars)
    .map((d) => ({ id: d.id, label: d.label, kind: d.kind, chars: d.chars }))
    .sort((a, b) => a.label.localeCompare(b.label))
}

/** Supprime toutes les notes d'une base (pour les régénérer). */
export function clearSummaries(id: string): void {
  const rt = bases.get(id)
  if (!rt) return
  for (const d of rt.sumDocs) fs.rmSync(sumFile(id, d), { force: true })
  rt.sumDocs.clear()
  void reindex(rt)
}

export function summaryCount(id: string): number {
  return bases.get(id)?.sumDocs.size ?? 0
}

// ---------- Gestion des bases ----------

function info(rt: Runtime): KbInfo {
  const m = rt.meta
  let chars = 0
  let chunks = 0
  for (const d of m.docs) {
    chars += d.chars
    chunks += d.chunks
  }
  return {
    id: m.id,
    name: m.name,
    enabled: m.enabled,
    about: m.about,
    brief: m.brief,
    briefAt: m.briefAt,
    docs: m.docs.length,
    chars,
    chunks,
    summarized: rt.sumDocs.size,
    indexing: rt.indexing,
    createdAt: m.createdAt
  }
}

export const listBases = (): KbInfo[] => [...bases.values()].map(info).sort((a, b) => a.createdAt - b.createdAt)

export function createBase(name: string): KbInfo {
  const meta: KbMeta = {
    id: randomUUID(),
    name: name.trim().slice(0, 80) || 'Nouvelle base',
    enabled: true,
    about: '',
    brief: '',
    briefAt: 0,
    createdAt: Date.now(),
    docs: []
  }
  const rt = newRuntime(meta)
  bases.set(meta.id, rt)
  persist(rt)
  return info(rt)
}

export function updateBase(id: string, patch: KbPatch): KbInfo | null {
  const rt = bases.get(id)
  if (!rt) return null
  if (typeof patch.name === 'string' && patch.name.trim()) rt.meta.name = patch.name.trim().slice(0, 80)
  if (typeof patch.enabled === 'boolean') rt.meta.enabled = patch.enabled
  if (typeof patch.about === 'string') rt.meta.about = patch.about.slice(0, 4000)
  if (typeof patch.brief === 'string') {
    rt.meta.brief = patch.brief.slice(0, 30_000)
    rt.meta.briefAt = Date.now()
  }
  persist(rt)
  return info(rt)
}

export function setBrief(id: string, brief: string): void {
  const rt = bases.get(id)
  if (!rt) return
  rt.meta.brief = brief
  rt.meta.briefAt = Date.now()
  persist(rt)
}

export function deleteBase(id: string): void {
  const rt = bases.get(id)
  if (!rt) return
  rt.gen++
  bases.delete(id)
  for (const k of [...cache.keys()]) if (k.startsWith(`${id}/`)) cacheChars -= cache.get(k)!.length, cache.delete(k)
  fs.rmSync(kbDir(id), { recursive: true, force: true })
}

export function listDocs(id: string): KbDocInfo[] {
  return (bases.get(id)?.meta.docs ?? []).map((d) => ({ id: d.id, label: d.label, kind: d.kind, chars: d.chars, chunks: d.chunks }))
}

export function removeDoc(id: string, docId: string, bulk = false): void {
  const rt = bases.get(id)
  if (!rt) return
  const num = rt.docNum.get(docId)
  if (num !== undefined) {
    rt.index.removeDoc(num)
    rt.numDoc.delete(num)
  }
  rt.docNum.delete(docId)
  rt.meta.docs = rt.meta.docs.filter((d) => d.id !== docId)
  const key = `${id}/${docId}`
  if (cache.has(key)) cacheChars -= cache.get(key)!.length, cache.delete(key)
  fs.rmSync(docFile(id, docId), { force: true })
  if (bulk) return
  persist(rt)
  if (rt.index.deadRatio > 0.3) void reindex(rt)
}

/** Texte intégral d'une base (utilisé pour la synthèse). */
export function readDoc(kb: string, doc: string): string {
  return docText(kb, doc)
}

export function baseDocs(id: string): { id: string; label: string; kind: DocKind; chars: number }[] {
  return (bases.get(id)?.meta.docs ?? []).map((d) => ({ id: d.id, label: d.label, kind: d.kind, chars: d.chars }))
}

export function baseMeta(id: string): { name: string; about: string } | null {
  const rt = bases.get(id)
  return rt ? { name: rt.meta.name, about: rt.meta.about } : null
}

// ---------- Import ----------

const toPosix = (p: string) => p.split(path.sep).join('/')

/** Importe des fichiers et/ou des dossiers (récursif, avec filtres) dans une base. */
export async function importPaths(id: string, inputs: string[], signal?: { aborted: boolean }): Promise<KbImportResult> {
  const rt = bases.get(id)
  if (!rt) throw new Error('base introuvable')
  const result: KbImportResult = { added: 0, unchanged: 0, skipped: 0, errors: [], truncated: false }

  const jobs: { file: string; label: string }[] = []
  for (const input of inputs) {
    try {
      const st = fs.statSync(input)
      if (st.isDirectory()) {
        const { files, truncated } = listFilesRecursive(input)
        if (truncated) result.truncated = true
        const base = path.basename(input)
        for (const f of files) jobs.push({ file: f, label: `${base}/${toPosix(path.relative(input, f))}` })
      } else if (st.isFile()) {
        jobs.push({ file: input, label: path.basename(input) })
      }
    } catch (e) {
      result.errors.push(`${path.basename(input)} : ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const gen = rt.gen
  let last = 0
  let sinceSave = 0
  const total = jobs.length
  for (let i = 0; i < total; i++) {
    if (signal?.aborted) break
    const { file, label } = jobs[i]
    if (Date.now() - last > 150) {
      last = Date.now()
      emitFn({ kbId: id, task: 'import', done: i, total, label })
      await tick()
    }
    try {
      if (rt.gen !== gen) break
      const st = fs.statSync(file)
      const prev = rt.meta.docs.find((d) => d.source === file)
      if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs) {
        result.unchanged++
        continue
      }
      if (!prev && rt.meta.docs.length >= MAX_DOCS_PER_KB) {
        result.errors.push(`limite de ${MAX_DOCS_PER_KB} fichiers par base atteinte`)
        break
      }
      const ex = await extractFile(file)
      if (!ex) {
        result.skipped++
        continue
      }
      const hash = createHash('md5').update(ex.text).digest('hex')
      if (rt.meta.docs.some((d) => d.hash === hash && d.id !== prev?.id)) {
        result.skipped++ // même contenu que dans un autre fichier de la base (copie, build…)
        continue
      }
      if (prev) removeDoc(id, prev.id, true)
      const doc: DocMeta = {
        id: randomUUID(),
        label,
        source: file,
        kind: ex.kind,
        chars: ex.text.length,
        chunks: 0,
        addedAt: Date.now(),
        size: st.size,
        mtimeMs: st.mtimeMs,
        hash
      }
      fs.mkdirSync(path.join(kbDir(id), 'docs'), { recursive: true })
      fs.writeFileSync(docFile(id, doc.id), ex.text, 'utf8')
      doc.chunks = await indexDoc(rt, doc, ex.text, rt.gen)
      rt.meta.docs.push(doc)
      result.added++
      if (++sinceSave >= 300) {
        persist(rt)
        sinceSave = 0
      }
    } catch (e) {
      result.errors.push(`${label} : ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  persist(rt)
  if (rt.index.deadRatio > 0.3) void reindex(rt)
  emitFn({
    kbId: id,
    task: 'import',
    done: total,
    total,
    label: '',
    finished: true,
    message: signal?.aborted ? 'Import annulé' : undefined
  })
  logFn(`[base] « ${rt.meta.name} » : ${result.added} ajouté(s), ${result.unchanged} inchangé(s), ${result.skipped} ignoré(s), ${result.errors.length} erreur(s)`)
  return result
}

// ---------- Recherche ----------

export interface KbExcerpt {
  lineStart: number
  lineEnd: number
  symbols?: string
  text: string
  score: number
}

/** Un fichier retrouvé : sa note de résumé (si elle existe) + les passages exacts les plus proches de la question. */
export interface KbFileHit {
  kb: string
  label: string
  kind: DocKind
  note: string
  excerpts: KbExcerpt[]
  score: number
}

/** Seuil absolu qui grandit avec la taille de la base : une phrase banale ne doit pas ramener d'extraits au hasard. */
const minScoreFor = (size: number): number => 0.5 * Math.log(1 + size / 2)
const REL_SCORE = 0.3
const MAX_PER_FILE = 3
const MAX_FILES = 5

/** Ligne « Éléments : … » d'une note : sert à retrouver, dans le fichier brut, les passages importants. */
function noteElements(note: string): string {
  const m = note.match(/^\s*[ÉE]l[ée]ments\s*:\s*(.+)$/im)
  return m ? m[1] : ''
}

/**
 * 1) cherche dans les extraits bruts ET dans les notes (qui contiennent des synonymes et des explications) ;
 * 2) regroupe par fichier ; 3) pour chaque fichier retenu, redonne la note et les passages exacts.
 * `topK` = nombre maximal de passages de code/texte au total.
 */
export function searchKb(query: string, topK: number): KbFileHit[] {
  const terms = queryTerms(query)
  if (!terms.size) return []
  interface Cand {
    rt: Runtime
    doc: DocMeta
    chunkScore: number
    noteScore: number
    chunks: { chunk: number; score: number }[]
  }
  const cands = new Map<string, Cand>()
  for (const rt of bases.values()) {
    if (!rt.meta.enabled || !rt.index.size) continue
    const min = minScoreFor(rt.index.size)
    for (const h of rt.index.search(terms, topK * 8)) {
      if (h.score < min) continue
      const ref = rt.index.chunks[h.chunk]
      const doc = rt.numDoc.get(ref.doc)
      if (!doc) continue
      const key = `${rt.meta.id}/${doc.id}`
      let c = cands.get(key)
      if (!c) cands.set(key, (c = { rt, doc, chunkScore: 0, noteScore: 0, chunks: [] }))
      if (ref.note) c.noteScore = Math.max(c.noteScore, h.score)
      else {
        c.chunkScore = Math.max(c.chunkScore, h.score)
        c.chunks.push({ chunk: h.chunk, score: h.score })
      }
    }
  }
  if (!cands.size) return []
  // Un fichier qui ressort à la fois par sa note et par son contenu passe devant.
  // Citer le nom d'un fichier (« dans heapq », « le fichier cache.go ») est un signal fort.
  const pathBonus = (label: string): number => {
    const base = (label.split('/').pop() ?? label).replace(/\.[^.]+$/, '')
    let n = 0
    for (const t of new Set(tokenize(base))) if (terms.has(t)) n++
    return n * 8
  }
  const rank = (c: Cand) => Math.max(c.chunkScore, c.noteScore) + 0.5 * Math.min(c.chunkScore, c.noteScore) + pathBonus(c.doc.label)
  const ordered = [...cands.values()].sort((a, b) => rank(b) - rank(a))
  const best = rank(ordered[0])

  const out: KbFileHit[] = []
  const seen = new Set<string>()
  let excerptsLeft = topK
  for (const c of ordered) {
    if (out.length >= MAX_FILES || excerptsLeft <= 0 || rank(c) < best * REL_SCORE) break
    const kbId = c.rt.meta.id
    let picks = c.chunks.sort((a, b) => b.score - a.score).slice(0, MAX_PER_FILE)
    const note = readSummary(kbId, c.doc.id)
    if (!picks.length && note) {
      // Trouvé par sa note seulement : on va chercher dans le fichier les passages des éléments cités par la note.
      const t2 = new Map(terms)
      for (const [t, w] of queryTerms(noteElements(note))) t2.set(t, Math.max(t2.get(t) ?? 0, w * 0.5))
      const num = c.rt.docNum.get(c.doc.id)
      if (num !== undefined) {
        picks = c.rt.index
          .search(t2, 2, new Set([num]), true)
          .map((h) => ({ chunk: h.chunk, score: h.score }))
      }
    }
    const text = docText(kbId, c.doc.id)
    const excerpts: KbExcerpt[] = []
    for (const p of picks) {
      if (excerptsLeft <= 0) break
      const ref = c.rt.index.chunks[p.chunk]
      const body = text.slice(ref.start, ref.end)
      const sig = body.slice(0, 160)
      if (!body.trim() || seen.has(sig)) continue
      seen.add(sig)
      excerpts.push({ lineStart: ref.lineStart, lineEnd: ref.lineEnd, symbols: ref.sym, text: body, score: p.score })
      excerptsLeft--
    }
    if (!excerpts.length && !note) continue
    excerpts.sort((a, b) => a.lineStart - b.lineStart)
    out.push({ kb: c.rt.meta.name, label: c.doc.label, kind: c.doc.kind, note, excerpts, score: rank(c) })
  }
  return out
}

/** Texte de la conversation → requête : sans nos propres réponses ni les horodatages, fin de conversation seulement. */
export function cleanQuery(transcript: string, maxChars = 900): string {
  return transcript
    .split('\n')
    .filter((l) => !l.includes(ANSWER_MARK))
    .join('\n')
    .replace(/^\[\d\d:\d\d:\d\d\]\s*/gm, '')
    .slice(-maxChars)
}

export interface KbMemory {
  /** Fiches, présentations et carte des fichiers des bases actives : changent rarement (mises en cache côté API) */
  stable: string
  /** Notes + passages retrouvés pour la conversation en cours */
  dynamic: string
  hits: KbFileHit[]
}

const BRIEF_MAX_TOTAL = 18_000
const MAP_MAX_CHARS = 6000
const NOTE_IN_PROMPT = 900

/** Première phrase de la ligne « Rôle : … » d'une note (pour la carte des fichiers). */
function roleLine(note: string): string {
  const m = note.match(/^\s*R[ôo]le\s*:\s*(.+)$/im)
  const line = (m ? m[1] : note.split('\n')[0]).trim()
  const cut = line.search(/[.!?]\s/)
  return (cut > 20 ? line.slice(0, cut) : line).slice(0, 120)
}

/** « Carte » : une ligne par fichier résumé, pour que Claude sache de quel fichier on parle. */
function fileMap(rt: Runtime): string {
  const lines: string[] = []
  let len = 0
  let more = 0
  for (const d of [...rt.meta.docs].sort((a, b) => a.label.localeCompare(b.label))) {
    if (!rt.sumDocs.has(d.id)) continue
    const line = `- ${d.label} : ${roleLine(readSummary(rt.meta.id, d.id))}`
    if (len + line.length > MAP_MAX_CHARS) {
      more++
      continue
    }
    lines.push(line)
    len += line.length + 1
  }
  if (more) lines.push(`… et ${more} autre(s) fichier(s) résumé(s), retrouvés à la demande.`)
  return lines.join('\n')
}

export function buildKbMemory(opts: { enabled: boolean; transcript: string; topK: number; budgetChars: number }): KbMemory {
  const empty: KbMemory = { stable: '', dynamic: '', hits: [] }
  if (!opts.enabled) return empty
  const active = [...bases.values()].filter((rt) => rt.meta.enabled).sort((a, b) => a.meta.createdAt - b.meta.createdAt)
  if (!active.length) return empty

  const sheets: string[] = []
  let used = 0
  for (const rt of active) {
    const parts: string[] = []
    if (rt.meta.about.trim()) parts.push(rt.meta.about.trim())
    if (rt.meta.brief.trim()) parts.push(rt.meta.brief.trim())
    const map = fileMap(rt)
    if (map) parts.push(`Carte des fichiers (rôle de chacun) :\n${map}`)
    if (!parts.length) continue
    let body = parts.join('\n\n')
    if (used + body.length > BRIEF_MAX_TOTAL) body = body.slice(0, Math.max(0, BRIEF_MAX_TOTAL - used))
    if (!body) break
    used += body.length
    sheets.push(`### Base « ${rt.meta.name} »\n${body}`)
  }

  const hits = searchKb(cleanQuery(opts.transcript), opts.topK)
  const blocks: string[] = []
  let chars = 0
  const kept: KbFileHit[] = []
  for (const h of hits) {
    const head = [`#### ${h.label}`]
    if (h.note) head.push(`Note : ${h.note.length > NOTE_IN_PROMPT ? `${h.note.slice(0, NOTE_IN_PROMPT)}…` : h.note}`)
    const parts = [head.join('\n')]
    for (const e of h.excerpts) {
      const where = h.kind === 'code' ? `Passage exact, lignes ${e.lineStart}–${e.lineEnd}${e.symbols ? ` (${e.symbols})` : ''} :` : 'Passage exact :'
      parts.push(`${where}\n${e.text.trim()}`)
    }
    const block = parts.join('\n')
    if (chars + block.length > opts.budgetChars && blocks.length) break
    blocks.push(block)
    kept.push(h)
    chars += block.length
  }
  return { stable: sheets.join('\n\n'), dynamic: blocks.join('\n\n'), hits: kept }
}
