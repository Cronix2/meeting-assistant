import { BrowserWindow, Menu, app, desktopCapturer, dialog, ipcMain, session } from 'electron'
import type {
  AppState,
  AudioDevice,
  CaptureOptions,
  DiagSnapshot,
  LevelMessage,
  MixerListResult,
  OverlayPrefsMessage,
  RagChange,
  RagDoc,
  SaveResult,
  Settings,
  SettingsPatch,
  SettingsView
} from '../shared/types'
import { SilenceGate } from './gate'
import {
  MixerCapture,
  autoSonarIds,
  ensureHelper,
  listRenderDevices,
  pickDevices,
  type MixerLevel
} from './helper'
import { getLog, log, onLog } from './log'
import { Pipeline } from './pipeline'
import { RAG_EXTENSIONS, addFiles, listDocs, removeDoc } from './rag'
import {
  encryptionAvailable,
  getSecret,
  loadSettings,
  merge,
  sanitize,
  saveSettings,
  setSecret
} from './settings'
import { registerShortcuts, unregisterAllShortcuts } from './shortcuts'
import { createTray, type TrayHandle } from './tray'
import {
  createCaptureWindow,
  createOverlayWindow,
  getSettingsWindow,
  openSettingsWindow,
  showOverlay,
  toggleOverlay
} from './windows'

// `windows.ts` lit ce drapeau pour distinguer « masquer l'overlay » de « quitter ».
Object.assign(app, { isQuitting: false })

let settings: Settings
let captureWin: BrowserWindow
let overlayWin: BrowserWindow
let pipeline: Pipeline
let tray: TrayHandle
let chunkCount = 0 // diagnostic : morceaux audio transmis au pipeline
let mixer: MixerCapture | null = null
let heardDevices = new Set<string>()

// ---------- Capture de l'audio système (loopback Windows) ----------

function setupLoopback(): void {
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      desktopCapturer
        .getSources({ types: ['screen'] })
        .then((sources) => {
          if (!sources.length) return callback({})
          // 'loopback' = mix de toutes les applis sur la sortie audio par défaut.
          // (pas 'loopbackWithMute' : on veut continuer à entendre le son)
          callback({ video: sources[0], audio: 'loopback' })
        })
        .catch(() => callback({}))
    },
    { useSystemPicker: false }
  )
}

async function runInCapture(code: string): Promise<void> {
  // userGesture=true : getDisplayMedia exige une activation utilisateur.
  await captureWin.webContents.executeJavaScript(code, true)
}

async function evalInCapture<T>(code: string): Promise<T> {
  return (await captureWin.webContents.executeJavaScript(code, true)) as T
}

// ---------- Messages vers l'overlay ----------

/** La fenêtre de réglages n'a besoin que de l'état, des niveaux et du journal (panneau Diagnostic). */
const SETTINGS_CHANNELS = new Set(['state', 'level', 'log'])

function sendTo(win: BrowserWindow | null | undefined, channel: string, payload?: unknown): void {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  win.webContents.send(channel, payload)
}

function send(channel: string, payload?: unknown): void {
  sendTo(overlayWin, channel, payload)
  if (SETTINGS_CHANNELS.has(channel)) sendTo(getSettingsWindow(), channel, payload)
}

// ---------- Mixeur natif de sorties Windows (SteelSeries Sonar…) ----------

async function startMixer(opts: CaptureOptions): Promise<void> {
  stopMixer()
  const exe = await ensureHelper()
  const devices = await listRenderDevices()
  log(`[mixeur] sorties Windows détectées : ${devices.map((d) => d.name).join(' | ') || 'aucune'}`)
  const ids = pickDevices(devices, settings)
  if (!ids.length) throw new Error('aucune sortie audio Windows à capturer')

  const m = new MixerCapture(exe, ids)
  const gate = new SilenceGate(opts.gate, opts.threshold)
  heardDevices = new Set()
  chunkCount = 0

  m.on('audio', (chunk: Buffer) => {
    if (mixer !== m) return
    for (const c of gate.process(chunk)) {
      chunkCount++
      pipeline.onAudio(c)
    }
  })
  m.on('level', (l: MixerLevel) => {
    if (mixer !== m) return
    for (const d of l.devices) {
      if (d.rms > 0.001 && !heardDevices.has(d.name)) {
        heardDevices.add(d.name)
        log(`[mixeur] son reçu depuis « ${d.name} »`)
      }
    }
    const msg: LevelMessage = {
      source: 'mixer',
      rms: l.mix,
      an: l.mix,
      received: chunkCount,
      devices: l.devices
    }
    send('level', msg)
  })
  m.on('warn', (message: string) => log(`[mixeur] ${message}`))
  m.on('exit', (message: string) => {
    if (mixer !== m) return
    mixer = null
    log(`[mixeur] arrêt inattendu : ${message}`)
    pipeline.onCaptureError(message)
  })

  mixer = m
  try {
    const names = await m.start()
    log(`[mixeur] capture en cours sur ${names.length} sortie(s) : ${names.join(' | ')}`)
  } catch (e) {
    if (mixer === m) mixer = null
    throw e
  }
}

