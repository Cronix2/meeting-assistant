import { PRESETS } from '../../shared/defaults'
import type {
  AppState,
  AudioDevice,
  DiagSnapshot,
  Lang,
  LevelMessage,
  MixerListResult,
  RagChange,
  RagDoc,
  Mode,
  SaveResult,
  SettingsPatch,
  SettingsView
} from '../../shared/types'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const input = (id: string) => $<HTMLInputElement>(id)
const select = (id: string) => $<HTMLSelectElement>(id)

const CUSTOM = '__custom'
const result = $('result')
const saveBtn = $<HTMLButtonElement>('save')

// ---------- Raccourcis : enregistrement d'une combinaison ----------

const KEY_NAMES: Record<string, string> = {
  ' ': 'Space',
  Enter: 'Enter',
  Backspace: 'Backspace',
  Tab: 'Tab',
  Escape: 'Esc',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right'
}

function toAccelerator(e: KeyboardEvent): string | null {
  if (['Control', 'Shift', 'Alt', 'Meta', 'AltGraph'].includes(e.key)) return null
  const mods: string[] = []
  if (e.ctrlKey) mods.push('Ctrl')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')
  if (e.metaKey) mods.push('Super')
  if (!mods.length) return null

  let key: string | undefined = KEY_NAMES[e.key]
  if (!key) {
    if (/^F\d{1,2}$/.test(e.key)) key = e.key
    else if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3)
    else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5)
    else if (e.key.length === 1) key = e.key.toUpperCase()
  }
  return key ? [...mods, key].join('+') : null
}

document.querySelectorAll<HTMLInputElement>('input.hotkey').forEach((el) => {
  el.addEventListener('keydown', (e) => {
    e.preventDefault()
    const accel = toAccelerator(e)
    if (accel) el.value = accel
  })
})

// ---------- Presets ----------

const presetSel = select('preset')
presetSel.innerHTML =
  `<option value="${CUSTOM}">Personnalisé</option>` +
  PRESETS.map((p) => `<option value="${p.id}">${p.label}</option>`).join('')

presetSel.addEventListener('change', () => {
  const p = PRESETS.find((x) => x.id === presetSel.value)
  if (p) $<HTMLTextAreaElement>('systemPrompt').value = p.prompt
})
$<HTMLTextAreaElement>('systemPrompt').addEventListener('input', syncPresetLabel)

function syncPresetLabel(): void {
  const cur = $<HTMLTextAreaElement>('systemPrompt').value.trim()
  const match = PRESETS.find((p) => p.prompt.trim() === cur)
  presetSel.value = match ? match.id : CUSTOM
}

// ---------- Chargement ----------

async function loadDevices(selected: string): Promise<void> {
  const sel = select('audioSource')
  let devices: AudioDevice[] = []
  try {
    devices = await window.api.invoke<AudioDevice[]>('devices:list')
  } catch {
    /* liste indisponible : on garde au moins le loopback */
  }
  sel.innerHTML = ''
  const add = (value: string, label: string) => {
    const o = document.createElement('option')
    o.value = value
    o.textContent = label
    sel.appendChild(o)
  }
  add('loopback', 'Sortie système — loopback de la sortie par défaut de Windows')
  add('mixer', 'Mixeur de sorties Windows — tous les canaux SteelSeries Sonar (recommandé avec Sonar)')
  for (const d of devices) add(d.id, `Entrée : ${d.label}`)
  if (selected !== 'loopback' && selected !== 'mixer' && !devices.some((d) => d.id === selected)) {
    add(selected, 'Périphérique enregistré (introuvable)')
  }
  sel.value = selected
  syncMixerBox()
}

// ---------- Mixeur de sorties Windows ----------

let mixerResult: MixerListResult | null = null
let mixerSelected = new Set<string>()
let mixerLoaded = false

function syncMixerBox(): void {
  const on = select('audioSource').value === 'mixer'
  $('mixerBox').hidden = !on
  if (on && !mixerLoaded) void loadMixer()
}

