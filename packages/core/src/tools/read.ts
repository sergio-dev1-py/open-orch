import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { z } from "zod"
import { textOutput, ToolFailure, type ToolContext, type ToolDefinition } from "./types.js"
import {
  MAX_LINE_LENGTH,
  MAX_MEDIA_INGEST_BYTES,
  MAX_READ_BYTES,
  MAX_READ_LINES,
  MEDIA_MIMES,
  modelPath,
  resolvePath,
} from "./helpers.js"

function fileParts(file: string): { text: string; truncated: boolean; nextOffset?: number; lines: number } {
  const raw = readFileSync(file).toString("utf8")
  const allLines = raw.split(/\r?\n/)
  const totalLines = allLines.length
  let truncated = false
  let nextOffset: number | undefined
  let selected = allLines
  if (totalLines > MAX_READ_LINES) {
    selected = allLines.slice(0, MAX_READ_LINES)
    truncated = true
    nextOffset = MAX_READ_LINES + 1
  }
  let budget = MAX_READ_BYTES
  const out: string[] = []
  for (let i = 0; i < selected.length; i++) {
    let line = selected[i]
    if (line.length > MAX_LINE_LENGTH) line = `${line.slice(0, MAX_LINE_LENGTH)}... (line truncated to 2000 chars)`
    budget -= line.length + 8
    if (budget < 0) {
      truncated = true
      nextOffset = i + 1
      break
    }
    out.push(`${i + 1}: ${line}`)
  }
  return { text: out.join("\n"), truncated, nextOffset, lines: totalLines }
}

export const readTool: ToolDefinition = {
  name: "read",
  description:
    "Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as `<line>: <content>`. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.",
  inputSchema: z.object({
    path: z.string().describe("File or directory to read"),
    offset: z.number().int().optional().describe("The line or directory entry to start reading from (1-based)"),
    limit: z
      .number()
      .int()
      .optional()
      .describe("The maximum number of lines or directory entries to read (defaults to and capped at 2000)"),
  }),
  async execute(input: { path: string; offset?: number; limit?: number }, ctx: ToolContext) {
    const { absolute, relative } = await resolvePath(input.path, ctx)
    const offset = Math.max(1, input.offset ?? 1)
    const limit = Math.min(input.limit && input.limit > 0 ? input.limit : MAX_READ_LINES, MAX_READ_LINES)

    if (!existsSync(absolute)) {
      const suggestions = suggestNames(path.dirname(absolute), path.basename(absolute))
      const extra = suggestions.length > 0 ? `\nDid you mean one of these?\n${suggestions.join("\n")}` : ""
      throw new ToolFailure(`File not found: ${input.path}${extra}`)
    }

    await ctx.permission({ action: "read", resources: [relative], save: ["*"], metadata: { path: relative } })

    const stat = statSync(absolute)
    if (stat.isDirectory()) {
      const entries = readdirSync(absolute, { withFileTypes: true })
        .map((entry) => {
          const full = path.join(absolute, entry.name)
          return entry.isDirectory() ? `${modelPath(full, ctx.directory)}/` : modelPath(full, ctx.directory)
        })
        .sort()
      const page = entries.slice(offset - 1, offset - 1 + limit)
      const truncated = offset - 1 + limit < entries.length
      const header = `Read directory ${relative}, entries ${offset}-${offset + page.length - 1}`
      const footer = truncated ? `\n[Output truncated. Continue reading with offset: ${offset + limit}]` : ""
      if (page.length === 0) return textOutput(`Read directory ${relative}, no entries`, { directory: relative })
      return textOutput(`${header}\n${page.join("\n")}${footer}`, { directory: relative, entries: page.length })
    }

    const ext = path.extname(absolute).toLowerCase()
    const mime = MEDIA_MIMES[ext]
    if (mime && stat.size <= MAX_MEDIA_INGEST_BYTES) {
      const data = readFileSync(absolute).toString("base64")
      const label = mime === "application/pdf" ? "PDF" : "Image"
      return {
        content: [
          { type: "text", text: `${label} read successfully: ${relative}` },
          { type: "file", url: `data:${mime};base64,${data}`, mime, name: relative },
        ],
        metadata: { path: relative, media: true },
      }
    }

    const buffer = readFileSync(absolute)
    if (buffer.subarray(0, Math.min(buffer.length, 4096)).includes(0)) {
      throw new ToolFailure(`Cannot read binary file: ${relative}`)
    }
    const parts = fileParts(absolute)
    void ctx.services.instructions(ctx.sessionID, absolute).catch(() => undefined)
    const header = `Read file ${relative}, lines ${offset}-${Math.max(offset, parts.text.split("\n").length + offset - 1)}`
    const sliced = sliceLines(parts.text, offset, limit)
    const truncated = parts.truncated || sliced.truncated
    const footer = truncated ? `\n[Output truncated. Continue reading with offset: ${sliced.nextOffset}]` : ""
    return textOutput(`${header}\n${sliced.text}${footer}`, {
      path: relative,
      lines: parts.lines,
      offset,
      truncated,
    })
  },
}

function sliceLines(text: string, offset: number, limit: number): { text: string; truncated: boolean; nextOffset: number } {
  const lines = text.split("\n")
  const start = offset - 1
  const page = lines.slice(start, start + limit)
  return {
    text: page.join("\n"),
    truncated: start + limit < lines.length,
    nextOffset: start + limit + 1,
  }
}

function suggestNames(dir: string, name: string): string[] {
  try {
    const entries = readdirSync(dir)
    const lower = name.toLowerCase()
    return entries.filter((entry) => entry.toLowerCase().includes(lower.slice(0, Math.max(2, lower.length - 2)))).slice(0, 3)
  } catch {
    return []
  }
}
