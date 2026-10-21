import { z } from "zod"
import { textOutput, ToolFailure, type ToolContext, type ToolDefinition } from "./types.js"

const MAX_FETCH_BYTES = 5 * 1024 * 1024
const USER_AGENT = "Mozilla/5.0 (compatible; OpenOrch-User/1.0; +https://github.com/openorch)"

async function fetchBounded(
  url: string,
  accept: string,
  timeoutMs: number,
  userAgent = USER_AGENT,
): Promise<{ body: string; contentType: string; challenged: boolean }> {
  const response = await fetch(url, {
    headers: { accept, "accept-language": "en-US,en;q=0.9", "user-agent": userAgent },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "follow",
  })
  // Cloudflare bot challenges answer 403 with a marker header; retry with the plain agent.
  const challenged = response.status === 403 && response.headers.get("cf-mitigated") === "challenge"
  if (challenged) {
    await response.body?.cancel().catch(() => undefined)
    return { body: "", contentType: response.headers.get("content-type") ?? "", challenged: true }
  }
  if (!response.ok) {
    throw new ToolFailure(`Unable to fetch ${url} (HTTP ${response.status})`)
  }
  const contentType = response.headers.get("content-type") ?? ""
  if (contentType.startsWith("image/")) {
    throw new ToolFailure(`Unsupported fetched image content type: ${contentType}`)
  }
  const reader = response.body?.getReader()
  if (!reader) throw new ToolFailure(`Unable to fetch ${url}`)
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > MAX_FETCH_BYTES) {
      await reader.cancel().catch(() => undefined)
      throw new ToolFailure(`Response too large (exceeds ${MAX_FETCH_BYTES} byte limit)`)
    }
    chunks.push(value)
  }
  const body = Buffer.concat(chunks).toString("utf8")
  return { body, contentType, challenged: false }
}

function stripText(html: string): string {
  return html
    .replaceAll(/<script[\s\S]*?<\/script>/gi, "")
    .replaceAll(/<style[\s\S]*?<\/style>/gi, "")
    .replaceAll(/<noscript[\s\S]*?<\/noscript>/gi, "")
    .replaceAll(/<iframe[\s\S]*?<\/iframe>/gi, "")
    .replaceAll(/<object[\s\S]*?<\/object>/gi, "")
    .replaceAll(/<embed[\s\S]*?<\/embed>/gi, "")
    .replaceAll(/<br\s*\/?>/gi, "\n")
    .replaceAll(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replaceAll(/<[^>]+>/g, "")
    .replaceAll(/&nbsp;/g, " ")
    .replaceAll(/&amp;/g, "&")
    .replaceAll(/&lt;/g, "<")
    .replaceAll(/&gt;/g, ">")
    .replaceAll(/&quot;/g, '"')
    .replaceAll(/&#39;/g, "'")
    .replaceAll(/\n{3,}/g, "\n\n")
    .trim()
}

export const webfetchTool: ToolDefinition = {
  name: "webfetch",
  description:
    "Fetch content from an HTTP or HTTPS URL and return it as text, markdown, or HTML. Markdown is the default.\n\nUse a more targeted tool when one is available. This tool is read-only. Large text results may be replaced with a preview while the complete output is retained in managed storage.",
  inputSchema: z.object({
    url: z.string().describe("The HTTP or HTTPS URL to fetch content from"),
    format: z.enum(["text", "markdown", "html"]).default("markdown").describe("The format to return the content in. Defaults to markdown."),
    timeout: z.number().optional().describe("Optional timeout in seconds (maximum: 120)"),
  }),
  async execute(input: { url: string; format?: "text" | "markdown" | "html"; timeout?: number }, ctx: ToolContext) {
    let parsed: URL
    try {
      parsed = new URL(input.url)
    } catch {
      throw new ToolFailure(`Invalid URL: ${input.url}`)
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new ToolFailure("Only http:// and https:// URLs are supported.")
    }
    await ctx.permission({ action: "webfetch", resources: [input.url], save: ["*"] })
    const timeoutSeconds = Math.min(input.timeout && input.timeout > 0 ? input.timeout : 30, 120)
    const format = input.format ?? "markdown"
    const accept =
      format === "html" ? "text/html,application/xhtml+xml,*/*;q=0.8" : "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.8"
    let { body, contentType } = await fetchBounded(input.url, accept, timeoutSeconds * 1000)
    // Cloudflare challenge: retry once with the plain agent, mirroring upstream webfetch.
    if (!body) {
      const retry = await fetchBounded(input.url, accept, timeoutSeconds * 1000, "openorch")
      body = retry.body
      contentType = retry.contentType
    }
    const isHtml = contentType.includes("html") || body.trimStart().startsWith("<")
    let output = body
    if (format === "html") {
      output = body
    } else if (format === "text") {
      output = isHtml ? stripText(body) : body
    } else {
      if (isHtml) {
        const TurndownService = (await import("turndown")).default
        const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" })
        output = turndown.turndown(body)
      } else {
        output = body
      }
    }
    const truncated = output.length > 120_000
    const text = truncated ? `${output.slice(0, 120_000)}\n…(truncated)` : output
    return textOutput(text, { url: input.url, contentType, format, truncated })
  },
}

export const websearchTool: ToolDefinition = {
  name: "websearch",
  description: `Search the web using the user's selected search integration. Use this for current information beyond knowledge cutoff.

The current year is ${new Date().getFullYear()}. Use this year when searching for recent information or current events.`,
  inputSchema: z.object({
    query: z.string().describe("Websearch query"),
  }),
  async execute(input: { query: string }, ctx: ToolContext) {
    await ctx.permission({ action: "websearch", resources: [input.query], save: ["*"] })
    const outcome = await ctx.services.searchWeb(input.query)
    // Upstream returns the message as normal content so the model can retry.
    if (outcome.results.length === 0) {
      return textOutput("No search results found. Please try a different query.", { provider: outcome.provider, count: 0 })
    }
    const blocks = outcome.results
      .slice(0, 8)
      .map((result) => {
        const published = result.published ? `Published: ${result.published}\n\n` : ""
        return `## [${result.title}](${result.url})\n${published}${result.content ?? ""}`.trim()
      })
    return textOutput(blocks.join("\n\n"), { provider: outcome.provider, count: outcome.results.length })
  },
}
