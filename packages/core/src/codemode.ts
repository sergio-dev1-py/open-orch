import { z } from "zod"
import type { ToolContent } from "@openorch/shared"
import { effectiveName, textOutput, ToolFailure, type ToolContext, type ToolDefinition, type ToolOutput } from "./tools/types.js"

/**
 * Code Mode: a confined JavaScript runtime where the model scripts tool calls
 * (`tools.<namespace>["name"](input)`), composes results and returns a value.
 *
 * Upstream OpenCode ships a purpose-built JS interpreter; this implementation uses
 * `node:vm` with a restricted sandbox, no filesystem/process access and code
 * generation disabled. Real protection comes from the tool permission system,
 * which is enforced for every nested call.
 */

export interface CatalogEntry {
  namespace?: string
  name: string
  path: string
  signature: string
  description: string
}

function schemaType(schema: Record<string, unknown> | undefined): string {
  if (!schema) return "unknown"
  const type = schema.type
  if (Array.isArray(type)) return type.map((entry) => schemaType({ ...schema, type: entry })).join(" | ")
  if (Array.isArray(schema.enum)) return schema.enum.map((value) => JSON.stringify(value)).join(" | ")
  if (type === "array") {
    const items = schema.items as Record<string, unknown> | undefined
    return `${schemaType(items)}[]`
  }
  if (type === "integer" || type === "number") return "number"
  if (type === "boolean") return "boolean"
  if (type === "null") return "null"
  if (type === "object") return "object"
  return typeof type === "string" ? type : "unknown"
}

function objectSignature(schema: Record<string, unknown> | undefined): string {
  if (!schema || schema.type !== "object") return schemaType(schema)
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>
  const required = new Set((schema.required as string[] | undefined) ?? [])
  const parts = Object.entries(properties).map(
    ([key, value]) => `${key}${required.has(key) ? "" : "?"}: ${schemaType(value)}`,
  )
  return `{ ${parts.join("; ")} }`
}

export function jsonSchemaFor(tool: ToolDefinition): Record<string, unknown> | undefined {
  if (tool.jsonSchema) return tool.jsonSchema as Record<string, unknown>
  if (!tool.inputSchema) return undefined
  try {
    return z.toJSONSchema(tool.inputSchema as z.ZodType, { io: "input" }) as Record<string, unknown>
  } catch {
    return undefined
  }
}

export function buildCatalog(tools: ToolDefinition[]): CatalogEntry[] {
  return tools.map((tool) => {
    const schema = jsonSchemaFor(tool)
    return {
      namespace: tool.namespace,
      name: tool.name,
      path: tool.namespace ? `tools.${tool.namespace}["${tool.name}"]` : `tools["${tool.name}"]`,
      signature: `(input: ${objectSignature(schema)})`,
      description: tool.description.split("\n")[0],
    }
  })
}

export function renderCodeModeInstructions(entries: CatalogEntry[]): string {
  if (entries.length === 0) return ""
  const lines = [
    "# Code Mode",
    "Run JavaScript in a confined Code Mode runtime to script tool calls and HTTP requests and compose their results.",
    "`fetch` is available for HTTP requests. Imports, direct filesystem access, and timers are unavailable; all other external access goes through `tools`.",
    "Call tools through `tools` using only exact paths and signatures from the catalog. Do not infer or normalize tool names; preserve bracket notation such as `tools.opencode[\"session_rename\"](input)`.",
    "Use `search({ query })` to find tools by name or description.",
    "Prefer an explicit `return`; if omitted, the final top-level expression becomes the result.",
    "Await every call whose completion matters. Run independent calls concurrently with `Promise.allSettled`.",
    "",
    "Available tools:",
    ...entries.map((entry) => `- \`${entry.path}${entry.signature}\`${entry.description ? ` — ${entry.description}` : ""}`),
  ]
  return lines.join("\n")
}

interface NestedCall {
  path: string
  input: unknown
  status: "completed" | "error"
  output?: string
  error?: string
}

export interface CodeModeResult {
  output: string
  calls: NestedCall[]
  console: string[]
  files: ToolContent[]
  error?: string
}

const MAX_OUTPUT_CHARS = 100_000
const MAX_FETCH_BYTES = 5 * 1024 * 1024

