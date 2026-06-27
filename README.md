# Trilkeep

*Mirror your notes to Trilium.*

A VSCode extension that mirrors your notes workspace into [TriliumNext](https://triliumnotes.org)
via the [ETAPI](https://github.com/TriliumNext/Notes) (Trilium's External API).

Work in your familiar editor; get a second, scriptable backup target in Trilium.

## Status

**v1 — workspace → Trilium backup.** One batched full backfill on the first run,
then incremental (only changed files) afterward. The ETAPI client is verified
against the bundled spec at [`docs/etapi.openapi.yaml`](docs/etapi.openapi.yaml).

Planned later: in-VSCode viewing of Trilium notes, a Trilium-side read-only
mirror, and a standalone multi-repo daemon.

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

## Setup

1. Run TriliumNext and open **Options → ETAPI**, then generate a token.
2. In VSCode, run **`Trilkeep: Setup`** — a guided walk-through of every setting
   (connection name, server URL, token, globs, on-save, hard-delete), pre-filled
   with the current values so you can re-run it any time to review or change
   config. The token is stored in VSCode SecretStorage (never in settings) and is
   never displayed. Give each Trilium instance a distinct **connection name** (the
   token + backup state are keyed by it, so the URL can change freely). Renaming a
   connection in Setup offers to carry the existing backup over or start fresh.
3. Run **`Trilkeep: Back Up Workspace`** to back up.

Prefer to configure by hand? Set `trilkeep.serverUrl`, run **`Trilkeep: Set ETAPI
Token`**, then **`Trilkeep: Test Connection`** to confirm.

## Commands

| Command | Action |
|---|---|
| `Trilkeep: Setup` | Guided walk-through of every setting (re-runnable). |
| `Trilkeep: Back Up Workspace` | Full/incremental backup of the open workspace. |
| `Trilkeep: Test Connection` | Verify server URL + token via `/app-info`. |
| `Trilkeep: Set ETAPI Token` | Store the ETAPI token for the current connection. |
| `Trilkeep: Clear ETAPI Token` | Remove the stored token for the current connection. |

## Settings

| Setting | Default | Description |
|---|---|---|
| `trilkeep.connectionName` | `default` | Stable name for this Trilium instance (e.g. `real`, `test`). Keys the token + backup state, so `serverUrl` can change without losing them. |
| `trilkeep.serverUrl` | `http://localhost:8080` | TriliumNext base URL (just the address; change it freely). |
| `trilkeep.include` | `["**/*.md"]` | Globs to back up. |
| `trilkeep.exclude` | `node_modules`, `.git`, `.trilkeep` | Globs to skip. |
| `trilkeep.backupOnSave` | `false` | Incremental backup on each save. |
| `trilkeep.rootNoteTitle` | `Trilkeep` | Title of the top-level mirror note (workspace name appended). |
| `trilkeep.hardDeleteRemovedFiles` | `false` | Delete Trilium notes for removed files. |

## Security posture

- **Token** lives in VSCode SecretStorage, not `settings.json`, and is **keyed by
  `connectionName`** (a stable name you choose), not by `serverUrl`. Distinct
  connections (e.g. `test` vs `real`) never share a token, and changing a
  server's address — a churning LAN IP — never loses or misroutes the token. The
  backup-state manifest is keyed the same way (`.trilkeep/state.<connection>.json`),
  so two instances keep independent trees. (`serverUrl`/`connectionName` are
  workspace-scoped settings; the token is global SecretStorage.)
- **Zero runtime dependencies** — uses Node's built-in `fetch` and `crypto`, so
  there's no third-party supply-chain surface in what ships.
- **Dependency cooldown** — `pnpm-workspace.yaml` sets `minimumReleaseAge: 10080`
  (7 days), so we never install a version published in the last week, dodging the
  window where a freshly-compromised release is live before it's caught. Dependabot
  is configured with a matching 7-day `cooldown`.

## Notes & known limitations

- **One window per workspace at a time.** Overlapping backups are guarded within
  a single VSCode window, but that lock doesn't span processes. If you open the
  **same folder in two windows** and back up from both at once, they can race the
  shared `.trilkeep/state.json` and create duplicate notes in Trilium. Back up
  from one window at a time.
- **Broadening `include` uploads whatever matches.** The default (`**/*.md`) is
  markdown-only. If you widen it (e.g. to `**/*`), Trilkeep uploads **every**
  matching file — including secrets like `.env`, `*.pem`, or `id_rsa` — because
  there's no built-in secret-file denylist (by design, so nothing is silently
  dropped). Add `trilkeep.exclude` patterns for anything sensitive before
  widening the includes.

## Development

```bash
pnpm install          # respects the 7-day cooldown
pnpm run typecheck    # tsc against src + test
pnpm run lint         # eslint
pnpm run test         # node:test unit suite (pure logic)
pnpm run compile      # build to out/
```

Press <kbd>F5</kbd> in VSCode to launch an Extension Development Host with the
extension loaded.

## License

MIT.
