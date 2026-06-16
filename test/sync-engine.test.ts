import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { EtapiClient } from "../src/etapiClient";
import type { Manifest } from "../src/manifest";
import { ProgressReporter, SyncEngine, SyncOptions } from "../src/sync";

// A minimal in-memory ETAPI stand-in that records the calls we care about.
function mockClient() {
  const deleted: string[] = [];
  let created = 0;
  const client = {
    async appInfo() {
      return { appVersion: "test", dbVersion: 0 };
    },
    async getNote(noteId: string) {
      return { noteId, title: "x", type: "book" };
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
  };
  return { client: client as unknown as EtapiClient, deleted, calls: () => created };
}

const OPTS: SyncOptions = {
  workspaceRoot: "/nope",
  workspaceName: "ws",
  rootNoteTitle: "Backup",
  hardDeleteRemovedFiles: true, // so reconcile WOULD delete if it ran
};

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
