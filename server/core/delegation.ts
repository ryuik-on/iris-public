/**
 * Approval granted in advance, so that asking IRIS for work is enough.
 *
 * The approval gate exists because a tool that writes should not run on a
 * model's say-so alone. That reasoning is sound and this does not weaken it:
 * `requireApprovalLevels` still decides by risk level, and no tool may declare
 * itself exempt. What changes is *when* the person approves. A dispatch that
 * stops to ask is a button, and a button pressed every time is the thing the
 * user was trying not to do.
 *
 * So the approval is given once, with limits, and spent against those limits.
 * The distinction that matters is who grants it: a tool asserting it is safe
 * is the invariant this must not break, and a person saying "you may start
 * coding agents on this repository, up to this much, until this date" is an
 * ordinary delegation with a scope.
 *
 * Every field is a bound, and every bound is checked. A grant that cannot be
 * read, has expired, names a different tool, names a different repository, has
 * run out of money, or is already at its concurrency limit does not satisfy
 * anything — the caller falls back to asking. Nothing here can turn an
 * approval that would have been requested into one that is skipped silently:
 * a satisfied grant is reported as `delegation.used`, with what remains.
 *
 * The one case with no bound to check is an inferred run. A guess may start a
 * conversation and nothing else — the same rule as `FORBIDDEN_FOR_INFERRED`,
 * repeated here because money and a subprocess are exactly what a wrong guess
 * should not be able to reach on its own.
 */

export interface DelegationGrant {
  /** One tool. Never a pattern, never a list — scope is stated, not matched. */
  tool: string;
  /** Absolute, fully-resolved repository paths. Exact matches only. */
  repos: string[];
  /** USD across every dispatch in the current day. */
  dailyUsdCap: number;
  /** How many dispatches may be running at once. */
  maxConcurrent: number;
  /**
   * ISO 8601. A grant without an end is a setting, and a setting is what
   * someone turns on in April and has forgotten by August.
   */
  expiresAt: string;
  grantedAt: string;
  /** What the person was agreeing to, kept for when they are asked again. */
  note: string | null;
}

export type DelegationRefusalCode =
  | 'none'
  | 'malformed'
  | 'inferred'
  | 'expired'
  | 'tool'
  | 'repo'
  | 'budget'
  | 'concurrent';

export type DelegationVerdict =
  | { satisfied: true; remainingUsd: number; expiresAt: string }
  | { satisfied: false; code: DelegationRefusalCode; message: string };

export interface DelegationQuery {
  grant: DelegationGrant | null;
  tool: string;
  repo: string;
  /** `'user'` or `'inferred'`, from the run that produced the tool call. */
  origin: string;
  /** USD already spent by delegated dispatches today. */
  spentTodayUsd: number;
  /** Dispatches currently running. */
  running: number;
  now: Date;
}

const no = (code: DelegationRefusalCode, message: string): DelegationVerdict => ({
  satisfied: false,
  code,
  message,
});

export function decideDelegation(query: DelegationQuery): DelegationVerdict {
  const { grant } = query;
  if (!grant) return no('none', '委任されていません。');

  /**
   * Read before anything else, because a grant that cannot be trusted to say
   * what it permits cannot be trusted to bound it either. A cap of NaN
   * compares false against every number, which is a ceiling that never fires.
   */
  if (
    typeof grant.dailyUsdCap !== 'number' ||
    !Number.isFinite(grant.dailyUsdCap) ||
    grant.dailyUsdCap <= 0 ||
    !Number.isInteger(grant.maxConcurrent) ||
    grant.maxConcurrent <= 0 ||
    !Array.isArray(grant.repos)
  ) {
    return no('malformed', '委任の内容を読めません。');
  }

  const expiry = Date.parse(grant.expiresAt);
  if (!Number.isFinite(expiry)) return no('malformed', '委任の期限を読めません。');

  // A guess may start a conversation and nothing else.
  if (query.origin !== 'user') {
    return no('inferred', '推定による実行では委任を使えません。');
  }

  if (query.now.getTime() >= expiry) {
    return no('expired', `委任は ${grant.expiresAt} に期限切れです。`);
  }

  if (grant.tool !== query.tool) {
    return no('tool', `委任されているのは ${grant.tool} で、${query.tool} ではありません。`);
  }

  if (!grant.repos.includes(query.repo)) {
    return no('repo', `${query.repo} は委任の範囲外です。`);
  }

  const spent = Number.isFinite(query.spentTodayUsd) ? Math.max(0, query.spentTodayUsd) : NaN;
  /**
   * An unreadable spend is over budget, not under it.
   *
   * The meter reports "could not read" as a first-class answer for the same
   * reason, and this is the other end of that decision: a number that failed
   * to arrive must not be treated as zero, or the ceiling stops existing at
   * exactly the moment the accounting breaks.
   */
  if (!Number.isFinite(spent)) return no('budget', '本日の使用額を読めません。');

  if (spent >= grant.dailyUsdCap) {
    return no('budget', `本日の委任枠 $${grant.dailyUsdCap} を使い切っています（$${spent.toFixed(2)}）。`);
  }

  if (!Number.isFinite(query.running) || query.running >= grant.maxConcurrent) {
    return no('concurrent', `同時実行の上限 ${grant.maxConcurrent} に達しています。`);
  }

  return {
    satisfied: true,
    remainingUsd: Math.round((grant.dailyUsdCap - spent) * 1_000_000) / 1_000_000,
    expiresAt: grant.expiresAt,
  };
}

/** The default a grant is offered with, when the person does not say otherwise. */
export function defaultGrant(tool: string, repos: string[], now: Date): DelegationGrant {
  const expires = new Date(now.getTime());
  // Thirty days. Long enough to be useful, short enough that it is re-decided
  // while the reason for granting it is still remembered.
  expires.setDate(expires.getDate() + 30);
  return {
    tool,
    repos,
    dailyUsdCap: 5,
    maxConcurrent: 1,
    expiresAt: expires.toISOString(),
    grantedAt: now.toISOString(),
    note: null,
  };
}
