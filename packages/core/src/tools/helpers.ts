import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createTwoFilesPatch } from "diff"
import type { FileDiffInfo } from "@openorch/shared"
import { isInside, truncate } from "../util.js"
import { ToolFailure, type ToolContext } from "./types.js"

export const MAX_READ_LINES = 2_000
export const MAX_READ_BYTES = 50 * 1024
export const MAX_LINE_LENGTH = 2_000
export const MAX_MEDIA_INGEST_BYTES = 20 * 1024 * 1024
export const MEDIA_MIMES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
}

export interface ResolvedPath {
  absolute: string
  relative: string
}

/** Resolves a user supplied path against the session directory and enforces external access rules. */
export async function resolvePath(input: string, ctx: ToolContext): Promise<ResolvedPath> {
  const expanded = input.startsWith("~") ? path.join(process.env.USERPROFILE ?? process.env.HOME ?? "", input.slice(2)) : input
  const absolute = path.resolve(ctx.directory, expanded)
  const inside = isInside(ctx.directory, absolute)
  if (!inside) {
    const dir = existsSync(absolute) && statSync(absolute).isDirectory() ? absolute : path.dirname(absolute)
    await ctx.permission({
      action: "external_directory",
      resources: [path.join(dir, "*")],
      // "Always allow" must remember the external directory, not the session's.
      save: [path.join(dir, "*")],
      metadata: { path: absolute },
    })
  }
  const relative = path.relative(ctx.directory, absolute).split(path.sep).join("/") || "."
  return { absolute, relative }
}

export function readFileOrFail(file: string, input: string): string {
  if (!existsSync(file)) {
    throw new ToolFailure(`File not found: ${input}`)
  }
  const stat = statSync(file)
  if (stat.isDirectory()) {
    throw new ToolFailure(`Path is a directory: ${input}. Use read on the directory to list its entries.`)
  }
  const buffer = readFileSync(file)
  if (buffer.subarray(0, Math.min(buffer.length, 4096)).includes(0)) {
    throw new ToolFailure(`Cannot read binary file: ${input}`)
  }
  return buffer.toString("utf8")
}

export function writeFilePreserving(file: string, content: string, existing?: string): void {
  const bom = existing?.startsWith("\uFEFF") ? "\uFEFF" : content.startsWith("\uFEFF") ? "\uFEFF" : ""
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.openorch-tmp`
  writeFileSync(tmp, bom ? bom + content.replace(/^\uFEFF/, "") : content)
  renameSync(tmp, file)
}

export function computeDiff(filePath: string, before: string | undefined, after: string | undefined): FileDiffInfo {
  const status: FileDiffInfo["status"] = before === undefined ? "added" : after === undefined ? "deleted" : "modified"
  const patch = createTwoFilesPatch(
    `a/${filePath}`,
    `b/${filePath}`,
    before ?? "",
    after ?? "",
    undefined,
    undefined,
    { context: 3 },
  )
  let additions = 0
  let deletions = 0
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++
    if (line.startsWith("-") && !line.startsWith("---")) deletions++
  }
  return { path: filePath, status, patch, additions, deletions }
}

export function modelPath(absolute: string, directory: string): string {
  const relative = path.relative(directory, absolute).split(path.sep).join("/")
  return relative && !relative.startsWith("..") ? relative : absolute
}

export { truncate }
export type { ToolContext }
