import { execFileSync } from 'child_process';
import { existsSync, statSync } from 'fs';
import { resolve } from 'path';
import type Database from 'better-sqlite3';

/**
 * A lock on a file that would be gone if somebody deleted it.
 *
 * Not a note and not a convention: macOS's `uchg` flag, which the kernel
 * enforces. Measured 2026-08-26 — with it set, `rm` answers "Operation not
 * permitted" and a shell redirect answers the same; without it both succeed.
 * No sudo is needed for a file the user owns.
 *
 * It exists because of what this project keeps doing. In four days it
 * committed sixty megabytes of funding documents into a product repository,
 * destroyed uncommitted edits with `git reset --hard`, and killed a process
 * without checking what it was. Every one of those was a careless move on
 * something that could not be undone, made by an agent or by me, and none of
 * them would have got past a flag the kernel checks.
 *
 * What it is not: protection against somebody who means it. `chflags nouchg`
 * is one command and anyone can type it. This stops the slip, not the
 * decision — which is the failure that actually happens here.
 *
 * The ledger is the other half, and arguably the more useful one. A lock whose
 * removal leaves no trace is worth much less than one that records who took it
 * off and why, because the moment worth reviewing is the unlocking.
 */

export interface Lock {
  path: string;
  reason: string;
  lockedAt: string;
  lockedBy: string;
  /** Set when the lock has been taken off, with the reason it was. */
  unlockedAt: string | null;
  unlockedReason: string | null;
}

export type LockOutcome =
  | { ok: true; lock: Lock }
  | { ok: false; code: 'not_found' | 'not_a_file' | 'flag_failed' | 'not_locked'; message: string };

export class LockStore {
  constructor(private db: Database.Database, private now: () => Date = () => new Date()) {}

  /**
   * Sets the flag first, records second.
   *
   * That order on purpose: a ledger entry for a lock that was never applied is
   * a claim of protection that does not exist, which is worse than no entry —
   * somebody would rely on it. If the flag fails, nothing is written.
   */
  lock(path: string, reason: string, by = 'user'): LockOutcome {
    const full = resolve(path);
    if (!existsSync(full)) return { ok: false, code: 'not_found', message: `ありません: ${full}` };
    if (!statSync(full).isFile()) {
      // Directories can carry the flag too, but locking one hides why its
      // contents cannot be written, which reads as a broken disk.
      return { ok: false, code: 'not_a_file', message: `ファイルではありません: ${full}` };
    }
    try {
      execFileSync('/usr/bin/chflags', ['uchg', full], { stdio: 'pipe' });
    } catch (err: any) {
      return { ok: false, code: 'flag_failed', message: err?.message ?? String(err) };
    }
    const at = this.now().toISOString();
    this.db
      .prepare(
        `INSERT INTO file_locks (path, reason, locked_at, locked_by, unlocked_at, unlocked_reason)
         VALUES (?, ?, ?, ?, NULL, NULL)
         ON CONFLICT(path) DO UPDATE SET
           reason = excluded.reason, locked_at = excluded.locked_at,
           locked_by = excluded.locked_by, unlocked_at = NULL, unlocked_reason = NULL`
      )
      .run(full, reason, at, by);
    return { ok: true, lock: { path: full, reason, lockedAt: at, lockedBy: by, unlockedAt: null, unlockedReason: null } };
  }

  /**
   * Records first, unsets second — the opposite order, for the same reason.
   *
   * The unlocking is the event worth reviewing, so it is written down before
   * the protection goes away. A reason is required and not defaulted: "なぜ
   * 外したか" is the entire value of the ledger, and an empty string would let
   * the interesting case be the one with nothing in it.
   */
  unlock(path: string, reason: string, by = 'user'): LockOutcome {
    const full = resolve(path);
    const row = this.current(full);
    if (!row) return { ok: false, code: 'not_locked', message: `施錠されていません: ${full}` };
    const at = this.now().toISOString();
    this.db
      .prepare(`UPDATE file_locks SET unlocked_at = ?, unlocked_reason = ?, locked_by = ? WHERE path = ?`)
      .run(at, reason, by, full);
    try {
      execFileSync('/usr/bin/chflags', ['nouchg', full], { stdio: 'pipe' });
    } catch (err: any) {
      return { ok: false, code: 'flag_failed', message: err?.message ?? String(err) };
    }
    return { ok: true, lock: { ...row, unlockedAt: at, unlockedReason: reason, lockedBy: by } };
  }

  /** Locks that are still on. */
  current(path?: string): Lock | null {
    if (!path) return null;
    const row = this.db
      .prepare(`SELECT * FROM file_locks WHERE path = ? AND unlocked_at IS NULL`)
      .get(resolve(path)) as any;
    return row ? toLock(row) : null;
  }

  list(includeReleased = false): Lock[] {
    const sql = includeReleased
      ? `SELECT * FROM file_locks ORDER BY locked_at DESC`
      : `SELECT * FROM file_locks WHERE unlocked_at IS NULL ORDER BY locked_at DESC`;
    return (this.db.prepare(sql).all() as any[]).map(toLock);
  }

  /**
   * Whether the ledger and the filesystem still agree.
   *
   * They can drift: `chflags nouchg` from a shell takes the protection off and
   * tells nobody. A lock the ledger believes in and the disk does not is the
   * one worth surfacing, because everything downstream of it is trusting a
   * fence that is no longer there.
   */
  drifted(): Array<{ path: string; reason: string; problem: 'flag_missing' | 'file_missing' }> {
    const out: Array<{ path: string; reason: string; problem: 'flag_missing' | 'file_missing' }> = [];
    for (const lock of this.list()) {
      if (!existsSync(lock.path)) {
        out.push({ path: lock.path, reason: lock.reason, problem: 'file_missing' });
        continue;
      }
      if (!hasImmutableFlag(lock.path)) {
        out.push({ path: lock.path, reason: lock.reason, problem: 'flag_missing' });
      }
    }
    return out;
  }
}

/** Whether the kernel currently refuses to delete this. */
export function hasImmutableFlag(path: string): boolean {
  try {
    const out = execFileSync('/bin/ls', ['-ldO', resolve(path)], { encoding: 'utf-8' });
    return /\buchg\b/.test(out);
  } catch {
    return false;
  }
}

function toLock(row: any): Lock {
  return {
    path: row.path,
    reason: row.reason,
    lockedAt: row.locked_at,
    lockedBy: row.locked_by,
    unlockedAt: row.unlocked_at ?? null,
    unlockedReason: row.unlocked_reason ?? null,
  };
}
