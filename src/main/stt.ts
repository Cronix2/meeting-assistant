import { EventEmitter } from 'node:events'
import WebSocket from 'ws'
import type { Lang, SttStatus } from '../shared/types'
import { log } from './log'

export interface SttConfig {
  apiKey: string
  language: Lang
  vadSilenceSecs: number
}

const ENDPOINT = 'wss://api.elevenlabs.io/v1/speech-to-text/realtime'
/** Si plus aucun son n'est envoyé pendant ce délai, on ferme la session (et on la rouvre au prochain son). */
const IDLE_CLOSE_MS = 25_000
/** ~8 s d'audio (chunks de 100 ms) mis en attente pendant l'ouverture de la connexion. */
const MAX_PENDING_CHUNKS = 80

const FATAL_RE = /error|quota|rate_limit|throttl|exceeded|terms|overflow|exhausted/i

/**
 * Client Scribe v2 Realtime (WebSocket brut, auth par en-tête xi-api-key — la clé reste dans le process main).
 * Connexion paresseuse : ouverte au premier son, fermée après une période de silence.
 *
 * Événements : 'status' (status, message?), 'partial' (text), 'committed' (text)
 */
export class SttClient extends EventEmitter {
  status: SttStatus = 'idle'
  private ws: WebSocket | null = null
  private ready = false
  private pending: Buffer[] = []
  private idleTimer: NodeJS.Timeout | undefined
  private blockedUntil = 0

  constructor(private getConfig: () => SttConfig | null) {
    super()
  }

  /** PCM 16 kHz, mono, 16 bits little-endian. */
  push(pcm: Buffer): void {
    this.touchIdle()
    if (this.ws && this.ready) {
      this.sendChunk(pcm)
      return
    }
    this.pending.push(pcm)
    if (this.pending.length > MAX_PENDING_CHUNKS) this.pending.shift()
    if (!this.ws) this.connect()
  }

  /** Ferme la session (elle se rouvrira toute seule au prochain son). */
  close(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = undefined
    const ws = this.ws
    this.ws = null
    this.ready = false
    this.pending = []
    if (ws) {
      try {
        ws.close()
      } catch {
        /* déjà fermée */
      }
    }
    this.setStatus('idle')
  }

  private connect(): void {
    if (Date.now() < this.blockedUntil) return
    const cfg = this.getConfig()
    if (!cfg) {
      this.blockedUntil = Date.now() + 3000
      this.fail('Clé API ElevenLabs manquante (Réglages).')
      return
    }
    this.setStatus('connecting')

    const params = new URLSearchParams({
      model_id: 'scribe_v2_realtime',
      audio_format: 'pcm_16000',
      commit_strategy: 'vad',
      vad_silence_threshold_secs: String(cfg.vadSilenceSecs)
    })
    // Langue omise = détection automatique côté ElevenLabs (français / anglais mélangés OK).
    if (cfg.language !== 'auto') params.set('language_code', cfg.language)

    const ws = new WebSocket(`${ENDPOINT}?${params.toString()}`, {
      headers: { 'xi-api-key': cfg.apiKey }
    })
    this.ws = ws
    this.ready = false
    log(`[stt] connexion à ElevenLabs (langue : ${cfg.language})`)

    ws.on('open', () => log('[stt] WebSocket ouverte'))
    ws.on('message', (raw) => this.onMessage(ws, raw.toString()))
    ws.on('unexpected-response', (_req, res) => {
      this.blockedUntil = Date.now() + 5000
      const hint =
        res.statusCode === 401 || res.statusCode === 403 ? ' (clé invalide ?)' : ''
      this.fail(`ElevenLabs : HTTP ${res.statusCode}${hint}`)
      this.dropSocket(ws)
    })
    ws.on('error', (err) => {
      if (this.ws !== ws) return
      this.blockedUntil = Date.now() + 3000
      this.fail(`ElevenLabs : ${err.message}`)
    })
    ws.on('close', () => {
      if (this.ws !== ws) return
      this.ws = null
      this.ready = false
      if (this.status !== 'error') this.setStatus('idle')
    })
  }

  private onMessage(ws: WebSocket, raw: string): void {
    if (this.ws !== ws) return
    let data: { message_type?: string; text?: string; error?: string; message?: string }
    try {
      data = JSON.parse(raw)
    } catch {
      return
    }
    if (
      data.message_type &&
      data.message_type !== 'partial_transcript' &&
      data.message_type !== 'committed_transcript' &&
      data.message_type !== 'committed_transcript_with_timestamps'
    ) {
      log(`[stt] ← ${data.message_type}${data.error || data.message ? ` — ${data.error ?? data.message}` : ''}`)
    }
    switch (data.message_type) {
      case 'session_started':
        this.ready = true
        this.setStatus('ready')
        for (const chunk of this.pending) this.sendChunk(chunk)
        this.pending = []
        break
      case 'partial_transcript':
        if (data.text?.trim()) this.emit('partial', data.text.trim())
        break
      case 'committed_transcript':
        if (data.text?.trim()) this.emit('committed', data.text.trim())
        break
      case 'committed_transcript_with_timestamps':
        break
      default: {
        const type = data.message_type ?? 'inconnu'
        if (FATAL_RE.test(type)) {
          const detail = data.error ?? data.message
          this.blockedUntil = Date.now() + 3000
          this.fail(`ElevenLabs : ${type}${detail ? ` — ${detail}` : ''}`)
          this.dropSocket(ws)
        } else {
          log(`[stt] message ignoré : ${raw.slice(0, 120)}`)
        }
      }
    }
  }

  private sendChunk(pcm: Buffer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(
      JSON.stringify({
        message_type: 'input_audio_chunk',
        audio_base_64: pcm.toString('base64'),
        commit: false,
        sample_rate: 16000
      })
    )
  }

  private dropSocket(ws: WebSocket): void {
    if (this.ws === ws) {
      this.ws = null
      this.ready = false
      this.pending = []
    }
    try {
      ws.terminate()
    } catch {
      /* ignore */
    }
  }

  private touchIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => this.close(), IDLE_CLOSE_MS)
  }

  private fail(message: string): void {
    this.setStatus('error', message)
  }

  private setStatus(status: SttStatus, message?: string): void {
    this.status = status
    log(`[stt] statut=${status}${message ? ` — ${message}` : ''}`)
    this.emit('status', status, message)
  }
}
