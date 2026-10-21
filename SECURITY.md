# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security vulnerability. Use GitHub's
private vulnerability reporting for this repository, or contact the maintainer
through the GitHub profile linked in the repository metadata. Include a concise
reproduction, the affected version or commit, and the impact.

## Local data and credentials

OpenOrch is local-first. Provider API keys, MCP authentication tokens, the
browser bridge token, session databases, and local skill/agent configuration are
stored under the application's data directory:

- Windows: `%APPDATA%\OpenOrch\data`
- macOS: `~/Library/Application Support/OpenOrch/data`
- Linux: `~/.config/OpenOrch/data`

These files are not part of this repository. The app stores provider credentials
in its local `config.json`; they are protected by the operating system account,
not by application-level encryption. Do not post these files, screenshots that
contain keys, or the contents of `browser-bridge.json` in issues or pull
requests.

## Browser extension

The optional extension uses `chrome.debugger` and has broad host permissions so
the agent can work with the user's real browser session. It is intended for
manual, developer-mode installation, operates only on tabs in the `OpenOrch` tab
group, and requires the local bridge token. Use it only on sites and accounts
you trust. CAPTCHA, login, 2FA, and payment handoffs remain under user control.

## Scheduled tasks

Scheduled runs auto-approve ordinary permission prompts so they can run
unattended. Destructive shell commands are blocked by a denylist, and
CAPTCHA/login/payment questions pause the run. This is a safety measure, not a
sandbox for untrusted code. Only schedule instructions you are prepared to run
on your machine.
