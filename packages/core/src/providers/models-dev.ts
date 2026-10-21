import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { ProviderKind, ReasoningOption } from "@openorch/shared"

/**
 * models.dev catalog, fetched live (like upstream opencode) so new models and
 * their real reasoning levels show up without rebuilding the app. The bundled
 * `catalog.json` stays as the offline baseline; live data is merged per model.
 */

export interface CatalogModel {
  id: string
  name: string
  family?: string
  attachment?: boolean
  reasoning?: boolean
  reasoningOptions?: ReasoningOption[]
  toolCall?: boolean
  temperature?: boolean
  releaseDate?: string
  modalities?: { input?: string[]; output?: string[] }
  limit?: { context?: number; output?: number }
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
  interleaved?: { field?: string }
  canonicalModelID?: string
  status?: string
}

export interface CatalogProvider {
  id: string
  name: string
  kind: ProviderKind
  env?: string[]
  baseURL?: string
  doc?: string
  npm?: string
  models: CatalogModel[]
}

interface RawModel {
  id: string
  name?: string
  family?: string
  attachment?: boolean
  reasoning?: boolean
  reasoning_options?: ReasoningOption[]
  tool_call?: boolean
  temperature?: boolean
  release_date?: string
  last_updated?: string
  modalities?: { input?: string[]; output?: string[] }
  limit?: { context?: number; output?: number }
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number }
  interleaved?: { field?: string }
  canonical_model_id?: string
  status?: string
}

export interface RawProvider {
  id?: string
  name?: string
  env?: string[]
  npm?: string
  api?: string
  doc?: string
  models?: Record<string, RawModel>
}

const NPM_TO_KIND: Record<string, ProviderKind> = {
  "@ai-sdk/anthropic": "anthropic",
  "@ai-sdk/openai": "openai",
  "@ai-sdk/google": "google",
  "@ai-sdk/deepseek": "deepseek",
  "@ai-sdk/xai": "xai",
  "@ai-sdk/groq": "groq",
  "@ai-sdk/mistral": "mistral",
  "@openrouter/ai-sdk-provider": "openrouter",
  "@ai-sdk/cerebras": "cerebras",
  "@ai-sdk/togetherai": "togetherai",
  "@ai-sdk/openai-compatible": "openai-compatible",
}

// Providers first-party kinds we keep even when the catalog tacks them to a compatible package.
const FORCE_KIND: Record<string, ProviderKind> = {
  opencode: "openai-compatible",
  "opencode-go": "openai-compatible",
}

/** Converts a models.dev `api.json` payload into the app's catalog shape. */
export function convertModelsDev(raw: Record<string, RawProvider>): CatalogProvider[] {
  const providers: CatalogProvider[] = []
  for (const [pid, provider] of Object.entries(raw)) {
    const kind = FORCE_KIND[pid] ?? (provider.npm ? NPM_TO_KIND[provider.npm] : undefined)
    if (!kind) continue
    // openai-compatible providers need an explicit api endpoint.
    if (kind === "openai-compatible" && !provider.api) continue
    const models: CatalogModel[] = []
    for (const model of Object.values(provider.models ?? {})) {
      if (model.status === "deprecated") continue
      models.push({
        id: model.id,
        name: model.name ?? model.id,
        family: model.family,
        attachment: model.attachment,
        reasoning: model.reasoning,
        reasoningOptions: model.reasoning_options,
        toolCall: model.tool_call,
        temperature: model.temperature,
        releaseDate: model.release_date ?? model.last_updated,
        modalities: model.modalities,
        limit: model.limit,
        cost: model.cost
          ? {
              input: model.cost.input,
              output: model.cost.output,
              cacheRead: model.cost.cache_read,
              cacheWrite: model.cost.cache_write,
            }
          : undefined,
        interleaved: model.interleaved,
        canonicalModelID: model.canonical_model_id,
        status: model.status,
      })
    }
    if (models.length === 0) continue
    providers.push({
      id: pid,
      name: provider.name ?? pid,
      kind,
      env: provider.env,
      baseURL: provider.api,
      doc: provider.doc,
      npm: provider.npm,
      models,
    })
  }
  providers.sort((a, b) => a.id.localeCompare(b.id))
  return providers
}

/**
 * Merges two catalogs per model: entries from `incoming` win, everything else in
 * `base` is kept. Missing models never disappear because a provider entry changed.
 */
export function mergeCatalogProviders(base: CatalogProvider[], incoming: CatalogProvider[]): CatalogProvider[] {
  const providers = new Map(base.map((provider) => [provider.id, { ...provider, models: [...provider.models] }]))
  for (const provider of incoming) {
    const current = providers.get(provider.id)
    if (!current) {
      providers.set(provider.id, { ...provider, models: [...provider.models] })
      continue
    }
    const models = new Map(current.models.map((model) => [model.id, model]))
    for (const model of provider.models) models.set(model.id, model)
    providers.set(provider.id, { ...current, ...provider, models: [...models.values()] })
  }
  return [...providers.values()]
}

// ---------------------------------------------------------------------------
// Cache + fetch
// ---------------------------------------------------------------------------

export const CATALOG_TTL_MS = 24 * 60 * 60 * 1000

export interface CatalogCache {
  fetchedAt: number
  url: string
  providers: CatalogProvider[]
}

export interface CatalogStatus {
  source: "embedded" | "cache" | "live"
  updatedAt?: number
  /** OpenCode Console account info (active models per provider) when connected. */
  account?: { active: number; updatedAt: number }
}

export function catalogCachePath(dataDir: string): string {
  return path.join(dataDir, "models-catalog.json")
}

export function loadCatalogCache(dataDir: string): CatalogCache | undefined {
  try {
    const raw = JSON.parse(readFileSync(catalogCachePath(dataDir), "utf8")) as CatalogCache
    if (!Array.isArray(raw.providers) || typeof raw.fetchedAt !== "number") return undefined
    return raw
  } catch {
    return undefined
  }
}

export function catalogSources(): string[] {
  const override = process.env.OPENORCH_MODELS_URL
  if (override) return [override]
  return ["https://models.opencode.ai/api.json", "https://models.dev/api.json"]
}

/** Downloads the live models.dev catalog, converts it, and caches it on disk. */
export async function fetchModelsCatalog(options: {
  dataDir: string
  url?: string
  timeoutMs?: number
}): Promise<{ ok: true; providers: CatalogProvider[]; models: number; fetchedAt: number; url: string } | { ok: false; error: string }> {
  const urls = options.url ? [options.url] : catalogSources()
  let lastError = "no source reachable"
  for (const url of urls) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(options.timeoutMs ?? 30_000) })
      if (!response.ok) {
        lastError = `HTTP ${response.status} from ${url}`
        continue
      }
      const payload = (await response.json()) as Record<string, RawProvider>
      const providers = convertModelsDev(payload)
      if (providers.length === 0) {
        lastError = `empty catalog from ${url}`
        continue
      }
      const fetchedAt = Date.now()
      const cache: CatalogCache = { fetchedAt, url, providers }
      try {
        mkdirSync(options.dataDir, { recursive: true })
        writeFileSync(catalogCachePath(options.dataDir), JSON.stringify(cache))
      } catch {
        // caching is best effort
      }
      return { ok: true, providers, models: providers.reduce((sum, provider) => sum + provider.models.length, 0), fetchedAt, url }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
  }
  return { ok: false, error: lastError }
}
