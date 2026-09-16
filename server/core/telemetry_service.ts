import Database from 'better-sqlite3';

/**
 * What each model has actually done, and whether there is enough of it to say.
 *
 * The question this exists to answer is not "what did we spend" — usage
 * already answers that — but "was the cheaper model enough". That is a
 * question about outcomes, so cost is reported per *completed* task rather
 * than per call: a model at half the price that needs three attempts is not
 * cheaper.
 *
 * Nothing new is written. Every number here is read from records the system
 * already keeps — agent_runs for outcomes, activity_logs for usage — because
 * a second capture path is a second thing that can disagree with the first.
 *
 * The part that matters most is the refusal. With two attempts, a 50% success
 * rate is noise, and a table presenting it next to a model with forty attempts
 * invites a decision the data cannot support. So every row carries how much
 * evidence is behind it, and comparisons decline to rank when either side is
 * too thin. The same discipline the context layer applies to sensors: a number
 * that cannot be trusted as a probability must not be presented as one.
 */

export type EvidenceLevel = 'insufficient' | 'indicative' | 'reliable';

/** Below this, a rate is noise. Above the second, it starts to mean something. */
const INDICATIVE_AT = 5;
const RELIABLE_AT = 20;

export interface ModelPerformance {
  /** As recorded on the run: registry key and model, e.g. `openai:gpt-5.6-terra`. */
  agent: string;
  model: string;
  role: string;
  attempts: number;
  succeeded: number;
  failed: number;
  /** Null rather than 0 when nothing has finished — no data is not failure. */
  successRate: number | null;
  medianDurationMs: number | null;
  /** From run.usage, matched on model. Null when no usage was recorded. */
  usd: number | null;
  /** The number that answers "was the cheaper one enough". */
  usdPerSuccess: number | null;
  evidence: EvidenceLevel;
  note: string;
}

export interface Comparison {
  a: string;
  b: string;
  /** Null when the evidence cannot support a ranking. */
  better: string | null;
  reason: string;
}

export class TelemetryService {
  constructor(private db: Database.Database) {}

  /**
   * Per model and role. Roles are kept apart because reviewing and
   * implementing are different jobs, and a model good at one is not thereby
   * good at the other.
   */
  performance(options: { sinceIso?: string; role?: string } = {}): ModelPerformance[] {
    const clauses: string[] = [];
    const params: Array<string> = [];
    if (options.sinceIso) {
      clauses.push('created_at >= ?');
      params.push(options.sinceIso);
    }
    if (options.role) {
      clauses.push('role = ?');
      params.push(options.role);
    }
    // Runs still in flight are excluded: counting a pending run as a failure
    // would punish a model for being slow to finish rather than wrong.
    clauses.push("status IN ('succeeded','failed','cancelled','blocked')");
    const where = `WHERE ${clauses.join(' AND ')}`;

    const rows = this.db
      .prepare(`SELECT agent, role, status, started_at, ended_at FROM agent_runs ${where}`)
      .all(...params) as any[];

    /*
     * 委任した実行も数える。**`agent_runs` には入っていない。**
     *
     * あの表を書くのは開発タスクに紐づいた実行と独立レビューだけで、
     * `codex exec` や `claude` を起こす本当の委任は一行も書かない。実測
     * 2026-09-08: `agent_runs` は8行、全部 8月18日の2時間ぶん。それ以降も
     * 委任は動いていたのに、ここは「どのモデルも判断できるだけの試行が
     * ない」と言い続けていた —— **足りないのではなく、数えていなかった。**
     *
     * 役は `delegate`。実装でもレビューでもない別の仕事として分ける ——
     * 一つの模型が委任で強くてもレビューで強いとは限らない、という
     * この関数の前提そのもの。
     *
     * 終わり方の対応: `completed` だけを成功とする。枠切れも人が止めたのも
     * **模型の出来ではない**ので、失敗に数えると使った回数の多い模型が
     * 不当に沈む。数えずに落とす。
     */
    if (!options.role || options.role === 'delegate') {
      const delegated = this.db
        .prepare(
          `SELECT agent, model, stop_reason, started_at, ended_at
             FROM delegated_runs
            WHERE state = 'stopped'${options.sinceIso ? ' AND started_at >= ?' : ''}`
        )
        .all(...(options.sinceIso ? [options.sinceIso] : [])) as any[];
      for (const d of delegated) {
        if (d.stop_reason !== 'completed' && d.stop_reason !== 'failed') continue;
        rows.push({
          agent: d.model ? `${d.agent}:${d.model}` : d.agent,
          role: 'delegate',
          status: d.stop_reason === 'completed' ? 'succeeded' : 'failed',
          started_at: d.started_at,
          ended_at: d.ended_at,
        });
      }
    }

    const usage = this.usageByModel(options.sinceIso);
    const grouped = new Map<string, { agent: string; role: string; rows: any[] }>();

    for (const row of rows) {
      const key = `${row.agent} ${row.role}`;
      const entry = grouped.get(key) ?? { agent: row.agent, role: row.role, rows: [] as any[] };
      entry.rows.push(row);
      grouped.set(key, entry);
    }

    const result: ModelPerformance[] = [];
    for (const { agent, role, rows: runs } of grouped.values()) {
      const attempts = runs.length;
      const succeeded = runs.filter((r) => r.status === 'succeeded').length;
      const failed = runs.filter((r) => r.status === 'failed').length;
      const model = modelFromAgent(agent);
      const usd = usage.get(model) ?? null;

      const durations = runs
        .map((r) => durationMs(r.started_at, r.ended_at))
        .filter((d): d is number => d !== null)
        .sort((a, b) => a - b);

      const evidence: EvidenceLevel =
        attempts >= RELIABLE_AT ? 'reliable' : attempts >= INDICATIVE_AT ? 'indicative' : 'insufficient';

      result.push({
        agent,
        model,
        role,
        attempts,
        succeeded,
        failed,
        successRate: attempts > 0 ? succeeded / attempts : null,
        medianDurationMs: durations.length > 0 ? durations[Math.floor(durations.length / 2)] : null,
        usd,
        // Only meaningful once something has succeeded; dividing by zero
        // successes would report an infinite cost for a model that has simply
        // not finished anything yet.
        usdPerSuccess: usd !== null && succeeded > 0 ? usd / succeeded : null,
        evidence,
        note:
          evidence === 'insufficient'
            ? `試行 ${attempts} 件では成績を判断できません（${INDICATIVE_AT} 件以上で参考値）。`
            : evidence === 'indicative'
              ? `参考値です（${RELIABLE_AT} 件以上で安定）。`
              : '十分な試行数があります。',
      });
    }

    // Most-evidenced first: the rows worth acting on should not be buried
    // under rows that cannot support a decision.
    const rank = { reliable: 0, indicative: 1, insufficient: 2 };
    return result.sort((a, b) => rank[a.evidence] - rank[b.evidence] || b.attempts - a.attempts);
  }

