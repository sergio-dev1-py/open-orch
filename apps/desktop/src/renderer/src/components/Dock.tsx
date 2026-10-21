import { For, Show, createEffect, createSignal, onCleanup } from "solid-js"
import { t } from "../i18n"
import {
  activateDockTab,
  closeDockTab,
  dockFloatTab,
  dropDockTab,
  moveFloat,
  openDockTab,
  resizeFloat,
  setDockDrag,
  setDockPointer,
  setDockRatio,
  splitDockPane,
  state,
  toggleDockWide,
  toggleTerminal,
  totalDockTabs,
  type DockPane,
  type DockTab,
} from "../store"
import { createDockTerminal } from "../dock-tools"
import { BrowserTab } from "./BrowserTab"
import { DockGuide } from "./DockGuide"
import { TerminalInstance, shellIcon } from "./TerminalPanel"
import { Icon } from "./Icons"

const TERMINAL_WIDTH_KEY = "openorch.terminal.width"

/** DSH rule: the panel never reaches the edge — 20–80% of the window (min. 320px). */
function clampWidth(value: number): number {
  const max = Math.max(320, Math.floor(window.innerWidth * 0.8))
  return Math.max(320, Math.min(value, max))
}

/** Chip glyph per tab kind (guide star, per-shell terminal glyph, browser globe). */
function TabIcon(props: { tab: DockTab }) {
  return (
    <Show
      when={props.tab.kind !== "terminal"}
      fallback={<span class="dock-tab-icon">{shellIcon(props.tab.shellID ?? "")}</span>}
    >
      <span class="dock-tab-icon">
        <Icon name={props.tab.kind === "browser" ? "globe" : "skill"} size={13} />
      </span>
    </Show>
  )
}

/** Shared body renderer for docked panes and floating panels (keepMounted). */
function TabBody(props: {
  tab: DockTab
  paneID?: string
  active: boolean
  focused: boolean
  visible: boolean
  onCopied?: () => void
}) {
  return (
    <Show
      when={props.tab.kind !== "terminal"}
      fallback={
        <TerminalInstance
          entry={{
            key: props.tab.id,
            shellID: props.tab.shellID ?? "",
            shellName: props.tab.title,
            sessionID: props.tab.sessionID ?? "",
            cwd: props.tab.cwd ?? "",
          }}
          active={props.active}
          focused={props.focused}
          visible={props.visible}
          onCopied={props.onCopied}
        />
      }
    >
      <Show when={props.tab.kind === "guide"} fallback={<BrowserTab tab={props.tab} active={props.active} />}>
        <DockGuide paneID={props.paneID} />
      </Show>
    </Show>
  )
}

/**
 * Right dock (DSH-style): one strip per pane (tabs → add → split → panel
 * controls), max. two panes with a 20–80% divider, drag & drop between panes
 * and into the chat to float. Width/resize/wide mode behave like the old
 * terminal panel, so `.terminal-panel` selectors keep working.
 */
