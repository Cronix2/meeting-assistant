/**
 * Découpage en jetons pour la recherche, pensé pour du texte (FR/EN) ET du code :
 * - minuscules, accents retirés, mots vides ignorés ;
 * - les identifiants sont gardés entiers ET découpés (parseConfig → parseconfig, parse, config ;
 *   max_retry_count → max_retry_count, max, retry, count) pour que « la fonction parse config »
 *   retrouve `parseConfig`.
 */

const STOP = new Set(
  (
    'le la les un une des du de d l et ou en au aux a à est sont été être ce cet cette ces se sa son ses sur dans par pour ' +
    'avec sans que qui quoi dont où ne pas plus je tu il elle nous vous ils elles on mon ma mes ton ta tes leur leurs y ' +
    'ca cela ceci donc alors mais si comme tout tous toute toutes tres bien fait faire ' +
    'the a an and or of to in on at for with without is are was were be been this that these those it its as by from ' +
    'i you he she we they me my your his her our their not no do does did have has had can could would should will ' +
    'um uh so just like yeah okay ok ' +
    'what how why when which who whom whose there here then than also very much many some any about into over under ' +
    'hello hi hey thanks thank please sure well right now going want need tell said ' +
    'bonjour salut merci svp comment pourquoi quand quel quelle quels quelles combien aujourd hui voila oui non peu ' +
    'peux peut pouvez pouvons dire parler parlez explique expliquez explain donner donnez dis dites faut falloir ' +
    'avez avons ai as ete etait etais sera serait vais va vont fais faites ici la là cela celui celle ceux'
  ).split(' ')
)

const WORD = /[A-Za-zÀ-ɏ0-9_]+/g
const NON_ASCII = /[^\x00-\x7f]/
const ACCENTS = /[̀-ͯ]/g

function fold(s: string): string {
  const lower = s.toLowerCase()
  return NON_ASCII.test(lower) ? lower.normalize('NFD').replace(ACCENTS, '') : lower
}

function stem(w: string): string {
  return w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w
}

function push(out: string[], raw: string): void {
  if (raw.length < 2) return
  const w = stem(fold(raw))
  if (w.length >= 2 && !STOP.has(w)) out.push(w)
}

export function tokenize(text: string): string[] {
  const out: string[] = []
  WORD.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = WORD.exec(text))) {
    const w = m[0]
    if (w.length > 40) continue // hachages, base64…
    let digits = 0
    for (let i = 0; i < w.length; i++) {
      const c = w.charCodeAt(i)
      if (c >= 48 && c <= 57) digits++
    }
    if (digits > 12) continue
    const hasUpper = /[A-Z]/.test(w) && /[a-z]/.test(w)
    if (w.includes('_') || hasUpper || (digits > 0 && digits < w.length)) {
      const parts = w
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .replace(/([A-Za-z])([0-9])/g, '$1 $2')
        .split(/[_\s]+/)
        .filter(Boolean)
      if (parts.length > 1) {
        const whole = fold(w.replace(/_/g, ''))
        if (whole.length >= 3) out.push(whole)
        for (const p of parts) push(out, p)
        continue
      }
    }
    push(out, w)
  }
  return out
}

/** Termes d'une requête parlée, avec un poids : les mots de la fin (dernière question) comptent double. */
export function queryTerms(text: string, recentChars = 280): Map<string, number> {
  const terms = new Map<string, number>()
  const cut = Math.max(0, text.length - recentChars)
  for (const t of tokenize(text.slice(0, cut))) terms.set(t, Math.max(terms.get(t) ?? 0, 1))
  for (const t of tokenize(text.slice(cut))) terms.set(t, 2)
  return terms
}
