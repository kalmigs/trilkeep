import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { EtapiClient } from "../src/etapiClient";
import type { Manifest } from "../src/manifest";
import {
  ProgressReporter,
  renameRootConnectionLabel,
  SyncEngine,
  SyncOptions,
} from "../src/sync";

interface StampedLabel {
  noteId: string;
  name: string;
  value: string;
}

interface MockNote {
  title?: string;
  attributes?: { attributeId: string; type: string; name: string; value?: string }[];
}

// A minimal in-memory ETAPI stand-in that records the calls we care about.
// `searchResults` controls what findExistingRoot sees (root recovery);
// `existingNote` controls what getNote returns (title/attributes).
function mockClient(
  searchResults: { noteId: string }[] = [],
  existingNote: MockNote = {}
) {
  const deleted: string[] = [];
  const labels: StampedLabel[] = [];
  const searches: string[] = [];
  const titlePatches: { noteId: string; title?: string }[] = [];
  const attrPatches: { attributeId: string; value: string }[] = [];
  let created = 0;
  const client = {
    async appInfo() {
      return { appVersion: "test", dbVersion: 0 };
    },
    async getNote(noteId: string) {
      return {
        noteId,
        title: existingNote.title ?? "x",
        type: "book",
        attributes: existingNote.attributes,
      };
    },
    async createNote() {
      created++;
      return { note: { noteId: `new${created}` }, branch: {} };
    },
    async putContent() {
      /* no-op */
    },
    async deleteNote(noteId: string) {
      deleted.push(noteId);
    },
    async createLabel(noteId: string, name: string, value = "") {
      labels.push({ noteId, name, value });
    },
    async searchNotes(search: string) {
      searches.push(search);
      return searchResults;
    },
    async patchNote(noteId: string, patch: { title?: string }) {
      titlePatches.push({ noteId, ...patch });
    },
    async patchAttribute(attributeId: string, value: string) {
      attrPatches.push({ attributeId, value });
    },
  };
  return {
    client: client as unknown as EtapiClient,
    deleted,
    labels,
    searches,
    titlePatches,
    attrPatches,
    calls: () => created,
  };
}

const OPTS: SyncOptions = {
  workspaceRoot: "/nope",
  workspaceName: "ws",
  connectionName: "conn",
  rootNoteTitle: "Backup",
  hardDeleteRemovedFiles: true, // so reconcile WOULD delete if it ran
};

/** A manifest with no rootNoteId — the "first run / lost manifest" path that
 * triggers root recovery/creation. */
function rootlessManifest(): Manifest {
  return { version: 1, entries: {} };
}

function manifestWith(rel: string): Manifest {
  return {
    version: 1,
    rootNoteId: "root1",
    entries: { [rel]: { noteId: "na", type: "file", sha256: "deadbeef" } },
  };
}

const noopProgress = (cancelled: boolean): ProgressReporter => ({
  report: () => undefined,
  isCancelled: () => cancelled,
});

test("cancelled backup does NOT reconcile deletions (no data loss)", async () => {
  const { client, deleted } = mockClient();
  const manifest = manifestWith("a.md");
  const engine = new SyncEngine(client, manifest, OPTS, () => undefined);

  // Cancelled before any file is processed → `seen` is empty.
  const summary = await engine.backup(["a.md"], noopProgress(true));

  assert.deepEqual(deleted, [], "no notes should be deleted on cancel");
  assert.ok(manifest.entries["a.md"], "manifest entry must survive a cancel");
  assert.equal(summary.removed, 0);
});

test("completed backup DOES reconcile deletions (guard is cancel-specific)", async () => {
  const { client, deleted } = mockClient();
  const manifest = manifestWith("gone.md");
  const engine = new SyncEngine(client, manifest, OPTS, () => undefined);

  // Empty file list (no disk I/O), not cancelled → "gone.md" is truly absent.
  const summary = await engine.backup([], noopProgress(false));

  assert.deepEqual(deleted, ["na"], "absent file's note should be deleted");
  assert.equal(manifest.entries["gone.md"], undefined, "entry should be removed");
  assert.equal(summary.removed, 1);
});

