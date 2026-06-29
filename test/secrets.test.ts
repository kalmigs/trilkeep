import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_CONNECTION_NAME,
  normalizeConnectionName,
  TOKEN_KEY_PREFIX,
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

test('tokenKey: always suffixed, never the bare prefix', () => {
  // Every key is `${TOKEN_KEY_PREFIX}:${name}`, so a connection's token key can
  // never equal the bare prefix string itself.
  assert.notEqual(tokenKey(DEFAULT_CONNECTION_NAME), TOKEN_KEY_PREFIX);
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
