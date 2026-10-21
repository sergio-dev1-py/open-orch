/**
 * Verifies the OpenCode Zen/Go gateway accepts our request-routing headers.
 * Uses an intentionally invalid key: without `x-opencode-session` the gateway
 * answers 400 MissingSessionID; with it, the error is an auth error instead.
 *
 * Usage: bun run scripts/check-zen.ts
 */
const BASE_URLS = ["https://opencode.ai/zen/go/v1", "https://opencode.ai/zen/v1"]
const MODELS: Record<string, string> = {
  "https://opencode.ai/zen/go/v1": "mimo-v2.6-pro",
  "https://opencode.ai/zen/v1": "claude-sonnet-4-5",
}

const results: { name: string; ok: boolean; detail?: string }[] = []
function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail })
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`)
}

const headers = {
  authorization: "Bearer not-a-real-key-for-openorch-check",
  "content-type": "application/json",
}

async function probe(url: string, extra: Record<string, string>): Promise<{ status: number; body: string }> {
  const response = await fetch(`${url}/chat/completions`, {
    method: "POST",
    headers: { ...headers, ...extra },
    body: JSON.stringify({ model: MODELS[url], messages: [{ role: "user", content: "hi" }], max_tokens: 8 }),
    signal: AbortSignal.timeout(25_000),
  })
  return { status: response.status, body: await response.text() }
}

for (const url of BASE_URLS) {
  try {
    const without = await probe(url, {})
    const withHeaders = await probe(url, {
      "x-opencode-session": "ses_openorch_check",
      "x-opencode-session-id": "ses_openorch_check",
      "x-session-affinity": "ses_openorch_check",
      "X-Session-Id": "ses_openorch_check",
      "x-opencode-client": "openorch",
      "user-agent": "openorch/0.1.0",
    })
    // The Go gateway rejects requests without the routing header (400 MissingSessionID).
    if (url.includes("/zen/go/")) {
      check(
        `${url} requires x-opencode-session`,
        without.status === 400 && without.body.includes("MissingSessionID"),
        `status=${without.status}`,
      )
    }
    check(
      `${url} accepts routing headers (no routing error)`,
      !(withHeaders.status === 400 && withHeaders.body.includes("MissingSessionID")),
      `status=${withHeaders.status} body=${withHeaders.body.slice(0, 80)}`,
    )
  } catch (error) {
    check(`${url} reachable`, false, error instanceof Error ? error.message : String(error))
  }
}

const failed = results.filter((entry) => !entry.ok)
console.log(`\n${results.length - failed.length}/${results.length} zen checks passed`)
if (failed.length > 0) process.exitCode = 1
