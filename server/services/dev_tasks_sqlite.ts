import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

export type TaskStatus = 'planned' | 'in_progress' | 'blocked' | 'review' | 'done' | 'abandoned';
export type RunRole = 'implement' | 'review' | 'research' | 'verify';
export type RunStatus = 'pending' | 'running' | 'blocked' | 'succeeded' | 'failed' | 'cancelled';
export type ResultOutcome = 'success' | 'partial' | 'failure';

export interface DevelopmentTask {
  id: string;
  title: string;
  goal: string;
  successCriteria: string[];
  scope: string | null;
  nonGoals: string[];
  constraints: string[];
  /** Decisions already settled, so a later agent does not relitigate them. */
  decisions: string[];
  relevantFiles: string[];
  status: TaskStatus;
  conversationId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentProgress {
  currentStep?: string;
  completedSteps?: string[];
  milestonesTotal?: number;
  milestonesCompleted?: number;
  confidence?: 'low' | 'medium' | 'high';
  note?: string;
}

export interface AgentRun {
  id: string;
  taskId: string;
  agent: string;
  role: RunRole;
  status: RunStatus;
  handoff: any;
  progress: AgentProgress | null;
  blockedReason: string | null;
  lastHeartbeatAt: string | null;
  lastProgressAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentResult {
  id: string;
  runId: string;
  outcome: ResultOutcome;
  summary: string;
  detail: any | null;
  createdAt: string;
}

export interface CreateTaskInput {
  title: string;
  goal: string;
  successCriteria: string[];
  scope?: string | null;
  nonGoals?: string[];
  constraints?: string[];
  decisions?: string[];
  relevantFiles?: string[];
  status?: TaskStatus;
  conversationId?: string | null;
}

/**
 * Development task, agent run and result storage.
 *
 * This is the durable state the development-orchestration layer needs before
 * any of it can be automated: a task that outlives the conversation that
 * created it, a run that records who was asked to do what, and a result in a
 * shape a second model can consume without being handed a raw transcript.
 *
 * Schema is owned by db.ts migration 5.
 */
export class SqliteDevTaskStore {
  constructor(private db: Database.Database) {}

  // ------------------------------------------------------------------ tasks

