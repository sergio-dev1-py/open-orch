import { execFile } from "node:child_process"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { promisify } from "node:util"
import { isInside } from "./util.js"

const execFileAsync = promisify(execFile)

const DEFAULT_SEARCH_LIMIT = 100
const DEFAULT_SEARCH_TIMEOUT_MS = 20_000

let ripgrepPath: string | undefined | null = null

/** Resolves the bundled ripgrep binary (or one on PATH). Returns undefined when unavailable. */
export async function findRipgrep(): Promise<string | undefined> {
  if (ripgrepPath !== null) return ripgrepPath
  const candidates: string[] = []
  if (process.env.OPENORCH_RG_PATH) candidates.push(process.env.OPENORCH_RG_PATH)
  try {
    const mod = (await import("@vscode/ripgrep")) as { rgPath?: string }
    if (mod.rgPath) candidates.push(mod.rgPath)
  } catch {
    // not installed
  }
  candidates.push("rg")
  for (const candidate of candidates) {
    try {
      if (candidate !== "rg" && !existsSync(candidate)) continue
      await execFileAsync(candidate, ["--version"], { timeout: 5_000 })
      ripgrepPath = candidate
      return candidate
    } catch {
      continue
    }
  }
  ripgrepPath = undefined
  return undefined
}

export interface GlobOptions {
  pattern: string
  path: string
  hidden: boolean
  limit: number
}

export interface GlobResult {
  files: string[]
  truncated: boolean
  truncatedByTimeout?: boolean
}

export async function globFiles(options: GlobOptions): Promise<GlobResult> {
  const limit = options.limit > 0 ? options.limit : DEFAULT_SEARCH_LIMIT
  const rg = await findRipgrep()
  if (rg) {
    try {
      const args = ["--files", "--glob", options.pattern, "--no-ignore", ...(options.hidden ? ["--hidden"] : [])]
      const { stdout } = await execFileAsync(rg, [...args, "--", options.path], {
        timeout: DEFAULT_SEARCH_TIMEOUT_MS,
        maxBuffer: 64 * 1024 * 1024,
      })
      const all = stdout
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => path.resolve(options.path, line))
      const files = all.slice(0, limit)
      return { files, truncated: all.length > limit }
    } catch (error) {
      if (error instanceof Error && (error as { killed?: boolean }).killed) {
        return { files: [], truncated: false, truncatedByTimeout: true }
      }
      // fall through to JS implementation
    }
  }
  return globFilesJS(options, limit)
}

function globFilesJS(options: GlobOptions, limit: number): GlobResult {
  const regex = globToRegex(options.pattern)
  const files: string[] = []
  let truncated = false
  const walk = (current: string) => {
    if (truncated) return
    let entries: string[]
    try {
      entries = readdirSync(current)
    } catch {
      return
    }
    for (const entry of entries) {
      if (!options.hidden && entry.startsWith(".")) continue
      if (entry === "node_modules") continue
      const full = path.join(current, entry)
      let stat
      try {
        stat = statSync(full)
      } catch {
        continue
      }
      if (stat.isDirectory()) {
        walk(full)
        continue
      }
      const relative = path.relative(options.path, full).split(path.sep).join("/")
      if (regex.test(relative) || regex.test(entry)) {
        files.push(full)
        if (files.length >= limit) {
          truncated = true
          return
        }
      }
    }
  }
  walk(options.path)
  return { files, truncated }
}

export function globToRegex(pattern: string): RegExp {
  let out = ""
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        // `**/` matches any directories (including none)
        if (pattern[i + 2] === "/") {
          out += "(?:.*/)?"
          i += 2
        } else {
          out += ".*"
          i += 1
        }
      } else {
        out += "[^/]*"
      }
      continue
    }
    if (char === "?") {
      out += "[^/]"
      continue
    }
    if (char === "{") {
      const end = pattern.indexOf("}", i)
      if (end !== -1) {
        const options = pattern
          .slice(i + 1, end)
          .split(",")
          .map((option) => option.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&"))
          .join("|")
        out += `(?:${options})`
        i = end
        continue
      }
    }
    out += char.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")
  }
  return new RegExp(`^${out}$`)
}

