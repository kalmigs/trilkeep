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
2. In VSCode, run **`Trilkeep: Set ETAPI Token`** (stored in VSCode SecretStorage,
   never in settings).
3. Set `trilkeep.serverUrl` if Trilium isn't at `http://localhost:8080`.
4. Run **`Trilkeep: Test Connection`** to confirm, then **`Trilkeep: Back Up Workspace`**.

## Commands

| Command | Action |
|---|---|
| `Trilkeep: Back Up Workspace` | Full/incremental backup of the open workspace. |
| `Trilkeep: Test Connection` | Verify server URL + token via `/app-info`. |
| `Trilkeep: Set ETAPI Token` | Store the ETAPI token in SecretStorage. |
| `Trilkeep: Clear ETAPI Token` | Remove the stored token. |

## Settings

| Setting | Default | Description |
|---|---|---|
| `trilkeep.serverUrl` | `http://localhost:8080` | TriliumNext base URL. |
| `trilkeep.include` | `["**/*.md"]` | Globs to back up. |
| `trilkeep.exclude` | `node_modules`, `.git`, `.trilkeep` | Globs to skip. |
| `trilkeep.backupOnSave` | `false` | Incremental backup on each save. |
| `trilkeep.rootNoteTitle` | `VSCode Backup` | Title of the top-level mirror note. |
| `trilkeep.hardDeleteRemovedFiles` | `false` | Delete Trilium notes for removed files. |

## Security posture

- **Token** lives in VSCode SecretStorage, not `settings.json`.
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
