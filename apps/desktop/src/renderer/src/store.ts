import { createStore, produce } from "solid-js/store"
import { batch, createMemo, createSignal } from "solid-js"
import type {
  AgentInfo,
  Config,
  EngineEvent,
  FileAttachment,
  Message,
  McpServerStatus,
  ModelInfo,
  ModelRef,
  ProviderInfo,
  Part,
  PermissionReply,
  PermissionRequest,
  PromptInput,
  QuestionAnswer,
  QuestionRequest,
  SessionInfo,
} from "@openorch/shared"
import { api } from "./api"

// ---------------------------------------------------------------------------
// Right dock: tabbed panel (guide / terminal / browser) + in-window floats.
// One layout per app (not per session); persisted in localStorage like DSH.
// ---------------------------------------------------------------------------

export type DockTabKind = "guide" | "terminal" | "browser"

export interface DockTab {
  id: string
  kind: DockTabKind
  title: string
  /** Terminal: shell id (browser address lives in `url`). */
  shellID?: string
  /** Browser: last visited address, restored when the tab reopens. */
  url?: string
  /** Browser: storage partition (derived from the workspace, kept across restarts). */
  partition?: string
  /** Terminal: owning session + cwd captured when the tab was created. */
  sessionID?: string
  cwd?: string
}

export interface DockPane {
  id: string
  tabs: DockTab[]
  activeTabID?: string
}

/** A tab floated out of the dock: one tab per floating window (DSH behaviour). */
export interface DockFloat {
  tab: DockTab
  x: number
  y: number
  w: number
  h: number
}

export interface DockLayout {
  panes: DockPane[]
  activePaneID: string
  /** First pane's width share, clamped to 0.2–0.8. */
  ratio: number
  floats: DockFloat[]
}

function emptyDockLayout(): DockLayout {
  return { panes: [], activePaneID: "", ratio: 0.5, floats: [] }
}

function isDockTab(value: unknown): value is DockTab {
  if (!value || typeof value !== "object") return false
  const tab = value as DockTab
  return typeof tab.id === "string" && (tab.kind === "guide" || tab.kind === "terminal" || tab.kind === "browser") && typeof tab.title === "string"
}

/** Restores the persisted layout, dropping anything malformed (types, ids, ratios). */
function sanitizeDockLayout(value: unknown): DockLayout | undefined {
  if (!value || typeof value !== "object") return undefined
  const raw = value as Partial<DockLayout>
  if (!Array.isArray(raw.panes)) return undefined
  const panes: DockPane[] = []
  for (const candidate of raw.panes) {
    if (!candidate || typeof candidate.id !== "string" || !Array.isArray(candidate.tabs)) continue
    const tabs = candidate.tabs.filter(isDockTab)
    panes.push({
      id: candidate.id,
      tabs,
      activeTabID: tabs.some((tab) => tab.id === candidate.activeTabID) ? candidate.activeTabID : tabs[0]?.id,
    })
  }
  const floats = (Array.isArray(raw.floats) ? raw.floats : [])
    .filter((value) => value && isDockTab((value as DockFloat).tab))
    .map((float) => ({
      tab: (float as DockFloat).tab,
      x: Number((float as DockFloat).x) || 24,
      y: Number((float as DockFloat).y) || 24,
      w: Number((float as DockFloat).w) || 480,
      h: Number((float as DockFloat).h) || 340,
    }))
  const activePaneID =
    typeof raw.activePaneID === "string" && panes.some((pane) => pane.id === raw.activePaneID) ? raw.activePaneID : (panes[0]?.id ?? "")
  const ratio = typeof raw.ratio === "number" ? Math.min(0.8, Math.max(0.2, raw.ratio)) : 0.5
  return { panes, activePaneID, ratio, floats }
}

function loadDockLayout(): DockLayout {
  try {
    return sanitizeDockLayout(JSON.parse(localStorage.getItem("openorch.dock.v1") ?? "null")) ?? emptyDockLayout()
  } catch {
    return emptyDockLayout()
  }
}

