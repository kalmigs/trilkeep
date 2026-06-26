// The backup/sync engine.
//
// Run model: one batched full backfill on the first run, then incremental
// (only changed files) on every run after. The manifest is what separates
// "already backed up" from "changed since". See manifest.ts.

import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as path from "path";

import { EtapiClient, EtapiError } from "./etapiClient";
import { Manifest, ManifestEntry } from "./manifest";

export interface SyncOptions {
  workspaceRoot: string;
  workspaceName: string;
  rootNoteTitle: string;
  hardDeleteRemovedFiles: boolean;
}

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
      // The root was deleted in Trilium — drop the stale tree so children get
      // recreated under a fresh root.
      this.log("Backup root note missing in Trilium; recreating tree.");
      this.manifest.entries = {};
    }
    const res = await this.client.createNote({
      parentNoteId: TRILIUM_ROOT_NOTE_ID,
      title,
      type: "book",
      content: "",
    });
    this.manifest.rootNoteId = res.note.noteId;
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
