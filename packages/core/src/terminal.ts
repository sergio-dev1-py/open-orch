import type { IPty } from "@lydell/node-pty"
import { resolveShell, type ShellOption } from "./tools/shell.js"

interface Terminal {
  id: string
  pty: IPty
}

export class TerminalManager {
  private terminals = new Map<string, Terminal>()

  async open(input: {
    id: string
    cwd: string
    cols: number
    rows: number
    shell?: string
    onData: (data: string) => void
    onExit: () => void
  }): Promise<void> {
    const pty = await import("@lydell/node-pty")
    const shell: ShellOption = resolveShell(input.shell)
    const terminal = pty.spawn(shell.path, shell.args, {
      name: "xterm-color",
      cols: input.cols,
      rows: input.rows,
      cwd: input.cwd,
      env: { ...process.env, OPENORCH: "1" } as Record<string, string>,
    })
    terminal.onData((data) => input.onData(data))
    terminal.onExit(() => {
      this.terminals.delete(input.id)
      input.onExit()
    })
    this.terminals.set(input.id, { id: input.id, pty: terminal })
  }

  write(id: string, data: string): void {
    this.terminals.get(id)?.pty.write(data)
  }

  list(): string[] {
    return [...this.terminals.keys()]
  }

  resize(id: string, cols: number, rows: number): void {
    const terminal = this.terminals.get(id)
    if (!terminal) return
    try {
      terminal.pty.resize(cols, rows)
    } catch {
      // ignore
    }
  }

  close(id: string): void {
    const terminal = this.terminals.get(id)
    if (!terminal) return
    try {
      terminal.pty.kill()
    } catch {
      // ignore
    }
    this.terminals.delete(id)
  }

  closeAll(): void {
    for (const id of [...this.terminals.keys()]) this.close(id)
  }
}
