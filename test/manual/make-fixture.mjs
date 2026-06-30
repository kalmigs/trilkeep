#!/usr/bin/env node
/**
Generate a throwaway test repo for exercising Trilkeep backups.
Zero deps, deterministic (seeded). Controls file count, nesting depth,
directory spread, markdown size range, plus optional large/binary/special
files and symlinks. Re-running with the same --seed reproduces byte-identical
content, so you can back up, regenerate with one knob changed, and watch the
hash-diff incremental path do the right thing. Examples (copy-pasteable):

node test/manual/make-fixture.mjs --out tmp/fixture --files 2000 --depth 6
node test/manual/make-fixture.mjs --out tmp/big --large 3 --large-mb 50 --binary 5
node test/manual/make-fixture.mjs --out tmp/fixture --files 50 --special --symlink --non-md

Run with --help for the full flag list.
*/

import { mkdir, rm, open, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// ---- args ------------------------------------------------------------------

const FLAGS = {
  out: { val: 'tmp/fixture', help: 'target directory' },
  files: { val: 50, num: true, help: 'number of markdown files' },
  depth: { val: 3, num: true, help: 'max folder nesting depth' },
  dirs: { val: 0, num: true, help: 'total directories (0 = auto, ~files/8)' },
  'min-kb': { val: 1, num: true, help: 'min markdown file size (KB)' },
  'max-kb': { val: 8, num: true, help: 'max markdown file size (KB)' },
  large: { val: 0, num: true, help: 'count of large markdown files' },
  'large-mb': { val: 5, num: true, help: 'size of each large file (MB)' },
  binary: { val: 0, num: true, help: 'count of binary files (.bin, NUL bytes)' },
  'binary-kb': { val: 64, num: true, help: 'size of each binary file (KB)' },
  special: { val: false, bool: true, help: 'add special-char filenames (spaces/&/#/unicode)' },
  symlink: { val: false, bool: true, help: 'add a symlink (engine should skip it)' },
  'non-md': { val: false, bool: true, help: 'add .txt/.json/.env files (test allowlist)' },
  seed: { val: 1, num: true, help: 'PRNG seed (same seed => same bytes)' },
  clean: { val: false, bool: true, help: 'delete --out first' },
  dry: { val: false, bool: true, help: 'print the plan, write nothing' },
  help: { val: false, bool: true, help: 'show this help' },
};

// Defaults as a plain object, so generate() can be called programmatically with
// a partial { files, depth, ... } and the rest fall back here.
const DEFAULTS = Object.fromEntries(Object.entries(FLAGS).map(([k, v]) => [k, v.val]));

function parseArgs(argv) {
  const o = Object.fromEntries(Object.entries(FLAGS).map(([k, v]) => [k, v.val]));
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (!a.startsWith('--')) continue;
    a = a.slice(2);
    let v;
    const eq = a.indexOf('=');
    if (eq !== -1) {
      v = a.slice(eq + 1);
      a = a.slice(0, eq);
    }
    const spec = FLAGS[a];
    if (!spec) {
      console.error(`unknown flag --${a}`);
      process.exit(2);
    }
    if (spec.bool) {
      o[a] = v === undefined ? true : v !== 'false';
      continue;
    }
    if (v === undefined) v = argv[++i];
    o[a] = spec.num ? Number(v) : v;
  }
  return o;
}

function printHelp() {
  console.log('make-fixture.mjs — generate a throwaway test repo for Trilkeep\n');
  for (const [k, s] of Object.entries(FLAGS)) {
    const def = s.bool ? (s.val ? 'true' : 'false') : s.val;
    console.log(`  --${k.padEnd(12)} ${s.help} (default: ${def})`);
  }
}

// ---- deterministic PRNG (mulberry32) --------------------------------------

function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
const between = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));

// ---- content ---------------------------------------------------------------

const WORDS = (
  'trillium note backup mirror workspace sync engine manifest hash diff token ' +
  'server root branch label content markdown folder nested deep shallow heavy ' +
  'light corpus fixture sample draft idea recall garden foam wiki link tree leaf ' +
  'green forest understory mycelium keep vault archive snapshot incremental atomic'
).split(' ');