async function loadMixer(): Promise<void> {
  mixerLoaded = true
  $('mixerNote').textContent = 'Recherche des sorties audio de Windows… (la première fois, le helper se compile : quelques secondes)'
  try {
    mixerResult = await window.api.invoke<MixerListResult>('mixer:list')
  } catch (err) {
    mixerResult = { devices: [], autoIds: [], error: err instanceof Error ? err.message : String(err) }
  }
  renderMixerList()
}

function renderMixerList(): void {
  const box = $('mixerList')
  box.innerHTML = ''
  const note = $('mixerNote')
  if (!mixerResult) return
  if (mixerResult.error) {
    note.textContent = `Impossible de lister les sorties : ${mixerResult.error}`
    return
  }
  const auto = input('mixerAutoSonar').checked
  for (const d of mixerResult.devices) {
    const isAuto = auto && mixerResult.autoIds.includes(d.id)
    const label = document.createElement('label')
    label.className = 'inline'
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.dataset['id'] = d.id
    cb.checked = isAuto || mixerSelected.has(d.id)
    cb.disabled = isAuto
    cb.addEventListener('change', () => {
      if (cb.checked) mixerSelected.add(d.id)
      else mixerSelected.delete(d.id)
    })
    const text = document.createElement('span')
    text.textContent = d.name
    label.append(cb, text)
    const tags = [isAuto ? 'Sonar (auto)' : '', d.isDefault ? 'par défaut Windows' : ''].filter(Boolean)
    if (tags.length) {
      const tag = document.createElement('span')
      tag.className = 'tag'
      tag.textContent = tags.join(' · ')
      label.append(tag)
    }
    box.appendChild(label)
  }
  const nAuto = auto ? mixerResult.autoIds.length : 0
  note.textContent =
    mixerResult.devices.length === 0
      ? 'Aucune sortie audio active trouvée.'
      : nAuto + mixerSelected.size === 0
        ? 'Aucune sortie sélectionnée : la sortie par défaut de Windows sera utilisée.'
        : auto && nAuto === 0
          ? 'Aucun canal Sonar détecté dans cette liste : coche les sorties à écouter à la main.'
          : `${nAuto} canal(aux) Sonar détecté(s) automatiquement.`
}

select('audioSource').addEventListener('change', syncMixerBox)
input('mixerAutoSonar').addEventListener('change', renderMixerList)
$('refreshMixer').addEventListener('click', () => void loadMixer())

$('refreshDevices').addEventListener('click', () => void loadDevices(select('audioSource').value))

function fill(s: SettingsView): void {
  const defined = (hint: string) => `•••••••• (définie${hint ? `, se termine par « ${hint} »` : ''})`
  input('elevenLabsKey').placeholder = s.hasElevenLabsKey
    ? defined(s.elevenLabsKeyHint)
    : 'Colle ta clé ElevenLabs'
  input('anthropicKey').placeholder = s.hasAnthropicKey
    ? defined(s.anthropicKeyHint)
    : 'Colle ta clé Claude (sk-ant-…)'
  $('encWarn').hidden = s.encryptionAvailable

  select('sttLanguage').value = s.sttLanguage
  input('vadSilenceSecs').value = String(s.vadSilenceSecs)
  input('silenceGate').checked = s.silenceGate
  input('gateThreshold').value = String(s.gateThreshold)
  input('autoListen').checked = s.autoListen
  $<HTMLTextAreaElement>('sessionContext').value = s.sessionContext
  input('numbersInWords').checked = s.numbersInWords
  input('autoEarly').checked = s.autoEarly
  input('ragEnabled').checked = s.ragEnabled
  $<HTMLTextAreaElement>('ragProfile').value = s.ragProfile
  input('ragTopK').value = String(s.ragTopK)
  input('mixerAutoSonar').checked = s.mixerAutoSonar
  mixerSelected = new Set(s.mixerDevices)
  renderMixerList()
  void loadDevices(s.audioSource)

  input('model').value = s.model
  select('replyLanguage').value = s.replyLanguage
  input('maxTokens').value = String(s.maxTokens)
  $<HTMLTextAreaElement>('systemPrompt').value = s.systemPrompt
  syncPresetLabel()

  select('mode').value = s.mode
  input('bufferMinutes').value = String(s.bufferMinutes)
  input('autoDebounceMs').value = String(s.autoDebounceMs)
  input('autoMinGapMs').value = String(s.autoMinGapMs)
  input('autoOnlyQuestions').checked = s.autoOnlyQuestions

  input('hkToggle').value = s.hotkeys.toggle
  input('hkAsk').value = s.hotkeys.ask
  input('hkClear').value = s.hotkeys.clear

  input('opacity').value = String(s.overlay.opacity)
  input('fontSize').value = String(s.overlay.fontSize)
  input('showTranscript').checked = s.overlay.showTranscript
  input('contentProtection').checked = s.overlay.contentProtection
  input('startHidden').checked = s.startHidden
  input('launchAtStartup').checked = s.launchAtStartup
}

