const HANGOVER_CHUNKS = 15 // on continue d'envoyer 1,5 s après le dernier son (pour que le VAD voie le silence)
const PREROLL_CHUNKS = 3 // 300 ms gardés avant le début du son

/** RMS (0–1) d'un bloc PCM 16 bits little-endian. */
export function rmsInt16(buf: Buffer): number {
  const n = Math.floor(buf.length / 2)
  if (!n) return 0
  let sum = 0
  for (let i = 0; i < n; i++) {
    const v = buf.readInt16LE(i * 2) / 32768
    sum += v * v
  }
  return Math.sqrt(sum / n)
}

/** Même logique que la porte de silence du renderer de capture, côté process principal. */
export class SilenceGate {
  private active = false
  private hang = 0
  private preroll: Buffer[] = []

  constructor(
    private enabled: boolean,
    private threshold: number
  ) {}

  /** Retourne les blocs à transmettre (0, 1, ou plusieurs avec le pré-roll). */
  process(chunk: Buffer): Buffer[] {
    if (!this.enabled) return [chunk]
    if (rmsInt16(chunk) >= this.threshold) {
      const out: Buffer[] = []
      if (!this.active) {
        this.active = true
        out.push(...this.preroll)
        this.preroll = []
      }
      this.hang = HANGOVER_CHUNKS
      out.push(chunk)
      return out
    }
    if (this.active) {
      if (--this.hang <= 0) this.active = false
      return [chunk]
    }
    this.preroll.push(chunk)
    if (this.preroll.length > PREROLL_CHUNKS) this.preroll.shift()
    return []
  }
}
