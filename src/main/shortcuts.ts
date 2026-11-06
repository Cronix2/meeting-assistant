import { globalShortcut } from 'electron'
import type { Hotkeys } from '../shared/types'

export interface ShortcutActions {
  toggle(): void
  ask(): void
  clear(): void
}

/**
 * (Ré)enregistre les raccourcis globaux.
 * Retourne la liste des raccourcis qui n'ont pas pu être pris (déjà utilisés par une autre appli, ou invalides).
 */
export function registerShortcuts(hotkeys: Hotkeys, actions: ShortcutActions): string[] {
  globalShortcut.unregisterAll()
  const failures: string[] = []
  const table: Array<[string, string, () => void]> = [
    ['Afficher / masquer', hotkeys.toggle, actions.toggle],
    ['Demander une réponse', hotkeys.ask, actions.ask],
    ['Vider', hotkeys.clear, actions.clear]
  ]
  const seen = new Set<string>()
  for (const [label, accel, run] of table) {
    const key = accel.toLowerCase()
    if (seen.has(key)) {
      failures.push(`${label} : « ${accel} » est déjà attribué à une autre action`)
      continue
    }
    seen.add(key)
    try {
      if (!globalShortcut.register(accel, run)) {
        failures.push(`${label} : « ${accel} » est déjà utilisé par une autre application`)
      }
    } catch {
      failures.push(`${label} : « ${accel} » n'est pas un raccourci valide`)
    }
  }
  return failures
}

export function unregisterAllShortcuts(): void {
  globalShortcut.unregisterAll()
}
