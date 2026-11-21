/** Un extrait d'un document : positions en caractères + numéros de lignes (1-based). */
export interface Chunk {
  start: number
  end: number
  lineStart: number
  lineEnd: number
  /** Fonctions / classes / sélecteurs rencontrés dans l'extrait (ou celle qui le contient) : aide la recherche et la citation */
  symbols?: string[]
}

const TEXT_TARGET = 900
const TEXT_MAX = 1500
const CODE_TARGET = 1400
const CODE_MAX = 2200
const CODE_SOFT_MIN = 700

/** Positions des débuts de ligne (pour retrouver un numéro de ligne par recherche dichotomique). */
function lineStarts(text: string): number[] {
  const starts = [0]
  let i = -1
  while ((i = text.indexOf('\n', i + 1)) >= 0) starts.push(i + 1)
  return starts
}

function lineOf(starts: number[], pos: number): number {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid] <= pos) lo = mid
    else hi = mid - 1
  }
  return lo + 1
}

function make(starts: number[], start: number, end: number): Chunk {
  return { start, end, lineStart: lineOf(starts, start), lineEnd: lineOf(starts, Math.max(start, end - 1)) }
}

/** Texte courant (cours, lois, PDF, notes…) : paragraphes regroupés, phrases coupées proprement. */
function chunkText(text: string): Chunk[] {
  const starts = lineStarts(text)
  const out: Chunk[] = []
  let cs = -1 // début du chunk courant
  let ce = 0
  const flush = () => {
    if (cs >= 0 && ce > cs && text.slice(cs, ce).trim()) out.push(make(starts, cs, ce))
    cs = -1
  }
  const re = /[^\n]+(?:\n(?!\s*\n)[^\n]+)*/g // un paragraphe = lignes consécutives non vides
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    let ps = m.index
    const pe = m.index + m[0].length
    // Paragraphe trop long : on le découpe aux fins de phrase.
    while (pe - ps > TEXT_MAX) {
      flush()
      let cut = ps + TEXT_TARGET
      const window = text.slice(cut, Math.min(pe, cut + 400))
      const sentence = window.search(/[.!?;:]\s/)
      const space = window.indexOf(' ')
      if (sentence >= 0) cut += sentence + 1
      else if (space >= 0) cut += space
      out.push(make(starts, ps, cut))
      ps = Math.max(ps + 1, cut - 120) // petit recouvrement
      const nextSpace = text.indexOf(' ', ps)
      if (nextSpace >= 0 && nextSpace < ps + 60) ps = nextSpace + 1
    }
    if (cs >= 0 && pe - cs > TEXT_TARGET) flush()
    if (cs < 0) cs = ps
    ce = pe
  }
  flush()
  return out
}

/** Début d'une définition : mot-clé de déclaration (Python, JS/TS, PHP, Go, Rust, Java, C#, Ruby…), éventuellement indenté. */
const DEF_KEYWORD =
  /^\s{0,8}(?:(?:export|default|public|private|protected|static|final|abstract|async|override|virtual|inline|extern|unsafe|pub(?:\([^)]*\))?|readonly|sealed|partial|internal)\s+)*(?:function\*?|def|class|interface|struct|enum|trait|impl|namespace|module|type|func|fn|sub|proc|object|record|union|protocol|extension|const\s+enum)\s+([A-Za-z_$\\][\w$\\]*)/
