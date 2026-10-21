import type { WebSearchConfig, WebSearchResult } from "@openorch/shared"
import { sleep } from "./util.js"
import { ToolFailure } from "./tools/types.js"

/**
 * Web search providers. The default is a keyless chain (DuckDuckGo HTML → Bing
 * RSS → TinyFish keyless); Exa, Brave, Tavily, TinyFish, and Parallel mirror the
 * providers upstream opencode ships and can be selected in Settings with an
 * optional API key. Requests are serialized so rapid agent searches do not trip
 * the keyless rate limits.
 */

export interface WebSearchOutcome {
  provider: string
  results: WebSearchResult[]
  /** Present when a fallback provider answered because the primary was empty/blocked. */
  fallback?: boolean
}

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
const OPENORCH_UA = "Mozilla/5.0 (compatible; OpenOrch/1.0; +https://github.com/openorch)"
const MAX_PROVIDER_BYTES = 256 * 1024
const FETCH_TIMEOUT_MS = 20_000
const DDG_RETRY_DELAY_MS = 1_200

// ---------------------------------------------------------------------------
// Serialized execution (one search at a time)
// ---------------------------------------------------------------------------

let queue: Promise<unknown> = Promise.resolve()

function serialize<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task)
  queue = run.catch(() => undefined)
  return run
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function decodeEntities(value: string): string {
  return value
    .replaceAll("&nbsp;", " ")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&#x27;", "'")
    .replaceAll(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replaceAll("&amp;", "&")
}

function stripTags(value: string): string {
  return decodeEntities(value.replaceAll(/<[^>]+>/g, "")).replaceAll(/\s+/g, " ").trim()
}

// ---------------------------------------------------------------------------
// DuckDuckGo HTML (keyless)
// ---------------------------------------------------------------------------

export function parseDuckDuckGo(html: string): WebSearchResult[] {
  const results: WebSearchResult[] = []
  const anchor = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g
  const matches: { url: string; title: string; end: number }[] = []
  let match: RegExpExecArray | null
  while ((match = anchor.exec(html))) {
    const rawUrl = match[1]
    const decodedUrl = rawUrl.startsWith("//duckduckgo.com/l/")
      ? decodeURIComponent(new URL(`https:${rawUrl}`).searchParams.get("uddg") ?? rawUrl)
      : rawUrl
    if (!decodedUrl.startsWith("http")) continue
    matches.push({ url: decodedUrl, title: stripTags(match[2]), end: match.index + match[0].length })
  }
  for (let i = 0; i < matches.length && results.length < 8; i++) {
    const entry = matches[i]
    const blockEnd = i + 1 < matches.length ? html.indexOf('class="result__a"', entry.end) : html.length
    const block = html.slice(entry.end, blockEnd === -1 ? html.length : blockEnd)
    const snippet = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(block) ?? /class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div|span)>/.exec(block)
    results.push({ title: entry.title, url: entry.url, ...(snippet ? { content: stripTags(snippet[1]) } : {}) })
  }
  return results
}

function looksBlocked(html: string): boolean {
  return /anomaly|unusual traffic|If this error persists|challenge-form|captcha/i.test(html)
}

