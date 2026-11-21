/**
 * Index inversé BM25, en mémoire. Chaque « chunk » est un extrait d'un document ; on ne garde ici que
 * ses coordonnées (document, positions) : le texte est relu depuis le disque quand un extrait est retenu.
 */

export interface ChunkRef {
  doc: number
  start: number
  end: number
  lineStart: number
  lineEnd: number
  /** Fonctions / classes présentes dans l'extrait (séparées par « , ») */
  sym?: string
  /** Ce « chunk » est la note de résumé du fichier, pas un morceau de son contenu */
  note?: boolean
}

export interface RawHit {
  chunk: number
  score: number
}

const K1 = 1.2
const B = 0.75

export class SearchIndex {
  chunks: ChunkRef[] = []
  private lens: number[] = []
  private dead: boolean[] = []
  private deadDocs = new Set<number>()
  private deadCount = 0
  private totalLen = 0
  private postings = new Map<string, number[]>()

  get size(): number {
    return this.chunks.length - this.deadCount
  }
  get deadRatio(): number {
    return this.chunks.length ? this.deadCount / this.chunks.length : 0
  }

  add(ref: ChunkRef, tokens: string[]): void {
    const id = this.chunks.length
    this.chunks.push(ref)
    this.lens.push(tokens.length)
    this.dead.push(false)
    this.totalLen += tokens.length
    const tf = new Map<string, number>()
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1)
    for (const [t, f] of tf) {
      const list = this.postings.get(t)
      if (list) list.push(id, f)
      else this.postings.set(t, [id, f])
    }
  }

  /** Retire un document de la recherche (l'espace mémoire n'est rendu qu'à la reconstruction). */
  removeDoc(doc: number): void {
    if (this.deadDocs.has(doc)) return
    this.deadDocs.add(doc)
    for (let i = 0; i < this.chunks.length; i++) {
      if (this.chunks[i].doc === doc && !this.dead[i]) {
        this.dead[i] = true
        this.deadCount++
        this.totalLen -= this.lens[i]
      }
    }
  }

  search(terms: Map<string, number>, limit: number, onlyDocs?: Set<number>, skipNotes = false): RawHit[] {
    const live = this.size
    if (live <= 0) return []
    const avg = this.totalLen / live || 1
    const scores = new Float32Array(this.chunks.length)
    const touched: number[] = []
    // Mots présents dans plus de 40 % des extraits : sans intérêt (sauf si c'est tout ce qu'on a).
    const used: { list: number[]; idf: number; w: number }[] = []
    const common: typeof used = []
    for (const [t, w] of terms) {
      const list = this.postings.get(t)
      if (!list) continue
      const df = list.length / 2
      const idf = Math.log(1 + (live - df + 0.5) / (df + 0.5))
      ;(live > 200 && df > live * 0.4 ? common : used).push({ list, idf, w })
    }
    const active = used.length ? used : common
    for (const { list, idf, w } of active) {
      for (let i = 0; i < list.length; i += 2) {
        const c = list[i]
        if (this.dead[c]) continue
        if (onlyDocs && !onlyDocs.has(this.chunks[c].doc)) continue
        if (skipNotes && this.chunks[c].note) continue
        const f = list[i + 1]
        const s = (w * idf * f * (K1 + 1)) / (f + K1 * (1 - B + (B * this.lens[c]) / avg))
        if (scores[c] === 0) touched.push(c)
        scores[c] += s
      }
    }
    if (!touched.length) return []
    const hits: RawHit[] = touched.map((c) => ({ chunk: c, score: scores[c] }))
    hits.sort((a, b) => b.score - a.score)
    return hits.slice(0, limit)
  }
}
