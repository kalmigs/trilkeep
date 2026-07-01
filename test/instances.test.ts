import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildInstancePickerRows,
  describeInstanceState,
  explicitInstanceFromInspect,
  isInstanceAlive,
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

test('isInstanceAlive: a token alone keeps it (usable from any repo)', () => {
  assert.equal(isInstanceAlive(true, false), true);
});

test('isInstanceAlive: a repo-local backup alone keeps it (token may be cleared)', () => {
  assert.equal(isInstanceAlive(false, true), true);
});

test('isInstanceAlive: neither token nor local backup → dead (prune)', () => {
  assert.equal(isInstanceAlive(false, false), false);
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
