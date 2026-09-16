import Database from 'better-sqlite3';

/**
 * Tasks parked on purpose, and when the parking runs out.
 *
 * This is the first piece of the ledger that lives in IRIS rather than in the
 * sheet, and it is a safe first piece precisely because the sheet has no idea
 * what a hold is: the two stores hold disjoint facts, so there is nothing for
 * them to disagree about while the rest of the move happens.
 */

export interface Hold {
  taskId: string;
  /** YYYY-MM-DD. Never null — a hold without an end is not a hold. */
  heldUntil: string;
  reason: string | null;
  setBy: string;
  setAt: string;
}

interface Row {
  task_id: string;
  held_until: string;
  reason: string | null;
  set_by: string;
  set_at: string;
  released_at: string | null;
  released_by: string | null;
}

const toHold = (r: Row): Hold => ({
  taskId: r.task_id,
  heldUntil: r.held_until,
  reason: r.reason,
  setBy: r.set_by,
  setAt: r.set_at,
});

export class FdpHoldStore {
  constructor(private db: Database.Database) {}

  /** Every hold not yet released, by task. Expiry is the verdict's business. */
  active(): Map<string, Hold> {
    const rows = this.db
      .prepare('SELECT * FROM fdp_task_holds WHERE released_at IS NULL')
      .all() as Row[];
    return new Map(rows.map((r) => [r.task_id, toHold(r)]));
  }

  /**
   * Park a task until a date.
   *
   * `setBy` is required rather than defaulted. Sessions write here, and a
   * default would quietly attribute an automatic hold to the person.
   */
  hold(taskId: string, heldUntil: string, reason: string | null, setBy: string, now = new Date()): Hold {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(heldUntil)) {
      throw new Error(`保留の期限は YYYY-MM-DD で指定してください: ${heldUntil}`);
    }
    if (!setBy.trim()) throw new Error('保留を設定した主体が必要です。');
    this.db
      .prepare(
        `INSERT INTO fdp_task_holds (task_id, held_until, reason, set_by, set_at, released_at, released_by)
         VALUES (?, ?, ?, ?, ?, NULL, NULL)
         ON CONFLICT(task_id) DO UPDATE SET
           held_until = excluded.held_until,
           reason = excluded.reason,
           set_by = excluded.set_by,
           set_at = excluded.set_at,
           released_at = NULL,
           released_by = NULL`
      )
      .run(taskId, heldUntil, reason?.trim() || null, setBy.trim(), now.toISOString());
    return { taskId, heldUntil, reason: reason?.trim() || null, setBy: setBy.trim(), setAt: now.toISOString() };
  }

  /** Let it be judged again. Returns false when nothing was on hold. */
  release(taskId: string, releasedBy: string, now = new Date()): boolean {
    const result = this.db
      .prepare(
        'UPDATE fdp_task_holds SET released_at = ?, released_by = ? WHERE task_id = ? AND released_at IS NULL'
      )
      .run(now.toISOString(), releasedBy.trim() || 'unknown', taskId);
    return result.changes > 0;
  }
}
