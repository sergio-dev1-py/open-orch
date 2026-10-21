import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { z } from "zod"
import { id, isInside, truncate } from "../util.js"
import { ToolFailure, textOutput, type ToolContext, type ToolDefinition } from "./types.js"

const MAX_INLINE_OUTPUT = 200_000
/** Grace period after process exit before resolving, so grandchildren can flush. */
const EXIT_GRACE_MS = 1_500

interface Job {
  child: ChildProcess
  sessionID: string
  command: string
  outputPath: string
  buffer: string[]
  finished: boolean
}

const jobs = new Map<string, Job>()

/**
 * Unattended scheduled runs must not be able to wipe the system. This is a
 * conservative denylist for catastrophic commands; normal work inside the task
 * workspace stays allowed. It is a safety net, not a shell sandbox.
 */
function assertScheduledCommandSafe(command: string, workspace: string): void {
  const text = command.toLowerCase()
  const catastrophic = [
    /(^|[;&|]\s*)(format(\.com)?\s+[a-z]:|diskpart|mkfs(\.\w+)?|bcdedit)\b/,
    /(^|[;&|]\s*)(shutdown|reboot|halt)(\s|$)/,
    /(^|[;&|]\s*)(restart-computer|stop-computer)(\s|$)/,
    /\bdd\b[^\n]*\bof=\/dev\//,
    /\breg(\.exe)?\s+delete\s+hk(lm|cr|cu)\b/,
    /:\(\)\s*\{\s*:\s*\|\s*:&\s*\}\s*;\s*:/,
    /\brm\s+-[a-z]*(r[a-z]*f|f[a-z]*r)\b[^\n]*\s\/(\s|$|\*)/,
    /\b(chmod|chown)\s+-r\b[^\n]*\s\/(\s|$)/,
    /\bdel\s+\/[a-z]*[sq]\b[^\n]*[a-z]:\\(windows|program files|users)(\\|\s|$)/,
    /\bremove-item\b[^\n]*-recurse[^\n]*[a-z]:\\(windows|program files|users)(\\|\s|$)/,
  ]
  if (catastrophic.some((pattern) => pattern.test(text))) {
    throw new ToolFailure(
      "Bloqueado por seguridad: una tarea programada no puede ejecutar comandos destructivos del sistema. " +
        "Divide la tarea o ejecútala manualmente si de verdad necesitas ese comando.",
    )
  }
  const recursive = /\b(rm\s+-[a-z]*(r[a-z]*f|f[a-z]*r)|remove-item[^\n]*-recurse|del\s+\/[a-z]*s|rd\s+\/s|rmdir\s+\/s)\b/i
  if (!recursive.test(text)) return
  const workspacePath = path.resolve(workspace)
  for (const target of command.match(/[a-z]:\\[^\s"';&|]+/gi) ?? []) {
    const resolved = path.resolve(target)
    if (resolved === workspacePath || !isInside(workspacePath, resolved)) {
      throw new ToolFailure(
        "Bloqueado por seguridad: una tarea programada no puede borrar de forma recursiva fuera de su carpeta de trabajo.",
      )
    }
  }
  if (/(^|\s)\/(\s|$|\*)/.test(command)) {
    throw new ToolFailure("Bloqueado por seguridad: no se permite un borrado recursivo de la raíz del sistema.")
  }
}

/**
 * Kills the whole process tree. On Windows `taskkill /T /F` also stops detached
 * grandchildren (e.g. `start node server.js`); on POSIX the child is spawned in
 * its own process group so the group can be signalled.
 */
function killTree(child: ChildProcess): void {
  const pid = child.pid
  if (pid !== undefined && process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" })
    } catch {
      // ignore
    }
  } else if (pid !== undefined) {
    try {
      process.kill(-pid, "SIGKILL")
    } catch {
      // ignore: group may not exist
    }
  }
  try {
    child.kill("SIGKILL")
  } catch {
    // ignore
  }
}

function osName(): string {
  if (process.platform === "darwin") return "macOS"
  if (process.platform === "win32") return "Windows"
  return "Linux"
}

function shellName(): string {
  if (process.platform === "win32") return "cmd.exe"
  return process.env.SHELL ?? "/bin/sh"
}

export function shellDescription(): string {
  return [
    `Execute a shell command and return its output. Commands run on ${osName()} using ${shellName()}. Quote file paths containing spaces or special characters.`,
    "Prefer dedicated tools over shell commands when possible.",
    "When output is large, the full result is saved to a file and a truncated preview is returned. Rely on automatic truncation unless filtering the output is more useful.",
    "Commands accept an optional timeout, background commands have no timeout by default.",
    "Background commands return immediately, and you will be notified when they complete.",
  ].join(" ")
}

function parseShellCommand(command: string): { resources: string[]; save: string[] } {
  const first = command.trim().split(/\s+/)[0] ?? command
  const binary = path.basename(first)
  return {
    resources: [command.trim()],
    save: [`${binary} *`],
  }
}

/**
 * Best-effort list of external directories a shell command reaches: the explicit
 * `workdir` plus `cd` targets (Windows `/d` and quoted forms included). Upstream
 * infers directories with a tree-sitter scanner; this covers the common cases.
 */
function externalShellDirectories(command: string, workdir: string | undefined, directory: string): string[] {
  const candidates = new Set<string>()
  if (workdir) candidates.add(path.resolve(directory, workdir))
  const cdPattern = /(?:^|[\s&;(|])cd\s+(?:\/d\s+)?(?:"([^"]+)"|'([^']+)'|([^\s&;|()]+))/gi
  let match: RegExpExecArray | null
  while ((match = cdPattern.exec(command))) {
    const raw = (match[1] ?? match[2] ?? match[3] ?? "").trim()
    if (!raw || raw === "." || raw === "..") continue
    candidates.add(path.resolve(directory, raw))
  }
  return [...candidates].filter((entry) => !isInside(directory, entry))
}

// ---------------------------------------------------------------------------
// Shell detection (integrated terminal picker + `!` composer commands)
// ---------------------------------------------------------------------------

export interface ShellOption {
  id: string
  name: string
  path: string
  args: string[]
}

let shellCache: ShellOption[] | undefined

function which(name: string): string | undefined {
  try {
    const result = spawnSync(process.platform === "win32" ? "where" : "which", [name], {
      encoding: "utf8",
      timeout: 2_500,
      windowsHide: true,
    })
    const first = result.stdout
      ?.split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean)
    return first && existsSync(first) ? first : undefined
  } catch {
    return undefined
  }
}

