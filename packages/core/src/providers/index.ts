import type { Config, ModelInfo, ProviderInfo, ProviderKind, ReasoningOption } from "@openorch/shared"
import { createAnthropic } from "@ai-sdk/anthropic"
import { createCerebras } from "@ai-sdk/cerebras"
import { createDeepSeek } from "@ai-sdk/deepseek"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { createGroq } from "@ai-sdk/groq"
import { createMistral } from "@ai-sdk/mistral"
import { createOpenAI } from "@ai-sdk/openai"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { createTogetherAI } from "@ai-sdk/togetherai"
import { createXai } from "@ai-sdk/xai"
import { createOpenRouter } from "@openrouter/ai-sdk-provider"
import type { LanguageModel } from "ai"
import rawCatalog from "./catalog.json"
import { consoleActiveModels, type ConsoleAccountConfig } from "./console-config.js"
import { mergeCatalogProviders, type CatalogModel, type CatalogProvider } from "./models-dev.js"

export type { CatalogModel, CatalogProvider } from "./models-dev.js"

const catalog = rawCatalog as { providers: CatalogProvider[] }

let liveProviders: CatalogProvider[] | undefined

/** Applies a live models.dev catalog (merged over the bundled baseline). */
export function setLiveCatalog(providers: CatalogProvider[] | undefined): void {
  liveProviders = providers && providers.length > 0 ? providers : undefined
}

/** Embedded + live catalog (live entries win per model; embedded fills the gaps). */
function activeProviders(): CatalogProvider[] {
  if (!liveProviders) return catalog.providers
  return mergeCatalogProviders(catalog.providers, liveProviders)
}

let consoleAccount: ConsoleAccountConfig | undefined

/** Applies the OpenCode Console account config (the account's real active models). */
export function setConsoleAccount(config: ConsoleAccountConfig | undefined): void {
  consoleAccount = config
}

function consoleProvider(providerID: string) {
  return consoleAccount?.providers[providerID]
}

/**
 * Catalog models for a provider. Console-attached providers (opencode/opencode-go)
 * list exactly the account's active models: disabled or unlisted = hidden, and
 * account metadata (name/family/cost/limit/capabilities) wins over the catalog.
 */
function visibleCatalogModels(provider: CatalogProvider): CatalogModel[] {
  const active = consoleActiveModels(consoleProvider(provider.id))
  // An empty account list means "no Console filter for this provider"; hiding the
  // whole catalog would leave the provider at 0 models and block provider tests.
  if (!active || active.size === 0) return provider.models
  const byId = new Map(provider.models.map((model) => [model.id, model]))
  const out: CatalogModel[] = []
  for (const [id, config] of active) {
    const base = byId.get(id)
    out.push({
      id,
      name: config.name ?? base?.name ?? id,
      family: config.family ?? base?.family,
      attachment: base?.attachment,
      reasoning: base?.reasoning,
      reasoningOptions: base?.reasoningOptions,
      toolCall: base?.toolCall ?? config.capabilities?.tools,
      temperature: base?.temperature,
      releaseDate: base?.releaseDate,
      modalities:
        base?.modalities ??
        (config.capabilities ? { input: config.capabilities.input, output: config.capabilities.output } : undefined),
      limit: config.limit ?? base?.limit,
      cost: config.cost?.[0]
        ? {
            input: config.cost[0].input,
            output: config.cost[0].output,
            cacheRead: config.cost[0].cache?.read,
            cacheWrite: config.cost[0].cache?.write,
          }
        : base?.cost,
      interleaved: base?.interleaved,
      canonicalModelID: base?.canonicalModelID,
      status: base?.status,
    })
  }
  return out
}

/** Minimal reasoning variants, in preference order (upstream `MINIMAL_REASONING_VARIANTS`). */
export const MINIMAL_REASONING_VARIANTS = ["none", "minimal", "low"] as const