export interface UIState {
  ready: boolean
  config?: Config
  sessions: SessionInfo[]
  activeSessionID?: string
  /** Workspace (working directory) chosen in the picker; sessions are scoped to it. */
  workspace?: string
  /** Left sidebar visibility (persisted between launches). */
  sidebarOpen: boolean
  skillDialogOpen: boolean
  /** Which view the skills manager opens in. */
  skillDialogMode: "list" | "create"
  /** Bumped when a skill is installed/removed so open pickers refresh. */
  skillsRevision: number
  messages: Record<string, Message[]>
  busy: Record<string, boolean>
  permissions: PermissionRequest[]
  questions: QuestionRequest[]
  models: ModelInfo[]
  agents: AgentInfo[]
  providers: ProviderInfo[]
  mcp: McpServerStatus[]
  modelPrefs?: { recent: ModelRef[]; byDirectory: Record<string, ModelRef>; variant: Record<string, string> }
  settingsOpen: boolean
  /** Active tab in the Settings window (so other views can deep-link to it). */
  settingsTab: "general" | "providers" | "agents" | "permissions" | "mcp" | "browser" | "skills" | "about"
  /** Scheduled tasks window (list/create/detail). */
  scheduleOpen: boolean
  scheduleTaskID?: string
  terminalOpen: boolean
  /** Right dock layout (tabs, panes, floats) — persisted under `openorch.dock.v1`. */
  dock: DockLayout
  /** Tab currently being dragged (renderer-only, never persisted). */
  dockDrag?: { tabID: string }
  /** True while the dock chrome (divider/float) is being dragged by pointer. */
  dockPointer: boolean
  /** Wide (maximized) presentation of the dock. */
  dockWide: boolean
  error?: string
}

const SIDEBAR_STORAGE_KEY = "openorch.sidebar"

function initialSidebarOpen(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_STORAGE_KEY) !== "collapsed"
  } catch {
    return true
  }
}

const [state, setState] = createStore<UIState>({
  ready: false,
  sessions: [],
  sidebarOpen: initialSidebarOpen(),
  skillDialogOpen: false,
  skillDialogMode: "list",
  skillsRevision: 0,
  messages: {},
  busy: {},
  permissions: [],
  questions: [],
  models: [],
  agents: [],
  providers: [],
  mcp: [],
  settingsOpen: false,
  settingsTab: "general",
  scheduleOpen: false,
  terminalOpen: false,
  dock: loadDockLayout(),
  dockPointer: false,
  dockWide: false,
})

export { state }

/** Root sessions (subagent children are hidden) that belong to the current workspace. */
export const workspaceSessions = createMemo(() =>
  state.sessions.filter((session) => !session.parentID && session.directory === state.workspace),
)

export interface WorkspaceGroup {
  directory: string
  sessions: SessionInfo[]
  last: number
}

export type ActivityState = "running" | "attention"

/**
 * Activity per session, including hidden subagent children. A pending
 * permission/question wins over a running state so the workspace turns yellow.
 */
export const sessionActivity = createMemo<Record<string, ActivityState>>(() => {
  const attention = new Set<string>()
  for (const request of state.permissions) attention.add(request.sessionID)
  for (const request of state.questions) attention.add(request.sessionID)
  const out: Record<string, ActivityState> = {}
  for (const session of state.sessions) {
    if (attention.has(session.id)) out[session.id] = "attention"
    else if (state.busy[session.id]) out[session.id] = "running"
  }
  return out
})

/** Aggregates session activity into each workspace/folder row. */
export const workspaceActivity = createMemo<Record<string, ActivityState>>(() => {
  const perSession = sessionActivity()
  const out: Record<string, ActivityState> = {}
  for (const session of state.sessions) {
    const activity = perSession[session.id]
    if (!activity) continue
    if (activity === "attention") out[session.directory] = "attention"
    else if (out[session.directory] !== "attention") out[session.directory] = "running"
  }
  return out
})

/** Every known workspace (recent directories + any directory with sessions) and its sessions. */
export const workspaceGroups = createMemo<WorkspaceGroup[]>(() => {
  const map = new Map<string, WorkspaceGroup>()
  const hidden = new Set(state.config?.hiddenDirectories ?? [])
  const add = (directory?: string) => {
    if (!directory || hidden.has(directory) || map.has(directory)) return
    map.set(directory, { directory, sessions: [], last: 0 })
  }
  for (const directory of state.config?.recentDirectories ?? []) add(directory)
  add(state.config?.lastDirectory)
  add(state.workspace)
  for (const session of state.sessions) {
    if (session.parentID) continue
    add(session.directory)
    const entry = map.get(session.directory)
    if (!entry) continue
    entry.sessions.push(session)
    entry.last = Math.max(entry.last, session.time.updated)
  }
  for (const entry of map.values()) entry.sessions.sort((a, b) => b.time.updated - a.time.updated)
  return [...map.values()].sort((a, b) => {
    if (a.directory === state.workspace) return -1
    if (b.directory === state.workspace) return 1
    return b.last - a.last || a.directory.localeCompare(b.directory)
  })
})

