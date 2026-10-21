import path from "node:path"
import os from "node:os"
import { existsSync, readdirSync, statSync, watch } from "node:fs"
import type {
  AgentInfo,
  AssistantMessage,
  Config,
  EngineEvent,
  FileAttachment,
  McpServerConfig,
  McpServerStatus,
  Message,
  ModelInfo,
  ModelRef,
  PermissionReply,
  PermissionRequest,
  PermissionRule,
  PromptInput,
  ProviderInfo,
  QuestionAnswer,
  QuestionRequest,
  ScheduleClarifyInput,
  ScheduleClarifyResult,
  ScheduleClarifyQuestion,
  SessionInfo,
  TokenUsage,
  ToolPart,
} from "@openorch/shared"
import { stepCountIs, streamText, type ModelMessage } from "ai"
import {
  AgentRegistry,
  MAX_STEPS_PROMPT,
  PLAN_DIRECTORY,
  composeSystemPrompt,
  planEnterReminder,
  planLeaveReminder,
  type AgentDef,
} from "./agents/index.js"
import { ConfigStore } from "./config.js"
import { McpManager, mergeMcpServers, type McpServerEntry } from "./mcp.js"
import {
  PermissionBlockedError,
  PermissionDeclinedError,
  PermissionEngine,
  PermissionRejectedError,
} from "./permissions.js"
import {
  createLanguageModel,
  listModels,
  listProviders,
  lookupModel,
  minimalVariant,
  pickCheapModel,
  pickSmallModel,
  resolveProvider,
  setConsoleAccount,
  setLiveCatalog,
  variantOptions,
  type ProviderRuntime,
} from "./providers/index.js"
import { CATALOG_TTL_MS, fetchModelsCatalog, loadCatalogCache, type CatalogStatus } from "./providers/models-dev.js"
import { CONSOLE_TTL_MS, consoleActiveCount, fetchConsoleConfig, loadConsoleConfig, type ConsoleAccountConfig } from "./providers/console-config.js"
import { ModelPreferenceStore, modelKey } from "./model-prefs.js"
import { searchWeb as searchProviderWeb } from "./websearch.js"
import { toModelMessages, lastAssistantText } from "./session/history.js"
import { SessionStore } from "./session/store.js"
import { openDataDatabase } from "./storage.js"
import { skillContent, globalSkillsDirectory, installGlobalSkill, readSkillDetail, readSkillDraft, removeGlobalSkill, writeSkill, openorchConfigDirectory } from "./skills.js"
import {
  agentsFilesUpwards,
  discoverSkills,
  environmentBlock,
  globalAgentsFile,
  readAgentsFile,
  renderInstructions,
  skillsInstructions,
  type InstructionEntry,
  type SkillDetail,
  type SkillInfo,
} from "./skills.js"
import { TerminalManager } from "./terminal.js"
import { ScheduleManager } from "./schedule.js"
import { WorktreeManager } from "./worktree.js"
import { buildTools, type ToolDefinition } from "./tools/index.js"
import { BROWSER_PROTOCOL } from "./tools/browser-challenge.js"
import { effectiveName, ToolFailure, type BrowserService, type ToolContent, type ToolContext, type ToolServices } from "./tools/types.js"
import { buildCatalog, createExecuteTool, renderCodeModeInstructions, type CatalogEntry } from "./codemode.js"
import { killAllJobs } from "./tools/shell.js"
import { evaluate } from "./permissions.js"
import { estimateTokens, ensureDir, home, id, readJson } from "./util.js"

const MAX_STEPS_SAFETY = 500
/** Reasoning/answer step cap shared by the runner and tests. */
export function stepLimitReached(agent: { steps?: number }, step: number): boolean {
  return (agent.steps !== undefined && step >= agent.steps) || step >= MAX_STEPS_SAFETY - 1
}

/**
 * Alternate `/models` endpoints for OpenCode's own providers: the new official
 * base URLs (…/inference/…) do not expose the listing, but the legacy zen ones do.
 */
