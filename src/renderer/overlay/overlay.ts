import type { AppState, OverlayPrefsMessage } from '../../shared/types'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const api = window.api

const dot = $('dot')
const statusEl = $('status')
const answerEl = $('answer')
const liveEl = $('live')
const modeBtn = $<HTMLButtonElement>('mode')
const listenBtn = $<HTMLButtonElement>('listen')

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
    if (bullet) html.push(`<div class="bullet">${fmt(bullet[1])}</div>`)
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

function showHint(): void {
  const k = hotkeys
  const keys = k.ask ? `<b>${k.ask}</b>` : 'le raccourci'
  answerEl.className = 'hint'
  answerEl.innerHTML = `Je transcris l'audio de tes applications en continu.<br>Appuie sur ${keys} (ou ⚡) pour obtenir une réponse.`
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
  modeBtn.textContent = s.mode === 'auto' ? 'auto' : 'manuel'
  modeBtn.classList.toggle('auto', s.mode === 'auto')
  listenBtn.textContent = s.listening ? '⏸' : '▶'

  let cls = ''
  let text = ''
  if (s.capture === 'error' || (s.stt === 'error' && s.message)) {
    cls = 'err'
    text = s.message ?? 'Erreur'
  } else if (!s.listening) {
    text = 'En pause'
  } else if (s.stt === 'connecting') {
    cls = 'warn'
    text = 'Connexion à la transcription…'
  } else if (s.stt === 'ready') {
    cls = 'ok'
    text = 'Transcription en cours'
  } else {
    cls = 'ok'
    text = 'À l’écoute'
  }
  dot.className = `dot ${cls}`
  statusEl.className = cls === 'err' ? 'err' : ''
  statusEl.textContent = text
  statusEl.title = text
}

api.on('state', applyState)

// Diagnostic : niveau audio capté (%) et morceaux reçus côté main.
const levelEl = $('level')
api.on('level', (l: { rms: number; an: number; received: number }) => {
  levelEl.textContent = `♪ ${(l.rms * 100).toFixed(1)}% / ${(l.an * 100).toFixed(1)}% · ${l.received}`
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

api.on('answer:start', () => {
  streaming = true
  current = ''
  showAnswer('', 'loading')
})
api.on('answer:delta', (d: string) => {
  current += d
  showAnswer(current, 'loading')
})
api.on('answer:done', () => {
  streaming = false
  previous = current
  showAnswer(current)
})
api.on('answer:skip', () => {
  // Claude a jugé qu'il n'y avait rien à dire : on garde l'ancienne réponse.
  streaming = false
  current = previous
  if (previous) showAnswer(previous)
  else showHint()
})
api.on('answer:error', (m: string) => {
  streaming = false
  current = ''
  showAnswer(m, 'error')
})
api.on('answer:clear', () => {
  streaming = false
  current = ''
  previous = ''
  liveEl.innerHTML = ''
  showHint()
})

// ---------- Boutons ----------

$('ask').addEventListener('click', () => api.send('overlay:ask'))
$('listen').addEventListener('click', () => api.send('overlay:toggleListening'))
$('mode').addEventListener('click', () => api.send('overlay:toggleMode'))
$('settings').addEventListener('click', () => api.send('overlay:openSettings'))
$('close').addEventListener('click', () => api.send('overlay:hide'))

showHint()
api.send('overlay:ready')