export const activeSession = createMemo(() => state.sessions.find((session) => session.id === state.activeSessionID))
export const activeMessages = createMemo(() => (state.activeSessionID ? (state.messages[state.activeSessionID] ?? []) : []))
export const activeBusy = createMemo(() => (state.activeSessionID ? Boolean(state.busy[state.activeSessionID]) : false))
export const activePermissions = createMemo(() =>
  state.permissions.filter((request) => request.sessionID === state.activeSessionID),
)
export const activeQuestions = createMemo(() =>
  state.questions.filter((request) => request.sessionID === state.activeSessionID),
)
export const primaryAgents = createMemo(() => state.agents.filter((agent) => agent.mode !== "subagent" && !agent.hidden))

/** Sessions whose transcript changed while another session was on screen. */
const staleTranscripts = new Set<string>()
/** Recently loaded transcripts, newest last. Keeps memory bounded across switches. */
const loadedTranscriptOrder: string[] = []
const MAX_LOADED_TRANSCRIPTS = 6

async function ensureMessages(sessionID: string, force = false): Promise<void> {
  if (!force && state.messages[sessionID]) return
  const messages = await api.messages(sessionID)
  setState("messages", sessionID, messages)
  const busy = await api.sessionBusy(sessionID)
  setState("busy", sessionID, busy)
}

function rememberLoadedTranscript(sessionID: string): void {
  const index = loadedTranscriptOrder.indexOf(sessionID)
  if (index !== -1) loadedTranscriptOrder.splice(index, 1)
  loadedTranscriptOrder.push(sessionID)
  while (loadedTranscriptOrder.length > MAX_LOADED_TRANSCRIPTS) {
    const oldest = loadedTranscriptOrder.shift()
    if (!oldest || oldest === state.activeSessionID) continue
    setState(
      produce((draft) => {
        delete draft.messages[oldest]
      }),
    )
  }
}

export async function loadInitial(): Promise<void> {
  const [config, sessions, models, agents, providers, mcp, modelPrefs] = await Promise.all([
    api.getConfig(),
    api.listSessions(),
    api.listModels(),
    api.listAgents(),
    api.listProviders(),
    api.mcpStatus(),
    api.modelPreferences(),
  ])
  batch(() => {
    setState({ config, sessions, models, agents, providers, mcp, modelPrefs, ready: true })
    // The workspace picker decides the session; nothing is auto-selected.
    if (!state.activeSessionID) setState("activeSessionID", undefined)
  })
}

/** Enters a workspace: remembers it (recents for the tree/picker) and opens its latest session. */
export async function enterWorkspace(directory: string): Promise<void> {
  setState("workspace", directory)
  const config = state.config
  const recentDirectories = [directory, ...(config?.recentDirectories ?? []).filter((entry) => entry !== directory)].slice(0, 12)
  // Reopening a previously removed workspace brings it back with all of its sessions.
  const hiddenDirectories = (config?.hiddenDirectories ?? []).filter((entry) => entry !== directory)
  await api.setConfig({ lastDirectory: directory, recentDirectories, hiddenDirectories }).catch(() => undefined)
  await refreshConfig().catch(() => undefined)
  const next = [...workspaceSessions()].sort((a, b) => b.time.updated - a.time.updated)[0]
  if (next) await selectSession(next.id)
  else setState("activeSessionID", undefined)
}

/** Removes a workspace from the sidebar without touching its sessions (reopen restores it). */
export async function removeWorkspace(directory: string): Promise<void> {
  const config = state.config
  const hiddenDirectories = [...new Set([...(config?.hiddenDirectories ?? []), directory])].slice(0, 50)
  const recentDirectories = (config?.recentDirectories ?? []).filter((entry) => entry !== directory)
  if (state.workspace === directory) leaveWorkspace()
  await api.setConfig({ hiddenDirectories, recentDirectories }).catch(() => undefined)
  await refreshConfig().catch(() => undefined)
}

/** Returns to the workspace picker. */
export function leaveWorkspace(): void {
  setState("workspace", undefined)
  setState("activeSessionID", undefined)
}

