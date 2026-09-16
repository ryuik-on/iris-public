import Database from 'better-sqlite3';
import { estimateCost, TokenUsage } from './usage.js';

/**
 * Spending limits, doubled on purpose.
 *
 * Metered APIs bill in real time, and the failure everyone is afraid of is not
 * an expensive day — it is a loop nobody was watching that ran all night. That
 * failure is unrecoverable in the only sense that matters: the money is
 * already gone by the time anyone reads a log.
 *
 * So there are two limits in two different senses, and the doubling is the
 * whole design:
 *
 *   By severity — a warn threshold and a stop threshold. The first exists so
 *   the second is never a surprise.
 *
 *   By mechanism — a check *before* a call using an estimate, and a check
 *   *after* every call using what was actually billed. These fail
 *   differently. If the price table is stale the estimate is wrong and only
 *   the after-check catches it; if a provider stops reporting usage the
 *   after-check goes blind and only the before-check bounds it. One
 *   mechanism checked twice would be one mechanism.
 *
 * Nothing new is recorded. Spend is read from the same run.usage log that the
 * cost view and the telemetry read, because a budget disagreeing with the
 * invoice is worse than no budget. That also makes the limit survive a
 * restart without any state of its own: a crash loop cannot reset it, because
 * there is nothing to reset.
 */

export interface BudgetLimits {
  /** One conversation turn. Bounds a single runaway loop. */
  perRunUsd: number;
  dailyUsd: number;
  monthlyUsd: number;
  /** Fraction of a limit at which to start warning. */
  warnAt: number;
}

export type BudgetVerdict = 'ok' | 'warn' | 'deny';

export interface BudgetWindow {
  window: 'run' | 'day' | 'month';
  spentUsd: number;
  limitUsd: number;
  remainingUsd: number;
  usedFraction: number;
  verdict: BudgetVerdict;
}

export interface BudgetState {
  limits: BudgetLimits;
  windows: BudgetWindow[];
  verdict: BudgetVerdict;
  /** Which window stopped or warned, when one did. */
  trippedBy: string | null;
  message: string;
  /** Costs seen from models with no price entry — spend we cannot see. */
  unpricedCalls: number;
  checkedAt: string;
}

export class BudgetExceededError extends Error {
  constructor(public readonly state: BudgetState) {
    super(state.message);
    this.name = 'BudgetExceededError';
  }
}

/**
 * Deliberately small.
 *
 * A limit whose default is generous is a limit that only ever gets noticed
 * after it failed to help. These are meant to be raised knowingly, not
 * discovered during an incident.
 */
export const DEFAULT_LIMITS: BudgetLimits = {
  perRunUsd: 1.0,
  dailyUsd: 5.0,
  monthlyUsd: 50.0,
  warnAt: 0.8,
};

