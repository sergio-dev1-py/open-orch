import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { Config, SkillDetail, SkillInfo } from "@openorch/shared"
import { home, isInside } from "./util.js"

export type { SkillDetail, SkillInfo }

interface SkillFrontmatter {
  name?: string
  description?: string
  autoinvoke?: boolean
}

function booleanValue(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined
  const normalized = value.trim().toLowerCase().replace(/^["']|["']$/g, "")
  if (["true", "yes", "on", "1"].includes(normalized)) return true
  if (["false", "no", "off", "0"].includes(normalized)) return false
  return undefined
}

function parseFrontmatter(content: string): SkillFrontmatter {
  if (!content.startsWith("---")) return {}
  const end = content.indexOf("\n---", 3)
  if (end === -1) return {}
  const head = content.slice(3, end)
  const data: SkillFrontmatter = {}
  for (const line of head.split("\n")) {
    const match = line.match(/^\s*([A-Za-z0-9_/-]+)\s*:\s*(.*)$/)
    if (!match) continue
    const key = match[1]
    const raw = match[2]
    if (key === "name" || key === "description") {
      let value = raw.trim()
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1)
      }
      if (key === "name") data.name = value
      else data.description = value
      continue
    }
    // `disable-model-invocation: true` and nested `metadata.opencode/autoinvoke`.
    if (key === "disable-model-invocation") {
      const disabled = booleanValue(raw)
      if (disabled !== undefined) data.autoinvoke = !disabled
      continue
    }
    if (key === "opencode/autoinvoke") {
      const autoinvoke = booleanValue(raw)
      if (autoinvoke !== undefined) data.autoinvoke = autoinvoke
    }
  }
  return data
}

function parseSkillFile(file: string, id: string, ): SkillInfo | undefined {
  let content = ""
  try {
    content = readFileSync(file, "utf8")
  } catch {
    return undefined
  }
  const front = parseFrontmatter(content)
  return {
    id,
    name: front.name ?? id,
    description: front.description ?? "",
    directory: path.dirname(file),
    autoinvoke: front.autoinvoke,
  }
}

export function openorchConfigDirectory(): string {
  // Tests sandbox the global folder with OPENORCH_CONFIG_DIR.
  return process.env.OPENORCH_CONFIG_DIR ?? path.join(home(), ".config", "openorch")
}

/** Global skills directory shared by every project opened in OpenOrch. */
export function globalSkillsDirectory(): string {
  return path.join(openorchConfigDirectory(), "skills")
}

export type SkillOrigin = SkillInfo["origin"]

/**
 * Dirent kind with symlink following: the `skills` CLI installs skills as symlinks by
 * default, and `readdirSync(withFileTypes)` reports those as neither file nor directory.
 */
function entryKind(parent: string, entry: import("node:fs").Dirent): "file" | "dir" | "other" {
  if (entry.isFile()) return "file"
  if (entry.isDirectory()) return "dir"
  if (!entry.isSymbolicLink()) return "other"
  try {
    const stat = statSync(path.join(parent, entry.name))
    if (stat.isFile()) return "file"
    if (stat.isDirectory()) return "dir"
  } catch {
    return "other"
  }
  return "other"
}

/**
 * Scans a skills directory following upstream patterns (`*.md`, `**\/SKILL.md`).
 * A flat `<name>.md` uses its basename as id; a `<dir>/SKILL.md` uses its folder name.
 */
function scanSkillsDir(dir: string): SkillInfo[] {
  if (!existsSync(dir)) return []
  const out: SkillInfo[] = []
  let entries: import("node:fs").Dirent[] = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  for (const entry of entries) {
    const kind = entryKind(dir, entry)
    if (kind === "file" && entry.name.endsWith(".md")) {
      const info = parseSkillFile(path.join(dir, entry.name), path.basename(entry.name, ".md"))
      if (info) out.push(info)
      continue
    }
    if (kind !== "dir") continue
    const walk = (current: string) => {
      const skillFile = path.join(current, "SKILL.md")
      if (existsSync(skillFile)) {
        const info = parseSkillFile(skillFile, path.basename(current))
        if (info) out.push(info)
      }
      let children: import("node:fs").Dirent[] = []
      try {
        children = readdirSync(current, { withFileTypes: true })
      } catch {
        return
      }
      for (const child of children) {
        if (entryKind(current, child) !== "dir") continue
        walk(path.join(current, child.name))
      }
    }
    walk(path.join(dir, entry.name))
  }
  return out
}