test("reconcile:false (single-file backup) never deletes absent files", async () => {
  const { client, deleted } = mockClient();
  const manifest = manifestWith("gone.md");
  const engine = new SyncEngine(client, manifest, OPTS, () => undefined);

  const summary = await engine.backup([], noopProgress(false), { reconcile: false });

  assert.deepEqual(deleted, [], "partial backup must not delete anything");
  assert.ok(manifest.entries["gone.md"], "entry must survive a partial backup");
  assert.equal(summary.removed, 0);
});

test("orphan directory notes are deleted under hardDelete", async () => {
  const { client, deleted } = mockClient();
  const manifest: Manifest = {
    version: 1,
    rootNoteId: "root1",
    entries: { stale: { noteId: "nd", type: "dir" } },
  };
  const engine = new SyncEngine(client, manifest, OPTS, () => undefined);

  // No files reference "stale" → it's orphaned.
  await engine.backup([], noopProgress(false));

  assert.deepEqual(deleted, ["nd"], "orphan dir note should be deleted");
  assert.equal(manifest.entries["stale"], undefined, "dir entry should be pruned");
});

test("soft-delete logs a removal once (tombstone), not every run", async () => {
  const { client } = mockClient();
  const logs: string[] = [];
  const manifest = manifestWith("gone.md");
  const softOpts: SyncOptions = { ...OPTS, hardDeleteRemovedFiles: false };
  const engine = new SyncEngine(client, manifest, softOpts, (m) => logs.push(m));

  const first = await engine.backup([], noopProgress(false));
  const second = await engine.backup([], noopProgress(false));

  assert.equal(first.removed, 1, "first run reports the removal");
  assert.equal(second.removed, 0, "second run does not re-report it");
  assert.ok(manifest.entries["gone.md"].removed, "entry is tombstoned, kept");
  assert.equal(
    logs.filter((l) => l.includes("removed (kept in Trilium)")).length,
    1,
    "removal logged exactly once across two runs"
  );
});

test("a new root is stamped with identifying labels (connection + workspace)", async () => {
  const { client, labels, calls } = mockClient([]); // search finds nothing
  const manifest = rootlessManifest();
  const engine = new SyncEngine(client, manifest, OPTS, () => undefined);

  await engine.backup([], noopProgress(false));

  assert.equal(calls(), 1, "a fresh root note is created");
  const rootId = manifest.rootNoteId;
  assert.ok(rootId, "rootNoteId recorded in the manifest");
  assert.deepEqual(
    labels.map((l) => `${l.name}=${l.value}`).sort(),
    ["trilkeepConnection=conn", "trilkeepRoot=", "trilkeepWorkspace=ws"].sort(),
    "root stamped with marker + connection + workspace labels"
  );
  assert.ok(
    labels.every((l) => l.noteId === rootId),
    "labels attached to the new root note"
  );
});

test("an existing stamped root is recovered, not duplicated, when the manifest is lost", async () => {
  const { client, labels, calls, searches } = mockClient([{ noteId: "oldRoot" }]);
  const manifest = rootlessManifest();
  const engine = new SyncEngine(client, manifest, OPTS, () => undefined);

  await engine.backup([], noopProgress(false));

  assert.equal(manifest.rootNoteId, "oldRoot", "reattached to the existing root");
  assert.equal(calls(), 0, "no duplicate root note created");
  assert.deepEqual(labels, [], "no re-stamping when adopting an existing root");
  assert.ok(
    searches[0].includes('#trilkeepConnection="conn"') &&
      searches[0].includes('#trilkeepWorkspace="ws"'),
    "recovery search is scoped by connection + workspace"
  );
});

test("ambiguous multiple candidate roots → a new root is created (no wrong adopt)", async () => {
  const { client, calls } = mockClient([{ noteId: "a" }, { noteId: "b" }]);
  const manifest = rootlessManifest();
  const engine = new SyncEngine(client, manifest, OPTS, () => undefined);

  await engine.backup([], noopProgress(false));

  assert.equal(calls(), 1, "ambiguity must not adopt — a fresh root is created");
  assert.equal(manifest.rootNoteId, "new1");
});

