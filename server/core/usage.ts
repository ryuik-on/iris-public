/**
 * Token usage and cost estimation.
 *
 * Without this, "how fast will this burn through money?" can only be answered
 * by guessing. Every provider call now reports what it actually consumed, so
 * the question becomes measurable — and so later model routing has real
 * evidence instead of stereotypes (§24: do not decide routing from public
 * benchmarks alone; IRIS's own workload is the important evidence).
 */

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** Cached input, billed at a large discount where the provider supports it. */
  cacheReadTokens?: number;
  /**
   * Cache writes at the default 5-minute TTL.
   *
   * Kept as the unqualified name because it is the common case and because
   * everything already reporting it means this.
   */
  cacheCreationTokens?: number;
  /**
   * Cache writes at the 1-hour TTL, which bill at twice base input rather than
   * 1.25x.
   *
   * A separate field because one number cannot carry two prices. Anthropic
   * reports the split (`ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens`)
   * and folding them together silently costs the more expensive one at the
   * cheaper rate — 2026-08-20, a session that wrote 771,533 tokens of 1-hour
   * cache was undercounted by $2.90 for exactly that reason, in a total the
   * spending limits are supposed to enforce.
   */
  cacheCreation1hTokens?: number;
  /** Reasoning tokens, where the provider reports them separately. */
  thinkingTokens?: number;
}

export interface ModelPrice {
  /** USD per 1M tokens. */
  inputPerMillion: number;
  outputPerMillion: number;
  /** Cached reads, where offered. */
  cacheReadPerMillion?: number;
  /**
   * Writing a cache entry costs more than plain input (1.25x at the default
   * 5-minute TTL). Costing a write as ordinary input understates the first
   * request of every conversation.
   */
  cacheWriteMultiplier?: number;
  /**
   * The same for a 1-hour TTL, which is twice base input.
   *
   * Separate from the 5-minute multiplier rather than derived from it: the two
   * are independent prices, and a long-running session can be entirely one or
   * entirely the other.
   */
  cacheWrite1hMultiplier?: number;

  /**
   * A price change that has already been announced, applied on or after `from`
   * (an ISO date, compared against today in UTC).
   *
   * The date on the table catches prices that drifted without anyone noticing.
   * It does nothing for a change whose date is already published — that one
   * arrives on schedule and reports the old number confidently until someone
   * happens to re-read the pricing page. Written down here, it applies itself.
   */
  scheduled?: Array<{ from: string; inputPerMillion: number; outputPerMillion: number }>;
}

/**
 * Prices change, and a stale price table silently produces wrong numbers
 * rather than an error — so the table carries the date it was last checked and
 * every estimate reports that date. Treat an estimate older than a few weeks
 * as indicative, and re-verify against the provider's pricing page (§47).
 */
export const PRICING_LAST_VERIFIED = '2026-08-20';

export const MODEL_PRICES: Record<string, ModelPrice> = {
  // Anthropic
  'claude-opus-5': { inputPerMillion: 5, outputPerMillion: 25, cacheReadPerMillion: 0.5 },
  'claude-opus-4-8': { inputPerMillion: 5, outputPerMillion: 25, cacheReadPerMillion: 0.5 },
  'claude-sonnet-5': { inputPerMillion: 3, outputPerMillion: 15, cacheReadPerMillion: 0.3 },
  'claude-sonnet-4-6': { inputPerMillion: 3, outputPerMillion: 15, cacheReadPerMillion: 0.3 },
  'claude-haiku-4-5': { inputPerMillion: 1, outputPerMillion: 5, cacheReadPerMillion: 0.1 },
  'claude-fable-5': { inputPerMillion: 10, outputPerMillion: 50 },

  // OpenAI. Sol / Terra / Luna are capability tiers within one generation, not
  // separate models — flagship, balanced, and cost-optimised. Terra and Luna
  // were cut on 2026-07-30 (Terra 2.50 -> 2.00, Luna 1.00 -> 0.20); these are
  // the post-cut rates, which is exactly why the table carries a date.
  'gpt-5.6-sol': { inputPerMillion: 5, outputPerMillion: 30, cacheReadPerMillion: 0.5 },
  'gpt-5.6-terra': { inputPerMillion: 2, outputPerMillion: 12, cacheReadPerMillion: 0.2 },
  'gpt-5.6-luna': { inputPerMillion: 0.2, outputPerMillion: 1.2, cacheReadPerMillion: 0.02 },

  // Google. These are the paid-tier rates, deliberately, even though the key
  // may still be on the free tier: the free tier caps at 20 requests a day and
  // then fails over, so a table of zeroes describes a state that lasts twenty
  // calls and then reports every later call as free. Over-reporting a bill
  // gets questioned; a bill of zero never does.
  //
  // Output is priced including thinking tokens, which is why the Gemini
  // provider folds them into outputTokens rather than leaving them beside it.
  'gemini-3.6-flash': {
    inputPerMillion: 0.75,
    outputPerMillion: 3.75,
    scheduled: [{ from: '2027-01-01', inputPerMillion: 1.5, outputPerMillion: 7.5 }],
  },
};

