/**
 * Probes DuckDuckGo HTML search with different user agents, the way the
 * websearch tool calls it. Usage: bun run scripts/check-search.ts
 */
const UA_BROWSER =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
const UA_OPENORCH = "Mozilla/5.0 (compatible; OpenOrch/1.0; +https://github.com/openorch)"

async function probe(label: string, url: string, userAgent: string): Promise<number> {
  try {
    const response = await fetch(url, { headers: { "user-agent": userAgent }, signal: AbortSignal.timeout(20_000) })
    const html = await response.text()
    const regex = /<a[^>]*class="result__a"[^>]*href="([^"]+)"/g
    let count = 0
    while (regex.exec(html) && count < 20) count++
    console.log(`${label}: status=${response.status} bytes=${html.length} results=${count}`)
    return count
  } catch (error) {
    console.log(`${label}: ERROR ${error instanceof Error ? error.message : String(error)}`)
    return 0
  }
}

const browser = await probe("html+GET+browserUA", "https://html.duckduckgo.com/html/?q=opencode+agent", UA_BROWSER)
const plain = await probe("html+GET+openorchUA", "https://html.duckduckgo.com/html/?q=opencode+agent", UA_OPENORCH)
const lite = await probe("lite+GET+browserUA", "https://lite.duckduckgo.com/lite/?q=opencode+agent", UA_BROWSER)

console.log(browser > 0 ? "RESULT: browser UA works" : plain > 0 ? "RESULT: plain UA works" : lite > 0 ? "RESULT: lite works" : "RESULT: all failed")
