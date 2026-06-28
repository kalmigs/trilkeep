import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isConnectionAlive,
  mergeConnectionNames,
  orderConnectionNames,
} from "../src/connections";

test("mergeConnectionNames: unions, de-duplicates, and sorts", () => {
  assert.deepEqual(
    mergeConnectionNames(["real", "test"], ["test", "archive"]),
    ["archive", "real", "test"]
  );
});

test("mergeConnectionNames: normalizes (trims) and blank → default", () => {
  assert.deepEqual(
    mergeConnectionNames(["  real  "], ["", "  "]),
    ["default", "real"]
  );
});

test("mergeConnectionNames: case-sensitive (matches tokenKey, which doesn't lowercase)", () => {
  assert.deepEqual(mergeConnectionNames(["Real"], ["real"]), ["Real", "real"]);
});

test("mergeConnectionNames: empty inputs → empty list", () => {
  assert.deepEqual(mergeConnectionNames([], []), []);
});

test("orderConnectionNames: current is first, rest sorted (regression: not 'default' on top)", () => {
  assert.deepEqual(
    orderConnectionNames("f5real", ["default", "f5real"]),
    ["f5real", "default"]
  );
});

test("orderConnectionNames: current first even when it's the alphabetically-first name", () => {
  assert.deepEqual(
    orderConnectionNames("default", ["f5real", "default", "archive"]),
    ["default", "archive", "f5real"]
  );
});

test("orderConnectionNames: current not yet in the known list is still placed first", () => {
  assert.deepEqual(orderConnectionNames("brandnew", ["a", "b"]), [
    "brandnew",
    "a",
    "b",
  ]);
});

test("orderConnectionNames: blank current normalizes to default, no duplicate", () => {
  assert.deepEqual(orderConnectionNames("  ", ["default", "real"]), [
    "default",
    "real",
  ]);
});

test("isConnectionAlive: a token alone keeps it (usable from any repo)", () => {
  assert.equal(isConnectionAlive(true, false), true);
});

test("isConnectionAlive: a repo-local backup alone keeps it (token may be cleared)", () => {
  assert.equal(isConnectionAlive(false, true), true);
});

test("isConnectionAlive: neither token nor local backup → dead (prune)", () => {
  assert.equal(isConnectionAlive(false, false), false);
});