function formatValue(value: unknown): string {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value, null, 1) ?? String(value)
  } catch {
    return String(value)
  }
}

function truncate(text: string, max = MAX_OUTPUT_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}\n…(output truncated)` : text
}

/**
 * Runs `code` inside a `node:vm` sandbox. `callTool` performs the real execution
 * (with permissions) in the engine; `signal` aborts long runs.
 */
export async function runCodeMode(input: {
  code: string
  catalog: CatalogEntry[]
  callTool: (entry: CatalogEntry, args: unknown, ctx: ToolContext) => Promise<ToolOutput>
  context: ToolContext
  signal?: AbortSignal
  timeoutMs?: number
}): Promise<CodeModeResult> {
  const vm = await import("node:vm")
  const calls: NestedCall[] = []
  const consoleLines: string[] = []
  const files: ToolContent[] = []
  const timeoutMs = input.timeoutMs ?? 60_000

  const entryByPath = new Map(input.catalog.map((entry) => [entry.path, entry]))
  const entryByEffective = new Map(input.catalog.map((entry) => [`${entry.namespace ? `${entry.namespace}_` : ""}${entry.name}`, entry]))

  const invoke = async (path: string, args: unknown): Promise<unknown> => {
    const entry = entryByPath.get(path) ?? entryByEffective.get(path)
    if (!entry) {
      const error = `No tool named "${path}" is available in Code Mode. Use search() or read the catalog.`
      calls.push({ path, input: args, status: "error", error })
      throw new Error(error)
    }
    if (input.signal?.aborted) throw new Error("aborted")
    try {
      const result = await input.callTool(entry, args, input.context)
      const text = (result.content ?? [])
        .filter((item): item is Extract<ToolContent, { type: "text" }> => item.type === "text")
        .map((item) => item.text)
        .join("\n")
      for (const item of result.content ?? []) {
        if (item.type === "file") files.push(item)
      }
      calls.push({ path, input: args, status: "completed", output: truncate(text, 20_000) })
      return result.metadata ? { output: text, metadata: result.metadata } : text
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      calls.push({ path, input: args, status: "error", error: message })
      throw new Error(message)
    }
  }

  // Build the nested `tools` tree: tools.<namespace>["name"] and tools["name"].
  const toolsTree: Record<string, unknown> = {}
  for (const entry of input.catalog) {
    const fn = (args: unknown) => invoke(entry.path, args)
    if (entry.namespace) {
      const bucket = (toolsTree[entry.namespace] as Record<string, unknown>) ?? {}
      bucket[entry.name] = fn
      toolsTree[entry.namespace] = bucket
    } else {
      toolsTree[entry.name] = fn
    }
  }

  const search = (query: unknown) => {
    const text = typeof query === "string" ? query.toLowerCase() : JSON.stringify(query ?? "").toLowerCase()
    const scored = input.catalog
      .map((entry) => {
        const haystack = `${entry.namespace ?? ""} ${entry.name} ${entry.description}`.toLowerCase()
        let score = haystack.includes(text) ? 2 : 0
        if (entry.path.toLowerCase().includes(text)) score += 3
        return { entry, score }
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 10)
    return scored.map((item) => ({
      path: item.entry.path,
      signature: item.entry.signature,
      description: item.entry.description,
    }))
  }

  const guardedFetch = async (url: unknown, init?: unknown): Promise<unknown> => {
    const target = String(url)
    let parsed: URL
    try {
      parsed = new URL(target)
    } catch {
      throw new Error(`Invalid URL: ${target}`)
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("Code Mode fetch only supports http:// and https:// URLs.")
    }
    const response = await fetch(parsed, (init ?? undefined) as RequestInit)
    const buffer = await response.arrayBuffer()
    if (buffer.byteLength > MAX_FETCH_BYTES) throw new Error(`Response too large (limit ${MAX_FETCH_BYTES} bytes)`)
    const text = new TextDecoder().decode(buffer)
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      text: () => text,
      json: () => JSON.parse(text) as unknown,
    }
  }

  const formatConsoleArgs = (args: unknown[]): string =>
    args
      .map((value) => (typeof value === "string" ? value : formatValue(value)))
      .join(" ")

  const sandboxGlobals = {
    tools: toolsTree,
    search,
    fetch: guardedFetch,
    console: {
      log: (...args: unknown[]) => consoleLines.push(formatConsoleArgs(args)),
      info: (...args: unknown[]) => consoleLines.push(formatConsoleArgs(args)),
      warn: (...args: unknown[]) => consoleLines.push(`warn: ${formatConsoleArgs(args)}`),
      error: (...args: unknown[]) => consoleLines.push(`error: ${formatConsoleArgs(args)}`),
    },
    JSON,
    Math,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Date,
    RegExp,
    Map,
    Set,
    WeakMap,
    WeakSet,
    Promise,
    Error,
    TypeError,
    RangeError,
    SyntaxError,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    Intl,
    structuredClone,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    encodeURIComponent,
    decodeURIComponent,
    btoa,
    atob,
  }

  const context = vm.createContext(sandboxGlobals, {
    codeGeneration: { strings: false, wasm: false },
    name: "openorch-codemode",
  })

  const result: CodeModeResult = { output: "", calls, console: consoleLines, files }
  try {
    const wrapped = `(async () => {\n${input.code}\n})()`
    const evaluation: unknown = vm.runInContext(wrapped, context, { timeout: Math.min(timeoutMs, 15_000), filename: "codemode.js" })
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Code Mode execution timed out after ${timeoutMs}ms.`)), timeoutMs)
    })
    try {
      const value = await Promise.race([Promise.resolve(evaluation), timeout])
      result.output = value === undefined ? "" : truncate(formatValue(value))
    } finally {
      if (timer) clearTimeout(timer)
    }
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error)
  }
  result.calls = calls
  result.console = consoleLines
  result.files = files
  return result
}