export function toggleSkillDialog(open: boolean, mode: "list" | "create" = "list"): void {
  setState("skillDialogMode", mode)
  setState("skillDialogOpen", open)
}

/** Shows/hides the left sidebar and remembers the choice between launches. */
export function toggleSidebar(open?: boolean): void {
  const next = open ?? !state.sidebarOpen
  setState("sidebarOpen", next)
  try {
    localStorage.setItem(SIDEBAR_STORAGE_KEY, next ? "open" : "collapsed")
  } catch {
    // localStorage unavailable: keep the in-memory state only
  }
}

export function bumpSkillsRevision(): void {
  setState("skillsRevision", (value) => value + 1)
}

export async function refreshModelPrefs(): Promise<void> {
  const modelPrefs = await api.modelPreferences()
  setState("modelPrefs", modelPrefs)
}

export async function refreshConfig(): Promise<void> {
  const config = await api.getConfig()
  setState("config", config)
}

export async function refreshProviders(): Promise<void> {
  const [providers, models] = await Promise.all([api.listProviders(), api.listModels()])
  batch(() => {
    setState("providers", providers)
    setState("models", models)
  })
}

export async function refreshAgents(): Promise<void> {
  const agents = await api.listAgents()
  setState("agents", agents)
}

export async function selectSession(sessionID: string): Promise<void> {
  // Transcript events are only forwarded for the watched session. Reload only
  // sessions that were busy or changed in the background; reloading a large,
  // idle transcript on every click is expensive and can stall the renderer.
  const changed = state.activeSessionID !== sessionID
  const force = staleTranscripts.has(sessionID) || (changed && Boolean(state.busy[sessionID]))
  setState("activeSessionID", sessionID)
  try {
    await ensureMessages(sessionID, force)
    staleTranscripts.delete(sessionID)
    rememberLoadedTranscript(sessionID)
  } catch (error) {
    setState("error", error instanceof Error ? error.message : String(error))
  }
}

export async function createSession(input?: { directory?: string; agent?: string }): Promise<SessionInfo> {
  const session = await api.createSession({ directory: input?.directory ?? state.workspace, agent: input?.agent })
  setState("sessions", (sessions) => dedupeSessions([session, ...sessions]))
  setState("messages", session.id, [])
  await selectSession(session.id)
  return session
}

export async function deleteSession(sessionID: string): Promise<void> {
  await api.deleteSession(sessionID)
  staleTranscripts.delete(sessionID)
  {
    const index = loadedTranscriptOrder.indexOf(sessionID)
    if (index !== -1) loadedTranscriptOrder.splice(index, 1)
  }
  setState(
    produce((draft) => {
      draft.sessions = draft.sessions.filter((session) => session.id !== sessionID)
      delete draft.messages[sessionID]
      delete draft.busy[sessionID]
      if (draft.activeSessionID === sessionID) draft.activeSessionID = undefined
    }),
  )
  const next = [...workspaceSessions()].sort((a, b) => b.time.updated - a.time.updated)[0]
  if (next) await selectSession(next.id)
}

export async function sendPrompt(
  text: string,
  files?: FileAttachment[],
  delivery?: "steer" | "queue",
  skills?: string[],
): Promise<void> {
  const sessionID = state.activeSessionID
  if (!sessionID) return
  const input: PromptInput = { text, files, delivery, skills }
  await api.prompt(sessionID, input)
}

export async function runCommand(command: string): Promise<void> {
  const sessionID = state.activeSessionID
  if (!sessionID) return
  await api.command(sessionID, command)
}

export async function interrupt(): Promise<void> {
  const sessionID = state.activeSessionID
  if (!sessionID) return
  await api.interrupt(sessionID)
}

export async function replyPermission(requestID: string, reply: PermissionReply, message?: string): Promise<void> {
  await api.replyPermission(requestID, reply, message)
  setState("permissions", (requests) => requests.filter((request) => request.id !== requestID))
}

export async function replyQuestion(requestID: string, answers: QuestionAnswer[]): Promise<void> {
  await api.replyQuestion(requestID, answers)
  setState("questions", (requests) => requests.filter((request) => request.id !== requestID))
}

export async function setAgent(agentID: string): Promise<void> {
  const sessionID = state.activeSessionID
  if (!sessionID) return
  await api.setSessionAgent(sessionID, agentID)
}

