/**
 * Locking a file that would be gone if somebody deleted it.
 *
 * The flag is the fence and the ledger is the record, and the assertions here
 * are mostly about the order between them: a ledger entry for a lock that was
 * never applied is a claim of protection that does not exist, and an unlock
 * that removes the protection before writing down why leaves the interesting
 * moment untraceable.
 *
 * Run: npx tsx scripts/test-locks.ts
 */
import Database from 'better-sqlite3';
import { mkdtempSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { LockStore, hasImmutableFlag } from '../server/services/locks.js';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function section(name: string) { console.log(`\n▸ ${name}`); }
function eq(name: string, actual: any, expected: any) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(`${name}: ${JSON.stringify(actual)} ≠ ${JSON.stringify(expected)}`); console.log(`  ✗ ${name}`); }
}

function store(): { store: LockStore; dir: string } {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE file_locks (
    path TEXT PRIMARY KEY, reason TEXT NOT NULL, locked_at TEXT NOT NULL,
    locked_by TEXT NOT NULL, unlocked_at TEXT, unlocked_reason TEXT);`);
  return { store: new LockStore(db), dir: mkdtempSync(join(tmpdir(), 'iris-lock-')) };
}

function file(dir: string, name = 'important.txt'): string {
  const path = join(dir, name);
  writeFileSync(path, '消えたら終わるもの', 'utf-8');
  return path;
}

function main() {
  const { store: locks, dir } = store();
  const path = file(dir);

  section('The flag is the fence');
  {
    const result = locks.lock(path, '消えたら復元できないため');
    eq('locking succeeds', result.ok, true);
    eq('and the kernel agrees', hasImmutableFlag(path), true);

    // The point of the whole thing: this is what a careless agent does.
    let removed = true;
    try { unlinkSync(path); } catch { removed = false; }
    eq('a delete is refused', removed, false);
    eq('and the file is still there', existsSync(path), true);
  }

  section('The ledger is the record');
  {
    const held = locks.list();
    eq('one lock is held', held.length, 1);
    eq('with the reason it was applied for', held[0].reason, '消えたら復元できないため');

    const off = locks.unlock(path, 'この資料はもう別の場所にある');
    eq('unlocking succeeds', off.ok, true);
    eq('the flag is gone', hasImmutableFlag(path), false);
    // The unlocking is the row worth reading, so it has to survive.
    eq('nothing is held any more', locks.list().length, 0);
    const history = locks.list(true);
    eq('but the history remains', history.length, 1);
    eq('and says why it came off', history[0].unlockedReason, 'この資料はもう別の場所にある');
  }

  section('What it refuses to do');
  {
    eq('a file that is not there', (locks.lock(join(dir, 'nope.txt'), '理由') as any).code, 'not_found');
    // A locked directory hides why its contents cannot be written, which reads
    // as a broken disk rather than as protection.
    eq('a directory', (locks.lock(dir, '理由') as any).code, 'not_a_file');
    eq('unlocking what was never locked', (locks.unlock(file(dir, 'other.txt'), '理由') as any).code, 'not_locked');
  }

  section('When the disk and the ledger disagree');
  {
    const guarded = file(dir, 'guarded.txt');
    locks.lock(guarded, '守る');
    eq('no drift while it holds', locks.drifted().length, 0);

    // Somebody types chflags nouchg in a shell. The ledger still believes.
    execFileSync('/usr/bin/chflags', ['nouchg', guarded]);
    const drift = locks.drifted();
    eq('the drift is found', drift.length, 1);
    eq('and named', drift[0].problem, 'flag_missing');

    unlinkSync(guarded);
    eq('a missing file is its own problem', locks.drifted()[0].problem, 'file_missing');
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`Locks: ${passed} passed, ${failed} failed`);
  if (failed) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('All lock tests passed.');
}

main();
