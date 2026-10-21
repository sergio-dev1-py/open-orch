import { existsSync, readFileSync, rmSync, statSync } from "node:fs"
import path from "node:path"
import { z } from "zod"
import { computeDiff, readFileOrFail, resolvePath, writeFilePreserving } from "./helpers.js"
import { textOutput, ToolFailure, type ToolContext, type ToolDefinition } from "./types.js"

// ---------------------------------------------------------------------------
// Matching helpers (exact -> unicode-normalized -> trailing-whitespace tolerant)
// ---------------------------------------------------------------------------

function foldUnicode(text: string): string {
  return text
    .replaceAll("\u2018", "'")
    .replaceAll("\u2019", "'")
    .replaceAll("\u201C", '"')
    .replaceAll("\u201D", '"')
    .replaceAll("\u2013", "-")
    .replaceAll("\u2014", "-")
    .replaceAll("\u00A0", " ")
}

function findWithMap(haystack: string, needle: string, transform: (text: string) => string): { index: number; length: number } | undefined {
  const normalizedHaystack = transform(haystack)
  const normalizedNeedle = transform(needle)
  const index = normalizedHaystack.indexOf(normalizedNeedle)
  if (index === -1) return undefined
  // Map normalized indices back to original offsets.
  let originalStart = -1
  let originalEnd = -1
  let normalized = ""
  const map = new Map<number, number>()
  for (let i = 0; i < haystack.length; i++) {
    const folded = transform(haystack[i])
    for (let j = 0; j < folded.length; j++) {
      map.set(normalized.length, i)
      normalized += folded[j]
    }
  }
  map.set(normalized.length, haystack.length)
  originalStart = map.get(index) ?? -1
  const endKey = index + normalizedNeedle.length
  for (let key = endKey; key <= normalized.length; key++) {
    const value = map.get(key)
    if (value !== undefined) {
      originalEnd = value
      break
    }
  }
  if (originalStart === -1 || originalEnd === -1) return undefined
  if (normalized.slice(index, index + normalizedNeedle.length) !== normalizedNeedle) return undefined
  return { index: originalStart, length: originalEnd - originalStart }
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let index = haystack.indexOf(needle)
  while (index !== -1) {
    count++
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}

interface Match {
  index: number
  length: number
  count: number
}

function findMatch(content: string, oldString: string, replaceAll: boolean): Match | undefined {
  const exact = countOccurrences(content, oldString)
  if (exact > 0) {
    if (!replaceAll && exact > 1) throw new ToolFailure(`Found ${exact} matches for oldString, but expected exactly one. Add more surrounding context to make oldString unique, or set replaceAll to true to replace every occurrence.`)
    return { index: content.indexOf(oldString), length: oldString.length, count: exact }
  }
  const folded = findWithMap(content, oldString, foldUnicode)
  if (folded) {
    const count = countOccurrences(foldUnicode(content), foldUnicode(oldString))
    if (!replaceAll && count > 1) throw new ToolFailure(`Found ${count} matches for oldString, but expected exactly one. Add more surrounding context to make oldString unique, or set replaceAll to true to replace every occurrence.`)
    return { index: folded.index, length: folded.length, count }
  }
  const tolerant = findTrailingWhitespaceMatch(content, oldString)
  if (tolerant) return { index: tolerant.index, length: tolerant.length, count: 1 }
  return undefined
}

function findTrailingWhitespaceMatch(content: string, oldString: string): { index: number; length: number } | undefined {
  const contentLines = content.split("\n")
  const oldLines = oldString.split("\n").map((line) => line.replace(/\s+$/, ""))
  const offsets: number[] = []
  let offset = 0
  for (const line of contentLines) {
    offsets.push(offset)
    offset += line.length + 1
  }
  const equal = (a: string, b: string) => a.replace(/\s+$/, "") === b
  for (let start = 0; start + oldLines.length <= contentLines.length; start++) {
    let ok = true
    for (let i = 0; i < oldLines.length; i++) {
      if (!equal(contentLines[start + i], oldLines[i])) {
        ok = false
        break
      }
    }
    if (!ok) continue
    const startOffset = offsets[start]
    const endLine = start + oldLines.length - 1
    const endOffset = offsets[endLine] + contentLines[endLine].length
    return { index: startOffset, length: endOffset - startOffset }
  }
  return undefined
}

function detectEol(content: string): string {
  return content.includes("\r\n") ? "\r\n" : "\n"
}

function applyEol(text: string, eol: string): string {
  const lf = text.replaceAll("\r\n", "\n")
  return eol === "\r\n" ? lf.replaceAll("\n", "\r\n") : lf
}

// ---------------------------------------------------------------------------
// edit
// ---------------------------------------------------------------------------

export const editTool: ToolDefinition = {
  name: "edit",
  description:
    "Edit the contents of a file by finding and replacing exact text. When editing text from Read output, preserve the exact indentation (tabs or spaces) and omit the line-number prefix, such as `1: `. Never include the prefix in oldString or newString. Write line breaks as \\n; the file's existing CRLF or LF line endings are matched and preserved. To change line endings themselves, make oldString and newString differ only in \\r; that edit applies to the exact bytes. If there is no exact match, the edit retries while ignoring typographic quote, dash, and space variants, then trailing whitespace on each line. The edit fails if oldString is not found. By default, oldString must identify a UNIQUE location. Multiple matches FAIL unless replaceAll is true. Add more surrounding context to disambiguate, or set replaceAll to true to replace every occurrence. Use replaceAll when the change should apply to every occurrence, such as renaming a variable.",
  permission: "edit",
  inputSchema: z.object({
    path: z.string().describe("File to edit"),
    oldString: z.string().describe("Exact text to find and replace"),
    newString: z.string().describe("Text to replace oldString with (must differ from oldString)"),
    replaceAll: z
      .boolean()
      .optional()
      .describe("Whether to replace every occurrence of oldString. When false, oldString must match exactly once. Defaults to false."),
  }),
  async execute(input: { path: string; oldString: string; newString: string; replaceAll?: boolean }, ctx: ToolContext) {
    if (input.oldString === input.newString) {
      throw new ToolFailure("No changes to apply: oldString and newString are identical.")
    }
    if (input.oldString.length === 0) {
      throw new ToolFailure("oldString must not be empty. Use write to create or overwrite a file.")
    }
    const { absolute, relative } = await resolvePath(input.path, ctx)
    const before = readFileOrFail(absolute, input.path)
    const eol = detectEol(before)
    const view = before.replaceAll("\r\n", "\n")
    const match = findMatch(view, input.oldString.replaceAll("\r\n", "\n"), Boolean(input.replaceAll))
    if (!match) {
      throw new ToolFailure(
        `Could not find oldString in ${relative}. It must match exactly, including whitespace and indentation.`,
      )
    }
    const count = input.replaceAll ? match.count : 1
    const after =
      count === 1
        ? view.slice(0, match.index) + input.newString.replaceAll("\r\n", "\n") + view.slice(match.index + match.length)
        : view.split(input.oldString.replaceAll("\r\n", "\n")).join(input.newString.replaceAll("\r\n", "\n"))
    const finalContent = applyEol(after, eol)
    const diff = computeDiff(relative, before, finalContent)
    await ctx.permission({
      action: "edit",
      resources: [relative],
      save: ["*"],
      metadata: { files: [diff] },
    })
    writeFilePreserving(absolute, finalContent, before)
    return textOutput(`Edited ${relative} (${count} replacement${count === 1 ? "" : "s"})`, { files: [diff] })
  },
}

// ---------------------------------------------------------------------------
// write
// ---------------------------------------------------------------------------

export const writeTool: ToolDefinition = {
  name: "write",
  description:
    "Writes a file to the local filesystem, overwriting if one exists.\n\nMissing parent directories are created automatically.\n\nUse this tool to create new files or overwrite existing files. For partial changes, use the edit tool instead.",
  permission: "edit",
  inputSchema: z.object({
    path: z.string().describe("Path to the file to write to"),
    content: z.string().describe("Content to write to the file"),
  }),
  async execute(input: { path: string; content: string }, ctx: ToolContext) {
    const { absolute, relative } = await resolvePath(input.path, ctx)
    if (existsSync(absolute) && statSync(absolute).isDirectory()) {
      throw new ToolFailure(`Path is a directory: ${relative}`)
    }
    const before = existsSync(absolute) ? readFileSync(absolute).toString("utf8") : undefined
    const diff = computeDiff(relative, before, input.content)
    await ctx.permission({
      action: "edit",
      resources: [relative],
      save: ["*"],
      metadata: { files: [diff] },
    })
    writeFilePreserving(absolute, input.content, before)
    const message = before === undefined ? `Created file successfully: ${relative}` : `Wrote file successfully: ${relative}`
    return textOutput(message, { files: [diff] })
  },
}

// ---------------------------------------------------------------------------
// patch
// ---------------------------------------------------------------------------

type PatchOperation =
  | { type: "add"; path: string; lines: string[] }
  | { type: "delete"; path: string }
  | { type: "update"; path: string; moveTo?: string; hunks: { context: string | undefined; lines: string[] }[] }

export function parsePatch(text: string): PatchOperation[] {
  const lines = text.split(/\r?\n/)
  const operations: PatchOperation[] = []
  let i = 0
  const begin = lines.findIndex((line) => line.trim() === "*** Begin Patch")
  const end = lines.findIndex((line) => line.trim() === "*** End Patch")
  if (begin === -1 || end === -1 || end < begin) {
    throw new ToolFailure("Invalid patch: missing *** Begin Patch / *** End Patch markers.")
  }
  i = begin + 1
  while (i < end) {
    const line = lines[i]
    if (line.startsWith("*** Add File: ")) {
      const filePath = line.slice("*** Add File: ".length).trim()
      const content: string[] = []
      i++
      while (i < end && !lines[i].startsWith("*** ")) {
        if (lines[i].startsWith("+")) content.push(lines[i].slice(1))
        else if (lines[i].trim() === "") content.push("")
        i++
      }
      operations.push({ type: "add", path: filePath, lines: content })
      continue
    }
    if (line.startsWith("*** Delete File: ")) {
      operations.push({ type: "delete", path: line.slice("*** Delete File: ".length).trim() })
      i++
      continue
    }
    if (line.startsWith("*** Update File: ")) {
      const filePath = line.slice("*** Update File: ".length).trim()
      let moveTo: string | undefined
      i++
      if (i < end && lines[i].startsWith("*** Move to: ")) {
        moveTo = lines[i].slice("*** Move to: ".length).trim()
        i++
      }
      const hunks: { context: string | undefined; lines: string[] }[] = []
      let current: { context: string | undefined; lines: string[] } | undefined
      while (i < end && !lines[i].startsWith("*** ")) {
        const hunkLine = lines[i]
        if (hunkLine.startsWith("@@")) {
          if (current) hunks.push(current)
          current = { context: hunkLine.slice(2).trim() || undefined, lines: [] }
          i++
          continue
        }
        if (!current) {
          current = { context: undefined, lines: [] }
        }
        if (hunkLine.startsWith("+") || hunkLine.startsWith("-") || hunkLine.startsWith(" ")) {
          current.lines.push(hunkLine)
        } else if (hunkLine.trim() === "") {
          current.lines.push(" ")
        }
        i++
      }
      if (current) hunks.push(current)
      operations.push({ type: "update", path: filePath, moveTo, hunks })
      continue
    }
    i++
  }
  if (operations.length === 0) throw new ToolFailure("Invalid patch: no file operations found.")
  return operations
}

function applyHunks(content: string, hunks: { context: string | undefined; lines: string[] }[]): string {
  const lines = content.split("\n")
  const eol = detectEol(content)
  let cursor = 0
  for (const hunk of hunks) {
    const pre: string[] = []
    const post: string[] = []
    for (const raw of hunk.lines) {
      const marker = raw[0]
      const text = raw.slice(1)
      if (marker === " ") {
        pre.push(text)
        post.push(text)
      } else if (marker === "-") {
        pre.push(text)
      } else if (marker === "+") {
        post.push(text)
      }
    }
    if (pre.length === 0 && post.length === 0) continue
    const found = findLineWindow(lines, pre, cursor)
    if (!found) {
      throw new ToolFailure(`Patch hunk could not be applied${hunk.context ? ` (near "${hunk.context}")` : ""}: context lines did not match.`)
    }
    lines.splice(found.start, pre.length, ...post)
    cursor = found.start + post.length
  }
  return applyEol(lines.join("\n"), eol)
}

function findLineWindow(lines: string[], pre: string[], from: number): { start: number } | undefined {
  const equal = (a: string, b: string, fuzzy: boolean) => (fuzzy ? a.trim() === b.trim() : a === b)
  for (const fuzzy of [false, true]) {
    for (let start = from; start + pre.length <= lines.length; start++) {
      let ok = true
      for (let i = 0; i < pre.length; i++) {
        if (!equal(lines[start + i], pre[i], fuzzy)) {
          ok = false
          break
        }
      }
      if (ok) return { start }
    }
    for (let start = 0; start + pre.length <= lines.length; start++) {
      let ok = true
      for (let i = 0; i < pre.length; i++) {
        if (!equal(lines[start + i], pre[i], fuzzy)) {
          ok = false
          break
        }
      }
      if (ok) return { start }
    }
  }
  return undefined
}

export const patchTool: ToolDefinition = {
  name: "patch",
  description: `Use the \`patch\` tool to edit files. Your patch language is a stripped-down, file-oriented diff format designed to be easy to parse and safe to apply. You can think of it as a high-level envelope:

*** Begin Patch
[ one or more file sections ]
*** End Patch

Within that envelope, you get a sequence of file operations.
You MUST include a header to specify the action you are taking.
Each operation starts with one of three headers:

*** Add File: <path> - create a new file. Every following line is a + line (the initial contents).
*** Delete File: <path> - remove an existing file. Nothing follows.
*** Update File: <path> - patch an existing file in place (optionally with a rename).

Example patch:

\`\`\`
*** Begin Patch
*** Add File: hello.txt
+Hello world
*** Update File: src/app.py
*** Move to: src/main.py
@@ def greet():
-print("Hi")
+print("Hello, world!")
*** Delete File: obsolete.txt
*** End Patch
\`\`\`

It is important to remember:

- You must include a header with your intended action (Add/Delete/Update)
- You must prefix new lines with \`+\` even when creating a new file`,
  permission: "edit",
  inputSchema: z.object({
    patchText: z.string().describe("The full patch text describing add, update, and delete operations"),
  }),
  async execute(input: { patchText: string }, ctx: ToolContext) {
    const operations = parsePatch(input.patchText)
    const files: { path: string; diff: ReturnType<typeof computeDiff> }[] = []
    const applied: { type: "add" | "update" | "delete"; path: string }[] = []
    const plan: { type: "add" | "update" | "delete"; absolute: string; relative: string; content?: string; moveTo?: string }[] = []

    for (const operation of operations) {
      const { absolute, relative } = await resolvePath(operation.path, ctx)
      if (operation.type === "add") {
        const content = operation.lines.join("\n")
        const before = existsSync(absolute) ? readFileSync(absolute).toString("utf8") : undefined
        plan.push({ type: "add", absolute, relative, content })
        files.push({ path: relative, diff: computeDiff(relative, before, content) })
        applied.push({ type: "add", path: relative })
        continue
      }
      if (operation.type === "delete") {
        const before = readFileOrFail(absolute, operation.path)
        plan.push({ type: "delete", absolute, relative })
        files.push({ path: relative, diff: computeDiff(relative, before, undefined) })
        applied.push({ type: "delete", path: relative })
        continue
      }
      const before = readFileOrFail(absolute, operation.path)
      const after = applyHunks(before, operation.hunks)
      plan.push({ type: "update", absolute, relative, content: after, moveTo: operation.moveTo })
      files.push({ path: relative, diff: computeDiff(relative, before, after) })
      applied.push({ type: "update", path: relative })
    }

    await ctx.permission({
      action: "edit",
      resources: files.map((file) => file.path),
      save: ["*"],
      metadata: { files: files.map((file) => file.diff) },
    })

    for (const step of plan) {
      if (step.type === "delete") {
        rmSync(step.absolute)
        continue
      }
      if (step.type === "add" || step.type === "update") {
        writeFilePreserving(step.absolute, step.content ?? "")
        if (step.moveTo) {
          const { absolute: moveAbsolute } = await resolvePath(step.moveTo, ctx)
          writeFilePreserving(moveAbsolute, step.content ?? "")
          rmSync(step.absolute)
        }
      }
    }

    const summary = applied
      .map((entry) => `${entry.type === "add" ? "A" : entry.type === "update" ? "M" : "D"} ${entry.path}`)
      .join("\n")
    return textOutput(`Success. Updated the following files:\n${summary}`, { files: files.map((file) => file.diff) })
  },
}
