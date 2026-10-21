# Contributing to OpenOrch

Thanks for helping improve OpenOrch. The project is an open-source desktop agent
harness; please keep changes focused and include a clear description of the
problem you are solving.

## Development setup

```bash
git clone https://github.com/sergio-dev1-py/open-orch.git
cd open-orch
bun install
bun run dev
```

Requirements: Bun 1.4+, Node.js 20+ (Electron is installed through Bun), and
Git. The app is local-first and does not need a `.env` file or a cloud account.
Configure model providers from **Settings → Providers**.

## Checks before opening a pull request

```bash
bun run typecheck
bun run check:core
bun run check:schedule
bun run check:bridge
bun run e2e
```

The e2e suite starts a fake provider and creates `.data/` (ignored). It is
currently Windows-oriented because it exercises PowerShell, cmd, and the dock
browser; the core checks are platform-neutral. Close any running OpenOrch
instance before running e2e because the app uses a single-instance lock.

## Branches and pull requests

`main` is the stable branch. Do not push feature work directly to `main`.

```bash
git switch main
git pull --ff-only
git switch -c feat/short-description

# Edit and test
git add .
git commit -m "feat: describe the change"
git push -u origin feat/short-description
```

Open a pull request against `main`, describe the change and the checks you ran,
and wait for review. Small, focused pull requests are easier to review than a
mix of unrelated changes.

Recommended branch names:

- `feat/...` for new behavior
- `fix/...` for bug fixes
- `docs/...` for documentation
- `refactor/...` for internal changes
- `test/...` for test-only changes

## Security and local data

Never commit API keys, `.data/`, `openorch.db`, provider credentials, MCP auth
tokens, browser profiles, or local skill/agent configuration. They are ignored
by `.gitignore`, but check the staged diff before committing. See
[SECURITY.md](SECURITY.md) for details.

## Code style

- Keep TypeScript strict and run `bun run typecheck`.
- Follow the existing package and component structure.
- Prefer small, readable changes over broad rewrites.
- Do not add generated build output to the repository.
- Keep user-facing strings in the existing `i18n.ts` dictionaries; the app
  supports Spanish and English.

## License

By contributing, you agree that your contribution is licensed under the MIT
License in [LICENSE](LICENSE). Third-party material keeps its original license;
see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
