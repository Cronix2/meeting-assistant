import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type { RagDoc, Settings } from '../shared/types'
import { ANSWER_MARK } from './buffer'
import { log } from './log'

/**
 * Mémoire personnelle (RAG local, sans service externe) :
 *  - un « profil permanent » toujours transmis à Claude ;
 *  - des documents (txt, md, json, csv…) découpés en extraits ; à chaque demande, on retrouve les extraits
 *    les plus proches de la conversation récente (classement BM25) et on les ajoute au prompt.
 * Les documents restent sur ce PC ; seuls le profil et les extraits retenus partent avec la requête à Claude.
 */

export const RAG_EXTENSIONS = ['txt', 'md', 'markdown', 'json', 'csv', 'tsv', 'yaml', 'yml', 'log']
const MAX_DOC_CHARS = 1_000_000
const MAX_DOCS = 60
const CHUNK_TARGET = 700
const CHUNK_OVERLAP = 100
const QUERY_CHARS = 900
const MEMORY_BUDGET = 3200

interface StoredDoc {
  id: string
  name: string
  addedAt: number
  text: string
}
interface Chunk {
  docId: string
  docName: string
  text: string
  tokens: string[]
}

const storePath = () => path.join(app.getPath('userData'), 'rag.json')

let docs: StoredDoc[] | null = null
let chunks: Chunk[] = []
let df = new Map<string, number>()
let avgLen = 0

// ---------- Texte → jetons ----------

const STOP = new Set(
  (
    'le la les un une des du de d l et ou en au aux a à est sont été être ce cet cette ces se sa son ses sur dans par pour ' +
    'avec sans que qui quoi dont où ne pas plus je tu il elle nous vous ils elles on mon ma mes ton ta tes leur leurs y ' +
    'the a an and or of to in on at for with without is are was were be been this that these those it its as by from ' +
    'i you he she we they me my your his her our their not no do does did have has had can could would should will'
  ).split(' ')
)

function tokenize(text: string): string[] {
  const out: string[] = []
  const words = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/)
  for (let w of words) {
    if (w.length < 2 || STOP.has(w)) continue
    if (w.length > 4 && w.endsWith('s')) w = w.slice(0, -1) // pluriels (très simple)
    out.push(w)
  }
  return out
}

function chunkText(text: string): string[] {
  const paragraphs = text.replace(/\r\n/g, '\n').split(/\n\s*\n/)
  const out: string[] = []
  let cur = ''
  const flush = () => {
    if (cur.trim()) out.push(cur.trim())
    cur = ''
  }
  for (const raw of paragraphs) {
    const p = raw.trim()
    if (!p) continue
    if (p.length > CHUNK_TARGET * 1.5) {
      flush()
      for (let i = 0; i < p.length; i += CHUNK_TARGET - CHUNK_OVERLAP) out.push(p.slice(i, i + CHUNK_TARGET))
      continue
    }
    if (cur && cur.length + p.length + 2 > CHUNK_TARGET) flush()
    cur += (cur ? '\n\n' : '') + p
  }
  flush()
  return out
}

// ---------- Stockage ----------

function load(): StoredDoc[] {
  if (docs) return docs
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath(), 'utf8')) as StoredDoc[]
    docs = Array.isArray(parsed) ? parsed.filter((d) => d && typeof d.text === 'string') : []
  } catch {
    docs = []
  }
  rebuild()
  return docs
}

function persist(): void {
  const file = storePath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(docs ?? []), 'utf8')
  fs.renameSync(tmp, file)
}

function rebuild(): void {
  chunks = []
  df = new Map()
  for (const d of docs ?? []) {
    for (const text of chunkText(d.text)) {
      chunks.push({ docId: d.id, docName: d.name, text, tokens: tokenize(`${d.name} ${text}`) })
    }
  }
  let total = 0
  for (const c of chunks) {
    total += c.tokens.length
    for (const t of new Set(c.tokens)) df.set(t, (df.get(t) ?? 0) + 1)
  }
  avgLen = chunks.length ? total / chunks.length : 0
}

