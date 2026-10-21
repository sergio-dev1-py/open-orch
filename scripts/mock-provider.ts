/**
 * Mock OpenAI-compatible provider used by scripts/e2e.ts to verify the full loop
 * (streaming, tool calls, diffs) without real API keys.
 *
 * Usage: bun run scripts/mock-provider.ts [port]
 */
import path from "node:path"

const port = Number(process.argv[2] ?? 8788)
const root = process.cwd()
const outsideFile = path.resolve(process.cwd(), ".data", "e2e", "outside.txt")

interface ChatMessage {
  role: string
  content?: string | Array<{ type: string; text?: string }>
  tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>
  tool_call_id?: string
  name?: string
}

/** Last request seen (body + headers), exposed at GET /last-request for tests. */
let lastRequest: { body: unknown; headers: Record<string, string> } | undefined
/** Recent requests, so tests can look for a specific model instead of the last one. */
const requestHistory: { body: unknown; headers: Record<string, string> }[] = []

function textOf(message: ChatMessage): string {
  if (typeof message.content === "string") return message.content
  if (Array.isArray(message.content)) {
    return message.content.map((part) => part.text ?? "").join("")
  }
  return ""
}

function sse(chunk: unknown): string {
  return `data: ${JSON.stringify(chunk)}\n\n`
}

function chunk(delta: Record<string, unknown>, finish: string | null = null, usage?: unknown): string {
  return sse({
    id: "chatcmpl-mock",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "mock-model",
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  })
}

function streamText(parts: string[]): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      const push = (text: string) => controller.enqueue(encoder.encode(text))
      push(chunk({ role: "assistant", content: "" }))
      for (const part of parts) {
        push(chunk({ content: part }))
        await new Promise((resolve) => setTimeout(resolve, 8))
      }
      push(chunk({}, "stop", { prompt_tokens: 42, completion_tokens: 57, total_tokens: 99 }))
      push("data: [DONE]\n\n")
      controller.close()
    },
  })
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  })
}

function streamToolCall(name: string, args: Record<string, unknown>): Response {
  return streamToolCalls([{ name, args }])
}

function streamToolCalls(calls: { name: string; args: Record<string, unknown> }[]): Response {
  const encoder = new TextEncoder()
  const payloads = calls.map((call, index) => ({ index, name: call.name, payload: JSON.stringify(call.args) }))
  const stream = new ReadableStream({
    async start(controller) {
      const push = (text: string) => controller.enqueue(encoder.encode(text))
      push(chunk({ role: "assistant", content: "" }))
      push(
        chunk({
          tool_calls: payloads.map((entry) => ({
            index: entry.index,
            id: `call_mock_${entry.index + 1}`,
            type: "function",
            function: { name: entry.name, arguments: "" },
          })),
        }),
      )
      let remaining = true
      let offset = 0
      while (remaining) {
        remaining = false
        for (const entry of payloads) {
          const slice = entry.payload.slice(offset, offset + 24)
          if (!slice) continue
          remaining = true
          push(chunk({ tool_calls: [{ index: entry.index, function: { arguments: slice } }] }))
        }
        offset += 24
        await new Promise((resolve) => setTimeout(resolve, 4))
      }
      push(chunk({}, "tool_calls", { prompt_tokens: 30, completion_tokens: 20, total_tokens: 50 }))
      push("data: [DONE]\n\n")
      controller.close()
    },
  })
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  })
}

/** Streams reasoning_content chunks followed by text (exercises the thinking block + replay). */
function streamReasoningText(reasoning: string[], parts: string[]): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      const push = (text: string) => controller.enqueue(encoder.encode(text))
      push(chunk({ role: "assistant", content: "" }))
      for (const piece of reasoning) {
        push(chunk({ reasoning_content: piece }))
        await new Promise((resolve) => setTimeout(resolve, 6))
      }
      for (const part of parts) {
        push(chunk({ content: part }))
        await new Promise((resolve) => setTimeout(resolve, 8))
      }
      push(chunk({}, "stop", { prompt_tokens: 42, completion_tokens: 57, total_tokens: 99 }))
      push("data: [DONE]\n\n")
      controller.close()
    },
  })
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  })
}

