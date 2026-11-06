import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type { RenderDevice } from '../shared/types'
import { log } from './log'

/**
 * Helper natif Windows (helper/LoopbackMixer.cs) : capture en loopback plusieurs sorties audio à la fois
 * (par ex. les canaux SteelSeries Sonar Game / Chat / Média / Aux), les mixe et renvoie du PCM 16 kHz mono.
 *
 * Il est compilé au premier usage avec le compilateur C# fourni avec Windows (csc.exe, .NET Framework) :
 * rien à installer. L'exécutable compilé est mis en cache dans le dossier de données de l'appli.
 */

const CHUNK_BYTES = 3200 // 100 ms de PCM 16 kHz mono 16 bits

function sourcePath(): string {
  const candidates = [
    path.join(process.resourcesPath ?? '', 'LoopbackMixer.cs'),
    path.join(app.getAppPath(), 'helper', 'LoopbackMixer.cs')
  ]
  const found = candidates.find((p) => fs.existsSync(p))
  if (!found) throw new Error('helper/LoopbackMixer.cs introuvable')
  return found
}

function findCsc(): string {
  const win = process.env['WINDIR'] ?? 'C:\\Windows'
  const candidates = [
    path.join(win, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(win, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe')
  ]
  const found = candidates.find((p) => fs.existsSync(p))
  if (!found) throw new Error('compilateur C# de Windows (csc.exe, .NET Framework 4) introuvable')
  return found
}

function run(file: string, args: string[], timeout: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const detail = (stdout || stderr || err.message).toString().trim().slice(0, 900)
        reject(new Error(detail))
      } else {
        resolve({ stdout: stdout.toString(), stderr: stderr.toString() })
      }
    })
  })
}

let building: Promise<string> | null = null

/** Retourne le chemin de l'exécutable du helper (compilé si nécessaire). */
export function ensureHelper(): Promise<string> {
  if (!building) {
    building = build().catch((e) => {
      building = null
      throw e
    })
  }
  return building
}

async function build(): Promise<string> {
  if (process.platform !== 'win32') throw new Error('le mixeur de sorties n’existe que sous Windows')
  const src = sourcePath()
  const dir = path.join(app.getPath('userData'), 'helper')
  fs.mkdirSync(dir, { recursive: true })

  const hash = createHash('sha1').update(fs.readFileSync(src)).digest('hex').slice(0, 10)
  const exeName = `LoopbackMixer-${hash}.exe`
  const exe = path.join(dir, exeName)
  if (fs.existsSync(exe)) return exe

  const csc = findCsc()
  log('[mixeur] compilation du helper audio (première utilisation, quelques secondes)…')
  try {
    await run(csc, ['/nologo', '/optimize+', '/target:exe', '/codepage:65001', `/out:${exe}`, src], 90_000)
  } catch (e) {
    throw new Error(`compilation du helper audio échouée : ${e instanceof Error ? e.message : String(e)}`)
  }
  if (!fs.existsSync(exe)) throw new Error('compilation du helper audio : exécutable non produit')
  log('[mixeur] helper audio prêt')

  // Nettoyage des anciennes versions.
  for (const f of fs.readdirSync(dir)) {
    if (/^LoopbackMixer-.*\.exe$/.test(f) && f !== exeName) {
      try {
        fs.unlinkSync(path.join(dir, f))
      } catch {
        /* encore utilisé ou verrouillé : tant pis */
      }
    }
  }
  return exe
}

/** Liste les sorties audio Windows actives. */
export async function listRenderDevices(): Promise<RenderDevice[]> {
  const exe = await ensureHelper()
  const { stdout } = await run(exe, ['--list'], 10_000)
  const parsed = JSON.parse(stdout.trim()) as RenderDevice[]
  return Array.isArray(parsed) ? parsed : []
}

/** Canaux virtuels SteelSeries Sonar (hors entrées « Stream » / « Microphone »). */
export const isSonarChannel = (d: RenderDevice): boolean =>
  /sonar/i.test(d.name) && !/stream|microphone|micro\b|\bmic\b/i.test(d.name)

export function autoSonarIds(devices: RenderDevice[]): string[] {
  return devices.filter(isSonarChannel).map((d) => d.id)
}

