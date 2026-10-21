import type {
  AgentInfo,
  Config,
  FileAttachment,
  Message,
  ModelInfo,
  ModelRef,
  McpServerStatus,
  PermissionReply,
  PermissionRequest,
  PromptInput,
  ProviderInfo,
  QuestionAnswer,
  QuestionRequest,
  SavedPermissionView,
  ScheduleClarifyInput,
  ScheduleClarifyResult,
  ScheduledRun,
  ScheduledTask,
  ScheduleDraft,
  ScheduleTaskView,
  SessionInfo,
  SkillDetail,
  SkillInfo,
} from "@openorch/shared"

export interface PickedFile {
  path: string
  name: string
  mime: string
  dataUrl?: string
  size: number
}

export type { SkillInfo }

export const api = {
  getConfig: () => window.openorch.invoke("config.get") as Promise<Config>,
  setConfig: (patch: Partial<Config>) => window.openorch.invoke("config.set", patch) as Promise<Config>,
  listProviders: () => window.openorch.invoke("providers.list") as Promise<ProviderInfo[]>,
  testProvider: (providerID: string, draft?: { apiKey?: string; baseURL?: string }) =>
    window.openorch.invoke("providers.test", providerID, draft) as Promise<{ ok: boolean; error?: string; models?: number }>,
  disconnectProvider: (providerID: string) => window.openorch.invoke("providers.disconnect", providerID) as Promise<Config>,
  refreshProviderModels: (providerID: string) =>
    window.openorch.invoke("providers.refreshModels", providerID) as Promise<{ ok: boolean; added: number; total: number; error?: string }>,
  listModels: () => window.openorch.invoke("models.list") as Promise<ModelInfo[]>,
  refreshModelsCatalog: () =>
    window.openorch.invoke("models.refreshCatalog") as Promise<{
      ok: boolean
      models?: number
      updatedAt?: number
      account?: { active: number }
      error?: string
    }>,
  catalogStatus: () =>
    window.openorch.invoke("models.catalogStatus") as Promise<{
      source: "embedded" | "cache" | "live"
      updatedAt?: number
      account?: { active: number; updatedAt: number }
    }>,
  modelPreferences: () =>
    window.openorch.invoke("models.recent") as Promise<{
      recent: ModelRef[]
      byDirectory: Record<string, ModelRef>
      variant: Record<string, string>
    }>,
  listAgents: () => window.openorch.invoke("agents.list") as Promise<AgentInfo[]>,

  listSessions: () => window.openorch.invoke("sessions.list") as Promise<SessionInfo[]>,
  /** Only high-frequency transcript events for this session are forwarded to the UI. */
  watchSession: (sessionID?: string) => window.openorch.invoke("sessions.watch", sessionID) as Promise<void>,
  createSession: (input?: { directory?: string; agent?: string }) =>
    window.openorch.invoke("sessions.create", input) as Promise<SessionInfo>,
  deleteSession: (sessionID: string) => window.openorch.invoke("sessions.delete", sessionID) as Promise<void>,
  renameSession: (sessionID: string, title: string) =>
    window.openorch.invoke("sessions.rename", sessionID, title) as Promise<void>,
  setSessionAgent: (sessionID: string, agent: string) =>
    window.openorch.invoke("sessions.setAgent", sessionID, agent) as Promise<void>,
  setSessionModel: (sessionID: string, model: ModelRef) =>
    window.openorch.invoke("sessions.setModel", sessionID, model) as Promise<void>,
  messages: (sessionID: string) => window.openorch.invoke("sessions.messages", sessionID) as Promise<Message[]>,
  prompt: (sessionID: string, input: PromptInput) =>
    window.openorch.invoke("sessions.prompt", sessionID, input) as Promise<void>,
  command: (sessionID: string, command: string) => window.openorch.invoke("sessions.command", sessionID, command) as Promise<void>,
  interrupt: (sessionID: string) => window.openorch.invoke("sessions.interrupt", sessionID) as Promise<void>,
  compact: (sessionID: string) => window.openorch.invoke("sessions.compact", sessionID) as Promise<void>,
  sessionBusy: (sessionID: string) => window.openorch.invoke("sessions.busy", sessionID) as Promise<boolean>,
  sessionDirectory: (sessionID: string) => window.openorch.invoke("session.directory", sessionID) as Promise<string>,

  pendingPermissions: (sessionID?: string) =>
    window.openorch.invoke("permissions.list", sessionID) as Promise<PermissionRequest[]>,
  replyPermission: (requestID: string, reply: PermissionReply, message?: string) =>
    window.openorch.invoke("permissions.reply", requestID, reply, message) as Promise<void>,
  savedPermissions: () => window.openorch.invoke("permissions.saved") as Promise<SavedPermissionView[]>,
  clearSavedPermissions: () => window.openorch.invoke("permissions.clearSaved") as Promise<void>,
  replyQuestion: (requestID: string, answers: QuestionAnswer[]) =>
    window.openorch.invoke("questions.reply", requestID, answers) as Promise<void>,

  findFiles: (sessionID: string, query: string, limit?: number) =>
    window.openorch.invoke("files.search", sessionID, query, limit) as Promise<string[]>,
  listSkills: (sessionID: string) => window.openorch.invoke("skills.list", sessionID) as Promise<SkillInfo[]>,
  readSkill: (sessionID: string, id: string) => window.openorch.invoke("skills.read", sessionID, id) as Promise<SkillDetail | null>,
  saveSkill: (sessionID: string, draft: { id: string; name?: string; description?: string; content: string }) =>
    window.openorch.invoke("skills.save", sessionID, draft) as Promise<SkillInfo>,
  installSkill: (draft: { id: string; name?: string; description?: string; content: string }) =>
    window.openorch.invoke("skills.install", draft) as Promise<SkillInfo>,
  removeSkill: (id: string) => window.openorch.invoke("skills.remove", id) as Promise<void>,
  importSkillDraft: () =>
    window.openorch.invoke("skills.importPick") as Promise<{ id: string; name?: string; description?: string; content: string } | null>,
  pickFiles: () => window.openorch.invoke("files.pick") as Promise<PickedFile[]>,
  pickDirectory: () => window.openorch.invoke("directory.pick") as Promise<string | null>,
  isDirectory: (target: string) => window.openorch.invoke("path.isDirectory", target) as Promise<boolean>,

  mcpStatus: () => window.openorch.invoke("mcp.status") as Promise<McpServerStatus[]>,
  mcpAuthenticate: (name: string) => window.openorch.invoke("mcp.authenticate", name) as Promise<McpServerStatus | undefined>,
  mcpLogout: (name: string) => window.openorch.invoke("mcp.logout", name) as Promise<void>,
  appVersion: () => window.openorch.invoke("app.version") as Promise<string>,
  openExternal: (url: string) => window.openorch.invoke("shell.openExternal", url) as Promise<void>,

  browserExtension: {
    info: () =>
      window.openorch.invoke("browser.extensionInfo") as Promise<{
        mode: "auto" | "embedded" | "extension"
        connected: boolean
        port: number
        token: string
        browser: string
        version: string
        lastError: string
        tabs: { id: string; url: string; title: string }[]
        extensionPath: string
      }>,
    disconnect: () => window.openorch.invoke("browser.extensionDisconnect") as Promise<void>,
    reset: () => window.openorch.invoke("browser.extensionReset") as Promise<string>,
    openFolder: () => window.openorch.invoke("browser.extensionOpenFolder") as Promise<string | null>,
  },

  schedule: {
    list: () => window.openorch.invoke("schedule.list") as Promise<ScheduledTask[]>,
    view: (taskID: string) => window.openorch.invoke("schedule.view", taskID) as Promise<ScheduleTaskView | null>,
    create: (draft: ScheduleDraft) => window.openorch.invoke("schedule.create", draft) as Promise<ScheduledTask>,
    update: (taskID: string, patch: Partial<ScheduleDraft> & { enabled?: boolean }) =>
      window.openorch.invoke("schedule.update", taskID, patch) as Promise<ScheduledTask>,
    remove: (taskID: string) => window.openorch.invoke("schedule.remove", taskID) as Promise<void>,
    setEnabled: (taskID: string, enabled: boolean) =>
      window.openorch.invoke("schedule.setEnabled", taskID, enabled) as Promise<ScheduledTask>,
    runNow: (taskID: string) => window.openorch.invoke("schedule.runNow", taskID) as Promise<void>,
    clarify: (input: ScheduleClarifyInput) =>
      window.openorch.invoke("schedule.clarify", input) as Promise<ScheduleClarifyResult>,
    runs: (taskID: string) => window.openorch.invoke("schedule.runs", taskID) as Promise<ScheduledRun[]>,
    startup: (enabled: boolean) =>
      window.openorch.invoke("schedule.startup", enabled) as Promise<{ openAtLogin: boolean }>,
    startupStatus: () => window.openorch.invoke("schedule.startupStatus") as Promise<{ openAtLogin: boolean }>,
  },

  terminal: {
    open: (sessionID: string, cols: number, rows: number, shellID?: string) =>
      window.openorch.invoke("terminal.open", sessionID, cols, rows, shellID) as Promise<{ id: string; error?: string }>,
    shells: () =>
      window.openorch.invoke("terminal.shells") as Promise<{ id: string; name: string; path: string }[]>,
    list: () => window.openorch.invoke("terminal.list") as Promise<string[]>,
    write: (id: string, data: string) => window.openorch.invoke("terminal.write", id, data) as Promise<void>,
    resize: (id: string, cols: number, rows: number) => window.openorch.invoke("terminal.resize", id, cols, rows) as Promise<void>,
    close: (id: string) => window.openorch.invoke("terminal.close", id) as Promise<void>,
  },
}

export type { FileAttachment, QuestionRequest }
