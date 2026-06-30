# Trilkeep

<p align="center">
  <img src="assets/icon.png" alt="Trilkeep logo" width="128" />
</p>

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![VS Code Marketplace](https://img.shields.io/badge/VS%20Code%20Marketplace-Install-007ACC?logo=visualstudiocode&logoColor=white)](https://marketplace.visualstudio.com/items?itemName=kalmigs.trilkeep)
[![Open VSX](https://img.shields.io/open-vsx/v/kalmigs/trilkeep?label=Open%20VSX&logo=eclipseide)](https://open-vsx.org/extension/kalmigs/trilkeep)
[![VS Code Engine](https://img.shields.io/badge/VS%20Code-%5E1.90.0-007ACC?logo=visualstudiocode&logoColor=white)](https://code.visualstudio.com)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![CI](https://github.com/kalmigs/trilkeep/actions/workflows/ci.yml/badge.svg)](https://github.com/kalmigs/trilkeep/actions/workflows/ci.yml)
[![GitHub Release](https://img.shields.io/github/v/release/kalmigs/trilkeep?style=flat&logo=github&label=release)](https://github.com/kalmigs/trilkeep/releases/latest)
[![GitHub Downloads](https://img.shields.io/github/downloads/kalmigs/trilkeep/total?style=flat&logo=github&label=downloads)](https://github.com/kalmigs/trilkeep/releases)
[![GitHub Stars](https://img.shields.io/github/stars/kalmigs/trilkeep?style=flat&logo=github)](https://github.com/kalmigs/trilkeep/stargazers)

*Mirror your notes to Trilium.*

A VS Code extension that mirrors your notes workspace into [Trilium](https://github.com/TriliumNext/trilium)
via the [ETAPI](https://docs.triliumnotes.org/user-guide/advanced-usage/etapi) (Trilium's External API).

The local workspace stays the source of truth; Trilkeep writes a one-way copy into Trilium.

## Features

- **One-way backup into Trilium.** A batched full backfill on the first run, then
  incremental hash-diff runs that upload only changed files and never duplicate notes.
- **Lossless Markdown.** Files are stored as Trilium code notes (`text/x-markdown`)
  byte-for-byte; folders become container notes that recreate your tree.
- **Backup on save (opt-in).** Back up changed files automatically as you save.
- **Read-only mirror (on by default).** The mirror renders read-only in Trilium so
  you don't accidentally edit it. You can make it editable (`trilkeep.readOnly: false`),
  but the workspace stays the source of truth, so any changes you make in Trilium are
  overwritten on the next backup. (True two-way sync is a longer-term
  [roadmap](#roadmap) idea, not a current capability.)
- **Secure token storage.** Your ETAPI token is kept in VS Code SecretStorage, never
  written to `settings.json` or any file you could commit by accident.
- **Zero runtime dependencies.** Built on Node's `fetch` and `crypto`, with a 7-day
  dependency cooldown on the dev toolchain.

## Status

**v1: workspace-to-Trilium backup.** One batched full backfill on the first run,
then incremental (only changed files) afterward. The ETAPI client is verified
against the Trilium ETAPI OpenAPI spec.

## Requirements

- **VS Code 1.90** or later.
- **Desktop VS Code.** The extension uses Node APIs (filesystem + crypto), so it
  doesn't run in the browser-only web editor (vscode.dev / github.dev).
- A reachable **Trilium server with ETAPI enabled** (see Setup).

## Setup

Install Trilkeep from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=kalmigs.trilkeep) or [Open VSX](https://open-vsx.org/extension/kalmigs/trilkeep), then:

1. Run Trilium and open **Options → ETAPI**, then generate a token.
2. In VS Code, run **`Trilkeep: Setup`**, a quick wizard for the essentials
   (connection name, server URL, token, on-save). For the rest (globs, grouping,
   read-only, hard-delete), run **`Trilkeep: Setup (Advanced)`**, which walks every
   setting. Both pre-fill the current values, so you can re-run either any time to
   review or change config. The token is stored in VS Code SecretStorage (never in
   settings) and is never displayed. Give each Trilium instance a distinct
   **connection name** (the token + backup state are keyed by it, so the URL can
   change freely). Renaming a connection in Setup offers to carry the existing
   backup over or start fresh.
3. Run **`Trilkeep: Back Up Workspace`** to back up.

Prefer to configure by hand? Set `trilkeep.serverUrl` in VS Code **Settings**
(`Cmd`/`Ctrl`+`,`, switch to the **Workspace** tab so it saves per-repo like Setup
does, then search "trilkeep", or edit `.vscode/settings.json` directly), run
**`Trilkeep: Set ETAPI Token`**, then **`Trilkeep: Test Connection`** to confirm.

## How the backup works

A state manifest at `<workspace>/.trilkeep/state.json` maps every backed-up
file to the Trilium `noteId` it became plus a `sha256` of its content. That
manifest is what makes incremental backup possible:

- **New file** → create a Trilium note and record it.
- **Changed file** (hash differs) → `PUT` new content to the existing note.
- **Unchanged file** (hash matches) → skipped.
- **Removed file** → logged, kept in Trilium by default (soft). Set
  `trilkeep.hardDeleteRemovedFiles: true` to delete instead.

Markdown files are stored as Trilium **code notes** with mime `text/x-markdown`
so the raw Markdown is preserved byte-for-byte (text notes would force a lossy
HTML conversion). Folders become container (`book`) notes, recreating the tree.

## Commands

| Command | Action |
|---|---|
| `Trilkeep: Setup` | Quick wizard for the essentials: connection, server URL, token, on-save (re-runnable). |
| `Trilkeep: Setup (Advanced)` | Guided walk-through of every setting (re-runnable). |
| `Trilkeep: Back Up Workspace` | Full/incremental backup of the open workspace. |
| `Trilkeep: Back Up Workspace (Dry Run)` | Show what would be backed up (new/changed/unchanged/skipped/removed) without writing to Trilium. No token needed. |
| `Trilkeep: Test Connection` | Verify server URL + token via `/app-info`. |
| `Trilkeep: Set ETAPI Token` | Store the ETAPI token for the current connection. |
| `Trilkeep: Clear ETAPI Token` | Remove the stored token for the current connection. |
| `Trilkeep: Forget Connection` | Stop tracking any known connection: clears its (global) token and optionally this repo's backup state. Trilium is left intact. |

## Settings

| Setting | Default | Description |
|---|---|---|
| `trilkeep.connectionName` | `default` | Stable name for this Trilium instance (e.g. `real`, `test`). Keys the token + backup state, so `serverUrl` can change without losing them. |
| `trilkeep.serverUrl` | `http://localhost:8080` | Trilium base URL (just the address; change it freely). |
| `trilkeep.include` | `["**/*.md"]` | Globs to back up. |
| `trilkeep.exclude` | `node_modules`, `.git`, `.trilkeep` | Globs to skip. |
| `trilkeep.backupOnSave` | `false` | Incremental backup on each save. |
| `trilkeep.rootNoteTitle` | _(empty)_ | Title of this workspace's root note. Blank = the workspace folder name. |
| `trilkeep.group` | `Trilkeep` | Slash-path of container notes to nest the backup root under (e.g. `Trilkeep/work/repo`). Blank = no grouping. |
| `trilkeep.parentNoteId` | _(empty)_ | Existing Trilium noteId to use as the base parent instead of Trilium's root. Blank = Trilium root. |
| `trilkeep.readOnly` | `true` | Mark the mirrored tree read-only in Trilium (inheritable `#readOnly` label). Backups still update it. |
| `trilkeep.hardDeleteRemovedFiles` | `false` | Delete Trilium notes for removed files. |

## Security posture

- **Token** lives in VS Code SecretStorage, not `settings.json`, and is **keyed by
  `connectionName`** (a stable name you choose), not by `serverUrl`. Distinct
  connections (e.g. `test` vs `real`) never share a token, and changing a
  server's address, such as a churning LAN IP, never loses or misroutes the token.
  The backup-state manifest is keyed the same way (`.trilkeep/state.<connection>.json`),
  so two instances keep independent trees. (`serverUrl`/`connectionName` are
  workspace-scoped settings; the token is global SecretStorage.)
- **Zero runtime dependencies.** Uses Node's built-in `fetch` and `crypto`, so
  there's no third-party supply-chain surface in what ships.
- **Dependency cooldown.** `pnpm-workspace.yaml` sets `minimumReleaseAge: 10080`
  (7 days), so we never install a version published in the last week, which closes
  the window where a freshly-compromised release is live before it's caught.
  Dependabot is configured with a matching 7-day `cooldown`.

## Notes & known limitations

- **One window per workspace at a time.** Overlapping backups are guarded within
  a single VS Code window, but that lock doesn't span processes. If you open the
  **same folder in two windows** and back up from both at once, they can race the
  shared `.trilkeep/state.json` and create duplicate notes in Trilium. Back up
  from one window at a time.
- **Broadening `include` uploads whatever matches.** The default (`**/*.md`) is
  markdown-only. If you widen it (e.g. to `**/*`), Trilkeep uploads **every**
  matching file, including secrets like `.env`, `*.pem`, or `id_rsa`, because
  there's no built-in secret-file denylist (by design, so nothing is silently
  dropped). Add `trilkeep.exclude` patterns for anything sensitive before
  widening the includes.

## Roadmap

Planned and under consideration (directional, not commitments):

- **Automatic backup.** Opt-in backup when the workspace opens, plus
  scheduled/periodic runs and a status-bar indicator (last backup time, in
  progress, errors).
- **Connection management.** A `Trilkeep: Forget Connection` command to drop a
  tracked connection and its token.
- **Standalone multi-repo daemon.** Back up several repos at the OS level,
  beyond the one open in VS Code.
- **Two-way sync (opt-in, longer-term).** Pull edits made in Trilium back into
  the workspace, not just push. A distinct mode from the default one-way backup
  (which keeps the workspace as the source of truth); the hard part is conflict
  handling when a note and its file both change, plus tracking remote-side
  changes and deletes.

## Development

```bash
pnpm install          # respects the 7-day cooldown
pnpm run typecheck    # tsc against src + test
pnpm run lint         # eslint
pnpm run test         # node:test unit suite (pure logic)
pnpm run compile      # build to out/
```

Press <kbd>F5</kbd> in VS Code to launch an Extension Development Host with the
extension loaded.

## Feedback

Bug reports and feature ideas are welcome. Open an issue on the
[GitHub repo](https://github.com/kalmigs/trilkeep/issues). If something feels
clunky in daily use, describe your workflow so it can be reproduced.

## License

MIT. See [LICENSE](LICENSE).