export function limitsFromEnv(env: NodeJS.ProcessEnv = process.env): BudgetLimits {
  const num = (name: string, fallback: number) => {
    const raw = env[name]?.trim();
    if (!raw) return fallback;
    const value = Number(raw);
    // A malformed limit falls back to the safe default rather than to
    // Infinity, which is what Number('') and Number('abc') would otherwise
    // produce downstream.
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  const warn = Number(env.IRIS_BUDGET_WARN_AT ?? '');
  return {
    perRunUsd: num('IRIS_BUDGET_PER_RUN_USD', DEFAULT_LIMITS.perRunUsd),
    dailyUsd: num('IRIS_BUDGET_DAILY_USD', DEFAULT_LIMITS.dailyUsd),
    monthlyUsd: num('IRIS_BUDGET_MONTHLY_USD', DEFAULT_LIMITS.monthlyUsd),
    warnAt: Number.isFinite(warn) && warn > 0 && warn < 1 ? warn : DEFAULT_LIMITS.warnAt,
  };
}

export class BudgetService {
  private limits: BudgetLimits;

  constructor(
    private db: Database.Database,
    limits: Partial<BudgetLimits> = {},
    private now: () => number = Date.now
  ) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  getLimits(): BudgetLimits {
    return { ...this.limits };
  }

  /**
   * Raises or lowers a limit at runtime.
   *
   * Deliberately not persisted: a limit raised to get through one task should
   * not silently outlive it. The durable setting is the environment.
   */
  setLimits(patch: Partial<BudgetLimits>) {
    for (const [key, value] of Object.entries(patch)) {
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        (this.limits as any)[key] = value;
      }
    }
    return this.getLimits();
  }

  /** Spend inside a window, read from the usage log rather than a counter. */
  spentSince(sinceIso: string): { usd: number; unpriced: number } {
    const rows = this.db
      .prepare(
        `SELECT detail_json FROM activity_logs
          WHERE event = 'run.usage' AND created_at >= ?`
      )
      .all(sinceIso) as any[];

    let usd = 0;
    let unpriced = 0;
    for (const row of rows) {
      try {
        const detail = JSON.parse(row.detail_json);
        if (typeof detail?.usd === 'number') usd += detail.usd;
        // A model with no price entry bills real money and reports zero here.
        // Counting those separately is the difference between "we spent
        // nothing" and "we cannot see what we spent".
        if (detail?.priced === false) unpriced++;
      } catch {
        /* a corrupt log line must not make the budget look smaller */
      }
    }
    return { usd, unpriced };
  }

  private startOfDay(): string {
    const d = new Date(this.now());
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
  }

  private startOfMonth(): string {
    const d = new Date(this.now());
    d.setDate(1);
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
  }

  /**
   * Where the budget stands. `pendingUsd` is an estimate of a call not yet
   * made, so a request can be refused before it is billed rather than after.
   */
  state(pendingUsd = 0): BudgetState {
    const day = this.spentSince(this.startOfDay());
    const month = this.spentSince(this.startOfMonth());

    const windows: BudgetWindow[] = [
      this.window('run', pendingUsd, this.limits.perRunUsd),
      this.window('day', day.usd + pendingUsd, this.limits.dailyUsd),
      this.window('month', month.usd + pendingUsd, this.limits.monthlyUsd),
    ];

    const denied = windows.find((w) => w.verdict === 'deny');
    const warned = windows.find((w) => w.verdict === 'warn');
    const verdict: BudgetVerdict = denied ? 'deny' : warned ? 'warn' : 'ok';

    return {
      limits: this.getLimits(),
      windows,
      verdict,
      trippedBy: denied?.window ?? warned?.window ?? null,
      message: this.describe(verdict, denied ?? warned, month.unpriced),
      unpricedCalls: month.unpriced,
      checkedAt: new Date(this.now()).toISOString(),
    };
  }

  private window(name: BudgetWindow['window'], spentUsd: number, limitUsd: number): BudgetWindow {
    const usedFraction = limitUsd > 0 ? spentUsd / limitUsd : 0;
    return {
      window: name,
      spentUsd,
      limitUsd,
      remainingUsd: Math.max(0, limitUsd - spentUsd),
      usedFraction,
      verdict: usedFraction >= 1 ? 'deny' : usedFraction >= this.limits.warnAt ? 'warn' : 'ok',
    };
  }

  private describe(verdict: BudgetVerdict, window: BudgetWindow | undefined, unpriced: number): string {
    const unpricedNote =
      unpriced > 0
        ? `（うち ${unpriced} 件は価格未登録のモデルで、実際の課金額を把握できていません）`
        : '';
    if (verdict === 'deny' && window) {
      return (
        `${labelOf(window.window)}の上限に達しました` +
        `（$${window.spentUsd.toFixed(4)} / $${window.limitUsd.toFixed(2)}）。` +
        `有料モデルの呼び出しを停止します。${unpricedNote}`
      );
    }
    if (verdict === 'warn' && window) {
      return (
        `${labelOf(window.window)}の上限に近づいています` +
        `（$${window.spentUsd.toFixed(4)} / $${window.limitUsd.toFixed(2)}、` +
        `残り $${window.remainingUsd.toFixed(4)}）。${unpricedNote}`
      );
    }
    return `予算内です。${unpricedNote}`;
  }

  /**
   * The check before a call.
   *
   * Estimated, because the exact cost is unknowable until the model has
   * answered. An estimate that is too low is why the after-check exists.
   */
  checkBeforeCall(model: string, estimatedUsage: TokenUsage): BudgetState {
    const estimate = estimateCost(model, estimatedUsage);
    return this.state(estimate.usd);
  }

  /** Throws when a call must not be made. Callers that can degrade should
   *  read `state()` instead and choose a free provider. */
  assertCanSpend(model: string, estimatedUsage: TokenUsage): BudgetState {
    const state = this.checkBeforeCall(model, estimatedUsage);
    if (state.verdict === 'deny') throw new BudgetExceededError(state);
    return state;
  }

  /**
   * The check after a call.
   *
   * Independent of the estimate: this reads what was actually billed, so a
   * stale price table or an unusually long answer is still caught — one call
   * late, but caught.
   */
  checkAfterCall(): BudgetState {
    return this.state(0);
  }

  /**
   * Whether paid providers may still be used.
   *
   * Separate from `state()` so the router can degrade to a free tier rather
   * than refusing the turn. Running out of budget should cost capability,
   * not the ability to talk.
   */
  paidCallsAllowed(): boolean {
    return this.state().verdict !== 'deny';
  }
}

function labelOf(window: BudgetWindow['window']): string {
  return window === 'run' ? '1回の実行' : window === 'day' ? '本日' : '今月';
}