  createTask(input: CreateTaskInput): DevelopmentTask {
    const now = new Date().toISOString();
    const id = randomUUID();

    if (!input.title?.trim()) throw new Error('title は必須です。');
    if (!input.goal?.trim()) throw new Error('goal は必須です。');
    if (!Array.isArray(input.successCriteria) || input.successCriteria.length === 0) {
      // Enforced rather than defaulted: a task with no definition of done is
      // exactly the kind of work that later gets called "complete" without
      // anyone being able to say what that meant (§39).
      throw new Error('successCriteria を1つ以上指定してください。');
    }

    this.db
      .prepare(
        `INSERT INTO development_tasks
           (id, title, goal, success_criteria_json, scope, non_goals_json,
            constraints_json, decisions_json, relevant_files_json, status,
            conversation_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.title.trim(),
        input.goal.trim(),
        JSON.stringify(input.successCriteria),
        input.scope ?? null,
        JSON.stringify(input.nonGoals ?? []),
        JSON.stringify(input.constraints ?? []),
        JSON.stringify(input.decisions ?? []),
        JSON.stringify(input.relevantFiles ?? []),
        input.status ?? 'planned',
        input.conversationId ?? null,
        now,
        now
      );

    return this.getTask(id)!;
  }

  getTask(id: string): DevelopmentTask | null {
    const row = this.db.prepare(`SELECT * FROM development_tasks WHERE id = ?`).get(id) as any;
    return row ? mapTask(row) : null;
  }

  listTasks(options: { status?: TaskStatus; limit?: number } = {}): DevelopmentTask[] {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 500);
    const rows = options.status
      ? (this.db
          .prepare(
            `SELECT * FROM development_tasks WHERE status = ?
              ORDER BY updated_at DESC, rowid DESC LIMIT ?`
          )
          .all(options.status, limit) as any[])
      : (this.db
          .prepare(`SELECT * FROM development_tasks ORDER BY updated_at DESC, rowid DESC LIMIT ?`)
          .all(limit) as any[]);
    return rows.map(mapTask);
  }

  updateTask(
    id: string,
    patch: Partial<Pick<CreateTaskInput, 'title' | 'goal' | 'successCriteria' | 'scope' | 'nonGoals' | 'constraints' | 'decisions' | 'relevantFiles'>> & {
      status?: TaskStatus;
    }
  ): DevelopmentTask {
    const existing = this.getTask(id);
    if (!existing) throw new Error(`Development task not found: ${id}`);

    const merged = { ...existing, ...patch };
    this.db
      .prepare(
        `UPDATE development_tasks
            SET title = ?, goal = ?, success_criteria_json = ?, scope = ?,
                non_goals_json = ?, constraints_json = ?, decisions_json = ?,
                relevant_files_json = ?, status = ?, updated_at = ?
          WHERE id = ?`
      )
      .run(
        merged.title,
        merged.goal,
        JSON.stringify(merged.successCriteria),
        merged.scope ?? null,
        JSON.stringify(merged.nonGoals),
        JSON.stringify(merged.constraints),
        JSON.stringify(merged.decisions),
        JSON.stringify(merged.relevantFiles),
        merged.status,
        new Date().toISOString(),
        id
      );

    return this.getTask(id)!;
  }

  /** Appends a settled decision so later agents do not reopen it (§55). */
  appendDecision(id: string, decision: string): DevelopmentTask {
    const task = this.getTask(id);
    if (!task) throw new Error(`Development task not found: ${id}`);
    return this.updateTask(id, { decisions: [...task.decisions, decision] });
  }

  deleteTask(id: string): boolean {
    return this.db.prepare(`DELETE FROM development_tasks WHERE id = ?`).run(id).changes > 0;
  }

  // ------------------------------------------------------------------- runs

  createRun(input: { taskId: string; agent: string; role: RunRole; handoff: any }): AgentRun {
    const now = new Date().toISOString();
    const id = randomUUID();

    try {
      this.db
        .prepare(
          `INSERT INTO agent_runs
             (id, task_id, agent, role, status, handoff_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`
        )
        .run(id, input.taskId, input.agent, input.role, JSON.stringify(input.handoff), now, now);
    } catch (err: any) {
      if (String(err?.message).includes('FOREIGN KEY')) {
        throw new Error(`Development task not found: ${input.taskId}`);
      }
      throw err;
    }

    return this.getRun(id)!;
  }

  getRun(id: string): AgentRun | null {
    const row = this.db.prepare(`SELECT * FROM agent_runs WHERE id = ?`).get(id) as any;
    return row ? mapRun(row) : null;
  }

  listRuns(taskId: string): AgentRun[] {
    const rows = this.db
      .prepare(`SELECT * FROM agent_runs WHERE task_id = ? ORDER BY created_at ASC, rowid ASC`)
      .all(taskId) as any[];
    return rows.map(mapRun);
  }

  listActiveRuns(): AgentRun[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM agent_runs WHERE status IN ('pending','running','blocked')
          ORDER BY created_at DESC`
      )
      .all() as any[];
    return rows.map(mapRun);
  }

  startRun(id: string): AgentRun {
    const now = new Date().toISOString();
    const changed = this.db
      .prepare(
        `UPDATE agent_runs
            SET status = 'running', started_at = COALESCE(started_at, ?),
                last_heartbeat_at = ?, last_progress_at = ?, updated_at = ?
          WHERE id = ? AND status IN ('pending','blocked')`
      )
      .run(now, now, now, now, id).changes;
    if (changed !== 1) {
      const run = this.getRun(id);
      if (!run) throw new Error(`Agent run not found: ${id}`);
      throw new Error(`実行を開始できません。現在の状態: ${run.status}`);
    }
    return this.getRun(id)!;
  }

  /**
   * Records a heartbeat, and separately records whether meaningful progress was
   * made. Distinguishing the two is the point: a run that is alive but not
   * advancing is exactly what stall detection must catch (§44).
   */
  heartbeat(id: string, progress?: AgentProgress): AgentRun {
    const run = this.getRun(id);
    if (!run) throw new Error(`Agent run not found: ${id}`);

    const now = new Date().toISOString();
    const madeProgress = progress !== undefined && !isSameProgress(run.progress, progress);

    this.db
      .prepare(
        `UPDATE agent_runs
            SET last_heartbeat_at = ?,
                progress_json = COALESCE(?, progress_json),
                last_progress_at = CASE WHEN ? = 1 THEN ? ELSE last_progress_at END,
                updated_at = ?
          WHERE id = ?`
      )
      .run(now, progress ? JSON.stringify(progress) : null, madeProgress ? 1 : 0, now, now, id);

    return this.getRun(id)!;
  }

  blockRun(id: string, reason: string): AgentRun {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE agent_runs SET status = 'blocked', blocked_reason = ?, last_heartbeat_at = ?, updated_at = ?
          WHERE id = ?`
      )
      .run(reason, now, now, id);
    const run = this.getRun(id);
    if (!run) throw new Error(`Agent run not found: ${id}`);
    return run;
  }

  finishRun(id: string, status: Extract<RunStatus, 'succeeded' | 'failed' | 'cancelled'>): AgentRun {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE agent_runs SET status = ?, ended_at = ?, updated_at = ?, blocked_reason = NULL
          WHERE id = ?`
      )
      .run(status, now, now, id);
    const run = this.getRun(id);
    if (!run) throw new Error(`Agent run not found: ${id}`);
    return run;
  }

