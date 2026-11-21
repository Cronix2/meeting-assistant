export type Mode = 'manual' | 'auto'
export type Lang = 'auto' | 'fr' | 'en'

export interface Hotkeys {
  /** Afficher / masquer l'overlay */
  toggle: string
  /** Demander une réponse à Claude (mode manuel, ou forcer en auto) */
  ask: string
  /** Vider le buffer de transcription et la réponse affichée */
  clear: string
}

export interface OverlayPrefs {
  x?: number
  y?: number
  width: number
  height: number
  opacity: number
  fontSize: number
  /** Exclut la fenêtre des captures d'écran / partages d'écran */
  contentProtection: boolean
  /** Affiche la ligne de transcription en direct sous la réponse */
  showTranscript: boolean
}

export interface Settings {
  mode: Mode
  sttLanguage: Lang
  replyLanguage: Lang
  systemPrompt: string
  model: string
  maxTokens: number
  /** Fenêtre glissante de transcription envoyée à Claude (minutes) */
  bufferMinutes: number
  autoDebounceMs: number
  autoMinGapMs: number
  autoOnlyQuestions: boolean
  /** Silence (s) pour que Scribe valide une phrase */
  vadSilenceSecs: number
  /** N'envoie à ElevenLabs que lorsqu'il y a du son (économise le temps facturé) */
  silenceGate: boolean
  /** Seuil RMS (0–1) sous lequel l'audio est considéré comme du silence */
  gateThreshold: number
  /**
   * 'loopback' = sortie système par défaut de Windows ; 'mixer' = mixeur natif de plusieurs sorties Windows
   * (SteelSeries Sonar…) ; sinon identifiant d'un périphérique d'entrée audio.
   */
  audioSource: string
  /** Contexte de la session en cours (ex. « exercice d'anglais, je joue un touriste ») ajouté au prompt */
  sessionContext: string
  /** Nombres, dates et heures écrits en toutes lettres dans les réponses */
  numbersInWords: boolean
  /** Mode auto : lance la réponse avant la validation de la phrase (plus rapide) */
  autoEarly: boolean
  /** Mémoire personnelle : ajoute le profil et des extraits de documents au prompt */
  ragEnabled: boolean
  /** Profil permanent, toujours transmis à Claude */
  ragProfile: string
  /** Nombre maximum d'extraits de documents ajoutés par demande */
  ragTopK: number
  /** Mémoire professionnelle : ajoute la fiche et des extraits des bases de connaissances au prompt */
  kbEnabled: boolean
  /** Nombre maximum d'extraits de bases de connaissances ajoutés par demande */
  kbTopK: number
  /** Taille maximale (caractères) des extraits de bases de connaissances par demande */
  kbBudgetChars: number
  /** Résumer chaque fichier avec Claude à l'import (notes consultables) */
  kbAutoSummary: boolean
  /** Mixeur : détecte automatiquement les canaux SteelSeries Sonar (Game, Chat, Média, Aux) */
  mixerAutoSonar: boolean
  /** Mixeur : identifiants de sorties Windows ajoutées à la main */
  mixerDevices: string[]
  autoListen: boolean
  startHidden: boolean
  launchAtStartup: boolean
  hotkeys: Hotkeys
  overlay: OverlayPrefs
}

/** Ce que voit la fenêtre de réglages : jamais les clés elles-mêmes. */
export interface SettingsView extends Settings {
  hasElevenLabsKey: boolean
  hasAnthropicKey: boolean
  /** 4 derniers caractères de la clé utilisée (pour la comparer à la console), '' si inconnue */
  elevenLabsKeyHint: string
  anthropicKeyHint: string
  encryptionAvailable: boolean
}

export interface SettingsPatch {
  settings?: Partial<Omit<Settings, 'hotkeys' | 'overlay'>> & {
    hotkeys?: Partial<Hotkeys>
    overlay?: Partial<OverlayPrefs>
  }
  /** undefined = inchangé, '' = effacer */
  elevenLabsKey?: string
  anthropicKey?: string
}

