import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { Manifest } from "../src/manifest";
import { BackupPlan, planBackup, sha256 } from "../src/sync";

async function tmpWorkspace(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "tb-plan-"));
}

/** Convenience: a file manifest entry with the sha256 of `content`. */
function fileEntry(noteId: string, content: string) {
  return { noteId, type: "file" as const, sha256: sha256(content) };
}

test("planBackup classifies new / changed / unchanged against the manifest", async () => {
  const ws = await tmpWorkspace();
  try {
    await fs.writeFile(path.join(ws, "new.md"), "brand new");
    await fs.writeFile(path.join(ws, "changed.md"), "updated body");
    await fs.writeFile(path.join(ws, "same.md"), "identical");

    const manifest: Manifest = {
      version: 1,
      rootNoteId: "root",
      entries: {
        // changed.md was backed up with DIFFERENT content → changed
        "changed.md": fileEntry("n1", "old body"),
        // same.md hash matches the file on disk → unchanged
        "same.md": fileEntry("n2", "identical"),
      },
    };

    const plan = await planBackup(ws, ["new.md", "changed.md", "same.md"], manifest);
    assert.deepEqual(plan.created, ["new.md"]);
    assert.deepEqual(plan.updated, ["changed.md"]);
    assert.deepEqual(plan.unchanged, ["same.md"]);
    assert.deepEqual(plan.skipped, []);
    assert.deepEqual(plan.removed, []);
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test("planBackup skips symlinks and binary files with a reason", async () => {
  const ws = await tmpWorkspace();
  try {
    await fs.writeFile(path.join(ws, "real.md"), "text");
    await fs.symlink(path.join(ws, "real.md"), path.join(ws, "link.md"));
    // A NUL byte marks binary content (same rule as the engine).
    await fs.writeFile(path.join(ws, "blob.md"), Buffer.from([0x68, 0x00, 0x69]));

    const manifest: Manifest = { version: 1, entries: {} };
    const plan = await planBackup(ws, ["real.md", "link.md", "blob.md"], manifest);

    assert.deepEqual(plan.created, ["real.md"]);
    const byRel = Object.fromEntries(plan.skipped.map((s) => [s.rel, s.reason]));
    assert.equal(byRel["link.md"], "symlink");
    assert.equal(byRel["blob.md"], "binary");
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test("planBackup reports tracked files that vanished from disk as removed", async () => {
  const ws = await tmpWorkspace();
  try {
    await fs.writeFile(path.join(ws, "kept.md"), "still here");

    const manifest: Manifest = {
      version: 1,
      entries: {
        "kept.md": fileEntry("n1", "still here"),
        "gone.md": fileEntry("n2", "deleted since last run"),
        // dir entries are not files — never reported as removed
        sub: { noteId: "d1", type: "dir" },
      },
    };

    const plan = await planBackup(ws, ["kept.md"], manifest);
    assert.deepEqual(plan.unchanged, ["kept.md"]);
    assert.deepEqual(plan.removed, ["gone.md"]);
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test("planBackup on an empty workspace with an empty manifest is all-empty", async () => {
  const ws = await tmpWorkspace();
  try {
    const manifest: Manifest = { version: 1, entries: {} };
    const plan: BackupPlan = await planBackup(ws, [], manifest);
    assert.deepEqual(plan, {
      created: [],
      updated: [],
      unchanged: [],
      skipped: [],
      removed: [],
    });
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});
