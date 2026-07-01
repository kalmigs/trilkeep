// The state manifest: the record of what has already been backed up.
//
// Lives at <workspaceRoot>/.trilkeep/state.json (or state.<instance>.json for
// a named instance). It is what makes incremental backup possible; it maps
// every backed-up path to the Trilium noteId it became and the content hash at
// the time, so the next run can tell "unchanged" (skip) from "changed" (update)
// from "new" (create). The manifest is keyed per instance (not per serverUrl)
// so the same repo can back up to two instances without their noteId maps
// colliding, and so a churning LAN URL never orphans the tree. See ./secrets.

import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';

import { DEFAULT_INSTANCE_NAME, normalizeInstanceName } from './secrets';

export const MANIFEST_DIR = '.trilkeep';
export const MANIFEST_FILE = 'state.json';
export const MANIFEST_VERSION = 1;

/** Manifest filename for an instance. The "default" instance keeps the bare
 * `state.json` name (the format from before instances had names, kept for
 * backward compatibility); named instances get `state.<slug>.json`. */
export function manifestFileName(instanceName: string): string {
  const name = normalizeInstanceName(instanceName);
  if (name === DEFAULT_INSTANCE_NAME) {
    return MANIFEST_FILE;
  }
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '') || 'inst';
  // The slug is lossy; case-folding and separator-collapsing make distinct
  // instances (e.g. "Work"/"work", "a/b"/"a-b") share a slug, and a
  // case-insensitive filesystem can't even tell state.Work.json from
  // state.work.json. Append a short hash of the EXACT (normalized) name so every
  // distinct instance (each has its own token) gets its own manifest file and
  // never inherits another instance's noteId map.
  const disambig = crypto.createHash('sha256').update(name).digest('hex').slice(0, 8);
  return `state.${slug}-${disambig}.json`;
}

export interface ManifestEntry {
  noteId: string;
  type: 'file' | 'dir';
  /** sha256 of the file content (files only). */
  sha256?: string;
  mtimeMs?: number;
  /** Soft-delete tombstone: file is gone locally but kept in Trilium. Set so
   * the removal is logged once, not re-logged on every subsequent run. */
  removed?: boolean;
}

export interface Manifest {
  version: number;
  /** Trilium noteId of the top-level backup note for this workspace. */
  rootNoteId?: string;
  /** True once the root note has been stamped with its identifying labels.
   * Lets a root created before stamping existed (or an unstamped one) get
   * stamped exactly once, without re-stamping on every run. */
  rootStamped?: boolean;
  /** The Trilium note the backup root is currently placed under (a container, an
   * arbitrary parent note, or Trilium's `root`). Cached so a `group` change is
   * detected cheaply and the root is moved (re-parented) instead of duplicated. */
  rootParentNoteId?: string;
  /** True while an inheritable #readOnly label is stamped on the root (the
   * read-only-mirror setting). Lets the label be added/removed exactly when the
   * setting toggles, without re-checking Trilium every run. */
  readOnlyStamped?: boolean;
  /** Keyed by workspace-relative POSIX path. */
  entries: Record<string, ManifestEntry>;
}

function manifestPath(workspaceRoot: string, instanceName: string): string {
  return path.join(workspaceRoot, MANIFEST_DIR, manifestFileName(instanceName));
}

export async function loadManifest(
  workspaceRoot: string,
  instanceName: string = DEFAULT_INSTANCE_NAME,
): Promise<Manifest> {
  try {
    const raw = await fs.readFile(manifestPath(workspaceRoot, instanceName), 'utf8');
    const parsed = JSON.parse(raw) as Manifest;
    if (parsed.version > MANIFEST_VERSION) {
      // Written by a NEWER Trilkeep. Silently resetting it would re-upload every
      // file and duplicate child notes, so surface it instead: the user should
      // update the extension (or delete the state file to start fresh).
      throw new Error(
        `Trilkeep: the backup state file .trilkeep/${manifestFileName(instanceName)} was ` +
          `written by a newer version of Trilkeep (state v${parsed.version}; this build ` +
          `supports up to v${MANIFEST_VERSION}). Update Trilkeep, or delete that file to start fresh.`,
      );
    }
    if (parsed.version < MANIFEST_VERSION) {
      // Older version: no migration implemented yet, so start fresh. Real
      // v1 -> vN migration logic lands here.
      return freshManifest();
    }
    parsed.entries ??= {};
    return parsed;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return freshManifest();
    }
    throw e;
  }
}

export async function saveManifest(
  workspaceRoot: string,
  manifest: Manifest,
  instanceName: string = DEFAULT_INSTANCE_NAME,
): Promise<void> {
  const dir = path.join(workspaceRoot, MANIFEST_DIR);
  await fs.mkdir(dir, { recursive: true });
  // Write to a temp file in the same directory, then rename. rename() is atomic
  // within a filesystem, so a crash mid-write can never leave a truncated
  // state.json that would wedge every future run on JSON.parse.
  const target = manifestPath(workspaceRoot, instanceName);
  const tmp = `${target}.tmp`;
  // Serialize the small metadata fields first and the (potentially huge) entries
  // map LAST, so state.json stays scannable (rootNoteId/flags at the top) instead
  // of burying them under the entries blob. Key order is otherwise insertion
  // order, which puts entries early (it's set in freshManifest).
  const { entries, ...meta } = manifest;
  const ordered = { ...meta, entries };
  await fs.writeFile(tmp, JSON.stringify(ordered, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, target);
}

export function freshManifest(): Manifest {
  return { version: MANIFEST_VERSION, entries: {} };
}

/** Whether an instance has a backup manifest file in this workspace. Unlike
 * loadManifest (which returns a fresh manifest on ENOENT), this distinguishes
 * "has a backup here" from "absent"; used to decide an instance's liveness. */
export async function manifestExists(
  workspaceRoot: string,
  instanceName: string,
): Promise<boolean> {
  try {
    await fs.access(manifestPath(workspaceRoot, instanceName));
    return true;
  } catch {
    return false;
  }
}

/** Move an instance's manifest file to a new instance name (used when a
 * instance is renamed so its backup state carries over). No-op if the source
 * doesn't exist. */
export async function renameInstanceManifest(
  workspaceRoot: string,
  oldName: string,
  newName: string,
): Promise<void> {
  const from = manifestPath(workspaceRoot, oldName);
  const to = manifestPath(workspaceRoot, newName);
  // Never clobber an existing backup under the new name: fs.rename silently
  // overwrites its destination, which would destroy that instance's noteId map.
  if (await manifestExists(workspaceRoot, newName)) {
    throw new Error(
      `A backup already exists for instance "${newName}"; rename aborted to avoid overwriting it.`,
    );
  }
  try {
    await fs.rename(from, to);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return; // nothing backed up under the old name yet
    }
    throw e;
  }
}

/** Delete an instance's manifest file in this workspace (used by Forget
 * Instance when the user opts to discard the backup state). No-op if the file
 * doesn't exist. Leaves the Trilium tree untouched; this only drops local state. */
export async function deleteInstanceManifest(
  workspaceRoot: string,
  instanceName: string,
): Promise<void> {
  try {
    await fs.unlink(manifestPath(workspaceRoot, instanceName));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return; // nothing backed up under this name
    }
    throw e;
  }
}
