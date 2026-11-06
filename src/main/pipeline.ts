import type { AppState, CaptureOptions, Mode, Settings, SttStatus } from '../shared/types'
import { TranscriptBuffer } from './buffer'
import { Responder, buildSystem, buildUserMessage } from './llm'
import { log } from './log'
import { buildMemory } from './rag'
import { getSecret } from './settings'
import { SttClient } from './stt'

export interface PipelineDeps {
  getSettings(): Settings
  /** Envoie un message à l'overlay. */
  send(channel: string, payload?: unknown): void
  startCapture(opts: CaptureOptions): Promise<void>
  stopCapture(): Promise<void>
  onStateChange(state: AppState): void
}

const QUESTION_RE =
  /^(est-ce|qu['’e]|quoi|pourquoi|comment|quand|où|qui|combien|quel|quelle|quels|quelles|peux|pouvez|pourrais|pourriez|sais-tu|savez|what|why|how|when|where|who|which|can|could|would|should|do|does|did|is|are|will)\b/i

export const looksLikeQuestion = (text: string): boolean =>
  text.includes('?') || QUESTION_RE.test(text.trim())

const EARLY_STABLE_MS = 350 // transcription partielle immobile depuis…
const EARLY_QUESTION_MS = 120 // … ou déjà terminée par un point d'interrogation

const norm = (t: string): string =>
  t
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** Vrai si la phrase validée est (presque) celle sur laquelle la réponse anticipée est partie. */
function sameSentence(early: string, committed: string): boolean {
  const a = norm(early)
  const b = norm(committed)
  if (!a || !b) return false
  if (b.length - a.length > 14) return false // la phrase validée est nettement plus longue : on relance
  if (a.includes(b) || b.includes(a)) return true
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  return i >= 0.8 * Math.min(a.length, b.length)
}

const wordCount = (text: string): number => text.trim().split(/\s+/).filter(Boolean).length

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** Cerveau de l'appli : audio → Scribe → buffer → (auto | manuel) → Claude → overlay. */
export class Pipeline {
  state: AppState
  private buffer = new TranscriptBuffer()
  private responder = new Responder()
  private stt: SttClient
  private lastPartial = ''
  private lastPartialAt = 0
  private autoTimer: NodeJS.Timeout | undefined
  private earlyTimer: NodeJS.Timeout | undefined
  /** Dernière demande anticipée (lancée sur une transcription partielle) */
  private early: { text: string } | null = null
  private lastAskAt = 0

  constructor(private deps: PipelineDeps) {
    this.state = { listening: false, capture: 'off', stt: 'idle', mode: deps.getSettings().mode }

    this.stt = new SttClient(() => {
      const apiKey = getSecret('elevenlabs')
      if (!apiKey) return null
      const s = deps.getSettings()
      return { apiKey, language: s.sttLanguage, vadSilenceSecs: s.vadSilenceSecs }
    })
    this.stt.on('status', (status: SttStatus, message?: string) => {
      // On ne masque pas une erreur de capture par un statut STT bénin.
      const keep = this.state.capture === 'error' ? this.state.message : undefined
      this.patch({ stt: status, message: status === 'error' ? message : keep })
    })
    this.stt.on('partial', (text: string) => {
      this.lastPartial = text
      this.lastPartialAt = Date.now()
      deps.send('transcript:partial', text)
      this.scheduleEarly(text)
    })
    this.stt.on('committed', (text: string) => this.onCommitted(text))
  }

  // ---------- Écoute ----------

  async start(): Promise<void> {
    if (this.state.listening) return
    this.patch({ listening: true, capture: 'off', message: undefined })
    const s = this.deps.getSettings()
    try {
      await this.deps.startCapture({
        gate: s.silenceGate,
        threshold: s.gateThreshold,
        deviceId: s.audioSource
      })
      this.patch({ capture: 'on' })
    } catch (e) {
      this.patch({
        listening: false,
        capture: 'error',
        message: `Capture audio impossible : ${errMsg(e)}`
      })
    }
  }

  async stop(): Promise<void> {
    if (this.autoTimer) clearTimeout(this.autoTimer)
    try {
      await this.deps.stopCapture()
    } catch {
      /* ignore */
    }
    this.stt.close()
    this.lastPartial = ''
    this.patch({ listening: false, capture: 'off', stt: 'idle', message: undefined })
  }

  async toggleListening(): Promise<void> {
    if (this.state.listening) await this.stop()
    else await this.start()
  }

  /** Appelé pour chaque chunk PCM 16 kHz reçu du renderer de capture. */
  onAudio(chunk: Buffer): void {
    if (!this.state.listening) return
    this.stt.push(chunk)
  }

  onCaptureError(message: string): void {
    this.patch({ listening: false, capture: 'error', message: `Capture audio : ${message}` })
    this.stt.close()
  }

  // ---------- Transcription → Claude ----------

  private onCommitted(text: string): void {
    this.lastPartial = ''
    if (this.earlyTimer) clearTimeout(this.earlyTimer)
    this.buffer.append(text)
    log(`[stt] phrase validée (${wordCount(text)} mots)`)
    this.deps.send('transcript:committed', text)
    // Une réponse anticipée est déjà partie sur (à peu près) cette phrase : on la garde.
    const early = this.early
    this.early = null
    if (early && sameSentence(early.text, text)) {
      log('[auto] réponse anticipée conservée')
      return
    }
    this.scheduleAuto(text)
  }

  /**
   * Mode auto « anticipé » : dès que la transcription partielle ressemble à une question et ne bouge plus
   * pendant un court instant, on lance Claude sans attendre la validation de la phrase (~0,5 à 1 s gagnée).
   */
  private scheduleEarly(text: string): void {
    const s = this.deps.getSettings()
    if (this.earlyTimer) clearTimeout(this.earlyTimer)
    if (s.mode !== 'auto' || !s.autoEarly) return
    if (wordCount(text) < 4 || !looksLikeQuestion(text)) return
    const wait = text.trim().endsWith('?') ? EARLY_QUESTION_MS : EARLY_STABLE_MS
    this.earlyTimer = setTimeout(() => {
      if (Date.now() - this.lastAskAt < s.autoMinGapMs) return
      if (this.early && sameSentence(this.early.text, text)) return
      this.early = { text }
      log('[auto] réponse anticipée (phrase pas encore validée)')
      void this.ask('auto', true)
    }, wait)
  }

  private scheduleAuto(text: string): void {
    const s = this.deps.getSettings()
    if (s.mode !== 'auto') return
    if (wordCount(text) < 3) return
    if (s.autoOnlyQuestions && !looksLikeQuestion(text)) return
    if (this.autoTimer) clearTimeout(this.autoTimer)
    const sinceLast = Date.now() - this.lastAskAt
    const wait = Math.max(s.autoDebounceMs, s.autoMinGapMs - sinceLast)
    this.autoTimer = setTimeout(() => void this.ask('auto'), wait)
  }

  async ask(trigger: 'manual' | 'auto', early = false): Promise<void> {
    const s = this.deps.getSettings()
    const apiKey = getSecret('anthropic')
    if (!apiKey) {
      this.deps.send('answer:error', 'Clé API Claude manquante (Réglages).')
      return
    }
    let transcript = this.buffer.recent(s.bufferMinutes)
    if ((trigger === 'manual' || early) && this.lastPartial) {
      transcript += `${transcript ? '\n' : ''}${this.lastPartial}${early ? '' : ' …'}`
    }
    if (!transcript.trim()) {
      if (trigger === 'manual') {
        this.deps.send('answer:error', "Rien à analyser pour l'instant : aucune parole transcrite.")
      }
      return
    }

    const tAsk = Date.now()
    let tFirst = 0
    this.lastAskAt = tAsk
    log(`[claude] demande ${trigger}${early ? ' anticipée' : ''} — ${transcript.length} caractères de transcription, modèle ${s.model}`)
    this.deps.send('answer:start', { trigger })
    await this.responder.ask({
      apiKey,
      model: s.model,
      system: buildSystem(s, buildMemory(s, transcript)),
      user: buildUserMessage(transcript, trigger),
      maxTokens: s.maxTokens,
      onDelta: (d) => {
        if (!tFirst) {
          tFirst = Date.now()
          const ttft = tFirst - tAsk
          const sinceSpeech =
            this.lastPartialAt && tAsk - this.lastPartialAt < 30_000 ? tFirst - this.lastPartialAt : undefined
          const sec = (ms: number) => (ms / 1000).toFixed(1)
          log(
            `[perf] premier mot : ${sec(ttft)} s après l'envoi à Claude` +
              (sinceSpeech !== undefined ? ` · ${sec(sinceSpeech)} s après le dernier mot reconnu` : '')
          )
          this.deps.send('perf', { trigger, ttft, sinceSpeech })
        }
        this.deps.send('answer:delta', d)
      },
      onDone: (full) => {
        const text = full.trim()
        log(`[claude] réponse reçue (${text.length} caractères, ${((Date.now() - tAsk) / 1000).toFixed(1)} s au total)`)
        if (text === '—' || text === '') {
          // En manuel, l'utilisateur doit toujours voir un retour ; en auto, on garde l'ancienne réponse.
          if (trigger === 'manual') {
            this.deps.send('answer:error', 'Claude n’a rien à répondre aux derniers échanges.')
          } else {
            this.deps.send('answer:skip')
          }
        } else {
          this.buffer.appendAnswer(text)
          this.deps.send('answer:done')
        }
      },
      onError: (m) => {
        log(`[claude] erreur : ${m}`)
        this.deps.send('answer:error', m)
      }
    })
  }

  clear(): void {
    if (this.autoTimer) clearTimeout(this.autoTimer)
    if (this.earlyTimer) clearTimeout(this.earlyTimer)
    this.early = null
    this.responder.cancel()
    this.buffer.clear()
    this.lastPartial = ''
    this.deps.send('answer:clear')
  }

  // ---------- Réglages ----------

  setMode(mode: Mode): void {
    if (mode === 'manual') {
      if (this.autoTimer) clearTimeout(this.autoTimer)
      if (this.earlyTimer) clearTimeout(this.earlyTimer)
    }
    this.patch({ mode })
  }

  /** À appeler après une modification des réglages. */
  async applySettings(prev: Settings): Promise<void> {
    const s = this.deps.getSettings()
    this.setMode(s.mode)
    if (prev.sttLanguage !== s.sttLanguage || prev.vadSilenceSecs !== s.vadSilenceSecs) {
      this.stt.close() // se rouvre tout seul avec les nouveaux paramètres
    }
    if (
      this.state.listening &&
      (prev.silenceGate !== s.silenceGate ||
        prev.gateThreshold !== s.gateThreshold ||
        prev.audioSource !== s.audioSource ||
        prev.mixerAutoSonar !== s.mixerAutoSonar ||
        prev.mixerDevices.join('|') !== s.mixerDevices.join('|'))
    ) {
      await this.stop()
      await this.start()
    }
  }

  // ---------- État ----------

  private patch(p: Partial<AppState>): void {
    this.state = { ...this.state, ...p }
    this.deps.send('state', this.state)
    this.deps.onStateChange(this.state)
  }

  pushState(): void {
    this.deps.send('state', this.state)
  }
}
