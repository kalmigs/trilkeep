import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildInstancePickerRows,
  describeInstanceState,
  explicitInstanceFromInspect,
  isConfiguredFromInspect,
  isRepoCurrentInstance,
  mergeInstanceNames,
  orderForgetInstances,
  orderInstanceNames,
  removeInstanceName,
  shouldWarnNewInstance,
} from '../src/instances';

test('mergeInstanceNames: unions, de-duplicates, and sorts', () => {
  assert.deepEqual(mergeInstanceNames(['real', 'test'], ['test', 'archive']), [
    'archive',
    'real',
    'test',
  ]);
});

test('mergeInstanceNames: normalizes (trims) and blank → default', () => {
  assert.deepEqual(mergeInstanceNames(['  real  '], ['', '  ']), ['default', 'real']);
});

test("mergeInstanceNames: case-sensitive (matches tokenKey, which doesn't lowercase)", () => {
  assert.deepEqual(mergeInstanceNames(['Real'], ['real']), ['Real', 'real']);
});

test('mergeInstanceNames: empty inputs → empty list', () => {
  assert.deepEqual(mergeInstanceNames([], []), []);
});

test("orderInstanceNames: current is first, rest sorted (regression: not 'default' on top)", () => {
  assert.deepEqual(orderInstanceNames('f5real', ['default', 'f5real']), ['f5real', 'default']);
});

test("orderInstanceNames: current first even when it's the alphabetically-first name", () => {
  assert.deepEqual(orderInstanceNames('default', ['f5real', 'default', 'archive']), [
    'default',
    'archive',
    'f5real',
  ]);
});

test('orderInstanceNames: current not yet in the known list is still placed first', () => {
  assert.deepEqual(orderInstanceNames('brandnew', ['a', 'b']), ['brandnew', 'a', 'b']);
});

test('orderInstanceNames: blank current normalizes to default, no duplicate', () => {
  assert.deepEqual(orderInstanceNames('  ', ['default', 'real']), ['default', 'real']);
});

test('removeInstanceName: drops the name, keeps the rest sorted', () => {
  assert.deepEqual(removeInstanceName(['real', 'test', 'archive'], 'test'), ['archive', 'real']);
});

test('removeInstanceName: normalizes the target (trim; blank → default)', () => {
  assert.deepEqual(removeInstanceName(['default', 'real'], '  '), ['real']);
  assert.deepEqual(removeInstanceName(['real'], '  real  '), []);
});

test("removeInstanceName: no-op when the name isn't present", () => {
  assert.deepEqual(removeInstanceName(['real', 'test'], 'missing'), ['real', 'test']);
});

test('removeInstanceName: case-sensitive (matches tokenKey)', () => {
  assert.deepEqual(removeInstanceName(['Real', 'real'], 'real'), ['Real']);
});

test('describeInstanceState: token + local backup', () => {
  assert.equal(describeInstanceState(true, true), 'has token · has backup here');
});

test('describeInstanceState: local backup but no token', () => {
  assert.equal(describeInstanceState(false, true), 'no token · has backup here');
});

test('describeInstanceState: token but no local backup', () => {
  assert.equal(describeInstanceState(true, false), 'has token · no backup here');
});

// --- explicitInstanceFromInspect (footgun: false "default = current" on a wiped repo) ---

test('explicitInstanceFromInspect: schema default alone is NOT explicit', () => {
  // The package.json `default: "default"` shows up as defaultValue, which we do
  // NOT read — so an unconfigured repo returns undefined (no false "current").
  assert.equal(explicitInstanceFromInspect({}), undefined);
});

test('explicitInstanceFromInspect: workspace > global; folder wins over both', () => {
  assert.equal(explicitInstanceFromInspect({ globalValue: 'g' }), 'g');
  assert.equal(explicitInstanceFromInspect({ workspaceValue: 'w', globalValue: 'g' }), 'w');
  assert.equal(
    explicitInstanceFromInspect({
      workspaceFolderValue: 'f',
      workspaceValue: 'w',
      globalValue: 'g',
    }),
    'f',
  );
});

test('explicitInstanceFromInspect: blank/whitespace is not explicit; value is normalized', () => {
  assert.equal(explicitInstanceFromInspect({ workspaceValue: '   ' }), undefined);
  assert.equal(explicitInstanceFromInspect({ workspaceValue: '  real  ' }), 'real');
});