async function searchDuckDuckGo(query: string): Promise<{ results: WebSearchResult[]; blocked: boolean }> {
  const get = async () => {
    const response = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      headers: { "user-agent": BROWSER_UA, accept: "text/html", "accept-language": "en-US,en;q=0.9" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    return { html: await response.text(), status: response.status }
  }
  const post = async () => {
    const response = await fetch("https://html.duckduckgo.com/html/", {
      method: "POST",
      headers: {
        "user-agent": BROWSER_UA,
        "content-type": "application/x-www-form-urlencoded",
        accept: "text/html",
        "accept-language": "en-US,en;q=0.9",
      },
      body: new URLSearchParams({ q: query }).toString(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    return { html: await response.text(), status: response.status }
  }
  let blocked = false
  for (const [index, attempt] of [get, post].entries()) {
    if (index > 0) await sleep(DDG_RETRY_DELAY_MS)
    try {
      const { html, status } = await attempt()
      const results = parseDuckDuckGo(html)
      if (results.length > 0) return { results, blocked }
      if (status === 202 || looksBlocked(html)) blocked = true
    } catch {
      // try the next attempt
    }
  }
  return { results: [], blocked }
}

// ---------------------------------------------------------------------------
// Bing RSS (keyless fallback)
// ---------------------------------------------------------------------------

export function parseBingRss(xml: string): WebSearchResult[] {
  const results: WebSearchResult[] = []
  const items = /<item>([\s\S]*?)<\/item>/g
  let match: RegExpExecArray | null
  while ((match = items.exec(xml)) && results.length < 8) {
    const item = match[1]
    const title = /<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/.exec(item)?.[1] ?? ""
    const url = /<link>([\s\S]*?)<\/link>/.exec(item)?.[1]?.trim() ?? ""
    const description = /<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/.exec(item)?.[1] ?? ""
    if (!url.startsWith("http")) continue
    results.push({ title: stripTags(title) || url, url, ...(description ? { content: stripTags(description) } : {}) })
  }
  return results
}

async function searchBing(query: string): Promise<WebSearchResult[]> {
  const response = await fetch(`https://www.bing.com/search?q=${encodeURIComponent(query)}&format=rss`, {
    headers: { "user-agent": BROWSER_UA, accept: "application/rss+xml, application/xml, text/xml" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!response.ok) return []
  return parseBingRss(await response.text())
}

// ---------------------------------------------------------------------------
// MCP-style providers (same JSON-RPC format upstream opencode uses)
// ---------------------------------------------------------------------------

async function collectBounded(response: Response): Promise<string> {
  const body = await response.text()
  if (body.length > MAX_PROVIDER_BYTES) throw new ToolFailure("Web search response exceeded the size limit")
  return body
}

function parseMcpResult(body: string): unknown {
  const parse = (payload: string): unknown => {
    const trimmed = payload.trim()
    if (!trimmed.startsWith("{")) return undefined
    try {
      return (JSON.parse(trimmed) as { result?: unknown }).result
    } catch {
      return undefined
    }
  }
  const direct = parse(body)
  if (direct !== undefined) return direct
  for (const line of body.split("\n")) {
    if (!line.startsWith("data: ")) continue
    const data = parse(line.slice(6))
    if (data !== undefined) return data
  }
  return undefined
}

async function mcpCall(
  url: string,
  tool: string,
  args: Record<string, unknown>,
  headers: Record<string, string>,
): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "user-agent": OPENORCH_UA, ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
    signal: AbortSignal.timeout(25_000),
  })
  if (!response.ok) throw new ToolFailure(`Web search failed (HTTP ${response.status})`)
  return parseMcpResult(await collectBounded(response))
}

export async function searchTinyFish(query: string, apiKey?: string): Promise<WebSearchResult[]> {
  const result = (await mcpCall(
    "https://agent.tinyfish.ai/mcp",
    "search",
    { query },
    apiKey ? { "X-API-Key": apiKey } : { "X-TinyFish-Access-Mode": "keyless" },
  )) as { content?: { type?: string; text?: string }[] } | undefined
  const text = result?.content?.find((entry) => entry.type === "text")?.text
  if (!text) return []
  const parsed = JSON.parse(text) as { results?: { url?: string; title?: string; snippet?: string }[] }
  return (parsed.results ?? [])
    .filter((entry) => typeof entry.url === "string" && entry.url.startsWith("http"))
    .slice(0, 8)
    .map((entry) => ({ title: entry.title ?? entry.url ?? "", url: entry.url ?? "", ...(entry.snippet ? { content: entry.snippet } : {}) }))
}

export async function searchParallel(query: string, apiKey?: string): Promise<WebSearchResult[]> {
  const result = (await mcpCall(
    "https://search.parallel.ai/mcp",
    "web_search",
    { objective: query, search_queries: [query] },
    apiKey ? { authorization: `Bearer ${apiKey}` } : {},
  )) as
    | {
        structuredContent?: { results?: { url?: string; title?: string; publish_date?: string | null; excerpts?: string[] }[] }
        content?: { type?: string; text?: string }[]
      }
    | undefined
  let results = result?.structuredContent?.results
  if (!results) {
    const text = result?.content?.find((entry) => entry.type === "text")?.text
    if (text) results = (JSON.parse(text) as { results?: { url?: string; title?: string; publish_date?: string | null; excerpts?: string[] }[] }).results
  }
  return (results ?? [])
    .filter((entry) => typeof entry.url === "string" && entry.url.startsWith("http"))
    .slice(0, 8)
    .map((entry) => ({
      title: entry.title ?? entry.url ?? "",
      url: entry.url ?? "",
      ...(entry.excerpts?.length ? { content: entry.excerpts.join("\n\n") } : {}),
      ...(entry.publish_date ? { published: entry.publish_date } : {}),
    }))
}

// ---------------------------------------------------------------------------
// API-key providers (upstream parity)
// ---------------------------------------------------------------------------

export async function searchExa(query: string, apiKey?: string): Promise<WebSearchResult[]> {
  const response = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey ?? "" },
    body: JSON.stringify({ query, numResults: 8, contents: { text: { maxCharacters: 1200 } } }),
    signal: AbortSignal.timeout(25_000),
  })
  if (!response.ok) throw new ToolFailure(`Web search failed (HTTP ${response.status})`)
  const data = (await response.json()) as { results?: { title?: string; url?: string; text?: string; publishedDate?: string }[] }
  return (data.results ?? []).map((entry) => ({
    title: entry.title ?? entry.url ?? "",
    url: entry.url ?? "",
    ...(entry.text ? { content: entry.text } : {}),
    ...(entry.publishedDate ? { published: entry.publishedDate } : {}),
  }))
}

