/**
 * Fast core-level checks (no Electron): skills discovery, reasoning replay,
 * compaction estimation, variant options and request headers.
 *
 * Usage: bun run scripts/check-core.ts
 */
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { spawn } from "node:child_process"
import path from "node:path"
import { parseChallenge, sensitiveLabel } from "../packages/core/src/tools/browser-challenge"

const root = path.resolve(import.meta.dir, "..")
const sandbox = path.join(root, ".data", "core-check")
rmSync(sandbox, { recursive: true, force: true })
mkdirSync(sandbox, { recursive: true })
// Sandbox the global OpenOrch folder so checks never touch the real home.
process.env.OPENORCH_CONFIG_DIR = path.join(sandbox, "config")
// Sandbox the user home too: compatibility roots (`~/.agents`, `~/.claude`, `~/.config/opencode`)
// are scanned now, and the checks must stay deterministic.
process.env.OPENORCH_HOME = path.join(sandbox, "home")

const results: { name: string; ok: boolean; detail?: string }[] = []
function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail })
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`)
}

// ---------------------------------------------------------------------------
// Skills: `*.md` flat files, `**/SKILL.md` folders and autoinvoke handling
// ---------------------------------------------------------------------------
const skillsDir = path.join(sandbox, ".opencode", "skills")
mkdirSync(path.join(skillsDir, "hidden-skill"), { recursive: true })
mkdirSync(path.join(skillsDir, "nested", "deep-skill"), { recursive: true })
writeFileSync(path.join(skillsDir, "flat.md"), `---\nname: Flat Skill\ndescription: Un skill plano\n---\n\nHaz cosas.\n`)
writeFileSync(
  path.join(skillsDir, "hidden-skill", "SKILL.md"),
  `---\nname: Hidden\ndescription: No autoinvoke\ndisable-model-invocation: true\n---\n\nSolo manual.\n`,
)
writeFileSync(
  path.join(skillsDir, "nested", "deep-skill", "SKILL.md"),
  `---\nname: Deep\ndescription: Anidado\nmetadata:\n  opencode/autoinvoke: false\n---\n\nAnidado.\n`,
)

const { discoverSkills, skillsInstructions, globalSkillsDirectory, installGlobalSkill, readSkillDraft, removeGlobalSkill, readSkillDetail, writeSkill } = await import(
  "../packages/core/src/skills.ts"
)
const skills = discoverSkills({ skills: { dirs: [] } } as never, sandbox).filter((skill) =>
  skill.directory.replaceAll("\\", "/").includes("/core-check/"),
)
check("skills: discovers flat *.md and nested **/SKILL.md", skills.length === 3, skills.map((skill) => skill.id).join(", "))
check("skills: id from basename for flat files", skills.some((skill) => skill.id === "flat"), "")
check("skills: id from folder for SKILL.md", skills.some((skill) => skill.id === "hidden-skill" && skill.id !== "SKILL"), "")
check("skills: disable-model-invocation sets autoinvoke=false", skills.find((skill) => skill.id === "hidden-skill")?.autoinvoke === false)
check("skills: metadata opencode/autoinvoke=false respected", skills.find((skill) => skill.id === "deep-skill")?.autoinvoke === false)

// Global OpenOrch folder + project `.openorch` (singular `skill/` included).
mkdirSync(path.join(globalSkillsDirectory(), "global-skill"), { recursive: true })
writeFileSync(path.join(globalSkillsDirectory(), "global-skill", "SKILL.md"), `---\nname: Global\ndescription: Skill global\n---\n\nHola.\n`)
mkdirSync(path.join(sandbox, ".openorch", "skill", "single-skill"), { recursive: true })
writeFileSync(path.join(sandbox, ".openorch", "skill", "single-skill", "SKILL.md"), `---\nname: Single\ndescription: singular dir\n---\n\nHola.\n`)
const allSkills = discoverSkills({ skills: { dirs: [] } } as never, sandbox)
check("skills: global OpenOrch folder is scanned with origin", allSkills.find((skill) => skill.id === "global-skill")?.origin === "global")
check("skills: project .openorch/skill (singular) is scanned", allSkills.find((skill) => skill.id === "single-skill")?.origin === "project")

// Compatibility roots: Claude Code, the `skills` CLI (`.agents`, where `npx skills add`
// installs) and a real opencode install — upstream scans all of them.
const homeDir = path.join(sandbox, "home")
const writeCompatSkill = (dir: string, id: string, description: string) => {
  mkdirSync(path.join(dir, id), { recursive: true })
  writeFileSync(path.join(dir, id, "SKILL.md"), `---\nname: ${id}\ndescription: ${description}\n---\n\nHola.\n`)
}
writeCompatSkill(path.join(homeDir, ".agents", "skills"), "agents-global", "compat agents")
writeCompatSkill(path.join(homeDir, ".claude", "skills"), "claude-global", "compat claude")
writeCompatSkill(path.join(homeDir, ".config", "opencode", "skills"), "opencode-global", "compat opencode")
writeCompatSkill(path.join(sandbox, ".agents", "skills"), "agents-project", "compat agents project")
const compatSkills = discoverSkills({ skills: { dirs: [] } } as never, sandbox)
check("skills: ~/.agents/skills (npx skills add -g) is scanned as global", compatSkills.find((skill) => skill.id === "agents-global")?.origin === "global")
check("skills: ~/.claude/skills is scanned as global", compatSkills.find((skill) => skill.id === "claude-global")?.origin === "global")
check("skills: ~/.config/opencode/skills is scanned as global", compatSkills.find((skill) => skill.id === "opencode-global")?.origin === "global")
check("skills: project .agents/skills is scanned as project", compatSkills.find((skill) => skill.id === "agents-project")?.origin === "project")

// Native directories win when two roots declare the same id.
writeCompatSkill(path.join(homeDir, ".agents", "skills"), "dup-skill", "compat copy")
writeCompatSkill(globalSkillsDirectory(), "dup-skill", "native copy")
const duplicate = discoverSkills({ skills: { dirs: [] } } as never, sandbox).find((skill) => skill.id === "dup-skill")
check("skills: native global wins over .agents on id collisions", duplicate?.description === "native copy", duplicate?.directory ?? "")

// Symlinked skill folders are followed (the `skills` CLI links by default).
let symlinkFollowed = false
try {
  const target = path.join(sandbox, "real-skills", "linked-skill")
  mkdirSync(target, { recursive: true })
  writeFileSync(path.join(target, "SKILL.md"), `---\nname: Linked\ndescription: symlinked skill\n---\n\nHola.\n`)
  symlinkSync(target, path.join(homeDir, ".agents", "skills", "linked-skill"), process.platform === "win32" ? "junction" : "dir")
  symlinkFollowed = discoverSkills({ skills: { dirs: [] } } as never, sandbox).some((skill) => skill.id === "linked-skill")
} catch (failure) {
  console.log(`(symlink setup failed: ${failure instanceof Error ? failure.message : failure})`)
}
check("skills: symlinked skill folders are followed", symlinkFollowed)

// Detail read + save (manager): content round-trip, frontmatter preservation, unknown ids rejected.
const editDirectory = path.join(homeDir, ".agents", "skills", "edit-skill")
mkdirSync(editDirectory, { recursive: true })
writeFileSync(
  path.join(editDirectory, "SKILL.md"),
  `---\nname: Edit\ndescription: original\nlicense: MIT\nmetadata:\n  opencode/autoinvoke: true\n---\n\nCuerpo original.\n`,
)
writeFileSync(path.join(editDirectory, "reference.txt"), "extra file\n")
const detail = readSkillDetail({ skills: { dirs: [] } } as never, sandbox, "edit-skill")
check(
  "skills: detail read returns body and extra files",
  detail?.content.includes("Cuerpo original") && detail?.description === "original" && (detail?.files.includes("reference.txt") ?? false),
  detail?.files.join(", ") ?? "missing",
)
const savedSkill = writeSkill({ skills: { dirs: [] } } as never, sandbox, {
  id: "edit-skill",
  name: "Edit",
  description: "actualizada",
  content: "# Nuevo\n\nCuerpo nuevo.",
})
check("skills: save updates the description", savedSkill.description === "actualizada")
const savedRaw = readFileSync(path.join(editDirectory, "SKILL.md"), "utf8")
check(
  "skills: save preserves other frontmatter keys",
  savedRaw.includes("license: MIT") && savedRaw.includes("opencode/autoinvoke") && savedRaw.includes("Cuerpo nuevo") && !savedRaw.includes("Cuerpo original"),
  savedRaw.split("\n").slice(0, 6).join(" | "),
)
let unknownRejected = false
try {
  writeSkill({ skills: { dirs: [] } } as never, sandbox, { id: "does-not-exist", content: "x" })
} catch {
  unknownRejected = true
}
check("skills: save rejects unknown ids", unknownRejected)

// Install/remove/import round-trip (used by `/skill`).
const installed = installGlobalSkill({ id: "demo-install", name: "Demo", description: "Instalada", content: "# Demo\n\nHola" })
check("skills: installGlobalSkill writes into the global folder", existsSync(path.join(installed.directory, "SKILL.md")) && installed.directory.startsWith(globalSkillsDirectory()))
const draft = readSkillDraft(installed.directory)
check("skills: readSkillDraft round-trips fields", draft?.name === "Demo" && draft?.description === "Instalada" && (draft?.content.includes("Hola") ?? false))
let invalidRejected = false
try {
  installGlobalSkill({ id: "bad/id", content: "x" })
} catch {
  invalidRejected = true
}
check("skills: invalid ids are rejected", invalidRejected)
removeGlobalSkill("demo-install")
check("skills: removeGlobalSkill deletes the folder", !existsSync(installed.directory))

const instructions = skillsInstructions(skills, sandbox)
check(
  "skills: only autoinvoke skills with description are advertised",
  instructions.includes("flat:") && !instructions.includes("hidden-skill") && !instructions.includes("deep-skill"),
)
check(
  "skills: instructions tell the model where skills live",
  instructions.includes(globalSkillsDirectory().replaceAll("\\", "/")) || instructions.includes(globalSkillsDirectory()),
)
check(
  "skills: instructions teach `npx skills add -g` and the .agents root",
  instructions.includes("npx skills add -g") && instructions.includes(".agents"),
)

// ---------------------------------------------------------------------------
// Reasoning replay: the same model keeps reasoning + metadata; other models
// keep the reasoning part (never downgraded to plain text).
// ---------------------------------------------------------------------------
const { toModelMessages } = await import("../packages/core/src/session/history.ts")
const assistant = {
  id: "msg_1",
  sessionID: "ses_1",
  role: "assistant" as const,
  agent: "build",
  model: { providerID: "anthropic", modelID: "claude-x" },
  content: [
    { type: "reasoning" as const, id: "p1", text: "pensamiento", providerMetadata: { anthropic: { signature: "sig" } } },
    { type: "text" as const, id: "p2", text: "respuesta" },
  ],
  time: { created: Date.now(), completed: Date.now() },
}
const sameModel = toModelMessages([assistant], { model: { providerID: "anthropic", modelID: "claude-x" } })
const otherModel = toModelMessages([assistant], { model: { providerID: "openai", modelID: "gpt-x" } })
const firstContent = (messages: typeof sameModel) => JSON.stringify(messages[0]?.content ?? [])
check("reasoning: replayed with provider metadata for the same model", firstContent(sameModel).includes("reasoning") && firstContent(sameModel).includes("signature"))
const otherParts = (otherModel[0]?.content ?? []) as { type: string; text?: string; providerOptions?: unknown }[]
check(
  "reasoning: other models keep the reasoning part without provider metadata",
  otherParts[0]?.type === "reasoning" && otherParts[0]?.text === "pensamiento" && otherParts[0]?.providerOptions === undefined,
  JSON.stringify(otherParts[0]),
)
check(
  "reasoning: never downgraded to plain assistant text after a model switch",
  !otherParts.some((part) => part.type === "text" && part.text === "pensamiento"),
)

// ---------------------------------------------------------------------------
// Variant options per family
// ---------------------------------------------------------------------------
const { variantOptions } = await import("../packages/core/src/providers/index.ts")
const deepseekHigh = variantOptions("deepseek", { id: "deepseek-v4", providerID: "deepseek", name: "x" }, "high")
check(
  "variants: deepseek effort enables thinking + reasoningEffort",
  JSON.stringify(deepseekHigh.providerOptions ?? {}).includes("reasoningEffort") &&
    JSON.stringify(deepseekHigh.providerOptions ?? {}).includes("enabled"),
)
const deepseekNone = variantOptions("deepseek", { id: "deepseek-v4", providerID: "deepseek", name: "x" }, "none")
check("variants: deepseek none disables thinking", JSON.stringify(deepseekNone.providerOptions ?? {}).includes("disabled"))
const compatNone = variantOptions("openai-compatible", { id: "glm", providerID: "zai", name: "glm" }, "none")
check("variants: compatible none sends thinking disabled", JSON.stringify(compatNone.providerOptions ?? {}).includes("disabled"))

// ---------------------------------------------------------------------------
// Model layer: variants come from the catalog only; discovered models from /models
// ---------------------------------------------------------------------------
const { Engine } = await import("../packages/core/src/index.ts")
const dataDir = path.join(sandbox, "userdata")
const workspace = path.join(sandbox, "workspace")
mkdirSync(workspace, { recursive: true })
mkdirSync(dataDir, { recursive: true })
// Provider config for the model-layer checks (no network calls are made here).
writeFileSync(
  path.join(dataDir, "config.json"),
  JSON.stringify({
    providers: {
      mock: { kind: "openai-compatible", baseURL: "http://127.0.0.1:9/v1", apiKey: "k", models: ["mock-model"], enabled: true },
      opencode: { apiKey: "k", baseURL: "http://127.0.0.1:9/v1", enabled: true },
    },
  }),
)
const collectedEvents: unknown[] = []
const engine = new Engine({
  dataDir,
  projectDirectory: workspace,
  emit: (event) => {
    collectedEvents.push(event)
  },
  log: () => undefined,
})
check("storage: sqlite driver active", engine.storage === "sqlite", engine.storage)

// Default model: cheapest available (free catalog models win).
const defaultRef = engine.defaultModelRef()
const defaultInfo = defaultRef ? engine.listModels().find((model) => model.providerID === defaultRef.providerID && model.id === defaultRef.modelID) : undefined
check(
  "models: default is the cheapest available model",
  Boolean(defaultInfo && (defaultInfo.cost?.input ?? Number.POSITIVE_INFINITY) === 0),
  defaultRef ? `${defaultRef.providerID}/${defaultRef.modelID} cost=${defaultInfo?.cost?.input}` : "none",
)

const session = engine.createSession({ directory: workspace })
check("models: new session starts from the cheap default", session.model?.modelID === defaultRef?.modelID, session.model?.modelID)

// Variants come exclusively from the catalog (no inference).
const { variantIds } = await import("../packages/core/src/providers/index.ts")
const mimoBase = { id: "mimo-v2.6-flash", name: "MiMo", reasoning: true, reasoningOptions: [] }
check("variants: reasoning models without catalog options offer none", variantIds(mimoBase as never).length === 0)
const gptWithOptions = { id: "gpt-5.4", name: "GPT", reasoning: true, reasoningOptions: [{ type: "effort", values: ["low", "high"] }] }
check(
  "variants: catalog options are used verbatim",
  variantIds(gptWithOptions as never).join(",") === "low,high",
  variantIds(gptWithOptions as never).join(","),
)

// The catalog must expose the free models the user expects in the picker.
const { listProviders, listModels } = await import("../packages/core/src/providers/index.ts")
const catalogConfig = { providers: { opencode: { apiKey: "k", enabled: true } } }
const zenModels = listModels(catalogConfig as never).map((model) => model.id)
check("models: free catalog models are listed", zenModels.includes("longcat-2.5-preview-free"), `${zenModels.length} models`)

// Per-directory / recent model memory.
const otherDirectory = path.join(sandbox, "other-project")
mkdirSync(otherDirectory, { recursive: true })
engine.setSessionModel(session.id, { providerID: "opencode", modelID: "gpt-5.4", variant: "high" })
const afterFirst = engine.defaultModelRef(workspace)
check(
  "models: per-directory memory restores model + variant",
  afterFirst?.modelID === "gpt-5.4" && afterFirst?.variant === "high",
  `${afterFirst?.providerID}/${afterFirst?.modelID}#${afterFirst?.variant}`,
)
const other = engine.createSession({ directory: otherDirectory })
engine.setSessionModel(other.id, { providerID: "opencode", modelID: "groK-4.7".toLowerCase() })
const recentRef = engine.defaultModelRef(workspace)
check("models: directory memory wins over recents", recentRef?.modelID === "gpt-5.4", recentRef?.modelID)
const freshDirectory = path.join(sandbox, "fresh")
mkdirSync(freshDirectory, { recursive: true })
const freshRef = engine.defaultModelRef(freshDirectory)
check("models: unknown directory falls back to the most recent model", freshRef?.modelID === "grok-4.7", freshRef?.modelID)