function stopMixer(): void {
  const m = mixer
  mixer = null
  if (m) {
    m.stop()
    log('[mixeur] capture arrêtée')
  }
}

function pushPrefs(): void {
  const msg: OverlayPrefsMessage = {
    fontSize: settings.overlay.fontSize,
    opacity: settings.overlay.opacity,
    showTranscript: settings.overlay.showTranscript,
    hotkeys: settings.hotkeys
  }
  send('prefs', msg)
}

// ---------- Raccourcis ----------

function applyShortcuts(): string[] {
  return registerShortcuts(settings.hotkeys, {
    toggle: () => toggleOverlay(overlayWin),
    ask: () => {
      showOverlay(overlayWin)
      void pipeline.ask('manual')
    },
    clear: () => pipeline.clear()
  })
}

// ---------- Réglages ----------

/** 4 derniers caractères seulement (jamais plus), et seulement pour une clé de longueur plausible. */
const keyHint = (key?: string): string => (key && key.length >= 20 ? key.slice(-4) : '')

function currentView(): SettingsView {
  return {
    ...settings,
    hasElevenLabsKey: !!getSecret('elevenlabs'),
    hasAnthropicKey: !!getSecret('anthropic'),
    elevenLabsKeyHint: keyHint(getSecret('elevenlabs')),
    anthropicKeyHint: keyHint(getSecret('anthropic')),
    encryptionAvailable: encryptionAvailable()
  }
}

function commitSettings(next: Settings): void {
  const prev = settings
  settings = next
  saveSettings(settings)

  overlayWin.setOpacity(settings.overlay.opacity)
  overlayWin.setContentProtection(settings.overlay.contentProtection)
  pushPrefs()
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: settings.launchAtStartup })
  void pipeline.applySettings(prev)
  tray.update(pipeline.state, settings.hotkeys)
}

async function handleSave(patch: SettingsPatch): Promise<SaveResult> {
  const messages: string[] = []
  if (patch.elevenLabsKey !== undefined && !setSecret('elevenlabs', patch.elevenLabsKey)) {
    messages.push('Chiffrement indisponible : clé ElevenLabs non enregistrée.')
  }
  if (patch.anthropicKey !== undefined && !setSecret('anthropic', patch.anthropicKey)) {
    messages.push('Chiffrement indisponible : clé Claude non enregistrée.')
  }
  commitSettings(sanitize(merge(settings, patch.settings ?? {})))
  const hotkeyErrors = applyShortcuts()
  return {
    ok: messages.length === 0,
    hotkeyErrors,
    message: messages.join(' ') || undefined
  }
}

// ---------- Démarrage ----------

async function main(): Promise<void> {
  Menu.setApplicationMenu(null)
  settings = loadSettings()
  setupLoopback()

  captureWin = await createCaptureWindow()
  overlayWin = createOverlayWindow(settings.overlay, (b) => {
    settings = sanitize({ ...settings, overlay: { ...settings.overlay, ...b } })
    saveSettings(settings)
  })

  pipeline = new Pipeline({
    getSettings: () => settings,
    send,
    startCapture: (opts: CaptureOptions) => {
      log(`[capture] démarrage — source : ${opts.deviceId ?? 'loopback'}`)
      if (opts.deviceId === 'mixer') return startMixer(opts)
      chunkCount = 0
      return runInCapture(
        `window.startCapture(${JSON.stringify({ ...opts, keepVideo: process.env['DESK_KEEP_VIDEO'] === '1' })})`
      )
    },
    stopCapture: async () => {
      stopMixer()
      await runInCapture('window.stopCapture()')
    },
    onStateChange: (state: AppState) => tray?.update(state, settings.hotkeys)
  })

  tray = createTray({
    toggleOverlay: () => toggleOverlay(overlayWin),
    toggleListening: () => void pipeline.toggleListening(),
    setMode: (mode) => commitSettings({ ...settings, mode }),
    openSettings: openSettingsWindow,
    quit: () => app.quit()
  })
  tray.update(pipeline.state, settings.hotkeys)

  onLog((line) => send('log', line))
  registerIpc()
  const failures = applyShortcuts()
  if (failures.length) send('answer:error', failures.join('\n'))

  overlayWin.webContents.once('did-finish-load', () => {
    pushPrefs()
    pipeline.pushState()
  })

  if (!settings.startHidden) showOverlay(overlayWin)
  if (settings.autoListen) void pipeline.start()
}

