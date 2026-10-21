import type { ModelInfo, McpServerConfig, McpServerStatus, QuestionAnswer, SkillInfo, ToolContent, WebSearchResult } from "@openorch/shared"
import type { z } from "zod"

export interface ToolProgressUpdate {
  metadata?: Record<string, unknown>
}

export type { SkillInfo }

export interface WorktreeView {
  directory: string
  branch?: string
  detached?: boolean
  source: string
  current?: boolean
}

export interface WebSearchOutcome {
  provider: string
  results: WebSearchResult[]
}

/** One browser tab of the right dock, as seen by the agent. */
export interface BrowserTabInfo {
  id: string
  url: string
  title: string
}

export interface BrowserSnapshot {
  tab: BrowserTabInfo
  /** Accessibility tree with `[ref=eN]` markers. Page content is untrusted. */
  tree: string
  truncated: boolean
  /** Bounded visible text, used when the tree has no useful entries. */
  text: string
}

/**
 * The desktop browser bridge. Main implements it over the dock `<webview>`
 * guests (CDP); headless runs simply have no browser attached.
 */
export interface BrowserService {
  list: () => BrowserTabInfo[]
  open: (url?: string) => Promise<BrowserTabInfo>
  close: (tabID: string) => Promise<BrowserTabInfo[]>
  focus: (tabID: string) => BrowserTabInfo
  navigate: (tabID: string, url: string) => Promise<BrowserTabInfo>
  back: (tabID: string) => Promise<BrowserTabInfo>
  forward: (tabID: string) => Promise<BrowserTabInfo>
  reload: (tabID: string) => Promise<BrowserTabInfo>
  snapshot: (tabID: string, options?: { maxChars?: number }) => Promise<BrowserSnapshot>
  click: (tabID: string, ref: string) => Promise<BrowserTabInfo>
  hover: (tabID: string, ref: string) => Promise<BrowserTabInfo>
  fill: (tabID: string, ref: string, text: string) => Promise<BrowserTabInfo>
  select: (tabID: string, ref: string, values: string[]) => Promise<BrowserTabInfo>
  check: (tabID: string, ref: string, checked: boolean) => Promise<BrowserTabInfo>
  press: (tabID: string, key: string) => Promise<BrowserTabInfo>
  scroll: (tabID: string, deltaY: number, ref?: string) => Promise<BrowserTabInfo>
  wait: (tabID: string, options: { text?: string; timeoutMs: number }) => Promise<{ tab: BrowserTabInfo; matched: boolean }>
  screenshot: (tabID: string) => Promise<{ tab: BrowserTabInfo; dataUrl: string }>
  evaluate: (tabID: string, script: string) => Promise<{ tab: BrowserTabInfo; value: unknown }>
}

export interface ToolServices {
  /** Ask the user structured questions (question tool). */
  ask: (sessionID: string, questions: unknown[]) => Promise<QuestionAnswer[]>
  /** Spawn (or continue) a subagent session. */
  spawnSubagent: (input: {
    parentSessionID: string
    agent: string
    prompt: string
    description: string
    model?: string
    sessionID?: string
    background?: boolean
  }) => Promise<{ sessionID: string; status: "completed" | "running"; output: string; model?: string }>
  /** Available subagents (id + description) for tool description augmentation. */
  subagents: () => { id: string; description: string }[]
  /** Web search implementation, if configured. */
  searchWeb: (query: string) => Promise<WebSearchOutcome>
  /** Tell the engine about AGENTS.md files discovered while reading. */
  instructions: (sessionID: string, filePath: string) => Promise<void>
  /** Notify a background shell finished. */
  shellNotify: (sessionID: string, shellID: string, command: string, state: "completed" | "failed", output: string) => Promise<void>
  /** Skills available in this session. */
  skills: (sessionID: string) => SkillInfo[]
  /** Session management (opencode namespace). */
  renameSession: (sessionID: string, title: string) => Promise<void>
  moveSession: (sessionID: string, directory: string) => Promise<string>
  /** Model catalog for the models tool. */
  listModels: () => ModelInfo[]
  /** MCP server management (mcp tool): config is updated and servers reconnect live. */
  mcp: {
    status: () => McpServerStatus[]
    /** Configured entry for a server (used by `mcp test <name>`). */
    get: (name: string) => McpServerConfig | undefined
    add: (name: string, server: McpServerConfig) => Promise<McpServerStatus>
    remove: (name: string) => Promise<void>
    test: (server: McpServerConfig, name?: string) => Promise<{ ok: boolean; tools: string[]; needsAuth?: boolean; error?: string }>
    /** Resources exposed by connected servers (mcp resource tools). */
    listResources: (name?: string) => Promise<{ server: string; resources: { uri: string; name?: string; mimeType?: string }[] }[]>
    readResource: (name: string, uri: string) => Promise<ToolContent[]>
  }
  /** Git worktree management. */
  worktree: {
    create: (directory: string, name: string) => Promise<WorktreeView>
    list: (directory: string) => Promise<WorktreeView[]>
    remove: (directory: string, target: string, force: boolean) => Promise<void>
  }
  /** Desktop browser (right dock) control. Absent when no window is attached. */
  browser?: BrowserService
}

export interface ToolContext {
  sessionID: string
  agent: string
  directory: string
  abort: AbortSignal
  progress(update?: ToolProgressUpdate): void
  permission(input: {
    action?: string
    resources: string[]
    save?: string[]
    metadata?: Record<string, unknown>
    message?: string
    onAsk?: (request: { id: string }) => void
  }): Promise<void>
  services: ToolServices
  config: { shellTimeoutMs: number; dataDir: string }
  /** True while a scheduled task is running (unattended safety policy). */
  scheduled?: boolean
}

export interface ToolOutput {
  content: ToolContent[]
  metadata?: Record<string, unknown>
}

export interface ToolDefinition<I = unknown> {
  name: string
  description: string
  /** Zod schema for validation (built-in tools). */
  inputSchema?: z.ZodType<I>
  /** Raw JSON Schema (MCP tools). */
  jsonSchema?: unknown
  /** Permission action; defaults to the tool name. */
  permission?: string
  /** Namespace used by Code Mode paths (e.g. `tools.opencode["session_rename"]`). */
  namespace?: string
  /** When true, the tool is only callable from the Code Mode `execute` runtime. */
  codemode?: boolean
  execute(input: I, ctx: ToolContext): Promise<ToolOutput | void>
}

export function effectiveName(tool: ToolDefinition): string {
  return tool.namespace ? `${tool.namespace.replaceAll(".", "_")}_${tool.name}` : tool.name
}

export type { ToolContent } from "@openorch/shared"

export function textContent(text: string): ToolContent {
  return { type: "text", text }
}

export function textOutput(text: string, metadata?: Record<string, unknown>): ToolOutput {
  return { content: [textContent(text)], metadata }
}

export class ToolFailure extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ToolFailure"
  }
}
