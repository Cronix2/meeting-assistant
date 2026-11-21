import { HELP, TOUR, type HelpEntry, type TourStep } from './help'

/**
 * Visite guidée + aide contextuelle. Une seule carte sert aux deux :
 * - visite : enchaîne les étapes de TOUR, change de page, met le champ en lumière ;
 * - aide : le bouton « ? » d'un champ ouvre la même carte pour ce seul champ.
 */

const TOUR_DONE_KEY = 'da.tourDone.v1'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

let goToPage: (page: string) => void = () => {}
let steps: TourStep[] = []
let index = 0
let single = false
let currentTarget: HTMLElement | null = null
let lastFocus: HTMLElement | null = null

const root = $('tour')
const hole = $('tourHole')
const card = $('tourCard')

function fieldFor(key: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-help="${key}"]`)
}

/** Champ texte « principal » d'un bloc d'aide (pour « Utiliser cet exemple »). */
function textInputIn(el: HTMLElement | null): HTMLTextAreaElement | HTMLInputElement | null {
  if (!el) return null
  return el.querySelector<HTMLTextAreaElement>('textarea') ?? el.querySelector<HTMLInputElement>('input[type="text"]')
}

function isVisible(el: HTMLElement | null): el is HTMLElement {
  return !!el && el.getClientRects().length > 0
}

function place(): void {
  const t = currentTarget
  const pad = 8
  if (!isVisible(t)) {
    hole.hidden = true
    card.style.left = `${Math.max(16, (window.innerWidth - card.offsetWidth) / 2)}px`
    card.style.top = `${Math.max(16, (window.innerHeight - card.offsetHeight) / 2)}px`
    root.classList.add('dim')
    return
  }
  root.classList.remove('dim')
  hole.hidden = false
  const r = t.getBoundingClientRect()
  const top = Math.max(4, r.top - pad)
  const left = Math.max(4, r.left - pad)
  const width = Math.min(window.innerWidth - left - 4, r.width + pad * 2)
  const height = Math.min(window.innerHeight - top - 4, r.height + pad * 2)
  Object.assign(hole.style, { top: `${top}px`, left: `${left}px`, width: `${width}px`, height: `${height}px` })

  const cw = card.offsetWidth
  const ch = card.offsetHeight
  const gap = 14
  let y: number
  if (top + height + gap + ch <= window.innerHeight - 8) y = top + height + gap
  else if (top - gap - ch >= 8) y = top - gap - ch
  else y = Math.max(8, window.innerHeight - ch - 8)
  // Cible très large (ex. barre latérale) : on place la carte à côté.
  let x = Math.min(Math.max(8, left), window.innerWidth - cw - 8)
  if (r.height > window.innerHeight * 0.6 && r.right + gap + cw < window.innerWidth) {
    x = r.right + gap
    y = Math.max(8, Math.min(r.top, window.innerHeight - ch - 8))
  }
  card.style.left = `${x}px`
  card.style.top = `${y}px`
}

function render(): void {
  const step = steps[index]
  const entry: HelpEntry | undefined = step.help ? HELP[step.help] : undefined
  if (!single) goToPage(step.page)

  currentTarget = step.target ? document.querySelector<HTMLElement>(step.target) : step.help ? fieldFor(step.help) : null
  // Champ rangé dans « Réglages avancés » : on déplie.
  const details = currentTarget?.closest('details')
  if (details && !details.open) details.open = true

  $('tourCount').textContent = single ? 'Aide' : `Étape ${index + 1} sur ${steps.length}`
  $('tourTitle').textContent = step.title ?? entry?.title ?? ''
  const body = $('tourBody')
  body.innerHTML = ''
  const addPara = (text: string | undefined, cls = '') => {
    if (!text) return
    const p = document.createElement('p')
    if (cls) p.className = cls
    p.textContent = text
    body.appendChild(p)
  }
  addPara(step.body ?? entry?.what)
  if (entry?.fill) {
    const p = document.createElement('p')
    p.className = 'fill'
    const b = document.createElement('b')
    b.textContent = 'Quoi mettre : '
    p.append(b, document.createTextNode(entry.fill))
    body.appendChild(p)
  }
  if (!isVisible(currentTarget) && step.help && (step.help.startsWith('kb') && step.help !== 'kbName')) {
    addPara("Ce réglage apparaît dès qu'une base est créée.", 'muted')
  }

  const exBox = $('tourExample')
  const useBtn = $<HTMLButtonElement>('tourUseExample')
  exBox.hidden = !entry?.example
  if (entry?.example) {
    $('tourExampleText').textContent = entry.example
    const field = textInputIn(currentTarget)
    const canApply = !!entry.apply && !!field && isVisible(field)
    useBtn.hidden = !canApply
    useBtn.textContent = field && field.value.trim() ? 'Remplacer par cet exemple' : 'Utiliser cet exemple'
  }

  $<HTMLButtonElement>('tourPrev').hidden = single || index === 0
  $('tourNext').textContent = single ? 'Compris' : index === steps.length - 1 ? 'Terminer' : 'Suivant'
  $('tourQuit').hidden = single

  currentTarget?.scrollIntoView({ block: 'center', behavior: 'auto' })
  requestAnimationFrame(place)
  $('tourNext').focus()
}

function open(list: TourStep[], start = 0, isSingle = false): void {
  steps = list
  index = start
  single = isSingle
  lastFocus = document.activeElement as HTMLElement | null
  root.hidden = false
  root.classList.toggle('single', isSingle)
  render()
}

function close(finished: boolean): void {
  root.hidden = true
  if (!single && finished) {
    try {
      localStorage.setItem(TOUR_DONE_KEY, '1')
    } catch {
      /* stockage indisponible : pas grave */
    }
  }
  if (single) lastFocus?.focus()
}

export function startTour(): void {
  open(TOUR, 0, false)
}

export function showHelp(key: string): void {
  const page = fieldFor(key)?.closest<HTMLElement>('[data-page]')?.dataset['page'] ?? ''
  open([{ page, help: key }], 0, true)
}

export function initHelp(goTo: (page: string) => void): void {
  goToPage = goTo

  // Bouton « ? » à côté du titre de chaque réglage qui a une aide.
  document.querySelectorAll<HTMLElement>('[data-help]').forEach((el) => {
    const key = el.dataset['help'] ?? ''
    if (!HELP[key]) return
    const host =
      el.querySelector<HTMLElement>(':scope > label:not(.mini)') ??
      el.querySelector<HTMLElement>(':scope > .kbbar') ??
      el.querySelector<HTMLElement>(':scope > p.hint') ??
      el
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'help'
    btn.textContent = '?'
    btn.title = `À quoi sert « ${HELP[key].title} » ?`
    btn.setAttribute('aria-label', btn.title)
    btn.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      showHelp(key)
    })
    host.appendChild(btn)
  })

  $('tourNext').addEventListener('click', () => {
    if (single || index >= steps.length - 1) close(true)
    else {
      index++
      render()
    }
  })
  $('tourPrev').addEventListener('click', () => {
    if (index > 0) {
      index--
      render()
    }
  })
  $('tourQuit').addEventListener('click', () => close(false))
  $('tourUseExample').addEventListener('click', () => {
    const entry = steps[index].help ? HELP[steps[index].help as string] : undefined
    const field = textInputIn(currentTarget)
    if (!entry?.example || !field) return
    field.value = entry.example
    field.dispatchEvent(new Event('input', { bubbles: true }))
    $('tourUseExample').textContent = 'Exemple ajouté — adapte-le à ta situation'
  })
  // Clic sur le fond : ferme l'aide simple (la visite, elle, ne se ferme que par ses boutons ou Échap).
  root.addEventListener('click', (e) => {
    if (single && e.target === root) close(false)
  })
  document.addEventListener('keydown', (e) => {
    if (root.hidden) return
    if (e.key === 'Escape') close(false)
    else if (!single && e.key === 'ArrowRight') $('tourNext').click()
    else if (!single && e.key === 'ArrowLeft') $('tourPrev').click()
  })
  window.addEventListener('resize', () => {
    if (!root.hidden) place()
  })
  document.getElementById('pages')?.addEventListener('scroll', () => {
    if (!root.hidden) place()
  })
}

export function tourAlreadyDone(): boolean {
  try {
    return localStorage.getItem(TOUR_DONE_KEY) === '1'
  } catch {
    return true
  }
}
