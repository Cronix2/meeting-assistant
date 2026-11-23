import fs from 'node:fs'
import path from 'node:path'
import { BrowserWindow, Menu, app, desktopCapturer, dialog, ipcMain, net, session } from 'electron'
import type {
  AppState,
  AudioDevice,
  CaptureOptions,
  DiagSnapshot,
  KbBriefEstimate,
  KbDocInfo,
  KbImportResult,
  KbInfo,
  KbPatch,
  KbSummaryEstimate,
  KbSummaryResult,
  DataExportResult,
  UpdateState,
  DataImportInfo,
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
import { claudeComplete, estimateBrief, generateBrief } from './kb/brief'
import {
  clearSummaries,
  createBase,
  deleteBase,
  importPaths,
  initKnowledge,
  listBases,
  listDocs as listKbDocs,
  readSummary,
  removeDoc as removeKbDoc,
  setBrief,
  startIndexing,
  updateBase
} from './kb/knowledge'
import { estimateSummaries, summarizeBase } from './kb/summaries'
import { explain } from './llm'
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
import { Updater } from './updater'
import {
  MIN_PASSWORD,
  backupData,
  buildExport,
  collectEntries,
  openExport,
  readHeader,
  writeImport
} from './transfer'
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
let updater: Updater

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
const SETTINGS_CHANNELS = new Set(['state', 'level', 'log', 'kb:progress', 'update:state'])

function sendTo(win: BrowserWindow | null | undefined, channel: string, payload?: unknown): void {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  win.webContents.send(channel, payload)
}

function send(channel: string, payload?: unknown): void {
  if (channel !== 'kb:progress') sendTo(overlayWin, channel, payload)
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
  tray.update(pipeline.state, settings.hotkeys, updateBadge())
  if (updater && prev.autoUpdateCheck !== settings.autoUpdateCheck) updater.schedule(settings.autoUpdateCheck)
}

/** Version proposée dans le menu de la zone de notification, s'il y en a une. */
function updateBadge(): string | undefined {
  const st = updater?.snapshot
  return st && (st.status === 'available' || st.status === 'ready') ? st.latest : undefined
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
  initKnowledge(path.join(app.getPath('userData'), 'knowledge'), { log, emit: (p) => send('kb:progress', p) })
  startIndexing()
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
    onStateChange: (state: AppState) => tray?.update(state, settings.hotkeys, updateBadge())
  })

  tray = createTray({
    toggleOverlay: () => toggleOverlay(overlayWin),
    toggleListening: () => void pipeline.toggleListening(),
    setMode: (mode) => commitSettings({ ...settings, mode }),
    openSettings: () => openSettingsWindow(),
    openUpdate: () => openSettingsWindow('maj'),
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

  updater = new Updater({
    currentVersion: app.getVersion(),
    canInstall: app.isPackaged,
    emit: (st) => {
      send('update:state', st)
      tray.update(pipeline.state, settings.hotkeys, st.status === 'available' || st.status === 'ready' ? st.latest : undefined)
    },
    log,
    quit: () => app.quit(),
    // Pile réseau de Chromium : respecte le proxy système de Windows.
    fetchImpl: ((input: string, init?: RequestInit) => net.fetch(input, init)) as unknown as typeof fetch
  })
  updater.schedule(settings.autoUpdateCheck)
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
  ipcMain.on('overlay:openUpdate', (e) => fromOverlay(e) && openSettingsWindow('maj'))
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
  registerKnowledgeIpc()
  registerTransferIpc()
  ipcMain.handle('settings:get', (): SettingsView => currentView())
  ipcMain.handle('settings:save', (_e, patch: SettingsPatch) => handleSave(patch))
  ipcMain.handle('update:get', (): UpdateState => updater.snapshot)
  ipcMain.handle('update:check', (): Promise<UpdateState> => updater.check(false))
  ipcMain.handle('update:download', (): Promise<UpdateState> => updater.download())
  ipcMain.handle('update:cancel', (): void => updater.cancel())
  ipcMain.handle('update:install', (): UpdateState => updater.install())
}

// ---------- Mémoire professionnelle (bases de connaissances) ----------

/** Une seule tâche longue (import ou synthèse) par base à la fois. */
const kbJobs = new Map<string, { kind: 'import' | 'brief' | 'summary'; flag: { aborted: boolean }; abort: AbortController }>()

function startKbJob(id: string, kind: 'import' | 'brief' | 'summary') {
  if (kbJobs.has(id)) throw new Error('une opération est déjà en cours sur cette base')
  const job = { kind, flag: { aborted: false }, abort: new AbortController() }
  kbJobs.set(id, job)
  return job
}

// ---------- Transfert des données vers un autre PC ----------

function registerTransferIpc(): void {
  const dataDir = () => app.getPath('userData')
  const parent = () => getSettingsWindow() ?? undefined

  ipcMain.handle('data:export', async (_e, o: { password?: string; includeKeys?: boolean }): Promise<DataExportResult> => {
    try {
      const password = typeof o?.password === 'string' && o.password ? o.password : undefined
      if (password && password.length < MIN_PASSWORD) return { ok: false, message: `Mot de passe trop court (${MIN_PASSWORD} caractères minimum).` }
      if (o?.includeKeys && !password) return { ok: false, message: 'Choisis un mot de passe pour exporter les clés API.' }
      const stamp = new Date().toISOString().slice(0, 10)
      const opts: Electron.SaveDialogOptions = {
        title: 'Exporter les données de Desk Assistant',
        defaultPath: path.join(app.getPath('documents'), `desk-assistant-${stamp}.deskassistant`),
        filters: [{ name: 'Export Desk Assistant', extensions: ['deskassistant'] }]
      }
      const w = parent()
      const res = w ? await dialog.showSaveDialog(w, opts) : await dialog.showSaveDialog(opts)
      if (res.canceled || !res.filePath) return { ok: false, canceled: true }
      const entries = collectEntries(dataDir()).map((e) => ({ name: e.name, data: fs.readFileSync(e.file) }))
      let secrets: Record<string, string> | undefined
      if (o?.includeKeys) {
        secrets = {}
        for (const k of ['elevenlabs', 'anthropic'] as const) {
          const v = getSecret(k)
          if (v) secrets[k] = v
        }
      }
      const buf = buildExport({ entries, appVersion: app.getVersion(), password, secrets, ragDocs: listDocs().length })
      fs.writeFileSync(res.filePath, buf)
      log(`[transfert] export écrit (${Math.round(buf.length / 1024)} Ko, ${password ? 'chiffré' : 'non chiffré'}${secrets ? ', avec les clés' : ''})`)
      return { ok: true, path: res.filePath, bytes: buf.length, keys: !!secrets && Object.keys(secrets).length > 0 }
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('data:pickImport', async (): Promise<DataImportInfo | null> => {
    const opts: Electron.OpenDialogOptions = {
      title: 'Importer des données Desk Assistant',
      properties: ['openFile'],
      filters: [{ name: 'Export Desk Assistant', extensions: ['deskassistant'] }]
    }
    const w = parent()
    const res = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts)
    if (res.canceled || !res.filePaths[0]) return null
    const file = res.filePaths[0]
    try {
      const fd = fs.openSync(file, 'r')
      const head = Buffer.alloc(8192)
      const n = fs.readSync(fd, head, 0, head.length, 0)
      fs.closeSync(fd)
      const { header } = readHeader(head.subarray(0, n))
      return { ok: true, file, name: path.basename(file), encrypted: header.encrypted, created: header.created, appVersion: header.appVersion, summary: header.summary }
    } catch (e) {
      return { ok: false, file, name: path.basename(file), message: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('data:import', async (_e, o: { file: string; password?: string }): Promise<DataExportResult> => {
    try {
      const file = String(o?.file ?? '')
      if (!file.toLowerCase().endsWith('.deskassistant')) return { ok: false, message: 'Fichier invalide.' }
      const opened = openExport(fs.readFileSync(file), o?.password || undefined)
      const backup = backupData(dataDir())
      writeImport(dataDir(), opened.entries, (json) => {
        // Les périphériques audio sont propres à chaque PC : on repart sur une configuration qui marche partout.
        const s = JSON.parse(json) as Record<string, unknown>
        if (s['audioSource'] !== 'loopback' && s['audioSource'] !== 'mixer') s['audioSource'] = 'loopback'
        s['mixerDevices'] = []
        return JSON.stringify(s, null, 2)
      })
      let keys = false
      if (opened.secrets) {
        for (const k of ['elevenlabs', 'anthropic'] as const) {
          const v = opened.secrets[k]
          if (v && setSecret(k, v)) keys = true
        }
      }
      log(`[transfert] import terminé (sauvegarde précédente : ${backup}) ; redémarrage`)
      // Redémarrage : toutes les données (réglages, mémoire, bases) sont rechargées proprement.
      setTimeout(() => {
        app.relaunch()
        app.exit(0)
      }, 1200)
      return { ok: true, keys, backup }
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  })
}

function registerKnowledgeIpc(): void {
  const parent = () => getSettingsWindow() ?? undefined
  ipcMain.handle('kb:list', (): KbInfo[] => listBases())
  ipcMain.handle('kb:create', (_e, name: string): KbInfo => createBase(String(name ?? '')))
  ipcMain.handle('kb:update', (_e, a: { id: string; patch: KbPatch }): KbInfo | null => updateBase(String(a.id), a.patch ?? {}))
  ipcMain.handle('kb:delete', (_e, id: string): KbInfo[] => {
    kbJobs.get(String(id))?.abort.abort()
    deleteBase(String(id))
    return listBases()
  })
  ipcMain.handle('kb:docs', (_e, id: string): KbDocInfo[] => listKbDocs(String(id)))
  ipcMain.handle('kb:removeDoc', (_e, a: { id: string; docId: string }): KbInfo[] => {
    removeKbDoc(String(a.id), String(a.docId))
    return listBases()
  })
  ipcMain.handle('kb:cancel', (_e, id: string): void => {
    const job = kbJobs.get(String(id))
    if (!job) return
    job.flag.aborted = true
    job.abort.abort()
  })

  ipcMain.handle('kb:import', async (_e, a: { id: string; mode: 'files' | 'folder' }): Promise<KbImportResult | null> => {
    const opts: Electron.OpenDialogOptions =
      a.mode === 'folder'
        ? { title: 'Ajouter un dossier (projet, cours…)', properties: ['openDirectory', 'multiSelections'] }
        : { title: 'Ajouter des fichiers', properties: ['openFile', 'multiSelections'] }
    const w = parent()
    const res = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts)
    if (res.canceled || !res.filePaths.length) return null
    const job = startKbJob(String(a.id), 'import')
    try {
      return await importPaths(String(a.id), res.filePaths, job.flag)
    } finally {
      kbJobs.delete(String(a.id))
    }
  })

  ipcMain.handle('kb:sumEstimate', (_e, id: string): KbSummaryEstimate => estimateSummaries(String(id)))
  ipcMain.handle('kb:note', (_e, a: { id: string; docId: string }): string => readSummary(String(a.id), String(a.docId)))
  ipcMain.handle('kb:clearNotes', (_e, id: string): KbInfo[] => {
    clearSummaries(String(id))
    return listBases()
  })
  ipcMain.handle('kb:summarize', async (_e, id: string): Promise<KbSummaryResult> => {
    const kbId = String(id)
    const apiKey = getSecret('anthropic')
    if (!apiKey) return { ok: false, message: 'Clé API Claude manquante (section Clés API).', done: 0, failed: 0 }
    let job
    try {
      job = startKbJob(kbId, 'summary')
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e), done: 0, failed: 0 }
    }
    try {
      log(`[base] notes par fichier lancées avec ${settings.model}`)
      const res = await summarizeBase({
        kbId,
        complete: claudeComplete(apiKey, settings.model, job.abort.signal),
        signal: job.flag,
        onProgress: (p) => send('kb:progress', p)
      })
      log(`[base] notes : ${res.done} créée(s), ${res.failed} en échec`)
      return res
    } catch (e) {
      const message = job.flag.aborted ? 'Annulé.' : explain(e)
      send('kb:progress', { kbId, task: 'summary', done: 0, total: 0, label: '', finished: true, message })
      return { ok: false, message, done: 0, failed: 0 }
    } finally {
      kbJobs.delete(kbId)
    }
  })

  ipcMain.handle('kb:estimate', (_e, id: string): KbBriefEstimate => estimateBrief(String(id)))

  ipcMain.handle('kb:brief', async (_e, id: string): Promise<{ ok: boolean; message?: string; info?: KbInfo | null }> => {
    const kbId = String(id)
    const apiKey = getSecret('anthropic')
    if (!apiKey) return { ok: false, message: 'Clé API Claude manquante (section Clés API).' }
    let job
    try {
      job = startKbJob(kbId, 'brief')
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
    try {
      log(`[base] synthèse lancée avec ${settings.model}`)
      const text = await generateBrief({
        kbId,
        complete: claudeComplete(apiKey, settings.model, job.abort.signal),
        signal: job.flag,
        onProgress: (p) => send('kb:progress', p)
      })
      setBrief(kbId, text)
      log(`[base] fiche de compréhension prête (${text.length} caractères)`)
      return { ok: true, info: listBases().find((b) => b.id === kbId) ?? null }
    } catch (e) {
      const message = job.flag.aborted ? 'Synthèse annulée.' : explain(e)
      send('kb:progress', { kbId, task: 'brief', done: 0, total: 0, label: '', finished: true, message })
      return { ok: false, message }
    } finally {
      kbJobs.delete(kbId)
    }
  })
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
