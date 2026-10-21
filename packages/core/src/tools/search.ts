import { existsSync, statSync } from "node:fs"
import path from "node:path"
import { z } from "zod"
import { globFiles, grepFiles } from "../ripgrep.js"
import { modelPath, resolvePath } from "./helpers.js"
import { textOutput, ToolFailure, type ToolContext, type ToolDefinition } from "./types.js"

export const globTool: ToolDefinition = {
  name: "glob",
  description: 'Search file paths using a glob pattern (examples: "**/*.ts", "src/**/*.tsx").',
  inputSchema: z.object({
    pattern: z.string().describe("Glob pattern to match files against"),
    path: z.string().optional().describe("Directory to search. Defaults to the current working directory."),
    hidden: z.boolean().default(false).describe("Include hidden files and directories (default: false)."),
    limit: z.number().int().optional().describe("Maximum number of matching files to return (default: 100)"),
  }),
  async execute(input: { pattern: string; path?: string; hidden?: boolean; limit?: number }, ctx: ToolContext) {
    const root = input.path ? await resolvePath(input.path, ctx) : { absolute: ctx.directory, relative: "." }
    if (!existsSync(root.absolute) || !statSync(root.absolute).isDirectory()) {
      throw new ToolFailure(`Not a directory: ${input.path ?? ctx.directory}`)
    }
    await ctx.permission({
      action: "glob",
      resources: [input.pattern],
      save: ["*"],
      metadata: { root: root.absolute, path: input.path, hidden: input.hidden, limit: input.limit },
    })
    const limit = input.limit && input.limit > 0 ? input.limit : 100
    const result = await globFiles({
      pattern: input.pattern,
      path: root.absolute,
      hidden: Boolean(input.hidden),
      limit,
    })
    if (result.truncatedByTimeout) {
      throw new ToolFailure("Search timed out after 20 seconds. Consider using a more specific path or pattern.")
    }
    const relative = result.files.map((file) => modelPath(file, ctx.directory))
    if (relative.length === 0) return textOutput("No files found")
    const body = relative.join("\n")
    const footer = result.truncated
      ? `\n(Results are truncated: showing first ${relative.length} results. Consider using a more specific path or pattern.)`
      : ""
    return textOutput(`${body}${footer}`, { files: relative })
  },
}

export const grepTool: ToolDefinition = {
  name: "grep",
  description:
    "Search file contents using ripgrep's regular expression syntax or literal text matching. Use it to locate specific code, symbols, or text patterns, and narrow searches with `path` or `include`. Returns matching file paths, line numbers, and line previews.",
  inputSchema: z.object({
    pattern: z.string().min(1).describe("Regular expression or literal text to match in file contents."),
    path: z.string().optional().describe("File or directory to search. Defaults to the current working directory."),
    include: z.string().optional().describe('Glob pattern to filter files (for example, "*.js" or "*.{ts,tsx}")'),
    literal: z.boolean().default(false).describe("Treat `pattern` as exact text instead of a regular expression (default: false)."),
    caseSensitive: z.boolean().default(true).describe("Use case-sensitive matching (default: true)."),
    limit: z.number().int().optional().describe("Maximum number of matching lines to return (default: 100)"),
  }),
  async execute(
    input: { pattern: string; path?: string; include?: string; literal?: boolean; caseSensitive?: boolean; limit?: number },
    ctx: ToolContext,
  ) {
    const target = input.path ? await resolvePath(input.path, ctx) : { absolute: ctx.directory, relative: "." }
    await ctx.permission({
      action: "grep",
      resources: [input.pattern],
      save: ["*"],
      metadata: { path: input.path, include: input.include, literal: input.literal },
    })
    const limit = input.limit && input.limit > 0 ? input.limit : 100
    const base = existsSync(target.absolute) && statSync(target.absolute).isFile() ? path.dirname(target.absolute) : target.absolute
    const result = await grepFiles({
      pattern: input.pattern,
      path: target.absolute,
      include: input.include,
      literal: Boolean(input.literal),
      caseSensitive: input.caseSensitive !== false,
      limit,
    })
    if (result.invalidRegex) throw new ToolFailure(`Invalid regex pattern: ${result.invalidRegex}`)
    if (result.truncatedByTimeout) {
      throw new ToolFailure("Search timed out after 20 seconds. Consider using a more specific path or pattern.")
    }
    if (result.matches.length === 0) return textOutput("No matches found")
    const grouped = new Map<string, { line: number; text: string }[]>()
    for (const match of result.matches) {
      const key = modelPath(match.file, ctx.directory)
      const list = grouped.get(key) ?? []
      list.push({ line: match.line, text: match.text })
      grouped.set(key, list)
    }
    const sections: string[] = []
    for (const [file, matches] of grouped) {
      const lines = matches.map((match) => `  Line ${match.line}: ${match.text}`).join("\n")
      sections.push(`${file}:\n${lines}`)
    }
    const footer = result.truncated
      ? `\n(Results are truncated: showing first ${result.matches.length} results. Consider using a more specific path or pattern.)`
      : ""
    return textOutput(`Found ${result.matches.length} matches\n\n${sections.join("\n\n")}${footer}`, {
      matches: result.matches.length,
      files: [...grouped.keys()],
      base,
    })
  },
}
