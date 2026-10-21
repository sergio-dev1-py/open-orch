<p align="center">
  <img src="docs/screenshots/openorch.png" alt="OpenOrch desktop app with the chat, workspace sidebar, and browser dock open" width="100%" />
</p>

<h1 align="center">OpenOrch</h1>

<p align="center">
  <strong>A local-first desktop AI coding agent.</strong><br />
  Plan, build, browse, and schedule work with your own models, from one desktop workspace.
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-yellow.svg" /></a>
  <img alt="Bun 1.4+" src="https://img.shields.io/badge/Bun-1.4%2B-black?logo=bun" />
  <img alt="Electron" src="https://img.shields.io/badge/Electron-44-47848F?logo=electron" />
  <img alt="SolidJS" src="https://img.shields.io/badge/SolidJS-1.9-2C4F7C?logo=solid" />
  <img alt="Status: alpha" src="https://img.shields.io/badge/status-alpha-orange" />
</p>

<p align="center">
  <strong>English</strong> · <a href="README.es.md">Español</a>
</p>

> OpenOrch is an independent open-source project inspired by [OpenCode](https://github.com/anomalyco/opencode).
> It is not affiliated with, endorsed by, or sponsored by the OpenCode team.

## Why OpenOrch

OpenOrch is a desktop harness for coding agents, built around your own machine and
your own model accounts. It combines a chat workspace, permissioned tools, a real
browser dock, and local automations without turning your code into a cloud
service.

- **Local-first by default.** Sessions, messages, settings, permissions, and
  scheduled tasks live on your computer. No account or hosted workspace is
  required.
- **Bring your own provider.** Connect Anthropic, OpenAI, Google, DeepSeek, xAI,
  Groq, Mistral, Cerebras, Together, OpenRouter, OpenCode Zen/Go, or any
  OpenAI-compatible endpoint.
- **Real developer tools.** Shell, file read/write/edit, glob, ripgrep search,
  web search, fetch, MCP, worktrees, and subagents, all behind configurable
  permissions.
- **Browser control that you can see.** Use the isolated dock browser or connect
  the optional Edge/Chrome extension to work in your real browser session, only
  on tabs in the `OpenOrch` group.
- **Local scheduled tasks.** Create a task, choose a workspace and model, and
  let it run from the tray at the scheduled time. Pause, resume, run now, or
  delete it from the task menu.
- **Plan, Build, and Code Mode.** Switch between a read-only planning agent and
  the full build agent; Code Mode lets the model compose tool calls in a
  confined JavaScript runtime.

## Quick start

### Requirements

- **Bun 1.4+** (`packageManager`: `bun@1.4.2`)
- **Node.js 20+** for tooling and Electron
- **Git**
- Windows, macOS, or Linux with a desktop session

### Run from source

```bash
git clone https://github.com/sergio-dev1-py/open-orch.git
cd open-orch
bun install
bun run dev
```

The first install downloads the Electron binary. If your environment blocks the
download, run the installer printed by Bun/Electron, then retry `bun run dev`.

Open **Settings → Providers**, paste the API key for the provider you want to
use, and save it. There is no `.env` file to fill in; credentials are stored only
in the app's local data directory.

### Verify the checkout

```bash
bun run typecheck
bun run check:core
bun run check:schedule
bun run check:bridge
bun run e2e
```

| Command | What it covers |
|---|---|
| `bun run typecheck` | TypeScript for shared, core, and desktop |
| `bun run check:core` | Agent loop, providers, tools, permissions, compaction, catalog |
| `bun run check:schedule` | Timezone math, task store, scheduler safety |
| `bun run check:bridge` | Browser extension bridge protocol |
| `bun run e2e` | Electron UI, tools, browser dock, MCP, scheduled tasks, sessions |

`bun run e2e` uses fake providers and MCP servers, and writes temporary data to
`.data/` (ignored by Git). It is currently Windows-oriented because it exercises
PowerShell, cmd, and the dock browser; close any running OpenOrch instance first
because the app uses a single-instance lock.

### Build

```bash
bun run --cwd apps/desktop build
```

The build output goes to `apps/desktop/out/` and is intentionally ignored. There
is no installer configuration yet; run the development app or the compiled
Electron app from the repository.

## What is inside

```text
apps/desktop       Electron main process, preload, and SolidJS renderer
packages/shared    Shared TypeScript types and IPC contracts
packages/core      Agent engine, providers, tools, permissions, MCP, sessions
extensions/         Optional MV3 extension for Edge/Chrome
scripts/            Builders, fake providers, and the test suites
```

The core engine is provider-agnostic and uses the AI SDK. The desktop app owns the
window, local SQLite storage, OS integration, the browser bridge, and notifications.

## Browser control

OpenOrch offers two browser modes:

1. **Dock browser** — an isolated Electron `<webview>` inside the app. It is the
   easiest way to let the agent browse without touching your personal browser
   profile.
2. **Edge/Chrome extension** — an optional MV3 extension that connects to a local
   WebSocket bridge. It uses `chrome.debugger` to work on a tab group named
   `OpenOrch`, so the rest of your browser remains outside the agent's scope.

The extension source is in [`extensions/openorch-browser`](extensions/openorch-browser)
(6 files, about 43 KB). It requests `debugger`, `tabs`, `tabGroups`, `storage`,
`alarms`, `windows`, and `<all_urls>` because it must be able to control a tab on
any site you explicitly add to the group. The bridge listens only on
`127.0.0.1` and requires the pairing code shown in **Settings → Browser**.

Install it for local use:

1. Open `edge://extensions` (or `chrome://extensions`).
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select `extensions/openorch-browser`.
4. Copy the pairing code from OpenOrch → Settings → Browser.
5. Paste it into the extension popup and connect.

CAPTCHA, login, 2FA, and payment handoffs stay with the user. The extension does
not solve CAPTCHAs, fill passwords, or read tabs outside the `OpenOrch` group.
Cookies, browser profiles, pairing tokens, and bridge state are local and are
never part of this repository.

## Scheduled tasks

Scheduled tasks are local automations, not cloud jobs.

- Choose a workspace, instruction, repetition, time, model, effort, and whether
  each run should use a new chat.
- Tasks are saved immediately in the task window; the instruction is executed as
  written. There is no separate review round.
- The scheduler checks every 30 seconds. A run can start up to about 30 seconds
  after the selected minute, and runs execute one at a time.
- A session is created when the task starts, in the configured workspace. If
  **new chat per run** is disabled, the task reuses its session.
- Open the `⋯` menu on a task to pause/resume, run now, or delete it. Delete asks
  for confirmation, removes the schedule and run history, and keeps chat sessions
  that already ran.
- Pausing the last background task also turns off **Run on this computer** and
  the Windows login item, so closing the window can quit the app normally.
- While a workspace is working, its folder and the specific session show a
  subtle green status. If the agent is waiting for a permission or an answer,
  they turn amber until you respond.

The app must be running, or start with Windows/tray mode enabled, at the scheduled
time. If the computer was off, missed runs are recovered within a 24-hour grace
period on the next launch.

## Local data and privacy

On Windows, application data is stored under `%APPDATA%\OpenOrch\data`; macOS and
Linux use the standard application-data directory. Depending on what you use, it
contains:

- `openorch.db` — sessions, messages, permission rules, tasks, and run history
- `config.json` — settings and provider credentials
- `browser-bridge.json` — the local browser-extension pairing token
- `mcp-auth.json` — MCP OAuth credentials
- local skills, agents, MCP configuration, and model preferences

These files are intentionally ignored by Git. Provider keys are stored in the
local config so the app can call the provider; they are protected by your OS
account rather than application-level encryption. Do not share this directory or
screenshots containing keys.

The repository does not include analytics or telemetry code. Network requests
happen only when you use a provider, web search/fetch, MCP server, or browser
feature. The agent's actions remain subject to the permission rules you configure.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) for setup, checks, and pull-request
expectations. Work on a branch and open a pull request; `main` is kept stable.

```bash
git switch main
git pull --ff-only
git switch -c feat/short-description
# edit and test
git add .
git commit -m "feat: describe the change"
git push -u origin feat/short-description
```

Then open a pull request against `main`. Enable branch protection on GitHub to
require a pull request and prevent direct pushes.

## License and credits

OpenOrch is released under the [MIT License](LICENSE).

Some built-in prompts and agent text are derived from
[OpenCode](https://github.com/anomalyco/opencode) (MIT). The required notice and
attribution are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The embedded
model catalog is derived from models.dev data. OpenOrch is independent and is not
affiliated with OpenCode, DeepSeek, or Open Design.

If OpenOrch is useful to you, issues and focused pull requests are welcome.