// Removed model: the session switches to an available model with a notice.
engine.setSessionModel(session.id, { providerID: "opencode", modelID: "gpt-5.4", variant: "high" })
await engine.setConfig({ providers: { opencode: { enabled: false } } })
const resolved = (engine as unknown as { resolveModel: (info: unknown) => unknown }).resolveModel(engine.store.get(session.id)!.info)
const updated = engine.store.get(session.id)!
check("models: removed model falls back to an available one", resolved !== undefined && updated.info.model?.providerID !== "opencode", `${updated.info.model?.providerID}/${updated.info.model?.modelID}`)
check(
  "models: fallback leaves a visible notice",
  updated.messages.some((message) => message.role === "synthetic" && message.text.includes("ya no está disponible")),
)

// @ts-expect-error private helper under test
const headers = engine.requestHeaders(session)
check(
  "headers: zen/go routing header uses the session id",
  headers["x-opencode-session"] === session.id && headers["x-opencode-session-id"] === session.id,
  headers["x-opencode-session"],
)

const record = engine.store.get(session.id)!
record.messages.push({
  id: "msg_a",
  sessionID: session.id,
  role: "assistant",
  agent: "build",
  model: { providerID: "mock", modelID: "mock-model" },
  content: [{ type: "text", id: "p", text: "hola" }],
  time: { created: Date.now(), completed: Date.now() },
  tokens: { input: 5_000, output: 200 },
})
engine.store.save(session.id)
const measured = engine.estimateSessionTokens(session.id, { id: "mock-model", providerID: "mock", name: "mock" })
check("compaction: measured anchor drives the estimate", measured >= 5_200 && measured < 8_000, `${measured} tokens`)

