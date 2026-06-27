// The backup/sync engine.
//
// Run model: one batched full backfill on the first run, then incremental
// (only changed files) on every run after. The manifest is what separates
// "already backed up" from "changed since". See manifest.ts.

import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as path from "path";

import { EtapiClient, EtapiError, EtapiNote } from "./etapiClient";
import { Manifest, ManifestEntry } from "./manifest";

export interface SyncOptions {
  workspaceRoot: string;
  workspaceName: string;
  /** Stable connection identity; stamped on the root note so it can be found
   * again (and told apart from other backups) even if the manifest is lost. */
  connectionName: string;
  rootNoteTitle: string;
  hardDeleteRemovedFiles: boolean;
}

// Labels stamped on the backup root note. ROOT marks it as a Trilkeep root;
// CONNECTION + WORKSPACE identify which backup it is, so a lost manifest can
// recover the root by search instead of creating a duplicate.
const ROOT_LABEL = "trilkeepRoot";
const CONNECTION_LABEL = "trilkeepConnection";
const WORKSPACE_LABEL = "trilkeepWorkspace";

export interface SyncSummary {
  created: number;
  updated: number;
  skipped: number;
  removed: number;
  errors: string[];
}

export interface ProgressReporter {
  report(message: string): void;
  isCancelled(): boolean;
}

const TRILIUM_ROOT_NOTE_ID = "root";