/** Renders the tool card content for the model (`execute` output). */
export function renderCodeModeOutput(result: CodeModeResult): string {
  const parts: string[] = []
  if (result.console.length > 0) parts.push(`console:\n${result.console.join("\n")}`)
  if (result.calls.length > 0) {
    parts.push(
      `tool calls:\n${result.calls
        .map((call) => `- ${call.path} → ${call.status === "completed" ? "ok" : `error: ${call.error}`}`)
        .join("\n")}`,
    )
  }
  if (result.output) parts.push(`result:\n${result.output}`)
  if (result.error) parts.push(`error: ${result.error}`)
  return parts.join("\n\n") || "(no output)"
}

export function createExecuteTool(input: {
  catalog: CatalogEntry[]
  callTool: (entry: CatalogEntry, args: unknown, ctx: ToolContext) => Promise<ToolOutput>
}): ToolDefinition {
  const schema = z.object({
    code: z.string().describe("JavaScript source to run in the Code Mode runtime."),
  })
  return {
    name: "execute",
    description: [
      "Run JavaScript in a confined Code Mode runtime to script tool calls and HTTP requests and compose their results.",
      "`fetch` is available for HTTP requests. Imports, direct filesystem access, and timers are unavailable; all other external access goes through `tools`.",
      'Within `{ code }`, call tools through `tools` using only exact paths and signatures from the Code Mode catalog instructions. Preserve bracket notation such as `tools.opencode["session_rename"](input)`.',
      "Use `search({ query })` to find tools by name or description.",
      "Prefer an explicit `return`; if omitted, the final top-level expression becomes the result.",
      "Await every call whose completion matters.",
    ].join("\n"),
    inputSchema: schema,
    async execute(raw: unknown, ctx: ToolContext) {
      const parsed = schema.safeParse(raw)
      if (!parsed.success) throw new ToolFailure("The execute tool requires a `code` string.")
      const result = await runCodeMode({
        code: parsed.data.code,
        catalog: input.catalog,
        callTool: input.callTool,
        context: ctx,
        signal: ctx.abort,
      })
      const content: ToolContent[] = [{ type: "text", text: renderCodeModeOutput(result) }, ...result.files]
      return {
        content: content.length > 0 ? content : [{ type: "text", text: "(no output)" }],
        metadata: {
          console: result.console,
          calls: result.calls.map((call) => ({ path: call.path, status: call.status, error: call.error })),
          error: result.error,
        },
      }
    },
  }
}