test("an existing unstamped root gets stamped once, then not re-stamped", async () => {
  const { client, labels } = mockClient();
  // A pre-stamping manifest: valid rootNoteId, no rootStamped flag.
  const manifest: Manifest = { version: 1, rootNoteId: "root1", entries: {} };
  const engine = new SyncEngine(client, manifest, OPTS, () => undefined);

  await engine.backup([], noopProgress(false));
  assert.equal(labels.length, 3, "unstamped existing root is stamped once");
  assert.equal(manifest.rootStamped, true, "flag recorded after stamping");

  await engine.backup([], noopProgress(false));
  assert.equal(labels.length, 3, "already-stamped root is not re-stamped");
});

test("root note title is synced when rootNoteTitle/workspace changed", async () => {
  // Existing root titled "x"; desired is `${rootNoteTitle}: ${workspaceName}`.
  const { client, titlePatches } = mockClient([], { title: "x" });
  const manifest: Manifest = {
    version: 1,
    rootNoteId: "root1",
    rootStamped: true,
    entries: {},
  };
  const engine = new SyncEngine(client, manifest, OPTS, () => undefined);

  await engine.backup([], noopProgress(false));

  assert.deepEqual(titlePatches, [{ noteId: "root1", title: "Backup: ws" }]);
});

test("root note title is NOT patched when it already matches", async () => {
  const { client, titlePatches } = mockClient([], { title: "Backup: ws" });
  const manifest: Manifest = {
    version: 1,
    rootNoteId: "root1",
    rootStamped: true,
    entries: {},
  };
  const engine = new SyncEngine(client, manifest, OPTS, () => undefined);

  await engine.backup([], noopProgress(false));

  assert.deepEqual(titlePatches, [], "no rename when the title is unchanged");
});

test("renameRootConnectionLabel patches the connection label on the root", async () => {
  const { client, attrPatches } = mockClient([], {
    attributes: [
      { attributeId: "a1", type: "label", name: "trilkeepConnection", value: "old" },
      { attributeId: "a2", type: "label", name: "trilkeepRoot", value: "" },
    ],
  });

  await renameRootConnectionLabel(client, "root1", "real");

  assert.deepEqual(attrPatches, [{ attributeId: "a1", value: "real" }]);
});

test("renameRootConnectionLabel is a no-op when no connection label exists", async () => {
  const { client, attrPatches } = mockClient([], { attributes: [] });
  await renameRootConnectionLabel(client, "root1", "real");
  assert.deepEqual(attrPatches, []);
});

test("binary files are skipped, not corrupted into a note", async () => {
  const { client, calls } = mockClient();
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "tb-bin-"));
  try {
    await fs.writeFile(path.join(ws, "image.bin"), Buffer.from([0x89, 0x00, 0x42]));
    const manifest: Manifest = { version: 1, rootNoteId: "root1", entries: {} };
    const engine = new SyncEngine(
      client,
      manifest,
      { ...OPTS, workspaceRoot: ws },
      () => undefined
    );

    const summary = await engine.backup(["image.bin"], noopProgress(false));

    assert.equal(summary.skipped, 1, "binary file counted as skipped");
    assert.equal(calls(), 0, "no note created for binary content");
    assert.equal(manifest.entries["image.bin"], undefined, "not tracked");
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test("symlinks are skipped, not followed to an out-of-tree target", async () => {
  const { client, calls } = mockClient();
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "tb-link-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "tb-secret-"));
  try {
    // A secret living outside the workspace, and an in-workspace symlink to it.
    const secret = path.join(outside, "secret.md");
    await fs.writeFile(secret, "TOP SECRET — must never be uploaded");
    await fs.symlink(secret, path.join(ws, "link.md"));
    const manifest: Manifest = { version: 1, rootNoteId: "root1", entries: {} };
    const engine = new SyncEngine(
      client,
      manifest,
      { ...OPTS, workspaceRoot: ws },
      () => undefined
    );

    const summary = await engine.backup(["link.md"], noopProgress(false));

    assert.equal(summary.skipped, 1, "symlink counted as skipped");
    assert.equal(calls(), 0, "no note created from a symlink target");
    assert.equal(manifest.entries["link.md"], undefined, "symlink not tracked");
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});
