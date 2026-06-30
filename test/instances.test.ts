import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  describeInstanceState,
  isInstanceAlive,
  mergeInstanceNames,
  orderInstanceNames,
  removeInstanceName,
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
  assert.equal(describeInstanceState(true, true), 'token · backup here');
});

test('describeInstanceState: local backup but no token', () => {
  assert.equal(describeInstanceState(false, true), 'no token · backup here');
});

test('describeInstanceState: token but no local backup', () => {
  assert.equal(describeInstanceState(true, false), 'token · no backup here');
});
