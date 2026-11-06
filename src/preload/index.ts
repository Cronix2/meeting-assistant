import { contextBridge, ipcRenderer } from 'electron'
import type { Api } from '../shared/types'

// Liste blanche des canaux : le renderer ne peut parler qu'à ceux-là.
const SEND = new Set([
  'audio:chunk',
  'capture:status',
  'capture:level',
  'overlay:ask',
  'overlay:clear',
  'overlay:toggleListening',
  'overlay:toggleMode',
  'overlay:openSettings',
  'overlay:hide',
  'overlay:ready'
])
const INVOKE = new Set([
  'settings:get',
  'settings:save',
  'devices:list',
  'mixer:list',
  'diag:get',
  'diag:toggleListening',
  'rag:list',
  'rag:add',
  'rag:remove'
])
const ON = new Set([
  'state',
  'level',
  'log',
  'perf',
  'prefs',
  'transcript:partial',
  'transcript:committed',
  'answer:start',
  'answer:delta',
  'answer:done',
  'answer:skip',
  'answer:error',
  'answer:clear'
])

const api: Api = {
  send(channel, payload) {
    if (!SEND.has(channel)) throw new Error(`Canal interdit : ${channel}`)
    ipcRenderer.send(channel, payload)
  },
  invoke(channel, payload) {
    if (!INVOKE.has(channel)) throw new Error(`Canal interdit : ${channel}`)
    return ipcRenderer.invoke(channel, payload)
  },
  on(channel, cb) {
    if (!ON.has(channel)) throw new Error(`Canal interdit : ${channel}`)
    const handler = (_e: unknown, payload: unknown) => cb(payload)
    ipcRenderer.on(channel, handler)
    return () => ipcRenderer.removeListener(channel, handler)
  }
}

contextBridge.exposeInMainWorld('api', api)