// ---------- Enregistrement ----------

function collect(): SettingsPatch {
  const patch: SettingsPatch = {
    settings: {
      sttLanguage: select('sttLanguage').value as Lang,
      vadSilenceSecs: Number(input('vadSilenceSecs').value),
      silenceGate: input('silenceGate').checked,
      gateThreshold: Number(input('gateThreshold').value),
      audioSource: select('audioSource').value,
      sessionContext: $<HTMLTextAreaElement>('sessionContext').value,
      numbersInWords: input('numbersInWords').checked,
      autoEarly: input('autoEarly').checked,
      ragEnabled: input('ragEnabled').checked,
      ragProfile: $<HTMLTextAreaElement>('ragProfile').value,
      ragTopK: Number(input('ragTopK').value),
      mixerAutoSonar: input('mixerAutoSonar').checked,
      mixerDevices: [...mixerSelected],
      autoListen: input('autoListen').checked,

      model: input('model').value.trim(),
      replyLanguage: select('replyLanguage').value as Lang,
      maxTokens: Number(input('maxTokens').value),
      systemPrompt: $<HTMLTextAreaElement>('systemPrompt').value,

      mode: select('mode').value as Mode,
      bufferMinutes: Number(input('bufferMinutes').value),
      autoDebounceMs: Number(input('autoDebounceMs').value),
      autoMinGapMs: Number(input('autoMinGapMs').value),
      autoOnlyQuestions: input('autoOnlyQuestions').checked,

      hotkeys: {
        toggle: input('hkToggle').value,
        ask: input('hkAsk').value,
        clear: input('hkClear').value
      },
      overlay: {
        opacity: Number(input('opacity').value),
        fontSize: Number(input('fontSize').value),
        showTranscript: input('showTranscript').checked,
        contentProtection: input('contentProtection').checked
      },
      startHidden: input('startHidden').checked,
      launchAtStartup: input('launchAtStartup').checked
    }
  }

  const eleven = input('elevenLabsKey').value.trim()
  const claude = input('anthropicKey').value.trim()
  if (input('clearEleven').checked) patch.elevenLabsKey = ''
  else if (eleven) patch.elevenLabsKey = eleven
  if (input('clearAnthropic').checked) patch.anthropicKey = ''
  else if (claude) patch.anthropicKey = claude
  return patch
}

function say(text: string, kind: '' | 'ok' | 'err' = ''): void {
  result.textContent = text
  result.className = kind
}

