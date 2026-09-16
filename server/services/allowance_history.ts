import type Database from 'better-sqlite3';

/**
 * Keeps a record of what the live readings said, because they do not.
 *
 * The weekly percentage resets every seven days and remembers nothing before
 * the reset. The per-project figures are recounted from transcripts on every
 * request, and transcripts are files that somebody may eventually tidy away.
 * Both answer "right now"; neither answers "what did last month look like",
 * which is the only question an allocation can be argued from.
 *
 * Nothing here enforces anything. It exists so that in a few weeks there is
 * something to point at other than a hunch.
 */

export interface AllowancePoint {
  at: string;
  vendor: string;
  weekPercent: number | null;
  sessionPercent: number | null;
  weekResetsAt: string | null;
}

export interface ProjectPoint {
  at: string;
  project: string;
  windowDays: number;
  weightedUsd: number;
  outputTokens: number;
  cacheReadTokens: number;
  messages: number;
}

export class AllowanceHistory {
  constructor(private db: Database.Database, private now: () => Date = () => new Date()) {}

  /**
   * One reading per vendor per snapshot.
   *
   * A null percentage is written rather than skipped. "The meter was not
   * answering at 3am" is a fact about the night, and a series with a hole in
   * it says so where a series that simply lacks a row does not.
   */
  recordAllowance(points: Array<Omit<AllowancePoint, 'at'>>): void {
    const at = this.now().toISOString();
    const insert = this.db.prepare(
      `INSERT OR REPLACE INTO allowance_history (at, vendor, week_percent, session_percent, week_resets_at)
       VALUES (?, ?, ?, ?, ?)`
    );
    this.db.transaction(() => {
      for (const p of points) {
        insert.run(at, p.vendor, num(p.weekPercent), num(p.sessionPercent), p.weekResetsAt ?? null);
      }
    })();
  }

  recordProjects(windowDays: number, rows: Array<Omit<ProjectPoint, 'at' | 'windowDays'>>): void {
    const at = this.now().toISOString();
    const insert = this.db.prepare(
      `INSERT OR REPLACE INTO project_usage_history
         (at, project, window_days, weighted_usd, output_tokens, cache_read_tokens, messages)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    this.db.transaction(() => {
      for (const r of rows) {
        insert.run(at, r.project, windowDays, r.weightedUsd, r.outputTokens, r.cacheReadTokens, r.messages);
      }
    })();
  }

  /** Readings since a point, oldest first, for drawing or for arguing from. */
  allowanceSince(sinceIso: string): AllowancePoint[] {
    return (
      this.db
        .prepare(
          `SELECT at, vendor, week_percent AS weekPercent, session_percent AS sessionPercent,
                  week_resets_at AS weekResetsAt
             FROM allowance_history WHERE at >= ? ORDER BY at ASC`
        )
        .all(sinceIso) as AllowancePoint[]
    );
  }

  /**
   * The most recent snapshot of each project, and how it has moved.
   *
   * Deliberately the latest rather than an average: the window itself is a
   * rolling seven days, so averaging snapshots would average overlapping
   * windows and count the same work several times.
   */
  latestProjects(): ProjectPoint[] {
    return this.db
      .prepare(
        `SELECT at, project, window_days AS windowDays, weighted_usd AS weightedUsd,
                output_tokens AS outputTokens, cache_read_tokens AS cacheReadTokens, messages
           FROM project_usage_history
          WHERE at = (SELECT MAX(at) FROM project_usage_history)
          ORDER BY weighted_usd DESC`
      )
      .all() as ProjectPoint[];
  }

  counts(): { allowance: number; projects: number; firstAt: string | null } {
    const a = this.db.prepare(`SELECT COUNT(*) AS n FROM allowance_history`).get() as { n: number };
    const p = this.db.prepare(`SELECT COUNT(*) AS n FROM project_usage_history`).get() as { n: number };
    const f = this.db.prepare(`SELECT MIN(at) AS at FROM allowance_history`).get() as { at: string | null };
    return { allowance: a.n, projects: p.n, firstAt: f.at };
  }
}

function num(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
