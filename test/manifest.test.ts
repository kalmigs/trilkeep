import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  loadManifest,
  MANIFEST_DIR,
  Manifest,
  saveManifest,
} from "../src/manifest";

async function tmpWorkspace(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "tb-manifest-"));
}

test("loadManifest returns a fresh manifest when none exists", async () => {
  const ws = await tmpWorkspace();
  try {
    const m = await loadManifest(ws);
    assert.equal(m.version, 1);
    assert.deepEqual(m.entries, {});
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test("save then load round-trips the manifest", async () => {
  const ws = await tmpWorkspace();
  try {
    const m: Manifest = {
      version: 1,
      rootNoteId: "root1",
      entries: { "a.md": { noteId: "n1", type: "file", sha256: "abc" } },
    };
    await saveManifest(ws, m);
    assert.deepEqual(await loadManifest(ws), m);
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test("saveManifest leaves no .tmp file behind (atomic rename)", async () => {
  const ws = await tmpWorkspace();
  try {
    await saveManifest(ws, { version: 1, entries: {} });
    const files = await fs.readdir(path.join(ws, MANIFEST_DIR));
    assert.deepEqual(
      files.filter((f) => f.endsWith(".tmp")),
      [],
      "no leftover temp file"
    );
    assert.ok(files.includes("state.json"));
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});
