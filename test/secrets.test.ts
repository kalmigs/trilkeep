import assert from "node:assert/strict";
import { test } from "node:test";

import { LEGACY_TOKEN_KEY, tokenKey } from "../src/secrets";

test("tokenKey: distinct servers get distinct keys (no shared credential)", () => {
  const test8081 = tokenKey("http://localhost:8081");
  const real = tokenKey("https://notes.example.com");
  assert.notEqual(test8081, real);
});

test("tokenKey: never collides with the legacy global key", () => {
  // The legacy migration reads LEGACY_TOKEN_KEY and writes tokenKey(...); they
  // must be different keys or migration would clobber its own source.
  assert.notEqual(tokenKey("http://localhost:8080"), LEGACY_TOKEN_KEY);
});

test("tokenKey: trailing slash and whitespace normalise to one key", () => {
  const a = tokenKey("http://localhost:8081");
  assert.equal(tokenKey("http://localhost:8081/"), a);
  assert.equal(tokenKey("  http://localhost:8081  "), a);
  assert.equal(tokenKey("http://localhost:8081///"), a);
});

test("tokenKey: scheme and port are part of the identity", () => {
  assert.notEqual(tokenKey("http://localhost:8081"), tokenKey("https://localhost:8081"));
  assert.notEqual(tokenKey("http://localhost:8081"), tokenKey("http://localhost:8080"));
});
