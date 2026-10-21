import { For, Show, createMemo, createSignal } from "solid-js"
import type { SessionInfo } from "@openorch/shared"
import { api } from "../api"
import { t } from "../i18n"
import { Icon } from "./Icons"
import {
  createSession,
  deleteSession,
  enterWorkspace,
  openSchedule,
  openSettingsTab,
  refreshConfig,
  removeWorkspace,
  requestConfirm,
  selectSession,
  sessionActivity,
  state,
  toggleSettings,
  toggleSidebar,
  workspaceActivity,
  workspaceGroups,
  type WorkspaceGroup,
} from "../store"

function relativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return "ahora"
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  return `${days}d`
}

function basename(directory: string): string {
  const parts = directory.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? directory
}

/** Panel glyph used to collapse/open the sidebar (also reused in the main header). */
export function PanelIcon(props: { flip?: boolean } = {}) {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.7"
      stroke-linecap="round"
      style={props.flip ? { transform: "scaleX(-1)" } : undefined}
    >
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <line x1="9.5" y1="4" x2="9.5" y2="20" />
    </svg>
  )
}

export function Sidebar() {
  const [editingID, setEditingID] = createSignal<string | undefined>()
  const [draftTitle, setDraftTitle] = createSignal("")
  const [searchOpen, setSearchOpen] = createSignal(false)
  const [query, setQuery] = createSignal("")
  const [sortMode, setSortMode] = createSignal<"recent" | "name">("recent")
  const [activeCollapsed, setActiveCollapsed] = createSignal(false)
  const [dragActive, setDragActive] = createSignal(false)
  const [dropError, setDropError] = createSignal("")

  /** MCP badge: errors win, then sign-in required, then any connected server, then "connecting". */
  const mcpState = createMemo(() => {
    const servers = state.mcp
    if (servers.some((entry) => entry.status === "error")) return { kind: "error" as const, label: t("mcp.error") }
    if (servers.some((entry) => entry.status === "needs-auth")) return { kind: "auth" as const, label: t("mcp.needsAuth") }
    if (servers.some((entry) => entry.status === "connected")) return { kind: "ok" as const, label: t("mcp.connected") }
    const configured = Object.entries(state.config?.mcp ?? {}).filter(([, server]) => server.enabled !== false)
    if (configured.length > 0) return { kind: "neutral" as const, label: t("mcp.connecting") }
    return { kind: "none" as const, label: "" }
  })

  const mcpTitle = () => {
    const lines = state.mcp.map((entry) => {
      const scope = entry.scope === "project" ? "project · " : ""
      if (entry.status === "connected") return `${entry.name}: ${scope}${t("mcp.connected")} · ${entry.tools} tools`
      if (entry.status === "needs-auth") return `${entry.name}: ${scope}${t("mcp.needsAuth")}`
      return `${entry.name}: ${scope}${entry.error ?? t("mcp.error")}`
    })
    return lines.length > 0 ? `${t("mcp.title")} — ${lines.join(" · ")}` : t("mcp.title")
  }

  // Drag & drop straight onto the workspace list adds (and enters) the folder.
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
    setDropError("")
    const dropped = [...(event.dataTransfer?.files ?? [])][0]
    if (!dropped) return
    const target = window.openorch.pathForFile(dropped)
    if (!target || !(await api.isDirectory(target).catch(() => false))) {
      setDropError(t("workspace.dropFile"))
      return
    }
    setActiveCollapsed(false)
    await enterWorkspace(target)
  }

  // Workspace tree: the active workspace is expanded; others stay collapsed (click to enter).
  const groups = createMemo(() => {
    const needle = query().trim().toLowerCase()
    const list = workspaceGroups().map((group) => {
      const nameMatch = !needle || basename(group.directory).toLowerCase().includes(needle) || group.directory.toLowerCase().includes(needle)
      const sessions = nameMatch ? group.sessions : group.sessions.filter((session) => (session.title || "").toLowerCase().includes(needle))
      return { ...group, sessions, nameMatch }
    })
    const filtered = needle ? list.filter((group) => group.nameMatch || group.sessions.length > 0) : list
    if (sortMode() === "name") {
      for (const group of filtered) group.sessions = [...group.sessions].sort((a, b) => (a.title || "").localeCompare(b.title || ""))
    }
    return filtered
  })

  const expanded = (group: WorkspaceGroup) => (query().trim().length > 0 ? true : group.directory === state.workspace && !activeCollapsed())

  const onWorkspaceClick = async (group: WorkspaceGroup) => {
    if (group.directory === state.workspace) {
      setActiveCollapsed(!activeCollapsed())
      return
    }
    setActiveCollapsed(false)
    await enterWorkspace(group.directory)
  }

  const openFolder = async () => {
    const directory = await api.pickDirectory()
    if (!directory) return
    setActiveCollapsed(false)
    await enterWorkspace(directory)
  }

  const startRename = (sessionID: string, title: string) => {
    setEditingID(sessionID)
    setDraftTitle(title)
  }

  const commitRename = async (sessionID: string) => {
    const title = draftTitle().trim()
    setEditingID(undefined)
    if (!title) return
    await api.renameSession(sessionID, title)
    await refreshConfig()
  }

  const activityTitle = (activity: string) => (activity === "attention" ? t("workspace.attention") : t("workspace.running"))

  const sessionItem = (session: SessionInfo) => (
    <div
      class={`session-item nested ${state.activeSessionID === session.id ? "active" : ""} ${sessionActivity()[session.id] ?? ""}`}
      onClick={() => void selectSession(session.id)}
    >
      <div style={{ display: "flex", "align-items": "center", gap: "6px" }}>
        <Show when={sessionActivity()[session.id]}>
          {(activity) => <span class={`activity-dot ${activity()}`} title={activityTitle(activity())} aria-label={activityTitle(activity())} />}
        </Show>
        <Show
          when={editingID() === session.id}
          fallback={<span class="title">{session.title || `${t("app.newSession")} · ${basename(session.directory)}`}</span>}
        >
          <input
            type="text"
            value={draftTitle()}
            onInput={(event) => setDraftTitle(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void commitRename(session.id)
              if (event.key === "Escape") setEditingID(undefined)
            }}
            onClick={(event) => event.stopPropagation()}
            autofocus
            style={{
              flex: 1,
              border: "1px solid var(--border)",
              "border-radius": "5px",
              background: "var(--bg-inset)",
              padding: "2px 6px",
              "font-size": "12.5px",
              outline: "none",
            }}
          />
        </Show>
        <span class="actions" onClick={(event) => event.stopPropagation()}>
          <button class="icon-button" title={t("app.rename")} onClick={() => startRename(session.id, session.title)}>
            ✎
          </button>
          <button
            class="icon-button"
            title={t("app.delete")}
            onClick={() =>
              requestConfirm({
                title: t("app.confirm.delete.title"),
                message: `${t("app.confirm.delete.message")}\n\n«${session.title || session.id}»`,
                note: state.busy[session.id] ? t("app.confirm.delete.note") : undefined,
                confirmLabel: t("app.confirm.delete"),
                danger: true,
                onConfirm: () => deleteSession(session.id),
              })
            }
          >
            <Icon name="trash" size={13} />
          </button>
        </span>
      </div>
      <span class="meta">
        {relativeTime(session.time.updated)} · {session.agent}
        <Show when={state.busy[session.id]}> · {t("app.working")}</Show>
      </span>
    </div>
  )

  return (
    <aside class="sidebar">
      <div class="sidebar-header">
        <div class="brand">
          <span class="brand-logo">O</span>
          <span>OpenOrch</span>
          <button class="icon-button" title={t("app.hideSidebar")} onClick={() => toggleSidebar(false)}>
            <PanelIcon />
          </button>
        </div>
        <button class="new-session" onClick={() => void createSession()}>
          <Icon name="plus" size={14} />
          {t("app.newSession")}
        </button>
        <button class="schedule-button" onClick={() => openSchedule()} title={t("schedule.buttonTitle")}>
          <Icon name="clock" size={15} />
          <span class="mcp-button-label">{t("schedule.title")}</span>
        </button>
        {/* MCP status: green when a server is connected, red on error, nothing when unused. */}
        <button class="mcp-button" onClick={() => openSettingsTab("mcp")} title={mcpTitle()}>
          <Icon name="plug" size={15} />
          <span class="mcp-button-label">{t("mcp.title")}</span>
          <Show when={mcpState().kind !== "none"}>
            <span class="spacer" />
            <span
              class={`status-dot ${
                mcpState().kind === "ok"
                  ? "ok"
                  : mcpState().kind === "error"
                    ? "err"
                    : mcpState().kind === "auth"
                      ? "auth"
                      : "neutral"
              }`}
            />
            <span class="mcp-button-status">{mcpState().label}</span>
          </Show>
        </button>
      </div>

      <div
        class={`session-list${dragActive() ? " drop-active" : ""}`}
        data-sort={sortMode()}
        onDragOver={onDragOver}
        onDragEnter={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={(event) => void onDrop(event)}
      >
        <Show when={dropError()}>
          <div class="workspace-drop-error">⚠ {dropError()}</div>
        </Show>
        <div class="workspace-section">
          <span class="workspace-section-title">{t("workspace.section")}</span>
          <span class="workspace-section-actions">
            <button
              class="icon-button"
              title={t("workspace.search")}
              onClick={() => {
                setSearchOpen(!searchOpen())
                if (searchOpen()) setQuery("")
              }}
            >
            <Icon name="search" size={14} />
            </button>
            <button
              class="icon-button"
              title={sortMode() === "recent" ? t("workspace.sort.recent") : t("workspace.sort.name")}
              onClick={() => setSortMode(sortMode() === "recent" ? "name" : "recent")}
            >
              ⇅
            </button>
            <button class="icon-button" title={t("workspace.openFolder")} onClick={() => void openFolder()}>
              <Icon name="folder-open" size={14} />
            </button>
          </span>
        </div>
        <Show when={searchOpen()}>
          <input
            class="workspace-search"
            type="text"
            placeholder={t("workspace.searchPlaceholder")}
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
            autofocus
          />
        </Show>

        <For each={groups()}>
          {(group) => (
            <div class="workspace-group">
              <div
                class={`workspace-entry ${group.directory === state.workspace ? "active" : ""} ${workspaceActivity()[group.directory] ?? ""}`}
                title={group.directory}
                data-directory={group.directory}
                onClick={() => void onWorkspaceClick(group)}
              >
                <span class="workspace-entry-icon"><Icon name="folder" size={14} /></span>
                <span class="workspace-entry-name">{basename(group.directory)}</span>
                <Show when={workspaceActivity()[group.directory]}>
                  {(activity) => <span class={`activity-dot ${activity()}`} title={activityTitle(activity())} aria-label={activityTitle(activity())} />}
                </Show>
                <span class="workspace-entry-count">{group.sessions.length}</span>
                <span class="workspace-entry-actions">
                  <button
                    class="icon-button"
                    title={t("workspace.remove")}
                    onClick={(event) => {
                      event.stopPropagation()
                      requestConfirm({
                        title: t("workspace.remove.title"),
                        message: `${t("workspace.remove.message")}\n\n«${basename(group.directory)}»`,
                        confirmLabel: t("workspace.remove.confirm"),
                        danger: true,
                        onConfirm: () => removeWorkspace(group.directory),
                      })
                    }}
                  >
                    <Icon name="trash" size={13} />
                  </button>
                </span>
              </div>
              <Show when={expanded(group)}>
                <div class="workspace-sessions">
                  <For each={group.sessions}>{(session) => sessionItem(session)}</For>
                  <Show when={group.sessions.length === 0}>
                    <div class="workspace-empty-small">{t("workspace.noSessions")}</div>
                  </Show>
                </div>
              </Show>
            </div>
          )}
        </For>
      </div>

      <div class="sidebar-footer">
        <button onClick={() => toggleSettings(true)}>
          <Icon name="gear" size={14} /> {t("app.settings")}
        </button>
      </div>
    </aside>
  )
}
