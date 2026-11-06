import fs from 'node:fs'
import path from 'node:path'
import { app, safeStorage } from 'electron'
import { DEFAULT_SETTINGS, DEFAULT_SYSTEM_PROMPT, LEGACY_DEFAULT_PROMPTS } from '../shared/defaults'
import type { Lang, Mode, Settings, SettingsPatch } from '../shared/types'

const settingsPath = () => path.join(app.getPath('userData'), 'settings.json')
const secretsPath = () => path.join(app.getPath('userData'), 'secrets.json')

// ---------- Utilitaires de validation ----------

const clamp = (v: unknown, min: number, max: number, fallback: number): number => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(v as T) ? (v as T) : fallback
const nonEmpty = (v: unknown, fallback: string): string =>
  typeof v === 'string' && v.trim() ? v.trim() : fallback
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback)

export function sanitize(s: Settings): Settings {
  const d = DEFAULT_SETTINGS
  const o = s.overlay ?? d.overlay
  const h = s.hotkeys ?? d.hotkeys
  const optNum = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : undefined
  return {
    mode: oneOf<Mode>(s.mode, ['manual', 'auto'], d.mode),
    sttLanguage: oneOf<Lang>(s.sttLanguage, ['auto', 'fr', 'en'], d.sttLanguage),
    replyLanguage: oneOf<Lang>(s.replyLanguage, ['auto', 'fr', 'en'], d.replyLanguage),
    systemPrompt:
      typeof s.systemPrompt === 'string' && s.systemPrompt.trim()
        ? s.systemPrompt
        : DEFAULT_SYSTEM_PROMPT,
    model: nonEmpty(s.model, d.model),
    maxTokens: Math.round(clamp(s.maxTokens, 50, 4000, d.maxTokens)),
    bufferMinutes: clamp(s.bufferMinutes, 0.5, 30, d.bufferMinutes),
    autoDebounceMs: Math.round(clamp(s.autoDebounceMs, 0, 10000, d.autoDebounceMs)),
    autoMinGapMs: Math.round(clamp(s.autoMinGapMs, 0, 60000, d.autoMinGapMs)),
    autoOnlyQuestions: bool(s.autoOnlyQuestions, d.autoOnlyQuestions),
    vadSilenceSecs: clamp(s.vadSilenceSecs, 0.3, 3, d.vadSilenceSecs),
    silenceGate: bool(s.silenceGate, d.silenceGate),
    gateThreshold: clamp(s.gateThreshold, 0.0005, 0.1, d.gateThreshold),
    audioSource: nonEmpty(s.audioSource, d.audioSource),
    sessionContext: typeof s.sessionContext === 'string' ? s.sessionContext.slice(0, 2000) : d.sessionContext,
    numbersInWords: bool(s.numbersInWords, d.numbersInWords),
    autoEarly: bool(s.autoEarly, d.autoEarly),
    ragEnabled: bool(s.ragEnabled, d.ragEnabled),
    ragProfile: typeof s.ragProfile === 'string' ? s.ragProfile.slice(0, 8000) : d.ragProfile,
    ragTopK: Math.round(clamp(s.ragTopK, 1, 10, d.ragTopK)),
    mixerAutoSonar: bool(s.mixerAutoSonar, d.mixerAutoSonar),
    mixerDevices: Array.isArray(s.mixerDevices)
      ? [...new Set(s.mixerDevices.filter((x): x is string => typeof x === 'string' && x.length > 0))].slice(0, 32)
      : d.mixerDevices,
    autoListen: bool(s.autoListen, d.autoListen),
    startHidden: bool(s.startHidden, d.startHidden),
    launchAtStartup: bool(s.launchAtStartup, d.launchAtStartup),
    hotkeys: {
      toggle: nonEmpty(h.toggle, d.hotkeys.toggle),
      ask: nonEmpty(h.ask, d.hotkeys.ask),
      clear: nonEmpty(h.clear, d.hotkeys.clear)
    },
    overlay: {
      x: optNum(o.x),
      y: optNum(o.y),
      width: Math.round(clamp(o.width, 280, 1400, d.overlay.width)),
      height: Math.round(clamp(o.height, 140, 1000, d.overlay.height)),
      opacity: clamp(o.opacity, 0.3, 1, d.overlay.opacity),
      fontSize: Math.round(clamp(o.fontSize, 10, 28, d.overlay.fontSize)),
      contentProtection: bool(o.contentProtection, d.overlay.contentProtection),
      showTranscript: bool(o.showTranscript, d.overlay.showTranscript)
    }
  }
}