/** Sorties à capturer : canaux Sonar (si activé) + sorties cochées ; à défaut la sortie par défaut de Windows. */
export function pickDevices(
  devices: RenderDevice[],
  opts: { mixerAutoSonar: boolean; mixerDevices: string[] }
): string[] {
  const existing = new Set(devices.map((d) => d.id))
  const ids = new Set<string>()
  if (opts.mixerAutoSonar) for (const id of autoSonarIds(devices)) ids.add(id)
  for (const id of opts.mixerDevices) if (existing.has(id)) ids.add(id)
  if (ids.size === 0) {
    const def = devices.find((d) => d.isDefault)
    if (def) ids.add(def.id)
  }
  return [...ids]
}

export interface MixerLevel {
  mix: number
  devices: { name: string; rms: number }[]
}

/**
 * Processus helper en cours d'exécution.
 * Événements : 'audio' (Buffer 100 ms), 'level' (MixerLevel), 'warn' (string), 'exit' (string) — 'exit' seulement
 * si le helper s'arrête sans que stop() ait été appelé.
 */
export class MixerCapture extends EventEmitter {
  private proc: ChildProcess | null = null
  private pending: Buffer = Buffer.alloc(0)
  private errBuf = ''
  private stopped = false
  private lastError = ''
  deviceNames: string[] = []

  constructor(
    private exe: string,
    private ids: string[]
  ) {
    super()
  }

  /** Résout avec les noms des sorties ouvertes quand le helper est prêt. */
  start(): Promise<string[]> {
    return new Promise((resolve, reject) => {
      let settled = false
      const fail = (message: string) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.stop()
        reject(new Error(message))
      }

      const proc = spawn(this.exe, ['--capture', ...this.ids], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      })
      this.proc = proc

      const timer = setTimeout(() => fail('le helper audio n’a pas démarré (délai dépassé)'), 10_000)

      proc.on('error', (err) => fail(`lancement du helper audio impossible : ${err.message}`))
      proc.stdin?.on('error', () => {})

      proc.stdout?.on('data', (d: Buffer) => {
        this.pending = this.pending.length ? Buffer.concat([this.pending, d]) : d
        while (this.pending.length >= CHUNK_BYTES) {
          this.emit('audio', Buffer.from(this.pending.subarray(0, CHUNK_BYTES)))
          this.pending = this.pending.subarray(CHUNK_BYTES)
        }
      })

      proc.stderr?.on('data', (d: Buffer) => {
        this.errBuf += d.toString('utf8')
        let nl: number
        while ((nl = this.errBuf.indexOf('\n')) >= 0) {
          const line = this.errBuf.slice(0, nl).trim()
          this.errBuf = this.errBuf.slice(nl + 1)
          if (line) this.onEvent(line, (names) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            this.deviceNames = names
            resolve(names)
          })
        }
      })

      proc.on('exit', (code) => {
        this.proc = null
        if (!settled) {
          fail(this.lastError || `le helper audio s’est arrêté (code ${code})`)
        } else if (!this.stopped) {
          this.emit('exit', this.lastError || `le helper audio s’est arrêté (code ${code})`)
        }
      })
    })
  }

  private onEvent(line: string, onReady: (names: string[]) => void): void {
    let ev: { type?: string; message?: string; devices?: unknown; mix?: number }
    try {
      ev = JSON.parse(line)
    } catch {
      log(`[mixeur] ${line.slice(0, 200)}`)
      return
    }
    switch (ev.type) {
      case 'ready':
        onReady(Array.isArray(ev.devices) ? (ev.devices as string[]) : [])
        break
      case 'level':
        this.emit('level', {
          mix: Number(ev.mix) || 0,
          devices: Array.isArray(ev.devices) ? (ev.devices as MixerLevel['devices']) : []
        } satisfies MixerLevel)
        break
      case 'warn':
        this.emit('warn', ev.message ?? '')
        break
      case 'error':
        this.lastError = ev.message ?? 'erreur inconnue'
        break
    }
  }

  stop(): void {
    this.stopped = true
    const proc = this.proc
    if (!proc) return
    this.proc = null
    try {
      proc.stdin?.end() // le helper s'arrête quand stdin se ferme
    } catch {
      /* ignore */
    }
    const killer = setTimeout(() => {
      try {
        proc.kill()
      } catch {
        /* ignore */
      }
    }, 400)
    killer.unref()
    proc.once('exit', () => clearTimeout(killer))
  }
}
