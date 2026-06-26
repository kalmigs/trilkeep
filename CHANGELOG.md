# Changelog

All notable changes to **Trilkeep** are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