const server = Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === "/console-config.json") {
      // Fixture for the OpenCode Console account config: only these models are active
      // for the account; `glm-5.1` is disabled and `hy3` is not listed at all.
      return Response.json({
        providers: {
          opencode: {
            name: "OpenCode",
            models: {
              "exo-free": { name: "Exo Free", family: "exo", cost: [{ input: 0, output: 0, cache: { read: 0 } }] },
              "gpt-5.4": { name: "GPT-5.4", family: "gpt" },
              "mimo-v2.6-flash": { name: "MiMo 2.6 Flash", family: "mimo" },
              "beam-free": { name: "Beam Free", family: "beam", cost: [{ input: 0, output: 0, cache: { read: 0 } }] },
              "glm-5.1": { name: "GLM-5.1", family: "glm", disabled: true },
            },
          },
        },
      })
    }
    if (url.pathname === "/models-dev.json") {
      // Fixture for the live models.dev catalog: a "new" API model with real reasoning levels.
      return Response.json({
        opencode: {
          id: "opencode",
          name: "OpenCode",
          npm: "@ai-sdk/openai-compatible",
          api: `http://127.0.0.1:${port}/v1`,
          models: {
            "beam-free": {
              id: "beam-free",
              name: "beam free",
              family: "beam",
              reasoning: true,
              reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
              tool_call: true,
              temperature: true,
              limit: { context: 200000, output: 32000 },
              cost: { input: 0, output: 0 },
            },
          },
        },
      })
    }
    if (url.pathname === "/v1/models") {
      return Response.json({
        object: "list",
        data: [
          { id: "mock-model", object: "model", created: 0, owned_by: "mock" },
          // Extra model only present at runtime: exercises `/models` discovery.
          { id: "mock-model-mini", object: "model", created: 0, owned_by: "mock" },
        ],
      })
    }
    if (url.pathname === "/last-request") {
      const wanted = url.searchParams.get("model")
      if (wanted) {
        const match = requestHistory
          .filter((entry) => (entry.body as { model?: unknown } | undefined)?.model === wanted)
          .at(-1)
        if (match) return Response.json(match)
      }
      return Response.json(lastRequest ?? null)
    }
    if (url.pathname === "/challenge") {
      // Persistent anti-bot gate for the handoff e2e: only the visible button clears it.
      const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Just a moment...</title></head><body>
<h1>Comprobación de seguridad</h1>
<p>Verificando el navegador…</p>
<button id="solve" onclick="document.title='Tienda verificada';document.body.innerHTML='<h1>ORCH-CHALLENGE-OK</h1>'">Resolver verificación</button>
</body></html>`
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } })
    }
    if (url.pathname === "/shop") {
      // Local store for the agent-browser e2e: fill the quantity, add to cart.
      const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Tienda E2E</title></head><body>
<h1>ORCH-SHOP-OK</h1>
<label for="qty">Cantidad</label>
<input id="qty" aria-label="Cantidad" value="1">
<button id="add" onclick="document.getElementById('result').textContent='En el carrito: '+document.getElementById('qty').value">Agregar al carrito</button>
<p id="result">Sin artículos</p>
</body></html>`
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } })
    }
    if (url.pathname === "/preview" || url.pathname === "/preview2") {
      // Local page for the dock's browser tab (webview e2e).
      const first = url.pathname === "/preview"
      const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${first ? "Vista previa E2E" : "Segunda página E2E"}</title></head><body><h1>${first ? "ORCH-PREVIEW-OK" : "ORCH-PREVIEW-2"}</h1><p>Página local del mock para probar el navegador integrado.</p>${
        first ? `<a id="second" href="/preview2">segunda página</a>` : `<a id="back" href="/preview">volver</a>`
      }</body></html>`
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } })
    }
    if (url.pathname.endsWith("/chat/completions")) {
      const body = (await request.json()) as { messages?: ChatMessage[]; stream?: boolean }
      lastRequest = { body, headers: Object.fromEntries(request.headers.entries()) }
      requestHistory.push(lastRequest)
      if (requestHistory.length > 100) requestHistory.shift()
      const messages = body.messages ?? []
      const lastUserIndex = messages.map((message) => message.role).lastIndexOf("user")
      const lastUser = lastUserIndex >= 0 ? messages[lastUserIndex] : undefined
      const hasToolResult = messages.slice(lastUserIndex + 1).some((message) => message.role === "tool")
      const userText = lastUser ? textOf(lastUser) : ""

      if (userText.includes('"previousAnswers"')) {
        // Scheduled task reviewer: first call asks one question, second call finalizes.
        try {
          const parsed = JSON.parse(userText) as { instruction?: string; previousAnswers?: { answer?: string }[] }
          const instruction = String(parsed.instruction ?? "Revisa el proyecto")
          const answers = (parsed.previousAnswers ?? []).map((entry) => String(entry.answer ?? "")).filter(Boolean)
          if (answers.length === 0) {
            return streamText([
              JSON.stringify({
                title: "Revisa el proyecto",
                clear: false,
                questions: [
                  {
                    header: "Alcance",
                    question: "¿Qué parte del proyecto quieres revisar?",
                    options: [{ label: "Todo el proyecto" }, { label: "Solo el código" }],
                  },
                ],
                finalInstruction: "",
              }),
            ])
          }
          return streamText([
            JSON.stringify({
              title: "Revisa el proyecto",
              clear: true,
              questions: [],
              finalInstruction: `${instruction} Enfócate en: ${answers.join(", ")}. Devuelve un resumen con los hallazgos y los siguientes pasos.`,
            }),
          ])
        } catch {
          // Fall through to the normal mock responses.
        }
      }

      if (!hasToolResult && /instala este mcp|instalar un mcp|añade un mcp/i.test(userText)) {
        // The agent installs an MCP server through the `mcp` tool (config + live reconnect).
        return streamToolCall("mcp", {
          action: "add",
          name: "agentmcp",
          type: "local",
          command: `bun run ${path.join(root, "scripts", "mock-mcp.ts")}`,
        })
      }

      if (!hasToolResult && /reto de prueba|verificaci[oó]n de prueba/i.test(userText)) {
        // The first action lands on a fake anti-bot gate. tabs_open must hand off
        // to the user, wait for the solve, and only then return the page.
        return streamToolCall("execute", {
          code: [
            `const opened = await tools.browser["tabs_open"]({ url: "http://127.0.0.1:${port}/challenge" })`,
            "const tabID = opened.metadata.tabID",
            'const snap = await tools.browser["snapshot"]({ tabID })',
            'return { tabID, ok: snap.output.includes("ORCH-CHALLENGE-OK"), first: snap.output.split("\\n")[0] }',
          ].join("\n"),
        })
      }

      if (!hasToolResult && /compra de prueba|navegador del dock/i.test(userText)) {
        // Drives the dock browser end to end through the agent's browser tools.
        const shop = `http://127.0.0.1:${port}/shop`
        return streamToolCall("execute", {
          code: [
            `const opened = await tools.browser["tabs_open"]({ url: ${JSON.stringify(shop)} })`,
            "const tabID = opened.metadata.tabID",
            'const found = await tools.browser["find"]({ tabID, text: "Cantidad" })',
            'const qty = /ref=(e\\d+)/.exec(found.output)',
            'if (!qty) throw new Error("quantity ref not found: " + found.output)',
            'await tools.browser["fill"]({ tabID, ref: "@" + qty[1], text: "2" })',
            'const add = await tools.browser["find"]({ tabID, text: "Agregar al carrito" })',
            'const addRef = /ref=(e\\d+)/.exec(add.output)',
            'if (!addRef) throw new Error("cart button not found: " + add.output)',
            'const clicked = await tools.browser["click"]({ tabID, ref: "@" + addRef[1] })',
            'return { tabID, cart: /En el carrito: \\d+/.exec(clicked.output)?.[0] ?? "sin resultado" }',
          ].join("\n"),
        })
      }

      if (!hasToolResult && /delegar en un subagente|heredar/i.test(userText)) {
        return streamToolCall("subagent", {
          agent: "explore",
          description: "Explorar con herencia",
          prompt: "Explora este proyecto brevemente. Thoroughness: quick",
        })
      }

      if (!hasToolResult && /contin[uú]a el subagente|continuar el subagente/i.test(userText)) {
        const toolText = messages.filter((message) => message.role === "tool").map((message) => textOf(message)).join("\n")
        const previous = toolText.match(/sessionID="(ses_[A-Za-z0-9]+)"/)
        if (previous) {
          return streamToolCall("subagent", {
            agent: "explore",
            description: "Continuar exploración",
            prompt: "Continúa explorando el proyecto.",
            sessionID: previous[1],
          })
        }
      }

      if (!hasToolResult && /nieto|grandchild|servidor persistente/i.test(userText)) {
        // A long-running process (the `start` case is covered by check-core): the tool
        // must time out and kill the tree instead of hanging forever.
        const command = process.platform === "win32" ? 'node -e "setInterval(()=>{},1000)"' : "sleep 30"
        return streamToolCall("shell", { command, timeout: 4000 })
      }

      if (!hasToolResult && /preguntas|cuestionario|config[uú]rame/i.test(userText)) {
        return streamToolCall("question", {
          questions: [
            {
              question: "¿Qué stack prefieres para la app?",
              header: "Stack",
              options: [
                { label: "FastAPI + React/Vite (Recomendado)", description: "Python con SQLAlchemy y frontend React moderno." },
                { label: "Flask + Jinja2", description: "Server-rendered con un poco de JavaScript." },
                { label: "Node/Express + React", description: "JavaScript en todo el stack." },
              ],
            },
            {
              question: "¿Qué funcionalidades quieres incluir?",
              header: "Features",
              multiple: true,
              options: [
                { label: "Autenticación", description: "Registro y login de usuarios." },
                { label: "Carrito de compras", description: "Carrito persistente por sesión." },
                { label: "Panel de administración", description: "Gestión de productos y stock." },
              ],
            },
            {
              question: "¿En qué idioma y moneda va la interfaz?",
              header: "Idioma",
              options: [
                { label: "Español / EUR", description: "Interfaz en español, precios en euros." },
                { label: "English / USD", description: "Interfaz en inglés, precios en dólares." },
              ],
            },
          ],
        })
      }

      if (!hasToolResult && /paralelo|subagent|subagente|delegar/i.test(userText)) {
        return streamToolCalls([
          {
            name: "subagent",
            args: {
              agent: "explore",
              description: "Explorar el repositorio",
              prompt: "Explora este proyecto y dime cuántos archivos hay. Thoroughness: quick",
            },
          },
          {
            name: "subagent",
            args: {
              agent: "general",
              description: "Resumir el proyecto",
              prompt: "Lee package.json y resume el proyecto en una frase.",
            },
          },
        ])
      }

      if (!hasToolResult && /fuera de la carpeta|archivo externo/i.test(userText)) {
        return streamToolCall("read", { path: outsideFile })
      }

      if (!hasToolResult && /razonamiento|reasoning|piensa|thinking/i.test(userText)) {
        return streamReasoningText(
          ["Voy a pensar paso a paso. ", "Primero verifico el contexto, ", "luego respondo de forma concisa."],
          ["Pensé el problema y esta es mi ", "respuesta final con **formato**."],
        )
      }

      if (!hasToolResult && /codemode|worktree|execute/i.test(userText)) {
        return streamToolCall("execute", {
          code: [
            'const created = await tools.opencode["worktree_create"]({ name: "demo" })',
            'const list = await tools.opencode["worktree_list"]({})',
            'console.log("created:", created)',
            "return list",
          ].join("\n"),
        })
      }

      if (!hasToolResult && /ancho|wide|tabla|scroll|desborde/i.test(userText)) {
        const longUrl = `https://example.com/${"segmento-muy-largo-".repeat(12)}fin`
        return streamText([
          "Aquí va una respuesta con contenido ancho para verificar el scroll.\n\n",
          "```ts\n",
          `const configuracionSuperLarga = ${JSON.stringify({ clave: "valor".repeat(30) })}\n`,
          "function calcularAlgoMuyLargo(argumentoUno: string, argumentoDos: number, argumentoTres: boolean): string {\n",
          '  return argumentoUno.repeat(argumentoDos) + String(argumentoTres)\n',
          "}\n",
          "```\n\n",
          "| Columna extremadamente larga número uno | Columna extremadamente larga número dos | Columna extremadamente larga número tres |\n",
          "| --- | --- | --- |\n",
          `| ${"dato".repeat(20)} | ${"dato".repeat(20)} | ${"dato".repeat(20)} |\n\n`,
          `URL larga: ${longUrl}\n`,
        ])
      }

      if (!hasToolResult && /escribe|write\b|crea un archivo|crear archivo/i.test(userText)) {
        const target = userText.match(/[\w./-]+\.(md|txt|ts|js|py|json)/)?.[0] ?? "MOCK_NOTES.md"
        const stamp = new Date().toISOString()
        return streamToolCall("write", {
          path: target,
          content: `# Nota generada por el mock\n\nContenido de prueba para verificar el flujo completo.\n\n- item uno\n- item dos\n- generado: ${stamp}\n`,
        })
      }

      if (!hasToolResult && /lee|read|archivo existente|package\.json/i.test(userText)) {
        return streamToolCall("read", { path: "package.json" })
      }

      if (!hasToolResult && /comando|shell|ejecuta/i.test(userText)) {
        return streamToolCall("shell", { command: "echo hola desde el mock" })
      }

      const reply = [
        "¡Listo! ",
        "He completado la tarea solicitada.\n\n",
        "### Resumen\n\n",
        "- Verifique el flujo de streaming en tiempo real\n",
        "- Renderice **markdown** con `código` inline\n\n",
        "```ts\nconst saludo = \"hola\"\nconsole.log(saludo)\n```\n\n",
        hasToolResult ? "El comando se ejecuto correctamente." : "Sin herramientas necesarias.",
      ]
      return streamText(reply)
    }
    return new Response("not found", { status: 404 })
  },
})

console.log(`mock provider listening on http://127.0.0.1:${server.port}/v1`)