  /**
   * Cost per model from the usage log.
   *
   * Read from activity_logs rather than recomputed, so this agrees with what
   * the cost view already reports instead of becoming a second opinion.
   */
  private usageByModel(sinceIso?: string): Map<string, number> {
    const rows = this.db
      .prepare(
        `SELECT detail_json FROM activity_logs
          WHERE event = 'run.usage'${sinceIso ? ' AND created_at >= ?' : ''}`
      )
      .all(...(sinceIso ? [sinceIso] : ([] as string[]))) as any[];

    const totals = new Map<string, number>();
    for (const row of rows) {
      try {
        const detail = JSON.parse(row.detail_json);
        if (!detail?.model || typeof detail.usd !== 'number') continue;
        totals.set(detail.model, (totals.get(detail.model) ?? 0) + detail.usd);
      } catch {
        /* a corrupt log line must not break the whole report */
      }
    }
    return totals;
  }

  /**
   * Ranks two models, or declines to.
   *
   * Declining is the point. A comparison between two thin samples reads as an
   * answer, and the reader has no way to see that it was not one.
   */
  compare(agentA: string, agentB: string, role?: string): Comparison {
    const rows = this.performance({ role });
    const a = rows.find((r) => r.agent === agentA);
    const b = rows.find((r) => r.agent === agentB);

    if (!a || !b) {
      return { a: agentA, b: agentB, better: null, reason: '両方の実績が記録されていません。' };
    }
    if (a.evidence === 'insufficient' || b.evidence === 'insufficient') {
      return {
        a: agentA,
        b: agentB,
        better: null,
        reason:
          `試行数が不足しています（${agentA}: ${a.attempts}件, ${agentB}: ${b.attempts}件）。` +
          `${INDICATIVE_AT} 件以上ずつ必要です。`,
      };
    }

    const gap = (a.successRate ?? 0) - (b.successRate ?? 0);
    // A difference smaller than one run's worth of movement is not a
    // difference. With ten attempts, one flip is ten points.
    const smallestMeaningful = 1 / Math.min(a.attempts, b.attempts);
    if (Math.abs(gap) < smallestMeaningful) {
      return {
        a: agentA,
        b: agentB,
        better: null,
        reason: `成功率の差（${(gap * 100).toFixed(0)}pt）が、試行1件ぶんの変動より小さいため判断できません。`,
      };
    }

    const winner = gap > 0 ? agentA : agentB;
    return {
      a: agentA,
      b: agentB,
      better: winner,
      reason:
        `${winner} の成功率が高い（${((a.successRate ?? 0) * 100).toFixed(0)}% vs ` +
        `${((b.successRate ?? 0) * 100).toFixed(0)}%、試行 ${a.attempts}/${b.attempts} 件）。`,
    };
  }

  /** A summary that says what it does not know. */
  summary(options: { sinceIso?: string } = {}) {
    const rows = this.performance(options);
    const usable = rows.filter((r) => r.evidence !== 'insufficient');
    return {
      models: rows,
      totalRuns: rows.reduce((sum, r) => sum + r.attempts, 0),
      /** How many rows support a decision at all. Often zero, and that is fine. */
      decidable: usable.length,
      note:
        usable.length === 0
          ? `まだどのモデルについても判断できるだけの試行がありません（各 ${INDICATIVE_AT} 件以上必要）。` +
            '数字は記録されていますが、比較には使わないでください。'
          : `${usable.length} 件のモデル×役割で参考値以上の試行数があります。`,
    };
  }
}

function modelFromAgent(agent: string): string {
  // Recorded as `registryKey:model`; the model is what usage is keyed on.
  const index = agent.indexOf(':');
  return index === -1 ? agent : agent.slice(index + 1);
}

function durationMs(startedAt: string | null, endedAt: string | null): number | null {
  if (!startedAt || !endedAt) return null;
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return end - start;
}
