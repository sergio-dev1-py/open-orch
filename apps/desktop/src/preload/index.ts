import { contextBridge, ipcRenderer, webUtils } from "electron"

type Unsubscribe = () => void

const api = {
  invoke: (method: string, ...args: unknown[]): Promise<unknown> => ipcRenderer.invoke(`openorch:${method}`, ...args),
  /** Real filesystem path of a dropped file/folder (webUtils; `file.path` no longer exists). */
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
  /** System clipboard via the main process (sandboxed preloads cannot import it). */
  clipboard: {
    readText: (): Promise<string> => ipcRenderer.invoke("openorch:clipboard.readText") as Promise<string>,
    writeText: (text: string): Promise<void> => ipcRenderer.invoke("openorch:clipboard.writeText", text) as Promise<void>,
  },
  onEngineEvent: (callback: (event: unknown) => void): Unsubscribe => {
    const listener = (_event: unknown, payload: unknown) => callback(payload)
    ipcRenderer.on("engine:event", listener)
    return () => ipcRenderer.removeListener("engine:event", listener)
  },
  onTerminalData: (callback: (payload: { id: string; data: string }) => void): Unsubscribe => {
    const listener = (_event: unknown, payload: { id: string; data: string }) => callback(payload)
    ipcRenderer.on("terminal:data", listener)
    return () => ipcRenderer.removeListener("terminal:data", listener)
  },
  onTerminalExit: (callback: (payload: { id: string }) => void): Unsubscribe => {
    const listener = (_event: unknown, payload: { id: string }) => callback(payload)
    ipcRenderer.on("terminal:exit", listener)
    return () => ipcRenderer.removeListener("terminal:exit", listener)
  },
  /** A preview guest called window.open or the agent opened a tab: create a dock browser tab. */
  onBrowserOpenTab: (callback: (payload: { id?: string; url?: string }) => void): Unsubscribe => {
    const listener = (_event: unknown, payload: { id?: string; url?: string }) => callback(payload)
    ipcRenderer.on("browser:openTab", listener)
    return () => ipcRenderer.removeListener("browser:openTab", listener)
  },
  /** The agent closed a browser tab: remove it from the dock. */
  onBrowserCloseTab: (callback: (payload: { id: string }) => void): Unsubscribe => {
    const listener = (_event: unknown, payload: { id: string }) => callback(payload)
    ipcRenderer.on("browser:closeTab", listener)
    return () => ipcRenderer.removeListener("browser:closeTab", listener)
  },
  /** The agent focused a browser tab: reveal the dock and activate it. */
  onBrowserFocusTab: (callback: (payload: { id: string }) => void): Unsubscribe => {
    const listener = (_event: unknown, payload: { id: string }) => callback(payload)
    ipcRenderer.on("browser:focusTab", listener)
    return () => ipcRenderer.removeListener("browser:focusTab", listener)
  },
  /** Scheduled task notification: open the task detail in the schedule window. */
  onScheduleOpen: (callback: (payload: { taskID?: string }) => void): Unsubscribe => {
    const listener = (_event: unknown, payload: { taskID?: string }) => callback(payload ?? {})
    ipcRenderer.on("schedule:open", listener)
    return () => ipcRenderer.removeListener("schedule:open", listener)
  },
  /** Scheduled task intervention: switch to the task's workspace/session. */
  onOpenSession: (callback: (payload: { sessionID: string; directory: string }) => void): Unsubscribe => {
    const listener = (_event: unknown, payload: { sessionID: string; directory: string }) => callback(payload)
    ipcRenderer.on("session:open", listener)
    return () => ipcRenderer.removeListener("session:open", listener)
  },
  /** Dock shortcuts pressed inside a preview guest, routed to the app window. */
  onDockShortcut: (callback: (payload: { key: string; alt: boolean; shift: boolean }) => void): Unsubscribe => {
    const listener = (_event: unknown, payload: { key: string; alt: boolean; shift: boolean }) => callback(payload)
    ipcRenderer.on("dock:shortcut", listener)
    return () => ipcRenderer.removeListener("dock:shortcut", listener)
  },
  versions: {
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
  },
}

contextBridge.exposeInMainWorld("openorch", api)

export type OpenOrchBridge = typeof api
