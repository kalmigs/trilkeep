import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  describeConnectionState,
  isConnectionAlive,
  mergeConnectionNames,
  orderConnectionNames,
  removeConnectionName,
} from '../src/connections';

test('mergeConnectionNames: unions, de-duplicates, and sorts', () => {
  assert.deepEqual(mergeConnectionNames(['real', 'test'], ['test', 'archive']), [
    'archive',
    'real',
    'test',
  ]);
});

test('mergeConnectionNames: normalizes (trims) and blank → default', () => {
  assert.deepEqual(mergeConnectionNames(['  real  '], ['', '  ']), ['default', 'real']);
});

test("mergeConnectionNames: case-sensitive (matches tokenKey, which doesn't lowercase)", () => {
  assert.deepEqual(mergeConnectionNames(['Real'], ['real']), ['Real', 'real']);
});

test('mergeConnectionNames: empty inputs → empty list', () => {
  assert.deepEqual(mergeConnectionNames([], []), []);
});

test("orderConnectionNames: current is first, rest sorted (regression: not 'default' on top)", () => {
  assert.deepEqual(orderConnectionNames('f5real', ['default', 'f5real']), ['f5real', 'default']);
});

test("orderConnectionNames: current first even when it's the alphabetically-first name", () => {
  assert.deepEqual(orderConnectionNames('default', ['f5real', 'default', 'archive']), [
    'default',
    'archive',
    'f5real',
  ]);
});

test('orderConnectionNames: current not yet in the known list is still placed first', () => {
  assert.deepEqual(orderConnectionNames('brandnew', ['a', 'b']), ['brandnew', 'a', 'b']);
});

test('orderConnectionNames: blank current normalizes to default, no duplicate', () => {
  assert.deepEqual(orderConnectionNames('  ', ['default', 'real']), ['default', 'real']);
});

test('isConnectionAlive: a token alone keeps it (usable from any repo)', () => {
  assert.equal(isConnectionAlive(true, false), true);
});

test('isConnectionAlive: a repo-local backup alone keeps it (token may be cleared)', () => {
  assert.equal(isConnectionAlive(false, true), true);
});

test('isConnectionAlive: neither token nor local backup → dead (prune)', () => {
  assert.equal(isConnectionAlive(false, false), false);
});

test('removeConnectionName: drops the name, keeps the rest sorted', () => {
  assert.deepEqual(removeConnectionName(['real', 'test', 'archive'], 'test'), ['archive', 'real']);
});

test('removeConnectionName: normalizes the target (trim; blank → default)', () => {
  assert.deepEqual(removeConnectionName(['default', 'real'], '  '), ['real']);
  assert.deepEqual(removeConnectionName(['real'], '  real  '), []);
});

test("removeConnectionName: no-op when the name isn't present", () => {
  assert.deepEqual(removeConnectionName(['real', 'test'], 'missing'), ['real', 'test']);
});

test('removeConnectionName: case-sensitive (matches tokenKey)', () => {
  assert.deepEqual(removeConnectionName(['Real', 'real'], 'real'), ['Real']);
});

test('describeConnectionState: token + local backup', () => {
  assert.equal(describeConnectionState(true, true), 'token · backup here');
});

test('describeConnectionState: local backup but no token', () => {
  assert.equal(describeConnectionState(false, true), 'no token · backup here');
});

test('describeConnectionState: token but no local backup', () => {
  assert.equal(describeConnectionState(true, false), 'token · no backup here');
});
