/**
 * Shared types between the OpenOrch engine (core) and the desktop UI.
 * Plain, structured-clone friendly data only.
 */

// ---------------------------------------------------------------------------
// Models & providers
// ---------------------------------------------------------------------------

export type ProviderKind =
  | "anthropic"
  | "openai"
  | "google"
  | "deepseek"
  | "xai"
  | "groq"
  | "mistral"
  | "openrouter"
  | "cerebras"
  | "togetherai"
  | "openai-compatible"

export interface CostInfo {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
}

export type ReasoningOption =
  | { type: "effort"; values?: string[] }
  | { type: "toggle" }
  | { type: "budget_tokens"; min?: number; max?: number }

export interface ModelInfo {
  id: string
  providerID: string
  name: string
  family?: string
  attachment?: boolean
  reasoning?: boolean
  reasoningOptions?: ReasoningOption[]
  toolCall?: boolean
  temperature?: boolean
  releaseDate?: string
  modalities?: { input?: string[]; output?: string[] }
  limit?: { context?: number; output?: number }
  cost?: CostInfo
  interleaved?: { field?: string }
  canonicalModelID?: string
  /** Reasoning variants available for this model (e.g. none, low, medium, high). */
  variants?: string[]
  /** Model discovered through the provider's `/models` endpoint (not in the catalog). */
  discovered?: boolean
}

export interface ProviderInfo {
  id: string
  name: string
  kind: ProviderKind
  env?: string[]
  baseURL?: string
  doc?: string
  npm?: string
  /** Where this provider definition came from. */
  source: "catalog" | "custom"
  models: ModelInfo[]
  configured?: boolean
}

export interface ModelRef {
  providerID: string
  modelID: string
  variant?: string
}

// ---------------------------------------------------------------------------
// Sessions & messages
// ---------------------------------------------------------------------------

export interface TokenUsage {
  input: number
  output: number
  reasoning?: number
  cacheRead?: number
  cacheWrite?: number
}

export interface ModelSelection extends ModelRef {
  /** Resolved display name for UI. */
  name?: string
}

export interface SessionInfo {
  id: string
  title: string
  directory: string
  agent: string
  model?: ModelSelection
  parentID?: string
  cost?: number
  tokens?: TokenUsage
  time: { created: number; updated: number; idle?: number }
}

export interface FileAttachment {
  type: "file"
  url: string // data: URI or file:// URL
  mime: string
  name?: string
}

export interface UserMessage {
  id: string
  sessionID: string
  role: "user"
  text: string
  files?: FileAttachment[]
  time: { created: number }
}

export interface AssistantMessage {
  id: string
  sessionID: string
  role: "assistant"
  agent: string
  model: ModelSelection
  content: Part[]
  time: { created: number; completed?: number }
  finish?: string
  cost?: number
  tokens?: TokenUsage
  error?: string
}

export interface SyntheticMessage {
  id: string
  sessionID: string
  role: "synthetic"
  text: string
  /** Short one-line label shown by the UI (upstream `session.synthetic` description). */
  description?: string
  metadata?: Record<string, unknown>
  time: { created: number }
}

export interface ShellMessage {
  id: string
  sessionID: string
  role: "shell"
  command: string
  output?: string
  status: "running" | "completed" | "failed"
  time: { created: number; completed?: number }
}

export interface CompactionMessage {
  id: string
  sessionID: string
  role: "compaction"
  summary: string
  recent?: string
  status: "running" | "completed" | "failed"
  error?: string
  cost?: number
  tokens?: TokenUsage
  time: { created: number; completed?: number }
}

export type Message =
  | UserMessage
  | AssistantMessage
  | SyntheticMessage
  | ShellMessage
  | CompactionMessage

// ---------------------------------------------------------------------------
// Message parts
// ---------------------------------------------------------------------------

export interface TextPart {
  type: "text"
  id: string
  text: string
  /** Provider-bound state (Gemini thought signatures, Anthropic signatures…). */
  providerMetadata?: Record<string, unknown>
}

export interface ReasoningPart {
  type: "reasoning"
  id: string
  text: string
  /** Provider-bound reasoning state, replayable only against the producing model. */
  providerMetadata?: Record<string, unknown>
}

export interface TextContent {
  type: "text"
  text: string
}

export interface FileContent {
  type: "file"
  url: string
  mime: string
  name?: string
}

export type ToolContent = TextContent | FileContent

export interface ToolStateStreaming {
  status: "streaming"
  input: string
}

export interface ToolStateRunning {
  status: "running"
  input: Record<string, unknown>
  metadata?: Record<string, unknown>
}

export interface ToolStateCompleted {
  status: "completed"
  input: Record<string, unknown>
  content: ToolContent[]
  metadata?: Record<string, unknown>
}