function sentence(rng) {
  const n = between(rng, 6, 16);
  const w = Array.from({ length: n }, () => pick(rng, WORDS));
  w[0] = w[0][0].toUpperCase() + w[0].slice(1);
  return w.join(' ') + pick(rng, ['.', '.', '.', '?', '!']);
}
const paragraph = rng => Array.from({ length: between(rng, 3, 6) }, () => sentence(rng)).join(' ');

// Stream markdown of ~targetBytes so multi-MB files never build a giant string.
// Builds ~64KB chunks with no awaits between appends (our content is ASCII, so
// string length tracks byte length closely enough for a fixture).
async function writeMarkdown(p, targetBytes, rng, title) {
  const fh = await open(p, 'w');
  const CHUNK = 1 << 16;
  let written = 0;
  let buf = `# ${title}\n\n`;
  while (written < targetBytes) {
    while (buf.length < CHUNK && written + buf.length < targetBytes) {
      const r = rng();
      if (r < 0.12) buf += `## ${sentence(rng)}\n\n`;
      else if (r < 0.22) buf += `- ${sentence(rng)}\n- ${sentence(rng)}\n\n`;
      else if (r < 0.3) buf += '```\n' + paragraph(rng) + '\n```\n\n';
      else if (r < 0.4) buf += `See [[${pick(rng, WORDS)}-${pick(rng, WORDS)}]].\n\n`;
      else buf += paragraph(rng) + '\n\n';
    }
    const b = Buffer.from(buf, 'utf8');
    await fh.write(b);
    written += b.length;
    buf = '';
  }
  await fh.close();
  return written;
}

// Stream pseudo-random bytes (NUL-bearing => engine classifies as binary).
async function writeBinary(p, targetBytes, rng) {
  const fh = await open(p, 'w');
  const chunk = Buffer.allocUnsafe(1 << 16);
  let written = 0;
  while (written < targetBytes) {
    const n = Math.min(chunk.length, targetBytes - written);
    for (let i = 0; i < n; i += 4)
      chunk.writeUInt32LE((rng() * 4294967296) >>> 0, i > n - 4 ? n - 4 : i);
    await fh.write(chunk, 0, n);
    written += n;
  }
  await fh.close();
  return written;
}

// ---- directory tree --------------------------------------------------------

function buildDirs(rng, count, maxDepth) {
  const dirs = ['']; // '' = repo root
  if (maxDepth < 1) return dirs;
  // Guarantee one spine that reaches maxDepth so deep nesting is always present.
  let spine = '';
  for (let d = 0; d < maxDepth && dirs.length < count; d++) {
    spine = spine ? `${spine}/d${d}` : `d${d}`;
    dirs.push(spine);
  }
  let guard = count * 20;
  while (dirs.length < count && guard-- > 0) {
    const parent = pick(rng, dirs);
    const depth = parent === '' ? 0 : parent.split('/').length;
    if (depth >= maxDepth) continue;
    const name = `${pick(rng, WORDS)}-${dirs.length}`;
    dirs.push(parent === '' ? name : `${parent}/${name}`);
  }
  return dirs;
}

const SPECIAL_NAMES = [
  'a b & c.md',
  'note #1.md',
  'café déjà.md',
  "it's mine.md",
  '100% done.md',
  'a+b=c.md',
  'pär.md',
];

// ---- main ------------------------------------------------------------------

/**
 * Generate the fixture. Accepts a partial options object (same keys as the CLI
 * flags); anything omitted falls back to DEFAULTS. Writes nothing when opt.dry.
 * Returns a summary with exact counts so a caller (e.g. scale-smoke) can assert
 * against them: { out, seed, mdFiles, binaryFiles, nonMdFiles, symlinks, dirs,
 * depth, bytes, ms }.
 */