export function discoverSkills(config: Config, projectDirectory: string): SkillInfo[] {
  const skills = new Map<string, SkillInfo>()
  const collect = (dir: string, origin: SkillOrigin) => {
    for (const skill of scanSkillsDir(dir)) skills.set(skill.id, { ...skill, origin })
  }
  // Upstream scans both `skill/` and `skills/` under each configuration directory, and also
  // reads the Claude Code / `.agents` compatibility roots — that is where `npx skills add`
  // installs. Compat roots come first and native directories last, so native skills win
  // when two roots declare the same id.
  const roots: { root: string; origin: SkillOrigin }[] = [
    { root: path.join(home(), ".claude"), origin: "global" },
    { root: path.join(home(), ".agents"), origin: "global" },
    { root: path.join(home(), ".config", "opencode"), origin: "global" },
    { root: openorchConfigDirectory(), origin: "global" },
    { root: path.join(projectDirectory, ".claude"), origin: "project" },
    { root: path.join(projectDirectory, ".agents"), origin: "project" },
    { root: path.join(projectDirectory, ".opencode"), origin: "project" },
    { root: path.join(projectDirectory, ".openorch"), origin: "project" },
  ]
  for (const { root, origin } of roots) {
    for (const variant of ["skill", "skills"]) collect(path.join(root, variant), origin)
  }
  for (const dir of config.skills.dirs) {
    const resolved = isInside(projectDirectory, dir) || path.isAbsolute(dir) ? dir : path.join(projectDirectory, dir)
    collect(resolved, "custom")
  }
  return [...skills.values()]
}

export function skillsInstructions(skills: SkillInfo[], projectDirectory?: string): string {
  // Skills with autoinvoke disabled are not advertised to the model; upstream also
  // hides skills without a description from the advertised list.
  const advertised = skills.filter((skill) => skill.autoinvoke !== false && skill.description.trim().length > 0)
  const storage = [
    "Skills are stored in these directories:",
    `- ${globalSkillsDirectory()} (global, available in every project)`,
    `- ${path.join(home(), ".agents", "skills")} (global, shared with other agents: \`npx skills add -g\` installs here)`,
    `- ${path.join(home(), ".claude", "skills")} (global, Claude Code compatibility)`,
    ...(projectDirectory
      ? [
          `- ${path.join(projectDirectory, ".openorch", "skills")} (this project)`,
          `- ${path.join(projectDirectory, ".agents", "skills")} (this project: \`npx skills add\` without -g installs here)`,
        ]
      : []),
    "When the user asks you to find, install, or create a skill: search with `npx skills find <query>` and install global skills with `npx skills add -g <source> --skill <name>`, or write the SKILL.md file into the global skills directory. `npx skills add` without `-g` installs only into the project. Installed skills appear in the `@` menu and in the available list on the next message.",
  ]
  const lines = advertised.map((skill) => `- ${skill.id}: ${skill.description}`)
  return [
    "Skills provide specialized instructions and workflows for specific tasks.",
    "Use the skill tool to load a skill when a task matches its description.",
    "The user may also invoke a skill directly. When that happens, its instructions appear in the conversation as a <skill_content> block, the same shape the skill tool returns. A skill that is already present this way does not need to be invoked again.",
    ...storage,
    ...(advertised.length === 0
      ? ["No skills are currently available."]
      : ["<available_skills>", ...lines, "</available_skills>"]),
  ].join("\n")
}

// ---------------------------------------------------------------------------
// Installing skills (global directory)
// ---------------------------------------------------------------------------

const SKILL_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