export async function setModel(providerID: string, modelID: string, variant?: string): Promise<void> {
  const sessionID = state.activeSessionID
  if (!sessionID) return
  const ref: ModelRef = { providerID, modelID, ...(variant ? { variant } : {}) }
  // Optimistic: reflect the choice immediately, then confirm with the engine so a
  // failed switch is never silent.
  setState("sessions", (sessions) => sessions.map((session) => (session.id === sessionID ? { ...session, model: ref } : session)))
  try {
    await api.setSessionModel(sessionID, ref)
  } catch (failure) {
    setState("error", `No se pudo cambiar el modelo: ${failure instanceof Error ? failure.message : String(failure)}`)
  }
  await refreshModelPrefs().catch(() => undefined)
}

/** Cycles the thinking variant of the active session's model (default → none → … ). */
export async function cycleModelVariant(): Promise<void> {
  const ref = activeSession()?.model
  if (!ref) return
  const model = state.models.find((entry) => entry.providerID === ref.providerID && entry.id === ref.modelID)
  const variants = ["default", ...(model?.variants ?? [])]
  if (variants.length <= 1) return
  const current = ref.variant ?? "default"
  const next = variants[(variants.indexOf(current) + 1) % variants.length]
  await setModel(ref.providerID, ref.modelID, next === "default" ? undefined : next)
}

function dedupeSessions(sessions: SessionInfo[]): SessionInfo[] {
  const map = new Map<string, SessionInfo>()
  for (const session of sessions) map.set(session.id, session)
  return [...map.values()].sort((a, b) => b.time.updated - a.time.updated)
}

function upsertSession(session: SessionInfo): void {
  setState("sessions", (sessions) => dedupeSessions([session, ...sessions.filter((entry) => entry.id !== session.id)]))
}

function upsertMessage(sessionID: string, message: Message): void {
  const list = state.messages[sessionID]
  if (!list) {
    setState("messages", sessionID, [message])
    return
  }
  const index = list.findIndex((entry) => entry.id === message.id)
  if (index === -1) {
    setState("messages", sessionID, (messages) => [...messages, message])
    return
  }
  setState("messages", sessionID, index, message)
}

export function applyEvent(event: EngineEvent): void {
  switch (event.type) {
    case "session.created":
    case "session.updated":
      upsertSession(event.session)
      break
    case "session.deleted":
      staleTranscripts.delete(event.sessionID)
      {
        const index = loadedTranscriptOrder.indexOf(event.sessionID)
        if (index !== -1) loadedTranscriptOrder.splice(index, 1)
      }
      setState(
        produce((draft) => {
          draft.sessions = draft.sessions.filter((session) => session.id !== event.sessionID)
          delete draft.messages[event.sessionID]
          if (draft.activeSessionID === event.sessionID) draft.activeSessionID = draft.sessions[0]?.id
        }),
      )
      break
    case "session.status":
      setState("busy", event.sessionID, event.status === "busy")
      // A background run may have appended messages while its transcript was
      // not being watched. Reload it when the user opens it again.
      if (event.status === "idle" && event.sessionID !== state.activeSessionID) staleTranscripts.add(event.sessionID)
      break
    case "message.created":
    case "message.updated": {
      // Sessions whose transcript is not loaded (hidden subagent children) are
      // dropped: keeping every child hot caused needless renders and lag.
      if (!state.messages[event.sessionID] && event.sessionID !== state.activeSessionID) break
      upsertMessage(event.sessionID, event.message)
      break
    }
    case "message.deleted": {
      const list = state.messages[event.sessionID]
      if (!list) break
      setState(
        "messages",
        event.sessionID,
        list.filter((message) => message.id !== event.messageID),
      )
      break
    }
    case "part.created": {
      if (!state.messages[event.sessionID] && event.sessionID !== state.activeSessionID) break
      const list = state.messages[event.sessionID]
      const message = list?.find((entry) => entry.id === event.messageID)
      if (!message || message.role !== "assistant") break
      if (message.content.some((part) => part.id === event.part.id)) break
      setState(
        produce((draft) => {
          const target = draft.messages[event.sessionID]?.find((entry) => entry.id === event.messageID)
          if (target?.role === "assistant") target.content.push(event.part)
        }),
      )
      break
    }
    case "part.delta": {
      if (!state.messages[event.sessionID] && event.sessionID !== state.activeSessionID) break
      setState(
        produce((draft) => {
          const target = draft.messages[event.sessionID]?.find((entry) => entry.id === event.messageID)
          if (!target || target.role !== "assistant") return
          const part = target.content.find((entry) => entry.id === event.partID)
          if (!part) return
          if (part.type === "text" || part.type === "reasoning") part.text += event.delta
        }),
      )
      break
    }
    case "part.updated": {
      if (!state.messages[event.sessionID] && event.sessionID !== state.activeSessionID) break
      setState(
        produce((draft) => {
          const target = draft.messages[event.sessionID]?.find((entry) => entry.id === event.messageID)
          if (!target || target.role !== "assistant") return
          const index = target.content.findIndex((entry) => entry.id === (event.part as Part).id)
          if (index === -1) target.content.push(event.part)
          else target.content[index] = event.part
        }),
      )
      break
    }
    case "permission.asked":
      if (!state.permissions.some((request) => request.id === event.request.id)) {
        setState("permissions", (requests) => [...requests, event.request])
      }
      break
    case "permission.replied":
      setState("permissions", (requests) => requests.filter((request) => request.id !== event.requestID))
      break
    case "question.asked":
      if (!state.questions.some((request) => request.id === event.request.id)) {
        setState("questions", (requests) => [...requests, event.request])
      }
      break
    case "question.replied":
      setState("questions", (requests) => requests.filter((request) => request.id !== event.requestID))
      break
    case "config.updated":
      void refreshConfig()
      break
    case "agents.updated":
      void refreshAgents()
      break
    case "providers.updated":
      void refreshProviders()
      break
    case "mcp.updated":
      void api.mcpStatus().then((mcp) => setState("mcp", mcp))
      break
    case "error":
      setState("error", event.message)
      break
  }
}

