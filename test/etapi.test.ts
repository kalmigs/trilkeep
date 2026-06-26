import assert from "node:assert/strict";
import { test } from "node:test";

import { EtapiClient, isInsecureRemoteUrl, normalizeEtapiBase } from "../src/etapiClient";

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

test("isInsecureRemoteUrl: loopback http is fine", () => {
  assert.equal(isInsecureRemoteUrl("http://localhost:8080"), false);
  assert.equal(isInsecureRemoteUrl("http://127.0.0.1:8080"), false);
  assert.equal(isInsecureRemoteUrl("http://[::1]:8080"), false);
});

test("isInsecureRemoteUrl: https is always fine", () => {
  assert.equal(isInsecureRemoteUrl("https://example.com"), false);
  assert.equal(isInsecureRemoteUrl("https://my-trilium.example.com:8443"), false);
});

test("isInsecureRemoteUrl: http to a non-loopback host is insecure", () => {
  assert.equal(isInsecureRemoteUrl("http://example.com"), true);
  assert.equal(isInsecureRemoteUrl("http://192.168.1.10:8080"), true);
  assert.equal(isInsecureRemoteUrl("http://trilium.local:8080"), true);
});

test("isInsecureRemoteUrl: malformed URL is not flagged (request layer handles it)", () => {
  assert.equal(isInsecureRemoteUrl("not a url"), false);
  assert.equal(isInsecureRemoteUrl(""), false);
});

test("client percent-encodes noteId into the request path", async () => {
  const calls: string[] = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => {
    calls.push(String(url));
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    const client = new EtapiClient("http://localhost:8080", "tok");
    // A noteId carrying path-control characters must not escape the /notes/ path.
    await client.deleteNote("a/b?c");
    assert.equal(calls[0], "http://localhost:8080/etapi/notes/a%2Fb%3Fc");
  } finally {
    globalThis.fetch = origFetch;
  }
});
