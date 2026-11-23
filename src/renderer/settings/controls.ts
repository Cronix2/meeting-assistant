/**
 * Contrôles maison qui remplacent ceux de Windows tout en gardant les éléments d'origine
 * (le reste du code continue de lire / écrire `select.value`, `input.value`…) :
 * - listes déroulantes (`<select>`) ;
 * - champs numériques avec boutons − / + ;
 * - boîte de confirmation (à la place de `window.confirm`).
 */

// ---------- Listes déroulantes ----------

const selectValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!
const selectIndex = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex')!

let openList: { close: () => void } | null = null

function enhanceSelect(sel: HTMLSelectElement): void {
  if (sel.dataset['enhanced']) return
  sel.dataset['enhanced'] = '1'

  const wrap = document.createElement('div')
  wrap.className = 'dd'
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'dd-btn'
  btn.setAttribute('aria-haspopup', 'listbox')
  btn.setAttribute('aria-expanded', 'false')
  const label = document.createElement('span')
  label.className = 'dd-label'
  const chev = document.createElement('span')
  chev.className = 'dd-chev'
  chev.setAttribute('aria-hidden', 'true')
  btn.append(label, chev)
  const aria = sel.getAttribute('aria-label') ?? document.querySelector(`label[for="${sel.id}"]`)?.textContent?.trim()
  if (aria) btn.setAttribute('aria-label', aria)

  sel.parentNode!.insertBefore(wrap, sel)
  wrap.append(sel, btn)
  sel.classList.add('dd-native')
  sel.tabIndex = -1
  sel.setAttribute('aria-hidden', 'true')
  // Un <label for="…"> cliqué donne le focus au <select> caché : on le renvoie vers le bouton.
  sel.addEventListener('focus', () => btn.focus())

  const sync = () => {
    const o = sel.selectedOptions[0]
    label.textContent = o?.textContent ?? ''
    btn.disabled = sel.disabled
  }
  // Changements faits par le code (sel.value = …) : on met l'affichage à jour.
  Object.defineProperty(sel, 'value', {
    configurable: true,
    get: () => selectValue.get!.call(sel),
    set: (v: string) => {
      selectValue.set!.call(sel, v)
      sync()
    }
  })
  Object.defineProperty(sel, 'selectedIndex', {
    configurable: true,
    get: () => selectIndex.get!.call(sel),
    set: (v: number) => {
      selectIndex.set!.call(sel, v)
      sync()
    }
  })
  new MutationObserver(sync).observe(sel, { childList: true, subtree: true, attributes: true, characterData: true })
  sel.addEventListener('change', sync)
  sync()

  const list = document.createElement('div')
  list.className = 'dd-list'
  list.setAttribute('role', 'listbox')
  list.hidden = true
  document.body.appendChild(list)
  let active = -1

  const items = () => [...list.querySelectorAll<HTMLElement>('.dd-opt')]
  const setActive = (i: number) => {
    const all = items()
    if (!all.length) return
    active = Math.max(0, Math.min(all.length - 1, i))
    all.forEach((el, k) => el.classList.toggle('active', k === active))
    all[active].scrollIntoView({ block: 'nearest' })
  }
  const choose = (i: number) => {
    const opt = sel.options[i]
    if (!opt || opt.disabled) return
    if (sel.selectedIndex !== i) {
      selectIndex.set!.call(sel, i)
      sel.dispatchEvent(new Event('input', { bubbles: true }))
      sel.dispatchEvent(new Event('change', { bubbles: true }))
    }
    sync()
    close()
    btn.focus()
  }
  const place = () => {
    const r = btn.getBoundingClientRect()
    list.style.minWidth = `${r.width}px`
    list.style.left = `${r.left}px`
    const below = window.innerHeight - r.bottom - 8
    const h = Math.min(list.scrollHeight, 280)
    if (below >= Math.min(h, 160) || below >= r.top) {
      list.style.top = `${r.bottom + 4}px`
      list.style.maxHeight = `${Math.max(120, below)}px`
    } else {
      list.style.top = `${Math.max(8, r.top - 4 - h)}px`
      list.style.maxHeight = `${Math.max(120, r.top - 12)}px`
    }
    const lw = list.offsetWidth
    if (r.left + lw > window.innerWidth - 8) list.style.left = `${Math.max(8, window.innerWidth - lw - 8)}px`
  }
  const open = () => {
    if (btn.disabled) return
    openList?.close()
    list.innerHTML = ''
    ;[...sel.options].forEach((o, i) => {
      const el = document.createElement('div')
      el.className = 'dd-opt'
      el.setAttribute('role', 'option')
      el.textContent = o.textContent
      if (o.disabled) el.classList.add('disabled')
      if (i === sel.selectedIndex) {
        el.classList.add('selected')
        el.setAttribute('aria-selected', 'true')
      }
      el.addEventListener('mousedown', (e) => e.preventDefault())
      el.addEventListener('click', () => choose(i))
      el.addEventListener('mousemove', () => setActive(i))
      list.appendChild(el)
    })
    list.hidden = false
    wrap.classList.add('open')
    btn.setAttribute('aria-expanded', 'true')
    place()
    setActive(sel.selectedIndex)
    openList = { close }
  }
  function close(): void {
    list.hidden = true
    wrap.classList.remove('open')
    btn.setAttribute('aria-expanded', 'false')
    if (openList?.close === close) openList = null
  }

  btn.addEventListener('click', () => (list.hidden ? open() : close()))
  btn.addEventListener('keydown', (e) => {
    const isOpen = !list.hidden
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!isOpen) open()
      else setActive(active + (e.key === 'ArrowDown' ? 1 : -1))
    } else if ((e.key === 'Enter' || e.key === ' ') && isOpen) {
      e.preventDefault()
      choose(active)
    } else if (e.key === 'Escape' && isOpen) {
      e.preventDefault()
      e.stopPropagation()
      close()
    } else if (e.key === 'Tab' && isOpen) close()
    else if (e.key.length === 1 && isOpen) {
      // Saut à la première option qui commence par la lettre tapée.
      const k = e.key.toLowerCase()
      const i = items().findIndex((el, n) => n > active && el.textContent!.trim().toLowerCase().startsWith(k))
      const j = i >= 0 ? i : items().findIndex((el) => el.textContent!.trim().toLowerCase().startsWith(k))
      if (j >= 0) setActive(j)
    }
  })
  btn.addEventListener('blur', () => window.setTimeout(() => list.matches(':hover') || close(), 120))
  document.addEventListener('mousedown', (e) => {
    if (!list.hidden && !wrap.contains(e.target as Node) && !list.contains(e.target as Node)) close()
  })
  window.addEventListener('resize', close)
  document.getElementById('pages')?.addEventListener('scroll', close)
}

