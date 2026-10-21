import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import type { AgentInfo, AgentSettings, Config, ModelInfo, PermissionRule } from "@openorch/shared"
import { home } from "../util.js"
import {
  anthropic as PROMPT_ANTHROPIC,
  gpt as PROMPT_GPT,
  gpt_astra as PROMPT_ASTRA,
  kimi as PROMPT_KIMI,
  meta as PROMPT_META,
  system as PROMPT_SYSTEM,
  trinity as PROMPT_TRINITY,
} from "./prompts.generated.js"

// ---------------------------------------------------------------------------
// Built-in prompts (copied from OpenCode's built-in plugin/agent.ts)
// ---------------------------------------------------------------------------

export const PROMPT_EXPLORE = `You are a file search specialist. You excel at thoroughly navigating and exploring codebases.

Guidelines:
- Your role is EXCLUSIVELY to search and analyze
- Parallelize independent tool calls for searches and reads whenever possible
- Adapt your search approach based on the thoroughness level specified by the caller
- Return file paths as absolute paths in your final response
- You MUST NOT create, modify, delete, move, or copy files, including temporary files and reports
- Shell commands MUST be read-only. NEVER run commands that write files or change system state

Complete the user's search request efficiently and report your findings clearly.`

export const PROMPT_TITLE = `You are a title generator. You output ONLY a thread title. Nothing else.

<task>
Generate a brief title that would help the user find this conversation later.

Follow all rules in <rules>
Use the <examples> so you know what a good title looks like.
Your output must be:
- A single line
- <=50 characters
- No explanations
</task>

<rules>
- you MUST use the same language as the user message you are summarizing
- Title must be grammatically correct and read naturally - no word salad
- Never include tool names in the title (e.g. "read tool", "bash tool", "edit tool")
- Focus on the main topic or question the user needs to retrieve
- Vary your phrasing - avoid repetitive patterns like always starting with "Analyzing"
- When a file is mentioned, focus on WHAT the user wants to do WITH the file, not just that they shared it
- Keep exact: technical terms, numbers, filenames, HTTP codes
- Remove: the, this, my, a, an
- Never assume tech stack
- Never use tools
- NEVER respond to questions, just generate a title for the conversation
- The title should NEVER include "summarizing" or "generating" when generating a title
- DO NOT SAY YOU CANNOT GENERATE A TITLE OR COMPLAIN ABOUT THE INPUT
- Always output something meaningful, even if the input is minimal.
- If the user message is short or conversational (e.g. "hello", "lol", "what's up", "hey"):
  -> create a title that reflects the user's tone or intent (such as Greeting, Quick check-in, Light chat, Intro message, etc.)
</rules>

<examples>
"debug 500 errors in production" -> Debugging production 500 errors
"refactor user service" -> Refactoring user service
"why is app.js failing" -> app.js failure investigation
"implement rate limiting" -> Rate limiting implementation
"how do I connect postgres to my API" -> Postgres API connection
"best practices for React hooks" -> React hooks best practices
"@src/credential.ts can you add refresh token support" -> Credential refresh token support
"@utils/parser.ts this is broken" -> Parser bug fix
"look at @config.json" -> Config review
"@App.tsx add dark mode toggle" -> Dark mode toggle in App
</examples>`

export const PROMPT_SUMMARY = `Summarize what was done in this conversation. Write like a pull request description.

Rules:
- 2-3 sentences max
- Describe the changes made, not the process
- Do not mention running tests, builds, or other validation steps
- Do not explain what the user asked for
- Write in first person (I added..., I fixed...)
- Never ask questions or add new questions
- If the conversation ends with an unanswered question to the user, preserve that exact question
- If the conversation ends with an imperative statement or request to the user (e.g. "Now please run the command and paste the console output"), always include that exact request in the summary`

export const MAX_STEPS_PROMPT = `CRITICAL - MAXIMUM STEPS REACHED

The maximum number of steps allowed for this task has been reached. Tools are disabled until next user input. Respond with text only.

STRICT REQUIREMENTS:
1. Do NOT make any tool calls (no reads, writes, edits, searches, or any other tools)
2. MUST provide a text response summarizing work done so far
3. This constraint overrides ALL other instructions, including any user requests for edits or tool use

Response must include:
- Statement that maximum steps for this agent have been reached
- Summary of what has been accomplished so far
- List of any remaining tasks that were not completed
- Recommendations for what should be done next

Any attempt to use tools is a critical violation. Respond with text ONLY.`

