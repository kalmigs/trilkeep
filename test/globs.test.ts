import assert from "node:assert/strict";
import { test } from "node:test";

import { joinGlobs, toPosix } from "../src/globs";

test("joinGlobs: empty array → empty string", () => {
  assert.equal(joinGlobs([]), "");
  assert.equal(joinGlobs(["  ", ""]), "");
});

test("joinGlobs: single glob is returned bare (no braces)", () => {
  assert.equal(joinGlobs(["**/*.md"]), "**/*.md");
});

test("joinGlobs: multiple globs are brace-joined", () => {
  assert.equal(joinGlobs(["**/*.md", "**/*.txt"]), "{**/*.md,**/*.txt}");
});

test("joinGlobs: trims and drops blanks before joining", () => {
  assert.equal(joinGlobs([" a ", "", " b "]), "{a,b}");
});

test("toPosix: backslashes become forward slashes", () => {
  assert.equal(toPosix("a\\b\\c.md"), "a/b/c.md");
  assert.equal(toPosix("already/posix.md"), "already/posix.md");
});
