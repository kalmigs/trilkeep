import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  EtapiClient,
  EtapiError,
  isInsecureRemoteUrl,
  normalizeEtapiBase,
  parseRetryAfter,
  retryDelayMs,
} from '../src/etapiClient';

test('normalizeEtapiBase: appends /etapi when missing', () => {
  assert.equal(normalizeEtapiBase('http://localhost:8080'), 'http://localhost:8080/etapi');
});

test('normalizeEtapiBase: strips trailing slashes', () => {
  assert.equal(normalizeEtapiBase('http://localhost:8080///'), 'http://localhost:8080/etapi');
});

test('normalizeEtapiBase: leaves an existing /etapi suffix intact', () => {
  assert.equal(normalizeEtapiBase('http://localhost:8080/etapi'), 'http://localhost:8080/etapi');
  assert.equal(normalizeEtapiBase('http://localhost:8080/etapi/'), 'http://localhost:8080/etapi');
});

test('isInsecureRemoteUrl: loopback http is fine', () => {
  assert.equal(isInsecureRemoteUrl('http://localhost:8080'), false);
  assert.equal(isInsecureRemoteUrl('http://127.0.0.1:8080'), false);
  assert.equal(isInsecureRemoteUrl('http://127.1.2.3:8080'), false); // all of 127/8
  assert.equal(isInsecureRemoteUrl('http://[::1]:8080'), false);
  assert.equal(isInsecureRemoteUrl('http://app.localhost:8080'), false);
});

test('isInsecureRemoteUrl: a 127.* DNS name is NOT loopback (token would leak)', () => {
  // Regression: a plain startsWith("127.") wrongly treated these as loopback and
  // suppressed the cleartext-token warning for a remote host.
  assert.equal(isInsecureRemoteUrl('http://127.evil.com:8080'), true);
  assert.equal(isInsecureRemoteUrl('http://127.0.0.1.attacker.com:8080'), true);
});

test('isInsecureRemoteUrl: https is always fine', () => {
  assert.equal(isInsecureRemoteUrl('https://example.com'), false);
  assert.equal(isInsecureRemoteUrl('https://my-trilium.example.com:8443'), false);
});

test('isInsecureRemoteUrl: http to a non-loopback host is insecure', () => {
  assert.equal(isInsecureRemoteUrl('http://example.com'), true);
  assert.equal(isInsecureRemoteUrl('http://192.168.1.10:8080'), true);
  assert.equal(isInsecureRemoteUrl('http://trilium.local:8080'), true);
});

test('isInsecureRemoteUrl: malformed URL is not flagged (request layer handles it)', () => {
  assert.equal(isInsecureRemoteUrl('not a url'), false);
  assert.equal(isInsecureRemoteUrl(''), false);
});

test('client percent-encodes noteId into the request path', async () => {
  const calls: string[] = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => {
    calls.push(String(url));
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  try {
    const client = new EtapiClient('http://localhost:8080', 'tok');
    // A noteId carrying path-control characters must not escape the /notes/ path.
    await client.deleteNote('a/b?c');
    assert.equal(calls[0], 'http://localhost:8080/etapi/notes/a%2Fb%3Fc');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('parseRetryAfter: delta-seconds → ms', () => {
  assert.equal(parseRetryAfter('120', 0), 120_000);
  assert.equal(parseRetryAfter('  0 ', 0), 0);
});

test('parseRetryAfter: HTTP-date → ms from now, floored at 0', () => {
  const now = Date.parse('2026-07-06T00:00:00Z');
  assert.equal(parseRetryAfter('Mon, 06 Jul 2026 00:00:05 GMT', now), 5000);
  // A date already in the past yields 0, never a negative delay.
  assert.equal(parseRetryAfter('Mon, 06 Jul 2026 00:00:00 GMT', now + 10_000), 0);
});

test('parseRetryAfter: absent or unparseable → null', () => {
  assert.equal(parseRetryAfter(null, 0), null);
  assert.equal(parseRetryAfter(undefined, 0), null);
  assert.equal(parseRetryAfter('', 0), null);
  assert.equal(parseRetryAfter('soon', 0), null);
});

test('retryDelayMs: exponential backoff when no Retry-After, capped', () => {
  assert.equal(retryDelayMs(1, null), 500);
  assert.equal(retryDelayMs(2, null), 1000);
  assert.equal(retryDelayMs(3, null), 2000);
  assert.equal(retryDelayMs(99, null), 30_000); // capped
});

test('retryDelayMs: honors Retry-After but clamps an over-eager server', () => {
  assert.equal(retryDelayMs(1, 3000), 3000);
  assert.equal(retryDelayMs(5, 3000), 3000); // Retry-After wins over the exponential term
  assert.equal(retryDelayMs(1, 999_999), 30_000); // clamped to the max
});

test('client retries a 429 then succeeds, honoring Retry-After', async () => {
  const statuses = [429, 200];
  const slept: number[] = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    const status = statuses.shift() ?? 200;
    return new Response('{}', { status, headers: { 'retry-after': '2' } });
  }) as typeof fetch;
  try {
    const client = new EtapiClient('http://localhost:8080', 'tok', {
      sleep: async ms => {
        slept.push(ms);
      },
    });
    await client.appInfo();
    assert.deepEqual(slept, [2000]); // one retry, waited the Retry-After
    assert.equal(statuses.length, 0); // both responses consumed
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('client gives up after maxAttempts on persistent 503 and throws', async () => {
  let calls = 0;
  const slept: number[] = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls++;
    return new Response('{"message":"busy","code":"X"}', { status: 503 });
  }) as typeof fetch;
  try {
    const client = new EtapiClient('http://localhost:8080', 'tok', {
      maxAttempts: 3,
      sleep: async ms => {
        slept.push(ms);
      },
    });
    await assert.rejects(
      () => client.appInfo(),
      (e: unknown) => e instanceof EtapiError && e.status === 503,
    );
    assert.equal(calls, 3); // initial + 2 retries
    assert.equal(slept.length, 2); // slept between the 3 attempts, not after the last
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('client does NOT retry a non-retryable 4xx', async () => {
  let calls = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls++;
    return new Response('{"message":"nope"}', { status: 400 });
  }) as typeof fetch;
  try {
    const client = new EtapiClient('http://localhost:8080', 'tok', {
      sleep: async () => {},
    });
    await assert.rejects(() => client.appInfo(), EtapiError);
    assert.equal(calls, 1); // failed once, no retry
  } finally {
    globalThis.fetch = origFetch;
  }
});
