import { Menu, Tray, nativeImage } from 'electron'
import type { AppState, Hotkeys, Mode } from '../shared/types'
import { TRAY_ICON_BASE64 } from './icon'

export interface TrayActions {
  toggleOverlay(): void
  toggleListening(): void
  setMode(mode: Mode): void
  openSettings(): void
  quit(): void
}

export interface TrayHandle {
  update(state: AppState, hotkeys: Hotkeys): void
  destroy(): void
}

/** Icône dans la zone de notification (pas de bouton dans la barre des tâches). */
export function createTray(actions: TrayActions): TrayHandle {
  const icon = nativeImage.createFromBuffer(Buffer.from(TRAY_ICON_BASE64, 'base64'))
  const tray = new Tray(icon)
  tray.setToolTip('Desk Assistant')
  tray.on('click', () => actions.toggleOverlay())

  return {
    update(state, hotkeys) {
      tray.setToolTip(
        `Desk Assistant — ${state.listening ? 'à l’écoute' : 'en pause'} (${state.mode === 'auto' ? 'auto' : 'manuel'})`
      )
      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: `Afficher / masquer (${hotkeys.toggle})`, click: actions.toggleOverlay },
          {
            label: state.listening ? 'Mettre l’écoute en pause' : 'Reprendre l’écoute',
            click: actions.toggleListening
          },
          { type: 'separator' },
          {
            label: 'Mode manuel (raccourci)',
            type: 'radio',
            checked: state.mode === 'manual',
            click: () => actions.setMode('manual')
          },
          {
            label: 'Mode automatique',
            type: 'radio',
            checked: state.mode === 'auto',
            click: () => actions.setMode('auto')
          },
          { type: 'separator' },
          { label: 'Réglages…', click: actions.openSettings },
          { label: 'Quitter', click: actions.quit }
        ])
      )
    },
    destroy() {
      tray.destroy()
    }
  }
}