// ---------------------------------------------------------------------------
// Agent definitions
// ---------------------------------------------------------------------------

export interface AgentDef {
  id: string
  name: string
  description?: string
  mode: "primary" | "subagent" | "all"
  hidden: boolean
  color?: string
  system?: string
  steps?: number
  model?: { providerID: string; modelID: string; variant?: string }
  permissions: PermissionRule[]
  source: "builtin" | "custom"
}

/** Default ruleset from upstream `Agent.Info.default`. */
export function defaultPermissions(): PermissionRule[] {
  return [
    { action: "*", resource: "*", effect: "allow" },
    { action: "external_directory", resource: "*", effect: "ask" },
    // The dock browser can reach any site: ask per origin the first time (the
    // user's "always" remembers only that site). Never let an agent browse
    // silently with the user's session cookies.
    { action: "browser", resource: "*", effect: "ask" },
    { action: "read", resource: "*.env", effect: "ask" },
    { action: "read", resource: "*.env.*", effect: "ask" },
    { action: "read", resource: "*.env.example", effect: "allow" },
  ]
}

export const PLAN_DIRECTORY = path.join(home(), ".openorch", "plan")

export function planEnterReminder(): string {
  return `<system-reminder>
You are in Plan mode. Discuss the plan with the user directly in the conversation. Do not create or update plan files unless the user explicitly asks you to; when they do, write them only in:
${PLAN_DIRECTORY}

Do not modify any other files or ask a subagent to do so.

You remain in Plan mode until the user switches agents. If the user asks you to implement changes, do not do so. Tell them they need to switch agents.
</system-reminder>`
}

export function planLeaveReminder(): string {
  return `<system-reminder>
You are NO LONGER in Plan mode. The previous Plan restrictions no longer apply. Any Plan mode instructions from earlier in this conversation are no longer active.
</system-reminder>`
}

function builtinAgents(): AgentDef[] {
  const agents: AgentDef[] = []

  const build = defaultPermissions()
  build.push({ action: "question", resource: "*", effect: "allow" })
  agents.push({
    id: "build",
    name: "Build",
    description: "The default agent. Executes tools based on configured permissions.",
    mode: "primary",
    hidden: false,
    permissions: build,
    source: "builtin",
  })

  const plan = defaultPermissions()
  plan.push({ action: "question", resource: "*", effect: "allow" })
  plan.push({ action: "edit", resource: "*", effect: "deny" })
  plan.push({ action: "edit", resource: path.join(PLAN_DIRECTORY, "*"), effect: "allow" })
  agents.push({
    id: "plan",
    name: "Plan",
    description: "Read-only agent for exploring the codebase and planning work before implementation.",
    mode: "primary",
    hidden: false,
    permissions: plan,
    source: "builtin",
  })

  const general = defaultPermissions()
  general.push(
    { action: "question", resource: "*", effect: "deny" },
    { action: "subagent", resource: "*", effect: "deny" },
  )
  agents.push({
    id: "general",
    name: "General",
    description:
      "General-purpose agent for researching complex questions and executing multi-step tasks. Use this agent to execute multiple units of work in parallel.",
    mode: "subagent",
    hidden: false,
    permissions: general,
    source: "builtin",
  })

  const explore = defaultPermissions()
  explore.push(
    { action: "*", resource: "*", effect: "deny" },
    { action: "shell", resource: "*", effect: "allow" },
    { action: "grep", resource: "*", effect: "allow" },
    { action: "glob", resource: "*", effect: "allow" },
    { action: "webfetch", resource: "*", effect: "allow" },
    { action: "websearch", resource: "*", effect: "allow" },
    { action: "read", resource: "*", effect: "allow" },
    { action: "read", resource: "*.env", effect: "ask" },
    { action: "read", resource: "*.env.*", effect: "ask" },
    { action: "read", resource: "*.env.example", effect: "allow" },
    { action: "subagent", resource: "*", effect: "deny" },
    { action: "external_directory", resource: "*", effect: "allow" },
  )
  agents.push({
    id: "explore",
    name: "Explore",
    description:
      'Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. "src/components/**/*.tsx"), search code for keywords (eg. "API endpoints"), or answer questions about the codebase (eg. "how do API endpoints work?"). When calling this agent, specify the desired thoroughness level: "quick" for basic searches, "medium" for moderate exploration, or "very thorough" for comprehensive analysis across multiple locations and naming conventions.',
    mode: "subagent",
    hidden: false,
    system: PROMPT_EXPLORE,
    permissions: explore,
    source: "builtin",
  })

  const compaction = defaultPermissions()
  agents.push({
    id: "compaction",
    name: "Compaction",
    mode: "primary",
    hidden: true,
    permissions: compaction,
    source: "builtin",
  })

  const title = defaultPermissions()
  title.push({ action: "*", resource: "*", effect: "deny" })
  agents.push({
    id: "title",
    name: "Title",
    mode: "primary",
    hidden: true,
    system: PROMPT_TITLE,
    permissions: title,
    source: "builtin",
  })

  const summary = defaultPermissions()
  summary.push({ action: "*", resource: "*", effect: "deny" })
  agents.push({
    id: "summary",
    name: "Summary",
    mode: "primary",
    hidden: true,
    system: PROMPT_SUMMARY,
    permissions: summary,
    source: "builtin",
  })

  return agents
}

