type Listener = (line: string) => void

const MAX_LINES = 300
const lines: string[] = []
const listeners = new Set<Listener>()

/** Journal en mémoire (affiché dans Réglages → Diagnostic) + console. Ne jamais y mettre de clé API. */
export function log(message: string): void {
  const line = `${new Date().toLocaleTimeString('fr-FR')}  ${message}`
  console.log(line)
  lines.push(line)
  if (lines.length > MAX_LINES) lines.shift()
  for (const l of listeners) l(line)
}

export const getLog = (): string[] => lines.slice()

export function onLog(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
