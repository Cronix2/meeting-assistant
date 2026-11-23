import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { UpdateState } from '../shared/types'

/**
 * Mises à jour depuis les releases GitHub du projet, sans dépendance :
 * 1. on lit la dernière release publique (API GitHub) ;
 * 2. si sa version est plus récente, on télécharge l'installeur dans le dossier temporaire ;
 * 3. on vérifie son empreinte SHA-256 avec celle publiée par GitHub (fichier abîmé ou remplacé → refus) ;
 * 4. on lance l'installeur en mode silencieux (/S) avec --force-run, qui rouvre l'appli à la fin, et on quitte.
 */

const OWNER = 'Cronix2'
const REPO = 'meeting-assistant'
const API = `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`
const ASSET = /^DeskAssistant-Setup-(\d+\.\d+\.\d+)\.exe$/
/** Les téléchargements ne sont acceptés que depuis GitHub. */
const ALLOWED_HOSTS = /^(?:github\.com|objects\.githubusercontent\.com|release-assets\.githubusercontent\.com|[a-z0-9-]+\.githubusercontent\.com)$/

export interface ReleaseInfo {
  version: string
  tag: string
  name: string
  notes: string
  url: string
  publishedAt: string
  asset: { name: string; url: string; size: number; sha256: string | null }
}

/** Compare deux versions « x.y.z » : >0 si a est plus récente. */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split(/[.-]/).map((n) => parseInt(n, 10) || 0)
  const pb = b.replace(/^v/, '').split(/[.-]/).map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return d
  }
  return 0
}

/** Extrait de la réponse de l'API ce dont on a besoin (et rien d'autre). */
export function parseRelease(json: unknown): ReleaseInfo | null {
  const r = json as {
    tag_name?: string
    name?: string
    body?: string
    html_url?: string
    published_at?: string
    draft?: boolean
    prerelease?: boolean
    assets?: { name?: string; browser_download_url?: string; size?: number; digest?: string | null }[]
  }
  if (!r || r.draft || r.prerelease || typeof r.tag_name !== 'string') return null
  const a = (r.assets ?? []).find((x) => typeof x.name === 'string' && ASSET.test(x.name))
  if (!a?.name || !a.browser_download_url) return null
  const version = ASSET.exec(a.name)![1]
  const digest = typeof a.digest === 'string' && /^sha256:[0-9a-f]{64}$/i.test(a.digest) ? a.digest.slice(7).toLowerCase() : null
  return {
    version,
    tag: r.tag_name,
    name: r.name || r.tag_name,
    notes: cleanNotes(r.body ?? ''),
    url: r.html_url ?? `https://github.com/${OWNER}/${REPO}/releases`,
    publishedAt: r.published_at ?? '',
    asset: { name: a.name, url: a.browser_download_url, size: Number(a.size) || 0, sha256: digest }
  }
}

/** Notes de version lisibles (sans le markdown de GitHub). */
function cleanNotes(md: string): string {
  return md
    .replace(/\r/g, '')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https:\/\/github\.com\/\S+\/pull\/(\d+)/g, '#$1')
    .replace(/https:\/\/github\.com\/\S+\/compare\/(\S+)/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 3000)
}

export interface UpdaterDeps {
  currentVersion: string
  /** L'appli installée (pas en mode développement) : on peut se mettre à jour */
  canInstall: boolean
  emit: (s: UpdateState) => void
  log: (m: string) => void
  /** Quitte l'appli proprement après le lancement de l'installeur */
  quit: () => void
  fetchImpl?: typeof fetch
  tmpDir?: string
}

export class Updater {
  private state: UpdateState
  private release: ReleaseInfo | null = null
  private file = ''
  private abort: AbortController | null = null
  private timer: NodeJS.Timeout | null = null
  private readonly f: typeof fetch

  constructor(private readonly d: UpdaterDeps) {
    this.f = d.fetchImpl ?? fetch
    this.state = { status: 'idle', current: d.currentVersion, canInstall: d.canInstall }
  }

  get snapshot(): UpdateState {
    return this.state
  }

