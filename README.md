English | [中文](README.zh.md)

# DSH Web — Desktop Container for the Official DeepSeek Harness

An extremely thin, cross-platform (macOS + Windows) desktop container: **the window always runs the official [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) web shell** — the container itself ships no business UI of its own.

Core capability: **it automatically checks for and updates to the latest official release on every launch.**

```
┌─────────────────────────────────────────────────────┐
│  DSH Web.app (thin Electron shell)                   │
│                                                       │
│  1. Query npm registry: @deepseek-ai/dsh latest      │
│  2. New version found → pnpm-install into versions/  │
│  3. Atomically flip the `current` symlink → rollback │
│  4. Launch the official `dsh web` service            │
│     (127.0.0.1:<port>)                               │
│  5. Window loads the official page ← 100% official   │
└─────────────────────────────────────────────────────┘
```

## Design principles

| Decision | Rationale |
| --- | --- |
| The shell has zero business logic — only "update + launch + open window" | The upstream project iterates fast; a thin shell never conflicts with it |
| Each runtime version installs into its own directory, switched via a symlink | An upgrade that fails rolls back instantly; old versions stay around for rollback |
| pnpm's build-script allowlist (`allowBuilds`) is pre-configured | Only known native modules (node-pty/koffi, etc.) are allowed to run install scripts |
| A portable Node v22 ships with the app | No dependency on the system Node version; ABI stays consistent with native modules |
| The data directory is independent of the shell | Session data lives in `~/.dsh`; upgrading or reinstalling the shell never touches it |

## Quick start

### Development mode

```bash
npm install          # install Electron and other devDependencies
npm run fetch-tools  # download vendor/pnpm + vendor/node (portable Node)
npm start
```

The first launch downloads the official runtime (roughly 1–2 minutes, depending on your network); afterwards it only downloads again when a new version is available.

### Building the app

```bash
npm run dist         # produces macOS (dmg/zip) + Windows (NSIS installer/zip)
```

One build covers both platforms (electron-builder cross-builds the Windows target directly on macOS):

| Platform | Artifacts |
| --- | --- |
| macOS arm64 | `DSH Web-<ver>-arm64.dmg` / `-mac.zip` |
| Windows x64 | `DSH Web-Setup-<ver>-x64.exe` / `-win.zip` |

Windows notes:

- Unsigned — the first run triggers a SmartScreen prompt ("Run anyway" is fine); the installer runs in per-user mode with a selectable install directory.
- A portable `node.exe` and pnpm ship inside the package; version switching uses NTFS junctions (no admin privileges needed), falling back to a pointer file in restricted environments.
- The task-completion badge shows up as a taskbar overlay number; parsing session logs for it depends on the system `zstd` command (if missing, the badge feature silently degrades — install it with `scoop install zstd` if you want it).

## Update mechanism

On every launch:

1. `GET https://registry.npmjs.org/@deepseek-ai/dsh/latest` to fetch the latest version;
2. Compare it against the currently active local version using semver (pre-release ordering like `-rc.N` is supported);
3. If newer: download and install into `<data dir>/runtime/versions/v<version>/`, then atomically flip the `runtime/current` symlink over to it on success; on failure, the previous version stays active;
4. Auto-cleanup: only the 2 most recent versions are kept.

Offline: the check is skipped and the already-installed version is used directly; an error is only raised if there's no installed version at all and the machine is offline.

Manual trigger: menu **DSH Web → Check for Updates…** (⌘U); once downloaded you can apply it immediately or defer to the next launch.

The **About DSH Web** menu item shows both the container's own version and the "kernel" version (the currently active version of the official `@deepseek-ai/dsh` runtime).

## Directory layout

```
<data dir>/                        # ~/Library/Application Support/DSH Web when packaged; .data/ under the repo in dev
├── runtime/
│   ├── versions/v0.1.1-rc.2/     # each version gets its own full node_modules
│   └── current -> versions/v0.1.1-rc.2
├── pnpm-store/                    # content-addressed store, deduplicated across versions
├── logs/app-YYYY-MM-DD.log        # runtime logs
└── settings.json                  # user configuration
```

## Configuration

`settings.json` (openable from the menu):

```json
{
  "port": 43130,             // web service port; auto-probes forward if taken
  "channel": "latest",       // update channel (currently only npm's `latest`)
  "autoCheckUpdates": true,  // disable to skip the update check on every launch
  "dshHome": "",             // empty = the official standard ~/.dsh; point elsewhere to isolate data
  "taskBadge": true          // show a completed-task count badge on the Dock/taskbar icon
}
```

## Data relationship with third-party shells

By default the app uses the official standard data directory `~/.dsh`, so session history is fully interoperable with the official CLI.

Third-party containers (e.g. the older DSH Desktop) may push community plugins into a profile through a plugin marketplace. These are often incompatible with newer official releases and can crash the web service on startup (showing up as a blank white window). To address that, this app provides:

1. **A plugin manager** (menu: DSH Web → Manage Third-Party Plugins…): browse every plugin under a profile, distinguish official vs. third-party and where each is referenced (bundle, patch layer), and remove selected ones precisely. Removal requires confirmation, and the original files are automatically backed up under the profile's `.sanitized-backup-*` directory.
2. **Automatic cleanup on first launch**: if the web profile has been contaminated, it's restored to the official default shape, while user-level configuration for official components (e.g. the Funplay MCP) is preserved.
3. **Crash self-healing**: the service auto-restarts if it exits unexpectedly; if it has never been cleaned before, cleanup runs first, then it restarts.

