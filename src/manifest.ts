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
