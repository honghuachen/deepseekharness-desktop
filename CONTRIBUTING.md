English | [中文](CONTRIBUTING.zh.md)

# Contributing to DSH Web

Thanks for taking the time to contribute. This project is a thin, cross-platform (macOS + Windows) Electron container around the official [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — see [README.md](README.md) for the full architecture and feature set before diving in.

## Getting set up

```bash
npm install          # Electron and other devDependencies
npm run fetch-tools  # downloads vendor/pnpm + vendor/node (portable Node), idempotent
npm start             # launches the app in dev mode
```

Run the fast test suite before you start, so you know the baseline is green:

```bash
npm test
```

## Project layout

Read the "Project structure" section of [README.md](README.md) first — it maps every file under `src/main/` and `scripts/` to what it does. A few things worth knowing up front:

- `src/main/**` is plain CommonJS, no build step. `src/main/token-usage/` is the one exception with a `.html` file (the stats window's UI), which is loaded directly via `BrowserWindow.loadFile`.
- There's no linter or formatter configured. Match the style of the file you're editing rather than reformatting wholesale.
- Comments in `src/main/**` are written in Chinese, explaining *why* something is done a certain way (a non-obvious constraint, a workaround, an invariant) rather than restating *what* the code does. Please follow that convention for new code in the same files — don't switch a file's comment language mid-file, and don't add comments that just narrate the next line.

## Making a change

1. Fork the repo and create a branch off `main`. There's no fixed branch-naming scheme; something descriptive like `fix/session-scan-crash` or `feat/token-usage-export` is fine.
2. Keep the change focused. A bug fix shouldn't carry unrelated refactors; a new feature shouldn't rewrite adjacent code that already works.
3. Add or update tests where it makes sense — see [Testing](#testing) below. Not every change needs a new test script, but a change to `src/main/token-usage/**` or `src/main/plugin-guard.js` almost certainly should touch the corresponding `scripts/*-test.mjs` / `scripts/test-*.mjs` file.
4. For anything touching the UI (the stats window, the plugin manager window, the status window), actually run `npm start` and click through the change before opening a PR — passing tests verify logic, not that the feature works in the real app.
5. Open a PR against `main`. Describe *why* the change is needed, not just what changed (the diff already shows that), and note what you tested.

## Commit message convention

This repo follows [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <short summary, imperative mood, no trailing period>

<optional body — explain *why*, not *what*; the diff already shows what>

<optional footer — e.g. "Fixes #12">
```

**Types:**

| Type | When to use it |
| --- | --- |
| `feat` | A new user-facing capability |
| `fix` | A bug fix |
| `docs` | Documentation only (README, this file, code comments) |
| `refactor` | Restructuring code with no behavior change |
| `perf` | A performance improvement |
| `test` | Adding or fixing tests, no production code change |
| `build` | Packaging/build tooling (`electron-builder.yml`, `scripts/fetch-tools.mjs`, `package.json` scripts) |
| `chore` | Anything else that doesn't fit the above (dependency bumps, `.gitignore`, etc.) |

**Scope** is optional but encouraged for anything under `src/main/token-usage/`, `src/main/plugin-guard.js`/`plugin-manager.js`, or `src/main/updater.js`/`runner.js` — e.g. `feat(token-usage): ...`, `fix(plugin-guard): ...`. Skip it for changes that touch several unrelated areas at once.

**Examples from this repo's own history:**

```
feat: add DeepSeek Harness token/cost usage stats window

Ports the token/cost usage tracking from ClaudeCodeMacTools (native
Swift menu-bar app) into this cross-platform Electron shell: scans
~/.dsh/sessions, decrypts/parses session transcripts, dedupes,
aggregates by project/model/session, and estimates cost against an
editable pricing table. Adds a "Token 用量统计…" menu item that opens
a dedicated stats window.
```

A one-line commit is perfectly fine for small, self-explanatory changes (`fix: correct off-by-one in yesterday() date range`) — the body is for when the *why* isn't obvious from the diff alone.

## Testing

```bash
npm test          # fast regression suite — no network required
npm run test:e2e  # full update-engine flow against the real npm registry (slower)
```

`npm test` runs the following, all headless and network-free:

- `scripts/badge-test.mjs` — the task-completion badge watcher
- `scripts/plugin-guard-test.mjs` — the third-party plugin guard
- `scripts/test-plugin-update.mjs` — third-party plugin update logic
- `scripts/test-token-usage.mjs` — the token usage module, including a byte-for-byte decompression regression against a real local session file when one is available (it skips gracefully otherwise)

If you're adding a new pure-logic module under `src/main/`, add a matching `scripts/*.mjs` script in the same self-contained, `assert`-based style (no test framework is used) and wire it into the `test` script in `package.json`.

## Reporting issues

When filing an issue, include: your OS and app version (Menu → About DSH Web shows both the container and kernel versions), what you expected vs. what happened, and the relevant lines from the log file (Menu → Open Log Folder).

## License

By contributing, you agree that your contributions will be licensed under the project's [MIT license](LICENSE).
