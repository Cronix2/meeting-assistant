import type { Api, AudioDevice, CaptureOptions } from '../shared/types'

declare global {
  interface Window {
    api: Api
    startCapture?: (opts: CaptureOptions) => Promise<void>
    stopCapture?: () => Promise<void>
    listInputDevices?: () => Promise<AudioDevice[]>
  }
}

export {}
