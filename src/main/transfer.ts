import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

/**
 * Transfert des données d'un PC à l'autre : réglages, profil + documents perso, bases de connaissances
 * (texte extrait, notes, fiches) et, si on le demande, les clés API.
 *
 * Format du fichier .deskassistant :
 *   ligne 1   : « DESKASSISTANT-EXPORT »
 *   ligne 2   : en-tête JSON { v, created, appVersion, encrypted, salt?, iv?, summary? }
 *   ensuite   : corps = gzip(conteneur), ou AES-256-GCM(gzip(conteneur)) + étiquette (16 octets) si mot de passe.
 * Conteneur  : suite d'entrées [longueur du nom (u32)][nom utf-8][taille (u64)][octets].
 *
 * Les clés API ne sont jamais écrites sans mot de passe. À l'import, seuls des chemins connus sont acceptés
 * (pas de « ../ », pas de fichiers arbitraires).
 */

const MAGIC = 'DESKASSISTANT-EXPORT'
const SECRETS_ENTRY = 'secrets.plain.json'
const MAX_UNPACKED = 2 * 1024 * 1024 * 1024 // 2 Go décompressés au maximum
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }
export const MIN_PASSWORD = 8

export interface ExportSummary {
  settings: boolean
  profileDocs: number
  bases: number
  baseFiles: number
  keys: boolean
}

export interface ExportHeader {
  v: 1
  created: number
  appVersion: string
  encrypted: boolean
  salt?: string
  iv?: string
  /** Contenu (présent seulement si le fichier n'est pas chiffré, pour ne rien révéler sinon) */
  summary?: ExportSummary
}

export interface UnpackedEntry {
  name: string
  data: Buffer
}

/** Chemins autorisés dans une archive. */
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const ALLOWED = new RegExp(
  `^(?:settings\\.json|rag\\.json|${SECRETS_ENTRY.replace('.', '\\.')}|knowledge/${UUID}/meta\\.json|knowledge/${UUID}/docs/${UUID}(?:\\.sum)?\\.txt)$`
)
export const isAllowedEntry = (name: string): boolean => ALLOWED.test(name)

function deriveKey(password: string, salt: Buffer): Buffer {
  return scryptSync(password.normalize('NFC'), salt, 32, SCRYPT)
}

/** Liste les fichiers à exporter depuis le dossier de données de l'appli. */
export function collectEntries(dataDir: string): { name: string; file: string }[] {
  const out: { name: string; file: string }[] = []
  for (const f of ['settings.json', 'rag.json']) {
    const p = path.join(dataDir, f)
    if (fs.existsSync(p)) out.push({ name: f, file: p })
  }
  const kb = path.join(dataDir, 'knowledge')
  if (fs.existsSync(kb)) {
    for (const base of fs.readdirSync(kb)) {
      const meta = path.join(kb, base, 'meta.json')
      if (!fs.existsSync(meta)) continue
      out.push({ name: `knowledge/${base}/meta.json`, file: meta })
      const docs = path.join(kb, base, 'docs')
      if (!fs.existsSync(docs)) continue
      for (const d of fs.readdirSync(docs)) out.push({ name: `knowledge/${base}/docs/${d}`, file: path.join(docs, d) })
    }
  }
  return out.filter((e) => isAllowedEntry(e.name))
}

export function summarize(names: string[], keys: boolean, ragDocs: number): ExportSummary {
  const bases = new Set<string>()
  let baseFiles = 0
  for (const n of names) {
    const m = /^knowledge\/([^/]+)\/(meta\.json|docs\/[^/]+\.txt)$/.exec(n)
    if (!m) continue
    bases.add(m[1])
    if (m[2].startsWith('docs/') && !m[2].endsWith('.sum.txt')) baseFiles++
  }
  return { settings: names.includes('settings.json'), profileDocs: ragDocs, bases: bases.size, baseFiles, keys }
}

function packContainer(entries: UnpackedEntry[]): Buffer {
  const parts: Buffer[] = []
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8')
    const head = Buffer.alloc(4 + name.length + 8)
    head.writeUInt32LE(name.length, 0)
    name.copy(head, 4)
    head.writeBigUInt64LE(BigInt(e.data.length), 4 + name.length)
    parts.push(head, e.data)
  }
  return Buffer.concat(parts)
}

function unpackContainer(buf: Buffer): UnpackedEntry[] {
  const out: UnpackedEntry[] = []
  let p = 0
  while (p < buf.length) {
    if (p + 4 > buf.length) throw new Error('fichier abîmé')
    const nl = buf.readUInt32LE(p)
    if (nl === 0 || nl > 512 || p + 4 + nl + 8 > buf.length) throw new Error('fichier abîmé')
    const name = buf.toString('utf8', p + 4, p + 4 + nl)
    const size = Number(buf.readBigUInt64LE(p + 4 + nl))
    const start = p + 4 + nl + 8
    if (start + size > buf.length) throw new Error('fichier abîmé')
    if (!isAllowedEntry(name)) throw new Error(`contenu inattendu dans le fichier (${name.slice(0, 60)})`)
    out.push({ name, data: buf.subarray(start, start + size) })
    p = start + size
  }
  return out
}

