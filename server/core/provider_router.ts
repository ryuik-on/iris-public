import { AIProvider, AIProviderResponse, SystemInput } from '../providers/base.js';
import { Tool, ConversationTurn } from '../core/types.js';
import { classifyProviderError, ClassifiedProviderError, ProviderErrorKind } from './provider_errors.js';

/**
 * Routes each model call to the first provider that is currently usable.
 *
 * The reason this exists: Gemini gives a free daily allowance, and an
 * allowance that resets every day is worth nothing unless it is actually
 * spent. So the order is a cost policy — drain the free quota first, then pay.
 *
 * The whole design rests on one asymmetry. Trying an exhausted provider costs
 * a 429, which is one round trip and no money and no quota. Skipping a
 * provider that had recovered costs real money for the rest of the day. So
 * every judgement call here is biased toward trying again too early rather
 * than too late.
 *
 * The failure that would make this worse than no routing at all is a dead
 * chat: quota runs out mid-sentence and the turn dies. That is why failover is
 * automatic, why a run whose provider dies part-way continues on the next one,
 * and why "everything is in cooldown" tries anyway instead of refusing — a
 * cooldown is a guess about the future, and a guess must never be the reason a
 * user cannot talk to their assistant.
 */

const DAY_MS = 86_400_000;

/**
 * Which failures mean "ask someone else" rather than "this request is bad".
 *
 * The distinction is not severity, it is locality. A request that Gemini
 * refuses on content grounds will be refused by Anthropic too, and trying all
 * three turns one refusal into three bills. Only errors that are a property of
 * the *provider* — its quota, its credit, its keys, its capacity — say
 * anything about whether a different provider would succeed.
 *
 * Timeouts and network faults are deliberately absent. §47: a timeout is not a
 * failure, and the retry layer above already owns it. Failing over on a
 * timeout would turn one slow call into two calls that both may have been
 * charged.
 */
const FAILOVER_KINDS = new Set<ProviderErrorKind>([
  'quota_exhausted',
  'insufficient_credit',
  'rate_limit',
  'overloaded',
  'authentication',
  'invalid_key_characters',
  'missing_key',
  'model_not_found',
]);

/** Long enough to mean "not without a human"; short enough to not be forever. */
const CONFIG_FAULT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

interface CooldownPolicy {
  /** First cooldown; doubles on each consecutive failure. */
  baseMs: number;
  capMs: number;
  /** True when the clock, not the backoff, decides recovery. */
  untilDailyReset?: boolean;
}

const COOLDOWNS: Record<string, CooldownPolicy> = {
  // A daily allowance comes back at a known-ish time. Probe on a growing
  // interval in case the reset is earlier than we think, and never sit past
  // the presumed reset — the point of the whole exercise is to be back on the
  // free tier the moment it refills.
  quota_exhausted: { baseMs: 5 * 60_000, capMs: 60 * 60_000, untilDailyReset: true },
  // A top-up can land at any moment, so do not write the provider off.
  insufficient_credit: { baseMs: 10 * 60_000, capMs: 60 * 60_000 },
  // Per-minute limits recover on their own, quickly.
  rate_limit: { baseMs: 60_000, capMs: 5 * 60_000 },
  overloaded: { baseMs: 30_000, capMs: 10 * 60_000 },
  // Nothing here recovers without the user editing .env, which means a
  // restart. The cooldown exists only so a fix made out-of-band is picked up
  // eventually rather than never.
  authentication: { baseMs: CONFIG_FAULT_COOLDOWN_MS, capMs: CONFIG_FAULT_COOLDOWN_MS },
  invalid_key_characters: { baseMs: CONFIG_FAULT_COOLDOWN_MS, capMs: CONFIG_FAULT_COOLDOWN_MS },
  missing_key: { baseMs: CONFIG_FAULT_COOLDOWN_MS, capMs: CONFIG_FAULT_COOLDOWN_MS },
  model_not_found: { baseMs: CONFIG_FAULT_COOLDOWN_MS, capMs: CONFIG_FAULT_COOLDOWN_MS },
};

export type RouterEvent =
  | { type: 'router.served'; key: string; model: string; vendor: string; preferred: boolean; attempt: number }
  | {
      type: 'router.provider_unavailable';
      key: string;
      model: string;
      kind: ProviderErrorKind;
      message: string;
      retryAt: string;
      cooldownMs: number;
      consecutiveFailures: number;
    }
  | { type: 'router.recovered'; key: string; model: string; downForMs: number }
  | { type: 'router.failover'; from: string; to: string; kind: ProviderErrorKind }
  | { type: 'router.all_unavailable'; tried: string[]; forcing: string }
  | { type: 'router.budget_restricted'; remaining: string[]; excluded: string[] };

