import { z } from "zod"
import type { ModelInfo } from "@openorch/shared"
import type { ToolDefinition } from "./types.js"
import { textOutput, ToolFailure, type ToolContext } from "./types.js"

/**
 * The `opencode` tool namespace: session management, worktrees and model lookup.
 * Mirrors upstream names (`session_rename`, `session_move`, `worktree_create`,
 * `worktree_list`, `worktree_remove`, `models`).
 */

export const sessionRenameTool: ToolDefinition = {
  namespace: "opencode", codemode: true, name: "session_rename",
  description: "Rename a session, or omit sessionID to rename the current session. Use a short, specific title that summarizes the work being done.",
  inputSchema: z.object({
    sessionID: z.string().optional().describe("Omit to rename the current session."),
    title: z.string().describe("New session title."),
  }),
  async execute(input: { sessionID?: string; title: string }, ctx: ToolContext) {
    const target = input.sessionID ?? ctx.sessionID
    await ctx.services.renameSession(target, input.title)
    return textOutput(`Renamed session ${target} to "${input.title}".`, { sessionID: target, title: input.title })
  },
}

export const sessionMoveTool: ToolDefinition = {
  namespace: "opencode", codemode: true, name: "session_move",
  description:
    "Move a session to another directory, or omit sessionID to move the current session. The current session moves at the next safe boundary; do not run destination-dependent tools in the same execute call.",
  inputSchema: z.object({
    sessionID: z.string().optional().describe("Omit to move the current session."),
    directory: z.string().describe("Destination directory, relative to the target session's directory or absolute. Supports ~."),
  }),
  async execute(input: { sessionID?: string; directory: string }, ctx: ToolContext) {
    const target = input.sessionID ?? ctx.sessionID
    const moved = await ctx.services.moveSession(target, input.directory)
    return textOutput(`Moved session ${target} to ${moved}.`, { sessionID: target, directory: moved })
  },
}

export const worktreeCreateTool: ToolDefinition = {
  namespace: "opencode", codemode: true, name: "worktree_create",
  description: "Create a named git worktree for the current repository. Returns its directory; use opencode_session_move to work inside it.",
  inputSchema: z.object({
    name: z.string().describe("Worktree name (used for the branch and folder)."),
  }),
  async execute(input: { name: string }, ctx: ToolContext) {
    const info = await ctx.services.worktree.create(ctx.directory, input.name)
    return textOutput(
      `Created worktree "${info.branch}" at ${info.directory}\nUse opencode_session_move with this directory to switch the session into it.`,
      { directory: info.directory, branch: info.branch },
    )
  },
}

export const worktreeListTool: ToolDefinition = {
  namespace: "opencode", codemode: true, name: "worktree_list",
  description: "List the git worktrees of the current repository, including the main checkout.",
  inputSchema: z.object({}),
  async execute(_input: unknown, ctx: ToolContext) {
    const list = await ctx.services.worktree.list(ctx.directory)
    const lines = list.map(
      (entry) =>
        `${entry.current ? "*" : " "} ${entry.directory}${entry.branch ? `  (${entry.branch})` : entry.detached ? "  (detached)" : ""}`,
    )
    return textOutput(lines.join("\n") || "(no worktrees)", {
      worktrees: list.map((entry) => ({ directory: entry.directory, branch: entry.branch, current: entry.current })),
    })
  },
}

export const worktreeRemoveTool: ToolDefinition = {
  namespace: "opencode", codemode: true, name: "worktree_remove",
  description: "Remove a worktree from the current repository. Use worktree_list for valid directories.",
  permission: "edit",
  inputSchema: z.object({
    directory: z.string().describe("Absolute path of the worktree to remove."),
    force: z.boolean().optional().describe("Discard modified and untracked files. Only set this when the user has confirmed forced removal."),
  }),
  async execute(input: { directory: string; force?: boolean }, ctx: ToolContext) {
    await ctx.permission({
      action: "edit",
      resources: [input.directory],
      save: ["*"],
      metadata: { worktree: input.directory, force: Boolean(input.force) },
      message: `Remove worktree ${input.directory}${input.force ? " (forced, discarding changes)" : ""}?`,
    })
    await ctx.services.worktree.remove(ctx.directory, input.directory, Boolean(input.force))
    return textOutput(`Removed worktree ${input.directory}.`, { directory: input.directory })
  },
}

export const modelsTool: ToolDefinition = {
  namespace: "opencode", codemode: true, name: "models",
  description:
    "Search the models available to use. Use this to turn a model name the user mentions into an exact reference before running a subagent on it. Check your own provider first.",
  inputSchema: z.object({
    query: z.string().optional().describe("Text to search for in model names and IDs."),
    provider: z.string().optional().describe("Provider ID or name to filter by. Try your own provider first."),
    all: z.boolean().optional().describe("Include older versions of each model family. By default only the newest version is listed."),
    limit: z.number().int().min(1).max(100).optional().describe("Maximum number of models to return. Defaults to 20."),
    offset: z.number().int().min(0).optional().describe("Number of models to skip, for paging through results."),
  }),
  async execute(
    input: { query?: string; provider?: string; all?: boolean; limit?: number; offset?: number },
    ctx: ToolContext,
  ) {
    const query = (input.query ?? "").toLowerCase()
    const providerFilter = (input.provider ?? "").toLowerCase()
    const all = ctx.services.listModels()
    const filtered = all.filter((model) => {
      if (providerFilter && !model.providerID.toLowerCase().includes(providerFilter)) return false
      if (!query) return true
      return model.id.toLowerCase().includes(query) || model.name.toLowerCase().includes(query)
    })
    const limit = input.limit ?? 20
    const offset = input.offset ?? 0
    const page = filtered.slice(offset, offset + limit)
    const total = filtered.length
    const lines = page.map(
      (model: ModelInfo) =>
        `- ${model.providerID}/${model.id}${model.name && model.name !== model.id ? ` (${model.name})` : ""}` +
        `${model.limit?.context ? ` · ctx ${Math.round(model.limit.context / 1000)}k` : ""}` +
        `${model.cost?.input !== undefined ? ` · $${model.cost.input}/M in, $${model.cost.output ?? 0}/M out` : ""}` +
        `${model.variants?.length ? ` · variants: ${model.variants.join(", ")}` : ""}`,
    )
    const body = lines.length > 0 ? lines.join("\n") : "(no models matched)"
    return textOutput(`${body}\n\nTotal: ${total}${offset + page.length < total ? ` (next offset: ${offset + page.length})` : ""}`, {
      total,
      next: offset + page.length < total ? offset + page.length : undefined,
      models: page.map((model) => `${model.providerID}/${model.id}`),
    })
  },
}

export const opencodeTools: ToolDefinition[] = [
  sessionRenameTool,
  sessionMoveTool,
  worktreeCreateTool,
  worktreeListTool,
  worktreeRemoveTool,
  modelsTool,
]