const child = engine.createSession({ directory: workspace, agent: "explore", parentID: session.id })
check("subagents: child inherits parent affinity headers", headers["x-opencode-session"] !== undefined && child.parentID === session.id)
// @ts-expect-error private helper under test
const childHeaders = engine.requestHeaders(child)
check("subagents: child sends parent session headers", childHeaders["x-opencode-session"] === session.id, childHeaders["x-opencode-session"])

// ---------------------------------------------------------------------------
// File index (`@` mentions) + disconnect + /models discovery
// ---------------------------------------------------------------------------
mkdirSync(path.join(workspace, ".git"), { recursive: true })
mkdirSync(path.join(workspace, "node_modules", "pkg"), { recursive: true })
mkdirSync(path.join(workspace, ".openorch"), { recursive: true })
mkdirSync(path.join(workspace, "src"), { recursive: true })
writeFileSync(path.join(workspace, "src", "index.ts"), "export const a = 1\n")
writeFileSync(path.join(workspace, "README.md"), "# demo\n")
writeFileSync(path.join(workspace, ".git", "config"), "[core]\n")
writeFileSync(path.join(workspace, "node_modules", "pkg", "index.js"), "module.exports = 1\n")
writeFileSync(path.join(workspace, ".openorch", "secret.txt"), "hidden\n")