export interface RouterEntryHealth {
  key: string;
  name: string;
  vendor: string;
  model: string;
  /** Position in the preference order; 0 is tried first. */
  priority: number;
  available: boolean;
  /** Why it is not available, when it is not. */
  reason: ProviderErrorKind | null;
  message: string | null;
  retryAt: string | null;
  consecutiveFailures: number;
  lastServedAt: string | null;
  servedCount: number;
}

interface Entry {
  key: string;
  provider: AIProvider;
  unavailableUntilMs: number;
  reason: ProviderErrorKind | null;
  message: string | null;
  consecutiveFailures: number;
  markedDownAtMs: number;
  lastServedAtMs: number;
  servedCount: number;
}

export interface ProviderRouterOptions {
  /** IANA zone the daily allowance is presumed to reset in. */
  quotaResetTimeZone?: string;
  onEvent?: (event: RouterEvent) => void;
  now?: () => number;
  /**
   * Whether paid providers may still be called.
   *
   * Asked per request rather than configured, so a spending limit reached
   * mid-conversation takes effect on the next turn. Returning false narrows
   * the chain to free providers instead of refusing: running out of budget
   * should cost capability, not the ability to talk.
   */
  paidAllowed?: () => boolean;
  /** Registry keys that cost nothing. Everything else is treated as paid. */
  freeKeys?: string[];
}

export class ProviderRouter implements AIProvider {
  private entries: Entry[];
  private options: Required<Pick<ProviderRouterOptions, 'quotaResetTimeZone'>> & ProviderRouterOptions;
  /** The provider that answered most recently, for cost attribution and review independence. */
  private lastServed: Entry;

