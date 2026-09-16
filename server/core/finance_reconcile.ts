/**
 * Matching a notification to the statement line that confirms it.
 *
 * A card notification email arrives within minutes of a purchase; the CSV that
 * confirms it arrives weeks later. They describe the same money, and counting
 * both doubles the month — which the register anticipated before either
 * existed (`finance_pending_confirmed_model`).
 *
 * The matching is deliberately dumb, and that is the design rather than a
 * shortcut. `finance_reconciliation` says it plainly: fixture だけで閾値を
 * 最適化しない。実データで True/False/Missed Match を測定して調整する。A
 * similarity score tuned against invented examples would look excellent here
 * and merge two different ¥1,200 purchases on a real statement — and a merged
 * pair is money that vanishes from the total, which nobody notices.
 *
 * So: the amount must be identical, the dates must be within a stated window,
 * and an ambiguous case is never resolved. Two pending rows that both match
 * one confirmed row are left alone and reported, because guessing which is
 * which has no better-than-chance basis and a wrong guess is silent.
 */

export interface Candidate {
  id: string;
  account: string;
  occurredOn: string;
  amount: number;
  description: string;
}

export interface MatchOptions {
  /**
   * How far apart the two dates may be.
   *
   * A notification carries the moment of purchase; a statement often carries
   * the date the merchant settled, which is later. Three days is a starting
   * point, not a calibrated value — and it is a parameter precisely so that
   * measuring it against real data can change it without touching this logic.
   */
  windowDays?: number;
}

export interface MatchResult {
  /** Pending row id → confirmed row id. */
  matched: Array<{ pending: string; confirmed: string }>;
  /**
   * Pending rows with more than one plausible partner, and confirmed rows
   * claimed by more than one pending row.
   *
   * Reported rather than resolved. These are the cases where a tuned matcher
   * would quietly pick one.
   */
  ambiguous: Array<{ pending: string; candidates: string[]; reason: string }>;
  /** Pending rows nothing confirmed. Still counted; still the only record. */
  unmatched: string[];
}

const DEFAULT_WINDOW_DAYS = 3;

function daysBetween(a: string, b: string): number {
  const ms = Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`));
  return Math.round(ms / 86_400_000);
}

/**
 * Pairs pending rows with the confirmed rows that supersede them.
 *
 * One-to-one throughout: a confirmed row can retire at most one pending row,
 * and a pending row is retired at most once. Two identical purchases produce
 * two pending rows and two confirmed rows, and pairing them arbitrarily is
 * correct — they are interchangeable — but pairing one confirmed row against
 * two pending rows would erase a purchase.
 */
export function reconcile(
  pending: Candidate[],
  confirmed: Candidate[],
  options: MatchOptions = {}
): MatchResult {
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;
  const matched: MatchResult['matched'] = [];
  const ambiguous: MatchResult['ambiguous'] = [];
  const unmatched: string[] = [];

  const taken = new Set<string>();

  for (const p of pending) {
    const candidates = confirmed.filter(
      (c) =>
        !taken.has(c.id) &&
        c.account === p.account &&
        c.amount === p.amount &&
        daysBetween(c.occurredOn, p.occurredOn) <= windowDays
    );

    if (candidates.length === 0) {
      unmatched.push(p.id);
      continue;
    }
    if (candidates.length > 1) {
      // Identical amounts on nearby dates are genuinely indistinguishable
      // without something this layer does not have. Choosing would be a coin
      // flip presented as a reconciliation.
      const sameAmount = candidates.every((c) => c.amount === candidates[0].amount);
      ambiguous.push({
        pending: p.id,
        candidates: candidates.map((c) => c.id),
        reason: sameAmount
          ? `同額の候補が ${candidates.length} 件あり、どれか決められません。`
          : `候補が ${candidates.length} 件あります。`,
      });
      continue;
    }

    taken.add(candidates[0].id);
    matched.push({ pending: p.id, confirmed: candidates[0].id });
  }

  return { matched, ambiguous, unmatched };
}
