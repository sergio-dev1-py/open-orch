import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

/**
 * OpenCode Console account config (`/api/v2/config`, same endpoint upstream
 * opencode's provider plugin uses). It carries the account's real model list for
 * the `opencode`/`opencode-go` providers: mentioned + not disabled = active,
 * disabled = hidden for this account. Refreshed periodically and cached on disk.
 */

export interface ConsoleModelConfig {
  disabled?: boolean
  name?: string
  family?: string
  modelID?: string
  capabilities?: { tools?: boolean; input?: string[]; output?: string[] }
  cost?: { tier?: { type?: string; size?: number }; input: number; output: number; cache?: { read?: number; write?: number } }[]
  limit?: { context?: number; input?: number; output?: number }
  variants?: unknown[]
}

export interface ConsoleProviderConfig {
  canonical?: string
  name?: string
  package?: string
  models?: Record<string, ConsoleModelConfig>
}

export interface ConsoleAccountConfig {
  fetchedAt: number
  url: string
  providers: Record<string, ConsoleProviderConfig>
}

export const CONSOLE_TTL_MS = 60 * 60 * 1000

export function consoleConfigPath(dataDir: string): string {
  return path.join(dataDir, "console-config.json")
}

export function consoleConfigUrl(): string {
  return process.env.OPENORCH_CONSOLE_URL ?? "https://opencode.ai/console/api/v2/config"
}

export function loadConsoleConfig(dataDir: string): ConsoleAccountConfig | undefined {
  try {
    const raw = JSON.parse(readFileSync(consoleConfigPath(dataDir), "utf8")) as ConsoleAccountConfig
    if (!raw.providers || typeof raw.fetchedAt !== "number") return undefined
    return raw
  } catch {
    return undefined
  }
}

export async function fetchConsoleConfig(options: {
  dataDir: string
  apiKey: string
  url?: string
  timeoutMs?: number
}): Promise<{ ok: true; config: ConsoleAccountConfig } | { ok: false; error: string }> {
  const url = options.url ?? consoleConfigUrl()
  try {
    const response = await fetch(url, {
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        accept: "application/json",
        "user-agent": "openorch/0.1.0",
      },
      signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
    })
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` }
    const payload = (await response.json()) as { providers?: Record<string, ConsoleProviderConfig> }
    if (!payload.providers || typeof payload.providers !== "object") return { ok: false, error: "invalid payload" }
    const config: ConsoleAccountConfig = { fetchedAt: Date.now(), url, providers: payload.providers }
    try {
      mkdirSync(options.dataDir, { recursive: true })
      writeFileSync(consoleConfigPath(options.dataDir), JSON.stringify(config))
    } catch {
      // caching is best effort
    }
    return { ok: true, config }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Active (not disabled) model ids for a provider, with alias handling. */
export function consoleActiveModels(provider: ConsoleProviderConfig | undefined): Map<string, ConsoleModelConfig> | undefined {
  if (!provider?.models) return undefined
  const out = new Map<string, ConsoleModelConfig>()
  for (const [key, cfg] of Object.entries(provider.models)) {
    if (cfg.disabled === true) continue
    out.set(cfg.modelID ?? key, cfg)
  }
  return out
}

/** Total active models across every provider in the account config. */
export function consoleActiveCount(config: ConsoleAccountConfig | undefined): number {
  if (!config) return 0
  let total = 0
  for (const provider of Object.values(config.providers)) total += consoleActiveModels(provider)?.size ?? 0
  return total
}
