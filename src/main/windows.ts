import path from 'node:path'
import { BrowserWindow, app, screen, shell } from 'electron'
import type { OverlayPrefs } from '../shared/types'

type Page = 'capture' | 'overlay' | 'settings'

const preloadPath = () => path.join(__dirname, '../preload/index.js')

function loadPage(win: BrowserWindow, page: Page): Promise<void> {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devUrl) return win.loadURL(`${devUrl}/${page}/index.html`)
  return win.loadFile(path.join(__dirname, '../renderer', page, 'index.html'))
}

/** Aucune navigation ni nouvelle fenêtre : ces pages ne chargent que du contenu local. */
function lockdown(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e) => e.preventDefault())
}

const baseWebPrefs = () => ({
  preload: preloadPath(),
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false
})

// ---------- Fenêtre cachée de capture audio ----------

export async function createCaptureWindow(): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    show: false,
    width: 320,
    height: 200,
    skipTaskbar: true,
    webPreferences: {
      ...baseWebPrefs(),
      backgroundThrottling: false, // le worklet audio doit tourner même caché
      autoplayPolicy: 'no-user-gesture-required'
    }
  })
  lockdown(win)
  await loadPage(win, 'capture')
  return win
}

// ---------- Overlay (la petite fenêtre de réponse) ----------

function ensureVisible(
  b: { x: number; y: number; width: number; height: number }
): { x: number; y: number } | null {
  const display = screen.getDisplayMatching(b)
  const wa = display.workArea
  const overlaps =
    b.x < wa.x + wa.width && b.x + b.width > wa.x && b.y < wa.y + wa.height && b.y + b.height > wa.y
  return overlaps ? { x: b.x, y: b.y } : null
}

export function createOverlayWindow(
  prefs: OverlayPrefs,
  onBounds: (b: { x: number; y: number; width: number; height: number }) => void
): BrowserWindow {
  const wa = screen.getPrimaryDisplay().workArea
  const { width, height } = prefs
  let x = wa.x + wa.width - width - 24
  let y = wa.y + wa.height - height - 24
  if (prefs.x !== undefined && prefs.y !== undefined) {
    const saved = ensureVisible({ x: prefs.x, y: prefs.y, width, height })
    if (saved) ({ x, y } = saved)
  }

  const win = new BrowserWindow({
    x,
    y,
    width,
    height,
    minWidth: 280,
    minHeight: 140,
    frame: false,
    show: false,
    skipTaskbar: true, // pas de bouton dans la barre des tâches
    alwaysOnTop: true,
    resizable: true,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    backgroundColor: '#14161b',
    webPreferences: baseWebPrefs()
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setMenuBarVisibility(false)
  win.setContentProtection(prefs.contentProtection)
  win.setOpacity(prefs.opacity)
  lockdown(win)

  let timer: NodeJS.Timeout | undefined
  const saveBounds = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      if (!win.isDestroyed()) onBounds(win.getBounds())
    }, 400)
  }
  win.on('moved', saveBounds)
  win.on('resized', saveBounds)

  // Fermer = masquer (l'appli continue d'écouter).
  win.on('close', (e) => {
    if (!(app as unknown as { isQuitting?: boolean }).isQuitting) {
      e.preventDefault()
      win.hide()
    }
  })

  void loadPage(win, 'overlay')
  return win
}

export function showOverlay(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  win.showInactive() // n'enlève pas le focus à l'appli en cours
  win.setSkipTaskbar(true) // Windows peut recréer le bouton à l'affichage
  win.setAlwaysOnTop(true, 'screen-saver')
}

export function toggleOverlay(win: BrowserWindow): void {
  if (win.isVisible()) win.hide()
  else showOverlay(win)
}

// ---------- Fenêtre de réglages ----------

let settingsWin: BrowserWindow | null = null

export const getSettingsWindow = (): BrowserWindow | null =>
  settingsWin && !settingsWin.isDestroyed() ? settingsWin : null

export function openSettingsWindow(): void {
  if (settingsWin && !settingsWin.isDestroyed()) {
    if (settingsWin.isMinimized()) settingsWin.restore()
    settingsWin.show()
    settingsWin.focus()
    return
  }
  settingsWin = new BrowserWindow({
    width: 760,
    height: 820,
    minWidth: 560,
    minHeight: 480,
    title: 'Desk Assistant — Réglages',
    backgroundColor: '#14161b',
    autoHideMenuBar: true,
    webPreferences: baseWebPrefs()
  })
  settingsWin.setMenuBarVisibility(false)
  lockdown(settingsWin)
  settingsWin.on('closed', () => {
    settingsWin = null
  })
  void loadPage(settingsWin, 'settings')
}
