interface Entry {
  t: number
  text: string
  /** 'answer' = réponse que l'assistant a déjà suggérée à l'utilisateur */
  kind: 'speech' | 'answer'
}

/** Préfixe des lignes de réponses déjà données dans la transcription envoyée à Claude. */
export const ANSWER_MARK = '▶ Réponse déjà suggérée'

const MAX_ENTRIES = 600

/** Mémoire glissante de la transcription (uniquement en RAM, jamais écrite sur disque). */
export class TranscriptBuffer {
  private entries: Entry[] = []

  append(text: string): void {
    const clean = text.trim()
    if (!clean) return
    this.entries.push({ t: Date.now(), text: clean, kind: 'speech' })
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES)
  }

  /** Mémorise une réponse donnée : elle apparaît dans l'historique, à sa place dans la conversation. */
  appendAnswer(text: string): void {
    const clean = text
      .split('\n')
      .filter((l) => !l.trim().startsWith('ℹ'))
      .join(' | ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 700)
    if (!clean) return
    this.entries.push({ t: Date.now(), text: clean, kind: 'answer' })
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES)
  }

  clear(): void {
    this.entries = []
  }

  /** Les derniers `minutes` de transcription, une ligne par phrase validée. */
  recent(minutes: number): string {
    const since = Date.now() - minutes * 60_000
    return this.entries
      .filter((e) => e.t >= since)
      .map((e) => {
        const d = new Date(e.t)
        const hh = String(d.getHours()).padStart(2, '0')
        const mm = String(d.getMinutes()).padStart(2, '0')
        const ss = String(d.getSeconds()).padStart(2, '0')
        return e.kind === 'answer'
          ? `[${hh}:${mm}:${ss}] ${ANSWER_MARK} : ${e.text}`
          : `[${hh}:${mm}:${ss}] ${e.text}`
      })
      .join('\n')
  }
}
