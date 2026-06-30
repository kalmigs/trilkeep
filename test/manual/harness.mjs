// Shared helpers for the manual live smoke harnesses (smoke.mjs, scale-smoke.mjs).
// Everything here talks to a REAL Trilium; none of it is part of `pnpm test`
// (which is offline/pure). Excluded from the .vsix via test/**.

import * as crypto from 'node:crypto';

import { EtapiClient } from '../../src/etapiClient.ts';

export const TOKEN = process.env.ETAPI_TOKEN;
export const SERVER_URL = process.env.TRILIUM_URL || 'http://localhost:8080';

// A no-op SyncEngine logger and a no-op progress reporter, shared by both runs.
export const silentLog = () => {};
export const reporter = { report: () => {}, isCancelled: () => false };

// Exit early with a usage hint when no token is set. `invocation` is the exact
// command to show in the hint (it differs per harness).
export function requireToken(invocation) {
  if (!TOKEN) {
    console.error(
      'ETAPI_TOKEN env var is required. Generate one in Trilium → Options → ETAPI.\n' +
        `  ETAPI_TOKEN=<token> ${invocation}`,
    );
    process.exit(2);
  }
}

// A pass/fail tracker. check() logs a ✓/✗ line; report() prints the tally and
// returns the failure count (0 = all green), so callers can set the exit code.
export function createChecker() {
  let passed = 0;
  let failed = 0;
  return {
    check(label, cond, detail = '') {
      if (cond) {
        passed++;
        console.log(`  ✓ ${label}`);
      } else {
        failed++;
        console.log(`  ✗ ${label}${detail ? `: ${detail}` : ''}`);
      }
    },
    report() {
      console.log(`\n${passed} passed, ${failed} failed`);
      return failed;
    },
  };
}

// Build a client and print the connection banner, failing fast with a clear
// message if the server/token is wrong.
export async function connect() {
  const client = new EtapiClient(SERVER_URL, TOKEN);
  const info = await client.appInfo();
  console.log(`Connected to Trilium ${info.appVersion} (db ${info.dbVersion}) at ${SERVER_URL}\n`);
  return client;
}

// A short random suffix for unique per-run connection/workspace names, so a
// crashed prior run can't make recovery ambiguous.
export const randomSuffix = () => crypto.randomBytes(4).toString('hex');