export interface GrepOptions {
  pattern: string
  path: string
  include?: string
  literal: boolean
  caseSensitive: boolean
  limit: number
}

export interface GrepMatch {
  file: string
  line: number
  text: string
}

export interface GrepResult {
  matches: GrepMatch[]
  truncated: boolean
  invalidRegex?: string
  truncatedByTimeout?: boolean
}

export async function grepFiles(options: GrepOptions): Promise<GrepResult> {
  const limit = options.limit > 0 ? options.limit : DEFAULT_SEARCH_LIMIT
  if (!options.literal) {
    try {
      new RegExp(options.pattern, options.caseSensitive ? undefined : "i")
    } catch (error) {
      return { matches: [], truncated: false, invalidRegex: error instanceof Error ? error.message : String(error) }
    }
  }
  const rg = await findRipgrep()
  if (rg) {
    try {
      const args = ["--json", "--line-number", "--no-heading", "--color", "never", "--max-count", "500"]
      if (options.literal) args.push("--fixed-strings")
      if (!options.caseSensitive) args.push("--ignore-case")
      if (options.include) args.push("--glob", options.include)
      args.push("--", options.pattern)
      const { stdout } = await execFileAsync(rg, [...args, options.path], {
        timeout: DEFAULT_SEARCH_TIMEOUT_MS,
        maxBuffer: 64 * 1024 * 1024,
      })
      const matches: GrepMatch[] = []
      let truncated = false
      for (const line of stdout.split(/\r?\n/)) {
        if (!line) continue
        let event: { type?: string; data?: Record<string, any> }
        try {
          event = JSON.parse(line)
        } catch {
          continue
        }
        if (event.type !== "match" || !event.data) continue
        const data = event.data
        matches.push({
          file: String(data.path?.text ?? ""),
          line: Number(data.line_number ?? 0),
          text: String(data.lines?.text ?? "").replace(/\r?\n$/, ""),
        })
        if (matches.length >= limit) {
          truncated = true
          break
        }
      }
      return { matches, truncated }
    } catch (error) {
      if (error instanceof Error && (error as { killed?: boolean }).killed) {
        return { matches: [], truncated: false, truncatedByTimeout: true }
      }
    }
  }
  return grepFilesJS(options, limit)
}

function grepFilesJS(options: GrepOptions, limit: number): GrepResult {
  const flags = options.caseSensitive ? "" : "i"
  const regex = options.literal
    ? new RegExp(options.pattern.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags)
    : new RegExp(options.pattern, flags)
  const includeRegex = options.include ? globToRegex(options.include) : undefined
  const matches: GrepMatch[] = []
  let truncated = false
  const walk = (current: string) => {
    if (truncated) return
    let entries: string[]
    try {
      entries = readdirSync(current)
    } catch {
      return
    }
    for (const entry of entries) {
      if (truncated) return
      if (entry.startsWith(".") || entry === "node_modules") continue
      const full = path.join(current, entry)
      let stat
      try {
        stat = statSync(full)
      } catch {
        continue
      }
      if (stat.isDirectory()) {
        walk(full)
        continue
      }
      if (stat.size > 512 * 1024) continue
      if (includeRegex && !includeRegex.test(entry)) continue
      let content: string
      try {
        content = readFileSync(full, "utf8")
      } catch {
        continue
      }
      if (content.includes("\0")) continue
      const lines = content.split(/\r?\n/)
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          matches.push({ file: full, line: i + 1, text: lines[i] })
          if (matches.length >= limit) {
            truncated = true
            return
          }
        }
      }
    }
  }
  const base = statSync(options.path).isFile() ? path.dirname(options.path) : options.path
  walk(base)
  return { matches, truncated }
}

export function assertInsideProject(directory: string, target: string): boolean {
  return isInside(directory, target)
}