export function modelListFallbacks(providerID: string, baseURL: string): string[] {
  if (!/opencode\.ai\//.test(baseURL)) return []
  if (providerID === "opencode-go") return ["https://opencode.ai/zen/go/v1/models"]
  if (providerID === "opencode") return ["https://opencode.ai/zen/v1/models"]
  return []
}
const COMPACTION_RESERVE_MIN = 16_000
const IMAGE_TOKEN_ESTIMATE = 1_500
const STREAM_RETRIES = 3
/** Streaming coalescing: token deltas are batched before hitting the store/IPC. */
const DELTA_FLUSH_MS = 40
const TOOL_INPUT_FLUSH_MS = 120
/** After each "too long" rejection, later attempts aim at this share of the previous budget. */
const SHRINK_STEPS = [0.7, 0.5, 0.35]

const SUMMARY_TEMPLATE = `You MUST use this format for your response (you may omit sections that aren't applicable). Do not include the <template> tags in your response.
<template>
## Objective
- [one or two brief sentences describing what the user is trying to accomplish]

## Requirements
- [constraints, preferences, requirements, and scope boundaries stated by the user, or "(none)"]

## Decisions
- [decisions already made and why, or "(none)"]

## Work State
Break the objective into smaller goals and report which are completed, which are being worked on, and which are blocked.
### Completed
- [goals that have been completed; otherwise "(none)"]

### Active
- [goals currently being worked on; otherwise "(none)"]

### Blocked
- [anything blocking progress, and why; otherwise "(none)"]

## Next Move
1. [ordered list of next actions, or "(none)"]

## Relevant Files
List the files and directories, other than the current working directory, that another agent would need to open to continue this work. Include at most 15, most important first. Do not list every file that was read or changed. Include paths outside the current working directory when relevant. If none, write "(none)".
- \`[file or directory path]\`: [brief reason it matters]

## Important Context
- [facts the next agent cannot continue without and cannot easily find on its own; or "(none)"]
</template>`

const SUMMARY_RULES = `Rules:
- Keep each section concise. Use terse, single-line bullets, not prose paragraphs or nested lists.
- Prefer short references over detailed restatement. It is fine to leave out information the next agent can recover from the code or the files listed above.
- Preserve exact file paths, symbols, commands, error strings, URLs, and identifiers.
- Carry forward only user questions or requests that remain unanswered or require further action. Do not repeat ones that newer history has answered or resolved. Preserve exact wording when carrying one forward.
- Preserve consequential workflow state, including whether changes are uncommitted, committed, pushed, under review, or merged.
- Do not mention the summary process or that context was compacted.`

export function buildCompactionPrompt(update: boolean): string {
  const shared = [
    "Summarize only what the user and the assistant said and did. Leave out instructions and setup the assistant was given rather than told by the user: repository conventions, instruction files such as AGENTS.md, and environment details like the session ID. The next agent receives current versions of all of these separately.",
    SUMMARY_TEMPLATE,
    SUMMARY_RULES,
    "Do not continue the task or call tools.",
    "Return only the structured summary in the requested format. Do not include a preamble, explanation, or other commentary.",
  ]
  if (!update) {
    return [
      "You MUST summarize the conversation above into a structured summary that will be given to another agent to resume the work.",
      ...shared,
    ].join("\n\n")
  }
  return [
    "Update the existing checkpoint in the conversation above into one consolidated summary.",
    "Newer history always takes precedence over the existing checkpoint. Preserve previous information unless newer history clearly contradicts, supersedes, resolves, or makes it stale. If something is no longer relevant to continuing the work, you may remove it.",
    "Incorporate newer requirements, decisions, progress, and context. Reconcile Work State and Next Move: move completed work out of Active, remove resolved blockers and answered questions, and preserve unresolved or pending work.",
    "Return only the updated Markdown sections. Do not reproduce the `<conversation-checkpoint>`, `<summary>`, or `<recent-context>` wrapper tags from the previous checkpoint.",
    ...shared,
  ].join("\n\n")
}

const COMPACTION_NUDGE =
  "The previous response did not fill in the required summary template. Do not call tools. Return the summary as text using the exact section headings from the template."

interface InboxItem {
  id: string
  type: "user" | "synthetic" | "compaction" | "shell"
  delivery?: "steer" | "queue"
  text?: string
  files?: FileAttachment[]
  skills?: string[]
  command?: string
  resume?: boolean
  description?: string
  metadata?: Record<string, unknown>
}

interface RunState {
  running: boolean
  abort?: AbortController
  inbox: InboxItem[]
  declined?: boolean
}

export interface EngineOptions {
  dataDir: string
  projectDirectory: string
  emit: (event: EngineEvent) => void
  log?: (message: string) => void
  /** Opens a URL in the user's browser (MCP OAuth); the app wires this to shell.openExternal. */
  openUrl?: (url: string) => void
  /** Desktop browser bridge for the right-dock browser tools. */
  browser?: BrowserService
}

export class Engine {
  readonly options: EngineOptions
  readonly configStore: ConfigStore
  readonly store: SessionStore
  readonly agents: AgentRegistry
  readonly permissions: PermissionEngine
  readonly mcp: McpManager
  readonly terminal: TerminalManager
  readonly worktrees: WorktreeManager
  readonly schedule: ScheduleManager
  readonly modelPrefs: ModelPreferenceStore
  readonly dataDir: string
  readonly storage: "sqlite" | "json"
  projectDirectory: string
  private states = new Map<string, RunState>()
  private instructionEntries = new Map<string, InstructionEntry[]>()
  private loadedAgentFiles = new Map<string, Set<string>>()
  private pendingQuestions = new Map<string, { resolve: (answers: QuestionAnswer[]) => void; request: QuestionRequest }>()
  private persistenceTimers = new Map<string, NodeJS.Timeout>()
  private configWatcher: ReturnType<typeof watch> | undefined
  private projectWatchers: ReturnType<typeof watch>[] = []
  /** Bumped when a streamed message is committed; stale buffered deltas are dropped. */
  private streamGeneration = new Map<string, number>()
  /** Consecutive overflow compaction attempts per session (drives SHRINK_STEPS). */
  private overflowShrink = new Map<string, number>()
  /** Sessions currently executing a scheduled task (unattended permission policy). */
  private scheduledSessions = new Set<string>()
  /** Models that failed a title request (skipped for the rest of the process). */
  private failedTitleModels = new Set<string>()
  /** Origin of the active models catalog (embedded snapshot, disk cache, or live models.dev). */
  private catalogSource: CatalogStatus["source"] = "embedded"
  private catalogUpdatedAt: number | undefined
  /** OpenCode Console account config timestamp (active models per provider). */
  private consoleUpdatedAt: number | undefined
  private consoleConfig: ConsoleAccountConfig | undefined
  private emit: (event: EngineEvent) => void
  private log: (message: string) => void

  constructor(options: EngineOptions) {
    this.options = options
    this.dataDir = options.dataDir
    this.projectDirectory = options.projectDirectory
    this.emit = options.emit
    this.log = options.log ?? (() => undefined)
    ensureDir(this.dataDir)
    this.configStore = new ConfigStore(this.dataDir)
    const db = openDataDatabase(this.dataDir)
    this.store = new SessionStore(this.dataDir, db)
    this.modelPrefs = new ModelPreferenceStore(this.dataDir)
    this.storage = this.store.kind
    this.agents = new AgentRegistry(this.configStore.get(), this.projectDirectory)
    this.permissions = new PermissionEngine(
      this.dataDir,
      this.configStore.get(),
      {
        onAsk: (request) => this.emit({ type: "permission.asked", request }),
        onReply: (sessionID, requestID, reply) => this.emit({ type: "permission.replied", sessionID, requestID, reply }),
      },
      db,
      this.managedPermissionRules(),
    )
    this.mcp = new McpManager(
      { dataDir: options.dataDir, openUrl: options.openUrl },
      (status) => {
        this.emit({ type: "mcp.updated" })
        this.log(`mcp: ${status}`)
      },
    )
    this.terminal = new TerminalManager()
    this.worktrees = new WorktreeManager(() => this.configStore.get().worktree.directory)
    this.schedule = new ScheduleManager({
      dataDir: this.dataDir,
      db,
      emit: (event) => this.emit(event),
      log: (message) => this.log(message),
      config: () => this.configStore.get(),
      createSession: (input) => this.createSession(input),
      renameSession: (sessionID, title) => this.renameSession(sessionID, title),
      setSessionModel: (sessionID, ref) => this.setSessionModel(sessionID, ref),
      prompt: (sessionID, input) => this.prompt(sessionID, input),
      isBusy: (sessionID) => this.isBusy(sessionID),
      waitIdle: (sessionID) => this.waitIdle(sessionID),
      interrupt: (sessionID) => this.interrupt(sessionID),
      messages: (sessionID) => this.messages(sessionID),
      sessionExists: (sessionID) => Boolean(this.store.get(sessionID)),
      defaultModel: (directory) => this.defaultModelRef(directory),
      setScheduled: (sessionID, scheduled) => {
        if (scheduled) this.scheduledSessions.add(sessionID)
        else this.scheduledSessions.delete(sessionID)
      },
      releaseSession: (sessionID) => this.releaseSession(sessionID),
      clarify: (input) => this.clarifySchedule(input),
    })
    this.startConfigWatch()
  }

  /** The workspace the user is working in (project MCP files come from here). */
  private workspaceDirectory(): string {
    return this.configStore.get().lastDirectory ?? this.projectDirectory
  }

  /** Global servers plus the project's `.opencode/mcp.json` / `.openorch/mcp.json` (native wins). */
  private effectiveMcpServers(): Record<string, McpServerEntry> {
    const workspace = this.workspaceDirectory()
    const projectFiles = [
      readJson<Record<string, McpServerConfig>>(path.join(workspace, ".opencode", "mcp.json"), {}),
      readJson<Record<string, McpServerConfig>>(path.join(workspace, ".openorch", "mcp.json"), {}),
    ]
    return mergeMcpServers(this.configStore.get().mcp, projectFiles)
  }

  /** Recomputes the server set (config + project files) and reconnects everything. */
  private async refreshMcp(): Promise<void> {
    this.mcp.updateServers(this.effectiveMcpServers())
    this.watchProjectMcp()
    await this.mcp.connectAll().catch((error) => this.log(`mcp reconnect failed: ${String(error)}`))
  }

  /** Watches the project MCP files so edits apply live too. */
  private watchProjectMcp(): void {
    for (const watcher of this.projectWatchers.splice(0)) watcher.close()
    const workspace = this.workspaceDirectory()
    for (const dir of [path.join(workspace, ".openorch"), path.join(workspace, ".opencode")]) {
      if (!existsSync(dir)) continue
      try {
        let timer: ReturnType<typeof setTimeout> | undefined
        this.projectWatchers.push(
          watch(dir, (_event, filename) => {
            if (filename && String(filename) !== "mcp.json") return
            if (timer) clearTimeout(timer)
            timer = setTimeout(() => {
              timer = undefined
              void this.refreshMcp()
            }, 250)
          }),
        )
      } catch {
        // Watching is best effort.
      }
    }
  }

  /** Watches config.json so external edits (agents, editors) apply without a restart. */
  private startConfigWatch(): void {
    try {
      let timer: ReturnType<typeof setTimeout> | undefined
      this.configWatcher = watch(this.configStore.path(), () => {
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => {
          timer = undefined
          void this.applyExternalConfig()
        }, 250)
      })
    } catch {
      // Watching is best effort: without it, config changes still apply via the UI/IPC.
    }
  }

  private async applyExternalConfig(): Promise<void> {
    try {
      const previous = this.configStore.get()
      const previousMcp = JSON.stringify(previous.mcp)
      const previousDirectory = previous.lastDirectory
      const next = this.configStore.reload()
      // Our own writes reload to the same value: nothing to do.
      if (JSON.stringify(next) === JSON.stringify(previous)) return
      this.agents.reload(this.projectDirectory)
      this.permissions.updateConfig(next)
      if (JSON.stringify(next.mcp) !== previousMcp || next.lastDirectory !== previousDirectory) {
        await this.refreshMcp()
      }
      this.emit({ type: "config.updated" })
      this.emit({ type: "agents.updated" })
      this.emit({ type: "providers.updated" })
      this.log("config reloaded from disk")
    } catch (error) {
      this.log(`config reload failed: ${String(error)}`)
    }
  }

  /**
   * Directories the app itself owns (session data, temporary files, OpenOrch's
   * global config): external access to them never asks, mirroring upstream, which
   * pre-allows its managed tool-output, temporary, and global configuration dirs.
   */
  private managedPermissionRules(): PermissionRule[] {
    const allow = (directory: string): PermissionRule => ({
      action: "external_directory",
      resource: path.join(directory, "*"),
      effect: "allow",
    })
    return [allow(this.dataDir), allow(os.tmpdir()), allow(openorchConfigDirectory())]
  }

  async init(): Promise<void> {
    await this.refreshMcp().catch((error) => this.log(`mcp init failed: ${String(error)}`))
    // Live models.dev catalog (like upstream): apply the cache instantly and refresh
    // in the background when it is stale, so new models and their real reasoning
    // levels show up without rebuilding the app.
    const cached = loadCatalogCache(this.dataDir)
    if (cached) {
      setLiveCatalog(cached.providers)
      this.catalogSource = "cache"
      this.catalogUpdatedAt = cached.fetchedAt
    }
    if (!cached || Date.now() - cached.fetchedAt > CATALOG_TTL_MS) {
      void this.refreshModelsCatalog().catch((error) => this.log(`models.dev refresh failed: ${String(error)}`))
    }
    // OpenCode Console account config: the account's real active models per provider.
    const consoleCache = loadConsoleConfig(this.dataDir)
    if (consoleCache) {
      setConsoleAccount(consoleCache)
      this.consoleConfig = consoleCache
      this.consoleUpdatedAt = consoleCache.fetchedAt
    }
    if (this.consoleKey() && (!consoleCache || Date.now() - consoleCache.fetchedAt > CONSOLE_TTL_MS)) {
      void this.refreshConsoleAccount().catch((error) => this.log(`console config refresh failed: ${String(error)}`))
    }
    // Refresh the model list of connected providers in the background (first boot / new keys).
    for (const provider of listProviders(this.configStore.get()).filter((entry) => entry.configured)) {
      void this.refreshProviderModels(provider.id).catch(() => undefined)
    }
    this.schedule.start()
  }

  /** Removes a provider's stored credential/settings (disconnect). */
  disconnectProvider(providerID: string): Config {
    const next = this.configStore.replaceProvider(providerID, undefined)
    this.agents.reload(this.projectDirectory)
    this.permissions.updateConfig(next)
    this.emit({ type: "config.updated" })
    this.emit({ type: "providers.updated" })
    return next
  }

  /**
   * Downloads the live models.dev catalog (the same source upstream opencode uses)
   * and applies it on top of the bundled baseline. Fixes stale catalogs: new API
   * models and their real reasoning levels appear without recompiling. Also
   * refreshes the OpenCode Console account config when a key is connected.
   */
  async refreshModelsCatalog(): Promise<{ ok: boolean; models?: number; updatedAt?: number; account?: { active: number }; error?: string }> {
    const result = await fetchModelsCatalog({ dataDir: this.dataDir })
    if (!result.ok) {
      this.log(`models.dev refresh failed: ${result.error}`)
      return { ok: false, error: result.error }
    }
    setLiveCatalog(result.providers)
    this.catalogSource = "live"
    this.catalogUpdatedAt = result.fetchedAt
    this.emit({ type: "providers.updated" })
    this.log(`models.dev catalog refreshed: ${result.models} models from ${result.url}`)
    const account = await this.refreshConsoleAccount().catch(() => undefined)
    return { ok: true, models: result.models, updatedAt: result.fetchedAt, ...(account ? { account } : {}) }
  }

  /** API key of a provider attached to the OpenCode Console (opencode / opencode-go). */
  private consoleKey(): string | undefined {
    const config = this.configStore.get()
    for (const providerID of ["opencode-go", "opencode"]) {
      const runtime = resolveProvider(config, providerID)
      const key = runtime?.apiKey ?? config.providers[providerID]?.apiKey
      if (key && config.providers[providerID]?.enabled !== false) return key
    }
    return undefined
  }

  /** Downloads the account's real model list from the OpenCode Console. */
  async refreshConsoleAccount(): Promise<{ active: number; updatedAt: number } | undefined> {
    const apiKey = this.consoleKey()
    if (!apiKey) return undefined
    const result = await fetchConsoleConfig({ dataDir: this.dataDir, apiKey })
    if (!result.ok) {
      this.log(`console config refresh failed: ${result.error}`)
      return undefined
    }
    setConsoleAccount(result.config)
    this.consoleConfig = result.config
    this.consoleUpdatedAt = result.config.fetchedAt
    this.emit({ type: "providers.updated" })
    const active = consoleActiveCount(result.config)
    this.log(`console account refreshed: ${active} active models`)
    return { active, updatedAt: result.config.fetchedAt }
  }

  /** Where the active models catalog came from (embedded snapshot, cache, or live). */
  catalogStatus(): CatalogStatus {
    return {
      source: this.catalogSource,
      updatedAt: this.catalogUpdatedAt,
      ...(this.consoleUpdatedAt
        ? { account: { active: consoleActiveCount(this.consoleConfig), updatedAt: this.consoleUpdatedAt } }
        : {}),
    }
  }

  /**
   * Asks the provider's `/models` endpoint for the models it currently serves and
   * remembers the ones the catalog does not list. Upstream relies on models.dev;
   * this covers gateways that expose extra models at runtime.
   */
  async refreshProviderModels(providerID: string): Promise<{ ok: boolean; added: number; total: number; error?: string }> {
    const config = this.configStore.get()
    const provider = listProviders(config).find((entry) => entry.id === providerID)
    if (!provider) return { ok: false, added: 0, total: 0, error: `Unknown provider: ${providerID}` }
    const baseURL = provider.baseURL
    if (!baseURL) return { ok: false, added: 0, total: 0, error: `Provider ${providerID} has no base URL` }
    const settings = config.providers[providerID] ?? {}
    const runtime = resolveProvider(config, providerID)
    const headers = {
      accept: "application/json",
      ...(runtime?.apiKey ? { authorization: `Bearer ${runtime.apiKey}` } : {}),
      ...(runtime?.headers ?? {}),
    }
    try {
      // Some gateways moved their listing: the new OpenCode endpoints (inference/…)
      // answer 404 for /models while the legacy zen endpoints still serve it.
      const urls = [`${baseURL.replace(/\/+$/, "")}/models`, ...modelListFallbacks(providerID, baseURL)]
      let response: Response | undefined
      let lastError = ""
      for (const url of urls) {
        let attempt: Response
        try {
          attempt = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) })
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error)
          continue
        }
        if (attempt.ok) {
          response = attempt
          break
        }
        lastError = `HTTP ${attempt.status}`
        if (attempt.status !== 404 && attempt.status !== 405) break
      }
      if (!response) {
        const friendly =
          lastError === "HTTP 404" || lastError === "HTTP 405"
            ? "Este proveedor no expone /models; sus modelos se actualizan con el catálogo (models.dev + Console)."
            : lastError
        return { ok: false, added: 0, total: 0, error: friendly }
      }
      const data = (await response.json()) as { data?: { id?: unknown }[] }
      const ids = (data.data ?? [])
        .map((entry) => entry?.id)
        .filter((value): value is string => typeof value === "string" && value.length > 0)
      const known = new Set(provider.models.map((model) => model.id))
      const discovered = [...new Set(ids.filter((idValue) => !known.has(idValue)))]
      if (discovered.length > 0) {
        const models = [...new Set([...(settings.models ?? []), ...discovered])]
        this.configStore.replaceProvider(providerID, { ...settings, models })
        this.emit({ type: "providers.updated" })
      }
      return { ok: true, added: discovered.length, total: ids.length }
    } catch (error) {
      return { ok: false, added: 0, total: 0, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async shutdown(): Promise<void> {
    this.schedule.stop()
    killAllJobs()
    this.configWatcher?.close()
    this.configWatcher = undefined
    for (const watcher of this.projectWatchers.splice(0)) watcher.close()
    await this.mcp.closeAll().catch(() => undefined)
    this.terminal.closeAll()
  }

  // -------------------------------------------------------------------------
  // Config / providers / agents
  // -------------------------------------------------------------------------

  getConfig(): Config {
    return this.configStore.get()
  }

  async setConfig(patch: Partial<Config>): Promise<Config> {
    const previous = this.configStore.get()
    const next = this.configStore.set(patch)
    this.agents.reload(this.projectDirectory)
    this.permissions.updateConfig(next)
    // MCP servers: reconnect when the entries change or the workspace moves (project files).
    if (JSON.stringify(previous.mcp) !== JSON.stringify(next.mcp) || previous.lastDirectory !== next.lastDirectory) {
      await this.refreshMcp()
    }
    this.emit({ type: "config.updated" })
    this.emit({ type: "agents.updated" })
    this.emit({ type: "providers.updated" })
    return next
  }

  /** Installs/updates an MCP server from the agent (mcp tool) and reconnects live. */
  async mcpAdd(name: string, server: McpServerConfig): Promise<McpServerStatus> {
    const clean = name.trim()
    if (!clean) throw new ToolFailure("An MCP server needs a name.")
    this.configStore.replaceMcpServer(clean, server)
    await this.refreshMcp()
    const status = this.mcp.status().find((entry) => entry.name === clean) ?? {
      name: clean,
      status: "error" as const,
      tools: 0,
      toolNames: [],
      scope: "global" as const,
    }
    this.log(`mcp added: ${clean} (${status.status})`)
    this.emit({ type: "mcp.updated" })
    this.emit({ type: "config.updated" })
    return status
  }

  /** Removes an MCP server from the agent (mcp tool) and reconnects live. */
  async mcpRemove(name: string): Promise<void> {
    const clean = name.trim()
    if (!clean) throw new ToolFailure("An MCP server needs a name.")
    this.configStore.replaceMcpServer(clean, undefined)
    await this.refreshMcp()
    this.log(`mcp removed: ${clean}`)
    this.emit({ type: "mcp.updated" })
    this.emit({ type: "config.updated" })
  }

  /** Runs the browser OAuth flow for a remote MCP server (Settings → MCP). */
  async mcpAuthenticate(name: string): Promise<McpServerStatus | undefined> {
    const status = await this.mcp.authenticate(name.trim())
    this.emit({ type: "mcp.updated" })
    return status
  }

  /** Forgets stored OAuth tokens for a server. */
  async mcpLogout(name: string): Promise<void> {
    await this.mcp.logout(name.trim())
    this.emit({ type: "mcp.updated" })
  }

  listProviders(): ProviderInfo[] {
    return listProviders(this.configStore.get())
  }

  async testProvider(providerID: string, draft?: { apiKey?: string; baseURL?: string }): Promise<{ ok: boolean; error?: string; models?: number }> {
    const config = this.configStore.get()
    const resolved = resolveProvider(config, providerID)
    if (!resolved) return { ok: false, error: `Unknown provider: ${providerID}` }
    const runtime = {
      ...resolved,
      apiKey: draft?.apiKey !== undefined && draft.apiKey !== "" ? draft.apiKey : resolved.apiKey,
      baseURL: draft?.baseURL !== undefined && draft.baseURL !== "" ? draft.baseURL : resolved.baseURL,
    }
    if (!runtime.apiKey && runtime.kind !== "openai-compatible") {
      return { ok: false, error: `Missing API key for ${runtime.name}` }
    }
    try {
      let models = listProviders(config).find((provider) => provider.id === providerID)?.models ?? []
      let testModelID = (models.find((model) => model.toolCall) ?? models[0])?.id
      if (!testModelID) {
        // The catalog/Console may not expose a model list yet (e.g. an empty
        // account filter). Ask the provider's /models endpoint before failing;
        // this is also the only way to test a freshly typed API key.
        if (!runtime.baseURL) return { ok: false, error: `Provider ${providerID} has no base URL` }
        const urls = [`${runtime.baseURL.replace(/\/+$/, "")}/models`, ...modelListFallbacks(providerID, runtime.baseURL)]
        const headers = {
          accept: "application/json",
          ...(runtime.apiKey ? { authorization: `Bearer ${runtime.apiKey}` } : {}),
          ...(runtime.headers ?? {}),
        }
        let lastError = ""
        for (const url of urls) {
          try {
            const response = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) })
            if (!response.ok) {
              lastError = `HTTP ${response.status} (${url})`
              continue
            }
            const payload = (await response.json()) as { data?: { id?: unknown }[] } | { id?: unknown }[]
            const entries = Array.isArray(payload) ? payload : payload.data ?? []
            const ids = entries
              .map((entry) => (entry && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "string" ? (entry as { id: string }).id : ""))
              .filter(Boolean)
            if (ids.length > 0) {
              models = ids.map((id) => ({ id, providerID, name: id }))
              testModelID = ids[0]
              break
            }
            lastError = `The /models response had no model ids (${url})`
          } catch (error) {
            lastError = error instanceof Error ? error.message : String(error)
          }
        }
        if (!testModelID) {
          return {
            ok: false,
            error: `No models available${lastError ? ` — ${lastError}` : ""}. Comprueba la URL base o actualiza el catálogo.`,
          }
        }
      }
      const result = streamText({
        model: createLanguageModel(runtime, testModelID),
        prompt: "Reply with the single word: ok",
        maxOutputTokens: 128,
        abortSignal: AbortSignal.timeout(45_000),
        headers: {
          "x-opencode-session": "ses_provider_test",
          "x-opencode-session-id": "ses_provider_test",
          "x-session-affinity": "ses_provider_test",
          "X-Session-Id": "ses_provider_test",
          "x-opencode-client": "openorch",
          "user-agent": "openorch/0.1.0",
          ...(runtime.headers ?? {}),
        },
      })
      await result.consumeStream()
      const text = (await result.text).trim()
      return { ok: true, models: models.length, error: text ? undefined : "Empty response" }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  listModels(): ModelInfo[] {
    return listModels(this.configStore.get())
  }

  listAgents(): AgentInfo[] {
    return this.agents.list().map((agent) => this.agents.toInfo(agent))
  }

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  listSessions(): SessionInfo[] {
    return this.store.list()
  }

  /**
   * Default model for a new session, mirroring upstream's TUI precedence:
   * config → last model used in this directory → most recent model → cheapest.
   */
  defaultModelRef(directory?: string): ModelRef | undefined {
    const config = this.configStore.get()
    const available = new Set(listModels(config).map((model) => modelKey(model)))
    const valid = (ref: ModelRef | undefined): ModelRef | undefined => {
      if (!ref) return undefined
      if (!available.has(modelKey(ref))) return undefined
      const model = listModels(config).find((entry) => modelKey(entry) === modelKey(ref))
      const variant = ref.variant && (model?.variants ?? []).includes(ref.variant) ? ref.variant : undefined
      return { providerID: ref.providerID, modelID: ref.modelID, ...(variant ? { variant } : {}) }
    }
    const configured = valid(config.model)
    if (configured) return configured
    const remembered = valid(directory ? this.modelPrefs.forDirectory(directory) : undefined)
    if (remembered) return remembered
    for (const recent of this.modelPrefs.recent()) {
      const found = valid(recent)
      if (found) return found
    }
    const cheap = pickCheapModel(config)
    if (!cheap) return undefined
    return { providerID: cheap.providerID, modelID: cheap.id }
  }

  createSession(input?: { directory?: string; agent?: string; parentID?: string; model?: ModelRef }): SessionInfo {
    const config = this.configStore.get()
    const directory = input?.directory ?? config.lastDirectory ?? this.projectDirectory
    // Children pass their model explicitly; otherwise restore the remembered default.
    const model = input?.model !== undefined ? input.model : this.defaultModelRef(directory)
    const info: SessionInfo = {
      id: id("ses"),
      title: "",
      directory,
      agent: input?.agent ?? "build",
      model: model ? { ...model } : undefined,
      parentID: input?.parentID,
      time: { created: Date.now(), updated: Date.now() },
    }
    this.store.put({ info, messages: [] })
    if (input?.directory) this.rememberDirectory(input.directory)
    this.store.save(info.id)
    // Upstream appends the Plan reminder when a session is created in Plan mode.
    if (info.agent === "plan") this.appendPlanReminder(info.id, "plan")
    this.emit({ type: "session.created", session: info })
    return info
  }

  deleteSession(sessionID: string): void {
    this.interrupt(sessionID)
    this.store.remove(sessionID)
    this.states.delete(sessionID)
    this.emit({ type: "session.deleted", sessionID })
  }

  renameSession(sessionID: string, title: string): void {
    const record = this.store.get(sessionID)
    if (!record) return
    record.info.title = title
    this.touch(record.info)
    this.persist(sessionID, true)
    this.emit({ type: "session.updated", session: record.info })
  }

  setSessionAgent(sessionID: string, agentID: string): void {
    const record = this.store.get(sessionID)
    if (!record) return
    const agent = this.agents.resolve(agentID)
    const previous = record.info.agent
    if (previous === agent.id) return
    record.info.agent = agent.id
    this.touch(record.info)
    this.persist(sessionID, true)
    this.emit({ type: "session.updated", session: record.info })
    // Plan mode reminders (mirrors upstream plan plugin behavior). They carry
    // metadata so the UI hides them; the model still receives the full text.
    if (agent.id === "plan") {
      this.appendPlanReminder(sessionID, "plan")
    } else if (previous === "plan") {
      this.appendPlanReminder(sessionID, "build")
    }
  }

  /** Persists the Plan/Build system reminder (hidden in the UI, sent to the model). */
  private appendPlanReminder(sessionID: string, mode: "plan" | "build"): void {
    this.appendMessage(sessionID, {
      id: id("msg"),
      sessionID,
      role: "synthetic",
      text: mode === "plan" ? planEnterReminder() : planLeaveReminder(),
      description: mode === "plan" ? "Plan mode" : "Build mode",
      metadata: { source: "plan", hidden: true },
      time: { created: Date.now() },
    })
  }

  /**
   * Mirrors upstream's plan plugin `context` hook: keep the latest Plan/Build
   * reminder consistent with the session's agent. Compaction or interrupted
   * switches can strip or stale it, and the model must see the current mode
   * near the tail of the request.
   */
  private reconcilePlanMode(sessionID: string, agent: AgentDef): void {
    const record = this.store.get(sessionID)
    if (!record) return
    const enter = planEnterReminder()
    const leave = planLeaveReminder()
    let last: "enter" | "leave" | undefined
    for (let i = record.messages.length - 1; i >= 0; i--) {
      const message = record.messages[i]
      if (message.role !== "synthetic") continue
      if (message.text === enter) {
        last = "enter"
        break
      }
      if (message.text === leave) {
        last = "leave"
        break
      }
    }
    if (agent.id === "plan" && last !== "enter") this.appendPlanReminder(sessionID, "plan")
    else if (agent.id !== "plan" && last === "enter") this.appendPlanReminder(sessionID, "build")
  }

  /** Remembers a workspace directory: last used plus the recents list for the picker. */
  private rememberDirectory(directory: string): void {
    const config = this.configStore.get()
    const recent = [directory, ...(config.recentDirectories ?? []).filter((entry) => entry !== directory)].slice(0, 12)
    this.configStore.set({
      ...(directory !== config.lastDirectory ? { lastDirectory: directory } : {}),
      recentDirectories: recent,
    })
  }

  setSessionModel(sessionID: string, ref: ModelRef): void {
    const record = this.store.get(sessionID)
    if (!record) return
    const config = this.configStore.get()
    const model = lookupModel(config, ref.providerID, ref.modelID)
    // Drop variants the target model does not support.
    const variant = ref.variant && (model?.variants ?? []).includes(ref.variant) ? ref.variant : undefined
    const next: ModelRef = { providerID: ref.providerID, modelID: ref.modelID, ...(variant ? { variant } : {}) }
    record.info.model = next
    this.modelPrefs.remember(next, record.info.directory)
    this.modelPrefs.setVariant(next, variant)
    this.touch(record.info)
    this.persist(sessionID, true)
    this.emit({ type: "session.updated", session: record.info })
  }

  /** Recents, per-directory last model and last variant per model (for the picker UI). */
  modelPreferences(): { recent: ModelRef[]; byDirectory: Record<string, ModelRef>; variant: Record<string, string> } {
    return this.modelPrefs.get()
  }

  messages(sessionID: string): Message[] {
    return this.store.get(sessionID)?.messages ?? []
  }

  sessionDirectory(sessionID: string): string {
    return this.store.get(sessionID)?.info.directory ?? this.projectDirectory
  }

  private touch(info: SessionInfo): void {
    info.time.updated = Date.now()
  }

  private persist(sessionID: string, immediate = false): void {
    if (immediate) {
      const timer = this.persistenceTimers.get(sessionID)
      if (timer) clearTimeout(timer)
      this.persistenceTimers.delete(sessionID)
      this.store.save(sessionID)
      return
    }
    if (this.persistenceTimers.has(sessionID)) return
    const timer = setTimeout(() => {
      this.persistenceTimers.delete(sessionID)
      this.store.save(sessionID)
    }, 400)
    this.persistenceTimers.set(sessionID, timer)
  }

  /** Flushes a finished scheduled session and lets the store evict its in-memory record. */
  private releaseSession(sessionID: string): void {
    const timer = this.persistenceTimers.get(sessionID)
    if (timer) clearTimeout(timer)
    this.persistenceTimers.delete(sessionID)
    this.store.save(sessionID)
    this.store.release(sessionID)
  }

  /** Marks tool parts that were mid-flight when the process stopped. */
  private settleStaleTools(sessionID: string): void {
    const record = this.store.get(sessionID)
    if (!record) return
    let changed = false
    for (const message of record.messages) {
      if (message.role !== "assistant") continue
      for (const part of message.content) {
        if (part.type !== "tool") continue
        const status = part.state.status
        if (status !== "running" && status !== "streaming" && status !== "permission") continue
        part.state = {
          status: "error",
          input: status === "streaming" ? {} : ((part.state as { input?: Record<string, unknown> }).input ?? {}),
          error: "Tool execution was interrupted.",
        }
        part.time = { created: part.time?.created ?? Date.now(), completed: Date.now() }
        this.touchMessage(sessionID, message.id)
        this.emit({ type: "part.updated", sessionID, messageID: message.id, part: structuredClone(part) })
        changed = true
      }
    }
    if (changed) this.persist(sessionID, true)
  }

  private runState(sessionID: string): RunState {
    let state = this.states.get(sessionID)
    if (!state) {
      state = { running: false, inbox: [] }
      this.states.set(sessionID, state)
    }
    return state
  }

  private appendMessage(sessionID: string, message: Message): void {
    const record = this.store.get(sessionID)
    if (!record) return
    this.store.append(sessionID, message)
    this.touch(record.info)
    this.emit({ type: "message.created", sessionID, message })
    this.persist(sessionID)
  }

  /** Marks a mutated message so it gets flushed to the store. */
  private touchMessage(sessionID: string, messageID: string): void {
    this.store.touch(sessionID, messageID)
  }

  // -------------------------------------------------------------------------
  // Prompt entry points
  // -------------------------------------------------------------------------

  prompt(sessionID: string, input: PromptInput): void {
    const record = this.store.get(sessionID)
    if (!record) throw new Error(`Unknown session: ${sessionID}`)
    const state = this.runState(sessionID)
    state.declined = false
    state.inbox.push({
      id: id("inb"),
      type: "user",
      delivery: input.delivery ?? "steer",
      text: input.text,
      files: input.files,
      skills: input.skills,
    })
    this.kick(sessionID)
  }

  private synthetic(sessionID: string, text: string, options?: { resume?: boolean; description?: string; metadata?: Record<string, unknown> }): void {
    const state = this.runState(sessionID)
    state.inbox.push({
      id: id("inb"),
      type: "synthetic",
      text,
      resume: options?.resume ?? true,
      description: options?.description,
      metadata: options?.metadata,
    })
    this.kick(sessionID)
  }

  command(sessionID: string, command: string): void {
    const trimmed = command.trim()
    if (trimmed.startsWith("!")) {
      const state = this.runState(sessionID)
      state.inbox.push({ id: id("inb"), type: "shell", command: trimmed.slice(1).trim() })
      this.kick(sessionID)
      return
    }
    if (trimmed === "/compact") {
      const state = this.runState(sessionID)
      state.inbox.push({ id: id("inb"), type: "compaction" })
      this.kick(sessionID)
      return
    }
    throw new Error(`Unknown command: ${command}`)
  }

  compact(sessionID: string): void {
    const state = this.runState(sessionID)
    state.inbox.push({ id: id("inb"), type: "compaction" })
    this.kick(sessionID)
  }

  interrupt(sessionID: string): void {
    const state = this.runState(sessionID)
    this.permissions.cancelSession(sessionID)
    for (const pending of [...this.pendingQuestions.values()]) {
      if (pending.request.sessionID !== sessionID) continue
      this.pendingQuestions.delete(pending.request.id)
      pending.resolve(pending.request.questions.map((question) => ({ question: question.question, answers: [] })))
    }
    state.abort?.abort()
    state.inbox = state.inbox.filter((item) => item.type === "user" && item.delivery === "queue")
  }

  isBusy(sessionID: string): boolean {
    return this.runState(sessionID).running
  }

  replyPermission(requestID: string, reply: PermissionReply, message?: string): void {
    this.permissions.reply(requestID, reply, message)
  }

  replyQuestion(requestID: string, answers: QuestionAnswer[]): void {
    const pending = this.pendingQuestions.get(requestID)
    if (!pending) return
    this.pendingQuestions.delete(requestID)
    this.emit({ type: "question.replied", sessionID: pending.request.sessionID, requestID, answers })
    pending.resolve(answers)
  }

  pendingPermissions(sessionID?: string): PermissionRequest[] {
    return this.permissions.list(sessionID)
  }

  private kick(sessionID: string): void {
    const state = this.runState(sessionID)
    if (state.running) return
    void this.drain(sessionID)
  }

  // -------------------------------------------------------------------------
  // Runner
  // -------------------------------------------------------------------------

  private async drain(sessionID: string): Promise<void> {
    const state = this.runState(sessionID)
    if (state.running) return
    // Tool calls left running by a previous process/session are settled as interrupted.
    this.settleStaleTools(sessionID)
    state.running = true
    state.abort = new AbortController()
    this.emit({ type: "session.status", sessionID, status: "busy" })
    try {
      while (true) {
        const item = state.inbox.shift()
        if (!item) break
        if (state.abort.signal.aborted) break
        await this.handleItem(sessionID, item)
      }
    } catch (error) {
      if (!(error instanceof Error && error.name === "AbortError")) {
        this.log(`runner error: ${String(error)}`)
        this.emit({ type: "error", message: error instanceof Error ? error.message : String(error) })
      }
    } finally {
      state.running = false
      state.abort = undefined
      this.persist(sessionID, true)
      this.emit({ type: "session.status", sessionID, status: "idle" })
      if (state.inbox.length > 0) {
        queueMicrotask(() => this.kick(sessionID))
      }
    }
  }

  private async handleItem(sessionID: string, item: InboxItem): Promise<void> {
    const record = this.store.get(sessionID)
    if (!record) return
    if (item.type === "user") {
      // Directly mentioned skills are injected as <skill_content> blocks before the prompt.
      if (item.skills && item.skills.length > 0) {
        const available = this.skillsFor(sessionID)
        for (const skillID of item.skills) {
          const skill = available.find((entry) => entry.id === skillID)
          if (!skill) continue
          this.appendMessage(sessionID, {
            id: id("msg"),
            sessionID,
            role: "synthetic",
            text: skillContent(skill),
            description: `Skill: ${skill.name}`,
            metadata: { source: "skill", skill: skill.id },
            time: { created: Date.now() },
          })
        }
      }
      const message: Message = {
        id: id("msg"),
        sessionID,
        role: "user",
        text: item.text ?? "",
        files: item.files,
        time: { created: Date.now() },
      }
      this.appendMessage(sessionID, message)
      if (!record.info.title && (item.text ?? "").trim()) {
        this.generateTitle(sessionID).catch((error) => this.log(`title failed: ${String(error)}`))
      }
      await this.runTurn(sessionID)
      return
    }
    if (item.type === "synthetic") {
      if (item.text) {
        this.appendMessage(sessionID, {
          id: id("msg"),
          sessionID,
          role: "synthetic",
          text: item.text,
          description: item.description,
          metadata: item.metadata,
          time: { created: Date.now() },
        })
      }
      if (item.resume) await this.runTurn(sessionID)
      return
    }
    if (item.type === "compaction") {
      await this.compactNow(sessionID, "manual").catch((error) => this.log(`compact failed: ${String(error)}`))
      return
    }
    if (item.type === "shell") {
      await this.runShellMessage(sessionID, item.command ?? "")
      return
    }
  }

  async runShellMessage(sessionID: string, command: string): Promise<void> {
    const record = this.store.get(sessionID)
    if (!record) return
    const { runShell, resolveShell } = await import("./tools/shell.js")
    const message: Message = {
      id: id("msg"),
      sessionID,
      role: "shell",
      command,
      status: "running",
      time: { created: Date.now() },
    }
    this.appendMessage(sessionID, message)
    const state = this.runState(sessionID)
    const { output, exit, timeout } = await runShell({
      command,
      workdir: record.info.directory,
      timeoutMs: this.configStore.get().shell.timeoutMs,
      background: false,
      sessionID,
      dataDir: this.dataDir,
      abort: state.abort?.signal,
      // `!` commands run in the shell selected for the integrated terminal.
      shell: resolveShell(this.configStore.get().terminal?.shell),
    })
    if (message.role === "shell") {
      const notes: string[] = []
      if (timeout) notes.push("Command exceeded its timeout.")
      if (exit !== undefined && exit !== 0) notes.push(`Exited with code ${exit}`)
      message.output = [...notes, output].filter(Boolean).join("\n")
      message.status = exit === 0 || exit === undefined ? "completed" : "failed"
      message.time.completed = Date.now()
    }
    this.touch(record.info)
    this.touchMessage(sessionID, message.id)
    this.emit({ type: "message.updated", sessionID, message })
    this.persist(sessionID, true)
  }

  private async runTurn(sessionID: string): Promise<void> {
    const state = this.runState(sessionID)
    let step = 0
    let continuation = true
    while (continuation && !state.abort?.signal.aborted && step < MAX_STEPS_SAFETY) {
      // Steering: deliver steered messages at step boundaries.
      const steered = state.inbox.filter((item) => item.type === "user" && item.delivery !== "queue")
      state.inbox = state.inbox.filter((item) => !(item.type === "user" && item.delivery !== "queue"))
      for (const item of steered) {
        if (item.type !== "user") continue
        this.appendMessage(sessionID, {
          id: id("msg"),
          sessionID,
          role: "user",
          text: item.text ?? "",
          files: item.files,
          time: { created: Date.now() },
        })
      }
      continuation = await this.runStep(sessionID, step)
      step++
      if (steered.length > 0) continuation = true
    }
  }

  private async runStep(sessionID: string, step: number): Promise<boolean> {
    const record = this.store.get(sessionID)
    if (!record) return false
    const state = this.runState(sessionID)
    const signal = state.abort?.signal ?? new AbortController().signal
    const config = this.configStore.get()
    const agent = this.agents.resolve(record.info.agent)
    const resolved = this.resolveModel(record.info)
    if (!resolved) {
      this.appendMessage(sessionID, {
        id: id("msg"),
        sessionID,
        role: "assistant",
        agent: agent.id,
        model: { providerID: "", modelID: "", name: "" },
        content: [],
        time: { created: Date.now(), completed: Date.now() },
        error: "No model selected. Open Settings → Providers to add an API key and choose a model.",
      })
      return false
    }
    const { runtime, model } = resolved

    if (config.compaction.auto && (await this.shouldCompact(sessionID, model, agent))) {
      await this.compactNow(sessionID, "auto").catch((error) => this.log(`auto compaction failed: ${String(error)}`))
    }

    const skills = discoverSkills(config, record.info.directory)
    const plan = this.planTools(agent, model, skills, config, record.info.directory)
    const toolDefs = plan.direct
    const maxStepsReached = stepLimitReached(agent, step)

    const assistant: AssistantMessage = {
      id: id("msg"),
      sessionID,
      role: "assistant",
      agent: agent.id,
      model: { providerID: runtime.id, modelID: model.id, variant: record.info.model?.variant, name: model.name },
      content: [],
      time: { created: Date.now() },
    }
    this.appendMessage(sessionID, assistant)

    const initial = this.initialContext(sessionID, record.info.directory, skills, plan.codeModeInstructions)
    const system = composeSystemPrompt({
      agent,
      model,
      tools: [...toolDefs, ...plan.catalogTools].map((tool) => effectiveName(tool)),
      initial,
    })
    // Keep the Plan/Build reminder consistent with the current agent (upstream plan plugin).
    this.reconcilePlanMode(sessionID, agent)
    const modelMessages = toModelMessages(this.messages(sessionID).filter((message) => message.id !== assistant.id), {
      model: { providerID: runtime.id, modelID: model.id },
      supportsImages: (model.modalities?.input ?? ["text"]).includes("image"),
    })
    if (maxStepsReached) {
      modelMessages.push({ role: "user", content: [{ type: "text", text: MAX_STEPS_PROMPT }] })
    }

    const variant = variantOptions(runtime.kind, model, record.info.model?.variant)
    const toolSet =
      maxStepsReached || model.toolCall === false ? undefined : (this.toolDefinitions(toolDefs) as never)

    let usage: TokenUsage | undefined
    let finishReason: string | undefined
    let overflow = false

    for (let attempt = 1; attempt <= STREAM_RETRIES; attempt++) {
      try {
        const stream = streamText({
          model: createLanguageModel(runtime, model.id),
          system,
          messages: modelMessages,
          tools: toolSet,
          stopWhen: stepCountIs(1),
          abortSignal: signal,
          maxRetries: 0,
          headers: this.requestHeaders(record.info, runtime.headers),
          providerOptions: variant.providerOptions as never,
          maxOutputTokens: variant.maxOutputTokens,
        })
        const collected = await this.consumeStream(sessionID, assistant, stream, toolDefs, agent, record.info.directory, signal)
        usage = collected.usage
        finishReason = collected.finishReason
        break
      } catch (error) {
        if (signal.aborted || (error instanceof Error && error.name === "AbortError")) break
        const message = error instanceof Error ? error.message : String(error)
        if (isOverflowError(message) && !overflow) {
          overflow = true
          await this.compactNow(sessionID, "overflow").catch(() => undefined)
          continue
        }
        if (attempt < STREAM_RETRIES && isRetryable(message)) {
          this.log(`retrying step after error: ${message}`)
          await new Promise((resolve) => setTimeout(resolve, attempt * 1500))
          continue
        }
        assistant.error = message
        this.log(`step failed: ${message}`)
        break
      }
    }

    assistant.time.completed = Date.now()
    assistant.finish = finishReason
    assistant.tokens = usage
    assistant.cost = usage ? this.computeCost(model, usage) : undefined
    if (!assistant.error) this.overflowShrink.delete(sessionID)
    if (assistant.cost) {
      record.info.cost = (record.info.cost ?? 0) + assistant.cost
    }
    if (usage) {
      record.info.tokens = addTokens(record.info.tokens, usage)
    }
    this.touch(record.info)
    this.touchMessage(sessionID, assistant.id)
    this.streamGeneration.set(assistant.id, (this.streamGeneration.get(assistant.id) ?? 0) + 1)
    this.emit({ type: "message.updated", sessionID, message: assistant })
    this.persist(sessionID)

    const executed = assistant.content.some(
      (part) => part.type === "tool" && (part.state.status === "completed" || part.state.status === "error"),
    )
    if (state.declined) {
      state.declined = false
      return false
    }
    if (maxStepsReached) return false
    return executed || finishReason === "tool-calls"
  }

  private async consumeStream(
    sessionID: string,
    assistant: AssistantMessage,
    stream: ReturnType<typeof streamText>,
    toolDefs: ToolDefinition[],
    agent: AgentDef,
    directory: string,
    signal: AbortSignal,
  ): Promise<{ usage?: TokenUsage; finishReason?: string }> {
    let usage: TokenUsage | undefined
    let finishReason: string | undefined
    const textParts = new Map<string, string>()
    const reasoningParts = new Map<string, string>()
    const toolParts = new Map<string, ToolPart>()

    const findPart = (partID: string) => assistant.content.find((part) => part.id === partID)

    // Deltas are buffered and flushed at most every DELTA_FLUSH_MS so streaming
    // several agents no longer floods IPC, the store, and the markdown renderer.
    // Each buffered delta carries the stream generation: once runStep commits the
    // message (or a retry restarts the stream) stale flushes are dropped.
    const generation = this.streamGeneration.get(assistant.id) ?? 0
    const pendingDeltas = new Map<string, { text: string; generation: number; timer?: NodeJS.Timeout }>()
    const flushDelta = (partID: string) => {
      const entry = pendingDeltas.get(partID)
      if (!entry) return
      if (entry.timer) clearTimeout(entry.timer)
      pendingDeltas.delete(partID)
      if (!entry.text) return
      if (entry.generation !== (this.streamGeneration.get(assistant.id) ?? 0)) return
      this.touchMessage(sessionID, assistant.id)
      this.persist(sessionID)
      this.emit({ type: "part.delta", sessionID, messageID: assistant.id, partID, delta: entry.text })
    }
    const queueDelta = (partID: string, delta: string) => {
      const entry = pendingDeltas.get(partID) ?? { text: "", generation }
      entry.text += delta
      if (!entry.timer) entry.timer = setTimeout(() => flushDelta(partID), DELTA_FLUSH_MS)
      pendingDeltas.set(partID, entry)
    }
    // Tool arguments stream token by token; emitting the whole accumulated input on
    // every delta made large writes O(n²) over IPC. Throttle to a few per second.
    const toolInputTimers = new Map<string, NodeJS.Timeout>()
    const queueToolInput = (part: ToolPart) => {
      if (toolInputTimers.has(part.id)) return
      toolInputTimers.set(
        part.id,
        setTimeout(() => {
          toolInputTimers.delete(part.id)
          if (generation !== (this.streamGeneration.get(assistant.id) ?? 0)) return
          this.touchMessage(sessionID, assistant.id)
          this.persist(sessionID)
          this.emit({ type: "part.updated", sessionID, messageID: assistant.id, part: structuredClone(part) })
        }, TOOL_INPUT_FLUSH_MS),
      )
    }
    const clearToolInputTimer = (partID: string) => {
      const timer = toolInputTimers.get(partID)
      if (timer) clearTimeout(timer)
      toolInputTimers.delete(partID)
    }

    for await (const chunk of stream.fullStream) {
      switch (chunk.type) {
        case "text-start": {
          const part = { type: "text" as const, id: id("prt"), text: "" }
          assistant.content.push(part)
          textParts.set(chunk.id, part.id)
          this.touchMessage(sessionID, assistant.id)
          this.emit({ type: "part.created", sessionID, messageID: assistant.id, part: { ...part } })
          break
        }
        case "text-delta": {
          const partID = textParts.get(chunk.id)
          if (!partID) break
          const part = findPart(partID)
          if (part?.type === "text") {
            part.text += chunk.text
            if (chunk.providerMetadata) {
              part.providerMetadata = { ...(part.providerMetadata ?? {}), ...chunk.providerMetadata }
            }
            queueDelta(partID, chunk.text)
          }
          break
        }
        case "text-end": {
          const partID = textParts.get(chunk.id)
          if (partID) {
            const part = findPart(partID)
            if (part?.type === "text" && chunk.providerMetadata) {
              part.providerMetadata = { ...(part.providerMetadata ?? {}), ...chunk.providerMetadata }
            }
            flushDelta(partID)
          }
          textParts.delete(chunk.id)
          break
        }
        case "reasoning-start": {
          const part = { type: "reasoning" as const, id: id("prt"), text: "" }
          assistant.content.push(part)
          reasoningParts.set(chunk.id, part.id)
          this.touchMessage(sessionID, assistant.id)
          this.emit({ type: "part.created", sessionID, messageID: assistant.id, part: { ...part } })
          break
        }
        case "reasoning-delta": {
          const partID = reasoningParts.get(chunk.id)
          if (!partID) break
          const part = findPart(partID)
          if (part?.type === "reasoning") {
            part.text += chunk.text
            if (chunk.providerMetadata) {
              part.providerMetadata = { ...(part.providerMetadata ?? {}), ...chunk.providerMetadata }
            }
            queueDelta(partID, chunk.text)
          }
          break
        }
        case "reasoning-end": {
          const partID = reasoningParts.get(chunk.id)
          if (partID) {
            const part = findPart(partID)
            if (part?.type === "reasoning" && chunk.providerMetadata) {
              part.providerMetadata = { ...(part.providerMetadata ?? {}), ...chunk.providerMetadata }
            }
            flushDelta(partID)
            // Some gateways emit a placeholder when a model has no reasoning channel.
            if (part?.type === "reasoning" && part.text.trim() === "No reasoning available.") {
              part.text = ""
              this.touchMessage(sessionID, assistant.id)
              this.emit({ type: "part.updated", sessionID, messageID: assistant.id, part: structuredClone(part) })
            }
          }
          reasoningParts.delete(chunk.id)
          break
        }
        case "tool-input-start": {
          const part: ToolPart = {
            type: "tool",
            id: id("prt"),
            callID: chunk.id,
            tool: chunk.toolName,
            state: { status: "streaming", input: "" },
            time: { created: Date.now() },
          }
          assistant.content.push(part)
          toolParts.set(chunk.id, part)
          this.touchMessage(sessionID, assistant.id)
          this.emit({ type: "part.created", sessionID, messageID: assistant.id, part: structuredClone(part) })
          break
        }
        case "tool-input-delta": {
          const part = toolParts.get(chunk.id)
          if (!part || part.state.status !== "streaming") break
          part.state.input += chunk.delta
          queueToolInput(part)
          break
        }
        case "tool-input-end": {
          const part = toolParts.get(chunk.id)
          if (part) clearToolInputTimer(part.id)
          break
        }
        case "tool-call": {
          const part = toolParts.get(chunk.toolCallId)
          if (!part) break
          clearToolInputTimer(part.id)
          part.tool = chunk.toolName
          part.state = { status: "running", input: (chunk.input ?? {}) as Record<string, unknown> }
          this.touchMessage(sessionID, assistant.id)
          this.persist(sessionID)
          this.emit({ type: "part.updated", sessionID, messageID: assistant.id, part: structuredClone(part) })
          break
        }
        case "tool-error": {
          const errorChunk = chunk as { toolCallId?: string; id?: string; error?: unknown; input?: unknown }
          const part = toolParts.get(errorChunk.toolCallId ?? errorChunk.id ?? "")
          const message =
            errorChunk.error instanceof Error
              ? errorChunk.error.message
              : typeof errorChunk.error === "string"
                ? errorChunk.error
                : JSON.stringify(errorChunk.error ?? "Tool call failed")
          if (part && part.state.status !== "completed") {
            part.state = {
              status: "error",
              input: (errorChunk.input as Record<string, unknown>) ?? {},
              error: message,
            }
            part.time = { created: part.time?.created ?? Date.now(), completed: Date.now() }
            this.touchMessage(sessionID, assistant.id)
            this.persist(sessionID)
            this.emit({ type: "part.updated", sessionID, messageID: assistant.id, part: structuredClone(part) })
          }
          this.log(`tool call error: ${message}`)
          break
        }
        case "finish-step": {
          usage = toTokenUsage(chunk.usage)
          finishReason = chunk.finishReason
          break
        }
        case "finish": {
          finishReason = chunk.finishReason
          if (!usage) usage = toTokenUsage(chunk.totalUsage)
          break
        }
        case "error": {
          throw chunk.error instanceof Error ? chunk.error : new Error(String(chunk.error))
        }
        default:
          break
      }
    }

    for (const partID of [...pendingDeltas.keys()]) flushDelta(partID)
    for (const timer of toolInputTimers.values()) clearTimeout(timer)
    toolInputTimers.clear()

    const calls = assistant.content.filter(
      (part): part is ToolPart => part.type === "tool" && part.state.status === "running",
    )
    if (calls.length > 0) {
      await Promise.allSettled(
        calls.map((part) =>
          this.executeToolCall(sessionID, assistant, part, toolDefs, agent, directory, signal).catch(() => undefined),
        ),
      )
    }
    return { usage, finishReason }
  }

  private async executeToolCall(
    sessionID: string,
    assistant: AssistantMessage,
    part: ToolPart,
    toolDefs: ToolDefinition[],
    agent: AgentDef,
    directory: string,
    signal: AbortSignal,
  ): Promise<void> {
    const definition = toolDefs.find((tool) => effectiveName(tool) === part.tool)
    if (!definition) {
      part.state = {
        status: "error",
        input: (part.state as { input?: Record<string, unknown> }).input ?? {},
        error: `No tool named "${part.tool}" is currently available.`,
      }
      this.emit({ type: "part.updated", sessionID, messageID: assistant.id, part: structuredClone(part) })
      return
    }
    const rawInput = (part.state as { input?: Record<string, unknown> }).input ?? {}
    const parsed = definition.inputSchema
      ? definition.inputSchema.safeParse(rawInput)
      : ({ success: true, data: rawInput } as const)
    if (!parsed.success) {
      part.state = {
        status: "error",
        input: rawInput,
        error: `Invalid arguments for tool "${definition.name}": ${parsed.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join(", ")}\n\nArguments provided:\n${JSON.stringify(rawInput)}\n\nUpdate the arguments and call the tool again.`,
      }
      this.emit({ type: "part.updated", sessionID, messageID: assistant.id, part: structuredClone(part) })
      return
    }

    const ctx: ToolContext = {
      sessionID,
      agent: agent.id,
      directory,
      abort: signal,
      progress: (update) => {
        if (part.state.status !== "running") return
        part.state.metadata = { ...(part.state.metadata ?? {}), ...(update?.metadata ?? {}) }
        this.emit({ type: "part.updated", sessionID, messageID: assistant.id, part: structuredClone(part) })
      },
      permission: async (input) => {
        await this.permissions.assert(
          {
            sessionID,
            action: input.action ?? definition.permission ?? effectiveName(definition),
            resources: input.resources,
            save: input.save,
            metadata: input.metadata,
            message: input.message,
          },
          agent,
          directory,
          undefined,
          (request) => {
            if (part.state.status !== "running") return
            part.state = { status: "permission", input: rawInput, requestID: request.id }
            this.touchMessage(sessionID, assistant.id)
          this.emit({ type: "part.updated", sessionID, messageID: assistant.id, part: structuredClone(part) })
          },
          this.scheduledSessions.has(sessionID),
        )
        if (part.state.status === "permission") {
          part.state = { status: "running", input: rawInput }
          this.touchMessage(sessionID, assistant.id)
          this.emit({ type: "part.updated", sessionID, messageID: assistant.id, part: structuredClone(part) })
        }
      },
      services: this.toolServices(directory),
      config: { shellTimeoutMs: this.configStore.get().shell.timeoutMs, dataDir: this.dataDir },
      scheduled: this.scheduledSessions.has(sessionID),
    }

    try {
      const result = await definition.execute(parsed.data, ctx)
      part.state = {
        status: "completed",
        input: rawInput,
        content: result?.content ?? [],
        metadata: result?.metadata,
      }
      part.time = { created: part.time?.created ?? Date.now(), completed: Date.now() }
    } catch (error) {
      if (error instanceof PermissionDeclinedError) {
        part.state = { status: "error", input: rawInput, error: "The user declined the request." }
        this.runState(sessionID).declined = true
      } else if (error instanceof PermissionRejectedError) {
        part.state = { status: "error", input: rawInput, error: error.feedback }
      } else if (error instanceof PermissionBlockedError) {
        if (agent.id === "plan" && ["edit", "write", "patch"].includes(part.tool)) {
          part.state = {
            status: "error",
            input: rawInput,
            error: `Cannot use ${part.tool} to modify files outside the Plan directory: ${PLAN_DIRECTORY}`,
          }
        } else {
          part.state = { status: "error", input: rawInput, error: error.message }
        }
      } else if (error instanceof ToolFailure) {
        part.state = { status: "error", input: rawInput, error: error.message }
      } else if (error instanceof Error && error.name === "AbortError") {
        part.state = { status: "error", input: rawInput, error: "Interrupted" }
      } else {
        const message = error instanceof Error ? error.message : String(error)
        part.state = { status: "error", input: rawInput, error: message }
        this.log(`tool ${definition.name} failed: ${message}`)
      }
      part.time = { created: part.time?.created ?? Date.now(), completed: Date.now() }
    }
    this.emit({ type: "part.updated", sessionID, messageID: assistant.id, part: structuredClone(part) })
  }

  // -------------------------------------------------------------------------
  // Model / tools / context helpers
  // -------------------------------------------------------------------------

  /**
   * Request-routing headers used by OpenCode for every provider call
   * (session affinity, project, client). The OpenCode Zen/Go gateways require
   * `x-opencode-session`; other providers ignore unknown headers.
   */
  private requestHeaders(session: SessionInfo, extra?: Record<string, string>, affinityOverride?: string): Record<string, string> {
    const affinity = affinityOverride ?? session.parentID ?? session.id
    const headers: Record<string, string> = {
      "x-opencode-session": affinity,
      "x-opencode-session-id": session.id,
      "x-session-affinity": affinity,
      "X-Session-Id": affinity,
      "x-opencode-project": path.basename(session.directory) || session.directory,
      "x-opencode-client": "openorch",
      "user-agent": "openorch/0.1.0",
      ...(extra ?? {}),
    }
    if (session.parentID) {
      headers["x-opencode-parent-session-id"] = session.parentID
      headers["x-parent-session-id"] = session.parentID
    }
    return headers
  }

  private runtimeFor(
    config: Config,
    ref: ModelRef,
  ): { runtime: ProviderRuntime; model: ModelInfo } | undefined {
    const runtime = resolveProvider(config, ref.providerID)
    if (!runtime) return undefined
    const model = lookupModel(config, ref.providerID, ref.modelID)
    if (!model) return undefined
    return { runtime, model }
  }

  private resolveModel(session: SessionInfo): { runtime: ProviderRuntime; model: ModelInfo } | undefined {
    const config = this.configStore.get()
    const direct = this.runtimeFor(config, session.model ?? { providerID: "", modelID: "" })
    if (direct) return direct

    // The session's model (or its provider) disappeared: fall back to the
    // cheapest/default model, mirroring upstream's `isModelValid` fallback.
    const fallback = this.defaultModelRef(session.directory)
    const resolved = fallback ? this.runtimeFor(config, fallback) : undefined
    const record = this.store.get(session.id)
    if (resolved && record && fallback) {
      const previous = session.model ? `${session.model.providerID}/${session.model.modelID}` : "(sin modelo)"
      const next = `${fallback.providerID}/${fallback.modelID}`
      if (previous !== next) {
        record.info.model = { ...fallback }
        this.modelPrefs.remember(record.info.model, record.info.directory)
        this.touch(record.info)
        this.persist(session.id, true)
        this.emit({ type: "session.updated", session: record.info })
        this.synthetic(
          session.id,
          `El modelo ${previous} ya no está disponible. Se cambió automáticamente a ${next}.`,
          { resume: false },
        )
      }
    }
    return resolved
  }

  /**
   * Resolves the tools for a step: direct tools, the Code Mode catalog and the
   * instructions injected into the system prompt.
   */
  private planTools(
    agent: AgentDef,
    model: ModelInfo,
    skills: SkillInfo[],
    config: Config,
    directory: string,
  ): { direct: ToolDefinition[]; catalogTools: ToolDefinition[]; byEffective: Map<string, ToolDefinition>; codeModeInstructions: string } {
    const rules = this.permissions.rules(agent)
    const subagents = this.agents
      .subagents()
      .filter((subagent) => evaluate("subagent", subagent.id, rules).effect !== "deny")
      .map((subagent) => ({ id: subagent.id, description: subagent.description ?? "" }))
    const { direct, codemode } = buildTools({
      model,
      permissions: rules,
      mcpTools: this.mcp.tools(),
      websearchEnabled: Boolean(config.websearch.provider),
      skillsAvailable: skills.length > 0,
      subagents,
      codeMode: config.codeMode.enabled,
      browser: Boolean(this.options.browser),
    })
    const byEffective = new Map<string, ToolDefinition>()
    for (const tool of [...direct, ...codemode]) byEffective.set(effectiveName(tool), tool)

    const catalog = buildCatalog(codemode)
    const codeModeInstructions = config.codeMode.enabled ? renderCodeModeInstructions(catalog) : ""

    if (config.codeMode.enabled) {
      const executeTool = createExecuteTool({
        catalog,
        callTool: async (entry, args, ctx) => this.executeNestedTool(entry, args, ctx, byEffective),
      })
      direct.push(executeTool)
      byEffective.set("execute", executeTool)
    }
    void directory
    return { direct, catalogTools: codemode, byEffective, codeModeInstructions }
  }

  /** Executes a catalog tool from inside the Code Mode runtime (with permissions). */
  private async executeNestedTool(
    entry: CatalogEntry,
    args: unknown,
    ctx: ToolContext,
    byEffective: Map<string, ToolDefinition>,
  ): Promise<{ content: ToolContent[]; metadata?: Record<string, unknown> }> {
    const effective = entry.namespace ? `${entry.namespace}_${entry.name}` : entry.name
    const definition = byEffective.get(effective)
    if (!definition) throw new ToolFailure(`No tool named ${entry.path} is currently available.`)
    const parsed = definition.inputSchema
      ? definition.inputSchema.safeParse(args ?? {})
      : ({ success: true, data: args ?? {} } as const)
    if (!parsed.success) {
      throw new ToolFailure(
        `Invalid arguments for ${entry.path}: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join(", ")}`,
      )
    }
    const result = await definition.execute(parsed.data, ctx)
    return {
      content: result?.content ?? [{ type: "text", text: "(no output)" }],
      metadata: result?.metadata,
    }
  }

  /** Tool definitions handed to the model (execution is handled by the runner). */
  private toolDefinitions(tools: ToolDefinition[]): Record<string, { description: string; inputSchema: unknown }> {
    const set: Record<string, { description: string; inputSchema: unknown }> = {}
    for (const tool of tools) {
      set[effectiveName(tool)] = {
        description: tool.description,
        inputSchema: tool.inputSchema ?? tool.jsonSchema ?? { type: "object", properties: {} },
      }
    }
    return set
  }

  private toolServices(directory: string): ToolServices {
    return {
      ask: async (sessionID, questions) => this.askQuestions(sessionID, questions as never),
      spawnSubagent: async (input) => this.spawnSubagent(input),
      subagents: () => this.agents.subagents().map((agent) => ({ id: agent.id, description: agent.description ?? "" })),
      searchWeb: async (query) => this.searchWeb(query),
      instructions: async (sessionID, filePath) => this.addInstructions(sessionID, filePath, directory),
      shellNotify: async (sessionID, shellID, command, state, output) => {
        this.synthetic(
          sessionID,
          `<shell id="${shellID}" state="${state}" command="${command}">\n${output.slice(-4000)}\n</shell>`,
          { resume: true },
        )
      },
      skills: () => discoverSkills(this.configStore.get(), directory),
      mcp: {
        status: () => this.mcp.status(),
        get: (name) => this.effectiveMcpServers()[name]?.config,
        add: (name, server) => this.mcpAdd(name, server),
        remove: (name) => this.mcpRemove(name),
        test: (server, name) => this.mcp.probe(server, name),
        listResources: (name) => this.mcp.listResources(name),
        readResource: (name, uri) => this.mcp.readResource(name, uri),
      },
      renameSession: async (sessionID, title) => this.renameSession(sessionID, title),
      moveSession: async (sessionID, target) => this.moveSession(sessionID, target),
      listModels: () => this.listModels(),
      worktree: {
        create: async (dir, name) => this.worktrees.create(dir, name),
        list: async (dir) => this.worktrees.list(dir),
        remove: async (dir, target, force) => this.worktrees.remove(dir, target, force),
      },
      browser: this.options.browser,
    }
  }

  /** Moves a session to another working directory (effective from the next step). */
  async moveSession(sessionID: string, directory: string): Promise<string> {
    const record = this.store.get(sessionID)
    if (!record) throw new ToolFailure(`Unknown session: ${sessionID}`)
    const base = record.info.directory
    const expanded =
      directory === "~" || directory.startsWith("~/") || directory.startsWith("~\\")
        ? path.join(process.env.USERPROFILE ?? process.env.HOME ?? "", directory.slice(2))
        : directory
    const resolved = path.resolve(base, expanded)
    if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
      throw new ToolFailure(`Directory not found: ${directory}`)
    }
    record.info.directory = resolved
    this.touch(record.info)
    this.persist(sessionID, true)
    this.emit({ type: "session.updated", session: record.info })
    return resolved
  }

  private initialContext(sessionID: string, directory: string, skills: SkillInfo[], codeModeInstructions = ""): string {
    const parts: string[] = [environmentBlock(directory, this.projectDirectory)]
    const global = globalAgentsFile()
    if (global) {
      parts.push(`<global-instructions>\n${global}\n</global-instructions>`)
    }
    const existing = this.instructionEntries.get(sessionID)
    if (!existing) {
      const loaded = this.loadedAgentFiles.get(sessionID) ?? new Set<string>()
      const collected: InstructionEntry[] = []
      const files = agentsFilesUpwards(directory).reverse()
      for (const file of files) {
        if (loaded.has(file)) continue
        const content = readAgentsFile(file)
        if (!content) continue
        loaded.add(file)
        collected.push({ path: file, content })
      }
      this.loadedAgentFiles.set(sessionID, loaded)
      this.instructionEntries.set(sessionID, collected)
      parts.push(renderInstructions(collected))
    } else {
      parts.push(renderInstructions(existing))
    }
    const skillInstructions = skillsInstructions(skills, directory)
    if (skillInstructions) parts.push(skillInstructions)
    const mcpInstructions = this.mcp.instructions()
    if (mcpInstructions) parts.push(mcpInstructions)
    if (this.options.browser) parts.push(BROWSER_PROTOCOL)
    if (codeModeInstructions) parts.push(codeModeInstructions)
    return parts.filter(Boolean).join("\n\n")
  }

  private async addInstructions(sessionID: string, filePath: string, directory: string): Promise<void> {
    const loaded = this.loadedAgentFiles.get(sessionID) ?? new Set<string>()
    const entries = this.instructionEntries.get(sessionID) ?? []
    const collected: InstructionEntry[] = []
    for (const file of agentsFilesUpwards(path.dirname(filePath), directory)) {
      if (loaded.has(file)) continue
      const content = readAgentsFile(file)
      if (!content) continue
      loaded.add(file)
      collected.push({ path: file, content })
    }
    this.loadedAgentFiles.set(sessionID, loaded)
    if (collected.length > 0) {
      this.instructionEntries.set(sessionID, [...entries, ...collected])
      this.appendMessage(sessionID, {
        id: id("msg"),
        sessionID,
        role: "synthetic",
        text: `Loaded project instructions:\n${renderInstructions(collected)}`,
        time: { created: Date.now() },
      })
    }
  }

  // -------------------------------------------------------------------------
  // Questions / subagents / web search
  // -------------------------------------------------------------------------

  private async askQuestions(
    sessionID: string,
    questions: { question: string; header: string; options: { label: string; description?: string }[]; multiple?: boolean }[],
  ): Promise<QuestionAnswer[]> {
    const request: QuestionRequest = {
      id: id("que"),
      sessionID,
      questions: questions.map((question) => ({
        question: question.question,
        header: question.header,
        options: question.options,
        multiple: question.multiple,
      })),
      time: Date.now(),
    }
    this.emit({ type: "question.asked", request })
    return new Promise<QuestionAnswer[]>((resolve) => {
      this.pendingQuestions.set(request.id, { resolve, request })
    })
  }

  private async spawnSubagent(input: {
    parentSessionID: string
    agent: string
    prompt: string
    description: string
    model?: string
    sessionID?: string
    background?: boolean
  }): Promise<{ sessionID: string; status: "completed" | "running"; output: string; model?: string }> {
    const parent = this.store.get(input.parentSessionID)
    if (!parent) throw new ToolFailure("Parent session not found.")
    const agent = this.agents.resolve(input.agent)
    if (!agent || agent.mode === "primary") throw new ToolFailure(`Agent "${input.agent}" cannot be used as a subagent.`)

    // Depth limit, mirroring upstream `experimental.subagent_depth` (default 1).
    let depth = 0
    let current = parent.info
    while (current.parentID) {
      depth++
      const up = this.store.get(current.parentID)
      if (!up) throw new ToolFailure(`Parent session not found: ${current.parentID}`)
      current = up.info
    }
    const limit = this.configStore.get().experimental?.subagentDepth ?? 1
    if (depth >= limit) {
      throw new ToolFailure(`Subagent depth limit reached (${limit}). Increase "experimental.subagentDepth" to allow nested subagents.`)
    }

    const override = input.model ? this.resolveModelRef(input.model) : undefined
    const existing = input.sessionID ? this.store.get(input.sessionID) : undefined
    if (existing && existing.info.parentID !== input.parentSessionID) {
      throw new ToolFailure(`Session ${existing.info.id} is not a child of the current session`)
    }

    // Model resolution: override > agent model > parent model. Subagents inherit the
    // parent's model with a minimal thinking level (configurable: `inherit` keeps the
    // parent's variant, matching upstream).
    const inherited = this.subagentModel(parent.info, override, agent, Boolean(input.model?.includes("#")))
    if (existing) {
      const switched = existing.info.agent !== agent.id
      if (switched) this.setSessionAgent(existing.info.id, agent.id)
      // Re-inherit the parent's model on continue unless an explicit override exists.
      if (inherited && (modelKey(existing.info.model ?? { providerID: "", modelID: "" }) !== modelKey(inherited) || override)) {
        this.setSessionModel(existing.info.id, inherited)
      }
    }

    let sessionID = existing?.info.id
    if (!existing) {
      const created = this.createSession({
        directory: parent.info.directory,
        agent: agent.id,
        parentID: input.parentSessionID,
        model: inherited,
      })
      sessionID = created.id
      created.title = input.description
      this.touch(created)
      this.persist(created.id, true)
      this.emit({ type: "session.updated", session: created })
    }
    const childID = sessionID!
    const childModel = this.store.get(childID)?.info.model
    this.log(
      `subagent ${childID} agent=${agent.id} model=${childModel ? `${childModel.providerID}/${childModel.modelID}${childModel.variant ? `#${childModel.variant}` : ""}` : "(none)"}`,
    )
    const first = this.messages(childID).length === 0
    this.prompt(childID, {
      text: first ? `You are a subagent spawned by another session.\n\n${input.prompt}` : input.prompt,
      delivery: "steer",
    })

    if (input.background) {
      void this.watchSubagent(childID, input.parentSessionID, input.description)
      return { sessionID: childID, status: "running", output: "", model: this.modelLabel(childID) }
    }
    await this.waitIdle(childID)
    return {
      sessionID: childID,
      status: "completed",
      output: this.subagentOutput(childID),
      model: this.modelLabel(childID),
    }
  }

  /** Model label for UI/telemetry. */
  private modelLabel(sessionID: string): string | undefined {
    const ref = this.store.get(sessionID)?.info.model
    if (!ref) return undefined
    return `${ref.providerID}/${ref.modelID}${ref.variant ? `#${ref.variant}` : ""}`
  }

  /**
   * Resolves the model a subagent runs with: `override > agent model > parent model`,
   * then applies the minimal thinking level unless the caller pinned a variant or
   * `experimental.subagentVariant` is `"inherit"`.
   */
  private subagentModel(
    parent: SessionInfo,
    override: ModelRef | undefined,
    agent: AgentDef,
    overrideHasVariant: boolean,
  ): ModelRef | undefined {
    const config = this.configStore.get()
    const configured =
      config.experimental?.subagentModel && this.runtimeFor(config, config.experimental.subagentModel)
        ? config.experimental.subagentModel
        : undefined
    const resolved = override ?? configured ?? agent.model ?? this.parentModelRef(parent)
    if (!resolved) return undefined
    const mode = config.experimental?.subagentVariant ?? "minimal"
    // A variant explicitly pinned by the caller (or by a global subagent model)
    // wins over the minimal-level policy.
    if (mode === "inherit" || overrideHasVariant || (configured && resolved === configured && resolved.variant)) {
      return { ...resolved }
    }
    const info = lookupModel(config, resolved.providerID, resolved.modelID)
    const variant = minimalVariant(info)
    return { providerID: resolved.providerID, modelID: resolved.modelID, ...(variant ? { variant } : {}) }
  }

  /** Parent model for a subagent: persisted ref → runtime resolution → default. */
  private parentModelRef(parent: SessionInfo): ModelRef | undefined {
    const config = this.configStore.get()
    if (parent.model && this.runtimeFor(config, parent.model)) return { ...parent.model }
    const resolved = this.resolveModel(parent)
    if (resolved) {
      return {
        providerID: resolved.runtime.id,
        modelID: resolved.model.id,
        ...(parent.model?.variant ? { variant: parent.model.variant } : {}),
      }
    }
    return this.defaultModelRef(parent.directory)
  }

  /** Parsea "providerID/modelID#variant" y valida que exista (upstream: resolveModel). */
  private resolveModelRef(input: string): { providerID: string; modelID: string; variant?: string } {
    const [providerID, rest] = input.split("/")
    if (!providerID || !rest) {
      throw new ToolFailure(`Invalid model "${input}". Use "providerID/modelID" or "providerID/modelID#variant".`)
    }
    const [modelID, variant] = rest.split("#")
    const match = this.listModels().find((model) => model.providerID === providerID && model.id === modelID)
    if (!match) {
      throw new ToolFailure(`Model "${providerID}/${modelID}" is not available. Use the opencode_models tool to see what is available.`)
    }
    if (variant !== undefined && !(match.variants ?? []).includes(variant)) {
      throw new ToolFailure(
        (match.variants ?? []).length === 0
          ? `Model "${providerID}/${modelID}" has no variants. Omit the variant.`
          : `Variant "${variant}" is not available for "${providerID}/${modelID}". Available: ${(match.variants ?? []).join(", ")}.`,
      )
    }
    return { providerID, modelID, variant }
  }

  private subagentOutput(childID: string): string {
    return lastAssistantText(this.messages(childID)) || "Subagent completed without a text response."
  }

  /** Background subagents notify the parent session when they finish. */
  private async watchSubagent(childID: string, parentID: string, description: string): Promise<void> {
    try {
      await this.waitIdle(childID)
      const messages = this.messages(childID)
      const failed = messages.some((message) => message.role === "assistant" && message.error)
      const state = failed ? "error" : "completed"
      const output = failed
        ? messages
            .filter((message) => message.role === "assistant" && message.error)
            .map((message) => (message as Extract<Message, { role: "assistant" }>).error)
            .filter(Boolean)
            .join("\n") || "Subagent failed"
        : this.subagentOutput(childID)
      this.synthetic(parentID, `<subagent sessionID="${childID}" state="${state}" description="${description}">\n${output}\n</subagent>`, {
        resume: true,
      })
    } catch (error) {
      this.log(`subagent watcher failed: ${String(error)}`)
    }
  }

  private async waitIdle(sessionID: string): Promise<void> {
    while (this.runState(sessionID).running) {
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }

  private async searchWeb(query: string): Promise<{ provider: string; results: { title: string; url: string; content?: string; published?: string }[] }> {
    return searchProviderWeb(this.configStore.get().websearch, query)
  }

  // -------------------------------------------------------------------------
  // Compaction
  // -------------------------------------------------------------------------

  private async shouldCompact(sessionID: string, model: ModelInfo, agent: AgentDef): Promise<boolean> {
    if (agent.id === "compaction") return false
    const limit = model.limit?.context
    if (!limit) return false
    const record = this.store.get(sessionID)
    if (!record) return false
    const messages = record.messages
    // A compaction just completed; let the runner rebuild the request from it first.
    const last = messages.at(-1)
    if (last?.role === "compaction" && last.status === "completed") return false
    const config = this.configStore.get()
    const ceiling = config.compaction.buffer ?? limit - Math.max(COMPACTION_RESERVE_MIN, Math.floor(limit * 0.1))
    const lastCheckpoint = findLastIndex(messages, (message) => message.role === "compaction" && message.status === "completed")
    const lastMeasured = findLastIndex(
      messages,
      (message) =>
        message.role === "assistant" &&
        message.tokens !== undefined &&
        message.error === undefined &&
        message.model.providerID === model.providerID &&
        message.model.modelID === model.id,
    )
    // After a checkpoint we need a fresh measurement before compacting again.
    if (lastMeasured < lastCheckpoint) return false
    return this.estimateSessionTokens(sessionID, model) >= ceiling
  }

  private estimateMessageTokens(message: Message): number {
    if (message.role === "user" || message.role === "synthetic") {
      return estimateTokens(message.text) + (message.role === "user" ? (message.files?.length ?? 0) * IMAGE_TOKEN_ESTIMATE : 0)
    }
    if (message.role === "shell") return estimateTokens(message.output ?? "")
    if (message.role === "compaction") return estimateTokens(message.summary)
    let total = 0
    for (const part of message.content) {
      if (part.type === "text" || part.type === "reasoning") total += estimateTokens(part.text)
      if (part.type === "tool" && part.state.status === "completed") {
        for (const content of part.state.content) {
          if (content.type === "text") total += estimateTokens(content.text)
          else total += IMAGE_TOKEN_ESTIMATE
        }
      }
    }
    return total
  }

  /**
   * Estimates the model-visible context size. Uses the measured prompt from the last
   * assistant produced by the same model as an anchor (upstream: `hasMeasuredPrompt`),
   * and falls back to a char-based estimate otherwise.
   */
  estimateSessionTokens(sessionID: string, model?: ModelInfo): number {
    const record = this.store.get(sessionID)
    if (!record) return 0
    const messages = record.messages
    let start = 0
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]
      if (message.role === "compaction" && message.status === "completed") {
        start = i
        break
      }
    }
    const active = messages.slice(start)
    let anchor = -1
    if (model) {
      for (let i = active.length - 1; i >= 0; i--) {
        const message = active[i]
        if (
          message.role === "assistant" &&
          message.tokens !== undefined &&
          message.error === undefined &&
          message.model.providerID === model.providerID &&
          message.model.modelID === model.id
        ) {
          anchor = i
          break
        }
      }
    }
    if (anchor >= 0) {
      const measured = active[anchor] as Extract<Message, { role: "assistant" }>
      let total = (measured.tokens?.input ?? 0) + (measured.tokens?.output ?? 0)
      for (const message of active.slice(anchor + 1)) total += this.estimateMessageTokens(message)
      return total
    }
    let total = 3_000
    for (const message of active) total += this.estimateMessageTokens(message)
    return total
  }

  private async compactNow(sessionID: string, reason: "auto" | "manual" | "overflow"): Promise<void> {
    const record = this.store.get(sessionID)
    if (!record) return
    const config = this.configStore.get()
    // Overflow recovery shrinks the retained window on each consecutive rejection.
    const shrinkIndex = reason === "overflow" ? Math.min(this.overflowShrink.get(sessionID) ?? 0, SHRINK_STEPS.length - 1) : 0
    const keepBase = config.compaction.keep ?? 15_000
    const keep = reason === "overflow" ? Math.max(1_000, Math.floor(keepBase * SHRINK_STEPS[shrinkIndex])) : keepBase
    if (reason !== "overflow") this.overflowShrink.delete(sessionID)
    const messages = record.messages

    let prefixEnd = 0
    let activeStart = 0
    let previousSummary: string | undefined
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]
      if (message.role === "compaction" && message.status === "completed") {
        prefixEnd = i
        activeStart = i + 1
        previousSummary = message.summary
        break
      }
    }
    const active = messages.slice(activeStart)
    if (active.length === 0) {
      if (reason === "manual") this.synthetic(sessionID, "Nothing to compact yet.", { resume: false })
      return
    }

    let accumulated = 0
    let boundary = active.length
    for (let i = active.length - 1; i >= 0; i--) {
      const message = active[i]
      let size = 0
      if (message.role === "user" || message.role === "synthetic") size = estimateTokens(message.text)
      else if (message.role === "shell") size = estimateTokens(message.output ?? "")
      else if (message.role === "assistant") {
        size = message.content.reduce(
          (sum, part) => sum + (part.type === "text" || part.type === "reasoning" ? estimateTokens(part.text) : 200),
          0,
        )
      }
      accumulated += size
      if (accumulated > keep) {
        boundary = i + 1
        break
      }
      boundary = i
    }
    while (
      boundary < active.length &&
      active[boundary].role !== "user" &&
      active[boundary].role !== "synthetic"
    ) {
      boundary++
    }
    const older = active.slice(0, boundary)
    const recent = active.slice(boundary)
    if (older.length === 0) {
      if (reason === "manual") this.synthetic(sessionID, "Nothing to compact yet.", { resume: false })
      return
    }

    const agent = this.agents.resolve("compaction")
    // Upstream: the compaction agent's model when configured, otherwise the session model.
    const agentModel = agent.model
      ? lookupModel(config, agent.model.providerID, agent.model.modelID)
      : undefined
    const model = agentModel ?? this.resolveModel(record.info)?.model
    if (!model) return
    const runtime = resolveProvider(config, model.providerID)
    if (!runtime) return
    const compactionVariant = agentModel ? agent.model?.variant : record.info.model?.variant

    const compactionMessage: Message = {
      id: id("msg"),
      sessionID,
      role: "compaction",
      summary: "",
      status: "running",
      time: { created: Date.now() },
    }
    this.emit({ type: "message.created", sessionID, message: compactionMessage })

    const modelMessages = toModelMessages(older, { model: { providerID: model.providerID, modelID: model.id } })
    if (previousSummary) {
      modelMessages.unshift({
        role: "user",
        content: [{ type: "text", text: `<conversation-checkpoint>\n${previousSummary}\n</conversation-checkpoint>` }],
      })
    }
    modelMessages.push({ role: "user", content: [{ type: "text", text: buildCompactionPrompt(Boolean(previousSummary)) }] })

    const headers = this.requestHeaders(record.info, runtime.headers)
    try {
      let summary = await this.streamTextPlain(runtime, model, agent.system, modelMessages, headers, compactionVariant)
      if (!summary.includes("## ")) {
        summary = await this.streamTextPlain(runtime, model, agent.system, [
          ...modelMessages,
          { role: "assistant", content: [{ type: "text", text: summary }] },
          { role: "user", content: [{ type: "text", text: COMPACTION_NUDGE }] },
        ], headers, compactionVariant)
      }
      if (compactionMessage.role === "compaction") {
        compactionMessage.summary = summary
        compactionMessage.status = "completed"
        compactionMessage.time.completed = Date.now()
      }
      record.messages = [...messages.slice(0, prefixEnd), compactionMessage, ...recent]
      this.store.markRewrite(sessionID)
      if (reason === "overflow") this.overflowShrink.set(sessionID, shrinkIndex + 1)
      for (const removed of older) {
        this.emit({ type: "message.deleted", sessionID, messageID: removed.id })
      }
      this.emit({ type: "message.created", sessionID, message: compactionMessage })
      this.touch(record.info)
      this.persist(sessionID, true)
    } catch (error) {
      if (compactionMessage.role === "compaction") {
        compactionMessage.status = "failed"
        compactionMessage.error = error instanceof Error ? error.message : String(error)
        compactionMessage.time.completed = Date.now()
      }
      this.emit({ type: "message.updated", sessionID, message: compactionMessage })
      if (!record.messages.some((message) => message.id === compactionMessage.id)) {
        record.messages.splice(prefixEnd, 0, compactionMessage)
      }
      this.persist(sessionID, true)
      throw error
    }
  }

  private async streamTextPlain(
    runtime: ProviderRuntime,
    model: ModelInfo,
    system: string | undefined,
    messages: ModelMessage[],
    headers?: Record<string, string>,
    variant?: string,
  ): Promise<string> {
    const options = variantOptions(runtime.kind, model, variant)
    const result = streamText({
      model: createLanguageModel(runtime, model.id),
      system: system ?? undefined,
      messages,
      maxRetries: 1,
      headers,
      providerOptions: options.providerOptions as never,
      maxOutputTokens: options.maxOutputTokens,
    })
    let text = ""
    for await (const chunk of result.fullStream) {
      if (chunk.type === "text-delta") text += chunk.text
      if (chunk.type === "error") throw chunk.error instanceof Error ? chunk.error : new Error(String(chunk.error))
    }
    return text.trim()
  }

  // -------------------------------------------------------------------------
  // Titles
  // -------------------------------------------------------------------------

  async generateTitle(sessionID: string): Promise<void> {
    const record = this.store.get(sessionID)
    if (!record || record.info.title) return
    const firstUser = record.messages.find((message) => message.role === "user")
    if (!firstUser || firstUser.role !== "user" || !firstUser.text.trim()) return
    const config = this.configStore.get()
    const agent = this.agents.resolve("title")
    const prompt = [{ role: "user", content: [{ type: "text", text: firstUser.text.slice(0, 4_000) }] }] as ModelMessage[]
    const headers = this.requestHeaders(record.info)

    // Candidates: the small model first, then the session model (upstream `title.ts`
    // retries with the primary model when the preferred one fails).
    const small = pickSmallModel(config, record.info.model?.providerID)
    const primary = this.resolveModel(record.info)?.model
    const candidates: { model: ModelInfo; variant?: string }[] = []
    if (small) {
      const minimalVariant = ["none", "minimal", "low"].find((variant) => (small.variants ?? []).includes(variant))
      candidates.push({ model: small, variant: agent.model?.variant ?? minimalVariant })
    }
    if (primary && (!small || primary.id !== small.id || primary.providerID !== small.providerID)) {
      candidates.push({ model: primary, variant: record.info.model?.variant })
    }

    let text = ""
    for (const candidate of candidates) {
      const key = `${candidate.model.providerID}/${candidate.model.id}`
      if (this.failedTitleModels.has(key)) continue
      const runtime = resolveProvider(config, candidate.model.providerID)
      if (!runtime) continue
      try {
        text = await this.streamTextPlain(
          runtime,
          candidate.model,
          agent.system,
          prompt,
          this.requestHeaders(record.info, runtime.headers),
          candidate.variant,
        )
        break
      } catch (error) {
        this.failedTitleModels.add(key)
        this.log(`title model ${key} failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (!text) return
    const title = text
      .split("\n")[0]
      .replace(/^["'#\s]+|["'\s]+$/g, "")
      .slice(0, 64)
      .trim()
    if (!title) return
    record.info.title = title
    this.touch(record.info)
    this.persist(sessionID, true)
    this.emit({ type: "session.updated", session: record.info })
  }

  /**
   * Reviews a scheduled task instruction before saving it. Returns a short
   * title, up to three clarification questions, and the final instruction.
   * Fails open: if the model/provider is unavailable the task can still be
   * saved with the original instruction.
   */
  private async clarifySchedule(input: ScheduleClarifyInput): Promise<ScheduleClarifyResult> {
    const instruction = input.instruction.trim()
    const fallbackTitle = instruction.split("\n")[0].replace(/^["'#\s]+|["'\s]+$/g, "").slice(0, 72) || "Tarea programada"
    const fallback: ScheduleClarifyResult = {
      title: fallbackTitle,
      clear: true,
      questions: [],
      finalInstruction: instruction,
    }
    if (!instruction) return { ...fallback, error: "La instrucción está vacía." }

    const config = this.configStore.get()
    let resolved: { runtime: ReturnType<typeof resolveProvider>; model: ModelInfo } | undefined
    if (input.model) resolved = this.runtimeFor(config, input.model)
    if (!resolved) {
      const ref = this.defaultModelRef(input.workspace)
      if (ref) resolved = this.runtimeFor(config, ref)
    }
    if (!resolved?.runtime) return { ...fallback, error: "No hay un modelo disponible para revisar la instrucción." }

    const system = [
      "You review instructions for unattended scheduled tasks in OpenOrch.",
      "Return ONLY a JSON object (no markdown, no commentary) with this shape:",
      '{"title":"short title, max 8 words","clear":true,"questions":[],"finalInstruction":"self-contained instruction"}',
      "The task runs autonomously: the instruction must say what to do, where (the workspace is provided) and what result is expected.",
      "If critical information is missing, set clear=false and ask at most 3 concise questions with useful options. Never ask about schedule, time, timezone, model, effort or workspace: those are already configured.",
      "When clear=true, questions must be empty and finalInstruction must preserve the user's intent and add concrete success criteria/output expectations.",
      "If previous answers are provided, incorporate them and do not ask the same thing again.",
      "Use the same language as the instruction.",
    ].join("\n")
    const user = JSON.stringify(
      {
        instruction,
        workspace: input.workspace,
        previousAnswers: input.answers ?? [],
      },
      null,
      2,
    )

    try {
      const variant = input.model?.variant
      const options = variantOptions(resolved.runtime.kind, resolved.model, variant)
      const result = streamText({
        model: createLanguageModel(resolved.runtime, resolved.model.id),
        system,
        messages: [{ role: "user", content: [{ type: "text", text: user }] }] as ModelMessage[],
        maxRetries: 1,
        maxOutputTokens: Math.min(options.maxOutputTokens ?? 1_200, 1_200),
        providerOptions: options.providerOptions as never,
        abortSignal: AbortSignal.timeout(60_000),
      })
      let text = ""
      for await (const chunk of result.fullStream) {
        if (chunk.type === "text-delta") text += chunk.text
        if (chunk.type === "error") throw chunk.error instanceof Error ? chunk.error : new Error(String(chunk.error))
      }
      const cleaned = text
        .trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, "")
        .trim()
      const start = cleaned.indexOf("{")
      const end = cleaned.lastIndexOf("}")
      if (start < 0 || end <= start) return { ...fallback, error: "El modelo no devolvió una revisión válida." }
      const parsed = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>
      const title =
        typeof parsed.title === "string" && parsed.title.trim() ? parsed.title.trim().slice(0, 80) : fallbackTitle
      const rawQuestions = Array.isArray(parsed.questions) ? parsed.questions : []
      const questions: ScheduleClarifyQuestion[] = rawQuestions
        .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
        .slice(0, 3)
        .map((entry) => {
          const options = Array.isArray(entry.options)
            ? entry.options
                .filter((option): option is Record<string, unknown> => Boolean(option) && typeof option === "object")
                .slice(0, 6)
                .map((option) => ({
                  label: typeof option.label === "string" ? option.label.slice(0, 80) : "",
                  description: typeof option.description === "string" ? option.description.slice(0, 240) : undefined,
                }))
                .filter((option) => option.label)
            : []
          return {
            header: typeof entry.header === "string" && entry.header.trim() ? entry.header.trim().slice(0, 40) : "Aclaración",
            question: typeof entry.question === "string" ? entry.question.trim() : "",
            ...(options.length ? { options } : {}),
            ...(entry.multiple === true ? { multiple: true } : {}),
          }
        })
        .filter((entry) => entry.question)
      const finalInstruction =
        typeof parsed.finalInstruction === "string" && parsed.finalInstruction.trim()
          ? parsed.finalInstruction.trim()
          : instruction
      const clear = parsed.clear !== false && questions.length === 0
      return { title, clear, questions: clear ? [] : questions, finalInstruction }
    } catch (error) {
      return { ...fallback, error: error instanceof Error ? error.message : String(error) }
    }
  }

  private computeCost(model: ModelInfo, usage: TokenUsage): number {
    const cost = model.cost
    if (!cost) return 0
    const per = (tokens: number | undefined, price: number | undefined) => ((tokens ?? 0) * (price ?? 0)) / 1_000_000
    const uncachedInput = Math.max(0, usage.input - (usage.cacheRead ?? 0) - (usage.cacheWrite ?? 0))
    return (
      per(uncachedInput, cost.input) + per(usage.cacheRead, cost.cacheRead) + per(usage.cacheWrite, cost.cacheWrite) + per(usage.output, cost.output)
    )
  }

  /**
   * Lazily built file index for a session directory (ripgrep `--files`, honoring
   * `.gitignore`). Cached briefly so `@` mentions never walk the filesystem per keystroke.
   */
  private fileIndexes = new Map<string, { directory: string; files: string[]; at: number }>()

  async indexFiles(sessionID: string): Promise<string[]> {
    const directory = this.sessionDirectory(sessionID)
    const cached = this.fileIndexes.get(sessionID)
    if (cached && cached.directory === directory && Date.now() - cached.at < 60_000) return cached.files
    const files = await this.scanFiles(directory)
    this.fileIndexes.set(sessionID, { directory, files, at: Date.now() })
    return files
  }

  private async scanFiles(directory: string): Promise<string[]> {
    const limit = 20_000
    const { findRipgrep } = await import("./ripgrep.js")
    const rg = await findRipgrep()
    if (rg) {
      try {
        const { execFile } = await import("node:child_process")
        const { promisify } = await import("node:util")
        const { stdout } = await promisify(execFile)(
          rg,
          ["--files", "--glob", "!**/.git/**", "--glob", "!**/node_modules/**", "--glob", "!**/.openorch/**"],
          { cwd: directory, timeout: 10_000, maxBuffer: 32 * 1024 * 1024 },
        )
        return stdout
          .split(/\r?\n/)
          .filter(Boolean)
          .slice(0, limit)
          .map((entry) => entry.replaceAll("\\", "/"))
      } catch {
        // fall through to the JS walk
      }
    }
    const out: string[] = []
    const skip = new Set([".git", "node_modules", ".openorch"])
    const walk = (current: string, depth: number) => {
      if (out.length >= limit || depth > 12) return
      let entries: import("node:fs").Dirent[] = []
      try {
        entries = readdirSync(current, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (out.length >= limit) return
        if (entry.name.startsWith(".") || skip.has(entry.name)) continue
        const full = path.join(current, entry.name)
        if (entry.isDirectory()) {
          walk(full, depth + 1)
          continue
        }
        out.push(path.relative(directory, full).split(path.sep).join("/"))
      }
    }
    walk(directory, 0)
    return out
  }

  /** Name-first file search over the cached index, mirroring upstream `file.find`. */
  async searchFiles(sessionID: string, query: string, limit = 20): Promise<string[]> {
    const files = await this.indexFiles(sessionID)
    const needle = query.trim().toLowerCase()
    if (!needle) return files.slice(0, limit)
    const scored: { path: string; score: number }[] = []
    for (const file of files) {
      const lower = file.toLowerCase()
      const base = lower.split("/").pop() ?? lower
      const score = base.startsWith(needle) ? 3 : base.includes(needle) ? 2 : lower.includes(needle) ? 1 : 0
      if (score > 0) scored.push({ path: file, score })
    }
    scored.sort((a, b) => b.score - a.score || a.path.length - b.path.length)
    return scored.slice(0, limit).map((entry) => entry.path)
  }

  /** Skills available for a session (global + project), for the `@` menu. */
  skillsFor(sessionID: string): SkillInfo[] {
    const record = this.store.get(sessionID)
    return discoverSkills(this.configStore.get(), record?.info.directory ?? this.projectDirectory)
  }

  /** Installs a manually authored skill into the global directory (used by `/skill`). */
  installSkill(draft: { id: string; name?: string; description?: string; content: string }): SkillInfo {
    const skill = installGlobalSkill(draft)
    this.log(`skill installed: ${skill.id} at ${skill.directory}`)
    return skill
  }

  /** Reads a discovered skill with its content (manager detail view). */
  readSkill(sessionID: string, id: string): SkillDetail | undefined {
    const record = this.store.get(sessionID)
    return readSkillDetail(this.configStore.get(), record?.info.directory ?? this.projectDirectory, id)
  }

  /** Saves edits to a discovered skill (target validated against the discovery roots). */
  saveSkill(sessionID: string, draft: { id: string; name?: string; description?: string; content: string }): SkillInfo {
    const record = this.store.get(sessionID)
    const skill = writeSkill(this.configStore.get(), record?.info.directory ?? this.projectDirectory, draft)
    this.log(`skill saved: ${skill.id} at ${skill.directory}`)
    return skill
  }

  /** Removes a global skill directory (project skills are never touched). */
  removeSkill(id: string): void {
    removeGlobalSkill(id)
    this.log(`skill removed: ${id}`)
  }

  /** Reads a skill folder picked by the user so the dialog can prefill its fields. */
  importSkillDraft(directory: string): { id: string; name?: string; description?: string; content: string } | undefined {
    return readSkillDraft(directory)
  }

  /** Builds an index error is never fatal for the UI; empty lists are fine. */
  async findFiles(sessionID: string, query: string, limit = 20): Promise<string[]> {
    return this.searchFiles(sessionID, query, limit)
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findLastIndex<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) {
    if (predicate(items[i])) return i
  }
  return -1
}

function toTokenUsage(
  usage:
    | {
        inputTokens?: number
        outputTokens?: number
        inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number }
        outputTokenDetails?: { reasoningTokens?: number }
      }
    | undefined,
): TokenUsage | undefined {
  if (!usage) return undefined
  return {
    input: usage.inputTokens ?? 0,
    output: usage.outputTokens ?? 0,
    reasoning: usage.outputTokenDetails?.reasoningTokens,
    cacheRead: usage.inputTokenDetails?.cacheReadTokens,
    cacheWrite: usage.inputTokenDetails?.cacheWriteTokens,
  }
}

function addTokens(existing: TokenUsage | undefined, usage: TokenUsage): TokenUsage {
  return {
    input: (existing?.input ?? 0) + usage.input,
    output: (existing?.output ?? 0) + usage.output,
    reasoning: (existing?.reasoning ?? 0) + (usage.reasoning ?? 0),
    cacheRead: (existing?.cacheRead ?? 0) + (usage.cacheRead ?? 0),
    cacheWrite: (existing?.cacheWrite ?? 0) + (usage.cacheWrite ?? 0),
  }
}

function isOverflowError(message: string): boolean {
  const lower = message.toLowerCase()
  return (
    lower.includes("context length") ||
    lower.includes("context window") ||
    lower.includes("maximum context") ||
    lower.includes("too long") ||
    lower.includes("too many tokens") ||
    lower.includes("prompt is too long")
  )
}

export function isRetryable(message: string): boolean {
  const lower = message.toLowerCase()
  // Gateway hiccups ("Endpoint is unavailable") are transient; entitlement errors are not.
  if (lower.includes("subscription is required")) return false
  return (
    lower.includes("rate limit") ||
    lower.includes("overloaded") ||
    lower.includes("timeout") ||
    lower.includes("fetch failed") ||
    lower.includes("econn") ||
    lower.includes("socket") ||
    lower.includes("unavailable") ||
    lower.includes("500") ||
    lower.includes("502") ||
    lower.includes("503") ||
    lower.includes("504") ||
    lower.includes("529")
  )
}