function registerIpc(): void {
  const fromCapture = (e: Electron.IpcMainEvent) => e.sender === captureWin.webContents
  const fromOverlay = (e: Electron.IpcMainEvent) => e.sender === overlayWin.webContents

  ipcMain.on('audio:chunk', (e, data: ArrayBuffer | Uint8Array) => {
    if (!fromCapture(e)) return
    chunkCount++
    if (chunkCount === 1) log('[capture] premiers blocs audio reçus du flux')
    pipeline.onAudio(Buffer.from(data as ArrayBuffer))
  })
  ipcMain.on(
    'capture:level',
    (
      e,
      l: { rms: number; an: number; msgs: number; active: boolean; ctx: string; rate: number; track: string }
    ) => {
      if (!fromCapture(e)) return
      const msg: LevelMessage = {
        source: settings.audioSource === 'loopback' ? 'loopback' : 'device',
        rms: l.rms,
        an: l.an,
        received: chunkCount,
        ctx: `${l.ctx}@${l.rate}Hz`,
        track: l.track,
        msgs: l.msgs
      }
      send('level', msg)
    }
  )
  ipcMain.on('capture:status', (e, s: { ok: boolean; message?: string }) => {
    if (!fromCapture(e)) return
    if (!s.ok) {
      log(`[capture] erreur : ${s.message ?? 'inconnue'}`)
      pipeline.onCaptureError(s.message ?? 'erreur inconnue')
    }
  })

  ipcMain.on('overlay:ready', (e) => {
    if (!fromOverlay(e)) return
    pushPrefs()
    pipeline.pushState()
  })
  ipcMain.on('overlay:ask', (e) => fromOverlay(e) && void pipeline.ask('manual'))
  ipcMain.on('overlay:clear', (e) => fromOverlay(e) && pipeline.clear())
  ipcMain.on('overlay:toggleListening', (e) => fromOverlay(e) && void pipeline.toggleListening())
  ipcMain.on(
    'overlay:toggleMode',
    (e) =>
      fromOverlay(e) &&
      commitSettings({ ...settings, mode: settings.mode === 'auto' ? 'manual' : 'auto' })
  )
  ipcMain.on('overlay:openSettings', (e) => fromOverlay(e) && openSettingsWindow())
  ipcMain.on('overlay:hide', (e) => fromOverlay(e) && overlayWin.hide())

  ipcMain.handle('devices:list', async (): Promise<AudioDevice[]> => {
    try {
      return await evalInCapture<AudioDevice[]>('window.listInputDevices()')
    } catch {
      return []
    }
  })
  ipcMain.handle('mixer:list', async (): Promise<MixerListResult> => {
    try {
      const devices = await listRenderDevices()
      return { devices, autoIds: autoSonarIds(devices) }
    } catch (e) {
      return { devices: [], autoIds: [], error: e instanceof Error ? e.message : String(e) }
    }
  })
  ipcMain.handle('diag:get', (): DiagSnapshot => ({ state: pipeline.state, log: getLog() }))
  ipcMain.handle('diag:toggleListening', async () => {
    await pipeline.toggleListening()
  })
  ipcMain.handle('rag:list', (): RagDoc[] => listDocs())
  ipcMain.handle('rag:add', async (): Promise<RagChange> => {
    const parent = getSettingsWindow()
    const opts: Electron.OpenDialogOptions = {
      title: 'Ajouter des documents à la mémoire',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Texte, Markdown, JSON, CSV…', extensions: RAG_EXTENSIONS }]
    }
    const res = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts)
    if (res.canceled || !res.filePaths.length) return { docs: listDocs(), errors: [] }
    const out = addFiles(res.filePaths)
    log(`[mémoire] ${res.filePaths.length - out.errors.length} document(s) ajouté(s)`)
    return out
  })
  ipcMain.handle('rag:remove', (_e, id: string): RagDoc[] => removeDoc(String(id)))
  ipcMain.handle('settings:get', (): SettingsView => currentView())
  ipcMain.handle('settings:save', (_e, patch: SettingsPatch) => handleSave(patch))
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (overlayWin) showOverlay(overlayWin)
  })
  // L'appli vit dans la zone de notification : fermer les fenêtres ne la quitte pas.
  app.on('window-all-closed', () => {})
  app.on('before-quit', () => {
    Object.assign(app, { isQuitting: true })
  })
  app.on('will-quit', () => {
    stopMixer()
    unregisterAllShortcuts()
  })
  void app.whenReady().then(main)
}
