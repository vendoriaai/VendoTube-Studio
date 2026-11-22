import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC, EVENTS } from '@shared/ipc'

/**
 * Preload bridge: strict channel whitelist (TAD §11). The renderer never
 * sees raw ipcRenderer — only `invoke` on known channels and subscription
 * to known events, both returning/removing wrapped listeners.
 */

const INVOKE_ALLOWED = new Set<string>(Object.values(IPC))
const EVENT_ALLOWED = new Set<string>(Object.values(EVENTS))
/** Renderer → main acknowledgements (no reply expected). */
const SEND_ALLOWED = new Set<string>([EVENTS.ProjectsReleased])

const api = {
  invoke: (channel: string, payload?: unknown): Promise<unknown> => {
    if (!INVOKE_ALLOWED.has(channel)) {
      return Promise.reject(new Error(`IPC channel not allowed: ${channel}`))
    }
    return ipcRenderer.invoke(channel, payload)
  },
  on: (event: string, callback: (payload: unknown) => void): (() => void) => {
    if (!EVENT_ALLOWED.has(event)) {
      throw new Error(`IPC event not allowed: ${event}`)
    }
    const listener = (_e: IpcRendererEvent, payload: unknown): void => callback(payload)
    ipcRenderer.on(event, listener)
    return () => {
      ipcRenderer.removeListener(event, listener)
    }
  },
  /** Fire-and-forget signal to main (only the ack channels below). */
  send: (event: string, payload?: unknown): void => {
    if (!SEND_ALLOWED.has(event)) {
      throw new Error(`IPC send not allowed: ${event}`)
    }
    ipcRenderer.send(event, payload)
  }
}

contextBridge.exposeInMainWorld('api', api)

export type PreloadApi = typeof api
