import { ErrorBoundary, For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { Composer } from "./components/Composer"
import { ConfirmDialog } from "./components/ConfirmDialog"
import { Dock, DockFloats } from "./components/Dock"
import { MessageView } from "./components/MessageParts"
import { PermissionDock, QuestionDock } from "./components/Docks"
import { Settings } from "./components/Settings"
import { ScheduleDialog } from "./components/ScheduleDialog"
import { PanelIcon, Sidebar } from "./components/Sidebar"
import { SkillDialog } from "./components/SkillDialog"
import { WorkspacePicker } from "./components/WorkspacePicker"
import { Icon } from "./components/Icons"
import { api } from "./api"
import { t } from "./i18n"
import { createDockBrowser, createDockTerminal } from "./dock-tools"
import {
  activeBusy,
  activeMessages,
  activePermissions,
  activeQuestions,
  activeSession,
  activateDockTab,
  clearError,
  closeDockTab,
  floatDockTab,
  initEvents,
  loadInitial,
  openSchedule,
  openScheduledSession,
  setDockDrag,
  splitDockPane,
  state,
  toggleDockWide,
  toggleSettings,
  toggleSidebar,
  toggleTerminal,
} from "./store"
import { resolvedThemeID, watchSystemTheme } from "./themes"

export function App() {
  let timeline: HTMLDivElement | undefined
  const [atBottom, setAtBottom] = createSignal(true)
  const [floatHint, setFloatHint] = createSignal(false)

  onMount(() => {
    initEvents()
    watchSystemTheme()
    void loadInitial()
    // A preview page called window.open, or the agent opened a tab: show it in the dock.
    const stopBrowserTabs = window.openorch.onBrowserOpenTab(({ id, url }) => {
      if (!state.workspace) return
      toggleTerminal(true)
      createDockBrowser({ id, url })
    })
    onCleanup(stopBrowserTabs)
    // The agent closed a dock browser tab.
    const stopBrowserClose = window.openorch.onBrowserCloseTab(({ id }) => {
      closeDockTab(id)
    })
    onCleanup(stopBrowserClose)
    // The agent focused a dock browser tab.
    const stopBrowserFocus = window.openorch.onBrowserFocusTab(({ id }) => {
      if (!state.workspace) return
      toggleTerminal(true)
      activateDockTab(id)
    })
    onCleanup(stopBrowserFocus)
    // Scheduled task notifications open the task window or the run's chat.
    const stopScheduleOpen = window.openorch.onScheduleOpen(({ taskID }) => openSchedule(taskID))
    onCleanup(stopScheduleOpen)
    const stopSessionOpen = window.openorch.onOpenSession(({ sessionID, directory }) => {
      void openScheduledSession(directory, sessionID)
    })
    onCleanup(stopSessionOpen)
    // Shortcuts pressed while a preview guest has focus (routed by the main process).
    const stopDockShortcut = window.openorch.onDockShortcut(({ key, alt, shift }) => {
      runDockShortcut(key, alt, shift)
    })
    onCleanup(stopDockShortcut)
  })

  // The main process only forwards transcript deltas for the session on screen.
  createEffect(() => {
    void api.watchSession(state.activeSessionID).catch(() => undefined)
  })

  // Auto-scroll to bottom while streaming, unless the user scrolled up.
  createEffect(() => {
    const messages = activeMessages()
    const busy = activeBusy()
    void messages.length
    void busy
    if (!timeline) return
    if (!atBottom()) return
    // Two frames: the first renders the new rows, the second scrolls past them.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!timeline || !atBottom()) return
        timeline.scrollTop = timeline.scrollHeight
      })
    })
  })

  const onScroll = () => {
    if (!timeline) return
    const near = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 80
    setAtBottom(near)
  }

  const jumpToBottom = () => {
    if (!timeline) return
    timeline.scrollTop = timeline.scrollHeight
    setAtBottom(true)
  }

  // Theme
  createEffect(() => {
    document.documentElement.dataset.theme = resolvedThemeID()
  })

  // While a tab or the dock chrome is dragged, webviews must not swallow the pointer.
  createEffect(() => {
    document.documentElement.toggleAttribute("data-dock-drag", Boolean(state.dockDrag) || state.dockPointer)
  })
  onCleanup(() => document.documentElement.removeAttribute("data-dock-drag"))

  // Dock shortcuts, shared by the window handler and guests' forwarded keys (DSH rule).
  const runDockShortcut = (key: string, alt: boolean, shift: boolean): boolean => {
    const lower = key.toLowerCase()
    if (lower === "b" && !alt && !shift) {
      toggleTerminal()
      return true
    }
    if (lower === "t" && !alt && !shift) {
      if (!state.workspace) return false
      toggleTerminal(true)
      createDockBrowser({ replaceGuide: false })
      return true
    }
    if (key === "`" && !alt) {
      if (!state.workspace) return false
      toggleTerminal(true)
      void createDockTerminal({ replaceGuide: true })
      return true
    }
    if (key === "\\" && !alt) {
      if (!state.terminalOpen) return false
      splitDockPane()
      return true
    }
    if (key === "Enter" && alt) {
      if (!state.terminalOpen) return false
      toggleDockWide()
      return true
    }
    if (lower === "w" && !alt && !shift) {
      const pane = state.dock.panes.find((entry) => entry.id === state.dock.activePaneID) ?? state.dock.panes[0]
      const tabID = pane?.activeTabID
      if (!tabID) return false
      closeDockTab(tabID)
      return true
    }
    return false
  }

  // Global shortcuts (DSH bindings kept where OpenOrch has no conflict: Ctrl+B toggles the dock).
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "," && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      toggleSettings()
    }
    if (event.key === "n" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      void import("./store").then((store) => {
        if (store.state.workspace) void store.createSession()
      })
    }
    if ((event.key === "l" || event.key === "L") && (event.ctrlKey || event.metaKey) && state.terminalOpen) {
      // let the terminal keep its own shortcuts when focused
    }
    if (event.key === ">" && event.ctrlKey && event.shiftKey) {
      event.preventDefault()
      void import("./store").then(({ cycleModelVariant }) => cycleModelVariant())
      return
    }
    if (!(event.ctrlKey || event.metaKey)) return
    if (runDockShortcut(event.key, event.altKey, event.shiftKey)) event.preventDefault()
  }
  onMount(() => window.addEventListener("keydown", onKeyDown))
  onCleanup(() => window.removeEventListener("keydown", onKeyDown))

  const hasMessages = createMemo(() => activeMessages().length > 0)

  return (
    <>
      <Show when={state.workspace} fallback={<WorkspacePicker />}>
        <div class={`app${state.sidebarOpen ? "" : " no-sidebar"}${state.terminalOpen ? " terminal-open" : ""}`}>
          <Sidebar />
      <main class="main">
        <div class="main-header">
          <Show when={!state.sidebarOpen}>
            <button class="icon-button" title={t("app.showSidebar")} onClick={() => toggleSidebar(true)}>
              <PanelIcon />
            </button>
          </Show>
          <span class="session-title">{activeSession()?.title || t("app.newSession")}</span>
          <span class="spacer" />
          <Show when={activeSession()?.directory}>
            <span class="header-chip" title={activeSession()?.directory}>
              {worktreeLabel(activeSession()?.directory ?? "") ?? activeSession()?.directory?.split(/[\\/]/).filter(Boolean).slice(-2).join("/")}
            </span>
          </Show>
          <Show when={activeBusy()}>
            <span class="header-chip" style={{ color: "var(--warning)" }}>
              <span class="spinner" /> {t("app.working")}
            </span>
          </Show>
          <button
            class="header-chip"
            title={t("session.compact")}
            onClick={() => void import("./store").then(({ runCommand }) => runCommand("/compact"))}
          >
            ⌁ {t("session.compact")}
          </button>
          <button
            class={`icon-button terminal-toggle${state.terminalOpen ? " active" : ""}`}
            title={t("app.terminal")}
            onClick={() => toggleTerminal()}
          >
            <PanelIcon flip />
          </button>
        </div>

        <Show when={state.error}>
          <div class="banner-error">
            <span>⚠</span>
            <span style={{ flex: 1 }}>{state.error}</span>
            <button class="icon-button" onClick={() => clearError()}>
              ✕
            </button>
          </div>
        </Show>

        <div
          class="timeline-wrap"
          onDragOver={(event) => {
            if (!state.dockDrag || !event.dataTransfer) return
            event.preventDefault()
            event.dataTransfer.dropEffect = "move"
            setFloatHint(true)
          }}
          onDragLeave={(event) => {
            const related = event.relatedTarget as Node | null
            if (related && (event.currentTarget as HTMLElement).contains(related)) return
            setFloatHint(false)
          }}
          onDrop={(event) => {
            if (!state.dockDrag) return
            event.preventDefault()
            const w = 520
            const h = 360
            floatDockTab(state.dockDrag.tabID, {
              x: Math.min(Math.max(8, event.clientX - 100), Math.max(8, window.innerWidth - w - 8)),
              y: Math.min(Math.max(8, event.clientY - 24), Math.max(8, window.innerHeight - h - 8)),
              w,
              h,
            })
            setDockDrag(undefined)
            setFloatHint(false)
          }}
        >
          <div class="timeline" ref={timeline} onScroll={onScroll}>
            <Show
              when={hasMessages()}
              fallback={<div class="empty-state">{activeSession() ? t("session.empty") : t("app.noSessions")}</div>}
            >
              <div class="timeline-inner">
                <For each={activeMessages()}>
                  {(message, index) => (
                    <ErrorBoundary fallback={() => <div class="message-error">{t("app.messageError")}</div>}>
                      <MessageView
                        message={message}
                        showFooter={message.role === "assistant" ? isLastOfRun(activeMessages(), index()) : undefined}
                      />
                    </ErrorBoundary>
                  )}
                </For>
              </div>
            </Show>
          </div>
          {/* Docks (permissions/questions) only take space while something is pending:
              otherwise the timeline must reach the composer's edge, not stop short. */}
          <Show when={activePermissions().length > 0 || activeQuestions().length > 0}>
            <div style={{ padding: "0 24px" }}>
              <div style={{ "max-width": "860px", margin: "0 auto", display: "flex", "flex-direction": "column", gap: "10px", "padding-bottom": "10px" }}>
                <PermissionDock />
                <QuestionDock />
              </div>
            </div>
          </Show>
          <Show when={hasMessages() && !atBottom()}>
            <button class="jump-bottom" title={t("app.jumpBottom")} onClick={jumpToBottom}>
              ↓
            </button>
          </Show>
          <Show when={Boolean(state.dockDrag) && floatHint()}>
            <div class="dock-float-hint">
              <Icon name="columns" size={18} />
              <span>{t("dock.drop.float")}</span>
            </div>
          </Show>
          <Composer />
        </div>
      </main>
      <Dock />
      <DockFloats />
        </div>
      </Show>
      <Settings />
      <ScheduleDialog />
      <ConfirmDialog />
      <SkillDialog />
    </>
  )
}

function isLastOfRun(messages: { role: string }[], index: number): boolean {
  const next = messages[index + 1]
  return !next || next.role !== "assistant"
}

/** Shows a "worktree: <name>" label when the session lives inside a managed worktree. */
function worktreeLabel(directory: string): string | undefined {
  const normalized = directory.replaceAll("\\", "/")
  const marker = "/.openorch/worktrees/"
  const index = normalized.indexOf(marker)
  if (index === -1) return undefined
  const name = normalized.slice(index + marker.length).split("/")[0]
  return name ? `worktree: ${name}` : undefined
}
