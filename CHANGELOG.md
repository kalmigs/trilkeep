# Changelog

All notable changes to **Trilkeep** are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`Trilkeep: Forget Connection`**. Stop tracking a connection: pick it from a
  list (each annotated with whether it has a token and a backup in this repo),
  confirm a modal warning that the token is cleared globally (every repo using
  that name will need it re-entered), then choose to keep this repo's backup state
  (default; re-adding later resumes cleanly) or delete it. Trilium notes are never
  touched. Complements `Clear ETAPI Token`, which only acts on the
  currently-configured connection.

## [0.1.0] - 2026-06-29

### Added

- **`Trilkeep: Back Up Workspace (Dry Run)`**. Reports what a full backup would do
  (files new / changed / unchanged / skipped / removed, and how many notes would
  actually be written) without contacting Trilium or writing anything. Requires no
  token, so you can preview what your include/exclude globs match before
  configuring a connection. Details go to the Trilkeep output channel.
- **`Trilkeep: Setup`** (Quick). A short, re-runnable wizard for the essentials
  (connection, server URL, token, back-up-on-save). Leaves all advanced settings at
  their current value/default, so a quick re-run never clobbers them. **`Trilkeep: Setup
  (Advanced)`** walks every setting (root title, group, globs, on-save, hard-delete,
  read-only) too. Both end by offering to **back up now** (Back Up Now / Test
  Connection / Dry Run / Not Now), apply atomically (Esc cancels with no changes),
  never display the token, and write at workspace scope. (`parentNoteId` stays
  settings-only, advanced.)
- **`trilkeep.connectionName`**. A stable name identifying a Trilium instance.
  The ETAPI token and backup-state manifest are keyed by it (not by `serverUrl`),
  so a server's address can change (e.g. a churning LAN IP) without losing the
  token or duplicating the backup, and distinct instances (`test`/`real`) stay
  isolated. The manifest for a named connection is `.trilkeep/state.<name>.json`.
- Backup **root notes are stamped** with `#trilkeepRoot`, `#trilkeepConnection`,
  and `#trilkeepWorkspace` labels, so they're identifiable in Trilium and an
  existing root is recovered by search instead of duplicated if the local
  manifest is lost. An already-existing root is stamped once on its next backup.
- **Connection rename**. Changing the connection name in Setup, when a backup
  already exists, offers to carry it over (moves the manifest + token and
  re-labels the root) or start a fresh tree.
- **Root note title follows the local title**. Changing `rootNoteTitle` (or the
  folder name) now renames the existing root note in Trilium on the next backup,
  instead of only applying at creation.
- **Connection picker in Setup**. Step 1 lists known connections (tracked in a
  machine-local `globalState` registry spanning every repo on this machine, current
  one pre-selected) plus "Enter a new name…"; the filter text you type seeds the
  new-name box. Dead connections (no token and no local backup) are pruned
  automatically.
- **`trilkeep.group`**. Nest a workspace's backup root under a container path
  (default `Trilkeep`, e.g. `Trilkeep/work/repo`), so backups group together
  instead of cluttering Trilium's root. Trilkeep creates and reuses the containers
  (repos sharing a group share the container). Blank = no grouping. Changing the
  group **re-parents** the existing root (its `noteId`, and so the backup, is
  preserved, not duplicated).
- **`trilkeep.parentNoteId`**. Nest backups under one of your own existing Trilium
  notes instead of Trilium's root (the `group` path, if any, is created under it).
- **`trilkeep.readOnly`** (default **on**). Marks the mirrored tree read-only in
  Trilium's UI via an inheritable `#readOnly` label on the root, to discourage edits
  in Trilium that the next backup would silently overwrite. On by default because
  Trilkeep is a one-way mirror (the workspace is the source of truth). Soft UI guard
  only; Trilkeep's own backups still update the notes. Set `false` to edit in Trilium.

### Changed

- Command palette category is now **`Trilkeep:`** (was the nominative `Trilium:`).
- `rootNoteTitle` now sets a workspace root's **own** title (blank = the folder
  name); the "Trilkeep" branding moved to the new `trilkeep.group` container, and
  the old `"<rootNoteTitle>: <workspace>"` composition is dropped. By default
  workspaces now nest under a single `Trilkeep` container instead of each sitting
  at Trilium's root. Done/in-progress notifications say "Trilkeep backup".
- The Setup connection-name change only offers carry-over (rename) when the
  current connection actually has a backup **in this repo**; a leftover global
  token alone no longer triggers a spurious "rename?" prompt on a fresh repo.
- Initial public release prep: packaging metadata, `.vscodeignore`, Open VSX target.

## [0.0.1] - 2026-06-16

Initial build (pre-release, not yet published).

### Added

- One-way backup of a VS Code workspace into Trilium via the ETAPI: a batched
  full backfill on first run, then incremental (changed-files-only) afterward.
- Markdown stored losslessly as Trilium `code` notes (`text/x-markdown`); folders
  mirrored as `book` container notes.
- Hash-diff backup via a `.trilkeep/state.json` manifest (atomic writes) mapping each
  path to its `noteId` + `sha256`, so re-runs only upload changes and never duplicate.
- Commands: Back Up Workspace, Test Connection, Set / Clear ETAPI Token.
- Settings: `serverUrl`, `include`, `exclude`, `backupOnSave` (default `false`),
  `rootNoteTitle`, `hardDeleteRemovedFiles` (default `false`, soft delete).
- ETAPI token stored in VS Code SecretStorage (never `settings.json`); zero runtime
  dependencies (built-in `fetch` + `crypto`).
- Supply-chain hardening: pnpm `minimumReleaseAge` (7-day cooldown) + matching
  Dependabot cooldown.

[Unreleased]: https://github.com/kalmigs/trilkeep/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/kalmigs/trilkeep/releases/tag/v0.1.0
[0.0.1]: https://github.com/kalmigs/trilkeep/releases/tag/v0.0.1
