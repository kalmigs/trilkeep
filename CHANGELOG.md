# Changelog

All notable changes to **Trilkeep** are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`Trilkeep: Back Up Workspace (Dry Run)`** — reports what a full backup would do
  (files new / changed / unchanged / skipped / removed, and how many notes would
  actually be written) without contacting Trilium or writing anything. Requires no
  token, so you can preview what your include/exclude globs match before
  configuring a connection. Details go to the Trilkeep output channel.
- **`Trilkeep: Setup`** (Quick) — a short, re-runnable wizard for the essentials
  (connection, server URL, token, back-up-on-save). Leaves all advanced settings at
  their current value/default, so a quick re-run never clobbers them. **`Trilkeep: Setup
  (Advanced)`** walks every setting (root title, group, globs, on-save, hard-delete,
  read-only) too. Both end by offering to **back up now** (Back Up Now / Test
  Connection / Dry Run / Not Now), apply atomically (Esc cancels with no changes),
  never display the token, and write at workspace scope. (`parentNoteId` stays
  settings-only — advanced.)
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
- **Connection picker in Setup** — step 1 lists known connections (tracked in a
  machine-local `globalState` registry spanning every repo on this machine, current
  one pre-selected) plus "Enter a new name…"; the filter text you type seeds the
  new-name box. Dead connections (no token and no local backup) are pruned
  automatically.
- **`trilkeep.group`** — nest a workspace's backup root under a container path
  (default `Trilkeep`, e.g. `Trilkeep/work/repo`), so backups group together
  instead of cluttering Trilium's root. Trilkeep creates and reuses the containers
  (repos sharing a group share the container). Blank = no grouping. Changing the
  group **re-parents** the existing root (its `noteId`, and so the backup, is
  preserved — not duplicated).
- **`trilkeep.parentNoteId`** — nest backups under one of your own existing Trilium
  notes instead of Trilium's root (the `group` path, if any, is created under it).
- **`trilkeep.readOnly`** (default **on**) — marks the mirrored tree read-only in
  Trilium's UI via an inheritable `#readOnly` label on the root, to discourage edits
  in Trilium that the next backup would silently overwrite. On by default because
  Trilkeep is a one-way mirror (the workspace is the source of truth). Soft UI guard
  only; Trilkeep's own syncing still updates the notes. Set `false` to edit in Trilium.

### Changed

- Command palette category is now **`Trilkeep:`** (was the nominative `Trilium:`).
- `rootNoteTitle` now sets a workspace root's **own** title (blank = the folder
  name); the "Trilkeep" branding moved to the new `trilkeep.group` container, and
  the old `"<rootNoteTitle>: <workspace>"` composition is dropped. By default
  workspaces now nest under a single `Trilkeep` container instead of each sitting
  at Trilium's root. Done/in-progress notifications say "Trilkeep backup".
- The Setup connection-name change only offers carry-over (rename) when the
  current connection actually has a backup **in this repo** — a leftover global
  token alone no longer triggers a spurious "rename?" prompt on a fresh repo.
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