const indexed = await engine.indexFiles(session.id)
check(
  "files: index lists project files",
  indexed.includes("src/index.ts") && indexed.includes("README.md"),
  `${indexed.length} files`,
)
check(
  "files: index ignores .git, node_modules and .openorch",
  !indexed.some((file) => file.startsWith(".git/") || file.startsWith("node_modules/") || file.startsWith(".openorch/")),
)
const searchResult = await engine.searchFiles(session.id, "index", 5)
check("files: search filters by name", searchResult.includes("src/index.ts"), searchResult.join(", "))
const bounded = await engine.searchFiles(session.id, "", 3)
check("files: search respects the limit", bounded.length <= 3, `${bounded.length}`)

// Disconnect removes the stored credential.
await engine.setConfig({ providers: { opencode: { apiKey: "secret-key", enabled: true } } })
check("providers: configured before disconnect", engine.listProviders().find((p) => p.id === "opencode")?.configured === true)
engine.disconnectProvider("opencode")
check("providers: disconnect clears the credential", engine.listProviders().find((p) => p.id === "opencode")?.configured === false)

// `/models` discovery against a local server.
const modelsServer = Bun.serve({
  port: 0,
  fetch() {
    return Response.json({ data: [{ id: "gpt-5.4" }, { id: "brand-new-model" }, { id: "another-new" }] })
  },
})
await engine.setConfig({
  providers: { opencode: { apiKey: "k", baseURL: `http://127.0.0.1:${modelsServer.port}/v1`, enabled: true } },
})
const refresh = await engine.refreshProviderModels("opencode")
modelsServer.stop(true)
check("models: /models refresh discovers new models", refresh.ok && refresh.added >= 2, `added=${refresh.added} total=${refresh.total}`)
const discovered = engine.listModels().find((model) => model.id === "brand-new-model")
check("models: discovered models appear in the list", Boolean(discovered?.discovered))

// ---------------------------------------------------------------------------
// Variant overlays per family (compatible gateways) + shell robustness
// ---------------------------------------------------------------------------
const { runShell } = await import("../packages/core/src/tools/shell.ts")
const gptNone = variantOptions("openai-compatible", { id: "gpt-5.6-luna", providerID: "opencode-go", name: "Luna", family: "gpt-luna" }, "none")
check(
  "variants: gpt-family compatible models use flat reasoningEffort (fixes Luna)",
  JSON.stringify(gptNone.providerOptions ?? {}).includes("reasoningEffort") && !JSON.stringify(gptNone.providerOptions ?? {}).includes("thinking"),
  JSON.stringify(gptNone.providerOptions),
)
const glmNone = variantOptions("openai-compatible", { id: "glm-5.3-flash", providerID: "opencode-go", name: "GLM", family: "glm" }, "none")
check("variants: glm family uses thinking toggle", JSON.stringify(glmNone.providerOptions ?? {}).includes("disabled"))
const kimiHigh = variantOptions("openai-compatible", { id: "kimi-k3", providerID: "opencode-go", name: "Kimi", family: "kimi" }, "high")
check("variants: kimi family enables thinking", JSON.stringify(kimiHigh.providerOptions ?? {}).includes("enableThinking"))

const shellSandbox = path.join(sandbox, "shell")
mkdirSync(shellSandbox, { recursive: true })
writeFileSync(path.join(shellSandbox, "hello.txt"), "hola\n")
const quick = await runShell({
  command: process.platform === "win32" ? "echo hola" : "echo hola",
  workdir: shellSandbox,
  timeoutMs: 10_000,
  background: false,
  sessionID: "ses_shell_check",
  dataDir: path.join(sandbox, "data"),
})
check("shell: normal command returns output", quick.output.includes("hola") && !quick.timeout, quick.output.trim().slice(0, 40))

const grandchildStart = Date.now()
const grandchild = await runShell({
  // `start` returns immediately; the orphan keeps running (the user's exact case).
  command:
    process.platform === "win32"
      ? 'start "" /b cmd /c "node -e "setInterval(()=>{},1000)" >nul 2>&1"'
      : "sleep 30 >/dev/null 2>&1 &",
  workdir: shellSandbox,
  timeoutMs: 10_000,
  background: false,
  sessionID: "ses_shell_check",
  dataDir: path.join(sandbox, "data"),
})
check(
  "shell: orphan grandchild resolves fast instead of hanging",
  grandchild.timeout === false && Date.now() - grandchildStart < 6_000,
  `${Date.now() - grandchildStart}ms`,
)

const longRunStart = Date.now()
const longRun = await runShell({
  command: process.platform === "win32" ? 'node -e "setInterval(()=>{},1000)"' : "sleep 30",
  workdir: shellSandbox,
  timeoutMs: 3_000,
  background: false,
  sessionID: "ses_shell_check",
  dataDir: path.join(sandbox, "data"),
})
check(
  "shell: long-running command times out and is killed",
  longRun.timeout === true && Date.now() - longRunStart < 10_000,
  `timeout=${longRun.timeout} in ${Date.now() - longRunStart}ms`,
)

// ---------------------------------------------------------------------------
// Subagent model: parent's model with a minimal thinking level
// ---------------------------------------------------------------------------
const { minimalVariant } = await import("../packages/core/src/providers/index.ts")
const gptModel = { id: "gpt-5.4", providerID: "opencode", name: "GPT", variants: ["none", "low", "medium", "high", "xhigh"] }
const lowOnly = { id: "x", providerID: "p", name: "X", variants: ["low", "high"] }
const noVariants = { id: "y", providerID: "p", name: "Y", variants: [] as string[] }
check("subagent variant: prefers none", minimalVariant(gptModel as never) === "none")
check("subagent variant: falls back to low when none is unavailable", minimalVariant(lowOnly as never) === "low")
check("subagent variant: models without variants get none", minimalVariant(noVariants as never) === undefined)

