// The backup engine: one-way mirror of the workspace into TriliumNext.
//
// Run model: one batched full backfill on the first run, then incremental
// (only changed files) on every run after. The manifest is what separates
// "already backed up" from "changed since". See manifest.ts.

import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';

import { EtapiBranch, EtapiClient, EtapiError, EtapiNote } from './etapiClient';
import { Manifest, ManifestEntry } from './manifest';

export interface SyncOptions {
  workspaceRoot: string;
  workspaceName: string;
  /** Stable instance identity; stamped on the root note so it can be found
   * again (and told apart from other backups) even if the manifest is lost. */
  instanceName: string;
  /** Title of this workspace's root note. Blank → the workspace folder name.
   * The "Trilkeep" branding now lives on the `group` container, not here. */
  rootNoteTitle: string;
  hardDeleteRemovedFiles: boolean;
  /** Slash-path of container notes to nest the backup root under (e.g.
   * "Trilkeep" or "Trilkeep/work/repo"). Blank → root sits directly under
   * `parentNoteId` (or Trilium's root). Trilkeep creates/stamps the containers. */
  group?: string;
  /** Existing Trilium note to use as the base parent instead of Trilium's root
   * (e.g. to nest backups under your own note). The `group` path, if any, is
   * created under it. Blank → Trilium root. */
  parentNoteId?: string;
  /** When true, stamp the backup root with an inheritable #readOnly label so the
   * whole mirrored subtree renders read-only in Trilium's UI. */
  readOnly?: boolean;
}

// Labels stamped on the backup root note. ROOT marks it as a Trilkeep root;
// INSTANCE + WORKSPACE identify which backup it is, so a lost manifest can
// recover the root by search instead of creating a duplicate.
const ROOT_LABEL = 'trilkeepRoot';
const INSTANCE_LABEL = 'trilkeepInstance';
const WORKSPACE_LABEL = 'trilkeepWorkspace';
// Labels stamped on a group container note: CONTAINER marks it as Trilkeep-owned,
// CONTAINER_PATH holds its full slash-path so it can be found/reused (not
// duplicated) on the next run.
const CONTAINER_LABEL = 'trilkeepContainer';
const CONTAINER_PATH_LABEL = 'trilkeepContainerPath';
// An inheritable label Trilium honors to render a note (and its subtree) read-only.
const READONLY_LABEL = 'readOnly';

/** Split a group setting into clean path segments: "/Trilkeep//work/" →
 * ["Trilkeep", "work"]. Blank → []. Pure + testable. */
