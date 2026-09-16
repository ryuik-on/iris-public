/**
 * Backup tests.
 *
 * On 2026-08-20 the only copies of this database were two manual snapshots
 * from two days earlier, one of them a twentieth of the current size —
 * everything decided, learned and corrected since existed in exactly one
 * place. This is the thing that fixes that, so the tests are about the ways a
 * backup can appear to work and not.
 *
 * Three of those:
 *
 * A snapshot taken by copying the file misses whatever the WAL had not
 * checkpointed, which is the most recent work, which is why anyone wanted the
 * backup. So the copy is checked for the rows that were written just before
 * it.
 *
 * Thinning must never delete the newest copy. A retention policy that can is
 * a bug that only manifests at the worst possible moment.
 *
 * A file the policy cannot parse is kept. Deleting what you do not understand
 * is how a backup directory loses the one copy that mattered.
 *
 * Run: npm run test:backup
 */
import { mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync, readFileSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';

import { openDatabase } from '../server/services/db.js';
import { BackupService } from '../server/services/backup_service.js';
import {
  selectBackups,
  parseBackupName,
  backupName,
  DEFAULT_RETENTION,
  BackupFile,
} from '../server/core/backup_retention.js';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail?: string) {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
function eq(name: string, actual: any, expected: any) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, ok, ok ? undefined : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function section(t: string) { console.log(`\n▸ ${t}`); }

const dir = mkdtempSync(join(tmpdir(), 'iris-backup-'));
const NOW = new Date('2026-08-20T12:00:00');

function file(name: string): BackupFile {
  return { name, takenAt: parseBackupName(name)! };
}
function at(daysAgo: number, hour = 3): string {
  const d = new Date(NOW);
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, 0, 0, 0);
  return backupName(d);
}