export interface CostEstimate {
  usd: number;
  model: string;
  /** False when the model is absent from the table — the number is then 0, not accurate. */
  priced: boolean;
  pricingLastVerified: string;
}

/**
 * The announced price for today, which is the base price until a scheduled one
 * has taken effect. Later dates win, so several changes can be listed in any
 * order without the last one written silently deciding the answer.
 */
function applicablePrice(price: ModelPrice, today = new Date()): ModelPrice {
  if (!price.scheduled?.length) return price;
  const iso = today.toISOString().slice(0, 10);
  let chosen: ModelPrice = price;
  let chosenFrom = '';
  for (const step of price.scheduled) {
    if (step.from > iso || step.from < chosenFrom) continue;
    chosenFrom = step.from;
    chosen = {
      ...price,
      inputPerMillion: step.inputPerMillion,
      outputPerMillion: step.outputPerMillion,
    };
  }
  return chosen;
}

export function estimateCost(model: string, usage: TokenUsage): CostEstimate {
  const table = MODEL_PRICES[model];
  if (!table) {
    return { usd: 0, model, priced: false, pricingLastVerified: PRICING_LAST_VERIFIED };
  }
  const price = applicablePrice(table);

  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheCreationTokens ?? 0;
  const cacheWrite1h = usage.cacheCreation1hTokens ?? 0;
  // Anthropic reports cache reads and writes outside `input_tokens`, so the
  // three are added rather than subtracted from one another.
  const freshInput = Math.max(0, usage.inputTokens);

  const usd =
    (freshInput / 1_000_000) * price.inputPerMillion +
    (cacheRead / 1_000_000) * (price.cacheReadPerMillion ?? price.inputPerMillion) +
    (cacheWrite / 1_000_000) * price.inputPerMillion * (price.cacheWriteMultiplier ?? 1.25) +
    (cacheWrite1h / 1_000_000) * price.inputPerMillion * (price.cacheWrite1hMultiplier ?? 2) +
    // Thinking tokens are billed as output; providers that report them
    // separately have usually already counted them in outputTokens.
    (usage.outputTokens / 1_000_000) * price.outputPerMillion;

  return {
    usd: Math.round(usd * 1_000_000) / 1_000_000,
    model,
    priced: true,
    pricingLastVerified: PRICING_LAST_VERIFIED,
  };
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0),
    cacheCreationTokens: (a.cacheCreationTokens ?? 0) + (b.cacheCreationTokens ?? 0),
    cacheCreation1hTokens: (a.cacheCreation1hTokens ?? 0) + (b.cacheCreation1hTokens ?? 0),
    thinkingTokens: (a.thinkingTokens ?? 0) + (b.thinkingTokens ?? 0),
  };
}

export const EMPTY_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0 };

/** Formats a cost for display without implying more precision than exists. */
export function formatCost(estimate: CostEstimate): string {
  if (!estimate.priced) return '不明（価格表に未登録）';
  if (estimate.usd === 0) return '$0.00';
  if (estimate.usd < 0.01) return `$${estimate.usd.toFixed(4)}`;
  return `$${estimate.usd.toFixed(2)}`;
}
