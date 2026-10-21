import { For, Show, createMemo, createSignal } from "solid-js"
import type { SessionInfo } from "@openorch/shared"
import { api } from "../api"
import { t } from "../i18n"
import { enterWorkspace, state, toggleSettings } from "../store"
import { Icon } from "./Icons"

function basename(directory: string): string {
  const parts = directory.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? directory
}

function relativeTime(timestamp: number): string {
  const minutes = Math.floor((Date.now() - timestamp) / 60000)
  if (minutes < 1) return "ahora"
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

interface WorkspaceEntry {
  directory: string
  sessions: SessionInfo[]
  last?: number
}

export function WorkspacePicker() {
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal("")
  const [dragActive, setDragActive] = createSignal(false)

  // Recent workspaces (config) plus every directory that already has sessions.
  const entries = createMemo<WorkspaceEntry[]>(() => {
    const map = new Map<string, WorkspaceEntry>()
    const hidden = new Set(state.config?.hiddenDirectories ?? [])
    const add = (directory?: string) => {
      if (!directory || hidden.has(directory) || map.has(directory)) return
      map.set(directory, { directory, sessions: [] })
    }
    for (const directory of state.config?.recentDirectories ?? []) add(directory)
    add(state.config?.lastDirectory)
    for (const session of state.sessions) {
      if (session.parentID) continue
      add(session.directory)
      const entry = map.get(session.directory)
      if (!entry) continue
      entry.sessions.push(session)
      entry.last = Math.max(entry.last ?? 0, session.time.updated)
    }
    return [...map.values()].sort((a, b) => (b.last ?? 0) - (a.last ?? 0) || a.directory.localeCompare(b.directory))
  })

  const open = async (directory: string) => {
    setBusy(true)
    setError("")
    try {
      await enterWorkspace(directory)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }

  const pickFolder = async () => {
    setError("")
    const directory = await api.pickDirectory()
    if (!directory) return
    await open(directory)
  }

  // Drag & drop: dropping a folder opens it as a workspace (like the native picker).
  const onDragOver = (event: DragEvent) => {
    if (!event.dataTransfer?.types.includes("Files")) return
    event.preventDefault()
    event.dataTransfer.dropEffect = "copy"
    setDragActive(true)
  }

  const onDragLeave = (event: DragEvent) => {
    if (event.currentTarget === event.target) setDragActive(false)
  }

  const onDrop = async (event: DragEvent) => {
    event.preventDefault()
    setDragActive(false)
    setError("")
    const dropped = [...(event.dataTransfer?.files ?? [])][0]
    if (!dropped) return
    const target = window.openorch.pathForFile(dropped)
    if (!target || !(await api.isDirectory(target).catch(() => false))) {
      setError(t("workspace.dropFile"))
      return
    }
    await open(target)
  }

  return (
    <div
      class={`workspace-screen${dragActive() ? " dragging" : ""}`}
      onDragOver={onDragOver}
      onDragEnter={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={(event) => void onDrop(event)}
    >
      <Show when={dragActive()}>
        <div class="workspace-drop-overlay">
          <div class="workspace-drop-card">
            <Icon name="folder" size={16} /> {t("workspace.drop")}
          </div>
        </div>
      </Show>

      <div class="workspace-panel">
        <div class="workspace-brand">
          <span class="brand-logo">O</span>
          <div>
            <h1>OpenOrch</h1>
            <p>{t("workspace.subtitle")}</p>
          </div>
        </div>

        <Show when={entries().length > 0}>
          <div class="workspace-section-title">{t("workspace.recents")}</div>
          <div class="workspace-list">
            <For each={entries()}>
              {(entry) => (
                <button class="workspace-row" disabled={busy()} onClick={() => void open(entry.directory)}>
                  <span class="workspace-folder"><Icon name="folder" size={15} /></span>
                  <span class="workspace-info">
                    <span class="workspace-name">{basename(entry.directory)}</span>
                    <span class="workspace-path">{entry.directory}</span>
                  </span>
                  <span class="workspace-meta">
                    <span>
                      {entry.sessions.length} {t("workspace.sessions")}
                    </span>
                    <Show when={entry.last}>
                      <span>· {relativeTime(entry.last ?? 0)}</span>
                    </Show>
                  </span>
                </button>
              )}
            </For>
          </div>
        </Show>

        <Show when={entries().length === 0}>
          <div class="workspace-empty">{t("workspace.empty")}</div>
        </Show>

        <Show when={error()}>
          <div class="workspace-error">⚠ {error()}</div>
        </Show>

        <button class="workspace-open" disabled={busy()} onClick={() => void pickFolder()}>
          <Icon name="plus" size={14} /> {t("workspace.openFolder")}
        </button>
        <div class="workspace-hint">{t("workspace.hintDrop")}</div>
      </div>

      <button class="workspace-settings" onClick={() => toggleSettings(true)}>
        <Icon name="gear" size={14} /> {t("app.settings")}
      </button>
    </div>
  )
}
