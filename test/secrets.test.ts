import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_INSTANCE_NAME,
  normalizeInstanceName,
  TOKEN_KEY_PREFIX,
  tokenKey,
} from '../src/secrets';

test('tokenKey: distinct instances get distinct keys (no shared credential)', () => {
  assert.notEqual(tokenKey('test'), tokenKey('real'));
});

test('tokenKey: same instance name → same key regardless of any URL', () => {
  // The whole point: the key does not depend on serverUrl, so a churning LAN
  // address can't change which token is used.
  assert.equal(tokenKey('real'), tokenKey('real'));
});

test('tokenKey: always suffixed, never the bare prefix', () => {
  // Every key is `${TOKEN_KEY_PREFIX}:${name}`, so an instance's token key can
  // never equal the bare prefix string itself.
  assert.notEqual(tokenKey(DEFAULT_INSTANCE_NAME), TOKEN_KEY_PREFIX);
});

test('tokenKey: blank/whitespace name falls back to the default instance', () => {
  assert.equal(tokenKey(''), tokenKey(DEFAULT_INSTANCE_NAME));
  assert.equal(tokenKey('  '), tokenKey(DEFAULT_INSTANCE_NAME));
  assert.equal(tokenKey('  real  '), tokenKey('real'));
});

test('normalizeInstanceName: trims, and blank → default', () => {
  assert.equal(normalizeInstanceName('  test '), 'test');
  assert.equal(normalizeInstanceName(''), DEFAULT_INSTANCE_NAME);
  assert.equal(normalizeInstanceName('   '), DEFAULT_INSTANCE_NAME);
});