export function Dock() {
  const [width, setWidth] = createSignal(clampWidth(Number(localStorage.getItem(TERMINAL_WIDTH_KEY)) || 420))
  const [toast, setToast] = createSignal("")
  const [dropZone, setDropZone] = createSignal<{ paneID: string; zone: "left" | "right" | "center" } | undefined>()
  let panesEl: HTMLDivElement | undefined
  let openedOnce = false
  let toastTimer: number | undefined
  let resizeStart: { x: number; width: number } | undefined
  let splitStart: { x: number; ratio: number } | undefined

  const showToast = (text: string) => {
    setToast(text)
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = window.setTimeout(() => setToast(""), 1400)
  }

  // Drag the left edge to resize; the width is remembered between launches.
  // The drag starts from the rendered width: flex may have shrunk the panel.
  const onResizeDown = (event: PointerEvent) => {
    const panel = (event.currentTarget as HTMLElement).parentElement
    resizeStart = { x: event.clientX, width: panel?.getBoundingClientRect().width ?? width() }
    setDockWideSafe(false)
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
    event.preventDefault()
  }
  const onResizeMove = (event: PointerEvent) => {
    if (!resizeStart) return
    setWidth(clampWidth(resizeStart.width - (event.clientX - resizeStart.x)))
  }
  const onResizeUp = () => {
    if (!resizeStart) return
    resizeStart = undefined
    try {
      localStorage.setItem(TERMINAL_WIDTH_KEY, String(width()))
    } catch {
      // localStorage unavailable: keep the in-memory width only.
    }
  }
  const setDockWideSafe = (wide: boolean) => {
    if (state.dockWide !== wide) toggleDockWide()
  }

  // Divider drag: ratio clamped to 20%–80% (persisted with the layout).
  const onSplitDown = (event: PointerEvent) => {
    splitStart = { x: event.clientX, ratio: state.dock.ratio }
    setDockPointer(true)
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
    event.preventDefault()
  }
  const onSplitMove = (event: PointerEvent) => {
    if (!splitStart || !panesEl) return
    const rect = panesEl.getBoundingClientRect()
    if (rect.width <= 0) return
    setDockRatio(splitStart.ratio + (event.clientX - splitStart.x) / rect.width)
  }
  const onSplitUp = () => {
    if (!splitStart) return
    splitStart = undefined
    setDockPointer(false)
  }

  // Opening the panel: always start in normal mode (it pushes the columns with its
  // remembered width); very narrow windows open fullscreen like DSH. A terminal is
  // created when the layout is empty; existing tabs persist.
  createEffect(() => {
    const open = state.terminalOpen
    if (!open) {
      openedOnce = false
      return
    }
    if (openedOnce) return
    openedOnce = true
    const narrow = window.innerWidth < 768
    if (state.dockWide !== narrow) toggleDockWide()
    if (totalDockTabs() === 0) void createDockTerminal({ replaceGuide: false })
  })

  onCleanup(() => {
    if (toastTimer) clearTimeout(toastTimer)
  })

  const visiblePanes = (): DockPane[] =>
    state.dock.panes.length > 0 ? state.dock.panes : [{ id: "", tabs: [], activeTabID: undefined }]

  const onTabDragStart = (event: DragEvent, tabID: string) => {
    if (!event.dataTransfer) return
    event.dataTransfer.setData("text/plain", tabID)
    event.dataTransfer.effectAllowed = "move"
    setDockDrag({ tabID })
  }
  const onTabDragEnd = () => setDockDrag(undefined)

  const paneDragOver = (event: DragEvent, pane: DockPane) => {
    if (!state.dockDrag || !event.dataTransfer) return
    event.preventDefault()
    event.dataTransfer.dropEffect = "move"
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
    const x = (event.clientX - rect.left) / Math.max(1, rect.width)
    let zone: "left" | "right" | "center" = x < 0.3 ? "left" : x > 0.7 ? "right" : "center"
    // With two panes there is no room for a third: edge drops simply move the tab.
    if (state.dock.panes.length >= 2) zone = "center"
    setDropZone({ paneID: pane.id, zone })
  }
  const paneDragLeave = (event: DragEvent, pane: DockPane) => {
    const related = event.relatedTarget as Node | null
    if (related && (event.currentTarget as HTMLElement).contains(related)) return
    if (dropZone()?.paneID === pane.id) setDropZone(undefined)
  }
  const paneDrop = (event: DragEvent, pane: DockPane) => {
    if (!state.dockDrag) return
    event.preventDefault()
    const zone = dropZone()?.paneID === pane.id ? (dropZone()?.zone ?? "center") : "center"
    dropDockTab(state.dockDrag.tabID, pane.id, zone)
    setDropZone(undefined)
    setDockDrag(undefined)
  }

  return (
    <div
      class={`terminal-panel dock-panel${state.terminalOpen ? "" : " hidden"}${state.dockWide ? " wide" : ""}`}
      style={state.dockWide ? undefined : { width: `${width()}px` }}
    >
      <Show when={!state.dockWide}>
        <div
          class="terminal-resize"
          title={t("terminal.resize")}
          onPointerDown={onResizeDown}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeUp}
          onPointerCancel={onResizeUp}
        />
      </Show>
      <div
        class={`dock-panes${state.dock.panes.length === 2 ? " two" : ""}`}
        ref={panesEl}
        style={state.dock.panes.length === 2 ? { "grid-template-columns": `${state.dock.ratio * 100}% 1fr` } : undefined}
      >
        <For each={visiblePanes()}>
          {(pane, index) => (
            <div
              class="dock-pane"
              data-pane={pane.id}
              onDragOver={(event) => paneDragOver(event, pane)}
              onDragLeave={(event) => paneDragLeave(event, pane)}
              onDrop={(event) => paneDrop(event, pane)}
              onPointerDown={() => {
                if (pane.activeTabID) activateDockTab(pane.activeTabID)
              }}
            >
              <div class="dock-strip">
                <div class="dock-tabs">
                  <For each={pane.tabs}>
                    {(tab) => (
                      <div
                        class={`dock-tab${pane.activeTabID === tab.id ? " active" : ""}${state.dockDrag?.tabID === tab.id ? " dragging" : ""}`}
                        title={tab.kind === "terminal" && tab.cwd ? `${tab.title} · ${tab.cwd}` : tab.kind === "guide" ? t("dock.guide") : tab.title}
                        draggable="true"
                        onDragStart={(event) => onTabDragStart(event, tab.id)}
                        onDragEnd={onTabDragEnd}
                        onClick={() => activateDockTab(tab.id)}
                      >
                        <TabIcon tab={tab} />
                        <span class="dock-tab-title">{tab.kind === "guide" ? t("dock.guide") : tab.title}</span>
                        <button
                          class="icon-button dock-tab-close"
                          title={t("dock.close")}
                          onClick={(event) => {
                            event.stopPropagation()
                            closeDockTab(tab.id)
                          }}
                        >
                          ✕
                        </button>
                      </div>
                    )}
                  </For>
                </div>
                <Show when={!pane.tabs.some((tab) => tab.kind === "guide")}>
                  <button
                    class="icon-button dock-add"
                    title={t("dock.add")}
                    onClick={() => openDockTab("guide", {}, { paneID: pane.id })}
                  >
                    <Icon name="plus" size={13} />
                  </button>
                </Show>
                <button
                  class="icon-button dock-split"
                  title={t("dock.split")}
                  disabled={state.dock.panes.length >= 2}
                  onClick={() => splitDockPane(pane.id)}
                >
                  <Icon name="split" size={13} />
                </button>
                <Show when={index() === visiblePanes().length - 1}>
                  <button
                    class="icon-button"
                    title={state.dockWide ? t("terminal.restore") : t("terminal.maximize")}
                    onClick={() => toggleDockWide()}
                  >
                    {state.dockWide ? "⤡" : "⛶"}
                  </button>
                  <button class="icon-button" title={t("terminal.hide")} onClick={() => toggleTerminal(false)}>
                    ✕
                  </button>
                </Show>
              </div>
              <div class="dock-pane-body">
                <For each={pane.tabs}>
                  {(tab) => (
                    <div class={`dock-tab-body${pane.activeTabID === tab.id ? " active" : ""}`}>
                      <TabBody
                        tab={tab}
                        paneID={pane.id}
                        active={pane.activeTabID === tab.id}
                        focused={pane.activeTabID === tab.id && pane.id === state.dock.activePaneID}
                        visible={state.terminalOpen}
                        onCopied={() => showToast(t("terminal.copied"))}
                      />
                    </div>
                  )}
                </For>
                <Show when={pane.tabs.length === 0}>
                  <div class="dock-empty">{t("dock.empty")}</div>
                </Show>
                <Show when={Boolean(state.dockDrag) && dropZone()?.paneID === pane.id}>
                  <div class={`dock-drop-hint zone-${dropZone()?.zone ?? "center"}`}>
                    <Icon name={dropZone()?.zone === "center" ? "columns" : "split"} size={16} />
                    <span>{dropZone()?.zone === "center" ? t("dock.drop.move") : t("dock.drop.split")}</span>
                  </div>
                </Show>
              </div>
            </div>
          )}
        </For>
        <Show when={state.dock.panes.length === 2}>
          <div
            class="dock-divider"
            style={{ left: `calc(${state.dock.ratio * 100}% - 3px)` }}
            title={t("dock.split")}
            onPointerDown={onSplitDown}
            onPointerMove={onSplitMove}
            onPointerUp={onSplitUp}
            onPointerCancel={onSplitUp}
          />
        </Show>
      </div>
      <Show when={toast()}>
        <div class="terminal-toast">{toast()}</div>
      </Show>
    </div>
  )
}