function yamlValue(value: string): string {
  return /[:#'"\[\]{}]/.test(value) ? `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"` : value
}

/** Writes a skill into the global directory (used by `/skill` and the agent install flow). */
export function installGlobalSkill(draft: { id: string; name?: string; description?: string; content: string }): SkillInfo {
  const id = draft.id.trim()
  if (!SKILL_ID_PATTERN.test(id)) throw new Error(`Invalid skill id "${draft.id}". Use letters, numbers, dots, dashes, or underscores.`)
  const directory = path.join(globalSkillsDirectory(), id)
  const name = draft.name?.trim() || id
  const description = draft.description?.trim() ?? ""
  const body = draft.content.trim().replace(/^---[\s\S]*?\n---\n?/, "")
  const frontmatter = ["---", `name: ${yamlValue(name)}`, ...(description ? [`description: ${yamlValue(description)}`] : []), "---", ""].join("\n")
  mkdirSync(directory, { recursive: true })
  writeFileSync(path.join(directory, "SKILL.md"), `${frontmatter}${body}\n`, "utf8")
  return { id, name, description, directory, origin: "global" }
}

/** Removes a skill directory managed by the global skills folder (never touches project skills). */
export function removeGlobalSkill(id: string): void {
  if (!SKILL_ID_PATTERN.test(id)) throw new Error(`Invalid skill id "${id}"`)
  const root = globalSkillsDirectory()
  const directory = path.join(root, id)
  if (directory === root || !isInside(root, directory)) throw new Error(`Skill "${id}" is not managed by the global directory`)
  rmSync(directory, { recursive: true, force: true })
}

/** Reads a skill draft from an existing folder (used by the import button in the dialog). */
export function readSkillDraft(directory: string): { id: string; name?: string; description?: string; content: string } | undefined {
  const candidates = [path.join(directory, "SKILL.md"), ...(existsSync(path.join(directory, `${path.basename(directory)}.md`)) ? [path.join(directory, `${path.basename(directory)}.md`)] : [])]
  for (const file of candidates) {
    if (!existsSync(file)) continue
    const raw = readFileSync(file, "utf8")
    const front = parseFrontmatter(raw)
    const content = raw.replace(/^---[\s\S]*?\n---\n?/, "")
    return { id: front.name && SKILL_ID_PATTERN.test(front.name) ? front.name : path.basename(directory), name: front.name, description: front.description, content: content.trim() }
  }
  return undefined
}

/** File backing a discovered skill: a folder `SKILL.md` or a flat `<id>.md`. */
function skillFileOf(skill: SkillInfo): string {
  const folder = path.join(skill.directory, "SKILL.md")
  if (existsSync(folder)) return folder
  const flat = path.join(skill.directory, `${skill.id}.md`)
  if (existsSync(flat)) return flat
  return folder
}

/** Reads a discovered skill with its editable content (manager detail view). */
export function readSkillDetail(config: Config, projectDirectory: string, id: string): SkillDetail | undefined {
  const skill = discoverSkills(config, projectDirectory).find((entry) => entry.id === id)
  if (!skill) return undefined
  let raw = ""
  try {
    raw = readFileSync(skillFileOf(skill), "utf8")
  } catch {
    return undefined
  }
  const content = raw.replace(/^---[\s\S]*?\n---\n?/, "").trim()
  let files: string[] = []
  try {
    files = readdirSync(skill.directory)
      .filter((entry) => entry !== "SKILL.md" && !entry.endsWith(".md"))
      .slice(0, 20)
  } catch {
    files = []
  }
  return { ...skill, content, files }
}

/**
 * Saves edits to a discovered skill. The target is resolved through the discovery roots (a
 * caller can never write an arbitrary path) and the frontmatter keeps every key that is not
 * `name`/`description` (license, metadata, …).
 */
export function writeSkill(
  config: Config,
  projectDirectory: string,
  draft: { id: string; name?: string; description?: string; content: string },
): SkillInfo {
  const id = draft.id.trim()
  const skill = discoverSkills(config, projectDirectory).find((entry) => entry.id === id)
  if (!skill) throw new Error(`Unknown skill "${draft.id}".`)
  const file = skillFileOf(skill)
  let raw = ""
  try {
    raw = readFileSync(file, "utf8")
  } catch {
    raw = ""
  }
  const name = draft.name?.trim() || skill.name
  const description = draft.description !== undefined ? draft.description.trim() : skill.description
  const body = draft.content.trim()
  writeFileSync(file, renderSkillFile(raw, { name, description, body }), "utf8")
  return { ...skill, name, description }
}

/** Rewrites a SKILL.md keeping the existing frontmatter keys except `name`/`description`. */
function renderSkillFile(raw: string, fields: { name: string; description: string; body: string }): string {
  const existing = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1]
  const others: string[] = []
  if (existing) {
    for (const line of existing.split(/\r?\n/)) {
      if (line.trim() === "") continue
      const key = line.match(/^\s*([A-Za-z0-9_/-]+)\s*:/)?.[1]
      if (key === "name" || key === "description") continue
      others.push(line)
    }
  }
  const frontmatter = [
    "---",
    `name: ${yamlValue(fields.name)}`,
    ...(fields.description ? [`description: ${yamlValue(fields.description)}`] : []),
    ...others,
    "---",
    "",
  ].join("\n")
  return `${frontmatter}${fields.body}\n`
}

