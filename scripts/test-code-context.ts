/**
 * Code-context tests.
 *
 * This module reads IRIS's own source so a reviewer can judge the
 * implementation rather than its description. The content it produces is sent
 * to an external model, so the failure that matters is leakage: a .env reaching
 * a review prompt is worse than one being read locally. Most of this file is
 * about what must never come out.
 *
 * Run: npm run test:code-context
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  collectCodeContext,
  renderCodeContext,
  filterDiffHunks,
  MAX_FILE_BYTES,
} from '../server/services/code_context.js';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    failures.push(name + (detail ? ` — ${detail}` : ''));
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function eq(name: string, actual: any, expected: any) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, ok, ok ? undefined : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function section(title: string) {
  console.log(`\n▸ ${title}`);
}

const SECRET = 'SUPER_SECRET_VALUE_THAT_MUST_NEVER_LEAVE';

async function main() {
  const base = mkdtempSync(join(tmpdir(), 'iris-code-'));
  const repo = join(base, 'repo');
  const outside = join(base, 'outside');
  mkdirSync(repo, { recursive: true });
  mkdirSync(outside, { recursive: true });

  const git = (args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  git(['init', '-q']);
  git(['config', 'user.email', 't@e.com']);
  git(['config', 'user.name', 't']);

  mkdirSync(join(repo, 'server'), { recursive: true });
  writeFileSync(join(repo, 'server', 'app.ts'), 'export const answer = 42;\n');
  writeFileSync(join(repo, '.env'), `API_KEY=${SECRET}\n`);
  writeFileSync(join(repo, 'creds.pem'), `PRIVATE KEY ${SECRET}\n`);
  writeFileSync(join(repo, 'data.db'), `sqlite ${SECRET}\n`);
  writeFileSync(join(repo, 'binary.bin'), Buffer.from([0x00, 0x01, 0x00, 0x02]));
  writeFileSync(join(outside, 'secret-notes.txt'), `OUTSIDE ${SECRET}\n`);
  symlinkSync(join(outside, 'secret-notes.txt'), join(repo, 'link-out.txt'));
  // The leak an independent review found: a link INSIDE the repo pointing at a
  // protected file passed the denylist on its own name and passed containment
  // because its target is also inside the repo. Reproduced against a real .env
  // before the fix.
  symlinkSync(join(repo, '.env'), join(repo, 'notes.md'));

  git(['add', '-A', '-f']);
  git(['commit', '-qm', 'baseline']);

  // Uncommitted changes, including one to a protected file.
  writeFileSync(join(repo, 'server', 'app.ts'), 'export const answer = 43; // changed\n');
  writeFileSync(join(repo, '.env'), `API_KEY=${SECRET}_ROTATED\n`);

  try {
    // ---------------------------------------------------------------------
    section('Nothing protected reaches the reviewer');

    const ctx = await collectCodeContext(repo, [
      'server/app.ts',
      '.env',
      'creds.pem',
      'data.db',
      'binary.bin',
      '../outside/secret-notes.txt',
      'link-out.txt',
      'notes.md',
      'does-not-exist.ts',
    ]);

    check('the context is available', ctx.available);
    const rendered = renderCodeContext(ctx);
    const everything = JSON.stringify(ctx) + rendered;

    check('the secret appears nowhere in the context', !everything.includes(SECRET), 'LEAK');
    check('the ordinary source file IS included', /answer = 43/.test(rendered));

    const omittedBy = (p: string) => ctx.omitted.find((o) => o.path === p)?.reason;
    eq('.env is omitted as denied', omittedBy('.env'), 'denied');
    eq('a private key is omitted as denied', omittedBy('creds.pem'), 'denied');
    eq('the database is omitted as denied', omittedBy('data.db'), 'denied');
    eq('a binary is omitted as binary', omittedBy('binary.bin'), 'binary');
    eq('a path outside the repo is omitted', omittedBy('../outside/secret-notes.txt'), 'outside_repository');
    eq('a symlink pointing outside is omitted', omittedBy('link-out.txt'), 'outside_repository');
    eq('a symlink to a protected file INSIDE the repo is omitted', omittedBy('notes.md'), 'denied');
    eq('a missing file is reported as missing', omittedBy('does-not-exist.ts'), 'missing');

    eq('only the safe file is returned', ctx.files.map((f) => f.path), ['server/app.ts']);

    // A reviewer that does not know something was withheld may conclude it
    // does not exist, so omissions are stated rather than silent.
    check('omissions are stated in the rendered output', /除外されたもの/.test(rendered));
    check('and each omitted path is named', rendered.includes('`.env`'));

    // ---------------------------------------------------------------------
    section('The diff cannot leak either');

    check('a diff was produced', typeof ctx.diff === 'string' && ctx.diff.length > 0);
    check('the diff contains the ordinary change', /answer = 43/.test(ctx.diff ?? ''));
    check('the rotated secret is NOT in the diff', !(ctx.diff ?? '').includes(SECRET), 'LEAK');
    check('the protected hunk is replaced with a notice', /機密の可能性があるため除外/.test(ctx.diff ?? ''));

    const hunks = filterDiffHunks(
      'diff --git a/ok.ts b/ok.ts\n+const a = 1;\n' +
      `diff --git a/.env b/.env\n+SECRET=${SECRET}\n` +
      'diff --git a/lib/util.ts b/lib/util.ts\n+const b = 2;\n'
    );
    check('hunk filtering keeps ordinary files', /const a = 1/.test(hunks) && /const b = 2/.test(hunks));
    check('hunk filtering drops the protected file body', !hunks.includes(SECRET), 'LEAK');
    check('and still records that the file changed', /a\/\.env/.test(hunks));

    // ---------------------------------------------------------------------
    section('Rename and unparseable hunks fail closed');

    // A rename away from a protected file names it on the a/ side only, while
    // its whole contents appear as deletions.
    const renamed = filterDiffHunks(
      `diff --git a/.env b/config/app.ts\n--- a/.env\n+++ b/config/app.ts\n-SECRET=${SECRET}\n`
    );
    check('a rename away from a protected file is dropped', !renamed.includes(SECRET), 'LEAK');

    // The original regex used \S+, so any path containing a space failed to
    // match and the hunk was kept — fail-open on exactly the paths least likely
    // to be noticed. These are the shapes git actually emits.
    const spaced = filterDiffHunks(`diff --git a/my dir/.env b/my dir/.env\n+KEY=${SECRET}\n`);
    check('a protected file under a directory with spaces is dropped', !spaced.includes(SECRET), 'LEAK');

    const quoted = filterDiffHunks(`diff --git "a/日本語/.env" "b/日本語/.env"\n+KEY=${SECRET}\n`);
    check('core.quotePath form is dropped too', !quoted.includes(SECRET), 'LEAK');

    // A header this cannot parse at all keeps nothing. Losing review value is
    // better than losing a secret.
    const malformed = filterDiffHunks(`diff --git garbled\n+KEY=${SECRET}\n`);
    check('a header that cannot be parsed fails closed', !malformed.includes(SECRET), 'LEAK');
    check('and says so rather than vanishing', /解釈できない/.test(malformed));

    const ordinary = filterDiffHunks('diff --git a/lib/a.ts b/lib/a.ts\n+const x = 1;\n');
    check('an ordinary hunk still passes through', /const x = 1/.test(ordinary));

    // ---------------------------------------------------------------------
    section('Nothing goes missing silently');

    writeFileSync(join(repo, 'brand-new.ts'), 'export const fresh = true;\n');
    const withUntracked = await collectCodeContext(repo, ['server/app.ts']);
    check(
      'an untracked file is reported, since the diff cannot show it',
      withUntracked.untracked.includes('brand-new.ts'),
      JSON.stringify(withUntracked.untracked)
    );
    check(
      'and appears in the rendered output',
      /未追跡ファイル/.test(renderCodeContext(withUntracked))
    );

    const dirCtx = await collectCodeContext(repo, ['server'], { includeDiff: false });
    eq('a directory says so rather than "unreadable"', dirCtx.omitted[0]?.reason, 'directory');

    // ---------------------------------------------------------------------
    section('Budget is enforced and truncation is reported');

    const big = 'x'.repeat(MAX_FILE_BYTES * 2);
    writeFileSync(join(repo, 'big.ts'), big);
    const capped = await collectCodeContext(repo, ['big.ts'], { includeDiff: false });
    eq('an oversized file is included but capped', capped.files[0].bytes, MAX_FILE_BYTES);
    check('and is flagged as truncated', capped.files[0].truncated);
    check('the context reports the budget was exceeded', capped.budgetExceeded);
    check(
      'the rendered form warns against concluding from partial content',
      /見えていない部分について結論を出さないでください/.test(renderCodeContext(capped))
    );

    const tiny = await collectCodeContext(repo, ['server/app.ts', 'big.ts'], {
      maxTotalBytes: 40,
      includeDiff: false,
    });
    check('a tight budget still returns something', tiny.files.length >= 1);
    check('and reports what it dropped', tiny.budgetExceeded || tiny.omitted.length > 0);

    // ---------------------------------------------------------------------
    section('Failing safe outside a repository');

    const notRepo = await collectCodeContext(base, ['anything.ts']);
    check('a non-repository is reported unavailable, not crashed', !notRepo.available);
    check('with a reason', typeof notRepo.error === 'string');
    check('and renders as a stated failure', /取得できませんでした/.test(renderCodeContext(notRepo)));

    // ---------------------------------------------------------------------
    section('This is not a capability the model gained');

    // The module exposes no write path — the guarantee is structural, and this
    // asserts it rather than trusting the current shape of the file.
    const moduleExports = await import('../server/services/code_context.js');
    const writeLike = Object.keys(moduleExports).filter((k) => /write|delete|create|update|exec|run/i.test(k));
    eq('the module exports no mutating function', writeLike, []);

    const toolsModule = await import('../server/tools/registry.js');
    const registry = new toolsModule.ToolRegistry();
    eq('and registers no tool of its own', registry.getAll().length, 0);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Code context: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('All code context tests passed.');
}

main().catch((err) => {
  console.error('\nTest harness crashed:', err);
  process.exit(1);
});
