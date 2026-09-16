import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

/**
 * Work queued for a time when nobody will be awake.
 *
 * This is the whole of what makes unattended operation possible without
 * touching the approval boundary. The user asked for runs that happen while
 * they sleep; the first design reached for that by letting IRIS start agents
 * on its own judgement, which collides with two rules the orchestrator holds —
 * a guess may not cause an irreversible act, and anything above READ waits for
 * a person.
 *
 * Queueing sidesteps the collision rather than punching through it. The user
 * decides while awake, naming the task and the repository; the row *is* the
 * authorization; the runner reads it later. Nothing consults the boundary
 * because nothing is asking it for anything — no tool call, no inferred
 * origin, no exception to list or forget to revoke.
 *
 * Two properties the table exists to keep.
 *
 * It survives a restart. A queue held in memory would empty at 2am and look
 * exactly like a night with nothing scheduled, which is the failure shape this
 * codebase keeps rediscovering.
 *
 * A row that did not run says why. `note` is filled on refusal — a dirty tree,
 * a repository no longer allowed, another run already going. A morning with no
 * branch and no explanation is the same as no queue at all.
 */

export type ScheduleState = 'queued' | 'started' | 'cancelled' | 'failed';

export interface ScheduledRun {
  id: string;
  taskId: string;
  repo: string;
  dueAt: string;
  createdAt: string;
  state: ScheduleState;
  runId: string | null;
  note: string | null;
  settledAt: string | null;
}

interface Row {
  id: string;
  task_id: string;
  repo: string;
  due_at: string;
  created_at: string;
  state: ScheduleState;
  run_id: string | null;
  note: string | null;
  settled_at: string | null;
}

function toScheduled(row: Row): ScheduledRun {
  return {
    id: row.id,
    taskId: row.task_id,
    repo: row.repo,
    dueAt: row.due_at,
    createdAt: row.created_at,
    state: row.state,
    runId: row.run_id,
    note: row.note,
    settledAt: row.settled_at,
  };
}

export class AgentScheduleStore {
  constructor(private db: Database.Database) {}

  queue(input: { taskId: string; repo: string; dueAt: string }, now = new Date()): { queued: ScheduledRun | null; reason: string } {
    const due = Date.parse(input.dueAt);
    if (!Number.isFinite(due)) {
      return { queued: null, reason: '実行時刻を解釈できません。ISO8601 で指定してください。' };
    }
    if (due <= now.getTime()) {
      // Refused rather than run immediately. "Later" that turns out to mean
      // "now" is a surprise, and this is the class of thing that should never
      // surprise anyone.
      return { queued: null, reason: '過去または現在の時刻です。未来を指定してください。' };
    }
    if (!input.taskId?.trim() || !input.repo?.trim()) {
      return { queued: null, reason: 'taskId と repo は必須です。' };
    }

    const row: ScheduledRun = {
      id: randomUUID().slice(0, 8),
      taskId: input.taskId.trim(),
      repo: input.repo.trim(),
      dueAt: new Date(due).toISOString(),
      createdAt: now.toISOString(),
      state: 'queued',
      runId: null,
      note: null,
      settledAt: null,
    };
    this.db
      .prepare(
        `INSERT INTO agent_schedule (id, task_id, repo, due_at, created_at, state, run_id, note, settled_at)
         VALUES (?, ?, ?, ?, ?, 'queued', NULL, NULL, NULL)`
      )
      .run(row.id, row.taskId, row.repo, row.dueAt, row.createdAt);
    return { queued: row, reason: `${row.dueAt} に実行します。` };
  }

  /** Everything eligible now, oldest first so a backlog drains in order. */
  due(now = new Date()): ScheduledRun[] {
    const rows = this.db
      .prepare(`SELECT * FROM agent_schedule WHERE state = 'queued' AND due_at <= ? ORDER BY due_at ASC`)
      .all(now.toISOString()) as Row[];
    return rows.map(toScheduled);
  }

  list(limit = 50): ScheduledRun[] {
    const rows = this.db
      .prepare(`SELECT * FROM agent_schedule ORDER BY due_at DESC LIMIT ?`)
      .all(Math.max(1, limit)) as Row[];
    return rows.map(toScheduled);
  }

  get(id: string): ScheduledRun | null {
    const row = this.db.prepare(`SELECT * FROM agent_schedule WHERE id = ?`).get(id) as Row | undefined;
    return row ? toScheduled(row) : null;
  }

  /**
   * Claims a queued row so it cannot start twice.
   *
   * Conditional on the state, so two timers firing together produce one run
   * rather than two agents editing the same branch.
   */
  claim(id: string, now = new Date()): boolean {
    return (
      this.db
        .prepare(`UPDATE agent_schedule SET state = 'started', settled_at = ? WHERE id = ? AND state = 'queued'`)
        .run(now.toISOString(), id).changes > 0
    );
  }

  recordStarted(id: string, runId: string): void {
    this.db.prepare(`UPDATE agent_schedule SET run_id = ? WHERE id = ?`).run(runId, id);
  }

  /** A row that could not run, and the reason a morning with no branch has one. */
  recordFailed(id: string, note: string, now = new Date()): void {
    this.db
      .prepare(`UPDATE agent_schedule SET state = 'failed', note = ?, settled_at = ? WHERE id = ?`)
      .run(note, now.toISOString(), id);
  }

  cancel(id: string, now = new Date()): boolean {
    return (
      this.db
        .prepare(`UPDATE agent_schedule SET state = 'cancelled', settled_at = ? WHERE id = ? AND state = 'queued'`)
        .run(now.toISOString(), id).changes > 0
    );
  }
}
