import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  globToRegExp,
  isStateDirPath,
  joinGlobs,
  looksLikeSecret,
  matchesAllowlist,
  parseGlobList,
  toPosix,
} from '../src/globs';

test('parseGlobList: splits, trims, and drops blanks', () => {
  assert.deepEqual(parseGlobList('**/*.md, **/*.txt'), ['**/*.md', '**/*.txt']);
  assert.deepEqual(parseGlobList(' a , ,b, '), ['a', 'b']);
});

test('parseGlobList: blank input → empty list', () => {
  assert.deepEqual(parseGlobList(''), []);
  assert.deepEqual(parseGlobList('  ,  , '), []);
});

test('joinGlobs: empty array → empty string', () => {
  assert.equal(joinGlobs([]), '');
  assert.equal(joinGlobs(['  ', '']), '');
});

test('joinGlobs: single glob is returned bare (no braces)', () => {
  assert.equal(joinGlobs(['**/*.md']), '**/*.md');
});

test('joinGlobs: multiple globs are brace-joined', () => {
  assert.equal(joinGlobs(['**/*.md', '**/*.txt']), '{**/*.md,**/*.txt}');
});

test('joinGlobs: trims and drops blanks before joining', () => {
  assert.equal(joinGlobs([' a ', '', ' b ']), '{a,b}');
});

test('toPosix: backslashes become forward slashes', () => {
  assert.equal(toPosix('a\\b\\c.md'), 'a/b/c.md');
  assert.equal(toPosix('already/posix.md'), 'already/posix.md');
});

test('matchesAllowlist: included (nested + top-level), not excluded', () => {
  assert.equal(matchesAllowlist('a/b.md', ['**/*.md'], []), true);
  assert.equal(matchesAllowlist('top.md', ['**/*.md'], []), true);
});

test('matchesAllowlist: not in include → false', () => {
  assert.equal(matchesAllowlist('a/b.txt', ['**/*.md'], []), false);
});

test('matchesAllowlist: in include but excluded → false', () => {
  assert.equal(matchesAllowlist('a/node_modules/x.md', ['**/*.md'], ['**/node_modules/**']), false);
});

test('matchesAllowlist: any one include entry matching is enough', () => {
  assert.equal(matchesAllowlist('a.txt', ['**/*.md', '**/*.txt'], []), true);
  assert.equal(matchesAllowlist('a.log', ['**/*.md', '**/*.txt'], []), false);
});

test('isStateDirPath: flags anything inside .trilkeep/ at any depth', () => {
  assert.equal(isStateDirPath('.trilkeep/state.json'), true);
  assert.equal(isStateDirPath('.trilkeep/state.real.json'), true);
  assert.equal(isStateDirPath('sub/.trilkeep/x'), true);
});

test('isStateDirPath: does NOT flag look-alikes', () => {
  assert.equal(isStateDirPath('notes.md'), false);
  assert.equal(isStateDirPath('.trilkeeper/x'), false);
  assert.equal(isStateDirPath('a.trilkeep'), false);
});

test('matchesAllowlist: the .trilkeep state dir is excluded even with **/* and NO exclude', () => {
  // A user-supplied exclude replaces the defaults, so the guard must not depend on it.
  assert.equal(matchesAllowlist('.trilkeep/state.json', ['**/*'], []), false);
});

// globToRegExp replaces path.matchesGlob (Node 22+) so the on-save allowlist
// works on VSCode's Node 20. These pin the glob semantics we depend on.

test('globToRegExp: ** crosses path segments, * does not', () => {
  const star2 = globToRegExp('**/*.md');
  assert.equal(star2.test('top.md'), true); // **/ matches zero leading segments
  assert.equal(star2.test('a/b.md'), true);
  assert.equal(star2.test('a/b/c.md'), true);
  assert.equal(star2.test('a/b.txt'), false);

  const star1 = globToRegExp('*.md');
  assert.equal(star1.test('top.md'), true);
  assert.equal(star1.test('a/b.md'), false); // * never crosses a slash
});

test('globToRegExp: directory prefix glob', () => {
  const docs = globToRegExp('docs/**');
  assert.equal(docs.test('docs/x.md'), true);
  assert.equal(docs.test('docs/a/b.md'), true);
  assert.equal(docs.test('other/x.md'), false);
  assert.equal(docs.test('docsx.md'), false);
});

test('globToRegExp: ? matches exactly one non-slash char', () => {
  const q = globToRegExp('file?.md');
  assert.equal(q.test('file1.md'), true);
  assert.equal(q.test('file.md'), false);
  assert.equal(q.test('fileab.md'), false);
  assert.equal(q.test('a/file1.md'), false);
});

test('globToRegExp: brace alternation', () => {
  const braces = globToRegExp('**/*.{md,txt}');
  assert.equal(braces.test('a/b.md'), true);
  assert.equal(braces.test('a/b.txt'), true);
  assert.equal(braces.test('a/b.js'), false);
});

test('globToRegExp: character class with negation', () => {
  assert.equal(globToRegExp('[ab].md').test('a.md'), true);
  assert.equal(globToRegExp('[ab].md').test('c.md'), false);
  assert.equal(globToRegExp('[!a].md').test('b.md'), true);
  assert.equal(globToRegExp('[!a].md').test('a.md'), false);
});

test('globToRegExp: dots and other regex metachars are literal', () => {
  const g = globToRegExp('a.b+c.md');
  assert.equal(g.test('a.b+c.md'), true);
  assert.equal(g.test('aXbXc.md'), false); // the dots are not wildcards
});

// --- looksLikeSecret (keep credentials out of a broadened backup) ---

test('looksLikeSecret: flags common secret filenames', () => {
  for (const p of [
    '.env',
    '.env.local',
    '.env.production',
    'config/.env',
    'certs/server.pem',
    'privkey.key',
    '.ssh/id_rsa',
    'id_ed25519',
    'store.p12',
    'cert.pfx',
    'my.keystore',
    'credentials',
    'credentials.json',
    '.ssh/id_rsa_work', // multi-key names
    'deploy/id_ed25519_github',
    'gcp/service-account.json',
    'my-service-account-key.json',
    '.envrc',
    '.netrc',
    '.pgpass',
    '.git-credentials',
    '.npmrc',
    '.pypirc',
    'secrets.json',
    'secrets.yaml',
  ]) {
    assert.equal(looksLikeSecret(p), true, `${p} should look like a secret`);
  }
});

test('looksLikeSecret: does NOT flag ordinary notes or code', () => {
  for (const p of [
    'notes/todo.md',
    'README.md',
    'src/index.ts',
    'environment.md', // not ".env"
    'keynote.md', // not "*.key"
    'docs/credentials-guide.md', // not the bare "credentials" file
  ]) {
    assert.equal(looksLikeSecret(p), false, `${p} should NOT look like a secret`);
  }
});

test('looksLikeSecret: is case-insensitive on the basename', () => {
  assert.equal(looksLikeSecret('deploy/ID_RSA'), true);
  assert.equal(looksLikeSecret('Certs/Server.PEM'), true);
});

test('looksLikeSecret: committed .env placeholders are NOT secrets', () => {
  assert.equal(looksLikeSecret('.env.example'), false);
  assert.equal(looksLikeSecret('.env.sample'), false);
  assert.equal(looksLikeSecret('.env.template'), false);
  assert.equal(looksLikeSecret('.env.dist'), false);
});