export interface SaveResult {
  ok: boolean
  hotkeyErrors: string[]
  message?: string
}

export type SttStatus = 'idle' | 'connecting' | 'ready' | 'error'

export interface AppState {
  listening: boolean
  capture: 'off' | 'on' | 'error'
  stt: SttStatus
  mode: Mode
  message?: string
}

export interface OverlayPrefsMessage {
  fontSize: number
  opacity: number
  showTranscript: boolean
  hotkeys: Hotkeys
}

export interface CaptureOptions {
  gate: boolean
  threshold: number
  /** Diagnostic : garde la piste vidéo du partage d'écran au lieu de l'arrêter tout de suite. */
  keepVideo?: boolean
  /** 'loopback' (défaut) ou identifiant d'un périphérique d'entrée */
  deviceId?: string
}

export interface AudioDevice {
  id: string
  label: string
}

export interface RagDoc {
  id: string
  name: string
  chars: number
  chunks: number
  addedAt: number
}

export interface RagChange {
  docs: RagDoc[]
  errors: string[]
}

/** Base de connaissances (mémoire professionnelle) */
export interface KbInfo {
  id: string
  name: string
  enabled: boolean
  /** Présentation écrite par l'utilisateur (« c'est mon projet X, je l'ai codé seul… ») : toujours transmise */
  about: string
  /** Fiche de compréhension (générée par Claude puis modifiable) : toujours transmise */
  brief: string
  briefAt: number
  docs: number
  chars: number
  chunks: number
  /** Nombre de fichiers qui ont une note de résumé */
  summarized: number
  /** Index de recherche en cours de construction */
  indexing: boolean
  createdAt: number
}

export interface KbDocInfo {
  id: string
  label: string
  kind: 'code' | 'text'
  chars: number
  chunks: number
}

export interface KbProgress {
  kbId: string
  task: 'import' | 'index' | 'brief' | 'summary'
  done: number
  total: number
  label: string
  finished?: boolean
  message?: string
}

export interface KbImportResult {
  added: number
  unchanged: number
  skipped: number
  errors: string[]
  truncated: boolean
}

export interface KbBriefEstimate {
  inputChars: number
  calls: number
  approxTokens: number
  sampled: boolean
  /** La synthèse part des notes par fichier plutôt que des fichiers bruts */
  fromNotes?: boolean
}

export interface KbSummaryEstimate {
  /** Fichiers qui vont être résumés */
  files: number
  inputChars: number
  calls: number
  approxTokens: number
}

export interface KbSummaryResult {
  ok: boolean
  message?: string
  done: number
  failed: number
}

export interface KbPatch {
  name?: string
  enabled?: boolean
  about?: string
  brief?: string
}

/** Sortie audio Windows (périphérique de rendu) listée par le helper natif. */
export interface RenderDevice {
  id: string
  name: string
  isDefault: boolean
}

export interface MixerListResult {
  devices: RenderDevice[]
  /** Sorties retenues automatiquement (Sonar) */
  autoIds: string[]
  error?: string
}

/** Niveaux envoyés ~2 fois par seconde à l'overlay et à la fenêtre de réglages. */
export interface LevelMessage {
  source: 'mixer' | 'loopback' | 'device'
  /** Niveau principal (RMS 0–1) */
  rms: number
  /** Second niveau (analyseur) pour les sources du renderer ; = rms pour le mixeur */
  an: number
  /** Morceaux audio transmis au pipeline depuis le début de la capture */
  received: number
  /** Mixeur : niveau par sortie Windows */
  devices?: { name: string; rms: number }[]
  /** Sources du renderer : état interne */
  ctx?: string
  track?: string
  msgs?: number
}

export interface DiagSnapshot {
  state: AppState
  log: string[]
}

export interface Api {
  send(channel: string, payload?: unknown): void
  invoke<T = unknown>(channel: string, payload?: unknown): Promise<T>
  on(channel: string, cb: (payload: any) => void): () => void
}
