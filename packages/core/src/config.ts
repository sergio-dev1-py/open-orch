import path from "node:path"
import type { Config, McpServerConfig, ProviderSettings } from "@openorch/shared"
import { deepMerge, ensureDir, readJson, writeJsonAtomic } from "./util.js"

export const DEFAULT_CONFIG: Config = {
  language: "es",
  theme: "light",
  configVersion: 2,
  providers: {},
  agents: {},
  permissions: [],
  compaction: { auto: true, keep: 15_000 },
  mcp: {},
  skills: { dirs: [] },
  websearch: { provider: "duckduckgo" },
  shell: { timeoutMs: 120_000 },
  terminal: {},
  browser: { mode: "auto" },
  schedule: { startWithWindows: false },
  codeMode: { enabled: true },
  worktree: {},
  experimental: { subagentDepth: 1, subagentVariant: "minimal" },
  autoApprove: false,
}

export class ConfigStore {
  private file: string
  private value: Config

  constructor(private dataDir: string) {
    ensureDir(dataDir)
    this.file = path.join(dataDir, "config.json")
    this.value = deepMerge(structuredClone(DEFAULT_CONFIG), readJson<Partial<Config>>(this.file, {}))
    // One-time migration: installs created before themed UI defaulted to dark; the
    // requested default is the white theme.
    if ((this.value.configVersion ?? 1) < 2) {
      this.value.theme = "light"
      this.value.configVersion = 2
      writeJsonAtomic(this.file, this.value)
    }
  }

  get(): Config {
    return this.value
  }

  path(): string {
    return this.file
  }

  /** Re-reads the file from disk (external edits, config watcher). */
  reload(): Config {
    const next = deepMerge(structuredClone(DEFAULT_CONFIG), readJson<Partial<Config>>(this.file, {}))
    this.value = next
    return next
  }

  set(patch: Partial<Config>): Config {
    this.value = deepMerge(this.value, patch)
    writeJsonAtomic(this.file, this.value)
    return this.value
  }

  /** Replaces (or removes) an MCP server entry (mirrors replaceProvider). */
  replaceMcpServer(name: string, value: McpServerConfig | undefined): Config {
    if (value === undefined) delete this.value.mcp[name]
    else this.value.mcp[name] = value
    writeJsonAtomic(this.file, this.value)
    return this.value
  }

  /** Replaces (or removes) a provider entry, supporting credential removal. */
  replaceProvider(providerID: string, value: ProviderSettings | undefined): Config {
    if (value === undefined) delete this.value.providers[providerID]
    else this.value.providers[providerID] = value
    writeJsonAtomic(this.file, this.value)
    return this.value
  }
}