type PartialSettings = NonNullable<SettingsPatch['settings']>

export function merge(base: Settings, patch: PartialSettings | Partial<Settings>): Settings {
  const p = patch as PartialSettings
  return {
    ...base,
    ...p,
    hotkeys: { ...base.hotkeys, ...(p.hotkeys ?? {}) },
    overlay: { ...base.overlay, ...(p.overlay ?? {}) }
  } as Settings
}

// ---------- Lecture / écriture des réglages ----------

export function loadSettings(): Settings {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'))
    // v2 : réglages de rapidité. Les anciennes valeurs par défaut passent aux nouvelles (une seule fois).
    // v3 : mémoire de conversation plus longue (3 → 8 minutes si laissé par défaut).
    if ((Number(parsed._v) || 1) < 3 && parsed.bufferMinutes === 3) delete parsed.bufferMinutes
    if ((Number(parsed._v) || 1) < 2) {
      if (parsed.vadSilenceSecs === 0.8) delete parsed.vadSilenceSecs
      if (parsed.autoDebounceMs === 600) delete parsed.autoDebounceMs
      if (parsed.autoMinGapMs === 2500) delete parsed.autoMinGapMs
    }
    // Prompt système resté à l'ancienne valeur par défaut → on passe à la nouvelle.
    const norm = (t: string) => t.replace(/\s+/g, ' ').trim()
    if (
      typeof parsed.systemPrompt === 'string' &&
      LEGACY_DEFAULT_PROMPTS.some((l) => norm(l) === norm(parsed.systemPrompt))
    ) {
      delete parsed.systemPrompt
    }
    return sanitize(merge(DEFAULT_SETTINGS, parsed))
  } catch {
    return sanitize(merge(DEFAULT_SETTINGS, {}))
  }
}

export function saveSettings(s: Settings): void {
  const file = settingsPath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify({ ...s, _v: 3 }, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}

// ---------- Clés API (chiffrées avec safeStorage / DPAPI) ----------

export type SecretName = 'elevenlabs' | 'anthropic'
const ENV_NAMES: Record<SecretName, string> = {
  elevenlabs: 'ELEVENLABS_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY'
}

function readSecrets(): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(secretsPath(), 'utf8')) as Record<string, string>
  } catch {
    return {}
  }
}

export function encryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

export function getSecret(name: SecretName): string | undefined {
  const enc = readSecrets()[name]
  if (enc && encryptionAvailable()) {
    try {
      const v = safeStorage.decryptString(Buffer.from(enc, 'base64')).trim()
      if (v) return v
    } catch {
      /* clé illisible : on retombe sur la variable d'environnement */
    }
  }
  return process.env[ENV_NAMES[name]]?.trim() || undefined
}

/** '' = effacer. Retourne false si le chiffrement n'est pas disponible (on refuse alors de stocker en clair). */
export function setSecret(name: SecretName, value: string): boolean {
  const secrets = readSecrets()
  const v = value.trim()
  if (!v) {
    delete secrets[name]
  } else {
    if (!encryptionAvailable()) return false
    secrets[name] = safeStorage.encryptString(v).toString('base64')
  }
  fs.mkdirSync(path.dirname(secretsPath()), { recursive: true })
  fs.writeFileSync(secretsPath(), JSON.stringify(secrets), 'utf8')
  return true
}
