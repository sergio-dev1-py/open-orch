import { createSignal } from "solid-js"
import { api } from "./api"
import { t } from "./i18n"
import { activeSession, openDockTab, refreshConfig, state } from "./store"

/**
 * Shared dock helpers (used by the panel, the guide and the floats):
 * shell discovery/creation and browser tab creation.
 */

const [shells, setShells] = createSignal<{ id: string; name: string }[]>([])
let shellsLoaded = false
let shellsPromise: Promise<void> | undefined

/** Lazy shell discovery: runs once per renderer, reused by the guide menu. */
export function dockShells() {
  if (!shellsLoaded) {
    shellsLoaded = true
    shellsPromise = api
      .terminal.shells()
      .then((list) => {
        setShells(list)
      })
      .catch(() => {
        setShells([])
      })
  }
  return shells
}

export function shellName(id: string): string {
  return shells().find((shell) => shell.id === id)?.name ?? id
}

/** The shell a new terminal opens with (config wins, then discovery). */
export function preferredShell(): string {
  return state.config?.terminal?.shell || shells()[0]?.id || ""
}

/** Remembers the shell chosen from the guide's caret menu. */
export async function pickDockShell(id: string): Promise<void> {
  await api.setConfig({ terminal: { shell: id } }).catch(() => undefined)
  await refreshConfig().catch(() => undefined)
}

/** Creates a terminal tab in a pane (cwd/session captured at creation time). */
export async function createDockTerminal(options: { paneID?: string; shellID?: string; replaceGuide?: boolean } = {}): Promise<void> {
  const sessionID = activeSession()?.id
  if (!sessionID) return
  dockShells()
  await shellsPromise?.catch(() => undefined)
  const id = options.shellID || preferredShell()
  const cwd = await api.sessionDirectory(sessionID).catch(() => "")
  openDockTab(
    "terminal",
    { shellID: id, title: shellName(id), sessionID, cwd },
    { paneID: options.paneID, replaceGuide: options.replaceGuide ?? false },
  )
}

/** Creates a browser tab (partition follows the workspace so cookies persist). */
export function createDockBrowser(options: { paneID?: string; url?: string; id?: string; replaceGuide?: boolean } = {}): void {
  const partitionKey = (state.workspace ?? "session").replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80)
  openDockTab(
    "browser",
    {
      id: options.id,
      url: options.url,
      partition: `persist:openorch-web-${partitionKey}`,
      title: options.url ? hostOf(options.url) : t("browser.title"),
    },
    { paneID: options.paneID, replaceGuide: options.replaceGuide ?? false },
  )
}

/** `https://a.b/c` → `a.b` (used for the tab chip title). */
export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return t("browser.title")
  }
}
