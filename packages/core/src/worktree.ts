import { execFile } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { promisify } from "node:util"
import { ToolFailure } from "./tools/types.js"

const execFileAsync = promisify(execFile)

export interface WorktreeInfo {
  directory: string
  branch?: string
  detached?: boolean
  source: string
  current?: boolean
}

function normalize(p: string): string {
  return path.resolve(p).replaceAll("\\", "/").toLowerCase()
}

export class WorktreeManager {
  constructor(private baseDirectory: () => string | undefined) {}

  private async git(args: string[], cwd: string): Promise<string> {
    try {
      const { stdout } = await execFileAsync("git", args, { cwd, timeout: 60_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true })
      return stdout
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr
      throw new ToolFailure(stderr?.trim() || (error instanceof Error ? error.message : String(error)))
    }
  }

  async gitRoot(directory: string): Promise<string | undefined> {
    if (!existsSync(directory)) return undefined
    try {
      const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
        cwd: directory,
        timeout: 20_000,
        windowsHide: true,
      })
      return stdout.trim() || undefined
    } catch {
      return undefined
    }
  }

  private base(root: string): string {
    const configured = this.baseDirectory() ?? process.env.OPENORCH_WORKTREES
    if (configured && configured.trim()) return path.resolve(configured)
    return path.join(root, ".openorch", "worktrees")
  }

  /** Keeps the managed worktree folder out of `git status`. */
  private ensureExcluded(root: string, base: string): void {
    try {
      const relative = path.relative(root, base).replaceAll("\\", "/")
      if (relative.startsWith("..")) return
      const excludeFile = path.join(root, ".git", "info", "exclude")
      const current = existsSync(excludeFile) ? readFileSync(excludeFile, "utf8") : ""
      const line = `/${relative}/`
      if (current.split(/\r?\n/).includes(line)) return
      appendFileSync(excludeFile, `${current.endsWith("\n") || current === "" ? "" : "\n"}${line}\n`)
    } catch {
      // ignore: cosmetic only
    }
  }

  async list(directory: string): Promise<WorktreeInfo[]> {
    const root = await this.gitRoot(directory)
    if (!root) throw new ToolFailure("Not inside a git repository.")
    const stdout = await this.git(["worktree", "list", "--porcelain"], root)
    const current = normalize(directory)
    const out: WorktreeInfo[] = []
    for (const block of stdout.split(/\r?\n\r?\n/)) {
      const lines = block.split(/\r?\n/).filter(Boolean)
      if (lines.length === 0) continue
      const worktreeLine = lines.find((line) => line.startsWith("worktree "))
      if (!worktreeLine) continue
      const worktreePath = worktreeLine.slice("worktree ".length).trim()
      const branchLine = lines.find((line) => line.startsWith("branch "))
      const branch = branchLine ? branchLine.slice("branch ".length).replace("refs/heads/", "").trim() : undefined
      out.push({
        directory: worktreePath,
        branch,
        detached: lines.includes("detached"),
        source: root,
        current: normalize(worktreePath) === current,
      })
    }
    return out
  }

  async create(directory: string, name: string): Promise<WorktreeInfo> {
    const root = await this.gitRoot(directory)
    if (!root) throw new ToolFailure("Worktrees require a git repository.")
    const slug = name
      .trim()
      .replaceAll(/[^a-zA-Z0-9._-]+/g, "-")
      .replaceAll(/^-+|-+$/g, "")
    if (!slug) throw new ToolFailure("A worktree name is required.")
    const base = this.base(root)
    mkdirSync(base, { recursive: true })
    this.ensureExcluded(root, base)

    let target = path.join(base, slug)
    let suffix = 1
    while (existsSync(target)) {
      suffix++
      if (suffix > 10) throw new ToolFailure(`A worktree named "${slug}" already exists.`)
      target = path.join(base, `${slug}-${suffix}`)
    }

    const branchExists = await this.git(["rev-parse", "--verify", "--quiet", `refs/heads/${slug}`], root)
      .then((out) => out.trim().length > 0)
      .catch(() => false)
    if (branchExists) {
      await this.git(["worktree", "add", target, slug], root)
    } else {
      await this.git(["worktree", "add", "-b", slug, target, "HEAD"], root)
    }
    return { directory: target, branch: slug, source: root }
  }

  async remove(directory: string, worktreeDirectory: string, force: boolean): Promise<void> {
    const root = await this.gitRoot(directory)
    if (!root) throw new ToolFailure("Not inside a git repository.")
    const worktrees = await this.list(directory)
    const target = worktrees.find((entry) => normalize(entry.directory) === normalize(worktreeDirectory))
    if (!target) {
      throw new ToolFailure(`Not a registered worktree of this repository: ${worktreeDirectory}. Use worktree_list to see valid directories.`)
    }
    if (target.current) throw new ToolFailure("Cannot remove the worktree the session is using.")
    await this.git(["worktree", "remove", ...(force ? ["--force"] : []), target.directory], root)
    await this.git(["worktree", "prune"], root).catch(() => undefined)
  }
}