/** Cheapest thinking level available for a model, if it declares any variants. */
export function minimalVariant(model: ModelInfo | undefined): string | undefined {
  const variants = model?.variants ?? []
  if (variants.length === 0) return undefined
  for (const candidate of MINIMAL_REASONING_VARIANTS) {
    if (variants.includes(candidate)) return candidate
  }
  return variants[0]
}

export function variantIds(model: CatalogModel): string[] {
  if (!model.reasoning) return []
  const reasoningOptions = model.reasoningOptions ?? []
  const out: string[] = []
  const push = (id: string) => {
    if (!out.includes(id)) out.push(id)
  }
  const toggle = reasoningOptions.find((o) => o.type === "toggle")
  if (toggle) push("none")
  const effort = reasoningOptions.find((o) => o.type === "effort") as { type: "effort"; values?: string[] } | undefined
  if (effort) for (const value of effort.values ?? ["low", "medium", "high"]) push(value)
  const budget = reasoningOptions.find((o) => o.type === "budget_tokens")
  if (budget && !effort) {
    push("high")
    push("max")
  }
  // Variants come exclusively from the catalog (upstream `Variant.resolve`): models
  // without declared reasoning options simply have no levels to pick.
  return out
}

function toModelInfo(providerID: string, model: CatalogModel): ModelInfo {
  return {
    id: model.id,
    providerID,
    name: model.name,
    family: model.family,
    attachment: model.attachment,
    reasoning: model.reasoning,
    reasoningOptions: model.reasoningOptions,
    toolCall: model.toolCall,
    temperature: model.temperature,
    releaseDate: model.releaseDate,
    modalities: model.modalities,
    limit: model.limit,
    cost: model.cost,
    interleaved: model.interleaved,
    canonicalModelID: model.canonicalModelID,
    variants: variantIds(model),
  }
}

/** Minimal info for models discovered through the provider's `/models` endpoint. */
function discoveredModelInfo(providerID: string, modelID: string): ModelInfo {
  return { id: modelID, providerID, name: modelID, toolCall: true, temperature: true, discovered: true }
}

export function envApiKey(env: string[] | undefined): string | undefined {
  for (const name of env ?? []) {
    const value = process.env[name]
    if (value) return value
  }
  return undefined
}

export interface ProviderRuntime {
  id: string
  name: string
  kind: ProviderKind
  baseURL?: string
  apiKey?: string
  headers?: Record<string, string>
}

function catalogRuntime(config: Config, provider: CatalogProvider): ProviderRuntime | undefined {
  const settings = config.providers[provider.id] ?? {}
  if (settings.enabled === false) return undefined
  const apiKey = settings.apiKey ?? envApiKey(provider.env)
  return {
    id: provider.id,
    name: settings.name ?? provider.name,
    kind: provider.kind,
    baseURL: settings.baseURL ?? provider.baseURL,
    apiKey,
    headers: settings.headers,
  }
}

function customProviders(config: Config): ProviderRuntime[] {
  const known = new Set(activeProviders().map((p) => p.id))
  const out: ProviderRuntime[] = []
  for (const [id, settings] of Object.entries(config.providers)) {
    if (known.has(id) || !settings.kind) continue
    if (settings.enabled === false) continue
    out.push({
      id,
      name: settings.name ?? id,
      kind: settings.kind,
      baseURL: settings.baseURL,
      apiKey: settings.apiKey,
      headers: settings.headers,
    })
  }
  return out
}

export function isConfigured(config: Config, provider: ProviderRuntime, catalogProvider?: CatalogProvider): boolean {
  const settings = config.providers[provider.id] ?? {}
  if (settings.enabled === true) return true
  if (provider.apiKey) return true
  if (provider.kind === "openai-compatible" && settings.baseURL === undefined && !catalogProvider) return true
  return false
}

