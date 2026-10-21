import { For, Show, createMemo, createSignal } from "solid-js"
import type { FileDiffInfo } from "@openorch/shared"

interface DiffLine {
  type: "add" | "del" | "context" | "hunk" | "header"
  text: string
  oldLine?: number
  newLine?: number
}

function parsePatch(patch: string): DiffLine[] {
  const lines: DiffLine[] = []
  let oldLine = 0
  let newLine = 0
  let sawHunk = false
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("Index:") || raw.startsWith("===") || raw.startsWith("---") || raw.startsWith("+++")) {
      continue
    }
    const hunkMatch = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/)
    if (hunkMatch) {
      oldLine = Number.parseInt(hunkMatch[1], 10) || 1
      newLine = Number.parseInt(hunkMatch[2], 10) || 1
      sawHunk = true
      lines.push({ type: "hunk", text: raw })
      continue
    }
    if (raw.startsWith("+")) {
      if (!sawHunk) newLine = newLine || 1
      lines.push({ type: "add", text: raw.slice(1), newLine: newLine++ })
      continue
    }
    if (raw.startsWith("-")) {
      if (!sawHunk) oldLine = oldLine || 1
      lines.push({ type: "del", text: raw.slice(1), oldLine: oldLine++ })
      continue
    }
    if (raw.startsWith(" ")) {
      lines.push({ type: "context", text: raw.slice(1), oldLine: oldLine++, newLine: newLine++ })
      continue
    }
    if (raw === "") continue
    lines.push({ type: "context", text: raw })
  }
  return lines
}

export function DiffView(props: { files: FileDiffInfo[]; defaultOpen?: boolean }) {
  const [collapsed, setCollapsed] = createSignal<Record<string, boolean>>({})
  const isCollapsed = (path: string) => collapsed()[path] ?? !(props.defaultOpen ?? true)

  return (
    <div class="tool-group">
      <For each={props.files}>
        {(file) => {
          const lines = createMemo(() => parsePatch(file.patch))
          return (
            <div class="diff-file">
              <div class="diff">
                <div class="diff-header" onClick={() => setCollapsed({ ...collapsed(), [file.path]: !isCollapsed(file.path) })}>
                  <span>{isCollapsed(file.path) ? "▸" : "▾"}</span>
                  <span style={{ "font-family": "var(--font-mono)" }}>{file.path}</span>
                  <span class="diff-stat-add">+{file.additions}</span>
                  <span class="diff-stat-del">-{file.deletions}</span>
                  <span style={{ "margin-left": "auto", "font-size": "11px" }}>
                    {file.status === "added" ? "A" : file.status === "deleted" ? "D" : "M"}
                  </span>
                </div>
                <Show when={!isCollapsed(file.path)}>
                  <div class="diff-lines">
                    <For each={lines()}>
                      {(line) => (
                        <div class={`diff-line ${line.type === "add" ? "add" : line.type === "del" ? "del" : line.type === "hunk" ? "hunk" : ""}`}>
                          <span class="diff-gutter">{line.type === "hunk" ? "" : (line.newLine ?? line.oldLine ?? "")}</span>
                          <span class="diff-sign">{line.type === "add" ? "+" : line.type === "del" ? "-" : line.type === "hunk" ? "@" : " "}</span>
                          <span class="diff-text">{line.text}</span>
                        </div>
                      )}
                    </For>
                  </div>
                </Show>
              </div>
            </div>
          )
        }}
      </For>
    </div>
  )
}