$('form').addEventListener('submit', async (e) => {
  e.preventDefault()
  saveBtn.disabled = true
  say('Enregistrement…')
  try {
    const res = await window.api.invoke<SaveResult>('settings:save', collect())
    const problems = [...(res.message ? [res.message] : []), ...res.hotkeyErrors]
    say(problems.length ? problems.join(' · ') : 'Enregistré ✓', problems.length ? 'err' : 'ok')

    input('elevenLabsKey').value = ''
    input('anthropicKey').value = ''
    input('clearEleven').checked = false
    input('clearAnthropic').checked = false
    fill(await window.api.invoke<SettingsView>('settings:get'))
  } catch (err) {
    say(`Échec de l'enregistrement : ${err instanceof Error ? err.message : String(err)}`, 'err')
  } finally {
    saveBtn.disabled = false
  }
})

void window.api.invoke<SettingsView>('settings:get').then(fill)

// ---------- Mémoire personnelle : documents ----------

function renderRag(docs: RagDoc[], errors: string[] = []): void {
  const list = $('ragList')
  list.innerHTML = ''
  for (const d of docs) {
    const row = document.createElement('div')
    row.className = 'ragrow'
    const name = document.createElement('span')
    name.className = 'rname'
    name.textContent = d.name
    name.title = d.name
    const meta = document.createElement('span')
    meta.className = 'rmeta'
    meta.textContent = `${d.chunks} extrait(s) · ${Math.max(1, Math.round(d.chars / 1000))} ko`
    const del = document.createElement('button')
    del.type = 'button'
    del.className = 'secondary'
    del.textContent = 'Retirer'
    del.addEventListener('click', () => {
      void window.api.invoke<RagDoc[]>('rag:remove', d.id).then((next) => renderRag(next))
    })
    row.append(name, meta, del)
    list.appendChild(row)
  }
  const note = $('ragNote')
  note.className = errors.length ? 'warn' : 'note'
  note.textContent = errors.length
    ? errors.join(' · ')
    : docs.length
      ? `${docs.length} document(s) en mémoire. Ajout et retrait sont immédiats (pas besoin d'Enregistrer).`
      : 'Aucun document pour l’instant : seul le profil ci-dessus sera utilisé.'
}

$('ragAdd').addEventListener('click', () => {
  void window.api.invoke<RagChange>('rag:add').then((res) => renderRag(res.docs, res.errors))
})
void window.api.invoke<RagDoc[]>('rag:list').then((docs) => renderRag(docs))

// ---------- Diagnostic en direct ----------

const STATE_LABELS = {
  capture: { off: 'arrêtée', on: 'active', error: 'en erreur' },
  stt: { idle: 'en veille (se connecte au premier son)', connecting: 'connexion…', ready: 'connectée', error: 'en erreur' }
} as const

let listenStartedAt = 0
let lastSoundAt = 0
let lastLevel: LevelMessage | null = null
let curState: AppState | null = null
let meterKeys = ''

function pill(id: string, text: string, kind: '' | 'ok' | 'err' | 'wait'): void {
  const el = $(id)
  el.textContent = text
  el.className = `pill ${kind}`.trim()
}

function renderState(st: AppState): void {
  if (!curState?.listening && st.listening) {
    listenStartedAt = Date.now()
    lastSoundAt = 0
  }
  curState = st
  pill('dgListen', `Écoute : ${st.listening ? 'oui' : 'non'}`, st.listening ? 'ok' : '')
  pill(
    'dgCapture',
    `Capture : ${STATE_LABELS.capture[st.capture]}`,
    st.capture === 'on' ? 'ok' : st.capture === 'error' ? 'err' : ''
  )
  pill(
    'dgStt',
    `Transcription : ${STATE_LABELS.stt[st.stt]}`,
    st.stt === 'ready' ? 'ok' : st.stt === 'error' ? 'err' : st.stt === 'connecting' ? 'wait' : ''
  )
  const msg = $('dgMessage')
  msg.hidden = !st.message
  msg.textContent = st.message ?? ''
  $('dgToggle').textContent = st.listening ? "Arrêter l'écoute" : "Démarrer l'écoute"
  renderCounters()
}

/** Échelle en dB : −70 dB (vide) à 0 dB (plein). */
function dbOf(rms: number): number {
  return rms > 0.000001 ? 20 * Math.log10(rms) : -Infinity
}
const pctOf = (rms: number): number => Math.max(0, Math.min(1, (dbOf(rms) + 70) / 70))

