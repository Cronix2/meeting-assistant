/**
 * Infobulles maison à la place de celles de Windows : on lit l'attribut `title` au survol, on le
 * met de côté (sinon Windows afficherait aussi la sienne) et on affiche une bulle stylée.
 */
export function initTooltips(): void {
  const tip = document.createElement('div')
  tip.className = 'ui-tip'
  tip.setAttribute('role', 'tooltip')
  tip.hidden = true
  document.body.appendChild(tip)

  let target: HTMLElement | null = null
  let timer = 0

  const hide = () => {
    window.clearTimeout(timer)
    tip.hidden = true
    target = null
  }

  const show = (el: HTMLElement) => {
    const text = el.dataset['tip']
    if (!text || !el.isConnected) return
    tip.textContent = text
    tip.hidden = false
    const r = el.getBoundingClientRect()
    const w = tip.offsetWidth
    const h = tip.offsetHeight
    let x = r.left + r.width / 2 - w / 2
    x = Math.max(6, Math.min(x, window.innerWidth - w - 6))
    let y = r.bottom + 6
    if (y + h > window.innerHeight - 4) y = r.top - h - 6
    tip.style.left = `${x}px`
    tip.style.top = `${Math.max(4, y)}px`
  }

  document.addEventListener('mouseover', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[title], [data-tip]')
    if (el === target) return
    hide()
    if (!el) return
    // Le texte peut avoir changé depuis (ex. bouton pause / reprise) : on reprend toujours le `title` à jour.
    const title = el.getAttribute('title')
    if (title) {
      el.dataset['tip'] = title
      el.removeAttribute('title')
      if (!el.getAttribute('aria-label')) el.setAttribute('aria-label', title)
    }
    target = el
    timer = window.setTimeout(() => show(el), 450)
  })
  document.addEventListener('mousedown', hide, true)
  document.addEventListener('keydown', hide, true)
  window.addEventListener('blur', hide)
  document.addEventListener('scroll', hide, true)
}

/**
 * Le code met parfois à jour `el.title` (ex. libellé pause / reprise) : on l'intercepte pour
 * alimenter l'infobulle maison au lieu de recréer l'infobulle Windows.
 */
const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'title')
if (desc?.set && desc.get) {
  Object.defineProperty(HTMLElement.prototype, 'title', {
    configurable: true,
    get(this: HTMLElement) {
      return this.dataset['tip'] ?? desc.get!.call(this)
    },
    set(this: HTMLElement, v: string) {
      if (this.dataset['tip'] !== undefined) this.dataset['tip'] = v
      else desc.set!.call(this, v)
    }
  })
}
