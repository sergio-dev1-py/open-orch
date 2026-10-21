/**
 * Updates the bundled catalog with the live models.dev data (union merge: embedded
 * models are kept, live entries win per model). Run when preparing a release so the
 * offline baseline already includes new models and their real reasoning levels.
 *
 * Usage: bun run scripts/update-catalog.ts [url]
 */
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { convertModelsDev, mergeCatalogProviders, type CatalogProvider, type RawProvider } from "../packages/core/src/providers/models-dev.ts"

const OUT = path.join(import.meta.dir, "../packages/core/src/providers/catalog.json")
const url = process.argv[2] ?? "https://models.opencode.ai/api.json"

const response = await fetch(url, { signal: AbortSignal.timeout(60_000) })
if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`)
const live = convertModelsDev((await response.json()) as Record<string, RawProvider>)
const current = JSON.parse(readFileSync(OUT, "utf8")) as { providers: CatalogProvider[] }
const providers = mergeCatalogProviders(current.providers, live)
const catalog = {
  source: `models.dev live (${url}) + snapshot (via opencode, MIT)`,
  generatedAt: new Date().toISOString(),
  count: providers.length,
  providers,
}
writeFileSync(OUT, JSON.stringify(catalog))
console.log(`Wrote ${OUT}`)
console.log(`providers: ${providers.length}, models: ${providers.reduce((sum, provider) => sum + provider.models.length, 0)}`)