export function initEvents(): void {
  window.openorch.onEngineEvent((raw) => {
    applyEvent(raw as EngineEvent)
  })
}

export function toggleSettings(open?: boolean): void {
  setState("settingsOpen", open ?? !state.settingsOpen)
}

/** Opens Settings directly on a tab (sidebar shortcuts, MCP status button…). */
export function openSettingsTab(tab: UIState["settingsTab"]): void {
  setState("settingsTab", tab)
  setState("settingsOpen", true)
}

export function setSettingsTab(tab: UIState["settingsTab"]): void {
  setState("settingsTab", tab)
}

/** Opens the scheduled tasks window, optionally on a specific task. */
export function openSchedule(taskID?: string): void {
  setState("settingsOpen", false)
  setState("scheduleTaskID", taskID)
  setState("scheduleOpen", true)
}

export function closeSchedule(): void {
  setState("scheduleOpen", false)
  setState("scheduleTaskID", undefined)
}

/** Opens a scheduled run's session, switching the workspace when necessary. */
export async function openScheduledSession(directory: string, sessionID: string): Promise<void> {
  if (state.workspace !== directory) await enterWorkspace(directory)
  await selectSession(sessionID)
  setState("scheduleOpen", false)
}

export function toggleTerminal(open?: boolean): void {
  setState("terminalOpen", open ?? !state.terminalOpen)
}

// ---------------------------------------------------------------------------
// Right dock actions (pure layout mutations + persistence)
// ---------------------------------------------------------------------------

let dockCounter = 0
function newDockID(prefix: string): string {
  dockCounter += 1
  return `${prefix}_${Date.now().toString(36)}_${dockCounter}`
}