/** Renders the `<skill_content>` block used by the skill tool and `@skill` mentions. */
export function skillContent(skill: SkillInfo): string {
  const skillFile = path.join(skill.directory, "SKILL.md")
  let content = ""
  try {
    content = readFileSync(skillFile, "utf8").replace(/^---[\s\S]*?\n---\n?/, "")
  } catch {
    const flat = path.join(skill.directory, `${skill.id}.md`)
    try {
      content = readFileSync(flat, "utf8")
    } catch {
      content = ""
    }
  }
  let files: string[] = []
  try {
    files = readdirSync(skill.directory)
      .filter((entry) => entry !== "SKILL.md" && !entry.endsWith(".md"))
      .slice(0, 10)
  } catch {
    files = []
  }
  const fileList =
    files.length > 0 ? `<skill_files>\n${files.map((file) => `<file>${file}</file>`).join("\n")}\n</skill_files>` : ""
  return [
    `<skill_content name="${skill.name}">`,
    `# Skill: ${skill.name}`,
    content.trim(),
    `Base directory for this skill: ${skill.directory}`,
    "Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.",
    fileList,
    "</skill_content>",
  ]
    .filter(Boolean)
    .join("\n")
}

// ---------------------------------------------------------------------------
// Instruction discovery (AGENTS.md)
// ---------------------------------------------------------------------------

export interface InstructionEntry {
  path: string
  content: string
}

function readAgentsFile(file: string): string | undefined {
  if (!existsSync(file)) return undefined
  try {
    const content = readFileSync(file, "utf8").trim()
    return content || undefined
  } catch {
    return undefined
  }
}

export function agentsFilesUpwards(fromDirectory: string, stopAt?: string): string[] {
  const files: string[] = []
  let current = fromDirectory
  while (true) {
    files.push(path.join(current, "AGENTS.md"))
    const parent = path.dirname(current)
    if (parent === current) break
    if (stopAt && !isInside(stopAt, parent)) break
    current = parent
  }
  return files
}

export function renderInstructions(entries: InstructionEntry[]): string {
  if (entries.length === 0) return ""
  return entries
    .map((entry) => `<project-instructions path="${entry.path}">\n${entry.content}\n</project-instructions>`)
    .join("\n\n")
}

export function environmentBlock(directory: string, workspaceRoot: string): string {
  const isGit = existsSync(path.join(directory, ".git"))
  return [
    "Here is some useful information about the environment you are running in:",
    "<env>",
    `  Working directory: ${directory}`,
    `  Workspace root folder: ${workspaceRoot}`,
    `  Is directory a git repo: ${isGit ? "yes" : "no"}`,
    `  Platform: ${process.platform}`,
    "  Prefer the system temporary directory over generic temporary paths such as /tmp.",
    "</env>",
    `Today's date: ${new Date().toDateString()}`,
  ].join("\n")
}

export function globalAgentsFile(): string | undefined {
  const candidates = [
    path.join(home(), ".config", "opencode", "AGENTS.md"),
    path.join(home(), ".config", "opencode", "agents.md"),
  ]
  for (const candidate of candidates) {
    const content = readAgentsFile(candidate)
    if (content) return content
  }
  return undefined
}

export { readAgentsFile }
