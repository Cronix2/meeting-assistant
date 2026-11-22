import type { AppState, OverlayPrefsMessage } from '../../shared/types'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const api = window.api

const dot = $('dot')
const statusEl = $('status')
const answerEl = $('answer')
const liveEl = $('live')
const modeSeg = $('mode')
const listenBtn = $<HTMLButtonElement>('listen')
const askBtn = $<HTMLButtonElement>('ask')

let hotkeys = { toggle: '', ask: '', clear: '' }
let current = '' // réponse en cours d'affichage
let previous = '' // dernière réponse terminée (restaurée si Claude répond « — »)
let streaming = false

// ---------- Rendu minimal (échappement HTML, **gras**, `code`, puces) ----------

function render(text: string): string {
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const fmt = (t: string) =>
    t.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>').replace(/`([^`\n]+)`/g, '<code>$1</code>')
  const lines = esc.split('\n')
  const first = lines.findIndex((l) => l.trim())
  if (first < 0) return ''
  // 1re ligne = la réponse à retenir (mise en avant) ; ensuite puces, notes et paragraphes.
  const html = [`<div class="lead">${fmt(lines[first].trim())}</div>`]
  for (const raw of lines.slice(first + 1)) {
    const t = raw.trim()
    if (!t) continue
    const bullet = /^[-*•]\s+(.*)$/.exec(t)
    if (bullet && !bullet[1].startsWith('ℹ')) html.push(`<div class="bullet">${fmt(bullet[1])}</div>`)
    else if (bullet) html.push(`<div class="miss">${fmt(bullet[1])}</div>`)
    else if (t.startsWith('ℹ')) html.push(`<div class="miss">${fmt(t)}</div>`)
    else html.push(`<div class="para">${fmt(t)}</div>`)
  }
  return html.join('')
}

function showAnswer(text: string, cls = ''): void {
  answerEl.className = cls
  answerEl.innerHTML = render(text)
  answerEl.scrollTop = answerEl.scrollHeight
}

const kbd = (k: string) =>
  k
    .split('+')
    .map((p) => `<kbd>${p.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</kbd>`)
    .join('+')

function showHint(): void {
  const k = hotkeys
  answerEl.className = 'hint'
  answerEl.innerHTML =
    `<p>J'écoute le son de tes applications et je transcris en continu.</p>` +
    `<p>Pour une réponse : ${k.ask ? kbd(k.ask) : 'le raccourci'} ou le bouton <b>Répondre</b>.</p>` +
    (k.toggle ? `<p>Masquer ou afficher cette fenêtre : ${kbd(k.toggle)}</p>` : '')
}

function setLive(text: string, partial: boolean): void {
  liveEl.className = partial ? 'partial' : ''
  liveEl.innerHTML = ''
  const span = document.createElement('span')
  span.textContent = text
  liveEl.appendChild(span)
}

// ---------- État ----------

function applyState(s: AppState): void {
  modeSeg.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
    const on = b.dataset['mode'] === s.mode
    b.classList.toggle('on', on)
    b.setAttribute('aria-pressed', String(on))
  })
  listenBtn.classList.toggle('paused', !s.listening)
  listenBtn.querySelector('use')?.setAttribute('href', s.listening ? '#i-pause' : '#i-play')
  listenBtn.title = s.listening ? "Mettre l'écoute en pause" : "Reprendre l'écoute"
  listenBtn.setAttribute('aria-label', s.listening ? 'Pause' : 'Reprendre')

  // Libellé court dans la barre, détail au survol ; une erreur s'affiche en entier dans la zone de réponse.
  let cls = ''
  let label = ''
  let detail = ''
  const isErr = s.capture === 'error' || (s.stt === 'error' && !!s.message)
  if (isErr) {
    cls = 'err'
    label = 'Erreur'
    detail = s.message ?? 'Erreur'
  } else if (!s.listening) {
    label = 'En pause'
    detail = "L'écoute est en pause"
  } else if (s.stt === 'connecting') {
    cls = 'warn'
    label = 'Connexion…'
    detail = 'Connexion à la transcription…'
  } else if (s.stt === 'ready') {
    cls = 'ok'
    label = 'En direct'
    detail = 'Transcription en cours'
  } else {
    cls = 'ok'
    label = 'À l’écoute'
    detail = 'En attente de son'
  }
  dot.className = `dot ${cls}`
  statusEl.className = cls === 'err' ? 'err' : ''
  statusEl.textContent = label
  $('state').title = detail
  if (isErr && !current && !streaming) {
    showAnswer(`${detail}\nOuvre les Réglages → Diagnostic pour en savoir plus.`, 'error')
    stateError = true
  } else if (!isErr && stateError) {
    stateError = false
    if (!current && !streaming) showHint()
  }
}
let stateError = false

