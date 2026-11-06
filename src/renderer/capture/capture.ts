import type { AudioDevice, CaptureOptions } from '../../shared/types'

/**
 * Capture l'audio de TOUTES les applis (loopback de la sortie audio Windows),
 * le convertit en PCM 16 kHz mono 16 bits et l'envoie au process main par morceaux de 100 ms.
 */

const CHUNK_SAMPLES = 1600 // 100 ms à 16 kHz
const HANGOVER_CHUNKS = 15 // on continue d'envoyer 1,5 s après le dernier son (pour que le VAD voie le silence)
const PREROLL_CHUNKS = 3 // 300 ms gardés avant le début du son

const WORKLET_SOURCE = `
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buf = new Float32Array(${CHUNK_SAMPLES})
    this.n = 0
  }
  process(inputs) {
    const input = inputs[0]
    if (!input || !input.length) return true
    const channels = input.length
    const len = input[0].length
    for (let i = 0; i < len; i++) {
      let sum = 0
      for (let c = 0; c < channels; c++) sum += input[c][i]
      this.buf[this.n++] = sum / channels
      if (this.n === ${CHUNK_SAMPLES}) {
        this.port.postMessage(this.buf.slice(0))
        this.n = 0
      }
    }
    return true
  }
}
registerProcessor('pcm-capture', PcmCapture)
`

let ctx: AudioContext | null = null
let stream: MediaStream | null = null
let node: AudioWorkletNode | null = null
let stopping = false
let meter: number | undefined

function toPcm16(f32: Float32Array): Uint8Array {
  const out = new Int16Array(f32.length)
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]))
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return new Uint8Array(out.buffer)
}

function rms(f32: Float32Array): number {
  let sum = 0
  for (let i = 0; i < f32.length; i++) sum += f32[i] * f32[i]
  return Math.sqrt(sum / f32.length)
}

async function stopCapture(): Promise<void> {
  stopping = true
  if (meter !== undefined) window.clearInterval(meter)
  meter = undefined
  try {
    node?.disconnect()
    stream?.getTracks().forEach((t) => t.stop())
    if (ctx && ctx.state !== 'closed') await ctx.close()
  } catch {
    /* ignore */
  }
  node = null
  stream = null
  ctx = null
}

async function startCapture(opts: CaptureOptions): Promise<void> {
  await stopCapture()
  stopping = false

  // Le handler du process main répond avec audio:'loopback'. Windows impose de demander une
  // piste vidéo : on la jette tout de suite, seul l'audio nous intéresse.
  let s: MediaStream
  if (opts.deviceId && opts.deviceId !== 'loopback') {
    // Périphérique d'entrée précis (ex. mix « Stream » de Sonar, câble virtuel…), sans traitement du signal.
    s = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: { exact: opts.deviceId },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    })
  } else {
    s = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
    if (!opts.keepVideo) {
      s.getVideoTracks().forEach((t) => {
        t.stop()
        s.removeTrack(t)
      })
    }
  }
  if (s.getAudioTracks().length === 0) {
    s.getTracks().forEach((t) => t.stop())
    throw new Error("aucune piste audio système (loopback) n'a été fournie")
  }
  stream = s
  s.getAudioTracks()[0].addEventListener('ended', () => {
    if (!stopping) window.api.send('capture:status', { ok: false, message: 'le flux audio système s’est arrêté' })
  })

  ctx = new AudioContext({ sampleRate: 16000, latencyHint: 'interactive' })
  const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }))
  try {
    await ctx.audioWorklet.addModule(url)
  } finally {
    URL.revokeObjectURL(url)
  }
  await ctx.resume()

  const source = ctx.createMediaStreamSource(new MediaStream(s.getAudioTracks()))
  node = new AudioWorkletNode(ctx, 'pcm-capture', { numberOfInputs: 1, numberOfOutputs: 1 })

  // Porte de silence : n'envoie que quand il y a du son (moins de temps d'audio facturé).
  let active = false
  let hang = 0
  const preroll: Float32Array[] = []
  let peak = 0
  let sentChunks = 0
  let msgs = 0
  const send = (f: Float32Array) => {
    sentChunks++
    window.api.send('audio:chunk', toPcm16(f))
  }

  // Diagnostic : un analyseur branché directement sur la source (hors worklet) pour savoir
  // si le flux porte du son, indépendamment du worklet.
  const audioCtx = ctx
  const track = s.getAudioTracks()[0]
  const analyser = audioCtx.createAnalyser()
  analyser.fftSize = 2048
  source.connect(analyser)
  const anBuf = new Float32Array(analyser.fftSize)

  meter = window.setInterval(() => {
    analyser.getFloatTimeDomainData(anBuf)
    window.api.send('capture:level', {
      rms: peak, // niveau vu par le worklet
      an: rms(anBuf), // niveau vu par l'analyseur
      msgs, // morceaux reçus du worklet (cumul)
      sent: sentChunks,
      active,
      ctx: audioCtx.state,
      rate: audioCtx.sampleRate,
      track: `${track.readyState}${track.muted ? '/muted' : ''}${track.enabled ? '' : '/disabled'}`
    })
    peak = 0
    sentChunks = 0
  }, 500)

  node.port.onmessage = (ev: MessageEvent<Float32Array>) => {
    msgs++
    const f = ev.data
    const level = rms(f)
    if (level > peak) peak = level
    if (!opts.gate) {
      send(f)
      return
    }
    if (level >= opts.threshold) {
      if (!active) {
        active = true
        for (const p of preroll) send(p)
        preroll.length = 0
      }
      hang = HANGOVER_CHUNKS
      send(f)
    } else if (active) {
      send(f)
      if (--hang <= 0) active = false
    } else {
      preroll.push(f)
      if (preroll.length > PREROLL_CHUNKS) preroll.shift()
    }
  }

  // Le noeud doit être relié à la sortie pour être « tiré » par le graphe audio ; gain 0 = aucun son émis.
  const mute = ctx.createGain()
  mute.gain.value = 0
  source.connect(node)
  node.connect(mute)
  mute.connect(ctx.destination)

  window.api.send('capture:status', { ok: true })
}

/** Liste les périphériques d'entrée audio (un accès micro bref débloque les noms). */
async function listInputDevices(): Promise<AudioDevice[]> {
  try {
    const tmp = await navigator.mediaDevices.getUserMedia({ audio: true })
    tmp.getTracks().forEach((t) => t.stop())
  } catch {
    /* pas d'accès micro : on listera sans noms */
  }
  const all = await navigator.mediaDevices.enumerateDevices()
  return all
    .filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications')
    .map((d, i) => ({ id: d.deviceId, label: d.label || `Périphérique ${i + 1}` }))
}

window.listInputDevices = listInputDevices
window.startCapture = startCapture
window.stopCapture = stopCapture