/**
 * In-window floating panels (Option A): one tab per float, moved by its header
 * and resized by its corner; a columns button re-inserts it into the dock.
 * Rendered at the app root so floats can cover the chat.
 */
export function DockFloats() {
  const [drag, setDrag] = createSignal<{ tabID: string; x: number; y: number } | undefined>()
  const [resize, setResize] = createSignal<{ tabID: string; w: number; h: number } | undefined>()

  const position = (float: { tab: DockTab; x: number; y: number; w: number; h: number }) =>
    drag()?.tabID === float.tab.id ? { x: drag()!.x, y: drag()!.y } : { x: float.x, y: float.y }
  const size = (float: { tab: DockTab; x: number; y: number; w: number; h: number }) =>
    resize()?.tabID === float.tab.id ? { w: resize()!.w, h: resize()!.h } : { w: float.w, h: float.h }

  const startMove = (event: PointerEvent, float: { tab: DockTab; x: number; y: number; w: number; h: number }) => {
    if (event.button !== 0) return
    // Header buttons (re-dock/close) keep their own clicks.
    if ((event.target as HTMLElement | null)?.closest("button")) return
    const target = event.currentTarget as HTMLElement
    target.setPointerCapture(event.pointerId)
    setDockPointer(true)
    const origin = { px: event.clientX, py: event.clientY, x: float.x, y: float.y }
    setDrag({ tabID: float.tab.id, x: float.x, y: float.y })
    const move = (moveEvent: PointerEvent) => {
      const w = size(float).w
      const h = size(float).h
      setDrag({
        tabID: float.tab.id,
        x: Math.min(Math.max(0, origin.x + moveEvent.clientX - origin.px), Math.max(0, window.innerWidth - w)),
        y: Math.min(Math.max(0, origin.y + moveEvent.clientY - origin.py), Math.max(0, window.innerHeight - 48)),
      })
    }
    const up = () => {
      target.removeEventListener("pointermove", move)
      target.removeEventListener("pointerup", up)
      target.removeEventListener("pointercancel", up)
      const final = drag()
      if (final && final.tabID === float.tab.id) moveFloat(final.tabID, final.x, final.y)
      setDrag(undefined)
      setDockPointer(false)
    }
    target.addEventListener("pointermove", move)
    target.addEventListener("pointerup", up)
    target.addEventListener("pointercancel", up)
    event.preventDefault()
  }

  const startResize = (event: PointerEvent, float: { tab: DockTab; x: number; y: number; w: number; h: number }) => {
    if (event.button !== 0) return
    const target = event.currentTarget as HTMLElement
    target.setPointerCapture(event.pointerId)
    setDockPointer(true)
    const origin = { px: event.clientX, py: event.clientY, w: float.w, h: float.h }
    setResize({ tabID: float.tab.id, w: float.w, h: float.h })
    const move = (moveEvent: PointerEvent) => {
      setResize({
        tabID: float.tab.id,
        w: Math.max(280, Math.min(origin.w + moveEvent.clientX - origin.px, window.innerWidth - 8)),
        h: Math.max(180, Math.min(origin.h + moveEvent.clientY - origin.py, window.innerHeight - 8)),
      })
    }
    const up = () => {
      target.removeEventListener("pointermove", move)
      target.removeEventListener("pointerup", up)
      target.removeEventListener("pointercancel", up)
      const final = resize()
      if (final && final.tabID === float.tab.id) resizeFloat(final.tabID, { w: final.w, h: final.h })
      setResize(undefined)
      setDockPointer(false)
    }
    target.addEventListener("pointermove", move)
    target.addEventListener("pointerup", up)
    target.addEventListener("pointercancel", up)
    event.preventDefault()
  }

  return (
    <Show when={state.dock.floats.length > 0}>
      <For each={state.dock.floats}>
        {(float) => {
          const style = () => {
            const pos = position(float)
            const box = size(float)
            return { left: `${pos.x}px`, top: `${pos.y}px`, width: `${box.w}px`, height: `${box.h}px` }
          }
          return (
            <div class="dock-float" style={style()} data-float={float.tab.id}>
              <div class="dock-float-header" onPointerDown={(event) => startMove(event, float)}>
                <TabIcon tab={float.tab} />
                <span class="dock-float-title">{float.tab.kind === "guide" ? t("dock.guide") : float.tab.title}</span>
                <span style={{ flex: 1 }} />
                <button class="icon-button" title={t("dock.dock")} onClick={() => dockFloatTab(float.tab.id)}>
                  <Icon name="columns" size={13} />
                </button>
                <button class="icon-button" title={t("dock.close")} onClick={() => closeDockTab(float.tab.id)}>
                  ✕
                </button>
              </div>
              <div class="dock-float-body">
                <TabBody tab={float.tab} active focused={false} visible />
              </div>
              <div class="dock-float-resize" title={t("dock.resize")} onPointerDown={(event) => startResize(event, float)} />
            </div>
          )
        }}
      </For>
    </Show>
  )
}