export function sha256(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

export class SyncEngine {
  constructor(
    private readonly client: EtapiClient,
    private readonly manifest: Manifest,
    private readonly opts: SyncOptions,
    private readonly log: (msg: string) => void
  ) {}

  /**
   * Back up the given workspace-relative files. Mutates the manifest in place.
   * `reconcile` (default true) controls deletion handling: a full backup passes
   * the complete file list and reconciles removals; a partial backup (e.g. a
   * single saved file) passes `false` so absent files are NOT treated as
   * removed.
   */
  async backup(
    files: string[],
    progress: ProgressReporter,
    opts: { reconcile?: boolean } = {}
  ): Promise<SyncSummary> {
    const reconcile = opts.reconcile ?? true;
    const summary: SyncSummary = {
      created: 0,
      updated: 0,
      skipped: 0,
      removed: 0,
      errors: [],
    };

    await this.ensureRoot();

    const seen = new Set<string>();
    let cancelled = false;
    let i = 0;
    for (const rel of files) {
      if (progress.isCancelled()) {
        cancelled = true;
        this.log("Backup cancelled by user.");
        break;
      }
      i++;
      seen.add(rel);
      progress.report(`(${i}/${files.length}) ${rel}`);
      try {
        await this.backupFile(rel, summary);
      } catch (e) {
        const msg = `${rel}: ${(e as Error).message}`;
        summary.errors.push(msg);
        this.log(`ERROR ${msg}`);
      }
    }

    // Only reconcile deletions when the full file list was walked. On a cancel,
    // `seen` is incomplete, so unprocessed-but-existing files would be wrongly
    // treated as removed (and deleted under hardDeleteRemovedFiles). Partial
    // (single-file) backups also skip reconciliation.
    if (!cancelled && reconcile) {
      await this.reconcileDeletions(files, seen, summary);
    }
    return summary;
  }

  /** Ensure the top-level backup note exists; recreate it if it was removed. */
  private async ensureRoot(): Promise<void> {
    const title = `${this.opts.rootNoteTitle}: ${this.opts.workspaceName}`;
    if (this.manifest.rootNoteId) {
      const existing = await this.client.getNote(this.manifest.rootNoteId);
      if (existing) {
        return;
      }
      // The root noteId we held is gone in Trilium (deleted, or the manifest is
      // from a different instance). Drop the stale tree; we'll recover or create.
      this.log("Backup root note missing in Trilium; recovering or recreating.");
      this.manifest.entries = {};
    }

    // No valid rootNoteId (first run, or the manifest was lost/cleared). Before
    // creating a new tree, look for an existing root stamped with this
    // connection + workspace, so a lost manifest doesn't spawn a duplicate root.
    const recovered = await this.findExistingRoot();
    if (recovered) {
      this.manifest.rootNoteId = recovered;
      this.log(`Reattached to existing backup root ${recovered} (via attributes).`);
      return;
    }

    const res = await this.client.createNote({
      parentNoteId: TRILIUM_ROOT_NOTE_ID,
      title,
      type: "book",
      content: "",
    });
    this.manifest.rootNoteId = res.note.noteId;
    await this.stampRoot(res.note.noteId);
  }

  /** Find an existing backup root for this connection+workspace by its stamped
   * labels. Returns the noteId only on an unambiguous single match; best-effort
   * (a search failure or ambiguity falls back to creating a fresh root). */
  private async findExistingRoot(): Promise<string | undefined> {
    // Strip quotes so they can't break out of the search-query string literals.
    const esc = (s: string): string => s.replace(/"/g, "");
    const query =
      `#${ROOT_LABEL} ` +
      `#${CONNECTION_LABEL}="${esc(this.opts.connectionName)}" ` +
      `#${WORKSPACE_LABEL}="${esc(this.opts.workspaceName)}"`;
    let matches: EtapiNote[];
    try {
      matches = await this.client.searchNotes(query, {
        ancestorNoteId: TRILIUM_ROOT_NOTE_ID,
        limit: 2,
      });
    } catch (e) {
      this.log(
        `Root recovery search failed (${(e as Error).message}); creating a new root.`
      );
      return undefined;
    }
    if (matches.length === 1) {
      return matches[0].noteId;
    }
    if (matches.length > 1) {
      this.log(
        `Found ${matches.length} candidate backup roots for "${this.opts.connectionName}/${this.opts.workspaceName}"; ambiguous, creating a new one.`
      );
    }
    return undefined;
  }

  /** Stamp the identifying labels on a freshly-created root. Best-effort: a
   * stamping failure must not fail the backup (it only costs identifiability /
   * future recoverability, not data). */
  private async stampRoot(noteId: string): Promise<void> {
    try {
      await this.client.createLabel(noteId, ROOT_LABEL);
      await this.client.createLabel(
        noteId,
        CONNECTION_LABEL,
        this.opts.connectionName
      );
      await this.client.createLabel(
        noteId,
        WORKSPACE_LABEL,
        this.opts.workspaceName
      );
    } catch (e) {
      this.log(
        `Could not stamp backup-root attributes (${(e as Error).message}); continuing.`
      );
    }
  }

  /** Resolve (creating as needed) the Trilium noteId for a relative directory. */
  private async ensureDir(relDir: string): Promise<string> {
    if (relDir === "" || relDir === ".") {
      return this.manifest.rootNoteId!;
    }
    const existing = this.manifest.entries[relDir];
    if (existing && existing.type === "dir") {
      return existing.noteId;
    }
    const parentId = await this.ensureDir(path.posix.dirname(relDir));
    const res = await this.client.createNote({
      parentNoteId: parentId,
      title: path.posix.basename(relDir),
      type: "book",
      content: "",
    });
    this.manifest.entries[relDir] = { noteId: res.note.noteId, type: "dir" };
    return res.note.noteId;
  }

  private async backupFile(rel: string, summary: SyncSummary): Promise<void> {
    const abs = path.join(this.opts.workspaceRoot, rel);
    // lstat (not stat): a symlink whose target is outside the workspace would
    // otherwise have the TARGET's content uploaded (e.g. a `.md` symlink → an
    // out-of-tree secrets file). Skip symlinks entirely — a backup tool should
    // only copy real files inside the workspace.
    const stat = await fs.lstat(abs);
    if (stat.isSymbolicLink()) {
      this.log(`skipped (symlink, not backed up) ${rel}`);
      summary.skipped++;
      return;
    }
    const buf = await fs.readFile(abs);
    // Reject binary content: reading it as utf8 would replace invalid bytes with
    // U+FFFD, corrupting the upload and making the hash never match the file
    // (so it would re-upload every run). A NUL byte is a reliable binary signal;
    // valid UTF-8 text never contains one.
    if (buf.includes(0)) {
      this.log(`skipped (binary, not backed up) ${rel}`);
      summary.skipped++;
      return;
    }
    const content = buf.toString("utf8");
    const hash = sha256(content);

    const prev = this.manifest.entries[rel];
    if (prev && prev.type === "file") {
      // The file is present, so clear any soft-delete tombstone (it's "back").
      delete prev.removed;
      if (prev.sha256 === hash) {
        summary.skipped++;
        return;
      }
      await this.client.putContent(prev.noteId, content);
      this.manifest.entries[rel] = {
        ...prev,
        sha256: hash,
        mtimeMs: stat.mtimeMs,
      };
      summary.updated++;
      this.log(`updated  ${rel}`);
      return;
    }

    const parentId = await this.ensureDir(path.posix.dirname(rel));
    const res = await this.client.createNote({
      parentNoteId: parentId,
      title: path.posix.basename(rel),
      type: "code",
      mime: mimeForFile(rel),
      content,
    });
    this.manifest.entries[rel] = {
      noteId: res.note.noteId,
      type: "file",
      sha256: hash,
      mtimeMs: stat.mtimeMs,
    };
    summary.created++;
    this.log(`created  ${rel}`);
  }

  /** Handle files and directories that vanished since last run. */
  private async reconcileDeletions(
    files: string[],
    seen: Set<string>,
    summary: SyncSummary
  ): Promise<void> {
    const fileEntries = Object.entries(this.manifest.entries).filter(
      ([, e]) => e.type === "file"
    ) as [string, ManifestEntry][];

    for (const [rel, entry] of fileEntries) {
      if (seen.has(rel)) {
        continue;
      }
      if (this.opts.hardDeleteRemovedFiles) {
        // Prune the manifest entry only if the remote delete succeeds, so a
        // failed delete keeps the noteId and is retried next run (not orphaned).
        if (await this.tryDelete(entry.noteId, rel)) {
          delete this.manifest.entries[rel];
          summary.removed++;
          this.log(`deleted  ${rel}`);
        }
      } else if (!entry.removed) {
        // Soft delete: keep the note, log the removal once (tombstone), don't
        // re-log it on every subsequent run.
        entry.removed = true;
        summary.removed++;
        this.log(`removed (kept in Trilium) ${rel}`);
      }
    }

    // Orphan directory notes: only cleaned up under hard delete (soft delete
    // keeps the whole tree). A dir is orphaned if it's no longer an ancestor of
    // any backed-up file. Delete deepest-first so a parent's cascade delete
    // never 404s a child we still hold.
    if (this.opts.hardDeleteRemovedFiles) {
      const needed = requiredDirs(files);
      const orphanDirs = (
        Object.entries(this.manifest.entries).filter(
          ([rel, e]) => e.type === "dir" && !needed.has(rel)
        ) as [string, ManifestEntry][]
      ).sort(([a], [b]) => depth(b) - depth(a));

      for (const [rel, entry] of orphanDirs) {
        if (await this.tryDelete(entry.noteId, rel)) {
          delete this.manifest.entries[rel];
          this.log(`deleted dir ${rel}`);
        }
      }
    }
  }

  /** Delete a note, tolerating a 404 (already gone, e.g. via parent cascade).
   * Returns true if the note is gone afterward, false on a real failure. */
  private async tryDelete(noteId: string, rel: string): Promise<boolean> {
    try {
      await this.client.deleteNote(noteId);
      return true;
    } catch (e) {
      if (e instanceof EtapiError && e.status === 404) {
        return true;
      }
      this.log(`ERROR deleting ${rel}: ${(e as Error).message}`);
      return false;
    }
  }
}

/** Every ancestor directory of every file (posix paths), e.g. "a/b/c.md" →
 * {"a", "a/b"}. Used to find directory entries no file needs anymore. */
export function requiredDirs(files: string[]): Set<string> {
  const dirs = new Set<string>();
  for (const rel of files) {
    let d = path.posix.dirname(rel);
    while (d && d !== ".") {
      dirs.add(d);
      d = path.posix.dirname(d);
    }
  }
  return dirs;
}

function depth(rel: string): number {
  return rel.split("/").length;
}

export function mimeForFile(rel: string): string {
  const ext = path.posix.extname(rel).toLowerCase();
  switch (ext) {
    case ".md":
    case ".markdown":
      return "text/x-markdown";
    case ".json":
      return "application/json";
    case ".js":
      return "application/javascript";
    case ".ts":
      return "application/typescript";
    default:
      return "text/plain";
  }
}
