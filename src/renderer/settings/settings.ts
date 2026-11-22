import { PRESETS } from '../../shared/defaults'
import { initHelp, startTour, tourAlreadyDone } from './tour'
import type {
  AppState,
  AudioDevice,
  DiagSnapshot,
  Lang,
  LevelMessage,
  KbBriefEstimate,
  KbDocInfo,
  KbImportResult,
  KbInfo,
  KbProgress,
  KbSummaryEstimate,
  KbSummaryResult,
  DataExportResult,
  DataImportInfo,
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

// ---------- Navigation entre les pages ----------

const PAGES = ['accueil', 'cles', 'ecoute', 'reponses', 'moi', 'pro', 'fenetre', 'transfert', 'diag']

function showPage(name: string): void {
  if (!PAGES.includes(name)) name = 'accueil'
  document.querySelectorAll<HTMLElement>('.page').forEach((p) => (p.hidden = p.dataset['page'] !== name))
  document.querySelectorAll<HTMLAnchorElement>('[data-nav]').forEach((a) => {
    const on = a.dataset['nav'] === name
    a.classList.toggle('active', on)
    if (on) a.setAttribute('aria-current', 'page')
    else a.removeAttribute('aria-current')
  })
  $('pages').scrollTop = 0
  if (location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`)
}

// Tous les liens internes (#page) passent par showPage.
document.addEventListener('click', (e) => {
  const a = (e.target as HTMLElement).closest<HTMLAnchorElement>('a[href^="#"]')
  if (!a) return
  e.preventDefault()
  showPage(a.getAttribute('href')!.slice(1))
})
showPage(location.hash.slice(1) || 'accueil')
initHelp(showPage)
$('tourStart').addEventListener('click', startTour)
$('tourStart2').addEventListener('click', startTour)

/** Sélecteur à choix fixes : ajoute une option si la valeur enregistrée n'en fait pas partie. */
function setSelect(id: string, value: string, customLabel: (v: string) => string): void {
  const sel = select(id)
  if (![...sel.options].some((o) => o.value === value)) {
    const o = document.createElement('option')
    o.value = value
    o.textContent = customLabel(value)
    sel.appendChild(o)
  }
  sel.value = value
}

/** Curseurs : affiche la valeur à côté du titre. */
const RANGE_OUT: [string, string, (v: number) => string][] = [
  ['vadSilenceSecs', 'vadOut', (v) => `${v.toFixed(1).replace('.', ',')} s de silence`],
  ['gateThreshold', 'gateOut', (v) => (v <= 0.002 ? 'élevée' : v <= 0.01 ? 'moyenne' : 'faible')],
  ['opacity', 'opacityOut', (v) => `${Math.round(v * 100)} %`],
  ['fontSize', 'fontOut', (v) => `${v} px`]
]
function syncRanges(): void {
  for (const [inp, out, fmt] of RANGE_OUT) $(out).textContent = fmt(Number(input(inp).value))
}
for (const [inp] of RANGE_OUT) input(inp).addEventListener('input', syncRanges)

// ---------- Modifications non enregistrées ----------

let dirty = false
function setDirty(on: boolean): void {
  dirty = on
  $('dirty').hidden = !on
  $('savebar').classList.toggle('pending', on)
  if (on) say('')
}
// Champs qui ne passent pas par « Enregistrer » (actions immédiates) : exclus.
const IMMEDIATE = new Set(['kbSelect', 'kbName', 'kbAbout', 'kbBrief', 'kbActive', 'exportPassword', 'exportPassword2', 'exportKeys', 'importPassword'])
$('form').addEventListener('input', (e) => {
  const id = (e.target as HTMLElement).id
  if (!IMMEDIATE.has(id)) setDirty(true)
})
$('form').addEventListener('change', (e) => {
  const id = (e.target as HTMLElement).id
  if (!IMMEDIATE.has(id) && (e.target as HTMLElement).closest('.page')) setDirty(true)
})
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault()
    $<HTMLFormElement>('form').requestSubmit()
  }
})
window.addEventListener('beforeunload', (e) => {
  if (dirty) e.preventDefault()
})

// ---------- Accueil : étapes de démarrage ----------

const setup = { keys: false, audio: false, context: false }
function renderSetup(): void {
  $('stepKeys').classList.toggle('done', setup.keys)
  $('stepAudio').classList.toggle('done', setup.audio)
  $('stepContext').classList.toggle('done', setup.context)
  $('navKeys').classList.toggle('on', !setup.keys)
}

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
  add('loopback', 'Sortie par défaut de Windows')
  add('mixer', 'Toutes les sorties (mixeur) — recommandé avec SteelSeries Sonar')
  for (const d of devices) add(d.id, `Périphérique d'entrée : ${d.label}`)
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
    : 'Colle ta clé ElevenLabs (sk_…)'
  input('anthropicKey').placeholder = s.hasAnthropicKey
    ? defined(s.anthropicKeyHint)
    : 'Colle ta clé Claude (sk-ant-…)'
  const status = (id: string, ok: boolean) => {
    const el = $(id)
    el.textContent = ok ? 'enregistrée' : 'manquante'
    el.className = `status ${ok ? 'ok' : 'missing'}`
  }
  status('elevenStatus', s.hasElevenLabsKey)
  status('claudeStatus', s.hasAnthropicKey)
  setup.keys = s.hasElevenLabsKey && s.hasAnthropicKey
  setup.context = !!(s.sessionContext.trim() || s.ragProfile.trim())
  renderSetup()
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
  input('kbEnabled').checked = s.kbEnabled
  input('kbAutoSummary').checked = s.kbAutoSummary
  input('kbTopK').value = String(s.kbTopK)
  input('kbBudgetChars').value = String(s.kbBudgetChars)
  input('mixerAutoSonar').checked = s.mixerAutoSonar
  mixerSelected = new Set(s.mixerDevices)
  renderMixerList()
  void loadDevices(s.audioSource)

  setSelect('model', s.model, (v) => `${v} (personnalisé)`)
  select('replyLanguage').value = s.replyLanguage
  setSelect('maxTokens', String(s.maxTokens), (v) => `${v} tokens (personnalisé)`)
  $<HTMLTextAreaElement>('systemPrompt').value = s.systemPrompt
  syncPresetLabel()

  document.querySelectorAll<HTMLInputElement>('input[name="modeR"]').forEach((r) => (r.checked = r.value === s.mode))
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
  $('cheatToggle').textContent = s.hotkeys.toggle
  $('cheatAsk').textContent = s.hotkeys.ask
  $('cheatClear').textContent = s.hotkeys.clear
  syncRanges()
  setDirty(false)
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
      kbEnabled: input('kbEnabled').checked,
      kbAutoSummary: input('kbAutoSummary').checked,
      kbTopK: Number(input('kbTopK').value),
      kbBudgetChars: Number(input('kbBudgetChars').value),
      mixerAutoSonar: input('mixerAutoSonar').checked,
      mixerDevices: [...mixerSelected],
      autoListen: input('autoListen').checked,

      model: input('model').value.trim(),
      replyLanguage: select('replyLanguage').value as Lang,
      maxTokens: Number(input('maxTokens').value),
      systemPrompt: $<HTMLTextAreaElement>('systemPrompt').value,

      mode: (document.querySelector<HTMLInputElement>('input[name="modeR"]:checked')?.value ?? 'manual') as Mode,
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
    say(problems.length ? problems.join(' · ') : 'Enregistré', problems.length ? 'err' : 'ok')

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

void window.api.invoke<SettingsView>('settings:get').then((s) => {
  fill(s)
  // Première ouverture : proposer la visite si les clés ne sont pas encore là.
  if (!tourAlreadyDone() && !(s.hasElevenLabsKey && s.hasAnthropicKey)) window.setTimeout(startTour, 400)
})

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
  note.className = errors.length ? 'hint warn' : 'hint'
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

// ---------- Mémoire professionnelle : bases de connaissances ----------

let kbList: KbInfo[] = []
let kbCurrent = ''
let kbBusy = false

const kbMsg = (text: string, warn = false): void => {
  const el = $('kbMsg')
  el.className = warn ? 'hint warn' : 'hint'
  el.textContent = text
}

const fmtSize = (chars: number): string =>
  chars >= 1_000_000 ? `${(chars / 1_000_000).toFixed(1)} M caractères` : `${Math.max(1, Math.round(chars / 1000))} k caractères`

function kbSetBusy(busy: boolean): void {
  kbBusy = busy
  for (const id of ['kbAddFiles', 'kbAddFolder', 'kbGen', 'kbSum', 'kbSumAll', 'kbSaveText', 'kbNew', 'kbRename', 'kbDelete']) {
    $<HTMLButtonElement>(id).disabled = busy
  }
  $('kbStop').hidden = !busy
}

function kbCurrentInfo(): KbInfo | undefined {
  return kbList.find((b) => b.id === kbCurrent)
}

function renderKb(): void {
  const sel = select('kbSelect')
  sel.innerHTML = ''
  for (const b of kbList) {
    const o = document.createElement('option')
    o.value = b.id
    o.textContent = `${b.name}${b.enabled ? '' : ' (désactivée)'}`
    sel.appendChild(o)
  }
  if (!kbList.some((b) => b.id === kbCurrent)) kbCurrent = kbList[0]?.id ?? ''
  sel.value = kbCurrent
  const cur = kbCurrentInfo()
  $('kbBody').hidden = !cur
  $('kbStep3').hidden = !cur
  $<HTMLButtonElement>('kbRename').disabled = !cur
  $<HTMLButtonElement>('kbDelete').disabled = !cur
  if (!cur) {
    kbMsg('Aucune base pour l’instant : « Nouvelle base… » pour commencer.')
    return
  }
  input('kbActive').checked = cur.enabled
  const about = $<HTMLTextAreaElement>('kbAbout')
  if (document.activeElement !== about) about.value = cur.about
  const brief = $<HTMLTextAreaElement>('kbBrief')
  if (document.activeElement !== brief) brief.value = cur.brief
  $('kbStats').textContent =
    `${cur.docs} fichier(s), dont ${cur.summarized} avec une note · ${fmtSize(cur.chars)}` +
    (cur.indexing ? ' · indexation en cours…' : '') +
    (cur.brief ? '' : ' · pas encore de fiche de synthèse')
  $('kbGenNote').textContent = cur.briefAt ? `Fiche du ${new Date(cur.briefAt).toLocaleString('fr-FR')}` : ''
  void renderKbDocs()
}

async function renderKbDocs(): Promise<void> {
  const box = $('kbDocs')
  const id = kbCurrent
  if (!id) return
  const docs = await window.api.invoke<KbDocInfo[]>('kb:docs', id)
  if (id !== kbCurrent) return
  box.innerHTML = ''
  for (const d of docs.slice(0, 300)) {
    const row = document.createElement('div')
    row.className = 'ragrow'
    const name = document.createElement('span')
    name.className = 'rname'
    name.textContent = d.label
    name.title = 'Lire la note de ce fichier'
    name.addEventListener('click', () => {
      void window.api.invoke<string>('kb:note', { id, docId: d.id }).then((t) => {
        const pre = $('kbNote')
        pre.hidden = false
        pre.textContent = `${d.label}\n\n${t || '(pas encore de note pour ce fichier)'}`
      })
    })
    const meta = document.createElement('span')
    meta.className = 'rmeta'
    meta.textContent = `${d.chunks} extr. · ${Math.max(1, Math.round(d.chars / 1000))} k`
    const del = document.createElement('button')
    del.type = 'button'
    del.className = 'secondary'
    del.textContent = 'Retirer'
    del.addEventListener('click', () => {
      void window.api.invoke<KbInfo[]>('kb:removeDoc', { id, docId: d.id }).then((l) => {
        kbList = l
        renderKb()
      })
    })
    row.append(name, meta, del)
    box.appendChild(row)
  }
  if (docs.length > 300) {
    const more = document.createElement('p')
    more.className = 'note'
    more.textContent = `… et ${docs.length - 300} autres fichiers (non listés).`
    box.appendChild(more)
  }
}

async function refreshKb(): Promise<void> {
  kbList = await window.api.invoke<KbInfo[]>('kb:list')
  renderKb()
}

select('kbSelect').addEventListener('change', () => {
  kbCurrent = select('kbSelect').value
  renderKb()
})

$('kbNew').addEventListener('click', () => {
  const name = input('kbName').value.trim()
  if (!name) {
    kbMsg('Écris d’abord le nom de la base dans le champ ci-dessus.', true)
    input('kbName').focus()
    return
  }
  void window.api.invoke<KbInfo>('kb:create', name).then(async (b) => {
    kbCurrent = b.id
    input('kbName').value = ''
    await refreshKb()
    kbMsg(`Base « ${b.name} » créée : ajoute-y des fichiers ou un dossier.`)
  })
})

$('kbRename').addEventListener('click', () => {
  const cur = kbCurrentInfo()
  const name = input('kbName').value.trim()
  if (!cur) return
  if (!name) {
    kbMsg('Écris le nouveau nom dans le champ ci-dessus.', true)
    input('kbName').focus()
    return
  }
  input('kbName').value = ''
  void window.api.invoke('kb:update', { id: cur.id, patch: { name } }).then(refreshKb)
})

$('kbDelete').addEventListener('click', () => {
  const cur = kbCurrentInfo()
  if (!cur) return
  if (!window.confirm(`Supprimer la base « ${cur.name} » et tous ses fichiers indexés ? (tes fichiers d'origine ne sont pas touchés)`)) return
  void window.api.invoke<KbInfo[]>('kb:delete', cur.id).then((l) => {
    kbList = l
    renderKb()
  })
})

input('kbActive').addEventListener('change', () => {
  const cur = kbCurrentInfo()
  if (!cur) return
  void window.api.invoke('kb:update', { id: cur.id, patch: { enabled: input('kbActive').checked } }).then(refreshKb)
})

$('kbSaveText').addEventListener('click', () => {
  const cur = kbCurrentInfo()
  if (!cur) return
  void window.api
    .invoke('kb:update', {
      id: cur.id,
      patch: { about: $<HTMLTextAreaElement>('kbAbout').value, brief: $<HTMLTextAreaElement>('kbBrief').value }
    })
    .then(async () => {
      await refreshKb()
      kbMsg('Présentation et fiche enregistrées.')
    })
})

const AUTO_SUMMARY_MAX_TOKENS = 150_000

/** Lance les notes par fichier ; demande confirmation si c'est demandé ou si le volume est important. */
async function kbSummarize(id: string, name: string, ask: boolean): Promise<void> {
  if (kbBusy) return
  const est = await window.api.invoke<KbSummaryEstimate>('kb:sumEstimate', id)
  if (!est.files) {
    kbMsg('Tous les fichiers ont déjà une note.')
    return
  }
  if (ask || est.approxTokens > AUTO_SUMMARY_MAX_TOKENS) {
    const k = Math.round(est.approxTokens / 1000)
    const ok = window.confirm(
      `Claude va résumer ${est.files} fichier(s) de « ${name} » : environ ${k} 000 tokens envoyés en ${est.calls} appel(s) (modèle des Réglages). ` +
        'Cela consomme des crédits de ta clé Claude. Continuer ?'
    )
    if (!ok) return
  }
  kbSetBusy(true)
  try {
    const res = await window.api.invoke<KbSummaryResult>('kb:summarize', id)
    await refreshKb()
    kbMsg(res.message ?? (res.ok ? 'Notes créées.' : 'Échec.'), !res.ok)
  } finally {
    kbSetBusy(false)
  }
}

async function kbImport(mode: 'files' | 'folder'): Promise<void> {
  const cur = kbCurrentInfo()
  if (!cur || kbBusy) return
  kbSetBusy(true)
  kbMsg('')
  let added = 0
  try {
    const res = await window.api.invoke<KbImportResult | null>('kb:import', { id: cur.id, mode })
    await refreshKb()
    if (!res) return
    added = res.added
    const parts = [`${res.added} ajouté(s)`]
    if (res.unchanged) parts.push(`${res.unchanged} déjà à jour`)
    if (res.skipped) parts.push(`${res.skipped} ignoré(s) (binaires, doublons, vides)`)
    if (res.truncated) parts.push('dossier très volumineux : arrêt à 25 000 fichiers')
    kbMsg(`${parts.join(' · ')}${res.errors.length ? ` — ${res.errors.length} erreur(s) : ${res.errors.slice(0, 3).join(' | ')}` : ''}`, res.errors.length > 0)
  } catch (e) {
    kbMsg(e instanceof Error ? e.message : String(e), true)
  } finally {
    kbSetBusy(false)
  }
  // Notes par fichier juste après l'import (si l'option est cochée).
  if (added > 0 && input('kbAutoSummary').checked) await kbSummarize(cur.id, cur.name, false)
}
$('kbAddFiles').addEventListener('click', () => void kbImport('files'))
$('kbAddFolder').addEventListener('click', () => void kbImport('folder'))
$('kbStop').addEventListener('click', () => {
  if (kbCurrent) void window.api.invoke('kb:cancel', kbCurrent)
})

$('kbSum').addEventListener('click', () => {
  const cur = kbCurrentInfo()
  if (cur) void kbSummarize(cur.id, cur.name, true)
})
$('kbSumAll').addEventListener('click', () => {
  const cur = kbCurrentInfo()
  if (!cur || kbBusy) return
  if (!window.confirm('Effacer toutes les notes de cette base puis les refaire avec Claude ?')) return
  void window.api.invoke<KbInfo[]>('kb:clearNotes', cur.id).then(async (l) => {
    kbList = l
    renderKb()
    await kbSummarize(cur.id, cur.name, true)
  })
})

$('kbGen').addEventListener('click', () => {
  const cur = kbCurrentInfo()
  if (!cur || kbBusy) return
  void (async () => {
    if (cur.indexing || cur.docs === 0) {
      kbMsg(cur.docs === 0 ? 'Ajoute d’abord des fichiers à la base.' : 'L’indexation est encore en cours, réessaie dans un instant.', true)
      return
    }
    const est = await window.api.invoke<KbBriefEstimate>('kb:estimate', cur.id)
    const k = Math.round(est.approxTokens / 1000)
    const ok = window.confirm(
      `Claude va lire ${est.sampled ? 'un échantillon représentatif de ' : ''}la base « ${cur.name} » : environ ${k} 000 tokens envoyés en ${est.calls} appel(s) (modèle des Réglages). ` +
        `Cela consomme des crédits de ta clé Claude. Continuer ?${cur.brief.trim() ? '\n\nLa fiche actuelle sera remplacée.' : ''}`
    )
    if (!ok) return
    kbSetBusy(true)
    kbMsg('')
    try {
      const res = await window.api.invoke<{ ok: boolean; message?: string }>('kb:brief', cur.id)
      await refreshKb()
      kbMsg(res.ok ? 'Fiche de compréhension générée : relis-la et corrige-la si besoin, elle est transmise à chaque demande.' : (res.message ?? 'Échec.'), !res.ok)
    } finally {
      kbSetBusy(false)
    }
  })()
})

window.api.on('kb:progress', (p: KbProgress) => {
  const el = $('kbProgress')
  if (p.kbId !== kbCurrent) return
  const box = $('kbProgressBox')
  if (p.finished) {
    el.textContent = p.message ?? ''
    box.hidden = true
    void refreshKb()
    return
  }
  const what = p.task === 'import' ? 'Import' : p.task === 'index' ? 'Indexation' : p.task === 'summary' ? 'Notes par fichier' : 'Synthèse'
  box.hidden = !p.total
  $('kbBar').style.width = `${p.total ? Math.round((100 * p.done) / p.total) : 0}%`
  el.textContent = `${what} : ${p.done} sur ${p.total}${p.label ? ` — ${p.label}` : ''}`
})

void refreshKb()

// ---------- Sauvegarde et transfert ----------

const fmtBytes = (n: number): string => (n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} Mo` : `${Math.max(1, Math.round(n / 1024))} Ko`)
function setMsg(id: string, text: string, kind: '' | 'ok' | 'err' = ''): void {
  const el = $(id)
  el.textContent = text
  el.className = `hint ${kind === 'err' ? 'warn' : kind === 'ok' ? 'okmsg' : ''}`
}

$('exportBtn').addEventListener('click', () => {
  const pw = input('exportPassword').value
  const pw2 = input('exportPassword2').value
  const includeKeys = input('exportKeys').checked
  if (pw !== pw2) return setMsg('exportMsg', 'Les deux mots de passe sont différents.', 'err')
  if (pw && pw.length < 8) return setMsg('exportMsg', 'Mot de passe trop court : 8 caractères minimum.', 'err')
  if (includeKeys && !pw) return setMsg('exportMsg', 'Pour inclure les clés API, choisis un mot de passe.', 'err')
  if (dirty) setMsg('exportMsg', 'Attention : tes dernières modifications ne sont pas enregistrées, elles ne seront pas dans le fichier.', 'err')
  const btn = $<HTMLButtonElement>('exportBtn')
  btn.disabled = true
  void window.api
    .invoke<DataExportResult>('data:export', { password: pw || undefined, includeKeys })
    .then((r) => {
      if (r.canceled) return
      if (!r.ok) return setMsg('exportMsg', r.message ?? 'Export impossible.', 'err')
      input('exportPassword').value = ''
      input('exportPassword2').value = ''
      setMsg(
        'exportMsg',
        `Fichier exporté (${fmtBytes(r.bytes ?? 0)}) : ${r.path}. ${pw ? 'Il est chiffré' : "Il n'est pas chiffré : garde-le pour toi"}${r.keys ? ', clés API incluses' : ''}.`,
        'ok'
      )
    })
    .finally(() => (btn.disabled = false))
})

let importFile = ''
$('importPick').addEventListener('click', () => {
  void window.api.invoke<DataImportInfo | null>('data:pickImport').then((info) => {
    if (!info) return
    if (!info.ok) {
      $('importCard').hidden = true
      return setMsg('importMsg', `${info.name} : ${info.message ?? 'fichier illisible'}.`, 'err')
    }
    importFile = info.file
    setMsg('importMsg', '')
    const date = info.created ? new Date(info.created).toLocaleString('fr-FR') : '?'
    const s = info.summary
    const content = s
      ? ` Contenu : réglages, ${s.profileDocs} document(s) perso, ${s.bases} base(s) de documents de travail (${s.baseFiles} fichier(s)).`
      : ' Fichier chiffré : entre son mot de passe ci-dessous.'
    $('importInfo').textContent = `${info.name}, exporté le ${date} (version ${info.appVersion ?? '?'}).${content}`
    $('importPwBox').hidden = !info.encrypted
    input('importPassword').value = ''
    $('importCard').hidden = false
    if (info.encrypted) input('importPassword').focus()
  })
})
$('importCancel').addEventListener('click', () => {
  importFile = ''
  $('importCard').hidden = true
})
$('importGo').addEventListener('click', () => {
  if (!importFile) return
  if (!window.confirm('Remplacer toutes les données de ce PC par celles du fichier ? Une copie de sécurité est faite avant, puis l’appli redémarre.')) return
  const btn = $<HTMLButtonElement>('importGo')
  btn.disabled = true
  void window.api
    .invoke<DataExportResult>('data:import', { file: importFile, password: input('importPassword').value || undefined })
    .then((r) => {
      if (!r.ok) {
        btn.disabled = false
        return setMsg('importMsg', r.message ?? 'Import impossible.', 'err')
      }
      setDirty(false)
      $('importCard').hidden = true
      setMsg('importMsg', `Import réussi${r.keys ? ', clés API comprises' : ' (pense à recoller tes clés API)'}. Redémarrage…`, 'ok')
    })
})

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
  $('navDiag').classList.toggle('on', st.capture === 'error' || st.stt === 'error')
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
  if (rows.some((r) => r.value > 0.002)) {
    lastSoundAt = Date.now()
    if (!setup.audio) {
      setup.audio = true
      renderSetup()
    }
  }
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