function describe(): RagDoc[] {
  const list = load()
  return list.map((d) => ({
    id: d.id,
    name: d.name,
    chars: d.text.length,
    chunks: chunks.filter((c) => c.docId === d.id).length,
    addedAt: d.addedAt
  }))
}

export const listDocs = (): RagDoc[] => describe()

export interface AddResult {
  docs: RagDoc[]
  errors: string[]
}

export function addFiles(paths: string[]): AddResult {
  const list = load()
  const errors: string[] = []
  for (const p of paths) {
    const name = path.basename(p)
    const ext = path.extname(p).slice(1).toLowerCase()
    try {
      if (list.length >= MAX_DOCS) throw new Error(`limite de ${MAX_DOCS} documents atteinte`)
      if (!RAG_EXTENSIONS.includes(ext)) {
        throw new Error('format non pris en charge (utilise .txt, .md, .json, .csv… ; exporte les PDF/Word en texte)')
      }
      const buf = fs.readFileSync(p)
      if (buf.includes(0)) throw new Error('fichier binaire')
      const text = buf.toString('utf8').replace(/^\uFEFF/, '').trim()
      if (!text) throw new Error('fichier vide')
      if (text.length > MAX_DOC_CHARS) throw new Error('fichier trop volumineux (1 million de caractères max)')
      // Même nom = remplacement (mise à jour du document).
      const existing = list.findIndex((d) => d.name === name)
      const doc: StoredDoc = { id: randomUUID(), name, addedAt: Date.now(), text }
      if (existing >= 0) list.splice(existing, 1, doc)
      else list.push(doc)
    } catch (e) {
      errors.push(`${name} : ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  docs = list
  rebuild()
  persist()
  return { docs: describe(), errors }
}

export function removeDoc(id: string): RagDoc[] {
  docs = load().filter((d) => d.id !== id)
  rebuild()
  persist()
  return describe()
}

// ---------- Recherche (BM25) ----------

function search(query: string, k: number): Chunk[] {
  load()
  const q = [...new Set(tokenize(query))]
  if (!q.length || !chunks.length) return []
  const N = chunks.length
  const k1 = 1.5
  const b = 0.75
  const scored: { c: Chunk; score: number }[] = []
  for (const c of chunks) {
    const tf = new Map<string, number>()
    for (const t of c.tokens) tf.set(t, (tf.get(t) ?? 0) + 1)
    let score = 0
    for (const t of q) {
      const f = tf.get(t)
      if (!f) continue
      const n = df.get(t) ?? 0
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5))
      score += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * c.tokens.length) / (avgLen || 1)))
    }
    if (score > 0) scored.push({ c, score })
  }
  scored.sort((a, b2) => b2.score - a.score)
  return scored.slice(0, k).map((s) => s.c)
}

/**
 * Bloc « mémoire » ajouté au prompt système : profil permanent + extraits pertinents.
 * Retourne '' si la mémoire est désactivée ou vide.
 */
export function buildMemory(s: Settings, transcript: string): string {
  if (!s.ragEnabled) return ''
  const parts: string[] = []
  const profile = s.ragProfile.trim()
  if (profile) parts.push(`## Profil de l'utilisateur\n${profile}`)

  const query = transcript
    .split('\n')
    .filter((l) => !l.includes(ANSWER_MARK))
    .join('\n')
    .replace(/^\[\d\d:\d\d:\d\d\]\s*/gm, '')
    .slice(-QUERY_CHARS)
  const hits = search(query, s.ragTopK)
  let used = 0
  const excerpts: string[] = []
  for (const h of hits) {
    if (used + h.text.length > MEMORY_BUDGET && excerpts.length) break
    excerpts.push(`### ${h.docName}\n${h.text}`)
    used += h.text.length
  }
  if (excerpts.length) parts.push(`## Extraits de ses documents\n${excerpts.join('\n\n')}`)
  if (hits.length) log(`[mémoire] ${excerpts.length} extrait(s) retenu(s) : ${[...new Set(hits.map((h) => h.docName))].join(', ')}`)
  return parts.join('\n\n')
}