// Engine decision: the parent keeps its variant, the subagent gets the minimal one.
await engine.setConfig({ providers: { opencode: { apiKey: "k", enabled: true } } })
const parentSession = engine.createSession({ directory: workspace, model: { providerID: "opencode", modelID: "gpt-5.4", variant: "high" } })
const parentInfo = engine.store.get(parentSession.id)!.info
check("subagent model: the parent keeps its chosen variant", parentInfo.model?.variant === "high", parentInfo.model?.variant ?? "none")
// @ts-expect-error private helper under test
const childRef = engine.subagentModel(parentInfo, undefined, engine.agents.resolve("explore"), false)
check(
  "subagent model: same model as the parent with the minimal variant",
  childRef?.providerID === "opencode" && childRef?.modelID === "gpt-5.4" && childRef?.variant === "none",
  `${childRef?.providerID}/${childRef?.modelID}#${childRef?.variant}`,
)
// @ts-expect-error private helper under test
const inheritRef = engine.subagentModel(parentInfo, undefined, engine.agents.resolve("explore"), false)
await engine.setConfig({ experimental: { subagentVariant: "inherit" } })
// @ts-expect-error private helper under test
const inheritMode = engine.subagentModel(parentInfo, undefined, engine.agents.resolve("explore"), false)
check("subagent model: inherit mode keeps the parent's variant", inheritMode?.variant === "high", inheritMode?.variant ?? "none")
await engine.setConfig({ experimental: { subagentVariant: "minimal" } })
// @ts-expect-error private helper under test
const explicit = engine.subagentModel(parentInfo, { providerID: "opencode", modelID: "gpt-5.4", variant: "max" }, engine.agents.resolve("explore"), true)
check("subagent model: an explicit override variant is respected", explicit?.variant === "max", explicit?.variant ?? "none")
void inheritRef
await engine.setConfig({ experimental: { subagentModel: { providerID: "opencode", modelID: "gpt-5.4" } } })
// @ts-expect-error private helper under test
const configuredModel = engine.subagentModel(parentInfo, undefined, engine.agents.resolve("explore"), false)
check(
  "subagent model: the global subagent model wins over the parent",
  configuredModel?.providerID === "opencode" && configuredModel?.modelID === "gpt-5.4" && configuredModel?.variant === "none",
  `${configuredModel?.providerID}/${configuredModel?.modelID}#${configuredModel?.variant}`,
)
const explicitStillWins = engine.subagentModel(
  parentInfo,
  { providerID: "opencode", modelID: "gpt-5.4", variant: "max" },
  engine.agents.resolve("explore"),
  true,
)
check("subagent model: an explicit call model still wins", explicitStillWins?.variant === "max", explicitStillWins?.variant ?? "none")
await engine.setConfig({ experimental: { subagentModel: null } })

// ---------------------------------------------------------------------------
// External directories: reads outside the session ask (upstream parity)
// ---------------------------------------------------------------------------
{
  const outsideDir = path.join(sandbox, "outside")
  mkdirSync(outsideDir, { recursive: true })
  const asks = () =>
    collectedEvents.filter(
      (event): event is { type: "permission.asked"; request: { id: string; action: string; resources: string[] } } =>
        (event as { type?: string }).type === "permission.asked",
    )
  const buildAgent = engine.agents.resolve("build")
  const before = asks().length
  const pending = engine.permissions.assert(
    {
      sessionID: session.id,
      action: "external_directory",
      resources: [path.join(outsideDir, "*")],
      save: [path.join(outsideDir, "*")],
    },
    buildAgent,
    workspace,
  )
  await new Promise((resolve) => setTimeout(resolve, 60))
  const ask = asks().at(-1)
  check(
    "permissions: external directories ask before access",
    asks().length === before + 1 && ask?.request.action === "external_directory",
    ask?.request.resources.join(",") ?? "no ask",
  )
  engine.replyPermission(ask!.request.id, "always")
  await pending
  await engine.permissions.assert(
    {
      sessionID: session.id,
      action: "external_directory",
      resources: [path.join(outsideDir, "*")],
      save: [path.join(outsideDir, "*")],
    },
    buildAgent,
    workspace,
  )
  check("permissions: 'always' remembers the external directory itself", asks().length === before + 1)
  const managedBefore = asks().length
  await engine.permissions.assert(
    { sessionID: session.id, action: "external_directory", resources: [path.join(dataDir, "*")], save: [] },
    buildAgent,
    workspace,
  )
  check("permissions: managed folders (app data) never ask", asks().length === managedBefore)
}

// ---------------------------------------------------------------------------
// Plan/Build reminders: created with the session, appended on switch, reconciled
// ---------------------------------------------------------------------------
{
  const planSession = engine.createSession({ directory: workspace, agent: "plan" })
  const planMessages = () => engine.store.get(planSession.id)!.messages
  const reminderCount = () => planMessages().filter((message) => message.role === "synthetic" && message.metadata?.source === "plan").length
  check(
    "plan mode: a session created in plan carries the enter reminder",
    planMessages().at(-1)?.role === "synthetic" && (planMessages().at(-1) as { text?: string }).text?.includes("You are in Plan mode") === true,
  )
  // @ts-expect-error private helper under test
  engine.reconcilePlanMode(planSession.id, engine.agents.resolve("plan"))
  check("plan mode: reconcile does not duplicate the reminder", reminderCount() === 1, `${reminderCount()} reminders`)
  // Simulate compaction stripping the reminder while the agent stays put.
  planMessages().splice(0, planMessages().length, ...planMessages().filter((message) => !(message.role === "synthetic" && message.metadata?.source === "plan")))
  // @ts-expect-error private helper under test
  engine.reconcilePlanMode(planSession.id, engine.agents.resolve("plan"))
  check(
    "plan mode: reconcile re-injects the reminder after compaction",
    planMessages().some((message) => message.role === "synthetic" && (message as { text?: string }).text?.includes("You are in Plan mode") === true),
  )
  // Stale enter reminder while the session is build → the leave reminder wins.
  engine.setSessionAgent(planSession.id, "plan")
  engine.store.get(planSession.id)!.info.agent = "build"
  // @ts-expect-error private helper under test
  engine.reconcilePlanMode(planSession.id, engine.agents.resolve("build"))
  const last = planMessages().at(-1) as { text?: string }
  check("plan mode: a stale enter reminder is replaced before the request", last?.text?.includes("NO LONGER in Plan mode") === true)
}

