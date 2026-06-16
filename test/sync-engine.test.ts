import assert from "node:assert/strict";
import { test } from "node:test";

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
