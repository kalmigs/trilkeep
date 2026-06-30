// Live SCALE smoke test. Where smoke.mjs is the exact-correctness gate (tiny
// hand-built trees, precise assertions), this one drives the engine over a large
// GENERATED fixture and asserts the scale-invariant properties the small trees
// never exercise:
//   - allowlist: only the markdown glob reaches the backup (binary + non-md out)
//   - full backup creates exactly one note per markdown file
//   - re-run with no change uploads nothing (the incremental value prop, at scale)
//   - mutating K files re-uploads exactly K, the rest still skip
//   - throughput (files/sec), to catch a perf regression
//
// It reuses make-fixture's generate() so the expected counts come straight from
// the generator, and the project's own matchesAllowlist so the candidate list is
// built the same way the extension's discoverFiles would.
//
// Not part of `pnpm test` (offline/pure). Excluded from the .vsix via test/**.
// Tune scale with env vars (defaults in parens): SCALE_FILES (200), SCALE_DEPTH
// (6), SCALE_LARGE (1), SCALE_LARGE_MB (5), SCALE_BINARY (3), SCALE_MUTATE (5),
// SCALE_SEED (1).
//
//   ETAPI_TOKEN=<token> [TRILIUM_URL=http://localhost:8080] \
//     [SCALE_FILES=1000] node --import tsx test/manual/scale-smoke.mjs
//
// It backs up under a unique connection/workspace name and deletes the tree at
// the end, so a successful run leaves no residue in Trilium. Token never printed.

import { mkdtemp, readdir, rm, appendFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

import { EtapiClient } from '../../src/etapiClient.ts';
import { SyncEngine } from '../../src/sync.ts';
import { matchesAllowlist, toPosix } from '../../src/globs.ts';
import { generate } from './make-fixture.mjs';

const TOKEN = process.env.ETAPI_TOKEN;
const SERVER_URL = process.env.TRILIUM_URL || 'http://localhost:8080';
const num = (name, def) => Number(process.env[name] ?? def);

if (!TOKEN) {
  console.error(
    'ETAPI_TOKEN env var is required. Generate one in Trilium → Options → ETAPI.\n' +
      '  ETAPI_TOKEN=<token> node --import tsx test/manual/scale-smoke.mjs',
  );
  process.exit(2);
}

let passed = 0;
let failed = 0;
function check(label, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}${detail ? `: ${detail}` : ''}`);
  }
}

const silentLog = () => {};
const reporter = { report: () => {}, isCancelled: () => false };
const INCLUDE = ['**/*.md'];
const EXCLUDE = [];

// Workspace-relative POSIX paths of every regular file, skipping symlinks (the
// engine never follows them) — mirrors what discoverFiles would feed the engine.
async function walk(root, dir = root, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) await walk(root, full, out);
    else if (e.isFile()) out.push(toPosix(path.relative(root, full)));
  }
  return out;
}

async function main() {
  const client = new EtapiClient(SERVER_URL, TOKEN);
  const info = await client.appInfo();
  console.log(`Connected to Trilium ${info.appVersion} (db ${info.dbVersion}) at ${SERVER_URL}\n`);

  const suffix = crypto.randomBytes(4).toString('hex');
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'trilkeep-scale-'));
  const manifest = { version: 1, entries: {} };

  try {
    // 1) Generate a large fixture (binary + non-md present so the allowlist
    //    assertion is meaningful).
    console.log('1) generate fixture');
    const fx = await generate({
      out: workspaceRoot,
      files: num('SCALE_FILES', 200),
      depth: num('SCALE_DEPTH', 6),
      large: num('SCALE_LARGE', 1),
      'large-mb': num('SCALE_LARGE_MB', 5),
      binary: num('SCALE_BINARY', 3),
      special: true,
      'non-md': true,
      seed: num('SCALE_SEED', 1),
    });
    const mb = (fx.bytes / 1024 / 1024).toFixed(1);
    console.log(
      `   ${fx.mdFiles} md + ${fx.binaryFiles} bin + ${fx.nonMdFiles} non-md, ${fx.dirs} dirs, depth ${fx.depth}, ${mb} MB in ${fx.ms.toFixed(0)}ms`,
    );
    check('fixture has non-md/binary noise to exclude', fx.binaryFiles > 0 && fx.nonMdFiles > 0);

    // 2) Allowlist: only markdown survives **/*.md (binary + non-md dropped).
    console.log('\n2) allowlist: only markdown reaches the backup');
    const all = await walk(workspaceRoot);
    const files = all
      .filter(rel => matchesAllowlist(rel, INCLUDE, EXCLUDE))
      .sort((a, b) => a.localeCompare(b));
    check(
      'candidate count equals the markdown count (noise excluded)',
      files.length === fx.mdFiles,
      `candidates=${files.length} md=${fx.mdFiles} (of ${all.length} total)`,
    );

    const opts = {
      workspaceRoot,
      workspaceName: `scale-ws-${suffix}`,
      connectionName: `scale-${suffix}`,
      rootNoteTitle: 'Trilkeep Scale',
      hardDeleteRemovedFiles: false,
    };
    const run = () => new SyncEngine(client, manifest, opts, silentLog).backup(files, reporter);

    // 3) Full backup: one note per markdown file, plus throughput.
    console.log('\n3) full backup: one note per file');
    const t0 = process.hrtime.bigint();
    const full = await run();
    const secs = Number(process.hrtime.bigint() - t0) / 1e9;
    check(
      'created one note per markdown file',
      full.created === fx.mdFiles,
      `created=${full.created}`,
    );
    console.log(
      `   ${fx.mdFiles} files in ${secs.toFixed(1)}s = ${(fx.mdFiles / secs).toFixed(1)} files/s`,
    );

    // 4) Incremental no-op: re-running with no change uploads nothing.
    console.log('\n4) incremental: unchanged re-run uploads nothing');
    const noop = await run();
    check(
      'every file skipped, nothing created or updated',
      noop.created === 0 && noop.updated === 0 && noop.skipped === fx.mdFiles,
      `created=${noop.created} updated=${noop.updated} skipped=${noop.skipped}`,
    );

    // 5) Delta: mutate K files, re-run uploads exactly K.
    const k = Math.min(num('SCALE_MUTATE', 5), files.length);
    console.log(`\n5) delta: mutate ${k} files, re-run uploads exactly ${k}`);
    for (const rel of files.slice(0, k)) {
      await appendFile(path.join(workspaceRoot, rel), `\nedited ${suffix}\n`);
    }
    const delta = await run();
    check(
      `exactly ${k} updated, the rest skipped`,
      delta.updated === k && delta.skipped === fx.mdFiles - k && delta.created === 0,
      `updated=${delta.updated} skipped=${delta.skipped} created=${delta.created}`,
    );
  } finally {
    if (manifest.rootNoteId) {
      await client
        .deleteNote(manifest.rootNoteId)
        .catch(e =>
          console.log(`  (cleanup) could not delete root ${manifest.rootNoteId}: ${e.message}`),
        );
    }
    await rm(workspaceRoot, { recursive: true, force: true }).catch(() => {});
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => {
  console.error(`\nScale smoke errored: ${e.message}`);
  process.exit(1);
});
