import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { Manifest } from '../src/manifest';
import { BackupPlan, planBackup, sha256 } from '../src/sync';

async function tmpWorkspace(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'tb-plan-'));
}

/** Convenience: a file manifest entry with the sha256 of `content`. */
function fileEntry(noteId: string, content: string) {
  return { noteId, type: 'file' as const, sha256: sha256(content) };
}

test('planBackup classifies new / changed / unchanged against the manifest', async () => {
  const ws = await tmpWorkspace();
  try {
    await fs.writeFile(path.join(ws, 'new.md'), 'brand new');
    await fs.writeFile(path.join(ws, 'changed.md'), 'updated body');
    await fs.writeFile(path.join(ws, 'same.md'), 'identical');

    const manifest: Manifest = {
      version: 1,
      rootNoteId: 'root',
      entries: {
        // changed.md was backed up with DIFFERENT content → changed
        'changed.md': fileEntry('n1', 'old body'),
        // same.md hash matches the file on disk → unchanged
        'same.md': fileEntry('n2', 'identical'),
      },
    };

    const plan = await planBackup(ws, ['new.md', 'changed.md', 'same.md'], manifest);
    assert.deepEqual(plan.created, ['new.md']);
    assert.deepEqual(plan.updated, ['changed.md']);
    assert.deepEqual(plan.unchanged, ['same.md']);
    assert.deepEqual(plan.skipped, []);
    assert.deepEqual(plan.removed, []);
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test('planBackup skips symlinks and binary files with a reason', async () => {
  const ws = await tmpWorkspace();
  try {
    await fs.writeFile(path.join(ws, 'real.md'), 'text');
    await fs.symlink(path.join(ws, 'real.md'), path.join(ws, 'link.md'));
    // A NUL byte marks binary content (same rule as the engine).
    await fs.writeFile(path.join(ws, 'blob.md'), Buffer.from([0x68, 0x00, 0x69]));

    const manifest: Manifest = { version: 1, entries: {} };
    const plan = await planBackup(ws, ['real.md', 'link.md', 'blob.md'], manifest);

    assert.deepEqual(plan.created, ['real.md']);
    const byRel = Object.fromEntries(plan.skipped.map(s => [s.rel, s.reason]));
    assert.equal(byRel['link.md'], 'symlink');
    assert.equal(byRel['blob.md'], 'binary');
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test('planBackup skips secret-looking files with reason "secret" when excludeSecrets is on', async () => {
  const ws = await tmpWorkspace();
  try {
    await fs.writeFile(path.join(ws, 'note.md'), 'text');
    await fs.writeFile(path.join(ws, '.env'), 'TOKEN=x');

    const manifest: Manifest = { version: 1, entries: {} };

    // excludeSecrets on → .env is a "secret" skip, note.md still created.
    const guarded = await planBackup(ws, ['note.md', '.env'], manifest, false, true);
    assert.deepEqual(guarded.created, ['note.md']);
    const byRel = Object.fromEntries(guarded.skipped.map(s => [s.rel, s.reason]));
    assert.equal(byRel['.env'], 'secret');

    // excludeSecrets off → .env is backed up like any other file.
    const open = await planBackup(ws, ['note.md', '.env'], manifest, false, false);
    assert.deepEqual(open.created.sort(), ['.env', 'note.md']);
    assert.deepEqual(open.skipped, []);

    // The default now matches the product default (true): omitting the arg skips secrets.
    const defaulted = await planBackup(ws, ['note.md', '.env'], manifest);
    assert.deepEqual(defaulted.created, ['note.md']);
    assert.equal(defaulted.skipped.find(s => s.rel === '.env')?.reason, 'secret');
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test('planBackup reports tracked files that vanished from disk as removed', async () => {
  const ws = await tmpWorkspace();
  try {
    await fs.writeFile(path.join(ws, 'kept.md'), 'still here');

    const manifest: Manifest = {
      version: 1,
      entries: {
        'kept.md': fileEntry('n1', 'still here'),
        'gone.md': fileEntry('n2', 'deleted since last run'),
        // dir entries are not files, never reported as removed
        sub: { noteId: 'd1', type: 'dir' },
      },
    };

    const plan = await planBackup(ws, ['kept.md'], manifest);
    assert.deepEqual(plan.unchanged, ['kept.md']);
    assert.deepEqual(plan.removed, ['gone.md']);
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test('planBackup: tombstoned entries are skipped under soft delete, reported under hard delete', async () => {
  const ws = await tmpWorkspace();
  try {
    const manifest: Manifest = {
      version: 1,
      entries: {
        // already soft-deleted on a prior run (note kept in Trilium)
        'tombstoned.md': { ...fileEntry('n1', 'x'), removed: true },
        // newly absent this run
        'fresh.md': fileEntry('n2', 'y'),
      },
    };
    const soft = await planBackup(ws, [], manifest, false);
    assert.deepEqual(
      soft.removed,
      ['fresh.md'],
      'soft delete does not re-report an already-tombstoned file',
    );
    const hard = await planBackup(ws, [], manifest, true);
    assert.deepEqual(
      hard.removed.sort(),
      ['fresh.md', 'tombstoned.md'],
      'hard delete reports every absent file, tombstoned or not',
    );
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test('planBackup skips oversized files with a too-large reason, matching the engine', async () => {
  const ws = await tmpWorkspace();
  try {
    await fs.writeFile(path.join(ws, 'big.md'), 'x'.repeat(4096));
    await fs.writeFile(path.join(ws, 'small.md'), 'tiny');
    const manifest: Manifest = { version: 1, entries: {} };

    const capped = await planBackup(ws, ['big.md', 'small.md'], manifest, false, true, 1024);
    assert.deepEqual(capped.created, ['small.md']);
    assert.deepEqual(capped.skipped, [{ rel: 'big.md', reason: 'too-large' }]);

    // 0 = no limit: the dry run must agree with what a real backup would do.
    const uncapped = await planBackup(ws, ['big.md', 'small.md'], manifest, false, true, 0);
    assert.deepEqual(uncapped.created.sort(), ['big.md', 'small.md']);
    assert.deepEqual(uncapped.skipped, []);
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test('planBackup applies the 1 MiB default limit when the caller omits it', async () => {
  const ws = await tmpWorkspace();
  try {
    await fs.writeFile(path.join(ws, 'huge.md'), 'x'.repeat(1024 * 1024 + 1));
    const manifest: Manifest = { version: 1, entries: {} };
    const plan = await planBackup(ws, ['huge.md'], manifest);
    assert.deepEqual(plan.skipped, [{ rel: 'huge.md', reason: 'too-large' }]);
    assert.deepEqual(plan.created, []);
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test('planBackup on an empty workspace with an empty manifest is all-empty', async () => {
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
