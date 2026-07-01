import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  deleteInstanceManifest,
  loadManifest,
  manifestExists,
  manifestFileName,
  MANIFEST_DIR,
  MANIFEST_VERSION,
  Manifest,
  renameInstanceManifest,
  saveManifest,
} from '../src/manifest';

async function tmpWorkspace(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'tb-manifest-'));
}

test('manifestFileName: default instance keeps the bare state.json', () => {
  assert.equal(manifestFileName('default'), 'state.json');
  assert.equal(manifestFileName(''), 'state.json');
  assert.equal(manifestFileName('  '), 'state.json');
});

test('manifestFileName: named instances get a distinct, slugified file (+hash)', () => {
  assert.match(manifestFileName('real'), /^state\.real-[0-9a-f]{8}\.json$/);
  assert.match(manifestFileName('test'), /^state\.test-[0-9a-f]{8}\.json$/);
  assert.notEqual(manifestFileName('real'), manifestFileName('test'));
  // Unsafe filename characters are slugified, not passed through.
  assert.match(manifestFileName('Home Server!'), /^state\.home-server-[0-9a-f]{8}\.json$/);
  assert.match(manifestFileName('a/b\\c'), /^state\.a-b-c-[0-9a-f]{8}\.json$/);
});

test('manifestFileName: a name that slugifies to nothing falls back', () => {
  assert.match(manifestFileName('///'), /^state\.inst-[0-9a-f]{8}\.json$/);
});

test('manifestFileName: collision-prone distinct names get distinct files', () => {
  // These collapse to the same slug but are DISTINCT instances (distinct tokens
  // via tokenKey), so they must not share a manifest file (and so a noteId map).
  assert.notEqual(manifestFileName('Work'), manifestFileName('work'));
  assert.notEqual(manifestFileName('work test'), manifestFileName('work-test'));
  // Same name (after normalize) still maps to the same file; re-runs are stable.
  assert.equal(manifestFileName('real'), manifestFileName('  real  '));
});

