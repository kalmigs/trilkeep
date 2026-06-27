# Changelog

All notable changes to **Trilkeep** are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`Trilkeep: Setup`** — a guided, re-runnable wizard that walks every setting
  (connection name, server URL, token, globs, on-save, hard-delete), pre-filled
  with current values. Applies atomically (Esc cancels with no changes); the
  token is never displayed. Writes settings at workspace scope.
- **`trilkeep.connectionName`** — a stable name identifying a Trilium instance.
  The ETAPI token and backup-state manifest are keyed by it (not by `serverUrl`),
  so a server's address can change (e.g. a churning LAN IP) without losing the
  token or duplicating the backup, and distinct instances (`test`/`real`) stay
  isolated. The manifest for a named connection is `.trilkeep/state.<name>.json`.
- Backup **root notes are stamped** with `#trilkeepRoot`, `#trilkeepConnection`,
  and `#trilkeepWorkspace` labels, so they're identifiable in Trilium and an
  existing root is recovered by search instead of duplicated if the local
  manifest is lost. An already-existing root is stamped once on its next backup.
- **Connection rename** — changing the connection name in Setup, when a backup
  already exists, offers to carry it over (moves the manifest + token and
  re-labels the root) or start a fresh tree.
- **Root note title is kept in sync** — changing `rootNoteTitle` (or the folder
  name) now renames the existing root note in Trilium on the next backup, instead
  of only applying at creation.

### Changed

- Command palette category is now **`Trilkeep:`** (was the nominative `Trilium:`).
- Default `rootNoteTitle` is now **`Trilkeep`** (was `VSCode Backup`), and the
  in-progress/done notifications say "Trilkeep backup" — brand-consistent with the
  rename away from editor-coupling.
- A pre-existing single ETAPI token auto-migrates to the configured connection on
  first activation.

- Initial public release prep: packaging metadata, `.vscodeignore`, Open VSX target.

## [0.0.1] — 2026-06-16

Initial build (pre-release, not yet published).

### Added

- One-way backup of a VSCode workspace into TriliumNext via the ETAPI: a batched
  full backfill on first run, then incremental (changed-files-only) afterward.
- Markdown stored losslessly as Trilium `code` notes (`text/x-markdown`); folders
  mirrored as `book` container notes.
- Hash-diff sync via a `.trilkeep/state.json` manifest (atomic writes) mapping each
  path to its `noteId` + `sha256`, so re-runs only upload changes and never duplicate.
- Commands: Back Up Workspace, Test Connection, Set / Clear ETAPI Token.
- Settings: `serverUrl`, `include`, `exclude`, `backupOnSave` (default `false`),
  `rootNoteTitle`, `hardDeleteRemovedFiles` (default `false` — soft delete).
- ETAPI token stored in VSCode SecretStorage (never `settings.json`); zero runtime
  dependencies (built-in `fetch` + `crypto`).
- Supply-chain hardening: pnpm `minimumReleaseAge` (7-day cooldown) + matching
  Dependabot cooldown.

[Unreleased]: https://github.com/kalmigs/trilkeep/compare/v0.0.1...HEAD
[0.0.1]: https://github.com/kalmigs/trilkeep/releases/tag/v0.0.1