// --- buildInstancePickerRows (footgun: "default" vanished / falsely marked current) ---

test('buildInstancePickerRows: always OFFERS default, even with an empty registry', () => {
  const rows = buildInstancePickerRows(undefined, []);
  assert.deepEqual(rows, [{ name: 'default', isCurrent: false }]);
});

test('buildInstancePickerRows: no explicit current → default offered but NOT marked current', () => {
  const rows = buildInstancePickerRows(undefined, ['real', 'test']);
  assert.equal(
    rows.some(r => r.isCurrent),
    false,
    'nothing is current when the setting is unset',
  );
  assert.ok(rows.some(r => r.name === 'default'));
});

test('buildInstancePickerRows: explicit current is marked and ordered FIRST', () => {
  const rows = buildInstancePickerRows('real', ['test', 'default']);
  assert.equal(rows[0].name, 'real');
  assert.equal(rows[0].isCurrent, true);
  assert.equal(rows.filter(r => r.isCurrent).length, 1, 'exactly one current');
  assert.ok(rows.some(r => r.name === 'default')); // default still offered
});

// --- orderForgetInstances (footgun: Setup offers default, Forget must NOT) ---

test('orderForgetInstances: does NOT inject default; current-first only when explicit + tracked', () => {
  assert.deepEqual(orderForgetInstances(undefined, ['b', 'a']), ['b', 'a']); // no default, order preserved
  assert.deepEqual(orderForgetInstances('a', ['b', 'a']), ['a', 'b']); // current first when tracked
  assert.deepEqual(orderForgetInstances('x', ['b', 'a']), ['b', 'a']); // current not tracked → unchanged
});

// --- shouldWarnNewInstance (footgun: accidental duplicate backup tree) ---

test('shouldWarnNewInstance: warns only when name differs AND the current has a backup', () => {
  assert.equal(shouldWarnNewInstance('work', 'real', true), true); // different name + backup exists
  assert.equal(shouldWarnNewInstance('work', 'real', false), false); // no backup → no warning (fresh repo)
  assert.equal(shouldWarnNewInstance('real', 'real', true), false); // same name → no warning
  assert.equal(shouldWarnNewInstance('  real ', 'real', true), false); // normalized-equal → no warning
});

// --- isConfiguredFromInspect (footgun: "no token" skip noise on an unset repo) ---

test('isConfiguredFromInspect: unconfigured repo (only schema defaults) is NOT configured', () => {
  // Neither setting explicitly set → auto-backup should stay silent, not report a
  // missing token for a repo the user never pointed at Trilium.
  assert.equal(isConfiguredFromInspect({}, {}), false);
});

test('isConfiguredFromInspect: an explicit instance name at any scope counts', () => {
  assert.equal(isConfiguredFromInspect({ workspaceValue: 'real' }, {}), true);
  assert.equal(isConfiguredFromInspect({ globalValue: 'real' }, {}), true);
  assert.equal(isConfiguredFromInspect({ workspaceFolderValue: 'real' }, {}), true);
});

test('isConfiguredFromInspect: an explicit server URL counts even without an instance name', () => {
  assert.equal(isConfiguredFromInspect({}, { workspaceValue: 'http://box:8080' }), true);
});

test('isConfiguredFromInspect: blank explicit values do not count as configured', () => {
  assert.equal(isConfiguredFromInspect({ workspaceValue: '   ' }, { globalValue: '' }), false);
});

// --- isRepoCurrentInstance (footgun: "default" wrongly blocked from Forget on a
//     wiped repo, because it compared against the schema-default fallback) ---

test('isRepoCurrentInstance: nothing is the current on an unconfigured repo', () => {
  // No explicit instance → even "default" is forgettable, matching the picker.
  assert.equal(isRepoCurrentInstance('default', undefined), false);
  assert.equal(isRepoCurrentInstance('some-instance', undefined), false);
});

test('isRepoCurrentInstance: the explicitly-configured instance is blocked', () => {
  assert.equal(isRepoCurrentInstance('real', 'real'), true);
  assert.equal(isRepoCurrentInstance('other', 'real'), false);
  assert.equal(isRepoCurrentInstance('  real ', 'real'), true); // normalized (trim) compare
  // An explicit "default" IS the current and stays blocked.
  assert.equal(isRepoCurrentInstance('default', 'default'), true);
});