/** Construit le fichier d'export complet. */
export function buildExport(o: {
  entries: UnpackedEntry[]
  appVersion: string
  password?: string
  secrets?: Record<string, string>
  ragDocs: number
}): Buffer {
  const entries = [...o.entries]
  const withKeys = !!o.password && !!o.secrets && Object.keys(o.secrets).length > 0
  if (o.secrets && Object.keys(o.secrets).length && !o.password) throw new Error('un mot de passe est obligatoire pour exporter les clés')
  if (withKeys) entries.push({ name: SECRETS_ENTRY, data: Buffer.from(JSON.stringify(o.secrets), 'utf8') })
  const gz = zlib.gzipSync(packContainer(entries), { level: 6 })
  const header: ExportHeader = { v: 1, created: Date.now(), appVersion: o.appVersion, encrypted: !!o.password }
  let body = gz
  if (o.password) {
    if (o.password.length < MIN_PASSWORD) throw new Error(`mot de passe trop court (${MIN_PASSWORD} caractères minimum)`)
    const salt = randomBytes(16)
    const iv = randomBytes(12)
    const c = createCipheriv('aes-256-gcm', deriveKey(o.password, salt), iv)
    c.setAAD(Buffer.from(MAGIC))
    body = Buffer.concat([c.update(gz), c.final(), c.getAuthTag()])
    header.salt = salt.toString('base64')
    header.iv = iv.toString('base64')
  } else {
    header.summary = summarize(
      entries.map((e) => e.name),
      false,
      o.ragDocs
    )
  }
  return Buffer.concat([Buffer.from(`${MAGIC}\n${JSON.stringify(header)}\n`, 'utf8'), body])
}

/** Lit l'en-tête (sans déchiffrer). */
export function readHeader(buf: Buffer): { header: ExportHeader; bodyStart: number } {
  const m = Buffer.from(`${MAGIC}\n`)
  if (buf.length < m.length || !buf.subarray(0, m.length).equals(m)) {
    throw new Error("ce fichier n'est pas un export de Desk Assistant")
  }
  const nl = buf.indexOf(0x0a, m.length)
  if (nl < 0 || nl - m.length > 4096) throw new Error('fichier abîmé')
  const header = JSON.parse(buf.toString('utf8', m.length, nl)) as ExportHeader
  if (header.v !== 1) throw new Error('export créé par une version plus récente : mets à jour Desk Assistant')
  return { header, bodyStart: nl + 1 }
}

/** Déchiffre (si besoin) et décompresse. */
export function openExport(buf: Buffer, password?: string): { header: ExportHeader; entries: UnpackedEntry[]; secrets: Record<string, string> | null } {
  const { header, bodyStart } = readHeader(buf)
  let gz = buf.subarray(bodyStart)
  if (header.encrypted) {
    if (!password) throw new Error('mot de passe requis')
    if (!header.salt || !header.iv || gz.length < 17) throw new Error('fichier abîmé')
    const tag = gz.subarray(gz.length - 16)
    const d = createDecipheriv('aes-256-gcm', deriveKey(password, Buffer.from(header.salt, 'base64')), Buffer.from(header.iv, 'base64'))
    d.setAAD(Buffer.from(MAGIC))
    d.setAuthTag(tag)
    try {
      gz = Buffer.concat([d.update(gz.subarray(0, gz.length - 16)), d.final()])
    } catch {
      throw new Error('mot de passe incorrect (ou fichier modifié)')
    }
  }
  let raw: Buffer
  try {
    raw = zlib.gunzipSync(gz, { maxOutputLength: MAX_UNPACKED })
  } catch {
    throw new Error('fichier abîmé ou trop volumineux')
  }
  const all = unpackContainer(raw)
  let secrets: Record<string, string> | null = null
  const entries: UnpackedEntry[] = []
  for (const e of all) {
    if (e.name === SECRETS_ENTRY) {
      if (!header.encrypted) throw new Error('fichier incohérent (clés non chiffrées)')
      const obj = JSON.parse(e.data.toString('utf8')) as Record<string, unknown>
      secrets = {}
      for (const [k, v] of Object.entries(obj)) if (typeof v === 'string') secrets[k] = v
    } else entries.push(e)
  }
  if (!entries.some((e) => e.name === 'settings.json')) throw new Error('export incomplet (réglages absents)')
  return { header, entries, secrets }
}

/** Copie de sécurité des données actuelles avant un import. Renvoie le dossier créé. */
export function backupData(dataDir: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const dest = path.join(dataDir, 'backups', `avant-import-${stamp}`)
  fs.mkdirSync(dest, { recursive: true })
  for (const f of ['settings.json', 'rag.json', 'secrets.json']) {
    const p = path.join(dataDir, f)
    if (fs.existsSync(p)) fs.copyFileSync(p, path.join(dest, f))
  }
  const kb = path.join(dataDir, 'knowledge')
  if (fs.existsSync(kb)) fs.cpSync(kb, path.join(dest, 'knowledge'), { recursive: true })
  return dest
}

/** Remplace les données de l'appli par celles de l'export. */
export function writeImport(dataDir: string, entries: UnpackedEntry[], fixSettings: (json: string) => string): void {
  const kb = path.join(dataDir, 'knowledge')
  fs.rmSync(kb, { recursive: true, force: true })
  const hasRag = entries.some((e) => e.name === 'rag.json')
  if (!hasRag) fs.rmSync(path.join(dataDir, 'rag.json'), { force: true })
  for (const e of entries) {
    const dest = path.join(dataDir, ...e.name.split('/'))
    // Ceinture et bretelles : le chemin final doit rester dans le dossier de données.
    if (!path.resolve(dest).startsWith(path.resolve(dataDir) + path.sep)) throw new Error('chemin refusé')
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    const data = e.name === 'settings.json' ? Buffer.from(fixSettings(e.data.toString('utf8')), 'utf8') : e.data
    fs.writeFileSync(dest, data)
  }
}