function clampValue(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function persistDock(): void {
  try {
    localStorage.setItem("openorch.dock.v1", JSON.stringify(state.dock))
  } catch {
    // localStorage unavailable: keep the in-memory layout only.
  }
}

/** Runs a draft mutation (solid `produce`) and persists the result. */
function updateDock(mutate: (draft: DockLayout) => void): void {
  setState("dock", produce(mutate))
  persistDock()
}

/** Removes a tab from a pane or a float; returns the removed tab. */
function removeTab(draft: DockLayout, tabID: string): DockTab | undefined {
  const floatIndex = draft.floats.findIndex((float) => float.tab.id === tabID)
  if (floatIndex !== -1) return draft.floats.splice(floatIndex, 1)[0]?.tab
  for (const pane of draft.panes) {
    const index = pane.tabs.findIndex((tab) => tab.id === tabID)
    if (index === -1) continue
    const [tab] = pane.tabs.splice(index, 1)
    if (pane.activeTabID === tabID) pane.activeTabID = pane.tabs[index]?.id ?? pane.tabs[index - 1]?.id
    return tab
  }
  return undefined
}

/** Drops panes that lost their last tab (never more than the two the layout allows). */
function settlePanes(draft: DockLayout): void {
  if (draft.panes.length > 1) draft.panes = draft.panes.filter((pane) => pane.tabs.length > 0)
  if (!draft.panes.some((pane) => pane.id === draft.activePaneID)) draft.activePaneID = draft.panes[0]?.id ?? ""
}

export interface DockTabParams {
  id?: string
  title?: string
  url?: string
  partition?: string
  shellID?: string
  sessionID?: string
  cwd?: string
}

/**
 * Opens a tab in a pane (or the active one). Guides are singletons per pane;
 * `replaceGuide` swaps the pane's guide for the new content page (DSH rule).
 */
export function openDockTab(kind: DockTabKind, params: DockTabParams = {}, options: { paneID?: string; replaceGuide?: boolean } = {}): void {
  updateDock((draft) => {
    let pane =
      draft.panes.find((candidate) => candidate.id === options.paneID) ??
      draft.panes.find((candidate) => candidate.id === draft.activePaneID) ??
      draft.panes[0]
    if (!pane) {
      pane = { id: newDockID("pane"), tabs: [], activeTabID: undefined }
      draft.panes.push(pane)
    }
    if (options.replaceGuide) {
      const guide = pane.tabs.find((tab) => tab.kind === "guide")
      if (guide) removeTab(draft, guide.id)
    }
    const existing = pane.tabs.find((tab) => tab.kind === kind)
    if (kind === "guide" && existing) {
      pane.activeTabID = existing.id
      draft.activePaneID = pane.id
      return
    }
    const tab: DockTab = { id: params.id ?? newDockID(kind), kind, title: params.title ?? kind }
    if (params.shellID !== undefined) tab.shellID = params.shellID
    if (params.url !== undefined) tab.url = params.url
    if (params.partition !== undefined) tab.partition = params.partition
    if (params.sessionID !== undefined) tab.sessionID = params.sessionID
    if (params.cwd !== undefined) tab.cwd = params.cwd
    pane.tabs.push(tab)
    pane.activeTabID = tab.id
    draft.activePaneID = pane.id
  })
}

export function closeDockTab(tabID: string): void {
  updateDock((draft) => {
    removeTab(draft, tabID)
    settlePanes(draft)
  })
}

export function activateDockTab(tabID: string): void {
  updateDock((draft) => {
    for (const pane of draft.panes) {
      if (!pane.tabs.some((tab) => tab.id === tabID)) continue
      pane.activeTabID = tabID
      draft.activePaneID = pane.id
      return
    }
  })
}

/** Splits a pane into two (max. two panes) and seeds the new one with the guide. */
export function splitDockPane(paneID?: string): string | undefined {
  if (state.dock.panes.length >= 2) return undefined
  let created: string | undefined
  updateDock((draft) => {
    if (draft.panes.length >= 2) return
    const index = Math.max(0, draft.panes.findIndex((pane) => pane.id === (paneID ?? draft.activePaneID)))
    const pane: DockPane = { id: newDockID("pane"), tabs: [], activeTabID: undefined }
    draft.panes.splice(draft.panes.length > 0 ? index + 1 : 0, 0, pane)
    draft.ratio = 0.5
    draft.activePaneID = pane.id
    created = pane.id
  })
  if (created) openDockTab("guide", {}, { paneID: created })
  return created
}

/** Drag & drop: moves a tab (from a pane or a float) into a pane, splitting when there is room. */
export function dropDockTab(tabID: string, targetPaneID: string, zone: "left" | "right" | "center"): void {
  updateDock((draft) => {
    const source = draft.panes.find((pane) => pane.tabs.some((tab) => tab.id === tabID))
    const inFloat = draft.floats.some((float) => float.tab.id === tabID)
    if (!source && !inFloat) return
    // A lone tab dropped on its own pane edge would split the pane into nothing.
    if (source && source.id === targetPaneID && zone !== "center" && source.tabs.length === 1) return
    const tab = removeTab(draft, tabID)
    if (!tab) return
    settlePanes(draft)
    const target = draft.panes.find((pane) => pane.id === targetPaneID) ?? draft.panes[0]
    if (!target) {
      const pane: DockPane = { id: newDockID("pane"), tabs: [tab], activeTabID: tab.id }
      draft.panes.push(pane)
      draft.activePaneID = pane.id
      return
    }
    if (zone !== "center" && draft.panes.length < 2) {
      const index = draft.panes.findIndex((pane) => pane.id === target.id)
      const pane: DockPane = { id: newDockID("pane"), tabs: [tab], activeTabID: tab.id }
      draft.panes.splice(zone === "left" ? Math.max(0, index) : index + 1, 0, pane)
      draft.activePaneID = pane.id
      return
    }
    target.tabs.push(tab)
    target.activeTabID = tab.id
    draft.activePaneID = target.id
  })
}

/** Takes a tab out of the dock into an in-window floating panel (one tab only). */
export function floatDockTab(tabID: string, rect: { x: number; y: number; w?: number; h?: number }): void {
  updateDock((draft) => {
    const tab = removeTab(draft, tabID)
    if (!tab) return
    settlePanes(draft)
    const w = Math.min(rect.w ?? 520, Math.max(280, window.innerWidth - 32))
    const h = Math.min(rect.h ?? 360, Math.max(180, window.innerHeight - 64))
    draft.floats.push({
      tab,
      x: clampValue(rect.x, 8, Math.max(8, window.innerWidth - w - 8)),
      y: clampValue(rect.y, 8, Math.max(8, window.innerHeight - h - 8)),
      w,
      h,
    })
  })
}

/** Re-inserts a floating tab into the active pane (its dedicated panel button). */
export function dockFloatTab(tabID: string): void {
  updateDock((draft) => {
    const index = draft.floats.findIndex((float) => float.tab.id === tabID)
    if (index === -1) return
    const [float] = draft.floats.splice(index, 1)
    if (!float) return
    let pane = draft.panes.find((candidate) => candidate.id === draft.activePaneID) ?? draft.panes[0]
    if (!pane) {
      pane = { id: newDockID("pane"), tabs: [], activeTabID: undefined }
      draft.panes.push(pane)
    }
    pane.tabs.push(float.tab)
    pane.activeTabID = float.tab.id
    draft.activePaneID = pane.id
  })
}

export function moveFloat(tabID: string, x: number, y: number): void {
  updateDock((draft) => {
    const float = draft.floats.find((entry) => entry.tab.id === tabID)
    if (!float) return
    float.x = clampValue(x, 0, Math.max(0, window.innerWidth - float.w))
    float.y = clampValue(y, 0, Math.max(0, window.innerHeight - 48))
  })
}

export function resizeFloat(tabID: string, size: { w: number; h: number }): void {
  updateDock((draft) => {
    const float = draft.floats.find((entry) => entry.tab.id === tabID)
    if (!float) return
    float.w = clampValue(size.w, 280, Math.max(280, window.innerWidth - 8))
    float.h = clampValue(size.h, 180, Math.max(180, window.innerHeight - 8))
  })
}

export function setDockRatio(ratio: number): void {
  updateDock((draft) => {
    draft.ratio = clampValue(ratio, 0.2, 0.8)
  })
}

/** Browser tabs persist their latest address/title (restore after a restart). */
export function setDockTab(tabID: string, patch: Partial<DockTab>): void {
  updateDock((draft) => {
    const tabs = [...draft.panes.flatMap((pane) => pane.tabs), ...draft.floats.map((float) => float.tab)]
    const tab = tabs.find((entry) => entry.id === tabID)
    if (!tab) return
    Object.assign(tab, patch)
  })
}

export function setDockDrag(drag?: { tabID: string }): void {
  setState("dockDrag", drag)
}

/** Webviews must not swallow the pointer while dock chrome is dragged. */
export function setDockPointer(active: boolean): void {
  setState("dockPointer", active)
}

export function toggleDockWide(): void {
  setState("dockWide", !state.dockWide)
}

export function totalDockTabs(): number {
  return state.dock.panes.reduce((total, pane) => total + pane.tabs.length, 0) + state.dock.floats.length
}

export function clearError(): void {
  setState("error", undefined)
}

// ---------------------------------------------------------------------------
// Confirmation dialog
// ---------------------------------------------------------------------------

export interface ConfirmRequest {
  title: string
  message: string
  note?: string
  confirmLabel: string
  danger?: boolean
  onConfirm: () => void | Promise<void>
}

const [confirmRequest, setConfirmRequest] = createSignal<ConfirmRequest | undefined>()
export { confirmRequest }

export function requestConfirm(request: ConfirmRequest): void {
  setConfirmRequest(request)
}

export function closeConfirm(): void {
  setConfirmRequest(undefined)
}
