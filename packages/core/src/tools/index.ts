import type { ModelInfo, PermissionRule } from "@openorch/shared"
import { wildcardMatch } from "../util.js"
import { editTool, patchTool, writeTool } from "./edit.js"
import { globTool, grepTool } from "./search.js"
import { shellTool } from "./shell.js"
import { readTool } from "./read.js"
import { websearchTool, webfetchTool } from "./web.js"
import { questionTool, skillTool, subagentDescription, subagentTool } from "./agent.js"
import { mcpListResourcesTool, mcpReadResourceTool, mcpTool } from "./mcp.js"
import { browserTools } from "./browser.js"
import { opencodeTools } from "./opencode.js"
import { effectiveName, type ToolDefinition } from "./types.js"

export type { ToolDefinition } from "./types.js"

function whollyDisabled(action: string, rules: PermissionRule[]): boolean {
  let last: PermissionRule | undefined
  for (const rule of rules) {
    if (wildcardMatch(action, rule.action)) last = rule
  }
  return last?.resource === "*" && last.effect === "deny"
}

export interface BuildToolsInput {
  model: ModelInfo
  permissions: PermissionRule[]
  mcpTools: ToolDefinition[]
  websearchEnabled: boolean
  skillsAvailable: boolean
  subagents: { id: string; description: string }[]
  /** When true, `codemode` tools are only available from inside `execute`. */
  codeMode: boolean
  /** The desktop browser is attached (browser tools are only useful in the app). */
  browser: boolean
}

export interface BuiltTools {
  /** Tools exposed directly to the model. */
  direct: ToolDefinition[]
  /** Tools exposed through the Code Mode catalog. */
  codemode: ToolDefinition[]
}

export function buildTools(input: BuildToolsInput): BuiltTools {
  const tools: ToolDefinition[] = [shellTool, readTool, globTool, grepTool, webfetchTool]

  // GPT models get `patch`; every other model gets `edit` + `write` (upstream behavior).
  const usePatch = input.model.id.includes("gpt-") && !input.model.id.includes("oss") && !input.model.id.includes("gpt-4")
  if (usePatch) {
    tools.push(patchTool)
  } else {
    tools.push(editTool, writeTool)
  }

  tools.push(subagentTool)
  if (input.skillsAvailable) tools.push(skillTool)
  tools.push(questionTool)
  tools.push(...opencodeTools)
  tools.push(mcpTool, mcpListResourcesTool, mcpReadResourceTool)
  if (input.browser) tools.push(...browserTools)

  if (input.websearchEnabled) tools.push(websearchTool)
  tools.push(...input.mcpTools)

  const allowed = tools.filter((tool) => !whollyDisabled(tool.permission ?? effectiveName(tool), input.permissions))
  const codemode = input.codeMode ? allowed.filter((tool) => tool.codemode === true) : []
  const direct = allowed
    .filter((tool) => !(input.codeMode && tool.codemode === true))
    .map((tool) => {
      if (tool.name === "subagent") {
        return { ...tool, description: subagentDescription(tool.description, input.subagents) }
      }
      return tool
    })
  return { direct, codemode }
}