function renderLevels(l: LevelMessage): void {
  lastLevel = l
  const rows: { key: string; label: string; value: number }[] = []
  if (l.source === 'mixer') {
    rows.push({ key: '__mix', label: 'Mix envoyé à la transcription', value: l.rms })
    for (const d of l.devices ?? []) rows.push({ key: d.name, label: d.name, value: d.rms })
  } else {
    rows.push({ key: '__an', label: 'Flux audio capturé', value: l.an })
    rows.push({ key: '__rms', label: 'Après traitement (worklet)', value: l.rms })
  }
  const keys = rows.map((r) => r.key).join('|')
  const holder = $('meters')
  if (keys !== meterKeys) {
    meterKeys = keys
    holder.innerHTML = ''
    for (const r of rows) {
      const row = document.createElement('div')
      row.className = 'meter'
      row.innerHTML = '<span class="name"></span><div class="bar"><i></i></div><span class="db"></span>'
      ;(row.querySelector('.name') as HTMLElement).textContent = r.label
      holder.appendChild(row)
    }
  }
  const els = holder.children
  rows.forEach((r, i) => {
    const row = els[i] as HTMLElement
    ;(row.querySelector('i') as HTMLElement).style.width = `${(pctOf(r.value) * 100).toFixed(0)}%`
    const db = dbOf(r.value)
    ;(row.querySelector('.db') as HTMLElement).textContent = Number.isFinite(db) ? `${db.toFixed(0)} dB` : '−∞ dB'
  })
  if (rows.some((r) => r.value > 0.002)) lastSoundAt = Date.now()
  renderCounters()
}

function renderCounters(): void {
  const parts: string[] = []
  if (lastLevel) {
    parts.push(`Blocs audio transmis : ${lastLevel.received}`)
    if (lastLevel.ctx) parts.push(`contexte audio : ${lastLevel.ctx}`)
    if (lastLevel.track) parts.push(`piste : ${lastLevel.track}`)
  }
  if (curState?.listening) {
    parts.push(
      lastSoundAt
        ? `dernier son il y a ${Math.round((Date.now() - lastSoundAt) / 1000)} s`
        : 'aucun son reçu depuis le démarrage'
    )
  }
  $('dgCounters').textContent = parts.join(' · ')

  const hint = $('dgHint')
  const silentTooLong =
    !!curState?.listening && curState.capture === 'on' && !lastSoundAt && Date.now() - listenStartedAt > 8000
  hint.hidden = !silentTooLong
  if (silentTooLong) {
    hint.textContent =
      "Aucun son reçu : lance de l'audio (vidéo, appel Teams…) et regarde quelle barre monte. " +
      (lastLevel?.source === 'mixer'
        ? 'Si aucune sortie ne monte, essaie de cocher à la main la sortie physique de ton casque dans la liste du mixeur.'
        : 'Ce mode ne voit que la sortie par défaut de Windows : essaie le « Mixeur de sorties Windows ».')
  }
}

const logBox = $('logBox')
function addLog(line: string): void {
  const stick = logBox.scrollTop + logBox.clientHeight >= logBox.scrollHeight - 24
  logBox.appendChild(document.createTextNode(`${line}\n`))
  while (logBox.childNodes.length > 300) logBox.removeChild(logBox.firstChild as ChildNode)
  if (stick) logBox.scrollTop = logBox.scrollHeight
}

window.api.on('state', renderState)
window.api.on('level', renderLevels)
window.api.on('log', addLog)
void window.api.invoke<DiagSnapshot>('diag:get').then((snap) => {
  logBox.textContent = ''
  snap.log.forEach(addLog)
  renderState(snap.state)
})
$('dgToggle').addEventListener('click', () => void window.api.invoke('diag:toggleListening'))
window.setInterval(renderCounters, 1000)