// ---------- Champs numériques ----------

function enhanceNumber(inp: HTMLInputElement): void {
  if (inp.dataset['enhanced']) return
  inp.dataset['enhanced'] = '1'
  const wrap = document.createElement('div')
  wrap.className = 'num'
  inp.parentNode!.insertBefore(wrap, inp)
  const mk = (txt: string, dir: 1 | -1, label: string) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'num-btn'
    b.textContent = txt
    b.tabIndex = -1
    b.setAttribute('aria-label', label)
    b.addEventListener('click', () => {
      if (dir > 0) inp.stepUp()
      else inp.stepDown()
      inp.dispatchEvent(new Event('input', { bubbles: true }))
      inp.dispatchEvent(new Event('change', { bubbles: true }))
    })
    return b
  }
  wrap.append(mk('−', -1, 'Diminuer'), inp, mk('+', 1, 'Augmenter'))
}

export function enhanceControls(root: ParentNode = document): void {
  root.querySelectorAll('select').forEach(enhanceSelect)
  root.querySelectorAll<HTMLInputElement>('input[type="number"]').forEach(enhanceNumber)
}

// ---------- Confirmation ----------

export function confirmBox(message: string, o: { ok?: string; cancel?: string; danger?: boolean; title?: string } = {}): Promise<boolean> {
  return new Promise((resolve) => {
    const prev = document.activeElement as HTMLElement | null
    const back = document.createElement('div')
    back.className = 'ui-modal'
    const box = document.createElement('div')
    box.className = 'ui-dialog'
    box.setAttribute('role', 'alertdialog')
    box.setAttribute('aria-modal', 'true')
    if (o.title) {
      const h = document.createElement('h2')
      h.textContent = o.title
      box.appendChild(h)
    }
    for (const para of message.split('\n\n')) {
      const p = document.createElement('p')
      p.textContent = para
      box.appendChild(p)
    }
    const row = document.createElement('div')
    row.className = 'ui-dialog-row'
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'secondary'
    cancel.textContent = o.cancel ?? 'Annuler'
    const ok = document.createElement('button')
    ok.type = 'button'
    ok.textContent = o.ok ?? 'Continuer'
    if (o.danger) ok.classList.add('btn-danger')
    row.append(cancel, ok)
    box.appendChild(row)
    back.appendChild(box)
    document.body.appendChild(back)
    const done = (v: boolean) => {
      document.removeEventListener('keydown', onKey, true)
      back.remove()
      prev?.focus()
      resolve(v)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        done(false)
      } else if (e.key === 'Tab') {
        // Le focus reste dans la boîte.
        e.preventDefault()
        ;(document.activeElement === ok ? cancel : ok).focus()
      }
    }
    document.addEventListener('keydown', onKey, true)
    cancel.addEventListener('click', () => done(false))
    ok.addEventListener('click', () => done(true))
    back.addEventListener('mousedown', (e) => e.target === back && done(false))
    ;(o.danger ? cancel : ok).focus()
  })
}