  constructor(
    ordered: Array<{ key: string; provider: AIProvider }>,
    options: ProviderRouterOptions = {}
  ) {
    if (ordered.length === 0) throw new Error('ProviderRouter は最低1つのプロバイダを必要とします。');
    this.entries = ordered.map(({ key, provider }) => ({
      key,
      provider,
      unavailableUntilMs: 0,
      reason: null,
      message: null,
      consecutiveFailures: 0,
      markedDownAtMs: 0,
      lastServedAtMs: 0,
      servedCount: 0,
    }));
    this.lastServed = this.entries[0];
    this.options = { quotaResetTimeZone: 'America/Los_Angeles', ...options };
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  /**
   * Identity reflects whoever actually answered last, not the router.
   *
   * Cost estimation, review independence and every status display read these.
   * Reporting a fictional "router" model would price the run against nothing,
   * let a reviewer be picked that shares the implementer's blind spots, and
   * tell the user their assistant is running on something that does not exist.
   */
  get id(): string {
    return this.lastServed.key;
  }

  get vendor(): string {
    return this.lastServed.provider.vendor;
  }

  get name(): string {
    return this.lastServed.provider.name;
  }

  get currentModel(): string {
    return this.lastServed.provider.currentModel;
  }

  /** Aimed at the provider that will actually be tried first. */
  setModel(modelName: string) {
    this.preferred().provider.setModel(modelName);
  }

  describeSettings(): Record<string, string | number> {
    return {
      ...(this.lastServed.provider.describeSettings?.() ?? {}),
      routedTo: this.lastServed.key,
      priority: this.entries.map((e) => e.key).join(' > '),
    };
  }

  /** The first provider in the order, available or not. */
  preferred(): Entry {
    return this.available()[0] ?? this.entries[0];
  }

  /** True when this provider bills for use. */
  private isPaid(key: string): boolean {
    const free = this.options.freeKeys ?? ['gemini'];
    return !free.includes(key);
  }

  private available(): Entry[] {
    const now = this.now();
    return this.entries.filter((e) => {
      if (e.unavailableUntilMs <= now) {
        if (e.reason !== null) {
          this.options.onEvent?.({
            type: 'router.recovered',
            key: e.key,
            model: e.provider.currentModel,
            downForMs: now - e.markedDownAtMs,
          });
          e.reason = null;
          e.message = null;
        }
        return true;
      }
      return false;
    });
  }

  async generateResponse(
    messages: ConversationTurn[],
    tools: Tool[],
    systemInstruction: SystemInput,
    signal?: AbortSignal,
    /**
     * Forwarded, because this class is what the orchestrator holds.
     *
     * Dropping it here silently disabled streaming everywhere while every
     * individual piece looked correct — the provider implemented it, the
     * orchestrator passed it, and the router in between accepted four
     * arguments and called with four. The failure was invisible in each file
     * and only showed up as a reply that arrived all at once.
     */
    onDelta?: (text: string) => void
  ): Promise<AIProviderResponse> {
    let candidates = this.available();
    let forced = false;

    // A spending limit narrows the chain rather than ending the turn. If only
    // free providers remain, the assistant is less capable and still present,
    // which is the right way round.
    if (this.options.paidAllowed && !this.options.paidAllowed()) {
      const free = candidates.filter((e) => !this.isPaid(e.key));
      if (free.length !== candidates.length) {
        this.options.onEvent?.({
          type: 'router.budget_restricted',
          remaining: free.map((e) => e.key),
          excluded: candidates.filter((e) => this.isPaid(e.key)).map((e) => e.key),
        });
      }
      candidates = free;
    }

    if (candidates.length === 0 && this.options.paidAllowed && !this.options.paidAllowed()) {
      // Distinguished from an outage on purpose: "we hit the spending limit"
      // and "the providers are down" call for completely different actions.
      throw new Error(
        '支出上限に達しており、無料で使えるプロバイダがありません。' +
          '上限を引き上げるか、翌日の無料枠を待ってください。'
      );
    }

    if (candidates.length === 0) {
      // Every cooldown is an estimate about a future we cannot see. Refusing
      // the turn because all the estimates are pessimistic would let a wrong
      // guess silence the assistant, so try the one that should recover first.
      const soonest = [...this.entries].sort((a, b) => a.unavailableUntilMs - b.unavailableUntilMs)[0];
      this.options.onEvent?.({
        type: 'router.all_unavailable',
        tried: this.entries.map((e) => e.key),
        forcing: soonest.key,
      });
      candidates = [soonest];
      forced = true;
    }

    const preferredKey = candidates[0].key;
    let lastError: any;

    for (let attempt = 0; attempt < candidates.length; attempt++) {
      const entry = candidates[attempt];
      try {
        const response = await entry.provider.generateResponse(messages, tools, systemInstruction, signal, onDelta);
        const now = this.now();
        entry.consecutiveFailures = 0;
        entry.lastServedAtMs = now;
        entry.servedCount++;
        this.lastServed = entry;
        this.options.onEvent?.({
          type: 'router.served',
          key: entry.key,
          model: entry.provider.currentModel,
          vendor: entry.provider.vendor,
          preferred: entry.key === this.entries[0].key,
          attempt: attempt + 1,
        });
        return {
          ...response,
          servedBy: entry.key,
          servedModel: entry.provider.currentModel,
        };
      } catch (err: any) {
        // A cancelled run must not fan out across providers: the caller has
        // stopped caring, and every extra attempt is billable.
        if (signal?.aborted) throw err;

        const classified = classifyProviderError(err);
        if (!FAILOVER_KINDS.has(classified.kind)) throw err;

        // A forced attempt is a probe against a cooldown we already set; it
        // failing is expected and must not extend the backoff further.
        if (!forced) this.markUnavailable(entry, classified);
        lastError = err;

        const next = candidates[attempt + 1];
        if (next) {
          this.options.onEvent?.({
            type: 'router.failover',
            from: entry.key,
            to: next.key,
            kind: classified.kind,
          });
        }
      }
    }

    // Nothing worked. The last error is the honest one to surface: it came
    // from the provider we had the least reason to doubt.
    void preferredKey;
    throw lastError;
  }

  private markUnavailable(entry: Entry, classified: ClassifiedProviderError) {
    const now = this.now();
    const policy = COOLDOWNS[classified.kind] ?? { baseMs: 60_000, capMs: 10 * 60_000 };
    entry.consecutiveFailures++;

    const backoff = Math.min(policy.capMs, policy.baseMs * 2 ** (entry.consecutiveFailures - 1));
    let until = now + backoff;
    if (policy.untilDailyReset) {
      // Never wait past the refill, and never wait longer than the backoff.
      // Whichever comes first is the earliest moment it could plausibly work.
      until = Math.min(until, nextDailyReset(now, this.options.quotaResetTimeZone));
    }

    entry.unavailableUntilMs = until;
    entry.reason = classified.kind;
    entry.message = classified.message;
    entry.markedDownAtMs = now;

    this.options.onEvent?.({
      type: 'router.provider_unavailable',
      key: entry.key,
      model: entry.provider.currentModel,
      kind: classified.kind,
      message: classified.message,
      retryAt: new Date(until).toISOString(),
      cooldownMs: until - now,
      consecutiveFailures: entry.consecutiveFailures,
    });
  }

  /** What the user sees when they ask why they are being billed today. */
  health(): RouterEntryHealth[] {
    const now = this.now();
    return this.entries.map((e, priority) => ({
      key: e.key,
      name: e.provider.name,
      vendor: e.provider.vendor,
      model: e.provider.currentModel,
      priority,
      available: e.unavailableUntilMs <= now,
      reason: e.unavailableUntilMs <= now ? null : e.reason,
      message: e.unavailableUntilMs <= now ? null : e.message,
      retryAt: e.unavailableUntilMs <= now ? null : new Date(e.unavailableUntilMs).toISOString(),
      consecutiveFailures: e.consecutiveFailures,
      lastServedAt: e.lastServedAtMs ? new Date(e.lastServedAtMs).toISOString() : null,
      servedCount: e.servedCount,
    }));
  }

  /**
   * Clears a cooldown, for a user who has just fixed the underlying problem
   * and does not want to wait out an estimate made before the fix.
   */
  reset(key?: string): number {
    let cleared = 0;
    for (const entry of this.entries) {
      if (key && entry.key !== key) continue;
      if (entry.unavailableUntilMs === 0 && entry.consecutiveFailures === 0) continue;
      entry.unavailableUntilMs = 0;
      entry.reason = null;
      entry.message = null;
      entry.consecutiveFailures = 0;
      cleared++;
    }
    return cleared;
  }

  keys(): string[] {
    return this.entries.map((e) => e.key);
  }

  /**
   * The registry key of whoever answered most recently.
   *
   * Independent review needs this: with routing, "the model that did the work"
   * is a fact about the run, not a startup setting, and a reviewer chosen
   * against the wrong implementer shares the blind spots it exists to catch.
   */
  lastServedKey(): string {
    return this.lastServed.key;
  }
}

/**
 * When the next daily allowance is presumed to refill, in epoch ms.
 *
 * Google resets the free tier at midnight Pacific, so that is the default
 * zone. Around a DST change this is an hour out. That is tolerable in exactly
 * one direction: an hour early costs one wasted 429, an hour late costs an
 * hour of paid tokens — and the probe backoff covers the late case anyway.
 */
export function nextDailyReset(nowMs: number, timeZone: string): number {
  const offset = zoneOffsetMs(nowMs, timeZone);
  const localMs = nowMs + offset;
  const sinceMidnight = ((localMs % DAY_MS) + DAY_MS) % DAY_MS;
  return nowMs + (DAY_MS - sinceMidnight);
}

function zoneOffsetMs(epochMs: number, timeZone: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(epochMs));

    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    const asIfUtc = Date.UTC(
      get('year'),
      get('month') - 1,
      get('day'),
      get('hour') % 24,
      get('minute'),
      get('second')
    );
    return asIfUtc - epochMs;
  } catch {
    // An unknown zone must not break routing; UTC midnight is a poor guess but
    // a working one, and the backoff probe still recovers the quota.
    return 0;
  }
}

