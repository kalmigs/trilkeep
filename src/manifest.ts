// The state manifest: the record of what has already been backed up.
//
// Lives at <workspaceRoot>/.trilkeep/state.json. It is what makes
// incremental backup possible — it maps every backed-up path to the Trilium
// noteId it became and the content hash at the time, so the next run can tell
// "unchanged" (skip) from "changed" (update) from "new" (create).

import * as fs from "fs/promises";
import * as path from "path";

export const MANIFEST_DIR = ".trilkeep";
export const MANIFEST_FILE = "state.json";
export const MANIFEST_VERSION = 1;

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

function manifestPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, MANIFEST_DIR, MANIFEST_FILE);
}

export async function loadManifest(workspaceRoot: string): Promise<Manifest> {
  try {
    const raw = await fs.readFile(manifestPath(workspaceRoot), "utf8");
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
  manifest: Manifest
): Promise<void> {
  const dir = path.join(workspaceRoot, MANIFEST_DIR);
  await fs.mkdir(dir, { recursive: true });
  // Write to a temp file in the same directory, then rename. rename() is atomic
  // within a filesystem, so a crash mid-write can never leave a truncated
  // state.json that would wedge every future run on JSON.parse.
  const target = manifestPath(workspaceRoot);
  const tmp = `${target}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  await fs.rename(tmp, target);
}

export function freshManifest(): Manifest {
  return { version: MANIFEST_VERSION, entries: {} };
}