function firstExisting(paths: string[]): string | undefined {
  return paths.find((entry) => entry.length > 0 && existsSync(entry))
}

/** Lists the WSL distros (wsl.exe writes UTF-16LE; NULs are stripped). */
function wslDistros(wsl: string): string[] {
  try {
    const result = spawnSync(wsl, ["-l", "-q"], { timeout: 4_000, windowsHide: true })
    if (result.status !== 0 || !result.stdout) return []
    return Buffer.from(result.stdout)
      .toString("utf16le")
      .split(/\r?\n/)
      .map((line) => line.replaceAll("\u0000", "").trim())
      .filter((line) => line.length > 0)
  } catch {
    return []
  }
}

function posixShells(): string[] {
  try {
    return readFileSync("/etc/shells", "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("/") && existsSync(line))
  } catch {
    return []
  }
}

/** Detects the shells installed on this machine (cached for the process). */
export function availableShells(): ShellOption[] {
  if (shellCache) return shellCache
  const found: ShellOption[] = []
  const push = (option: ShellOption | undefined) => {
    if (!option || found.some((entry) => entry.id === option.id)) return
    found.push(option)
  }
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot ?? "C:\\Windows"
    push({
      id: "powershell",
      name: "Windows PowerShell",
      path:
        firstExisting([path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")]) ??
        which("powershell.exe") ??
        "powershell.exe",
      args: ["-NoLogo"],
    })
    const pwsh =
      which("pwsh.exe") ?? firstExisting([path.join(process.env.ProgramFiles ?? "C:\\Program Files", "PowerShell", "7", "pwsh.exe")])
    if (pwsh) push({ id: "pwsh", name: "PowerShell 7", path: pwsh, args: ["-NoLogo"] })
    push({
      id: "cmd",
      name: "Símbolo del sistema (cmd)",
      path: process.env.ComSpec ?? path.join(systemRoot, "System32", "cmd.exe"),
      args: [],
    })
    const gitBash = firstExisting([
      path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe"),
      path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Git", "bin", "bash.exe"),
      path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Git", "bin", "bash.exe"),
    ])
    if (gitBash) push({ id: "git-bash", name: "Git Bash", path: gitBash, args: ["-i"] })
    const wsl = firstExisting([path.join(systemRoot, "System32", "wsl.exe")]) ?? which("wsl.exe")
    if (wsl) {
      const distros = wslDistros(wsl)
      if (distros.length > 0) {
        for (const distro of distros) push({ id: `wsl:${distro}`, name: `WSL · ${distro}`, path: wsl, args: ["-d", distro] })
      } else {
        push({ id: "wsl", name: "WSL", path: wsl, args: [] })
      }
    }
  } else {
    for (const file of posixShells()) push({ id: path.basename(file), name: path.basename(file), path: file, args: [] })
    const shell = process.env.SHELL
    if (shell && existsSync(shell)) push({ id: path.basename(shell), name: path.basename(shell), path: shell, args: [] })
  }
  if (found.length === 0) {
    found.push({
      id: "default",
      name: "Shell",
      path: process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : (process.env.SHELL ?? "/bin/sh"),
      args: [],
    })
  }
  shellCache = found
  return found
}

/** Default shell id for this platform (PowerShell on Windows when available). */
export function defaultShellID(): string {
  if (process.platform !== "win32") return path.basename(process.env.SHELL ?? "sh")
  return availableShells().some((entry) => entry.id === "powershell") ? "powershell" : "cmd"
}

/** Resolves a shell id, falling back to the platform default. */
export function resolveShell(id?: string): ShellOption {
  const shells = availableShells()
  return shells.find((entry) => entry.id === id) ?? shells.find((entry) => entry.id === defaultShellID()) ?? shells[0]!
}

/** One-shot command arguments for the given shell (used by `!` in the composer). */
export function shellRunArgs(shell: ShellOption, command: string): string[] {
  if (shell.id === "cmd") return ["/d", "/s", "/c", command]
  if (shell.id === "powershell" || shell.id === "pwsh") return ["-NoLogo", "-NoProfile", "-Command", command]
  if (shell.id.startsWith("wsl")) return [...shell.args, "bash", "-lc", command]
  return ["-lc", command]
}

function shellEnv(sessionID: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AGENT: "1",
    OPENORCH: "1",
    AI_AGENT: process.env.AI_AGENT ?? "openorch",
    OPENORCH_SESSION_ID: sessionID,
  }
}

export interface ShellRunResult {
  output: string
  exit?: number
  signal?: string
  background?: boolean
  shellID?: string
  outputPath?: string
  truncated?: boolean
  timeout?: boolean
  interrupted?: boolean
}

export async function runShell(input: {
  command: string
  workdir: string
  timeoutMs: number
  background: boolean
  sessionID: string
  dataDir: string
  abort?: AbortSignal
  /** When set, the command runs in that shell instead of the platform default. */
  shell?: ShellOption
  onExit?: (state: "completed" | "failed", output: string) => void
}): Promise<ShellRunResult> {
  const shellID = id("sh")
  const outputDir = path.join(input.dataDir, "shell")
  mkdirSync(outputDir, { recursive: true })
  const outputPath = path.join(outputDir, `${shellID}.log`)

  const spawnOptions = {
    cwd: input.workdir,
    env: shellEnv(input.sessionID),
    windowsHide: true,
    // POSIX: own process group so timeouts can kill the whole tree.
    detached: process.platform !== "win32",
  } as const
  const child = input.shell
    ? spawn(input.shell.path, shellRunArgs(input.shell, input.command), spawnOptions)
    : spawn(input.command, { ...spawnOptions, shell: true })

  const chunks: string[] = []
  const append = (data: Buffer) => {
    const text = data.toString("utf8")
    chunks.push(text)
    if (chunks.reduce((sum, chunk) => sum + chunk.length, 0) > MAX_INLINE_OUTPUT * 2) {
      chunks.splice(0, Math.max(0, chunks.length - 200))
    }
  }

  if (input.background) {
    const stream = createWriteStream(outputPath)
    const job: Job = { child, sessionID: input.sessionID, command: input.command, outputPath, buffer: chunks, finished: false }
    jobs.set(shellID, job)
    child.stdout?.on("data", (data: Buffer) => {
      append(data)
      stream.write(data)
    })
    child.stderr?.on("data", (data: Buffer) => {
      append(data)
      stream.write(data)
    })
    child.on("close", (code) => {
      job.finished = true
      stream.end()
      jobs.delete(shellID)
      const output = chunks.join("")
      input.onExit?.(code === 0 ? "completed" : "failed", output)
    })
    return { output: "", background: true, shellID, outputPath }
  }

  const result = await new Promise<{
    code: number | null
    signal: NodeJS.Signals | null
    timedOut: boolean
    interrupted: boolean
  }>((resolve) => {
    let settled = false
    let timedOut = false
    let interrupted = false
    let code: number | null = null
    let signal: NodeJS.Signals | null = null
    let graceTimer: NodeJS.Timeout | undefined
    let killTimer: NodeJS.Timeout | undefined

    const settle = () => {
      if (settled) return
      settled = true
      if (graceTimer) clearTimeout(graceTimer)
      if (killTimer) clearTimeout(killTimer)
      input.abort?.removeEventListener("abort", onAbort)
      resolve({ code, signal, timedOut, interrupted })
    }

    // Exit resolves after a short grace period so grandchildren holding the pipes
    // (`start …`, detached servers) cannot hang the tool forever.
    const scheduleSettle = () => {
      if (settled || graceTimer) return
      graceTimer = setTimeout(settle, EXIT_GRACE_MS)
    }

    const onAbort = () => {
      interrupted = true
      killTree(child)
      settle()
    }

    if (input.timeoutMs > 0) {
      killTimer = setTimeout(() => {
        timedOut = true
        killTree(child)
        // Give the killer a moment, then resolve regardless of pipe state.
        setTimeout(settle, 500)
      }, input.timeoutMs)
    }
    input.abort?.addEventListener("abort", onAbort, { once: true })
    child.stdout?.on("data", append)
    child.stderr?.on("data", append)
    child.on("exit", (exitCode, exitSignal) => {
      code = exitCode
      signal = exitSignal
      scheduleSettle()
    })
    child.on("close", (exitCode, exitSignal) => {
      code = exitCode
      signal = exitSignal
      settle()
    })
    child.on("error", (error) => {
      append(Buffer.from(`Failed to start command: ${error.message}`))
      settle()
    })
  })

  let output = chunks.join("")
  let truncated = false
  if (output.length > MAX_INLINE_OUTPUT) {
    writeFileSync(outputPath, output)
    output = truncate(output, MAX_INLINE_OUTPUT, `…(truncated, full output at ${outputPath})`)
    truncated = true
  }
  return {
    output,
    exit: result.code ?? undefined,
    signal: result.signal ?? undefined,
    truncated,
    timeout: result.timedOut,
    interrupted: result.interrupted,
    outputPath: truncated ? outputPath : undefined,
  }
}

export const shellTool: ToolDefinition = {
  name: "shell",
  description: shellDescription(),
  inputSchema: z.object({
    command: z.string().describe("Shell command string to execute"),
    workdir: z
      .string()
      .optional()
      .describe(
        "Working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead.",
      ),
    timeout: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to 120000 for foreground commands. Background commands have no timeout by default."),
    background: z
      .boolean()
      .optional()
      .describe(
        "Run the command in the background and return immediately (useful for dev servers and long-running builds). You do not need to use '&' at the end of the command when using this parameter. You will be notified when it completes. DO NOT poll for completion.",
      ),
  }),
  async execute(input: { command: string; workdir?: string; timeout?: number; background?: boolean }, ctx: ToolContext) {
    if (ctx.scheduled) assertScheduledCommandSafe(input.command, ctx.directory)
    const { resources, save } = parseShellCommand(input.command)
    // Best-effort external directory check (upstream infers directories with its
    // shell scanner): explicit `workdir` and `cd` targets outside the session ask.
    const external = externalShellDirectories(input.command, input.workdir, ctx.directory)
    for (const dir of external) {
      await ctx.permission({
        action: "external_directory",
        resources: [path.join(dir, "*")],
        save: [path.join(dir, "*")],
        metadata: { command: input.command, directory: dir },
      })
    }
    await ctx.permission({ action: "shell", resources, save, metadata: { command: input.command } })
    const workdir = input.workdir ? path.resolve(ctx.directory, input.workdir) : ctx.directory
    const timeoutMs = input.background ? 0 : (input.timeout ?? ctx.config.shellTimeoutMs ?? 120_000)
    const result = await runShell({
      command: input.command,
      workdir,
      timeoutMs,
      background: Boolean(input.background),
      sessionID: ctx.sessionID,
      dataDir: ctx.config.dataDir,
      abort: ctx.abort,
      onExit: (state, output) => {
        void ctx.services.shellNotify(ctx.sessionID, "shell", input.command, state, output)
      },
    })

    if (result.background) {
      ctx.progress({ metadata: { background: true, shellID: result.shellID } })
      return textOutput(
        `Command moved to the background (shell ID: ${result.shellID}).\nOutput is streaming to: ${result.outputPath}`,
        { background: true, command: input.command, outputPath: result.outputPath },
      )
    }

    const notices: string[] = []
    if (result.timeout) notices.push(`Command exceeded timeout of ${timeoutMs} ms. Retry with a larger timeout, or use background mode for long-running commands.`)
    if (result.interrupted) notices.push("Command interrupted.")
    if (result.signal) notices.push(`Killed by signal ${result.signal}`)
    if (result.exit !== undefined && result.exit !== 0) notices.push(`Exited with code ${result.exit}`)
    const text = [...notices, result.output].filter(Boolean).join("\n")
    return textOutput(text || "(no output)", {
      command: input.command,
      exit: result.exit,
      output: result.output,
      truncated: result.truncated,
      outputPath: result.outputPath,
      timeout: result.timeout,
      interrupted: result.interrupted,
    })
  },
}

export function killAllJobs(): void {
  for (const job of jobs.values()) {
    killTree(job.child)
  }
  jobs.clear()
}