export function listProviders(config: Config): ProviderInfo[] {
  const out: ProviderInfo[] = []
  for (const provider of activeProviders()) {
    const runtime = catalogRuntime(config, provider)
    const settings = config.providers[provider.id] ?? {}
    if (settings.enabled === false) continue
    out.push({
      id: provider.id,
      name: runtime?.name ?? provider.name,
      kind: provider.kind,
      env: provider.env,
      baseURL: runtime?.baseURL,
      doc: provider.doc,
      npm: provider.npm,
      source: "catalog",
      models: mergeDiscovered(provider.id, visibleCatalogModels(provider).map((m) => toModelInfo(provider.id, m)), config),
      configured: isConfigured(config, { id: provider.id, name: provider.name, kind: provider.kind, apiKey: runtime?.apiKey }, provider),
    })
  }
  for (const runtime of customProviders(config)) {
    out.push({
      id: runtime.id,
      name: runtime.name,
      kind: runtime.kind,
      baseURL: runtime.baseURL,
      source: "custom",
      models: (config.providers[runtime.id]?.models ?? []).map((modelID) => ({
        id: modelID,
        providerID: runtime.id,
        name: modelID,
        toolCall: true,
        temperature: true,
      })),
      configured: true,
    })
  }
  return out
}

export function availableProviders(config: Config): ProviderRuntime[] {
  const out: ProviderRuntime[] = []
  for (const provider of activeProviders()) {
    const runtime = catalogRuntime(config, provider)
    if (!runtime) continue
    if (!isConfigured(config, runtime, provider)) continue
    out.push(runtime)
  }
  out.push(...customProviders(config))
  return out
}

export function resolveProvider(config: Config, providerID: string): ProviderRuntime | undefined {
  const catalogProvider = activeProviders().find((p) => p.id === providerID)
  if (catalogProvider) {
    const runtime = catalogRuntime(config, catalogProvider)
    return runtime
  }
  return customProviders(config).find((p) => p.id === providerID)
}

/** Appends models discovered via `/models` that the catalog does not list. */
function mergeDiscovered(providerID: string, models: ModelInfo[], config: Config): ModelInfo[] {
  const configured = config.providers[providerID]?.models ?? []
  if (configured.length === 0) return models
  const known = new Set(models.map((model) => model.id))
  // Console-attached providers list exactly the account's models, discovered extras included.
  const active = consoleActiveModels(consoleProvider(providerID))
  const extra = configured
    .filter((id) => !known.has(id) && (!active || active.size === 0 || active.has(id)))
    .map((id) => discoveredModelInfo(providerID, id))
  return extra.length > 0 ? [...models, ...extra] : models
}

export function listModels(config: Config): ModelInfo[] {
  const out: ModelInfo[] = []
  for (const provider of activeProviders()) {
    const runtime = catalogRuntime(config, provider)
    if (!runtime || !isConfigured(config, runtime, provider)) continue
    for (const model of mergeDiscovered(provider.id, visibleCatalogModels(provider).map((m) => toModelInfo(provider.id, m)), config)) {
      out.push(model)
    }
  }
  for (const runtime of customProviders(config)) {
    for (const modelID of config.providers[runtime.id]?.models ?? []) {
      out.push(discoveredModelInfo(runtime.id, modelID))
    }
  }
  return out
}

export function lookupModel(config: Config, providerID: string, modelID: string): ModelInfo | undefined {
  const catalogProvider = activeProviders().find((p) => p.id === providerID)
  const model = catalogProvider ? visibleCatalogModels(catalogProvider).find((m) => m.id === modelID) : undefined
  if (catalogProvider && model) return toModelInfo(providerID, model)
  const settings = config.providers[providerID]
  if (settings?.kind || (settings?.models ?? []).includes(modelID)) {
    return discoveredModelInfo(providerID, modelID)
  }
  return undefined
}

/**
 * Picks a cheap small model for titles and summaries. When `providerID` is given,
 * only models from that provider are considered (upstream `Model.small`).
 */