// ---------------------------------------------------------------------------
// Workspaces: recent directories are remembered for the picker
// ---------------------------------------------------------------------------
{
  const recents = engine.getConfig().recentDirectories ?? []
  check(
    "workspaces: recent directories are remembered (most recent first)",
    recents.includes(workspace) && recents.includes(otherDirectory) && recents[0] === workspace,
    recents.join(" | ").slice(0, 120),
  )
}

// ---------------------------------------------------------------------------
// Web search parsers (DDG HTML + Bing RSS fallback)
// ---------------------------------------------------------------------------
{
  const { parseDuckDuckGo, parseBingRss } = await import("../packages/core/src/websearch.ts")
  const ddgHtml =
    `<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fone&rut=x">Example <b>One</b></a>` +
    `<a class="result__snippet" href="https://example.com/one">Snippet &amp; one</a>` +
    `<a class="result__a" href="https://example.org/two">Two</a>`
  const ddg = parseDuckDuckGo(ddgHtml)
  check(
    "websearch: DDG parser decodes redirects, titles and snippets",
    ddg.length === 2 && ddg[0].url === "https://example.com/one" && ddg[0].title === "Example One" && ddg[0].content === "Snippet & one",
    JSON.stringify(ddg[0]),
  )
  const rss =
    `<rss><channel><item><title>Bing One</title><link>https://example.net/a</link><description>Desc &amp; more</description></item>` +
    `<item><title><![CDATA[Bing Two]]></title><link>https://example.net/b</link></item></channel></rss>`
  const bing = parseBingRss(rss)
  check(
    "websearch: Bing RSS parser reads items and CDATA titles",
    bing.length === 2 && bing[0].url === "https://example.net/a" && bing[0].content === "Desc & more" && bing[1].title === "Bing Two",
    JSON.stringify(bing),
  )
}

// ---------------------------------------------------------------------------
// Plan directory + shell detection + gateway retry classification
// ---------------------------------------------------------------------------
{
  const { PLAN_DIRECTORY: planDir, planEnterReminder: enterReminder } = await import("../packages/core/src/agents/index.js")
  check(
    "plan mode: plan files live in the OpenOrch directory (~/.openorch/plan)",
    planDir.replaceAll("\\", "/").endsWith("/.openorch/plan") && enterReminder().includes(planDir),
    planDir,
  )
  const { availableShells, resolveShell, shellRunArgs, defaultShellID } = await import("../packages/core/src/tools/shell.ts")
  const shells = availableShells()
  check("shells: at least one shell is detected", shells.length >= 1, shells.map((shell) => shell.id).join(", "))
  check(
    "shells: the platform default resolves",
    resolveShell(defaultShellID()).id === defaultShellID(),
    resolveShell(undefined).name,
  )
  check("shells: unknown ids fall back to the default", resolveShell("nope").id === defaultShellID())
  if (process.platform === "win32") {
    check("shells: cmd is always available on Windows", shells.some((shell) => shell.id === "cmd"))
    const cmd = resolveShell("cmd")
    check("shells: cmd one-shot args use /c", shellRunArgs(cmd, "echo hola").includes("/c"), shellRunArgs(cmd, "echo hola").join(" "))
    const ps = shells.find((shell) => shell.id === "powershell")
    if (ps) {
      const args = shellRunArgs(ps, "echo hola")
      check("shells: powershell one-shot args use -Command", args.includes("-Command") && args.includes("-NoProfile"), args.join(" "))
    }
  }
  const { isRetryable } = await import("../packages/core/src/engine.js")
  check("retry: 'Endpoint is unavailable' is retryable", isRetryable("Upstream request failed: Endpoint is unavailable."))
  check("retry: 'HTTP 504' is retryable", isRetryable("Web search failed HTTP 504"))
  check("retry: 'subscription is required' is NOT retryable", !isRetryable("An active OpenCode Go subscription is required to use Go models."))
  check("retry: rate limits are retryable", isRetryable("rate limit exceeded"))
  const { stepLimitReached, modelListFallbacks } = await import("../packages/core/src/engine.ts")
  check("steps: a configured agent limit stops the run", stepLimitReached({ steps: 2 }, 2) === true && stepLimitReached({ steps: 2 }, 1) === false)
  check(
    "steps: the safety cap also stops with the wrap-up step",
    stepLimitReached({}, 498) === false && stepLimitReached({}, 499) === true,
  )
  check(
    "refresh: opencode-go falls back to the legacy zen models endpoint",
    modelListFallbacks("opencode-go", "https://opencode.ai/inference/go/openai/v1").includes("https://opencode.ai/zen/go/v1/models"),
  )
  check(
    "refresh: opencode falls back to the legacy zen models endpoint",
    modelListFallbacks("opencode", "https://opencode.ai/inference/openai/v1").includes("https://opencode.ai/zen/v1/models"),
  )
  check("refresh: custom providers get no fallback", modelListFallbacks("mi-proveedor", "https://api.example.com/v1").length === 0)
}

