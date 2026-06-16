import assert from "node:assert/strict";
import { test } from "node:test";

import { mimeForFile, requiredDirs, sha256 } from "../src/sync";

test("sha256: stable and content-sensitive", () => {
  const a = sha256("hello");
  assert.equal(a, sha256("hello"));
  assert.notEqual(a, sha256("hello "));
  assert.match(a, /^[0-9a-f]{64}$/);
});

test("mimeForFile: markdown maps to the lossless code mime", () => {
  assert.equal(mimeForFile("notes/a.md"), "text/x-markdown");
  assert.equal(mimeForFile("notes/a.markdown"), "text/x-markdown");
});

test("mimeForFile: known and unknown extensions", () => {
  assert.equal(mimeForFile("data/x.json"), "application/json");
  assert.equal(mimeForFile("README"), "text/plain");
  assert.equal(mimeForFile("a.unknownext"), "text/plain");
});

test("requiredDirs: collects every ancestor directory, dedup'd", () => {
  const dirs = requiredDirs(["a/b/c.md", "a/x.md", "top.md"]);
  assert.deepEqual([...dirs].sort(), ["a", "a/b"]);
});

test("requiredDirs: empty for top-level-only files", () => {
  assert.deepEqual([...requiredDirs(["a.md", "b.md"])], []);
});