export function pickSmallModel(config: Config, providerID?: string): ModelInfo | undefined {
  if (config.smallModel && (!providerID || config.smallModel.providerID === providerID)) {
    const found = lookupModel(config, config.smallModel.providerID, config.smallModel.modelID)
    if (found) return found
  }
  const models = listModels(config).filter((model) => !providerID || model.providerID === providerID)
  const families = ["gpt-luna", "gemini-flash-lite", "gemini-flash", "claude-haiku"]
  for (const family of families) {
    const found = models.find((model) => model.family === family)
    if (found) return found
  }
  for (const family of families) {
    const found = models.find((model) => (model.family ?? "").includes(family) || model.id.includes(family))
    if (found) return found
  }
  // Broaden: any small-ish family id (flash-lite, flash, haiku, mini, nano).
  const smallish = /flash-lite|flash|haiku|mini|nano|small/i
  return (
    models.find((model) => smallish.test(`${model.family ?? ""} ${model.id}`) && model.toolCall) ??
    models[0] ??
    undefined
  )
}

/** Picks the cheapest tool-capable model (used as the default when nothing is remembered). */
export function pickCheapModel(config: Config): ModelInfo | undefined {
  const models = listModels(config).filter((model) => model.toolCall && (model.modalities?.input ?? ["text"]).includes("text"))
  if (models.length === 0) return undefined
  const price = (model: ModelInfo) => model.cost?.input ?? Number.POSITIVE_INFINITY
  const output = (model: ModelInfo) => model.cost?.output ?? Number.POSITIVE_INFINITY
  const free = models.filter((model) => price(model) === 0)
  const pool = free.length > 0 ? free : models
  return [...pool].sort((a, b) => price(a) - price(b) || output(a) - output(b) || (b.limit?.context ?? 0) - (a.limit?.context ?? 0))[0]
}

// ---------------------------------------------------------------------------
// Language model construction (Vercel AI SDK)
// ---------------------------------------------------------------------------

export function createLanguageModel(provider: ProviderRuntime, modelID: string): LanguageModel {
  const apiKey = provider.apiKey ?? ""
  const headers = provider.headers
  switch (provider.kind) {
    case "anthropic":
      return createAnthropic({ apiKey, baseURL: provider.baseURL, headers }).languageModel(modelID)
    case "openai":
      return createOpenAI({ apiKey, baseURL: provider.baseURL, headers }).languageModel(modelID)
    case "google":
      return createGoogleGenerativeAI({ apiKey, baseURL: provider.baseURL, headers }).languageModel(modelID)
    case "deepseek":
      return createDeepSeek({ apiKey, baseURL: provider.baseURL, headers }).languageModel(modelID)
    case "xai":
      return createXai({ apiKey, baseURL: provider.baseURL, headers }).languageModel(modelID)
    case "groq":
      return createGroq({ apiKey, baseURL: provider.baseURL, headers }).languageModel(modelID)
    case "mistral":
      return createMistral({ apiKey, baseURL: provider.baseURL, headers }).languageModel(modelID)
    case "cerebras":
      return createCerebras({ apiKey, baseURL: provider.baseURL, headers }).languageModel(modelID)
    case "togetherai":
      return createTogetherAI({ apiKey, baseURL: provider.baseURL, headers }).languageModel(modelID)
    case "openrouter":
      return createOpenRouter({ apiKey, baseURL: provider.baseURL, headers }).languageModel(modelID)
    case "openai-compatible":
      return createOpenAICompatible({
        name: provider.id,
        baseURL: provider.baseURL ?? "https://api.openai.com/v1",
        apiKey,
        headers,
      }).languageModel(modelID)
  }
}

export interface VariantOptions {
  providerOptions?: Record<string, Record<string, unknown>>
  maxOutputTokens?: number
}

