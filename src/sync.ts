// The backup/sync engine.
//
// Run model: one batched full backfill on the first run, then incremental
// (only changed files) on every run after. The manifest is what separates
// "already backed up" from "changed since". See manifest.ts.

import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as path from "path";

import { EtapiClient } from "./etapiClient";
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

  /** Back up the given workspace-relative files. Mutates the manifest in place. */
  async backup(files: string[], progress: ProgressReporter): Promise<SyncSummary> {
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
    // treated as removed (and deleted under hardDeleteRemovedFiles).
    if (!cancelled) {
      this.reconcileDeletions(files, seen, summary);
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
    const stat = await fs.stat(abs);
    const content = await fs.readFile(abs, "utf8");
    const hash = sha256(content);

    const prev = this.manifest.entries[rel];
    if (prev && prev.type === "file") {
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

  /** Handle files that vanished since last run. Soft by default (log only). */
  private reconcileDeletions(
    files: string[],
    seen: Set<string>,
    summary: SyncSummary
  ): void {
    const fileEntries = Object.entries(this.manifest.entries).filter(
      ([, e]) => e.type === "file"
    ) as [string, ManifestEntry][];

    for (const [rel] of fileEntries) {
      if (seen.has(rel)) {
        continue;
      }
      summary.removed++;
      if (this.opts.hardDeleteRemovedFiles) {
        // Fire-and-forget delete; record removal from the manifest regardless.
        const noteId = this.manifest.entries[rel].noteId;
        delete this.manifest.entries[rel];
        void this.client.deleteNote(noteId).catch((e) => {
          this.log(`ERROR deleting ${rel}: ${(e as Error).message}`);
        });
        this.log(`deleted  ${rel}`);
      } else {
        this.log(`removed (kept in Trilium) ${rel}`);
      }
    }
  }
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