api.on('state', applyState)

// Diagnostic : niveau audio capté (%) et morceaux reçus côté main.
const meterBars = [...$('meter').querySelectorAll('i')]
const STEPS_DB = [-60, -48, -40, -32, -24]
api.on('level', (l: { rms: number; received: number }) => {
  const db = l.rms > 0 ? 20 * Math.log10(l.rms) : -100
  meterBars.forEach((b, i) => b.classList.toggle('on', db >= STEPS_DB[i]))
  $('meter').title = `Son capté : ${db > -100 ? `${Math.round(db)} dB` : 'silence'} · ${l.received} blocs reçus`
})

const perfEl = $('perf')
api.on('perf', (p: { trigger: 'manual' | 'auto'; ttft: number; sinceSpeech?: number }) => {
  const ms = p.trigger === 'auto' ? (p.sinceSpeech ?? p.ttft) : p.ttft
  perfEl.textContent = `⏱ ${(ms / 1000).toFixed(1)} s`
  perfEl.title = `Premier mot : ${(p.ttft / 1000).toFixed(1)} s après l'envoi à Claude${
    p.sinceSpeech !== undefined ? ` · ${(p.sinceSpeech / 1000).toFixed(1)} s après le dernier mot reconnu` : ''
  }`
})

api.on('prefs', (p: OverlayPrefsMessage) => {
  hotkeys = p.hotkeys
  document.documentElement.style.setProperty('--fs', `${p.fontSize}px`)
  liveEl.classList.toggle('hidden', !p.showTranscript)
  if (!current && !streaming) showHint()
})

api.on('transcript:partial', (t: string) => setLive(t, true))
api.on('transcript:committed', (t: string) => setLive(t, false))

function setBusy(on: boolean): void {
  askBtn.classList.toggle('busy', on)
}

api.on('answer:start', () => {
  setBusy(true)
  streaming = true
  current = ''
  showAnswer('', 'loading')
})
api.on('answer:delta', (d: string) => {
  current += d
  showAnswer(current, 'loading')
})
api.on('answer:done', () => {
  setBusy(false)
  streaming = false
  previous = current
  showAnswer(current)
})
api.on('answer:skip', () => {
  // Claude a jugé qu'il n'y avait rien à dire : on garde l'ancienne réponse.
  setBusy(false)
  streaming = false
  current = previous
  if (previous) showAnswer(previous)
  else showHint()
})
api.on('answer:error', (m: string) => {
  setBusy(false)
  streaming = false
  current = ''
  showAnswer(m, 'error')
})
api.on('answer:clear', () => {
  setBusy(false)
  streaming = false
  current = ''
  previous = ''
  liveEl.innerHTML = ''
  showHint()
})

// ---------- Boutons ----------

$('ask').addEventListener('click', () => api.send('overlay:ask'))
$('listen').addEventListener('click', () => api.send('overlay:toggleListening'))
modeSeg.querySelectorAll<HTMLButtonElement>('button').forEach((b) =>
  b.addEventListener('click', () => {
    if (!b.classList.contains('on')) api.send('overlay:toggleMode')
  })
)
$('clear').addEventListener('click', () => api.send('overlay:clear'))
$('settings').addEventListener('click', () => api.send('overlay:openSettings'))
$('close').addEventListener('click', () => api.send('overlay:hide'))

showHint()
api.send('overlay:ready')
