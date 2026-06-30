import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { EtapiClient } from '../src/etapiClient';
import type { Manifest } from '../src/manifest';
import {
  parseGroupPath,
  ProgressReporter,
  renameRootInstanceLabel,
  SyncEngine,
  SyncOptions,
} from '../src/sync';

interface StampedLabel {
  noteId: string;
  name: string;
  value: string;
}

interface MockNote {
  title?: string;
  attributes?: { attributeId: string; type: string; name: string; value?: string }[];
  /** Branch ids placing this note under its parent(s); drives move/re-parent. */
  parentBranchIds?: string[];
  /** parentNoteId returned by getBranch() for those branches (the "old" parent). */
  branchParent?: string;
}

// A minimal in-memory ETAPI stand-in that records the calls we care about.
// `searchResults` controls what findExistingRoot sees (root recovery);
// `existingNote` controls what getNote returns (title/attributes/branches);
// `containerResults` is returned for container searches (group nesting).
function mockClient(
  searchResults: { noteId: string }[] = [],
  existingNote: MockNote = {},
  opts: { containerResults?: { noteId: string }[]; failCreateLabel?: boolean } = {},
) {
  const deleted: string[] = [];
  const labels: (StampedLabel & { inheritable: boolean })[] = [];
  const searches: string[] = [];
  const titlePatches: { noteId: string; title?: string }[] = [];
  const attrPatches: { attributeId: string; value: string }[] = [];
  const createdParents: string[] = [];
  const branchCreates: { noteId: string; parentNoteId: string }[] = [];
  const branchDeletes: string[] = [];
  const attrDeletes: string[] = [];
  let created = 0;
  let getNoteCount = 0;
  const client = {
    async appInfo() {
      return { appVersion: 'test', dbVersion: 0 };
    },
    async getNote(noteId: string) {
      getNoteCount++;
      return {
        noteId,
        title: existingNote.title ?? 'x',
        type: 'book',
        attributes: existingNote.attributes,
        parentBranchIds: existingNote.parentBranchIds,
      };
    },
    async createNote(params: { parentNoteId: string }) {
      created++;
      createdParents.push(params.parentNoteId);
      return { note: { noteId: `new${created}` }, branch: {} };
    },
    async putContent() {
      /* no-op */
    },
    async deleteNote(noteId: string) {
      deleted.push(noteId);
    },
    async createLabel(noteId: string, name: string, value = '', o: { inheritable?: boolean } = {}) {
      if (opts.failCreateLabel) {
        throw new Error('simulated stamp failure');
      }
      labels.push({ noteId, name, value, inheritable: !!o.inheritable });
    },
    async deleteAttribute(attributeId: string) {
      attrDeletes.push(attributeId);
    },
    async createBranch(noteId: string, parentNoteId: string) {
      branchCreates.push({ noteId, parentNoteId });
      return { branchId: `b${branchCreates.length}`, noteId, parentNoteId };
    },
    async getBranch(branchId: string) {
      return {
        branchId,
        noteId: 'root1',
        parentNoteId: existingNote.branchParent ?? 'oldParent',
      };
    },
    async deleteBranch(branchId: string) {
      branchDeletes.push(branchId);
    },
    async searchNotes(search: string) {
      searches.push(search);
      return search.includes('trilkeepContainer') ? (opts.containerResults ?? []) : searchResults;
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
    createdParents,
    branchCreates,
    branchDeletes,
    attrDeletes,
    calls: () => created,
    getNoteCalls: () => getNoteCount,
  };
}

const OPTS: SyncOptions = {
  workspaceRoot: '/nope',
  workspaceName: 'ws',
  instanceName: 'conn',
  rootNoteTitle: 'Backup',
  hardDeleteRemovedFiles: true, // so reconcile WOULD delete if it ran
};

/** A manifest with no rootNoteId; the "first run / lost manifest" path that
 * triggers root recovery/creation. */
function rootlessManifest(): Manifest {
  return { version: 1, entries: {} };
}

function manifestWith(rel: string): Manifest {
  return {
    version: 1,
    rootNoteId: 'root1',
    entries: { [rel]: { noteId: 'na', type: 'file', sha256: 'deadbeef' } },
  };
}

const noopProgress = (cancelled: boolean): ProgressReporter => ({
  report: () => undefined,
  isCancelled: () => cancelled,
});

test('cancelled backup does NOT reconcile deletions (no data loss)', async () => {
  const { client, deleted } = mockClient();
  const manifest = manifestWith('a.md');
  const engine = new SyncEngine(client, manifest, OPTS, () => undefined);

  // Cancelled before any file is processed → `seen` is empty.
  const summary = await engine.backup(['a.md'], noopProgress(true));

  assert.deepEqual(deleted, [], 'no notes should be deleted on cancel');
  assert.ok(manifest.entries['a.md'], 'manifest entry must survive a cancel');
  assert.equal(summary.removed, 0);
});

test('completed backup DOES reconcile deletions (guard is cancel-specific)', async () => {
  const { client, deleted } = mockClient();
  const manifest = manifestWith('gone.md');
  const engine = new SyncEngine(client, manifest, OPTS, () => undefined);

  // Empty file list (no disk I/O), not cancelled → "gone.md" is absent.
  const summary = await engine.backup([], noopProgress(false));

  assert.deepEqual(deleted, ['na'], "absent file's note should be deleted");
  assert.equal(manifest.entries['gone.md'], undefined, 'entry should be removed');
  assert.equal(summary.removed, 1);
});

test('reconcile:false (single-file backup) never deletes absent files', async () => {
  const { client, deleted } = mockClient();
  const manifest = manifestWith('gone.md');
  const engine = new SyncEngine(client, manifest, OPTS, () => undefined);

  const summary = await engine.backup([], noopProgress(false), { reconcile: false });

  assert.deepEqual(deleted, [], 'partial backup must not delete anything');
  assert.ok(manifest.entries['gone.md'], 'entry must survive a partial backup');
  assert.equal(summary.removed, 0);
});

test('orphan directory notes are deleted under hardDelete', async () => {
  const { client, deleted } = mockClient();
  const manifest: Manifest = {
    version: 1,
    rootNoteId: 'root1',
    entries: { stale: { noteId: 'nd', type: 'dir' } },
  };
  const engine = new SyncEngine(client, manifest, OPTS, () => undefined);

  // No files reference "stale" → it's orphaned.
  await engine.backup([], noopProgress(false));

  assert.deepEqual(deleted, ['nd'], 'orphan dir note should be deleted');
  assert.equal(manifest.entries['stale'], undefined, 'dir entry should be pruned');
});

test('soft-delete logs a removal once (tombstone), not every run', async () => {
  const { client } = mockClient();
  const logs: string[] = [];
  const manifest = manifestWith('gone.md');
  const softOpts: SyncOptions = { ...OPTS, hardDeleteRemovedFiles: false };
  const engine = new SyncEngine(client, manifest, softOpts, m => logs.push(m));

  const first = await engine.backup([], noopProgress(false));
  const second = await engine.backup([], noopProgress(false));

  assert.equal(first.removed, 1, 'first run reports the removal');
  assert.equal(second.removed, 0, 'second run does not re-report it');
  assert.ok(manifest.entries['gone.md'].removed, 'entry is tombstoned, kept');
  assert.equal(
    logs.filter(l => l.includes('removed (kept in Trilium)')).length,
    1,
    'removal logged exactly once across two runs',
  );
});

test('a new root is stamped with identifying labels (instance + workspace)', async () => {
  const { client, labels, calls } = mockClient([]); // search finds nothing
  const manifest = rootlessManifest();
  const engine = new SyncEngine(client, manifest, OPTS, () => undefined);

  await engine.backup([], noopProgress(false));

  assert.equal(calls(), 1, 'a fresh root note is created');
  const rootId = manifest.rootNoteId;
  assert.ok(rootId, 'rootNoteId recorded in the manifest');
  assert.deepEqual(
    labels.map(l => `${l.name}=${l.value}`).sort(),
    ['trilkeepInstance=conn', 'trilkeepRoot=', 'trilkeepWorkspace=ws'].sort(),
    'root stamped with marker + instance + workspace labels',
  );
  assert.ok(
    labels.every(l => l.noteId === rootId),
    'labels attached to the new root note',
  );
});

test('an existing stamped root is recovered, not duplicated, when the manifest is lost', async () => {
  const { client, labels, calls, searches } = mockClient([{ noteId: 'oldRoot' }]);
  const manifest = rootlessManifest();
  const engine = new SyncEngine(client, manifest, OPTS, () => undefined);

  await engine.backup([], noopProgress(false));

  assert.equal(manifest.rootNoteId, 'oldRoot', 'reattached to the existing root');
  assert.equal(calls(), 0, 'no duplicate root note created');
  assert.deepEqual(labels, [], 'no re-stamping when adopting an existing root');
  assert.ok(
    searches[0].includes('#trilkeepInstance="conn"') &&
      searches[0].includes('#trilkeepWorkspace="ws"'),
    'recovery search is scoped by instance + workspace',
  );
});

test('ambiguous multiple candidate roots → a new root is created (no wrong adopt)', async () => {
  const { client, calls } = mockClient([{ noteId: 'a' }, { noteId: 'b' }]);
  const manifest = rootlessManifest();
  const engine = new SyncEngine(client, manifest, OPTS, () => undefined);

  await engine.backup([], noopProgress(false));

  assert.equal(calls(), 1, 'ambiguity must not adopt; a fresh root is created');
  assert.equal(manifest.rootNoteId, 'new1');
});

test('an existing unstamped root gets stamped once, then not re-stamped', async () => {
  const { client, labels } = mockClient();
  // A pre-stamping manifest: valid rootNoteId, no rootStamped flag.
  const manifest: Manifest = { version: 1, rootNoteId: 'root1', entries: {} };
  const engine = new SyncEngine(client, manifest, OPTS, () => undefined);

  await engine.backup([], noopProgress(false));
  assert.equal(labels.length, 3, 'unstamped existing root is stamped once');
  assert.equal(manifest.rootStamped, true, 'flag recorded after stamping');

  await engine.backup([], noopProgress(false));
  assert.equal(labels.length, 3, 'already-stamped root is not re-stamped');
});

test('root note title is synced when rootNoteTitle/workspace changed', async () => {
  // Existing root titled "x"; desired title is rootNoteTitle ("Backup").
  const { client, titlePatches } = mockClient([], { title: 'x' });
  const manifest: Manifest = {
    version: 1,
    rootNoteId: 'root1',
    rootStamped: true,
    entries: {},
  };
  const engine = new SyncEngine(client, manifest, OPTS, () => undefined);

  await engine.backup([], noopProgress(false));

  assert.deepEqual(titlePatches, [{ noteId: 'root1', title: 'Backup' }]);
});

test('root note title is NOT patched when it already matches', async () => {
  const { client, titlePatches } = mockClient([], { title: 'Backup' });
  const manifest: Manifest = {
    version: 1,
    rootNoteId: 'root1',
    rootStamped: true,
    entries: {},
  };
  const engine = new SyncEngine(client, manifest, OPTS, () => undefined);

  await engine.backup([], noopProgress(false));

  assert.deepEqual(titlePatches, [], 'no rename when the title is unchanged');
});

test('renameRootInstanceLabel patches the instance label on the root', async () => {
  const { client, attrPatches } = mockClient([], {
    attributes: [
      { attributeId: 'a1', type: 'label', name: 'trilkeepInstance', value: 'old' },
      { attributeId: 'a2', type: 'label', name: 'trilkeepRoot', value: '' },
    ],
  });

  await renameRootInstanceLabel(client, 'root1', 'real');

  assert.deepEqual(attrPatches, [{ attributeId: 'a1', value: 'real' }]);
});

test('renameRootInstanceLabel is a no-op when no instance label exists', async () => {
  const { client, attrPatches } = mockClient([], { attributes: [] });
  await renameRootInstanceLabel(client, 'root1', 'real');
  assert.deepEqual(attrPatches, []);
});

test('parseGroupPath: splits, trims, drops blanks; empty → []', () => {
  assert.deepEqual(parseGroupPath('Trilkeep'), ['Trilkeep']);
  assert.deepEqual(parseGroupPath('/Trilkeep//work/ repo /'), ['Trilkeep', 'work', 'repo']);
  assert.deepEqual(parseGroupPath(''), []);
  assert.deepEqual(parseGroupPath('  '), []);
});

test('rootNoteTitle blank → root note titled by the workspace name', async () => {
  const { client, titlePatches } = mockClient([], { title: 'x' });
  const manifest: Manifest = {
    version: 1,
    rootNoteId: 'root1',
    rootStamped: true,
    entries: {},
  };
  const engine = new SyncEngine(client, manifest, { ...OPTS, rootNoteTitle: '' }, () => undefined);

  await engine.backup([], noopProgress(false));

  assert.deepEqual(titlePatches, [{ noteId: 'root1', title: 'ws' }]);
});

test('group path creates + stamps containers and nests the root under the deepest', async () => {
  const { client, createdParents, labels, calls } = mockClient(
    [],
    {},
    {
      containerResults: [], // no existing containers → they get created
    },
  );
  const manifest = rootlessManifest();
  const engine = new SyncEngine(client, manifest, { ...OPTS, group: 'A/B' }, () => undefined);

  await engine.backup([], noopProgress(false));

  // A under root, B under A(new1), root under B(new2).
  assert.deepEqual(createdParents, ['root', 'new1', 'new2']);
  assert.equal(calls(), 3, 'two containers + one root');
  assert.equal(manifest.rootNoteId, 'new3');
  assert.equal(manifest.rootParentNoteId, 'new2', 'root cached under deepest container');
  const paths = labels
    .filter(l => l.name === 'trilkeepContainerPath')
    .map(l => l.value)
    .sort();
  assert.deepEqual(paths, ['A', 'A/B'], 'each container stamped with its full path');
});

test('ensureContainer rolls back an unstamped container if stamping fails', async () => {
  // If labeling throws after the container note is created, leaving the unstamped
  // note would make every later run create another duplicate. It must be deleted
  // and the run aborted (next run recreates cleanly).
  const { client, deleted } = mockClient([], {}, { failCreateLabel: true });
  const manifest = rootlessManifest();
  const engine = new SyncEngine(client, manifest, { ...OPTS, group: 'G' }, () => undefined);

  await assert.rejects(
    () => engine.backup([], noopProgress(false)),
    /could not stamp|stamp failure/i,
  );
  assert.ok(deleted.includes('new1'), 'the unstamped container note was rolled back (deleted)');
});

test('an existing container is reused, not duplicated', async () => {
  const { client, createdParents, labels, calls } = mockClient(
    [],
    {},
    {
      containerResults: [{ noteId: 'existingA' }],
    },
  );
  const manifest = rootlessManifest();
  const engine = new SyncEngine(client, manifest, { ...OPTS, group: 'A' }, () => undefined);

  await engine.backup([], noopProgress(false));

  assert.deepEqual(createdParents, ['existingA'], 'root nested under the reused container');
  assert.equal(calls(), 1, 'only the root is created; container reused');
  assert.ok(
    !labels.some(l => l.name === 'trilkeepContainer'),
    'no container re-stamping when reusing',
  );
});

test('readOnly:true stamps an inheritable #readOnly label on a new root', async () => {
  const { client, labels } = mockClient([]);
  const manifest = rootlessManifest();
  const engine = new SyncEngine(client, manifest, { ...OPTS, readOnly: true }, () => undefined);

  await engine.backup([], noopProgress(false));

  const ro = labels.find(l => l.name === 'readOnly');
  assert.ok(ro, '#readOnly label stamped');
  assert.equal(ro!.inheritable, true, 'it must be inheritable to cascade the subtree');
  assert.equal(manifest.readOnlyStamped, true);
});

test('readOnly turned off removes the #readOnly label', async () => {
  const { client, attrDeletes } = mockClient([], {
    attributes: [{ attributeId: 'ro1', type: 'label', name: 'readOnly' }],
  });
  const manifest: Manifest = {
    version: 1,
    rootNoteId: 'root1',
    rootStamped: true,
    readOnlyStamped: true,
    entries: {},
  };
  const engine = new SyncEngine(client, manifest, { ...OPTS, readOnly: false }, () => undefined);

  await engine.backup([], noopProgress(false));

  assert.deepEqual(attrDeletes, ['ro1'], 'the #readOnly attribute is deleted');
  assert.equal(manifest.readOnlyStamped, false);
});

test('ensureRootPlacement is a no-op when the root is already under the desired parent', async () => {
  // group "" → desired parent is Trilium root; the root already lives there.
  const { client, branchCreates, branchDeletes } = mockClient([], {
    parentBranchIds: ['b0'],
    branchParent: 'root',
  });
  const manifest: Manifest = {
    version: 1,
    rootNoteId: 'root1',
    rootStamped: true,
    entries: {},
  };
  const engine = new SyncEngine(client, manifest, OPTS, () => undefined);

  await engine.backup([], noopProgress(false));

  assert.deepEqual(branchCreates, [], 'no new branch when already in place');
  assert.deepEqual(branchDeletes, [], 'nothing to delete');
  assert.equal(manifest.rootParentNoteId, 'root', 'placement cached');
});

test('readOnly:true does not duplicate an existing #readOnly label (recovery)', async () => {
  // A recovered root already carries #readOnly, but the fresh manifest's
  // readOnlyStamped is unset; a blind create would stack a duplicate.
  const { client, labels } = mockClient([], {
    attributes: [{ attributeId: 'ro1', type: 'label', name: 'readOnly' }],
  });
  const manifest: Manifest = {
    version: 1,
    rootNoteId: 'root1',
    rootStamped: true,
    entries: {},
  };
  const engine = new SyncEngine(client, manifest, { ...OPTS, readOnly: true }, () => undefined);

  await engine.backup([], noopProgress(false));

  assert.ok(
    !labels.some(l => l.name === 'readOnly'),
    'no second #readOnly label created when one already exists',
  );
  assert.equal(manifest.readOnlyStamped, true);
});

test('existing-root backup fetches the root note only once (no re-GET in placement/readonly)', async () => {
  // Trigger BOTH a move (rootParentNoteId !== desired) and a read-only stamp, so
  // both helpers run, yet the root note must be fetched a single time.
  const { client, getNoteCalls } = mockClient([], {
    parentBranchIds: ['b0'],
    branchParent: 'old',
    attributes: [], // no #readOnly yet → ensureReadOnly will act
  });
  const manifest: Manifest = {
    version: 1,
    rootNoteId: 'root1',
    rootStamped: true,
    rootParentNoteId: 'old',
    entries: {},
  };
  const engine = new SyncEngine(client, manifest, { ...OPTS, readOnly: true }, () => undefined);

  await engine.backup([], noopProgress(false));

  assert.equal(getNoteCalls(), 1, 'root note fetched exactly once per backup');
});

test('recovery search strips quotes from the instance/workspace names', async () => {
  const { client, searches } = mockClient([]); // no match → just inspect the query
  const manifest = rootlessManifest();
  const engine = new SyncEngine(
    client,
    manifest,
    { ...OPTS, instanceName: 'ac"me', workspaceName: 'w"s' },
    () => undefined,
  );

  await engine.backup([], noopProgress(false));

  const recovery = searches.find(s => s.includes('trilkeepRoot'));
  assert.ok(recovery, 'a recovery search was issued');
  assert.ok(!recovery!.includes('ac"me'), 'raw quote not interpolated');
  assert.ok(
    recovery!.includes('#trilkeepInstance="acme"'),
    `quotes stripped from the value (got: ${recovery})`,
  );
});

test('a group change re-parents the root (create new branch, delete old)', async () => {
  const { client, branchCreates, branchDeletes } = mockClient([], {
    parentBranchIds: ['ob1'],
    branchParent: 'oldParent',
  });
  const manifest: Manifest = {
    version: 1,
    rootNoteId: 'root1',
    rootStamped: true,
    rootParentNoteId: 'oldParent', // was under a different parent
    entries: {},
  };
  // group "" → desired parent is Trilium root, which differs from "oldParent".
  const engine = new SyncEngine(client, manifest, OPTS, () => undefined);

  await engine.backup([], noopProgress(false));

  assert.deepEqual(
    branchCreates,
    [{ noteId: 'root1', parentNoteId: 'root' }],
    'new placement created first',
  );
  assert.deepEqual(branchDeletes, ['ob1'], 'old placement deleted after');
  assert.equal(manifest.rootParentNoteId, 'root', 'cached new parent');
});

test('binary files are skipped, not corrupted into a note', async () => {
  const { client, calls } = mockClient();
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-bin-'));
  try {
    await fs.writeFile(path.join(ws, 'image.bin'), Buffer.from([0x89, 0x00, 0x42]));
    const manifest: Manifest = { version: 1, rootNoteId: 'root1', entries: {} };
    const engine = new SyncEngine(
      client,
      manifest,
      { ...OPTS, workspaceRoot: ws },
      () => undefined,
    );

    const summary = await engine.backup(['image.bin'], noopProgress(false));

    assert.equal(summary.skipped, 1, 'binary file counted as skipped');
    assert.equal(calls(), 0, 'no note created for binary content');
    assert.equal(manifest.entries['image.bin'], undefined, 'not tracked');
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test('symlinks are skipped, not followed to an out-of-tree target', async () => {
  const { client, calls } = mockClient();
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-link-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-secret-'));
  try {
    // A secret living outside the workspace, and an in-workspace symlink to it.
    const secret = path.join(outside, 'secret.md');
    await fs.writeFile(secret, 'TOP SECRET. Must never be uploaded');
    await fs.symlink(secret, path.join(ws, 'link.md'));
    const manifest: Manifest = { version: 1, rootNoteId: 'root1', entries: {} };
    const engine = new SyncEngine(
      client,
      manifest,
      { ...OPTS, workspaceRoot: ws },
      () => undefined,
    );

    const summary = await engine.backup(['link.md'], noopProgress(false));

    assert.equal(summary.skipped, 1, 'symlink counted as skipped');
    assert.equal(calls(), 0, 'no note created from a symlink target');
    assert.equal(manifest.entries['link.md'], undefined, 'symlink not tracked');
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});
