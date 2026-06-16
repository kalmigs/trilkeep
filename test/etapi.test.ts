import assert from "node:assert/strict";
import { test } from "node:test";

import { normalizeEtapiBase } from "../src/etapiClient";

test("normalizeEtapiBase: appends /etapi when missing", () => {
  assert.equal(normalizeEtapiBase("http://localhost:8080"), "http://localhost:8080/etapi");
});

test("normalizeEtapiBase: strips trailing slashes", () => {
  assert.equal(normalizeEtapiBase("http://localhost:8080///"), "http://localhost:8080/etapi");
});

test("normalizeEtapiBase: leaves an existing /etapi suffix intact", () => {
  assert.equal(normalizeEtapiBase("http://localhost:8080/etapi"), "http://localhost:8080/etapi");
  assert.equal(normalizeEtapiBase("http://localhost:8080/etapi/"), "http://localhost:8080/etapi");
});