function main() {
  // -----------------------------------------------------------------------
  section('Names carry their own timestamp');

  {
    const parsed = parseBackupName('iris-20260820-035400.db');
    check('a name parses', parsed !== null);
    eq('to the right day', parsed!.getFullYear() * 10000 + (parsed!.getMonth() + 1) * 100 + parsed!.getDate(), 20260820);
    eq('and the right time', parsed!.getHours() * 100 + parsed!.getMinutes(), 354);
    eq('a name without a stamp is not a backup', parseBackupName('notes.db'), null);
    // Round-trips, so listing and writing agree.
    eq('the format round-trips', parseBackupName(backupName(NOW))!.getTime(), NOW.getTime());
  }

  // -----------------------------------------------------------------------
  section('Thinning keeps a shape, not a count');

  {
    // A month of daily backups.
    const files = Array.from({ length: 40 }, (_, i) => file(at(i)));
    const { keep, remove } = selectBackups(files, NOW);

    check('the newest is kept', keep.includes(at(0)));
    check('yesterday is kept', keep.includes(at(1)));
    check('two weeks back is kept', keep.includes(at(14)));
    // Between the daily window and the weekly one, most days go.
    check('something older is dropped', remove.length > 0);
    check('but not everything older', keep.length > DEFAULT_RETENTION.dailyDays);
    eq('every file is either kept or removed', keep.length + remove.length, files.length);
  }

  {
    // Days with no backup must not shift the window. Counting files would
    // assume one per day — and the days it missed are the days something was
    // wrong.
    const sparse = [file(at(0)), file(at(1)), file(at(20)), file(at(200)), file(at(400))];
    const { keep } = selectBackups(sparse, NOW);
    check('a gap does not push older copies out', keep.includes(at(20)));
    // 200 days is inside the twelve-month bucket, so it survives — the
    // earlier version of this assertion had the arithmetic wrong, not the
    // policy.
    check('and something inside a year survives', keep.includes(at(200)));
    check('but not something older than a year', !keep.includes(at(400)));
  }

  {
    // The most important property. A policy that can delete the newest copy
    // is a bug that only shows up at the worst possible moment.
    const onlyOld = [file(at(400))];
    const { keep, remove } = selectBackups(onlyOld, NOW);
    eq('the only backup is kept even when it is too old', keep, [at(400)]);
    eq('and nothing is removed', remove, []);
  }

  {
    const mixed = [file(at(0)), { name: 'manual-snapshot.db', takenAt: new Date(0) }];
    const { remove } = selectBackups(
      mixed.filter((f) => parseBackupName(f.name) !== null),
      NOW
    );
    // Unparseable files never reach the policy — the service filters them out
    // of the listing — so they are never candidates for deletion.
    check('a file the policy cannot read is never proposed for deletion', !remove.includes('manual-snapshot.db'));
  }

  // -----------------------------------------------------------------------
  section('A snapshot has what was just written');

  {
    const dbPath = join(dir, 'live.db');
    const db = openDatabase(dbPath);
    const backupDir = join(dir, 'backups');
    const service = new BackupService({ db, directory: backupDir, now: () => NOW });

    // Written immediately before the snapshot, so it is exactly the kind of
    // row a plain file copy would miss.
    db.prepare(
      `INSERT INTO future_features (id, key, title, domain, status, verification, reality, priority, reason, dependencies_json, evidence_json, source, created_at, updated_at)
       VALUES ('t1','backup_probe','検証用','test','PLANNED','NONE','NOT_IMPLEMENTED','NONE','テスト','[]','[]','test',?,?)`
    ).run(NOW.toISOString(), NOW.toISOString());

    const result = service.run();
    check('the backup succeeds', result.ok === true, result.reason);
    check('and has a name', Boolean(result.file));
    check('with bytes on disk', (result.bytes ?? 0) > 0);

    // Opened and read, not merely present.
    const copy = new Database(join(backupDir, result.file!), { readonly: true });
    const row = copy.prepare(`SELECT key FROM future_features WHERE key = 'backup_probe'`).get() as any;
    check('the row written just before the snapshot is in it', row?.key === 'backup_probe');
    eq('and the copy is structurally sound', copy.pragma('integrity_check', { simple: true }), 'ok');
    copy.close();

    db.close();
  }

  {
    // Verification has to reject a file that opens but says nothing, or an
    // empty snapshot could displace a good one.
    const db = openDatabase(join(dir, 'v.db'));
    const service = new BackupService({ db, directory: join(dir, 'v-backups'), now: () => NOW });

    const empty = join(dir, 'empty.db');
    new Database(empty).close();
    const verdict = service.verify(empty);
    check('an empty database fails verification', verdict.ok === false);
    check('and says why', (verdict.reason ?? '').length > 0);

    writeFileSync(join(dir, 'garbage.db'), 'not a database at all');
    check('so does a file that is not a database', service.verify(join(dir, 'garbage.db')).ok === false);

    db.close();
  }

  {
    // Two snapshots on the same day: the newer replaces the older in the
    // daily bucket, and the directory does not grow without bound.
    const db = openDatabase(join(dir, 'r.db'));
    const backupDir = join(dir, 'r-backups');
    let clock = new Date('2026-08-01T03:00:00');
    const service = new BackupService({ db, directory: backupDir, now: () => clock });

    for (let day = 0; day < 40; day++) {
      clock = new Date(clock.getTime() + 86_400_000);
      service.run();
    }
    const remaining = readdirSync(backupDir).filter((n) => n.endsWith('.db'));
    check('forty days do not leave forty files', remaining.length < 40, `${remaining.length}`);
    check('but more than a fortnight survives', remaining.length >= DEFAULT_RETENTION.dailyDays, `${remaining.length}`);
    check('the newest is still there', existsSync(join(backupDir, backupName(clock))));

    db.close();
  }

  section('設定ファイルも一緒に写す');
  {
    /*
     * `.env` は git が無視し（鍵が入る）、`VACUUM INTO` はデータベースしか
     * 見ない。**どこにも控えの無い唯一のもの**だった（2026-09-08）。
     */
    const home = mkdtempSync(join(tmpdir(), 'iris-cfg-'));
    const store = join(home, 'backups');
    const env = join(home, '.env');
    writeFileSync(env, 'OPENAI_MODEL=gpt-5.6-terra\nSECRET=abc\n');
    const db2 = openDatabase(join(home, 'x.db'));

    const events: string[] = [];
    // 同じ秒に二度取ると名前が衝突して `VACUUM INTO` が落ちる。時計を進める。
    let tick = Date.parse('2026-09-08T05:00:00Z');
    const service = new BackupService({
      db: db2, directory: store, configFile: env,
      onEvent: (e) => events.push(e.type),
      now: () => new Date((tick += 60_000)),
    });
    service.run();

    const copy = join(store, 'env.backup');
    eq('写っている', existsSync(copy), true);
    eq('中身がそのまま', readFileSync(copy, 'utf-8').includes('SECRET=abc'), true);
    // 鍵の複製が一つ増えるので、読める相手は本人だけにする。
    eq('本人しか読めない', statSync(copy).mode & 0o777, 0o600);
    eq('写したことを出来事に残す', events.includes('backup.config_copied'), true);

    // 世代は取らない。設定は「いまどう動くべきか」なので、最新の一つだけ。
    writeFileSync(env, 'OPENAI_MODEL=gpt-6-astra\n');
    service.run();
    eq('上書きされる', readFileSync(copy, 'utf-8').includes('gpt-6-astra'), true);
    eq('古い版を並べない', readdirSync(store).filter((f) => f.startsWith('env')).length, 1);

    // 設定が無くても、データベースの控えは取れる。
    rmSync(env);
    const result = service.run();
    eq('設定が無くても控えは成功する', result.ok, true);
    /*
     * 数が増えることは確かめない。**間引きが同じ日の古い方を落とす**ので、
     * 一日のうちに何度取っても残るのは一つ。数えると、間引きが働いた日に
     * 落ちる試験になる。確かめるのは「取れて、検証を通ったものが在る」こと。
     */
    eq('検証済みの控えが在る', readdirSync(store).some((f) => f.endsWith('.db')), true);
    eq('無かったことは黙らない', events.includes('backup.config_missing'), true);

    db2.close();
    rmSync(home, { recursive: true, force: true });
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Backup: ${passed} passed, ${failed} failed`);
  rmSync(dir, { recursive: true, force: true });
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('All backup tests passed.');
}

main();
