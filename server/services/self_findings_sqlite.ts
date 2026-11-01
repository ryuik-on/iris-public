import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

/**
 * 自己開発の「気づいたこと」の控え。移行 34。
 *
 * 段は一方向に進む：open → fixing → verifying → awaiting_approval → merged。
 * 外れ道は dismissed（人が要らないと言った）と failed（直せなかった・検査に落ちた）。
 * **再び起きたら戻す**：merged や failed の後に同じ鍵がまた来たら open に戻して
 * 「直したのに再発した」と残す。見なかったことにはしない。
 */
export type FindingSource = 'complaint' | 'selfcheck' | 'error' | 'overview';
export type FindingStatus = 'open' | 'fixing' | 'verifying' | 'awaiting_approval' | 'merged' | 'dismissed' | 'failed';

export interface Finding {
  id: string;
  dedupeKey: string;
  source: FindingSource;
  title: string;
  detail: string;
  evidence: string[];
  status: FindingStatus;
  attempts: number;
  occurrences: number;
  firstSeen: string;
  lastSeen: string;
  taskId: string | null;
  runId: string | null;
  branch: string | null;
  verification: any | null;
  note: string | null;
  updatedAt: string;
}

/** 同じ問題に、直しを試す回数の上限。**暴走を止める構造上の安全装置**（使用量の上限ではない）。 */
export const MAX_ATTEMPTS = 3;

export class SelfFindingStore {
  constructor(private db: Database.Database) {}

  /** 気づいたことを置く。同じ鍵なら見た回数を増やす。新規ならそう言う。 */
  report(
    input: { dedupeKey: string; source: FindingSource; title: string; detail: string; evidence?: string[] },
    now = new Date()
  ): { finding: Finding; created: boolean; reopened: boolean } {
    const at = now.toISOString();
    const existing = this.byKey(input.dedupeKey);
    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO self_findings (id, dedupe_key, source, title, detail, evidence, status, first_seen, last_seen, updated_at)
           VALUES (@id, @dedupeKey, @source, @title, @detail, @evidence, 'open', @at, @at, @at)`
        )
        .run({ id: randomUUID(), dedupeKey: input.dedupeKey, source: input.source, title: input.title, detail: input.detail, evidence: JSON.stringify(input.evidence ?? []), at });
      return { finding: this.byKey(input.dedupeKey)!, created: true, reopened: false };
    }
    const regressed = existing.status === 'merged' || existing.status === 'failed';
    const evidence = [...new Set([...(existing.evidence), ...(input.evidence ?? [])])].slice(-12);
    this.db
      .prepare(
        `UPDATE self_findings SET occurrences = occurrences + 1, last_seen = @at, updated_at = @at, evidence = @evidence,
           status = CASE WHEN @regressed = 1 THEN 'open' ELSE status END,
           note = CASE WHEN @regressed = 1 THEN @note ELSE note END
         WHERE dedupe_key = @key`
      )
      .run({ at, key: input.dedupeKey, evidence: JSON.stringify(evidence), regressed: regressed ? 1 : 0, note: regressed ? `直したあとに再発（${at.slice(0, 16)}）` : null });
    return { finding: this.byKey(input.dedupeKey)!, created: false, reopened: regressed };
  }

  byKey(key: string): Finding | null {
    const row = this.db.prepare(`SELECT * FROM self_findings WHERE dedupe_key = ?`).get(key);
    return row ? shape(row) : null;
  }

  get(id: string): Finding | null {
    const row = this.db.prepare(`SELECT * FROM self_findings WHERE id = ?`).get(id);
    return row ? shape(row) : null;
  }

  list(statuses?: FindingStatus[], limit = 100): Finding[] {
    const rows = statuses?.length
      ? this.db
          .prepare(`SELECT * FROM self_findings WHERE status IN (${statuses.map(() => '?').join(',')}) ORDER BY last_seen DESC LIMIT ?`)
          .all(...statuses, limit)
      : this.db.prepare(`SELECT * FROM self_findings ORDER BY last_seen DESC LIMIT ?`).all(limit);
    return rows.map(shape);
  }

  /** 次に直す候補。見た回数が多く、試した回数が少ないものから。 */
  nextToFix(): Finding | null {
    const row = this.db
      .prepare(`SELECT * FROM self_findings WHERE status = 'open' AND attempts < ? ORDER BY occurrences DESC, first_seen ASC LIMIT 1`)
      .get(MAX_ATTEMPTS);
    return row ? shape(row) : null;
  }

  update(id: string, patch: Partial<Pick<Finding, 'status' | 'taskId' | 'runId' | 'branch' | 'verification' | 'note' | 'attempts'>>, now = new Date()): Finding | null {
    const current = this.get(id);
    if (!current) return null;
    const next = { ...current, ...patch };
    this.db
      .prepare(
        `UPDATE self_findings SET status=@status, task_id=@taskId, run_id=@runId, branch=@branch,
           verification=@verification, note=@note, attempts=@attempts, updated_at=@at WHERE id=@id`
      )
      .run({
        id, status: next.status, taskId: next.taskId, runId: next.runId, branch: next.branch,
        verification: next.verification ? JSON.stringify(next.verification) : null,
        note: next.note, attempts: next.attempts, at: now.toISOString(),
      });
    return this.get(id);
  }
}

function shape(row: any): Finding {
  return {
    id: row.id, dedupeKey: row.dedupe_key, source: row.source, title: row.title, detail: row.detail,
    evidence: JSON.parse(row.evidence || '[]'), status: row.status, attempts: row.attempts,
    occurrences: row.occurrences, firstSeen: row.first_seen, lastSeen: row.last_seen,
    taskId: row.task_id, runId: row.run_id, branch: row.branch,
    verification: row.verification ? JSON.parse(row.verification) : null,
    note: row.note, updatedAt: row.updated_at,
  };
}
