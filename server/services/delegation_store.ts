import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import { DelegationGrant } from '../core/delegation.js';

/**
 * Where a grant lives, and what has been spent against it.
 *
 * Grants are superseded, never edited, and revoked with a timestamp rather
 * than a DELETE. "When did I agree to this, and to what" has to stay
 * answerable after the terms change — a row updated in place cannot answer it,
 * and a row deleted cannot say it ever existed.
 *
 * Spending is recorded here rather than derived from `agent_runs` because the
 * cap has to hold even if a run row is cleaned up, and a ceiling computed from
 * rows that can disappear is a ceiling that quietly rises.
 */
export class DelegationStore {
  constructor(private db: Database.Database, private now: () => Date = () => new Date()) {}

  /** The one live grant for a tool, or null. */
  liveGrant(tool: string): (DelegationGrant & { id: string }) | null {
    const row = this.db
      .prepare(
        `SELECT * FROM delegation_grants
          WHERE tool = ? AND revoked_at IS NULL
          ORDER BY granted_at DESC LIMIT 1`
      )
      .get(tool) as any;
    if (!row) return null;

    let repos: string[];
    try {
      repos = JSON.parse(row.repos_json);
    } catch {
      // Unreadable scope is no scope. `decideDelegation` refuses an empty
      // list, so this fails closed rather than throwing into a tool call.
      repos = [];
    }

    return {
      id: row.id,
      tool: row.tool,
      repos: Array.isArray(repos) ? repos : [],
      dailyUsdCap: row.daily_usd_cap,
      maxConcurrent: row.max_concurrent,
      expiresAt: row.expires_at,
      grantedAt: row.granted_at,
      note: row.note ?? null,
    };
  }

  /**
   * Records a grant, revoking any live one for the same tool first.
   *
   * One live grant per tool, so "what am I allowed to do" has a single answer.
   * Two overlapping grants would mean two caps, and the effective cap would be
   * whichever the code happened to read.
   */
  grant(input: DelegationGrant): DelegationGrant & { id: string } {
    const at = this.now().toISOString();
    const id = randomUUID().slice(0, 8);
    this.db.transaction(() => {
      this.db
        .prepare(`UPDATE delegation_grants SET revoked_at = ? WHERE tool = ? AND revoked_at IS NULL`)
        .run(at, input.tool);
      this.db
        .prepare(
          `INSERT INTO delegation_grants
             (id, tool, repos_json, daily_usd_cap, max_concurrent, expires_at, granted_at, note, revoked_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`
        )
        .run(
          id,
          input.tool,
          JSON.stringify(input.repos),
          input.dailyUsdCap,
          input.maxConcurrent,
          input.expiresAt,
          input.grantedAt,
          input.note
        );
    })();
    return { ...input, id };
  }

  /** Returns how many grants were revoked, so "there was nothing to revoke" is sayable. */
  revoke(tool: string): number {
    const at = this.now().toISOString();
    const result = this.db
      .prepare(`UPDATE delegation_grants SET revoked_at = ? WHERE tool = ? AND revoked_at IS NULL`)
      .run(at, tool);
    return result.changes;
  }

  /**
   * What has been spent under a grant since local midnight.
   *
   * Local, not UTC. A cap the user thinks of as "per day" resets when their
   * day does; a UTC boundary would reset it at 09:00 JST, in the middle of a
   * working morning.
   *
   * A use whose cost could not be metered counts as `unmetered` rather than
   * as zero. The caller decides what to do with that, because "spent $0 on
   * three runs" and "could not price three runs" are different situations and
   * only one of them is safe to continue from.
   */
  spentToday(grantId: string): { usd: number; unmetered: number } {
    const start = this.now();
    start.setHours(0, 0, 0, 0);
    const rows = this.db
      .prepare(`SELECT usd FROM delegation_uses WHERE grant_id = ? AND used_at >= ?`)
      .all(grantId, start.toISOString()) as Array<{ usd: number | null }>;

    let usd = 0;
    let unmetered = 0;
    for (const row of rows) {
      if (typeof row.usd === 'number' && Number.isFinite(row.usd)) usd += row.usd;
      else unmetered++;
    }
    return { usd: Math.round(usd * 1_000_000) / 1_000_000, unmetered };
  }