/** Maps a reasoning variant id to provider options, mirroring upstream variant protocols. */
export function variantOptions(kind: ProviderKind, model: ModelInfo, variant: string | undefined): VariantOptions {
  const limitOutput = model.limit?.output
  const base: VariantOptions = {}
  if (limitOutput && limitOutput <= 8192) base.maxOutputTokens = limitOutput
  if (!variant || variant === "default") return base

  const budgets: Record<string, number> = { low: 4_000, medium: 8_000, high: 16_000, max: 32_000 }
  const clampBudget = (value: number) => {
    const cap = limitOutput ? Math.min(limitOutput, 32_000) : 32_000
    return Math.max(1_024, Math.min(value, cap - 1_024))
  }

  if (kind === "anthropic") {
    if (variant === "none") return { ...base, providerOptions: { anthropic: { thinking: { type: "disabled" } } } }
    const budget = clampBudget(budgets[variant] ?? 8_000)
    return {
      ...base,
      maxOutputTokens: limitOutput ? Math.min(limitOutput, budget * 2) : budget * 2,
      providerOptions: { anthropic: { thinking: { type: "enabled", budgetTokens: budget } } },
    }
  }
  if (kind === "openai") {
    const effort = variant === "none" ? "minimal" : variant
    return { ...base, providerOptions: { openai: { reasoningEffort: effort } } }
  }
  if (kind === "google") {
    if (variant === "none") return { ...base, providerOptions: { google: { thinkingConfig: { thinkingBudget: 0 } } } }
    // Catalog values are real Gemini thinking levels (minimal/low/medium/high…): pass through.
    const level = variant === "minimal" ? "minimal" : variant
    return {
      ...base,
      providerOptions: { google: { thinkingConfig: { includeThoughts: true, thinkingLevel: level } } },
    }
  }
  if (kind === "deepseek") {
    // Upstream deepseekChat: thinking toggle plus reasoning effort.
    if (variant === "none") return { ...base, providerOptions: { deepseek: { thinking: { type: "disabled" } } } }
    return { ...base, providerOptions: { deepseek: { thinking: { type: "enabled" }, reasoningEffort: variant } } }
  }
  if (kind === "groq") {
    return { ...base, providerOptions: { groq: { reasoningEffort: variant === "none" ? "minimal" : variant } } }
  }
  if (kind === "openai-compatible") {
    // Hosted OpenAI-compatible gateways (OpenCode Zen/Go) route many families, and each
    // family takes its own reasoning overlay (upstream variant protocols: openaiChat,
    // zaiChat, moonshotChat, alibabaChat, minimaxChat).
    const haystack = `${model.id} ${model.family ?? ""}`.toLowerCase()
    if (/glm|zai/.test(haystack)) {
      return {
        ...base,
        providerOptions: {
          [model.providerID]:
            variant === "none"
              ? { thinking: { type: "disabled" } }
              : { thinking: { type: "enabled", clear_thinking: false }, reasoningEffort: variant },
        },
      }
    }
    if (/kimi|moonshot/.test(haystack)) {
      return {
        ...base,
        providerOptions: {
          [model.providerID]: variant === "none" ? { enableThinking: false } : { enableThinking: true, reasoningEffort: variant },
        },
      }
    }
    if (/qwen|alibaba/.test(haystack)) {
      return {
        ...base,
        providerOptions: {
          [model.providerID]: variant === "none" ? { enableThinking: false } : { enableThinking: true, reasoningEffort: variant },
        },
      }
    }
    if (/minimax/.test(haystack)) {
      return {
        ...base,
        providerOptions: {
          [model.providerID]:
            variant === "none" ? { thinking: { type: "disabled" } } : { thinking: { type: "enabled" }, reasoningEffort: variant },
        },
      }
    }
    // Default (GPT/Luna/gpt-oss, DeepSeek, Grok… on compatible gateways): the flat
    // chat-completions reasoning effort, including "none".
    return { ...base, providerOptions: { [model.providerID]: { reasoningEffort: variant } } }
  }
  return base
}