// ---------------------------------------------------------------------------
// Live models.dev catalog: conversion, merge, cache and engine refresh
// ---------------------------------------------------------------------------
{
  const { convertModelsDev, mergeCatalogProviders, loadCatalogCache, fetchModelsCatalog } = await import(
    "../packages/core/src/providers/models-dev.ts"
  )
  const fixture = {
    mock: {
      id: "mock",
      name: "Mock",
      npm: "@ai-sdk/openai-compatible",
      api: "http://127.0.0.1:9/v1",
      models: {
        "beam-free": {
          id: "beam-free",
          name: "beam free",
          family: "beam",
          reasoning: true,
          reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
          tool_call: true,
        },
      },
    },
  }
  const converted = convertModelsDev(fixture as never)
  check(
    "catalog: conversion keeps real reasoning options",
    converted.length === 1 && converted[0]?.models[0]?.reasoningOptions?.[0]?.values?.join(",") === "low,medium,high,xhigh,max",
    JSON.stringify(converted[0]?.models[0]?.reasoningOptions),
  )
  const mergedFixture = mergeCatalogProviders(
    [{ id: "mock", name: "Mock", kind: "openai-compatible", models: [{ id: "old-model", name: "Old" }] }],
    converted,
  )
  check(
    "catalog: live data merges per model without dropping embedded ones",
    mergedFixture[0]?.models.map((model) => model.id).join(",") === "old-model,beam-free",
    mergedFixture[0]?.models.map((model) => model.id).join(","),
  )
  const dataUrl = `data:application/json;base64,${Buffer.from(JSON.stringify(fixture)).toString("base64")}`
  const fetchedCatalog = await fetchModelsCatalog({ dataDir: sandbox, url: dataUrl })
  check(
    "catalog: live fetch converts and caches the catalog",
    fetchedCatalog.ok === true && (loadCatalogCache(sandbox)?.providers.length ?? 0) === 1,
    fetchedCatalog.ok ? `${fetchedCatalog.models} models` : fetchedCatalog.error,
  )
  process.env.OPENORCH_MODELS_URL = dataUrl
  const refreshed = await engine.refreshModelsCatalog()
  check(
    "catalog: engine refresh applies live models",
    refreshed.ok === true && engine.catalogStatus().source === "live",
    engine.catalogStatus().source,
  )
  check(
    "catalog: live model shows up in listModels with its variants",
    engine.listModels().some((model) => model.id === "beam-free" && (model.variants ?? []).join(",") === "low,medium,high,xhigh,max"),
  )

  // Console account config: only the account's active models are listed.
  const { fetchConsoleConfig, loadConsoleConfig } = await import("../packages/core/src/providers/console-config.ts")
  const consoleFixture = {
    providers: {
      mock: {
        name: "Mock",
        models: {
          "new-model": { name: "New Model", family: "beam" },
          "old-model": { disabled: true },
          "alias-model": { modelID: "new-model" },
        },
      },
    },
  }
  const consoleUrl = `data:application/json;base64,${Buffer.from(JSON.stringify(consoleFixture)).toString("base64")}`
  const fetchedConsole = await fetchConsoleConfig({ dataDir: sandbox, apiKey: "k", url: consoleUrl })
  check(
    "console: account config downloads and caches",
    fetchedConsole.ok === true && loadConsoleConfig(sandbox)?.providers.mock?.models?.["new-model"] !== undefined,
    fetchedConsole.ok ? "ok" : fetchedConsole.error,
  )
  const { setConsoleAccount } = await import("../packages/core/src/providers/index.ts")
  setConsoleAccount(fetchedConsole.ok ? fetchedConsole.config : undefined)
  const consoleIds = engine
    .listModels()
    .filter((model) => model.providerID === "mock")
    .map((model) => model.id)
    .sort()
  check("console: only active models are listed (disabled/unlisted hidden)", consoleIds.join(",") === "new-model", consoleIds.join(","))
  setConsoleAccount(undefined)
  const restoredIds = engine.listModels().filter((model) => model.providerID === "mock").map((model) => model.id)
  check("console: clearing the account config restores the catalog", restoredIds.includes("beam-free"), restoredIds.join(","))
  await engine.setConfig({ providers: { "opencode-go": { apiKey: "k", enabled: true } } })
  setConsoleAccount({ providers: { "opencode-go": { models: {} } } } as never)
  const emptyAccountModels = engine.listModels().filter((model) => model.providerID === "opencode-go")
  check(
    "console: an empty active list does not hide the provider catalog",
    emptyAccountModels.length > 0,
    `${emptyAccountModels.length} models`,
  )
  setConsoleAccount(undefined)
}

await engine.shutdown()

// ---------------------------------------------------------------------------
// MCP: probe (env/timeout), project merge, OAuth (needs-auth → sign in) and resources
// ---------------------------------------------------------------------------
{
  const { McpManager, mergeMcpServers } = await import("../packages/core/src/mcp.ts")
  const authDir = path.join(sandbox, "mcp-auth")
  mkdirSync(authDir, { recursive: true })
  const manager = new McpManager({ dataDir: authDir }, () => undefined)
  const stdioCommand = ["bun", "run", path.join(root, "scripts", "mock-mcp.ts")]

  const probe = await manager.probe({ type: "local", command: stdioCommand })
  check("mcp: probe connects and lists tools", probe.ok && probe.tools.includes("echo"), probe.error ?? probe.tools.join(", "))

  const envProbe = await manager.probe({ type: "local", command: stdioCommand, environment: { MOCK_ENV: "xyz" } })
  check("mcp: environment variables reach the server", envProbe.ok && envProbe.tools.includes("env_xyz"), envProbe.tools.join(", "))

  const slow = await manager.probe({ type: "local", command: stdioCommand, environment: { MOCK_DELAY: "5000" }, timeout: 500 })
  check("mcp: a per-server timeout fails fast instead of hanging", !slow.ok, (slow.error ?? "").slice(0, 70))

  const broken = await manager.probe({ type: "local", command: ["definitely-not-a-command-xyz"] })
  check("mcp: probe reports connection errors", !broken.ok && Boolean(broken.error), (broken.error ?? "").slice(0, 70))

  const merged = mergeMcpServers(
    { globalone: { type: "local", command: ["x"] }, shared: { type: "local", command: ["global"] } },
    [{ projectone: { type: "local", command: ["y"] } }, { shared: { type: "local", command: ["native"] } }],
  )
  check(
    "mcp: project files merge over global entries (native wins)",
    merged.globalone?.scope === "global" &&
      merged.projectone?.scope === "project" &&
      merged.shared?.scope === "project" &&
      merged.shared?.config.command?.[0] === "native",
    Object.entries(merged)
      .map(([name, entry]) => `${name}:${entry.scope}`)
      .join(", "),
  )

  // Remote OAuth: 401 → needs-auth → sign in (auto-confirm test hook) → connected.
  const remotePort = 8796
  const remote = spawn("bun", ["run", path.join(root, "scripts", "mock-mcp-remote.ts"), String(remotePort)], {
    cwd: root,
    stdio: "ignore",
    shell: true,
  })
  await new Promise((resolve) => setTimeout(resolve, 1200))
  try {
    const url = `http://127.0.0.1:${remotePort}/mcp`
    manager.updateServers({ remoteone: { config: { type: "remote", url }, scope: "global" } })
    await manager.connectAll()
    const before = manager.status().find((entry) => entry.name === "remoteone")
    check("mcp: a 401 remote server becomes needs-auth (not an error)", before?.status === "needs-auth", before?.status ?? "missing")

    process.env.OPENORCH_MCP_AUTH_AUTO = "1"
    const authenticated = await manager.authenticate("remoteone")
    check(
      "mcp: OAuth sign-in connects and registers the tools",
      authenticated?.status === "connected" && (authenticated?.toolNames ?? []).includes("echo"),
      authenticated?.status ?? "missing",
    )
    check("mcp: tokens are stored in mcp-auth.json", existsSync(path.join(authDir, "mcp-auth.json")))

    const resources = await manager.listResources("remoteone")
    check(
      "mcp: resources are listed",
      resources.some((group) => group.resources.some((resource) => resource.uri === "mock://readme")),
      JSON.stringify(resources).slice(0, 80),
    )
    const content = await manager.readResource("remoteone", "mock://readme")
    check("mcp: resources are readable", JSON.stringify(content).includes("MOCK-RESOURCE-OK"), JSON.stringify(content).slice(0, 60))

    await manager.logout("remoteone")
    const after = manager.status().find((entry) => entry.name === "remoteone")
    check("mcp: logout clears the tokens (needs-auth again)", after?.status === "needs-auth", after?.status ?? "missing")
    delete process.env.OPENORCH_MCP_AUTH_AUTO
  } finally {
    remote.kill()
  }

  // Reusing an unchanged MCP entry must not spawn another npx/Node process.
  const spawnLog = path.join(sandbox, "mcp-reuse-spawns.log")
  writeFileSync(spawnLog, "")
  const localEntries = {
    reuse: {
      config: {
        type: "local" as const,
        command: stdioCommand,
        environment: { OPENORCH_MCP_SPAWN_LOG: spawnLog },
      },
      scope: "global" as const,
    },
  }
  const spawned = () => readFileSync(spawnLog, "utf8").split(/\r?\n/).filter(Boolean).length
  manager.updateServers(localEntries)
  await manager.connectAll()
  const firstSpawn = spawned()
  await manager.sync(localEntries)
  const afterUnchanged = spawned()
  const changedEntries = {
    reuse: {
      config: {
        ...localEntries.reuse.config,
        environment: { OPENORCH_MCP_SPAWN_LOG: spawnLog, MOCK_ENV: "reused" },
      },
      scope: "global" as const,
    },
  }
  await manager.sync(changedEntries)
  const afterChanged = spawned()
  check(
    "mcp: an unchanged server is reused instead of respawned",
    firstSpawn === 1 && afterUnchanged === 1 && afterChanged === 2,
    `spawns=${firstSpawn}/${afterUnchanged}/${afterChanged}`,
  )
  await manager.closeAll()
}