  /** Written before the dispatch, so a crash mid-launch still leaves a record. */
  recordUse(input: {
    grantId: string;
    repo: string;
    agent: string;
    /** Whose weekly allowance this draws from. */
    vendor?: string | null;
    /** What the dispatch was for — `implement` or `audit`. */
    purpose?: string | null;
    /** The vendor's weekly percentage as it stood before the run. */
    weekBefore?: number | null;
  }): string {
    const id = randomUUID().slice(0, 8);
    this.db
      .prepare(
        `INSERT INTO delegation_uses
           (id, grant_id, run_id, repo, agent, used_at, usd, week_before, vendor, purpose)
         VALUES (?, ?, NULL, ?, ?, ?, NULL, ?, ?, ?)`
      )
      .run(
        id,
        input.grantId,
        input.repo,
        input.agent,
        this.now().toISOString(),
        num(input.weekBefore),
        input.vendor ?? null,
        input.purpose ?? null
      );
    return id;
  }

  /** The run id, once the launch has produced one. */
  attachRun(useId: string, runId: string): void {
    this.db.prepare(`UPDATE delegation_uses SET run_id = ? WHERE id = ?`).run(runId, useId);
  }

  /**
   * The final cost, in both units.
   *
   * The dollar figure was the only one recorded and it is not the constraint:
   * both agents run on subscriptions, and two Codex runs costing four cents
   * between them moved that week's meter ten points. The weekly percentage
   * after the run is stored beside the one from before it, rather than the
   * difference, because subtracting is only valid when both came from the
   * same week — a reset in between turns a large spend into a large saving,
   * and two numbers make that visible where one would not.
   */
  settleUse(
    useId: string,
    usd: number | null,
    weekAfter?: number | null,
    /**
     * What ran it and what it consumed.
     *
     * Optional because one of the three agents files no cost anywhere IRIS can
     * read. Its rows carry a model and no tokens, which is a fact about that
     * agent worth being able to see rather than a gap to fill with zeroes.
     */
    spend?: { model?: string | null; outputTokens?: number | null; inputTokens?: number | null; cacheReadTokens?: number | null }
  ): void {
    this.db
      .prepare(
        `UPDATE delegation_uses
            SET usd = ?,
                week_after = COALESCE(?, week_after),
                model = COALESCE(?, model),
                output_tokens = COALESCE(?, output_tokens),
                input_tokens = COALESCE(?, input_tokens),
                cache_read_tokens = COALESCE(?, cache_read_tokens)
          WHERE id = ?`
      )
      .run(
        usd === null || !Number.isFinite(usd) ? null : usd,
        num(weekAfter),
        spend?.model ?? null,
        num(spend?.outputTokens),
        num(spend?.inputTokens),
        num(spend?.cacheReadTokens),
        useId
      );
  }

  /**
   * What each purpose has drawn from each vendor's week.
   *
   * Nothing is capped on this yet, on purpose. Allocating shares before there
   * is a measurement to allocate against would be putting a number in the
   * code that nobody could defend — the same mistake the routing table avoided
   * by not claiming a speciality neither benchmark found.
   */
  allowanceSince(sinceIso: string): Array<{
    vendor: string | null;
    purpose: string | null;
    runs: number;
    points: number;
    unmeasured: number;
  }> {
    const rows = this.db
      .prepare(
        `SELECT vendor, purpose, week_before, week_after
           FROM delegation_uses
          WHERE used_at >= ?`
      )
      .all(sinceIso) as Array<{
      vendor: string | null;
      purpose: string | null;
      week_before: number | null;
      week_after: number | null;
    }>;

    const groups = new Map<string, { vendor: string | null; purpose: string | null; runs: number; points: number; unmeasured: number }>();
    for (const row of rows) {
      const key = `${row.vendor ?? '?'}|${row.purpose ?? '?'}`;
      const g = groups.get(key) ?? { vendor: row.vendor, purpose: row.purpose, runs: 0, points: 0, unmeasured: 0 };
      g.runs++;
      // A run with only one end recorded is counted as unmeasured rather than
      // as zero: the ones that fail to settle are the expensive ones.
      if (row.week_before === null || row.week_after === null) g.unmeasured++;
      else g.points += Math.max(0, row.week_after - row.week_before);
      groups.set(key, g);
    }
    return [...groups.values()].map((g) => ({ ...g, points: Math.round(g.points * 10) / 10 }));
  }

  /** Recent uses, for showing what the delegation has actually done. */
  recentUses(grantId: string, limit = 20): Array<Record<string, unknown>> {
    return this.db
      .prepare(`SELECT * FROM delegation_uses WHERE grant_id = ? ORDER BY used_at DESC LIMIT ?`)
      .all(grantId, limit) as Array<Record<string, unknown>>;
  }
}

/** A percentage, or null. Never a NaN written into the record as a number. */
function num(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