  private set(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch }
    this.d.emit(this.state)
  }

  /** Vérifie au démarrage (après un délai) puis toutes les 6 heures. */
  schedule(enabled: boolean): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (!enabled) return
    setTimeout(() => void this.check(true), 15_000)
    this.timer = setInterval(() => void this.check(true), 6 * 3600_000)
  }

  async check(quiet = false): Promise<UpdateState> {
    if (this.state.status === 'downloading' || this.state.status === 'installing') return this.state
    if (!quiet) this.set({ status: 'checking', error: undefined })
    try {
      const res = await this.f(API, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': `DeskAssistant/${this.d.currentVersion}` },
        signal: AbortSignal.timeout(15_000)
      })
      if (res.status === 404) throw new Error('aucune version publiée pour l’instant')
      if (res.status === 403) throw new Error('GitHub limite les vérifications : réessaie dans une heure')
      if (!res.ok) throw new Error(`GitHub a répondu ${res.status}`)
      const rel = parseRelease(await res.json())
      const checkedAt = Date.now()
      if (!rel) {
        this.set({ status: 'uptodate', checkedAt, error: undefined })
        return this.state
      }
      this.release = rel
      const newer = compareVersions(rel.version, this.d.currentVersion) > 0
      // Déjà téléchargée (même version) : on garde l'état « prête ».
      if (newer && this.state.status === 'ready' && this.state.latest === rel.version) return this.state
      this.set({
        status: newer ? 'available' : 'uptodate',
        latest: rel.version,
        notes: rel.notes,
        releaseUrl: rel.url,
        size: rel.asset.size,
        publishedAt: rel.publishedAt,
        checkedAt,
        error: undefined
      })
      if (newer) this.d.log(`[mise à jour] version ${rel.version} disponible (actuelle ${this.d.currentVersion})`)
    } catch (e) {
      const msg = e instanceof Error ? (e.name === 'TimeoutError' ? 'pas de réponse de GitHub (connexion ?)' : e.message) : String(e)
      if (!quiet) this.set({ status: 'error', error: `Vérification impossible : ${msg}.` })
      else this.d.log(`[mise à jour] vérification impossible : ${msg}`)
    }
    return this.state
  }

  /** Télécharge l'installeur et vérifie son empreinte. */
  async download(): Promise<UpdateState> {
    const rel = this.release
    if (!rel || this.state.status === 'downloading') return this.state
    if (!rel.asset.sha256) {
      this.set({ status: 'error', error: 'GitHub ne fournit pas l’empreinte de cet installeur : télécharge-le depuis la page de la version.' })
      return this.state
    }
    const dir = path.join(this.d.tmpDir ?? os.tmpdir(), 'desk-assistant-update')
    fs.mkdirSync(dir, { recursive: true })
    const dest = path.join(dir, rel.asset.name)
    const part = `${dest}.part`
    this.abort = new AbortController()
    this.set({ status: 'downloading', progress: 0, received: 0, error: undefined })
    try {
      // Déjà téléchargé et intact : inutile de recommencer.
      if (fs.existsSync(dest) && (await sha256File(dest)) === rel.asset.sha256) {
        this.file = dest
        this.set({ status: 'ready', progress: 1 })
        return this.state
      }
      const res = await this.f(rel.asset.url, {
        headers: { 'User-Agent': `DeskAssistant/${this.d.currentVersion}`, Accept: 'application/octet-stream' },
        redirect: 'follow',
        signal: this.abort.signal
      })
      const host = (() => {
        try {
          return new URL(res.url || rel.asset.url).hostname
        } catch {
          return ''
        }
      })()
      if (!ALLOWED_HOSTS.test(host)) throw new Error(`téléchargement refusé depuis ${host || 'une adresse inconnue'}`)
      if (!res.ok || !res.body) throw new Error(`GitHub a répondu ${res.status}`)
      const total = Number(res.headers.get('content-length')) || rel.asset.size
      const hash = createHash('sha256')
      const out = fs.createWriteStream(part)
      let received = 0
      let last = 0
      const reader = res.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        hash.update(value)
        received += value.length
        if (!out.write(value)) await new Promise<void>((r) => out.once('drain', r))
        if (Date.now() - last > 200) {
          last = Date.now()
          this.set({ progress: total ? received / total : 0, received })
        }
      }
      await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())))
      const got = hash.digest('hex')
      if (got !== rel.asset.sha256) {
        fs.rmSync(part, { force: true })
        throw new Error('l’empreinte du fichier ne correspond pas à celle publiée par GitHub (fichier abîmé ou modifié) : il a été supprimé')
      }
      fs.renameSync(part, dest)
      this.file = dest
      this.d.log(`[mise à jour] ${rel.asset.name} téléchargé et vérifié (sha256 ${got.slice(0, 12)}…)`)
      this.set({ status: 'ready', progress: 1, received })
    } catch (e) {
      fs.rmSync(part, { force: true })
      const aborted = this.abort?.signal.aborted
      this.set({
        status: aborted ? 'available' : 'error',
        progress: undefined,
        error: aborted ? undefined : `Téléchargement impossible : ${e instanceof Error ? e.message : String(e)}.`
      })
    } finally {
      this.abort = null
    }
    return this.state
  }

  cancel(): void {
    this.abort?.abort()
  }

  /** Lance l'installeur (silencieux, relance l'appli à la fin) puis quitte. */
  install(): UpdateState {
    if (this.state.status !== 'ready' || !this.file || !fs.existsSync(this.file)) return this.state
    if (!this.d.canInstall) {
      this.set({ status: 'error', error: 'Mode développement : lance l’installeur à la main (dossier temporaire desk-assistant-update).' })
      return this.state
    }
    this.set({ status: 'installing' })
    this.d.log(`[mise à jour] installation de la version ${this.state.latest}`)
    const child = spawn(this.file, ['/S', '--force-run'], { detached: true, stdio: 'ignore', windowsHide: false })
    child.unref()
    setTimeout(() => this.d.quit(), 800)
    return this.state
  }
}

function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    fs.createReadStream(file)
      .on('data', (c) => h.update(c))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')))
  })
}
