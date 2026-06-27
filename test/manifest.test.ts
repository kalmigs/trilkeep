import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  loadManifest,
  manifestFileName,
  MANIFEST_DIR,
  Manifest,
  renameConnectionManifest,
  saveManifest,
} from "../src/manifest";

async function tmpWorkspace(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "tb-manifest-"));
}

test("manifestFileName: default connection keeps the bare state.json", () => {
  assert.equal(manifestFileName("default"), "state.json");
  assert.equal(manifestFileName(""), "state.json");
  assert.equal(manifestFileName("  "), "state.json");
});

test("manifestFileName: named connections get a distinct, slugified file", () => {
  assert.equal(manifestFileName("real"), "state.real.json");
  assert.equal(manifestFileName("test"), "state.test.json");
  assert.notEqual(manifestFileName("real"), manifestFileName("test"));
  // Unsafe filename characters are slugified, not passed through.
  assert.equal(manifestFileName("Home Server!"), "state.home-server.json");
  assert.equal(manifestFileName("a/b\\c"), "state.a-b-c.json");
});

test("manifestFileName: a name that slugifies to nothing falls back", () => {
  assert.equal(manifestFileName("///"), "state.conn.json");
});

test("renameConnectionManifest carries a backup over to the new name", async () => {
  const ws = await tmpWorkspace();
  try {
    const m: Manifest = { version: 1, rootNoteId: "r", entries: {} };
    await saveManifest(ws, m, "old");
    await renameConnectionManifest(ws, "old", "new");
    assert.equal((await loadManifest(ws, "new")).rootNoteId, "r", "moved to new");
    assert.deepEqual(
      (await loadManifest(ws, "old")).entries,
      {},
      "old name no longer has a manifest"
    );
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test("renameConnectionManifest is a no-op when the source doesn't exist", async () => {
  const ws = await tmpWorkspace();
  try {
    await renameConnectionManifest(ws, "missing", "new"); // must not throw
    assert.deepEqual((await loadManifest(ws, "new")).entries, {});
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test("named connections keep independent manifests in the same workspace", async () => {
  const ws = await tmpWorkspace();
  try {
    const real: Manifest = {
      version: 1,
      rootNoteId: "realRoot",
      entries: {},
    };
    const testM: Manifest = {
      version: 1,
      rootNoteId: "testRoot",
      entries: {},
    };
    await saveManifest(ws, real, "real");
    await saveManifest(ws, testM, "test");
    // Each connection reads back its own tree; neither clobbers the other.
    assert.equal((await loadManifest(ws, "real")).rootNoteId, "realRoot");
    assert.equal((await loadManifest(ws, "test")).rootNoteId, "testRoot");
    // The default connection is still empty (separate file).
    assert.deepEqual((await loadManifest(ws)).entries, {});
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

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