test('renameInstanceManifest carries a backup over to the new name', async () => {
  const ws = await tmpWorkspace();
  try {
    const m: Manifest = { version: 1, rootNoteId: 'r', entries: {} };
    await saveManifest(ws, m, 'old');
    await renameInstanceManifest(ws, 'old', 'new');
    assert.equal((await loadManifest(ws, 'new')).rootNoteId, 'r', 'moved to new');
    assert.deepEqual(
      (await loadManifest(ws, 'old')).entries,
      {},
      'old name no longer has a manifest',
    );
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test("renameInstanceManifest is a no-op when the source doesn't exist", async () => {
  const ws = await tmpWorkspace();
  try {
    await renameInstanceManifest(ws, 'missing', 'new'); // must not throw
    assert.deepEqual((await loadManifest(ws, 'new')).entries, {});
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test('deleteInstanceManifest removes only the named instance’s state', async () => {
  const ws = await tmpWorkspace();
  try {
    await saveManifest(ws, { version: 1, rootNoteId: 'a', entries: {} }, 'gone');
    await saveManifest(ws, { version: 1, rootNoteId: 'b', entries: {} }, 'kept');
    await deleteInstanceManifest(ws, 'gone');
    assert.equal(await manifestExists(ws, 'gone'), false, 'forgotten manifest deleted');
    assert.equal((await loadManifest(ws, 'kept')).rootNoteId, 'b', 'other instance untouched');
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test("deleteInstanceManifest is a no-op when the manifest doesn't exist", async () => {
  const ws = await tmpWorkspace();
  try {
    await deleteInstanceManifest(ws, 'missing'); // must not throw
    assert.equal(await manifestExists(ws, 'missing'), false);
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test('loadManifest rethrows on a corrupt (non-JSON) state file', async () => {
  // Precondition for the manual-backup command's reportError guard: a corrupt
  // state.json must SURFACE (not be silently treated as a fresh manifest, which
  // would then reconcile the whole tree as removed).
  const ws = await tmpWorkspace();
  try {
    await fs.mkdir(path.join(ws, MANIFEST_DIR), { recursive: true });
    await fs.writeFile(path.join(ws, MANIFEST_DIR, 'state.json'), '{ not: valid');
    await assert.rejects(() => loadManifest(ws));
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test('renameInstanceManifest refuses to overwrite an existing destination', async () => {
  const ws = await tmpWorkspace();
  try {
    await saveManifest(ws, { version: 1, rootNoteId: 'old', entries: {} }, 'old');
    await saveManifest(ws, { version: 1, rootNoteId: 'keep', entries: {} }, 'new');
    await assert.rejects(() => renameInstanceManifest(ws, 'old', 'new'), /already exists/);
    // The existing destination manifest must be untouched.
    assert.equal((await loadManifest(ws, 'new')).rootNoteId, 'keep');
    // And the source must still be intact (not consumed by a partial move).
    assert.equal((await loadManifest(ws, 'old')).rootNoteId, 'old');
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test('named instances keep independent manifests in the same workspace', async () => {
  const ws = await tmpWorkspace();
  try {
    const real: Manifest = {
      version: 1,
      rootNoteId: 'realRoot',
      entries: {},
    };
    const testM: Manifest = {
      version: 1,
      rootNoteId: 'testRoot',
      entries: {},
    };
    await saveManifest(ws, real, 'real');
    await saveManifest(ws, testM, 'test');
    // Each instance reads back its own tree; neither clobbers the other.
    assert.equal((await loadManifest(ws, 'real')).rootNoteId, 'realRoot');
    assert.equal((await loadManifest(ws, 'test')).rootNoteId, 'testRoot');
    // The default instance is still empty (separate file).
    assert.deepEqual((await loadManifest(ws)).entries, {});
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test('loadManifest returns a fresh manifest when none exists', async () => {
  const ws = await tmpWorkspace();
  try {
    const m = await loadManifest(ws);
    assert.equal(m.version, 1);
    assert.deepEqual(m.entries, {});
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test('loadManifest discards an OLDER-version manifest (migration hook)', async () => {
  // An older format version: no migration implemented yet, so start fresh. The
  // old root + noteId map are dropped. When real v1->vN migration lands, update
  // this to assert the carried-over state instead.
  const ws = await tmpWorkspace();
  try {
    const stale: Manifest = {
      version: MANIFEST_VERSION - 1,
      rootNoteId: 'stale',
      entries: { 'a.md': { noteId: 'n1', type: 'file', sha256: 'deadbeef' } },
    };
    await saveManifest(ws, stale);

    const m = await loadManifest(ws);
    assert.equal(m.version, MANIFEST_VERSION);
    assert.deepEqual(m.entries, {});
    assert.equal(m.rootNoteId, undefined);
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test('loadManifest surfaces an error for a NEWER-version manifest (no silent discard)', async () => {
  // A manifest written by a newer Trilkeep must NOT be silently reset (that would
  // re-upload everything and duplicate child notes). Surface it so the user
  // updates the extension or removes the file deliberately.
  const ws = await tmpWorkspace();
  try {
    const future: Manifest = {
      version: MANIFEST_VERSION + 1,
      rootNoteId: 'future',
      entries: { 'a.md': { noteId: 'n1', type: 'file', sha256: 'deadbeef' } },
    };
    await saveManifest(ws, future);

    await assert.rejects(() => loadManifest(ws), /newer version/);
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test('save then load round-trips the manifest', async () => {
  const ws = await tmpWorkspace();
  try {
    const m: Manifest = {
      version: 1,
      rootNoteId: 'root1',
      entries: { 'a.md': { noteId: 'n1', type: 'file', sha256: 'abc' } },
    };
    await saveManifest(ws, m);
    assert.deepEqual(await loadManifest(ws), m);
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test('saveManifest leaves no .tmp file behind (atomic rename)', async () => {
  const ws = await tmpWorkspace();
  try {
    await saveManifest(ws, { version: 1, entries: {} });
    const files = await fs.readdir(path.join(ws, MANIFEST_DIR));
    assert.deepEqual(
      files.filter(f => f.endsWith('.tmp')),
      [],
      'no leftover temp file',
    );
    assert.ok(files.includes('state.json'));
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test('saveManifest always serializes entries LAST, even as new fields are added', async () => {
  const ws = await tmpWorkspace();
  try {
    // entries in the MIDDLE and a hypothetical future field AFTER it — the exact
    // insertion order that would bury the metadata without the reorder in
    // saveManifest. The invariant (entries last) must hold regardless.
    const manifest = {
      version: MANIFEST_VERSION,
      entries: { 'a.md': { noteId: 'x', type: 'file', sha256: 'h' } },
      rootNoteId: 'R',
      futureField: 'whatever',
    } as unknown as Manifest;
    await saveManifest(ws, manifest, 'default');
    const raw = await fs.readFile(path.join(ws, MANIFEST_DIR, manifestFileName('default')), 'utf8');
    const keys = Object.keys(JSON.parse(raw));
    assert.equal(keys.at(-1), 'entries', 'entries must be the last key');
    assert.ok(
      keys.indexOf('futureField') < keys.indexOf('entries'),
      'a field added after entries must still serialize before it',
    );
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});