{
  const { mcpTool } = await import("../packages/core/src/tools/mcp.ts")
  const stubServices = {
    mcp: {
      status: () => [] as never[],
      get: () => undefined,
      add: async (name: string) => ({ name, status: "connected", tools: 1, toolNames: ["echo"], scope: "global" }),
      remove: async () => undefined,
      test: async () => ({ ok: true, tools: ["echo"] }),
      listResources: async () => [],
      readResource: async () => [],
    },
  }
  const runTool = async (input: unknown): Promise<{ ok: boolean; text: string }> => {
    try {
      const result = (await (mcpTool.execute as (input: unknown, ctx: unknown) => Promise<{ content: { text?: string }[] }>)(input, {
        permission: async () => undefined,
        services: stubServices,
      })) as { content: { text?: string }[] }
      return { ok: true, text: result.content.map((item) => item.text ?? "").join(" ") }
    } catch (error) {
      return { ok: false, text: error instanceof Error ? error.message : String(error) }
    }
  }
  const missingName = await runTool({ action: "add", type: "local", command: "bun run x" })
  check("mcp tool: add requires a name", !missingName.ok && /name/i.test(missingName.text), missingName.text.slice(0, 70))
  const missingCommand = await runTool({ action: "add", name: "x", type: "local" })
  check("mcp tool: a local server requires a command", !missingCommand.ok && /command/i.test(missingCommand.text), missingCommand.text.slice(0, 70))
  const missingUrl = await runTool({ action: "add", name: "x", type: "remote" })
  check("mcp tool: a remote server requires a url", !missingUrl.ok && /url/i.test(missingUrl.text), missingUrl.text.slice(0, 70))
  const emptyList = await runTool({ action: "list" })
  check("mcp tool: list reports when nothing is configured", emptyList.ok && emptyList.text.includes("No MCP servers"), emptyList.text.slice(0, 70))
  const added = await runTool({ action: "add", name: "demo", type: "local", command: "bun run mock-mcp.ts" })
  check("mcp tool: add reports the discovered tools", added.ok && added.text.includes("echo") && added.text.includes("demo"), added.text.slice(0, 90))
}

// ---------------------------------------------------------------------------
// Web search chain: DuckDuckGo → Bing RSS → TinyFish (network; skipped when offline)
// ---------------------------------------------------------------------------
try {
  const { searchWeb } = await import("../packages/core/src/websearch.ts")
  const outcome = await searchWeb({ provider: "duckduckgo" }, "opencode agent")
  check(
    "websearch: the keyless chain returns results (DDG/Bing/TinyFish)",
    outcome.results.length > 0,
    `${outcome.results.length} results via ${outcome.provider}${outcome.fallback ? " (fallback)" : ""}`,
  )
} catch (error) {
  console.log(`SKIP  websearch: providers unreachable — ${error instanceof Error ? error.message : String(error)}`)
}

// ---------------------------------------------------------------------------
// Browser: challenge classification and purchase confirmation
// ---------------------------------------------------------------------------
check("browser challenge: normal pages are not flagged", parseChallenge({ kind: "normal" }) === undefined)
check(
  "browser challenge: Cloudflare interstitials are detected",
  parseChallenge({ kind: "challenge", evidence: "just a moment" })?.kind === "challenge",
)
check(
  "browser challenge: login/OTP pages are classified separately",
  parseChallenge({ kind: "login", evidence: "password field" })?.kind === "login",
)
check(
  "browser challenge: card forms are classified as payment",
  parseChallenge({ kind: "payment", evidence: "card field" })?.kind === "payment",
)
check(
  "browser purchase: Place order asks for confirmation",
  sensitiveLabel('- button "Place order" [ref=e12]', "@e12") === "Place order",
)
check(
  "browser purchase: Add to cart does not ask",
  sensitiveLabel('- button "Add to cart" [ref=e12]', "@e12") === undefined,
)
check(
  "browser purchase: non-interactive headings are ignored",
  sensitiveLabel('- heading "Pagar" [ref=e2]', "@e2") === undefined,
)

const failed = results.filter((entry) => !entry.ok)
console.log(`\n${results.length - failed.length}/${results.length} core checks passed`)
if (failed.length > 0) process.exitCode = 1
