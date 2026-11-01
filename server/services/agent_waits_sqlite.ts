import type Database from 'better-sqlite3';

/**
 * 待機中の委任。理由と、いつから待っているかと、何度確かめたか。
 *
 * 置く理由は `db.ts` の移行 33。**断られたことを残さないと、断られたことは
 * 無かったことになる** —— タスクは「予定」の顔のまま、誰も何も待っていない。
 */
export interface AgentWait {
  taskId: string;
  repo: string;
  agent: string;
  reasonCode: string;
  reason: string;
  since: string;
  checkedAt: string;
  attempts: number;
  resolvedAt: string | null;
  runId: string | null;
}

/** 待てば解ける断り。これ以外（許可リストに無い等）は待っても解けない。 */
export const WAITABLE = new Set(['dirty_tree', 'busy']);

export class AgentWaitStore {
  constructor(private db: Database.Database) {}

  /** 待ち始める。すでに待っていれば、理由と確かめた時刻を更新する。 */
  wait(input: { taskId: string; repo: string; agent: string; reasonCode: string; reason: string }, now = new Date()): AgentWait {
    const at = now.toISOString();
    this.db
      .prepare(
        `INSERT INTO agent_waits (task_id, repo, agent, reason_code, reason, since, checked_at, attempts)
         VALUES (@taskId, @repo, @agent, @reasonCode, @reason, @at, @at, 1)
         ON CONFLICT(task_id) DO UPDATE SET
           reason_code = excluded.reason_code, reason = excluded.reason,
           checked_at = excluded.checked_at, attempts = agent_waits.attempts + 1,
           resolved_at = NULL, run_id = NULL,
           since = CASE WHEN agent_waits.resolved_at IS NULL THEN agent_waits.since ELSE excluded.since END`
      )
      .run({ ...input, at });
    return this.get(input.taskId)!;
  }

  get(taskId: string): AgentWait | null {
    const row = this.db.prepare(`SELECT * FROM agent_waits WHERE task_id = ?`).get(taskId);
    return row ? shape(row) : null;
  }

  /** まだ解けていないもの。古い順（先に待ち始めたものから始める）。 */
  open(): AgentWait[] {
    return this.db
      .prepare(`SELECT * FROM agent_waits WHERE resolved_at IS NULL ORDER BY since ASC`)
      .all()
      .map(shape);
  }

  /** もう一度確かめて、まだ待つ。 */
  touch(taskId: string, reasonCode: string, reason: string, now = new Date()): void {
    this.db
      .prepare(
        `UPDATE agent_waits SET checked_at = ?, reason_code = ?, reason = ?, attempts = attempts + 1
          WHERE task_id = ? AND resolved_at IS NULL`
      )
      .run(now.toISOString(), reasonCode, reason, taskId);
  }

  /** 始まった、または待つのをやめた。`runId` は始まったときだけ。 */
  resolve(taskId: string, runId: string | null, now = new Date()): void {
    this.db
      .prepare(`UPDATE agent_waits SET resolved_at = ?, run_id = ? WHERE task_id = ? AND resolved_at IS NULL`)
      .run(now.toISOString(), runId, taskId);
  }
}

function shape(row: any): AgentWait {
  return {
    taskId: row.task_id,
    repo: row.repo,
    agent: row.agent,
    reasonCode: row.reason_code,
    reason: row.reason,
    since: row.since,
    checkedAt: row.checked_at,
    attempts: row.attempts,
    resolvedAt: row.resolved_at,
    runId: row.run_id,
  };
}
