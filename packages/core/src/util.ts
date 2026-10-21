import { randomBytes } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import os from "node:os"

export function id(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${randomBytes(5).toString("hex")}`
}

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true })
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T
  } catch {
    return fallback
  }
}

export function writeJsonAtomic(file: string, value: unknown): void {
  ensureDir(path.dirname(file))
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2))
  renameSync(tmp, file)
}

export function writeFileAtomic(file: string, content: string): void {
  ensureDir(path.dirname(file))
  const tmp = `${file}.tmp`
  writeFileSync(tmp, content)
  renameSync(tmp, file)
}

export function home(): string {
  // Tests sandbox the user home directory with OPENORCH_HOME.
  return process.env.OPENORCH_HOME ?? os.homedir()
}

export function expandHome(p: string): string {
  if (p === "~") return home()
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(home(), p.slice(2))
  return p
}

export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child)
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

export function truncate(text: string, max: number, note = "…(truncated)"): string {
  if (text.length <= max) return text
  const head = text.slice(0, max)
  return `${head}\n${note}`
}

/** Rough token estimate: 4 chars/token for latin text. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"))
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error("aborted"))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

export function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === undefined) return base
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return patch as T
  if (typeof base !== "object" || base === null || Array.isArray(base)) return patch as T
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    out[key] = key in out ? deepMerge(out[key], value) : value
  }
  return out as T
}

/** Last matching rule wins. Wildcards: `*` matches any run of characters. */
export function wildcardMatch(value: string, pattern: string): boolean {
  if (pattern === "*" || pattern === value) return true
  if (!pattern.includes("*")) return false
  const escaped = pattern.split("*").map((part) => part.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")
  return new RegExp(`^${escaped}$`, "s").test(value)
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  return `${m}m ${Math.round(s % 60)}s`
}