export async function generate(rawOpt = {}) {
  const opt = { ...DEFAULTS, ...rawOpt };
  const rng = makeRng(opt.seed);
  const outRoot = path.resolve(opt.out);
  const dirCount = opt.dirs > 0 ? opt.dirs : Math.max(1, Math.ceil(opt.files / 8));
  const dirs = buildDirs(rng, dirCount, opt.depth);
  const depth = dirs.reduce((m, d) => Math.max(m, d ? d.split('/').length : 0), 0);

  const s = {
    out: outRoot,
    seed: opt.seed,
    mdFiles: 0,
    binaryFiles: 0,
    nonMdFiles: 0,
    symlinks: 0,
    dirs: dirs.length,
    depth,
    bytes: 0,
    ms: 0,
    symlinkError: undefined,
  };
  if (opt.dry) return s;

  if (opt.clean && existsSync(outRoot)) await rm(outRoot, { recursive: true, force: true });
  await mkdir(outRoot, { recursive: true });
  for (const d of dirs) if (d) await mkdir(path.join(outRoot, d), { recursive: true });

  const t0 = process.hrtime.bigint();
  const at = (dir, name) => path.join(outRoot, dir, name);

  // Regular markdown, scattered across the tree. Special names get the index
  // prefixed so they stay unique (two draws of the same special name in one dir
  // would otherwise overwrite and throw off the md count).
  for (let i = 0; i < opt.files; i++) {
    const dir = pick(rng, dirs);
    const useSpecial = opt.special && rng() < 0.05;
    const name = useSpecial ? `${i} ${pick(rng, SPECIAL_NAMES)}` : `note-${i}.md`;
    const sizeKB = between(rng, opt['min-kb'], opt['max-kb']);
    s.bytes += await writeMarkdown(at(dir, name), sizeKB * 1024, rng, `Note ${i}`);
    s.mdFiles++;
  }

  // Large markdown (heavy text files).
  for (let i = 0; i < opt.large; i++) {
    s.bytes += await writeMarkdown(
      at(pick(rng, dirs), `large-${i}.md`),
      opt['large-mb'] * 1024 * 1024,
      rng,
      `Large ${i}`,
    );
    s.mdFiles++;
  }

  // Binary files (engine should skip these; also excluded by the **/*.md allowlist).
  for (let i = 0; i < opt.binary; i++) {
    s.bytes += await writeBinary(
      at(pick(rng, dirs), `blob-${i}.bin`),
      opt['binary-kb'] * 1024,
      rng,
    );
    s.binaryFiles++;
  }

  // Non-markdown text (test the include allowlist excludes them by default).
  if (opt['non-md']) {
    await writeFile(at('', 'README.txt'), 'plain text, not markdown\n');
    await writeFile(at('', 'config.json'), '{"secret":"should-not-sync"}\n');
    await writeFile(at('', '.env'), 'TOKEN=should-not-sync\n');
    s.nonMdFiles += 3;
  }

  // Symlink (out-of-tree target; engine should skip it, never follow).
  if (opt.symlink) {
    try {
      await symlink(outRoot, at('', 'loop-link'), 'dir');
      s.symlinks++;
    } catch (e) {
      s.symlinkError = e.message;
    }
  }

  s.ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return s;
}

// ---- CLI (only when run directly, not when imported) -----------------------

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const opt = parseArgs(process.argv.slice(2));
  if (opt.help) {
    printHelp();
    process.exit(0);
  }

  const s = await generate(opt);
  console.log(
    'plan:',
    JSON.stringify(
      {
        out: s.out,
        seed: opt.seed,
        markdown: opt.files,
        directories: s.dirs,
        maxDepth: s.depth,
        sizeRangeKB: [opt['min-kb'], opt['max-kb']],
        large: opt.large ? `${opt.large} x ${opt['large-mb']}MB md` : 'none',
        binary: opt.binary ? `${opt.binary} x ${opt['binary-kb']}KB bin` : 'none',
        special: opt.special,
        symlink: opt.symlink,
        nonMd: opt['non-md'],
      },
      null,
      2,
    ),
  );
  if (opt.dry) process.exit(0);

  if (s.symlinkError) console.warn('symlink skipped:', s.symlinkError);
  const entries = s.mdFiles + s.binaryFiles + s.nonMdFiles + s.symlinks;
  const mb = (s.bytes / 1024 / 1024).toFixed(1);
  console.log(
    `\ndone: ${entries} entries, ${mb} MB, ${s.dirs} dirs, depth ${s.depth}, ${s.ms.toFixed(0)}ms`,
  );
  console.log(`  -> ${s.out}`);
}