> Note: the `desktop` profile belongs to the older DSH Desktop. Removing plugins from it will break that older shell's marketplace features (that's the intended effect of decontamination) — quit the older shell first if you still use it. To install a plugin, use the official method: `dsh plugin --profile <name> add <package>`.

## Token usage & cost stats

Menu **DSH Web → Token 用量统计…** (⌘⇧T) opens a dedicated window that tallies token usage and estimated cost across every session under `~/.dsh/sessions`:

- **Time range**: today / yesterday / this week / this month / all time / a custom range
- **Grouping**: by project (folded up to the repository root along `.git`, worktrees included) / by model / by session (capped at the 50 most recently active)
- Each row shows total tokens, cache hit rate, and estimated cost; the by-model/by-session views additionally break the cost down into input/output/cache-write/cache-read
- Clicking a project or session row opens its folder in Finder (Explorer on Windows)
- The window re-scans automatically every 60 seconds while open

**Cost estimates come from a local, editable pricing table.** The first time the window opens, the bundled `pricing.default.json` is copied to `pricing.json` in the app's data directory; from then on only that user copy is read/written (an app update never overwrites it). DeepSeek Harness can route to any provider/model — real-world usage has included OpenRouter, SenseNova, Zhipu, and Google models, for example — and this table only ships pricing for DeepSeek's own official models; every other model shows as "unknown pricing" until you add its rate using the same JSON shape. DeepSeek's official API also prices differently during UTC peak/off-peak windows; this only uses the (lower) off-peak rate as a single approximation, so the cost shown is an **estimate (≈)**, not an exact bill.

**Performance and cross-platform support**: decompressing `.zstd` session logs prefers the system-installed `zstd` CLI when available (roughly an order of magnitude faster in practice), and falls back to the pure-JS [`fzstd`](https://www.npmjs.com/package/fzstd) library otherwise — a case that mainly shows up on Windows machines without extra command-line tools installed. Neither path needs any native compilation, so it works correctly on Windows too. The whole scan/decompress/parse pipeline runs on a dedicated worker thread and never blocks the main process or the UI.

## Notes

- **Don't run two DSH containers at once** (e.g. the older DSH Desktop.app): both share the `~/.dsh` session data, and concurrent writes are risky. After migrating to this app, quit or remove the old shell.
- The default port is `43130`, chosen to avoid colliding with the old DSH Desktop's `43120`.
- Native modules (node-pty, koffi) all use official prebuilt binaries — no Xcode command line tools required.
- To distribute the app to others, configure Apple code signing (the `CSC_LINK` environment variable) before running `npm run dist` again.

## Project structure

```
src/main/
├── main.js              # startup orchestration, windows, menu, lifecycle, crash self-healing
├── config.js            # paths and constants (registry URL, build allowlist)
├── updater.js           # update engine: check/install/atomic-swap/cleanup (pure Node, testable)
├── runner.js            # official service process management: launch/double health check/graceful exit
├── plugin-guard.js      # third-party plugin guard: surgically restores an official profile
├── plugin-manager.js    # third-party plugin manager window
├── badge.js             # task-completion Dock/taskbar badge watcher
├── semver.js            # pre-release-aware version comparison
├── status-window.js     # startup progress window (plain text, not the product UI)
├── logger.js            # file logging
└── token-usage/         # token usage stats: scan/decompress/parse/dedupe/aggregate/pricing/window
    ├── scanner.js        # recursively find session.jsonl(.zstd)
    ├── decompress.js     # prefers system zstd, falls back to pure-JS fzstd
    ├── parser.js         # parses session events into usage records
    ├── dedup.js          # dedupes by requestId (streaming snapshots repeat the same request)
    ├── aggregator.js     # aggregates by project/model/session + estimates cost
    ├── pricing.js        # pricing table loading (bundled default + user-editable copy)
    ├── cache.js           # incremental cache keyed by file mtime/size
    ├── scan-worker.js     # runs the actual scan on a worker thread, off the main process
    ├── service.js         # orchestrates the steps above
    ├── window.js          # the stats window + its IPC handlers
    └── stats-window.html  # the stats window's UI
scripts/
├── fetch-tools.mjs        # build-time download of pnpm/portable Node into vendor/
├── e2e-update-test.mjs    # headless end-to-end test (hits the real registry, full chain)
├── test-plugin-update.mjs # self-test for third-party plugin update logic
├── test-token-usage.mjs   # self-test for the token usage module (incl. a real-file decompression regression)
├── badge-test.mjs         # self-test for the task-completion badge
├── plugin-guard-test.mjs  # self-test for the plugin guard
├── repair-session.mjs     # repairs sequence numbers in a corrupted session.jsonl(.zstd)
└── verify-session-file.cjs # verifies a session file's zstd framing / sequence continuity
```

## Testing

```bash
npm test          # fast regression suite: badge / plugin guard / plugin update / token usage (no network needed)
npm run test:e2e  # end-to-end update flow test (hits the real npm registry, slower)
```

## Contributing

Issues and PRs are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) first (it covers the dev workflow and the commit message convention).

## License

[MIT](LICENSE)