// ---------------------------------------------------------------------------
// Custom agents (.opencode/agent/*.md frontmatter + config.agents)
// ---------------------------------------------------------------------------

interface Frontmatter {
  data: Record<string, string>
  body: string
}

function parseFrontmatter(content: string): Frontmatter {
  if (!content.startsWith("---")) return { data: {}, body: content }
  const end = content.indexOf("\n---", 3)
  if (end === -1) return { data: {}, body: content }
  const head = content.slice(3, end).trim()
  const body = content.slice(end + 4).trimStart()
  const data: Record<string, string> = {}
  for (const line of head.split("\n")) {
    const match = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/)
    if (!match) continue
    let value = match[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    data[match[1]] = value
  }
  return { data, body }
}

function loadMarkdownAgents(dir: string): AgentDef[] {
  const agentsDir = path.join(dir, "agent")
  if (!existsSync(agentsDir)) return []
  const out: AgentDef[] = []
  const walk = (current: string) => {
    for (const entry of readdirSync(current)) {
      const full = path.join(current, entry)
      const stat = statSync(full)
      if (stat.isDirectory()) {
        walk(full)
        continue
      }
      if (!entry.endsWith(".md")) continue
      const relative = path.relative(agentsDir, full).replace(/\.md$/, "")
      const agentID = relative.split(path.sep).join("/")
      const { data, body } = parseFrontmatter(readFileSync(full, "utf8"))
      const mode = data.mode === "subagent" || data.mode === "all" ? data.mode : "primary"
      const def: AgentDef = {
        id: agentID,
        name: agentID,
        description: data.description,
        mode: mode as AgentDef["mode"],
        hidden: data.hidden === "true",
        color: data.color,
        system: body.trim() ? body : undefined,
        steps: data.steps ? Number.parseInt(data.steps, 10) || undefined : undefined,
        permissions: defaultPermissions(),
        source: "custom",
      }
      if (data.model?.includes("/")) {
        const [providerID, rest] = data.model.split("/")
        const [modelID, variant] = rest.split("#")
        def.model = { providerID, modelID, variant }
      }
      out.push(def)
    }
  }
  walk(agentsDir)
  return out
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export class AgentRegistry {
  private agents = new Map<string, AgentDef>()

  constructor(
    private config: Config,
    private projectDirectory: string,
  ) {
    this.reload()
  }

  reload(projectDirectory?: string): void {
    if (projectDirectory) this.projectDirectory = projectDirectory
    this.agents = new Map()
    for (const agent of builtinAgents()) this.agents.set(agent.id, agent)
    const dirs = [
      path.join(home(), ".config", "opencode"),
      path.join(this.projectDirectory, ".opencode"),
    ]
    for (const dir of dirs) {
      for (const agent of loadMarkdownAgents(dir)) this.agents.set(agent.id, agent)
    }
    for (const [agentID, settings] of Object.entries(this.config.agents)) {
      const existing = this.agents.get(agentID)
      const def: AgentDef = existing ?? {
        id: agentID,
        name: agentID,
        mode: "primary",
        hidden: false,
        permissions: defaultPermissions(),
        source: "custom",
      }
      if (settings.description !== undefined) def.description = settings.description
      if (settings.mode !== undefined) def.mode = settings.mode
      if (settings.hidden !== undefined) def.hidden = settings.hidden
      if (settings.color !== undefined) def.color = settings.color
      if (settings.system !== undefined) def.system = settings.system
      if (settings.steps !== undefined) def.steps = settings.steps
      if (settings.model !== undefined) def.model = settings.model
      if (settings.permissions !== undefined) def.permissions = [...def.permissions, ...settings.permissions]
      this.agents.set(agentID, def)
    }
    // Disabled agents are removed.
    for (const [agentID, settings] of Object.entries(this.config.agents)) {
      if (settings.disabled) this.agents.delete(agentID)
    }
  }

  get(agentID: string): AgentDef | undefined {
    return this.agents.get(agentID)
  }

  /** Returns the resolved agent, falling back to `build`. */
  resolve(agentID?: string): AgentDef {
    if (agentID) {
      const found = this.agents.get(agentID)
      if (found) return found
    }
    return this.agents.get("build")!
  }

  selectable(): AgentDef[] {
    return [...this.agents.values()].filter((agent) => agent.mode !== "subagent" && !agent.hidden)
  }

  subagents(): AgentDef[] {
    return [...this.agents.values()].filter((agent) => agent.mode !== "primary" && !agent.hidden)
  }

  list(): AgentDef[] {
    return [...this.agents.values()]
  }

  toInfo(def: AgentDef): AgentInfo {
    return {
      id: def.id,
      name: def.name,
      description: def.description,
      mode: def.mode,
      hidden: def.hidden,
      color: def.color,
      model: def.model,
      steps: def.steps,
      source: def.source,
    }
  }
}

// ---------------------------------------------------------------------------
// System prompt composition
// ---------------------------------------------------------------------------

/** Renders `${OPENCODE_TOOL_GUIDANCE}` based on the tools offered to the model. */
export function renderSystemPrompt(prompt: string, tools: string[]): string {
  const instructions: string[] = []
  if (tools.includes("shell")) {
    instructions.push(
      "- Prefer dedicated tools over shell commands; fall back to the shell when a tool cannot do what you need.",
      "- Do not chain shell commands with separators like `echo \"====\";` or `printf '---'`; the output becomes noisy in a way that makes the user's side of the conversation worse.",
    )
  }
  if (tools.includes("write")) {
    instructions.push(
      "- Use the write tool to create files or completely replace their content. Prefer using the edit tool for targeted changes.",
    )
  }
  if (tools.includes("edit")) {
    instructions.push(
      "- Use the edit tool for targeted changes to existing text files. It replaces the exact text in `oldString` with `newString`, and the values must differ. By default, `oldString` must occur exactly once. If it occurs multiple times, include more surrounding context to make it unique or set `replaceAll` to true to replace every occurrence.",
    )
  }
  return prompt.replace("${OPENCODE_TOOL_GUIDANCE}", instructions.join("\n"))
}

export function baseSystemPrompt(tools: string[]): string {
  return renderSystemPrompt(PROMPT_SYSTEM, tools)
}

/**
 * Model-specific prompt optimization, mirroring upstream `plugin/optimize.ts`.
 * Only applies when the agent has no system prompt of its own.
 * Returns `{ text, mode }` where mode is "override" or "append".
 */
export function optimizePrompt(model: ModelInfo, tools: string[]): { text: string; mode: "override" | "append" } | undefined {
  const modelID = model.id.toLowerCase()
  if (modelID.includes("gpt")) {
    return { text: renderSystemPrompt(modelID.includes("astra") ? PROMPT_ASTRA : PROMPT_GPT, tools), mode: "override" }
  }
  if (modelID.includes("claude")) {
    return { text: renderSystemPrompt(PROMPT_ANTHROPIC, tools), mode: "append" }
  }
  if (modelID.includes("kimi")) {
    return { text: renderSystemPrompt(PROMPT_KIMI, tools), mode: "override" }
  }
  if (modelID.includes("trinity")) {
    return { text: renderSystemPrompt(PROMPT_TRINITY, tools), mode: "override" }
  }
  if (modelID.includes("muse")) {
    return { text: renderSystemPrompt(PROMPT_META.replaceAll("{{MODEL_NAME}}", model.name), tools), mode: "override" }
  }
  return undefined
}

export function composeSystemPrompt(input: {
  agent: AgentDef
  model: ModelInfo
  tools: string[]
  initial: string
}): string {
  const toolNames = input.tools
  let prompt = input.agent.system ?? baseSystemPrompt(toolNames)
  if (!input.agent.system) {
    const optimized = optimizePrompt(input.model, toolNames)
    if (optimized) {
      prompt = optimized.mode === "append" ? `${prompt}\n\n${optimized.text}` : optimized.text
    }
  }
  const parts = [prompt]
  if (input.initial) parts.push(input.initial)
  return parts.join("\n\n")
}