/**
 * Reads the preference order from configuration.
 *
 * The default puts a free allowance ahead of a paid one, which is the whole
 * point. An explicit IRIS_PROVIDER_PRIORITY overrides it; names that are not
 * configured are dropped rather than treated as an error, so removing a key
 * from .env does not also require editing the order.
 */
export function resolvePriority(
  configured: Record<string, AIProvider>,
  raw: string | undefined,
  defaultOrder: string[] = ['gemini', 'anthropic', 'openai']
): Array<{ key: string; provider: AIProvider }> {
  const requested = (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const order = requested.length > 0 ? requested : defaultOrder;
  const seen = new Set<string>();
  const result: Array<{ key: string; provider: AIProvider }> = [];

  for (const key of order) {
    if (seen.has(key) || !configured[key]) continue;
    seen.add(key);
    result.push({ key, provider: configured[key] });
  }

  // Anything configured but unnamed still belongs in the chain — a provider
  // the user set up should not be silently unreachable because the order
  // predates it. It goes last, since the order expresses the preference.
  for (const [key, provider] of Object.entries(configured)) {
    if (seen.has(key)) continue;
    // A second instance of the primary vendor exists for review independence,
    // not for serving chat, and routing to it would double the bill quietly.
    if (key.endsWith('-review')) continue;
    seen.add(key);
    result.push({ key, provider });
  }

  return result;
}