/** `const nom = (…) =>`, `const nom = function`, `nom = async (…) =>` (JS/TS) */
const DEF_ARROW = /^\s{0,8}(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/
/** Méthode de classe (JS/TS/Java/C#/PHP) : modificateurs + nom( … ) { */
const DEF_METHOD = /^\s{1,8}(?:(?:public|private|protected|static|async|final|override|abstract|get|set)\s+)+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/
/** Fonction C/C++/Go-like en colonne 0 : `type nom(` sans `;` final, hors directives et mots-clés */
const DEF_C = /^(?!#|\/\/|\/\*|\*|\s|}|return\b|if\b|for\b|while\b|switch\b|else\b|typedef\b)[A-Za-z_][\w\s\*&:<>,~]*?[\s\*&]([A-Za-z_~][\w:~]*)\s*\([^;]*$/
/** Règle CSS/SCSS en colonne 0 : `.sel, #id > a {` ou `@media (…) {` */
/** Go : `func (r *T) Nom(` ou `func Nom(` */
const DEF_GO = /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/
const CODE_START = /^(?:if|else|for|while|switch|try|catch|finally|do|func|function|class|struct|enum|interface|namespace|impl|fn|def|return|case|default|select|go|defer|with|elif|unsafe)\b/
const DEF_CSS = /^([.#@:\[a-zA-Z*&][^;{}]{0,100}?)\s*\{\s*$/
const DEF_HTML = /^\s{0,6}<(section|div|header|footer|main|nav|script|style|form|table|article|aside|template)\b[^>]*?(?:\bid="([^"]+)")?/i
const DEF_DECORATOR = /^\s{0,8}@[A-Za-z_][\w.]*(?:\(.*\))?\s*$/

const NOT_A_NAME = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'else', 'sizeof', 'defined', 'elif', 'with'])

/** Nom défini par cette ligne, ou null. */
function defName(line: string): string | null {
  let m = DEF_KEYWORD.exec(line)
  if (m) return m[1]
  m = DEF_ARROW.exec(line)
  if (m) return m[1]
  m = DEF_METHOD.exec(line)
  if (m && !NOT_A_NAME.has(m[1])) return m[1]
  m = DEF_C.exec(line)
  if (m && !NOT_A_NAME.has(m[1])) return m[1]
  m = DEF_GO.exec(line)
  if (m) return m[1]
  m = DEF_CSS.exec(line)
  if (m) {
    const sel = m[1].trim()
    const pseudoFn = /:(?:not|nth-[\w-]+|is|where|has|lang)\(/.test(sel)
    if (!CODE_START.test(sel) && (!sel.includes('(') || sel.startsWith('@') || pseudoFn) && !sel.includes('=')) return sel.slice(0, 60)
  }
  m = DEF_HTML.exec(line)
  if (m) return m[2] ? `${m[1]}#${m[2]}` : m[1]
  return null
}

/** Frontière naturelle où couper de préférence (début de fonction, classe, décorateur, titre…). */
function isBoundary(line: string): boolean {
  return DEF_DECORATOR.test(line) || defName(line) !== null || /^(?:\/\*\*|#{2,}\s|<\?php|\[[^\]\n]+\]\s*$)/.test(line)
}

/** Code, JSON, YAML, CSV, logs : fenêtres de lignes, coupées de préférence aux frontières de fonctions/classes. */
function chunkCode(text: string): Chunk[] {
  const starts = lineStarts(text)
  const out: Chunk[] = []
  const nLines = starts.length
  // Nom défini sur chaque ligne (une seule passe) : sert aux frontières et aux « symboles » de chaque extrait.
  const names: (string | null)[] = new Array(nLines)
  for (let i = 0; i < nLines; i++) {
    const ls = starts[i]
    const line = text.slice(ls, Math.min(ls + 160, i + 1 < nLines ? starts[i + 1] : text.length))
    names[i] = line.length > 3 && line.length < 400 ? defName(line) : null
  }
  let enclosing: string | null = null // dernière définition vue avant le début de l'extrait
  let scanned = 0
  const symbolsOf = (i: number, j: number): string[] => {
    for (; scanned < i; scanned++) if (names[scanned]) enclosing = names[scanned]
    const syms: string[] = []
    if (enclosing && !names[i]) syms.push(enclosing)
    for (let k = i; k < j && syms.length < 8; k++) {
      const n = names[k]
      if (n && !syms.includes(n)) syms.push(n)
    }
    return syms
  }
  let i = 0
  while (i < nLines) {
    const s = starts[i]
    let end = s
    let j = i
    let lastBlank = -1
    while (j < nLines) {
      const ls = starts[j]
      const le = j + 1 < nLines ? starts[j + 1] : text.length
      const size = ls - s
      if (size >= CODE_MAX) break
      if (j > i) {
        if (size >= CODE_SOFT_MIN && (names[j] || isBoundary(text.slice(ls, Math.min(le, ls + 120))))) {
          // un décorateur ou commentaire de doc juste avant la définition reste avec elle
          break
        }
        if (size >= CODE_TARGET && !text.slice(ls, le).trim()) break
      }
      if (!text.slice(ls, le).trim()) lastBlank = j
      end = le
      j++
    }
    if (end - s > CODE_MAX) {
      // Ligne géante (minifié) : coupe dure par caractères.
      for (let p = s; p < end; p += CODE_TARGET) out.push({ ...make(starts, p, Math.min(end, p + CODE_TARGET)), symbols: [] })
    } else if (text.slice(s, end).trim()) {
      out.push({ ...make(starts, s, end), symbols: symbolsOf(i, j) })
    }
    if (j >= nLines) break
    // Recouvrement de 2 lignes pour ne pas perdre le contexte, sauf si on a coupé sur un blanc.
    i = Math.max(i + 1, lastBlank === j - 1 ? j : j - 2)
  }
  return out
}

export function chunkDocument(text: string, kind: 'code' | 'text'): Chunk[] {
  return kind === 'code' ? chunkCode(text) : chunkText(text)
}
