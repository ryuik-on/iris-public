/**
 * Local data permission tests.
 *
 * The workspace confinement, the approval boundary and the `local_only` flag
 * all govern what IRIS will hand out. None of them says anything about another
 * account on the same machine opening the file directly — and on 2026-08-20
 * every one of these was world-readable, including `backups/`, which holds a
 * complete copy of the database with the transactions marked as never leaving
 * the device.
 *
 * Applied at every start rather than once by hand, because a directory
 * recreated later inherits the umask and the tightening would undo itself the
 * first time something was rebuilt. That is the property most of this file is
 * about.
 *
 * Run: npm run test:permissions
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  enforce,
  check,
  isPrivate,
  describeExposure,
  DIRECTORY_MODE,
  FILE_MODE,
} from '../server/core/local_permissions.js';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(name: string, condition: boolean, detail?: string) {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
function eq(name: string, actual: any, expected: any) {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  ok(name, same, same ? undefined : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function section(t: string) { console.log(`\n▸ ${t}`); }

const dir = mkdtempSync(join(tmpdir(), 'iris-perm-'));
const modeOf = (p: string) => statSync(p).mode & 0o777;

function main() {
  // -----------------------------------------------------------------------
  section('What counts as private');

  {
    ok('owner-only is private', isPrivate(0o700));
    ok('and 600 for a file', isPrivate(0o600));
    // Anything at all for group or other is not.
    ok('group read is not', !isPrivate(0o740));
    ok('other read is not', !isPrivate(0o704));
    ok('the usual default is not', !isPrivate(0o755));
    ok('nor the usual file default', !isPrivate(0o644));

    // The report has to name who, or it is not actionable.
    ok('other read is described', describeExposure(0o644).includes('他のユーザ'));
    ok('group write is described', describeExposure(0o660).includes('グループ'));
  }

  // -----------------------------------------------------------------------
  section('Applying, not just reporting');

  {
    const target = { path: join(dir, 'finance'), kind: 'directory' as const, holds: 'CSV' };
    mkdirSync(target.path, { recursive: true });
    chmodSync(target.path, 0o755);
    ok('starts world-readable', !isPrivate(modeOf(target.path)));

    const after = enforce(target);
    ok('enforce closes it', after.ok, after.reason ?? '');
    eq('to 700', modeOf(target.path), DIRECTORY_MODE);

    // The property that matters at startup: something recreated later inherits
    // the umask, and applying once by hand would not survive it.
    chmodSync(target.path, 0o777);
    ok('a reopened directory is closed again', enforce(target).ok);
    eq('back to 700', modeOf(target.path), DIRECTORY_MODE);
  }

  {
    const target = { path: join(dir, 'db.sqlite'), kind: 'file' as const, holds: 'すべて' };
    writeFileSync(target.path, 'x');
    chmodSync(target.path, 0o644);
    const after = enforce(target);
    ok('a file is closed too', after.ok);
    eq('to 600', modeOf(target.path), FILE_MODE);
  }

  {
    // A directory that does not exist yet is created closed, rather than
    // created by something else later and left open.
    const target = { path: join(dir, 'made-here'), kind: 'directory' as const, holds: 'x' };
    const created = enforce(target);
    ok('a missing directory is created', created.exists);
    eq('already private', modeOf(target.path), DIRECTORY_MODE);
  }

  // -----------------------------------------------------------------------
  section('Reporting');

  {
    const target = { path: join(dir, 'open'), kind: 'directory' as const, holds: '明細' };
    mkdirSync(target.path, { recursive: true });
    chmodSync(target.path, 0o755);

    // `check` observes without changing, so a report can be produced without
    // the act of reporting fixing what it reports.
    const observed = check(target);
    ok('check reports the exposure', !observed.ok);
    ok('and says who can read it', (observed.reason ?? '').includes('他のユーザ'));
    ok('and what is at stake', observed.holds === '明細');
    eq('without changing anything', modeOf(target.path), 0o755);
  }

  {
    const absent = { path: join(dir, 'not-there'), kind: 'file' as const, holds: 'x' };
    const observed = check(absent);
    ok('a file that does not exist is not a fault', observed.ok);
    ok('and is reported as absent', observed.exists === false);
    // Nothing is invented for it.
    eq('with no mode', observed.mode, null);
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Local permissions: ${passed} passed, ${failed} failed`);
  rmSync(dir, { recursive: true, force: true });
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('All permission tests passed.');
}

main();
