import { createEffect, createSignal, onCleanup } from "solid-js"
import { marked } from "marked"
import { codeToHtml } from "shiki"
import { state } from "../store"
import { currentTheme } from "../themes"

function sanitize(html: string): string {
  return html
    .replaceAll(/<script[\s\S]*?<\/script>/gi, "")
    .replaceAll(/<iframe[\s\S]*?<\/iframe>/gi, "")
    .replaceAll(/\son\w+\s*=\s*"[^"]*"/gi, "")
    .replaceAll(/\son\w+\s*=\s*'[^']*'/gi, "")
}

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")
}

function decodeHtml(text: string): string {
  return text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&")
}

const highlightCache = new Map<string, string>()

async function highlightBlock(code: string, lang: string, theme: string): Promise<string> {
  const key = `${theme}\u0000${lang}\u0000${code}`
  const cached = highlightCache.get(key)
  if (cached) return cached
  try {
    const html = await codeToHtml(code, { lang: lang || "text", theme })
    highlightCache.set(key, html)
    if (highlightCache.size > 400) {
      const first = highlightCache.keys().next().value
      if (first) highlightCache.delete(first)
    }
    return html
  } catch {
    const fallback = `<pre class="shiki"><code>${escapeHtml(code)}</code></pre>`
    highlightCache.set(key, fallback)
    return fallback
  }
}

async function enhance(html: string, theme: string): Promise<string> {
  const blocks: { full: string; code: string; lang: string }[] = []
  const regex = /<pre><code(?: class="language-([^"]*)")?>([\s\S]*?)<\/code><\/pre>/g
  let match: RegExpExecArray | null
  while ((match = regex.exec(html))) {
    blocks.push({ full: match[0], code: decodeHtml(match[2]), lang: match[1] ?? "text" })
  }
  if (blocks.length === 0) return html
  const replacements = await Promise.all(
    blocks.map(async (block) => ({
      full: block.full,
      html: await highlightBlock(block.code, block.lang, theme),
    })),
  )
  let output = html
  for (const replacement of replacements) {
    output = output.replace(replacement.full, `<div class="code-block">${replacement.html}<button class="code-copy">copy</button></div>`)
  }
  return output
}

export function Markdown(props: { text: string; streaming?: boolean; class?: string }) {
  const [html, setHtml] = createSignal("")
  let timer: number | undefined
  let disposed = false
  let renderToken = 0
  onCleanup(() => {
    disposed = true
    if (timer) clearTimeout(timer)
  })

  createEffect(() => {
    const text = props.text
    const streaming = props.streaming
    const theme = currentTheme().shiki
    if (timer) clearTimeout(timer)
    const token = ++renderToken
    timer = window.setTimeout(
      () => {
        const parsed = sanitize(marked.parse(text, { gfm: true, async: false }) as string)
        if (streaming) {
          // Skip shiki while streaming: re-highlighting a growing code block on
          // every frame is the renderer's main cost with several agents writing.
          if (!disposed && token === renderToken) setHtml(parsed)
          return
        }
        void enhance(parsed, theme).then((enhanced) => {
          if (!disposed && token === renderToken) setHtml(enhanced)
        })
      },
      streaming ? 80 : 0,
    )
  })

  const onClick = (event: MouseEvent) => {
    const target = event.target as HTMLElement
    if (target.classList.contains("code-copy")) {
      const container = target.closest(".code-block")
      const code = container?.querySelector("code")?.textContent ?? ""
      void navigator.clipboard.writeText(code)
      target.textContent = state.config?.language === "en" ? "copied" : "copiado"
      setTimeout(() => {
        target.textContent = "copy"
      }, 1200)
    }
    const anchor = target.closest("a")
    if (anchor instanceof HTMLAnchorElement && anchor.href.startsWith("http")) {
      event.preventDefault()
      void window.openorch.invoke("shell.openExternal", anchor.href)
    }
  }

  return <div class={`md ${props.class ?? ""}`} innerHTML={html()} onClick={onClick} />
}
