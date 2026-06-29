import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_CONNECTION_NAME,
  LEGACY_TOKEN_KEY,
  normalizeConnectionName,
  tokenKey,
} from '../src/secrets';

test('tokenKey: distinct connections get distinct keys (no shared credential)', () => {
  assert.notEqual(tokenKey('test'), tokenKey('real'));
});

test('tokenKey: same connection name → same key regardless of any URL', () => {
  // The whole point: the key does not depend on serverUrl, so a churning LAN
  // address can't change which token is used.
  assert.equal(tokenKey('real'), tokenKey('real'));
});

test('tokenKey: never collides with the legacy global key', () => {
  // The legacy migration reads LEGACY_TOKEN_KEY and writes tokenKey(...); they
  // must be different keys or migration would clobber its own source.
  assert.notEqual(tokenKey(DEFAULT_CONNECTION_NAME), LEGACY_TOKEN_KEY);
});

test('tokenKey: blank/whitespace name falls back to the default connection', () => {
  assert.equal(tokenKey(''), tokenKey(DEFAULT_CONNECTION_NAME));
  assert.equal(tokenKey('  '), tokenKey(DEFAULT_CONNECTION_NAME));
  assert.equal(tokenKey('  real  '), tokenKey('real'));
});

test('normalizeConnectionName: trims, and blank → default', () => {
  assert.equal(normalizeConnectionName('  test '), 'test');
  assert.equal(normalizeConnectionName(''), DEFAULT_CONNECTION_NAME);
  assert.equal(normalizeConnectionName('   '), DEFAULT_CONNECTION_NAME);
});