export function parseGroupPath(group: string): string[] {
  return group
    .split('/')
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

/** Strip the one character that could break out of a Trilium search string
 * literal (`#label="…"`) when interpolating a user-chosen name/path into a
 * recovery or container query. */
function escapeSearchValue(value: string): string {
  return value.replace(/"/g, '');
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

const TRILIUM_ROOT_NOTE_ID = 'root';

export function sha256(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

export class SyncEngine {
  constructor(
    private readonly client: EtapiClient,
    private readonly manifest: Manifest,
    private readonly opts: SyncOptions,
    private readonly log: (msg: string) => void,
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
    opts: { reconcile?: boolean } = {},
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
        this.log('Backup cancelled by user.');
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

  /** Ensure the top-level backup note exists; recreate it if it was removed.
   * Also resolves the configured group/parent, moving the root if it changed,
   * and keeps the inheritable #readOnly mark matching the setting. */
  private async ensureRoot(): Promise<void> {
    const title = this.opts.rootNoteTitle?.trim() || this.opts.workspaceName;
    const desiredParent = await this.ensureParent();
    if (this.manifest.rootNoteId) {
      const existing = await this.client.getNote(this.manifest.rootNoteId);
      if (existing) {
        // Update the root note's title to match if rootNoteTitle or the
        // workspace name changed since it was created. Best-effort.
        if (existing.title !== title) {
          try {
            await this.client.patchNote(this.manifest.rootNoteId, { title });
            this.log(`Renamed backup root note → "${title}".`);
          } catch (e) {
            this.log(`Could not rename backup root note (${(e as Error).message}); continuing.`);
          }
        }
        // Stamp a root that predates stamping (or whose stamp didn't land) so
        // it becomes recoverable; the flag stops this re-stamping every run.
        if (!this.manifest.rootStamped) {
          await this.stampRoot(this.manifest.rootNoteId);
        }
        // Reuse the note we already fetched (it carries parentBranchIds +
        // attributes) instead of re-GETting it in each helper. The stamping/title
        // update above don't touch the branches or the #readOnly label we read.
        await this.ensureRootPlacement(desiredParent, existing);
        await this.ensureReadOnly(existing);
        return;
      }
      // The root noteId we held is gone in Trilium (deleted, or the manifest is
      // from a different instance). Drop the stale tree; we'll recover or create.
      this.log('Backup root note missing in Trilium; recovering or recreating.');
      this.manifest.entries = {};
      this.manifest.rootParentNoteId = undefined;
    }

    // No valid rootNoteId (first run, or the manifest was lost/cleared). Before
    // creating a new tree, look for an existing root stamped with this
    // instance + workspace, so a lost manifest doesn't spawn a duplicate root.
    const recovered = await this.findExistingRoot();
    if (recovered) {
      this.manifest.rootNoteId = recovered;
      this.manifest.rootStamped = true; // found it by its stamp, so it's stamped
      this.manifest.rootParentNoteId = undefined; // unknown until placement checks
      this.log(`Reattached to existing backup root ${recovered} (via attributes).`);
      await this.ensureRootPlacement(desiredParent);
      await this.ensureReadOnly();
      return;
    }

    const res = await this.client.createNote({
      parentNoteId: desiredParent,
      title,
      type: 'book',
      content: '',
    });
    this.manifest.rootNoteId = res.note.noteId;
    this.manifest.rootParentNoteId = desiredParent; // created right where we want it
    await this.stampRoot(res.note.noteId);
    await this.ensureReadOnly();
  }

  /** Resolve the note the backup root should live under: walk/create the `group`
   * container path under the base parent (`parentNoteId` or Trilium root),
   * returning the deepest container's noteId (or the base if no group). */
  private async ensureParent(): Promise<string> {
    const base = this.opts.parentNoteId?.trim() || TRILIUM_ROOT_NOTE_ID;
    let parent = base;
    let fullPath = '';
    for (const segment of parseGroupPath(this.opts.group ?? '')) {
      fullPath = fullPath ? `${fullPath}/${segment}` : segment;
      parent = await this.ensureContainer(segment, parent, fullPath);
    }
    return parent;
  }

  /** Find (by its stamped path) or create a Trilkeep container note titled
   * `title` under `parentId`. Reusing by path keeps repos that share a group
   * under one container instead of duplicating it. Best-effort stamping. */
  private async ensureContainer(
    title: string,
    parentId: string,
    fullPath: string,
  ): Promise<string> {
    const query = `#${CONTAINER_LABEL} #${CONTAINER_PATH_LABEL}="${escapeSearchValue(fullPath)}"`;
    try {
      const matches = await this.client.searchNotes(query, {
        ancestorNoteId: parentId,
        limit: 2,
      });
      if (matches.length >= 1) {
        return matches[0].noteId;
      }
    } catch (e) {
      this.log(`Container search failed (${(e as Error).message}); creating "${fullPath}".`);
    }
    const res = await this.client.createNote({
      parentNoteId: parentId,
      title,
      type: 'book',
      content: '',
    });
    try {
      await this.client.createLabel(res.note.noteId, CONTAINER_LABEL);
      await this.client.createLabel(res.note.noteId, CONTAINER_PATH_LABEL, fullPath);
    } catch (e) {
      // An UNSTAMPED container is invisible to the path search above, so leaving
      // it would make every later run create another duplicate. Roll it back and
      // abort this run; the next run recreates + stamps it cleanly.
      await this.client.deleteNote(res.note.noteId).catch(() => undefined);
      throw new Error(
        `Could not stamp group container "${fullPath}" (${(e as Error).message}); rolled it back.`,
      );
    }
    return res.note.noteId;
  }

  /** Move the backup root under `desiredParent` if it isn't already there (the
   * `group`/`parentNoteId` changed). The root's noteId is preserved, so the
   * manifest stays valid. Cheap in the steady state: skips when the cached
   * parent already matches. Best-effort.
   *
   * CRITICAL ORDER: create the new placement (branch) FIRST, then delete the old
   * one(s); deleting a note's LAST branch deletes the note (per the ETAPI spec),
   * so the root must always retain ≥1 branch mid-move. */
  private async ensureRootPlacement(
    desiredParent: string,
    prefetched?: EtapiNote | null,
  ): Promise<void> {
    const rootId = this.manifest.rootNoteId!;
    if (this.manifest.rootParentNoteId === desiredParent) {
      return;
    }
    const note = prefetched ?? (await this.client.getNote(rootId));
    const oldBranchIds = note?.parentBranchIds ?? [];
    // Resolve the root's actual placement(s). Resolve EVERY branch; a note can be
    // cloned under several parents, and we must delete each stale one.
    const branches: EtapiBranch[] = [];
    for (const branchId of oldBranchIds) {
      const branch = await this.client.getBranch(branchId);
      if (branch) {
        branches.push(branch);
      }
    }
    if (branches.length === 0) {
      // Couldn't determine where the root lives (transient getBranch failure, or
      // a branchless note). Don't guess; caching a parent we never verified would
      // permanently mask a real move. Skip without caching; retry next run.
      this.log(
        "Could not determine the backup root's current placement; leaving it and retrying next run.",
      );
      return;
    }
    const alreadyUnderDesired = branches.some(b => b.parentNoteId === desiredParent);
    const strays = branches.filter(b => b.parentNoteId !== desiredParent);
    if (strays.length === 0) {
      // Already (only) under the desired parent; just record it.
      this.manifest.rootParentNoteId = desiredParent;
      return;
    }
    try {
      // Create the new placement FIRST (deleting a note's last branch deletes the
      // note), unless one already exists under the desired parent.
      if (!alreadyUnderDesired) {
        await this.client.createBranch(rootId, desiredParent);
      }
      let allRemoved = true;
      for (const branch of strays) {
        try {
          await this.client.deleteBranch(branch.branchId);
        } catch {
          allRemoved = false; // a stray placement survived
        }
      }
      // Only cache success once the root is solely under the desired parent, so a
      // partial move is retried next run rather than masked by the cache.
      if (allRemoved) {
        this.manifest.rootParentNoteId = desiredParent;
        this.log(`Moved backup root under ${desiredParent}.`);
      } else {
        this.log(
          `Backup root re-parented under ${desiredParent}, but an old placement could not be removed; will retry next run.`,
        );
      }
    } catch (e) {
      const detail =
        e instanceof EtapiError && e.body ? `${e.message}: ${e.body}` : (e as Error).message;
      this.log(`Could not move backup root (${detail}); leaving it in place.`);
    }
  }

  /** Add or remove the inheritable #readOnly label on the root to match the
   * setting. Tracked via manifest.readOnlyStamped so it only acts on a toggle.
   * Best-effort (a failure never blocks the backup). */
  private async ensureReadOnly(prefetched?: EtapiNote | null): Promise<void> {
    const rootId = this.manifest.rootNoteId!;
    const desired = !!this.opts.readOnly;
    if (desired === !!this.manifest.readOnlyStamped) {
      return;
    }
    try {
      // Check the ACTUAL label, not just the cached flag: on manifest-loss
      // recovery the flag is unset while the recovered root may already carry the
      // label, so a blind create would stack a duplicate #readOnly every recovery.
      const note = prefetched ?? (await this.client.getNote(rootId));
      const attr = note?.attributes?.find(a => a.type === 'label' && a.name === READONLY_LABEL);
      if (desired) {
        if (!attr) {
          await this.client.createLabel(rootId, READONLY_LABEL, '', {
            inheritable: true,
          });
          this.log('Marked backup tree read-only in Trilium (inheritable #readOnly).');
        }
        this.manifest.readOnlyStamped = true;
      } else {
        if (attr) {
          await this.client.deleteAttribute(attr.attributeId);
          this.log('Removed the read-only mark from the backup tree.');
        }
        this.manifest.readOnlyStamped = false;
      }
    } catch (e) {
      this.log(`Could not update the read-only mark (${(e as Error).message}); continuing.`);
    }
  }

  /** Find an existing backup root for this instance+workspace by its stamped
   * labels. Returns the noteId only on an unambiguous single match; best-effort
   * (a search failure or ambiguity falls back to creating a fresh root). */
  private async findExistingRoot(): Promise<string | undefined> {
    const query =
      `#${ROOT_LABEL} ` +
      `#${INSTANCE_LABEL}="${escapeSearchValue(this.opts.instanceName)}" ` +
      `#${WORKSPACE_LABEL}="${escapeSearchValue(this.opts.workspaceName)}"`;
    let matches: EtapiNote[];
    try {
      matches = await this.client.searchNotes(query, {
        ancestorNoteId: TRILIUM_ROOT_NOTE_ID,
        limit: 2,
      });
    } catch (e) {
      this.log(`Root recovery search failed (${(e as Error).message}); creating a new root.`);
      return undefined;
    }
    if (matches.length === 1) {
      return matches[0].noteId;
    }
    if (matches.length > 1) {
      this.log(
        `Found ${matches.length} candidate backup roots for "${this.opts.instanceName}/${this.opts.workspaceName}"; ambiguous, creating a new one.`,
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
      await this.client.createLabel(noteId, INSTANCE_LABEL, this.opts.instanceName);
      await this.client.createLabel(noteId, WORKSPACE_LABEL, this.opts.workspaceName);
      this.manifest.rootStamped = true;
    } catch (e) {
      this.log(`Could not stamp backup-root attributes (${(e as Error).message}); continuing.`);
    }
  }

  /** Resolve (creating as needed) the Trilium noteId for a relative directory. */
  private async ensureDir(relDir: string): Promise<string> {
    if (relDir === '' || relDir === '.') {
      return this.manifest.rootNoteId!;
    }
    const existing = this.manifest.entries[relDir];
    if (existing && existing.type === 'dir') {
      return existing.noteId;
    }
    const parentId = await this.ensureDir(path.posix.dirname(relDir));
    const res = await this.client.createNote({
      parentNoteId: parentId,
      title: path.posix.basename(relDir),
      type: 'book',
      content: '',
    });
    this.manifest.entries[relDir] = { noteId: res.note.noteId, type: 'dir' };
    return res.note.noteId;
  }

  private async backupFile(rel: string, summary: SyncSummary): Promise<void> {
    const abs = path.join(this.opts.workspaceRoot, rel);
    // lstat (not stat): a symlink whose target is outside the workspace would
    // otherwise have the TARGET's content uploaded (e.g. a `.md` symlink → an
    // out-of-tree secrets file). Skip symlinks entirely; a backup tool should
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
    const content = buf.toString('utf8');
    const hash = sha256(content);

    const prev = this.manifest.entries[rel];
    if (prev && prev.type === 'file') {
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
      type: 'code',
      mime: mimeForFile(rel),
      content,
    });
    this.manifest.entries[rel] = {
      noteId: res.note.noteId,
      type: 'file',
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
    summary: SyncSummary,
  ): Promise<void> {
    const fileEntries = Object.entries(this.manifest.entries).filter(
      ([, e]) => e.type === 'file',
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
          ([rel, e]) => e.type === 'dir' && !needed.has(rel),
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

/** What a backup WOULD do, computed offline (no ETAPI calls). Lists are
 * workspace-relative posix paths; `skipped` carries why each was skipped. */
export interface BackupPlan {
  created: string[];
  updated: string[];
  unchanged: string[];
  skipped: { rel: string; reason: 'symlink' | 'binary' | 'unreadable' }[];
  /** File entries still in the manifest but no longer on disk. */
  removed: string[];
}

/**
 * Classify what a full backup would do, without contacting Trilium. Applies the
 * same skip rules as the engine (symlinks and binary/NUL files are not backed
 * up) and the same hash-diff against the manifest, so the preview matches the
 * real run. Reads file content but performs no network or write side effects.
 */
export async function planBackup(
  workspaceRoot: string,
  files: string[],
  manifest: Manifest,
  hardDelete = false,
): Promise<BackupPlan> {
  const plan: BackupPlan = {
    created: [],
    updated: [],
    unchanged: [],
    skipped: [],
    removed: [],
  };
  const seen = new Set<string>();
  for (const rel of files) {
    seen.add(rel);
    try {
      const abs = path.join(workspaceRoot, rel);
      const stat = await fs.lstat(abs);
      if (stat.isSymbolicLink()) {
        plan.skipped.push({ rel, reason: 'symlink' });
        continue;
      }
      const buf = await fs.readFile(abs);
      if (buf.includes(0)) {
        plan.skipped.push({ rel, reason: 'binary' });
        continue;
      }
      const hash = sha256(buf.toString('utf8'));
      const prev = manifest.entries[rel];
      if (prev && prev.type === 'file') {
        if (prev.sha256 === hash) {
          plan.unchanged.push(rel);
        } else {
          plan.updated.push(rel);
        }
      } else {
        plan.created.push(rel);
      }
    } catch {
      plan.skipped.push({ rel, reason: 'unreadable' });
    }
  }
  // Tracked files that have vanished since the last backup. Mirror the engine's
  // reconcileDeletions: under soft delete an already-tombstoned (removed) entry is
  // not re-reported (the real run reports 0 for it); under hard delete every
  // absent file is deleted, tombstoned or not.
  for (const [rel, entry] of Object.entries(manifest.entries)) {
    if (entry.type === 'file' && !seen.has(rel) && (hardDelete || !entry.removed)) {
      plan.removed.push(rel);
    }
  }
  return plan;
}

/** Every ancestor directory of every file (posix paths), e.g. "a/b/c.md" →
 * {"a", "a/b"}. Used to find directory entries no file needs anymore. */
export function requiredDirs(files: string[]): Set<string> {
  const dirs = new Set<string>();
  for (const rel of files) {
    let d = path.posix.dirname(rel);
    while (d && d !== '.') {
      dirs.add(d);
      d = path.posix.dirname(d);
    }
  }
  return dirs;
}

function depth(rel: string): number {
  return rel.split('/').length;
}

export function mimeForFile(rel: string): string {
  const ext = path.posix.extname(rel).toLowerCase();
  switch (ext) {
    case '.md':
    case '.markdown':
      return 'text/x-markdown';
    case '.json':
      return 'application/json';
    case '.js':
      return 'application/javascript';
    case '.ts':
      return 'application/typescript';
    default:
      return 'text/plain';
  }
}
