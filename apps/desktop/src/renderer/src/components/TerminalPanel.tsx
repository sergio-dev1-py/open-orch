import { Show, createEffect, createSignal, onCleanup, onMount } from "solid-js"
import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import "@xterm/xterm/css/xterm.css"
import { api } from "../api"
import { t } from "../i18n"
import { currentTheme } from "../themes"
import { Icon } from "./Icons"

export interface TerminalEntry {
  key: string
  shellID: string
  shellName: string
  sessionID: string
  cwd: string
}

export interface InstanceHandle {
  kill: () => void
}

/** Tiny per-shell glyph shown on a terminal's dock tab. */
export function shellIcon(shellID: string) {
  if (shellID.startsWith("wsl")) return <Icon name="penguin" size={13} />
  if (shellID === "cmd") return "C:"
  if (shellID === "git-bash") return "$"
  return ">_"
}

/**
 * One xterm.js screen bound to its own PTY.
 * `active` = the tab is visible (gates fitting); `focused` = the pane the user
 * last clicked (gates stealing the keyboard focus with two panes side by side).
 */
export function TerminalInstance(props: {
  entry: TerminalEntry
  active: boolean
  focused: boolean
  visible: boolean
  onRegister?: (handle: InstanceHandle) => void
  onUnregister?: () => void
  onCopied?: () => void
}) {
  let container: HTMLDivElement | undefined
  let root: HTMLDivElement | undefined
  let term: Terminal | undefined
  let fit: FitAddon | undefined
  let ptyID: string | undefined
  const [error, setError] = createSignal("")
  const cleanups: (() => void)[] = []

  /** Selection-aware copy: Ctrl+C copies when text is selected, never interrupts. */
  const copySelection = () => {
    const selection = term?.getSelection()
    if (!selection) return false
    window.openorch.clipboard.writeText(selection)
    props.onCopied?.()
    return true
  }

  onMount(() => {
    if (!container) return
    term = new Terminal({
      fontFamily: "var(--font-mono)",
      fontSize: 12.5,
      theme: currentTheme().terminal,
      cursorBlink: true,
      convertEol: true,
    })
    fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)
    // Test hook (e2e reads/selects through this).
    ;(root as unknown as { __term?: Terminal }).__term = term
    fit.fit()

    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true
      const lower = event.key.toLowerCase()
      // Ctrl+Shift+C / Ctrl+Insert always copy; Ctrl+C copies only with a selection.
      const copyChord =
        ((event.ctrlKey || event.metaKey) && event.shiftKey && lower === "c") || (event.ctrlKey && event.key === "Insert")
      if (copyChord && copySelection()) return false
      const interrupt = (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && lower === "c"
      if (interrupt && copySelection()) return false
      // Dock shortcuts win over terminal control keys (DSH: regions include "terminal"):
      // returning false leaves the event untouched so it bubbles to the window handler.
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && ["t", "w", "b", "`", "\\"].includes(lower)) return false
      if ((event.ctrlKey || event.metaKey) && event.altKey && event.key === "Enter") return false
      return true
    })
    term.element?.addEventListener("contextmenu", (event) => {
      event.preventDefault()
      if (copySelection()) return
      void window.openorch.clipboard.readText().then((text) => {
        if (text) term?.paste(text)
      })
    })
    term.onData((data) => {
      if (ptyID) void api.terminal.write(ptyID, data)
    })
    cleanups.push(
      window.openorch.onTerminalData((payload) => {
        if (payload.id === ptyID) term?.write(payload.data)
      }),
      window.openorch.onTerminalExit((payload) => {
        if (payload.id === ptyID) {
          term?.write("\r\n[process exited]\r\n")
          ptyID = undefined
        }
      }),
    )
    const observer = new ResizeObserver(() => {
      // Hidden tabs (and a hidden panel) report a 0×0 box: never fit those.
      if (!props.active || !props.visible) return
      fit?.fit()
      if (ptyID && term) void api.terminal.resize(ptyID, term.cols, term.rows)
    })
    observer.observe(container)
    cleanups.push(() => observer.disconnect())
    container.addEventListener("mousedown", () => term?.focus())

    props.onRegister?.({
      kill: () => {
        if (ptyID) void api.terminal.close(ptyID)
        ptyID = undefined
      },
    })

    void api.terminal.open(props.entry.sessionID, term.cols, term.rows, props.entry.shellID).then((result) => {
      if (!result.id) {
        setError(result.error ?? t("terminal.error"))
        return
      }
      ptyID = result.id
      if (props.active && props.focused) term?.focus()
    })
  })

  // Refit whenever the tab becomes visible; only the focused pane takes the keyboard.
  createEffect(() => {
    if (!props.active || !props.visible) return
    fit?.fit()
    if (ptyID && term) void api.terminal.resize(ptyID, term.cols, term.rows)
    if (props.focused) term?.focus()
  })

  // Follow the app theme.
  createEffect(() => {
    const theme = currentTheme()
    if (term) term.options.theme = theme.terminal
  })

  onCleanup(() => {
    props.onUnregister?.()
    for (const cleanup of cleanups.splice(0)) cleanup()
    if (ptyID) void api.terminal.close(ptyID)
    term?.dispose()
  })

  return (
    <div class={`terminal-instance${props.active ? " active" : ""}`} ref={root}>
      <Show when={error()}>
        <div class="terminal-error">⚠ {error()}</div>
      </Show>
      <div class="terminal-surface" ref={container} />
    </div>
  )
}
