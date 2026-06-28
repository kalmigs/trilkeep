// The state manifest: the record of what has already been backed up.
//
// Lives at <workspaceRoot>/.trilkeep/state.json (or state.<connection>.json for
// a named connection). It is what makes incremental backup possible — it maps
// every backed-up path to the Trilium noteId it became and the content hash at
// the time, so the next run can tell "unchanged" (skip) from "changed" (update)
// from "new" (create). The manifest is keyed per connection (not per serverUrl)
// so the same repo can back up to two instances without their noteId maps
// colliding, and so a churning LAN URL never orphans the tree. See ./secrets.

import * as fs from "fs/promises";
import * as path from "path";

import { DEFAULT_CONNECTION_NAME, normalizeConnectionName } from "./secrets";

export const MANIFEST_DIR = ".trilkeep";
export const MANIFEST_FILE = "state.json";
export const MANIFEST_VERSION = 1;

/** Manifest filename for a connection. The "default" connection keeps the bare
 * `state.json` name (backward compatible with pre-connection backups); named
 * connections get `state.<slug>.json`. */
export function manifestFileName(connectionName: string): string {
  const name = normalizeConnectionName(connectionName);
  if (name === DEFAULT_CONNECTION_NAME) {
    return MANIFEST_FILE;
  }
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "") || "conn";
  return `state.${slug}.json`;
}

export interface ManifestEntry {
  noteId: string;
  type: "file" | "dir";
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

function manifestPath(workspaceRoot: string, connectionName: string): string {
  return path.join(
    workspaceRoot,
    MANIFEST_DIR,
    manifestFileName(connectionName)
  );
}

export async function loadManifest(
  workspaceRoot: string,
  connectionName: string = DEFAULT_CONNECTION_NAME
): Promise<Manifest> {
  try {
    const raw = await fs.readFile(
      manifestPath(workspaceRoot, connectionName),
      "utf8"
    );
    const parsed = JSON.parse(raw) as Manifest;
    if (parsed.version !== MANIFEST_VERSION) {
      // Future migrations land here. For now, start fresh on version mismatch.
      return freshManifest();
    }
    parsed.entries ??= {};
    return parsed;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return freshManifest();
    }
    throw e;
  }
}

export async function saveManifest(
  workspaceRoot: string,
  manifest: Manifest,
  connectionName: string = DEFAULT_CONNECTION_NAME
): Promise<void> {
  const dir = path.join(workspaceRoot, MANIFEST_DIR);
  await fs.mkdir(dir, { recursive: true });
  // Write to a temp file in the same directory, then rename. rename() is atomic
  // within a filesystem, so a crash mid-write can never leave a truncated
  // state.json that would wedge every future run on JSON.parse.
  const target = manifestPath(workspaceRoot, connectionName);
  const tmp = `${target}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  await fs.rename(tmp, target);
}

export function freshManifest(): Manifest {
  return { version: MANIFEST_VERSION, entries: {} };
}

/** Whether a connection has a backup manifest file in this workspace. Unlike
 * loadManifest (which returns a fresh manifest on ENOENT), this distinguishes
 * "has a backup here" from "absent" — used to decide a connection's liveness. */
export async function manifestExists(
  workspaceRoot: string,
  connectionName: string
): Promise<boolean> {
  try {
    await fs.access(manifestPath(workspaceRoot, connectionName));
    return true;
  } catch {
    return false;
  }
}

/** Move a connection's manifest file to a new connection name (used when a
 * connection is renamed so its backup state carries over). No-op if the source
 * doesn't exist. */
export async function renameConnectionManifest(
  workspaceRoot: string,
  oldName: string,
  newName: string
): Promise<void> {
  const from = manifestPath(workspaceRoot, oldName);
  const to = manifestPath(workspaceRoot, newName);
  try {
    await fs.rename(from, to);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return; // nothing backed up under the old name yet
    }
    throw e;
  }
}