  /**
   * Closes runs left mid-flight by a process that died.
   *
   * A run's progress lives in memory; the record does not. Before review became
   * asynchronous this was mostly theoretical, but a restart during a
   * minutes-long review now leaves a row claiming to be running forever, which
   * is precisely the "alive but not progressing" state stall detection exists
   * to catch (§44). Called once at startup, when nothing can legitimately be
   * running yet.
   */
  reconcileOrphanedRuns(): AgentRun[] {
    const orphans = this.db
      .prepare(`SELECT * FROM agent_runs WHERE status IN ('pending','running')`)
      .all() as any[];

    const now = new Date().toISOString();
    const tx = this.db.transaction(() => {
      for (const row of orphans) {
        this.db
          .prepare(
            `UPDATE agent_runs SET status = 'failed', ended_at = ?, updated_at = ?,
                    blocked_reason = ? WHERE id = ?`
          )
          .run(now, now, 'サーバ再起動により中断されました（結果は不明）', row.id);

        this.db
          .prepare(
            `INSERT INTO agent_results (id, run_id, outcome, summary, detail_json, created_at)
             VALUES (?, ?, 'failure', ?, ?, ?)`
          )
          .run(
            randomUUID(),
            row.id,
            'サーバ再起動により中断されました。完了したかどうかは不明です。',
            JSON.stringify({ orphaned: true, startedAt: row.started_at }),
            now
          );
      }
    });
    tx();

    return orphans.map(mapRun);
  }

  // ---------------------------------------------------------------- results

  recordResult(input: {
    runId: string;
    outcome: ResultOutcome;
    summary: string;
    detail?: any;
  }): AgentResult {
    if (!input.summary?.trim()) throw new Error('summary は必須です。');
    const now = new Date().toISOString();
    const id = randomUUID();

    try {
      this.db
        .prepare(
          `INSERT INTO agent_results (id, run_id, outcome, summary, detail_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          input.runId,
          input.outcome,
          input.summary.trim(),
          input.detail === undefined ? null : JSON.stringify(input.detail),
          now
        );
    } catch (err: any) {
      if (String(err?.message).includes('FOREIGN KEY')) {
        throw new Error(`Agent run not found: ${input.runId}`);
      }
      throw err;
    }

    return this.getResult(id)!;
  }

  getResult(id: string): AgentResult | null {
    const row = this.db.prepare(`SELECT * FROM agent_results WHERE id = ?`).get(id) as any;
    return row ? mapResult(row) : null;
  }

  listResults(runId: string): AgentResult[] {
    const rows = this.db
      .prepare(`SELECT * FROM agent_results WHERE run_id = ? ORDER BY created_at ASC, rowid ASC`)
      .all(runId) as any[];
    return rows.map(mapResult);
  }

  /** Every result recorded against a task, across all of its runs. */
  listTaskResults(taskId: string): Array<AgentResult & { run: AgentRun }> {
    const runs = this.listRuns(taskId);
    return runs.flatMap((run) => this.listResults(run.id).map((result) => ({ ...result, run })));
  }
}

/**
 * Derives whether a run looks stalled: alive by status, but with no meaningful
 * progress inside the threshold. `process = running` is not evidence of work
 * (§43), so this is computed from progress timestamps rather than trusted.
 */
export function assessRun(run: AgentRun, now = Date.now(), stallThresholdMs = 10 * 60 * 1000) {
  const active = run.status === 'running';
  const lastProgress = run.lastProgressAt ? Date.parse(run.lastProgressAt) : null;
  const lastHeartbeat = run.lastHeartbeatAt ? Date.parse(run.lastHeartbeatAt) : null;

  const sinceProgressMs = lastProgress === null ? null : now - lastProgress;
  const sinceHeartbeatMs = lastHeartbeat === null ? null : now - lastHeartbeat;

  const stalled = active && sinceProgressMs !== null && sinceProgressMs > stallThresholdMs;

  const total = run.progress?.milestonesTotal;
  const done = run.progress?.milestonesCompleted;
  const estimatedProgress =
    typeof total === 'number' && total > 0 && typeof done === 'number'
      ? Math.min(1, Math.max(0, done / total))
      : null;

  return {
    active,
    stalled,
    sinceProgressMs,
    sinceHeartbeatMs,
    estimatedProgress,
    // Reported as a range rather than a false-precision percentage (§45).
    milestones: typeof total === 'number' ? `${done ?? 0}/${total}` : null,
    confidence: run.progress?.confidence ?? null,
  };
}

function isSameProgress(a: AgentProgress | null, b: AgentProgress): boolean {
  if (!a) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function parseArray(value: any): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseJson(value: any): any {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function mapTask(row: any): DevelopmentTask {
  return {
    id: row.id,
    title: row.title,
    goal: row.goal,
    successCriteria: parseArray(row.success_criteria_json),
    scope: row.scope,
    nonGoals: parseArray(row.non_goals_json),
    constraints: parseArray(row.constraints_json),
    decisions: parseArray(row.decisions_json),
    relevantFiles: parseArray(row.relevant_files_json),
    status: row.status,
    conversationId: row.conversation_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRun(row: any): AgentRun {
  return {
    id: row.id,
    taskId: row.task_id,
    agent: row.agent,
    role: row.role,
    status: row.status,
    handoff: parseJson(row.handoff_json),
    progress: parseJson(row.progress_json),
    blockedReason: row.blocked_reason,
    lastHeartbeatAt: row.last_heartbeat_at,
    lastProgressAt: row.last_progress_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapResult(row: any): AgentResult {
  return {
    id: row.id,
    runId: row.run_id,
    outcome: row.outcome,
    summary: row.summary,
    detail: parseJson(row.detail_json),
    createdAt: row.created_at,
  };
}
