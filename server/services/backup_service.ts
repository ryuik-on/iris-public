import Database from 'better-sqlite3';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'fs';
import { join } from 'path';

import {
  BackupFile,
  RetentionPolicy,
  DEFAULT_RETENTION,
  backupName,
  parseBackupName,
  selectBackups,
} from '../core/backup_retention.js';

/**
 * Copies of the database, taken while it is running.
 *
 * SQLite's own `VACUUM INTO` is used rather than copying the file. A running
 * database has a WAL alongside it, and copying just the `.db` produces a file
 * that opens fine and is missing whatever had not been checkpointed — which is
 * the most recent work, which is the reason anyone wanted a backup. `VACUUM
 * INTO` writes a consistent snapshot of the whole thing, and compacts it.
 *
 * Every backup is verified before the old ones are thinned. An unreadable
 * backup that displaced a readable one is worse than no backup at all, and the
 * only way to know is to open it.
 */

export interface BackupResult {
  ok: boolean;
  file?: string;
  bytes?: number;
  removed?: string[];
  reason?: string;
}

export interface BackupOptions {
  db: Database.Database;
  directory: string;
  retention?: RetentionPolicy;
  onEvent?: (event: { type: string; detail?: Record<string, any> }) => void;
  now?: () => Date;
  /**
   * 控えを取る設定ファイル。既定は `.env`。
   *
   * **データベース以外で、どこにも控えの無い唯一のもの。**git は無視し
   * （鍵が入るので当然）、`VACUUM INTO` の対象でもない。API キー、
   * `IRIS_CODEX_BINARY`、`IRIS_AGENT_REPOS` —— 消えると本当に戻らない。
   *
   * 世代は取らない。**最新の一つだけ**を上書きする。設定は「その時どう
   * 動いていたか」ではなく「いまどう動くべきか」なので、古い版を並べても
   * どれを戻せばいいかが増えるだけ。
   */
  configFile?: string;
}

export class BackupService {
  constructor(private options: BackupOptions) {}

  private now(): Date {
    return this.options.now ? this.options.now() : new Date();
  }

  /**
   * 設定ファイルを、データベースの隣へ写す。
   *
   * **失敗しても控え全体を失敗にしない。**データベースが取れたことの方が
   * 重い。取れなかったことは出来事として残すので、黙って落ちてはいない。
   *
   * 権限は 0600。置き場は既に端末の外へ出さない約束の場所
   * （`finance_local_boundary`）だが、**鍵の複製が一つ増えるので、読める
   * 相手は本人だけにする。**
   */
  private copyConfig(dir: string): void {
    const from = this.options.configFile;
    if (!from) return;
    if (!existsSync(from)) {
      this.options.onEvent?.({ type: 'backup.config_missing', detail: { file: from } });
      return;
    }
    const to = join(dir, 'env.backup');
    try {
      copyFileSync(from, to);
      chmodSync(to, 0o600);
      this.options.onEvent?.({ type: 'backup.config_copied', detail: { file: to } });
    } catch (err: any) {
      this.options.onEvent?.({ type: 'backup.config_failed', detail: { message: err?.message ?? String(err) } });
    }
  }

  /** Snapshots the database, verifies it, then thins the older copies. */
  run(): BackupResult {
    const dir = this.options.directory;
    try {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    } catch (err: any) {
      return { ok: false, reason: `保存先を作成できません: ${err?.message ?? err}` };
    }

    const at = this.now();
    const name = backupName(at);
    const target = join(dir, name);

    try {
      // Parameterised as a literal because VACUUM INTO takes no bindings; the
      // path is built here from a timestamp, never from input.
      this.options.db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    } catch (err: any) {
      this.options.onEvent?.({ type: 'backup.failed', detail: { message: err?.message } });
      return { ok: false, reason: `取得に失敗しました: ${err?.message ?? err}` };
    }

    this.copyConfig(dir);

    // Opened and read before anything is deleted. A snapshot nobody checked is
    // a belief about a file, not a backup.
    const verified = this.verify(target);
    if (!verified.ok) {
      try { unlinkSync(target); } catch { /* the failed copy is not worth keeping */ }
      this.options.onEvent?.({ type: 'backup.unverified', detail: { file: name, reason: verified.reason } });
      return { ok: false, reason: `検証に失敗したため破棄しました: ${verified.reason}` };
    }

    const removed = this.thin(at);
    const bytes = statSync(target).size;
    this.options.onEvent?.({
      type: 'backup.taken',
      detail: { file: name, bytes, removed: removed.length },
    });
    return { ok: true, file: name, bytes, removed };
  }

  /** Opens a snapshot and reads from it. */
  verify(path: string): { ok: boolean; reason?: string } {
    let copy: Database.Database | null = null;
    try {
      copy = new Database(path, { readonly: true });
      const check = copy.pragma('integrity_check', { simple: true });
      if (check !== 'ok') return { ok: false, reason: `integrity_check: ${check}` };

      /**
       * Schema, not rows.
       *
       * A first version rejected a snapshot whose register was empty, meaning
       * to catch a truncated file. It caught a legitimate one instead: a
       * database that has not been seeded yet has no rows, so every backup was
       * taken, judged worthless and deleted — leaving a fresh install with no
       * backups and a log full of successes. An empty table is a state; a
       * missing table is a broken file.
       */
      const version = copy.pragma('user_version', { simple: true }) as number;
      const expected = this.options.db.pragma('user_version', { simple: true }) as number;
      if (version !== expected) {
        return { ok: false, reason: `schema ${version} != ${expected}` };
      }
      const table = copy
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'future_features'`)
        .get();
      if (!table) return { ok: false, reason: 'future_features テーブルがありません。' };
      return { ok: true };
    } catch (err: any) {
      return { ok: false, reason: err?.message ?? String(err) };
    } finally {
      try { copy?.close(); } catch { /* nothing to do */ }
    }
  }

  list(): BackupFile[] {
    const dir = this.options.directory;
    if (!existsSync(dir)) return [];
    const files: BackupFile[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.db')) continue;
      const takenAt = parseBackupName(name);
      if (!takenAt) continue;
      files.push({ name, takenAt });
    }
    return files.sort((a, b) => b.takenAt.getTime() - a.takenAt.getTime());
  }

  private thin(now: Date): string[] {
    const { remove } = selectBackups(this.list(), now, this.options.retention ?? DEFAULT_RETENTION);
    const removed: string[] = [];
    for (const name of remove) {
      try {
        unlinkSync(join(this.options.directory, name));
        removed.push(name);
      } catch { /* a file already gone is the state we wanted */ }
    }
    return removed;
  }

  /** Newest first, with sizes, for a person deciding whether to trust it. */
  describe(): Array<{ name: string; takenAt: string; bytes: number }> {
    return this.list().map((f) => ({
      name: f.name,
      takenAt: f.takenAt.toISOString(),
      bytes: (() => {
        try { return statSync(join(this.options.directory, f.name)).size; } catch { return 0; }
      })(),
    }));
  }
}