export interface ToolStateError {
  status: "error"
  input: Record<string, unknown>
  error: string
  metadata?: Record<string, unknown>
}

/** The tool needs the user's permission before running. */
export interface ToolStatePermission {
  status: "permission"
  input: Record<string, unknown>
  requestID: string
}

export type ToolState =
  | ToolStateStreaming
  | ToolStateRunning
  | ToolStateCompleted
  | ToolStateError
  | ToolStatePermission

export interface ToolPart {
  type: "tool"
  id: string
  callID: string
  tool: string
  state: ToolState
  time?: { created: number; completed?: number }
}

export type Part = TextPart | ReasoningPart | ToolPart

// ---------------------------------------------------------------------------
// File diffs (tool metadata for UI)
// ---------------------------------------------------------------------------

export interface FileDiffInfo {
  path: string
  status: "added" | "modified" | "deleted"
  patch: string
  additions: number
  deletions: number
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

export type PermissionEffect = "allow" | "deny" | "ask"

export interface PermissionRule {
  action: string
  resource: string
  effect: PermissionEffect
}

/** Flattened view used by Settings to list saved "allow always" rules. */
export interface SavedPermissionView {
  action: string
  resource: string
  project: string
}

export interface PermissionRequest {
  id: string
  sessionID: string
  action: string
  resources: string[]
  save?: string[]
  metadata?: Record<string, unknown>
  message?: string
  time: number
}

export type PermissionReply = "once" | "always" | "reject"

// ---------------------------------------------------------------------------
// Questions (model -> user)
// ---------------------------------------------------------------------------

export interface QuestionOption {
  label: string
  description?: string
}

export interface QuestionPrompt {
  question: string
  header: string
  options: QuestionOption[]
  multiple?: boolean
}

export interface QuestionRequest {
  id: string
  sessionID: string
  questions: QuestionPrompt[]
  time: number
}

export interface QuestionAnswer {
  question: string
  answers: string[]
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

export interface SkillInfo {
  id: string
  name: string
  description: string
  directory: string
  /** When false, the skill is not advertised to the model (only user-invokable). */
  autoinvoke?: boolean
  /** Where the skill was discovered from (global OpenOrch dir, the project, or a configured folder). */
  origin?: "global" | "project" | "custom"
}

/** Skill plus its editable content, for the manager's detail view. */
export interface SkillDetail extends SkillInfo {
  /** `SKILL.md` body (frontmatter stripped). */
  content: string
  /** Extra files shipped with the skill (scripts, references…). */
  files: string[]
}

// ---------------------------------------------------------------------------
// Web search
// ---------------------------------------------------------------------------

export interface WebSearchResult {
  title: string
  url: string
  content?: string
  published?: string
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export interface AgentInfo {
  id: string
  name: string
  description?: string
  mode: "primary" | "subagent" | "all"
  hidden: boolean
  color?: string
  model?: ModelRef
  steps?: number
  source: "builtin" | "custom"
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ProviderSettings {
  kind?: ProviderKind
  name?: string
  apiKey?: string
  baseURL?: string
  headers?: Record<string, string>
  models?: string[]
  enabled?: boolean
}

export interface AgentSettings {
  model?: ModelRef
  system?: string
  description?: string
  mode?: "primary" | "subagent" | "all"
  hidden?: boolean
  color?: string
  steps?: number
  disabled?: boolean
  permissions?: PermissionRule[]
}

export interface McpServerConfig {
  type: "local" | "remote"
  command?: string[]
  url?: string
  headers?: Record<string, string>
  /** Extra environment variables for local servers (merged with the default env). */
  environment?: Record<string, string>
  /** Per-server request timeout in milliseconds. */
  timeout?: number
  /** Pre-registered OAuth client credentials (remote servers without dynamic registration). */
  oauth?: { clientId?: string; clientSecret?: string; scope?: string }
  enabled?: boolean
}

/** Live state of one MCP server (IPC `mcp.status`, sidebar badge, Settings tab). */
export interface McpServerStatus {
  name: string
  status: "connected" | "error" | "needs-auth"
  tools: number
  toolNames: string[]
  /** Where the entry comes from: the app config or the project's `.openorch/mcp.json`. */
  scope: "global" | "project"
  /** Display target: the command line (local) or the URL (remote). */
  target?: string
  error?: string
}

export interface WebSearchConfig {
  provider?: "exa" | "brave" | "tavily" | "tinyfish" | "parallel" | "duckduckgo"
  apiKey?: string
}

export type ThemeName = "light" | "dark" | "nord" | "gruvbox" | "tokyo" | "system"

export interface Config {
  language: "es" | "en"
  theme: ThemeName
  configVersion?: number
  providers: Record<string, ProviderSettings>
  model?: ModelRef
  smallModel?: ModelRef
  agents: Record<string, AgentSettings>
  permissions: PermissionRule[]
  compaction: { auto: boolean; keep: number; buffer?: number }
  mcp: Record<string, McpServerConfig>
  skills: { dirs: string[] }
  websearch: WebSearchConfig
  shell: { timeoutMs: number }
  /** Integrated terminal preferences (selected shell). */
  terminal: { shell?: string }
  /** Agent browser backend: the dock webview, the Edge/Chrome extension, or auto. */
  browser: { mode: "auto" | "embedded" | "extension" }
  /** Scheduled task preferences (background startup). */
  schedule: { startWithWindows: boolean }
  codeMode: { enabled: boolean }
  worktree: { directory?: string }
  experimental: {
    subagentDepth: number
    /** Subagent thinking level: "minimal" (default) or "inherit" the parent's. */
    subagentVariant: "minimal" | "inherit"
    /** Global subagent model. Empty/null = inherit the parent/agent model. */
    subagentModel?: ModelRef | null
  }
  autoApprove: boolean
  lastDirectory?: string
  /** Workspaces opened through the picker, most recent first. */
  recentDirectories?: string[]
  /** Workspaces removed from the sidebar (sessions are kept; reopening clears this). */
  hiddenDirectories?: string[]
}

// ---------------------------------------------------------------------------
// Scheduled tasks
// ---------------------------------------------------------------------------

export type ScheduleRepeat =
  | { kind: "daily" }
  | { kind: "weekdays" }
  | { kind: "weekly"; days: number[] }
  | { kind: "monthly"; day: number }
  | { kind: "hourly"; interval: number }
  | { kind: "once"; at: number }

export interface ScheduledTask {
  id: string
  title: string
  /** Final, self-contained instruction (after the clarification step). */
  instruction: string
  originalInstruction?: string
  repeat: ScheduleRepeat
  /** Local time in `timeZone`, HH:mm. Ignored for one-time tasks. */
  time: string
  timeZone: string
  workspace: string
  model?: ModelRef
  /** Show a Windows/Electron notification when the run finishes. */
  notify: boolean
  /** Keep OpenOrch running in the tray so the task can run with the window hidden. */
  background: boolean
  /** Create a new session for each run (on) or reuse the task session (off). */
  newChatEachRun: boolean
  enabled: boolean
  sessionID?: string
  nextRunAt?: number
  lastRunAt?: number
  lastStatus?: "success" | "failed" | "running" | "interrupted" | "paused"
  lastSummary?: string
  lastError?: string
  createdAt: number
  updatedAt: number
}

export interface ScheduledRun {
  id: string
  taskID: string
  taskTitle: string
  sessionID: string
  status: "running" | "success" | "failed" | "interrupted"
  trigger: "schedule" | "manual"
  startedAt: number
  finishedAt?: number
  summary?: string
  error?: string
}

export interface ScheduleDraft {
  title?: string
  instruction: string
  originalInstruction?: string
  repeat: ScheduleRepeat
  time: string
  timeZone: string
  workspace: string
  model?: ModelRef
  notify: boolean
  background: boolean
  newChatEachRun: boolean
  enabled?: boolean
}

export interface ScheduleClarifyQuestion {
  header: string
  question: string
  options?: { label: string; description?: string }[]
  multiple?: boolean
}

export interface ScheduleClarifyInput {
  instruction: string
  model?: ModelRef
  workspace: string
  answers?: { question: string; answer: string }[]
}

export interface ScheduleClarifyResult {
  title: string
  clear: boolean
  questions: ScheduleClarifyQuestion[]
  finalInstruction: string
  error?: string
}

/** UI payload: task + its recent runs. */
export interface ScheduleTaskView {
  task: ScheduledTask
  runs: ScheduledRun[]
}

// ---------------------------------------------------------------------------
// Engine events (main -> renderer)
// ---------------------------------------------------------------------------

export type EngineEvent =
  | { type: "session.created"; session: SessionInfo }
  | { type: "session.updated"; session: SessionInfo }
  | { type: "session.deleted"; sessionID: string }
  | { type: "session.status"; sessionID: string; status: "idle" | "busy" }
  | { type: "message.created"; sessionID: string; message: Message }
  | { type: "message.updated"; sessionID: string; message: Message }
  | { type: "message.deleted"; sessionID: string; messageID: string }
  | { type: "part.created"; sessionID: string; messageID: string; part: Part }
  | { type: "part.delta"; sessionID: string; messageID: string; partID: string; delta: string }
  | { type: "part.updated"; sessionID: string; messageID: string; part: Part }
  | { type: "permission.asked"; request: PermissionRequest }
  | { type: "permission.replied"; sessionID: string; requestID: string; reply: PermissionReply }
  | { type: "question.asked"; request: QuestionRequest }
  | { type: "question.replied"; sessionID: string; requestID: string; answers: QuestionAnswer[] }
  | { type: "schedule.updated"; task: ScheduledTask }
  | { type: "schedule.deleted"; taskID: string }
  | { type: "schedule.run"; run: ScheduledRun; task: ScheduledTask }
  | { type: "config.updated" }
  | { type: "agents.updated" }
  | { type: "providers.updated" }
  | { type: "mcp.updated" }
  | { type: "error"; message: string }

// ---------------------------------------------------------------------------
// IPC API surface (renderer -> main)
// ---------------------------------------------------------------------------

export interface PromptInput {
  text: string
  files?: FileAttachment[]
  /** Skills invoked directly from the `@` menu. */
  skills?: string[]
  delivery?: "steer" | "queue"
}

export interface EngineIPC {
  "config.get": () => Promise<Config>
  "config.set": (patch: Partial<Config>) => Promise<Config>
  "providers.list": () => Promise<ProviderInfo[]>
  "providers.test": (providerID: string, draft?: { apiKey?: string; baseURL?: string }) => Promise<{ ok: boolean; error?: string; models?: number }>
  "providers.disconnect": (providerID: string) => Promise<Config>
  "providers.refreshModels": (providerID: string) => Promise<{ ok: boolean; added: number; total: number; error?: string }>
  "models.list": () => Promise<ModelInfo[]>
  "models.recent": () => Promise<{ recent: ModelRef[]; byDirectory: Record<string, ModelRef>; variant: Record<string, string> }>
  "models.refreshCatalog": () => Promise<{ ok: boolean; models?: number; updatedAt?: number; account?: { active: number }; error?: string }>
  "models.catalogStatus": () => Promise<{ source: "embedded" | "cache" | "live"; updatedAt?: number; account?: { active: number; updatedAt: number } }>
  "agents.list": () => Promise<AgentInfo[]>
  "sessions.list": () => Promise<SessionInfo[]>
  "sessions.create": (input?: { directory?: string; agent?: string }) => Promise<SessionInfo>
  "sessions.delete": (sessionID: string) => Promise<void>
  "sessions.rename": (sessionID: string, title: string) => Promise<void>
  "sessions.setAgent": (sessionID: string, agent: string) => Promise<void>
  "sessions.setModel": (sessionID: string, model: ModelRef) => Promise<void>
  "sessions.messages": (sessionID: string) => Promise<Message[]>
  "sessions.prompt": (sessionID: string, input: PromptInput) => Promise<void>
  "sessions.command": (sessionID: string, command: string) => Promise<void>
  "sessions.interrupt": (sessionID: string) => Promise<void>
  "sessions.compact": (sessionID: string) => Promise<void>
  "permissions.list": (sessionID?: string) => Promise<PermissionRequest[]>
  "permissions.reply": (requestID: string, reply: PermissionReply, message?: string) => Promise<void>
  "permissions.saved": () => Promise<PermissionRule[]>
  "permissions.clearSaved": () => Promise<void>
  "questions.reply": (requestID: string, answers: QuestionAnswer[]) => Promise<void>
  "files.search": (sessionID: string, query: string, limit?: number) => Promise<string[]>
  "files.pick": () => Promise<FileAttachment[]>
  "directory.pick": () => Promise<string | null>
  "skills.list": (sessionID: string) => Promise<SkillInfo[]>
  "skills.read": (sessionID: string, id: string) => Promise<SkillDetail | null>
  "skills.save": (
    sessionID: string,
    draft: { id: string; name?: string; description?: string; content: string },
  ) => Promise<SkillInfo>
  "skills.install": (draft: { id: string; name?: string; description?: string; content: string }) => Promise<SkillInfo>
  "skills.remove": (id: string) => Promise<void>
  "skills.importPick": () => Promise<{ id: string; name?: string; description?: string; content: string } | null>
  "session.directory": (sessionID: string) => Promise<string>
  "terminal.open": (sessionID: string, cols: number, rows: number, shell?: string) => Promise<{ id: string; error?: string }>
  "terminal.shells": () => Promise<{ id: string; name: string; path: string }[]>
  "terminal.list": () => Promise<string[]>
  "terminal.write": (id: string, data: string) => Promise<void>
  "terminal.resize": (id: string, cols: number, rows: number) => Promise<void>
  "terminal.close": (id: string) => Promise<void>
  "app.version": () => Promise<string>
}

export type IPCMethod = keyof EngineIPC