export async function searchBrave(query: string, apiKey?: string): Promise<WebSearchResult[]> {
  const response = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=8`, {
    headers: { accept: "application/json", "x-subscription-token": apiKey ?? "" },
    signal: AbortSignal.timeout(25_000),
  })
  if (!response.ok) throw new ToolFailure(`Web search failed (HTTP ${response.status})`)
  const data = (await response.json()) as { web?: { results?: { title?: string; url?: string; description?: string }[] } }
  return (data.web?.results ?? []).map((entry) => ({
    title: entry.title ?? entry.url ?? "",
    url: entry.url ?? "",
    ...(entry.description ? { content: entry.description } : {}),
  }))
}

export async function searchTavily(query: string, apiKey?: string): Promise<WebSearchResult[]> {
  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ api_key: apiKey, query, max_results: 8 }),
    signal: AbortSignal.timeout(25_000),
  })
  if (!response.ok) throw new ToolFailure(`Web search failed (HTTP ${response.status})`)
  const data = (await response.json()) as { results?: { title?: string; url?: string; content?: string }[] }
  return (data.results ?? []).map((entry) => ({
    title: entry.title ?? entry.url ?? "",
    url: entry.url ?? "",
    ...(entry.content ? { content: entry.content } : {}),
  }))
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function runProvider(provider: string, config: WebSearchConfig, query: string): Promise<WebSearchOutcome> {
  if (provider === "exa") return { provider, results: await searchExa(query, config.apiKey) }
  if (provider === "brave") return { provider, results: await searchBrave(query, config.apiKey) }
  if (provider === "tavily") return { provider, results: await searchTavily(query, config.apiKey) }
  if (provider === "tinyfish") return { provider, results: await searchTinyFish(query, config.apiKey) }
  if (provider === "parallel") return { provider, results: await searchParallel(query, config.apiKey) }
  // DuckDuckGo (default, keyless): fall back to Bing RSS, then keyless TinyFish.
  const ddg = await searchDuckDuckGo(query)
  if (ddg.results.length > 0) return { provider: "duckduckgo", results: ddg.results }
  const bing = await searchBing(query).catch(() => [])
  if (bing.length > 0) return { provider: "bing", results: bing, fallback: true }
  const tinyfish = await searchTinyFish(query).catch(() => [])
  if (tinyfish.length > 0) return { provider: "tinyfish", results: tinyfish, fallback: true }
  if (ddg.blocked) {
    throw new ToolFailure(
      "Web search is temporarily rate limited. Retry in a few seconds, or configure another provider in Settings (TinyFish, Parallel, Exa, Brave, or Tavily).",
    )
  }
  return { provider: "duckduckgo", results: [] }
}

/** Runs the configured provider chain (serialized so parallel agents queue up). */
export function searchWeb(config: WebSearchConfig, query: string): Promise<WebSearchOutcome> {
  const provider = config.provider ?? "duckduckgo"
  return serialize(() => runProvider(provider, config, query))
}
