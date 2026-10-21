/**
 * Minimal preload for dock browser guests (DSH's "approved guest" lease).
 *
 * Webview guests are sandboxed, and sandboxed preloads must be CommonJS, so this
 * file is emitted verbatim into out/preload/guest.cjs by electron.vite.config.ts.
 * It only forwards dock shortcut keys to the main process (which routes them to
 * the app window) and never exposes Node or Electron APIs to the visited page.
 */
const { ipcRenderer } = require("electron")

const DOCK_KEYS = ["t", "T", "w", "W", "b", "B", "`", "\\"]

window.addEventListener(
  "keydown",
  (event) => {
    if (!event.ctrlKey || event.metaKey) return
    if (!DOCK_KEYS.includes(event.key)) return
    ipcRenderer.send("openorch:guest-dock-shortcut", { key: event.key, alt: event.altKey, shift: event.shiftKey })
  },
  true,
)
