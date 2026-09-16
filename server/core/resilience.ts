/**
 * Timeouts, retries and run deadlines.
 *
 * The governing rule (handoff §47) is that **a timeout is not a failure**. When
 * a call that may have side effects times out, IRIS does not know whether the
 * effect happened. Reporting that as "failed" would be a false report, and
 * retrying it would risk performing the action twice.
 *
 * So this module separates two things that are easy to conflate:
 *   - `TimeoutError.sideEffectUnknown === false` — nothing happened, safe to retry
 *     (a text generation request, a read);
 *   - `TimeoutError.sideEffectUnknown === true`  — outcome genuinely unknown, must
 *     never be retried automatically, and must be reported as unknown.
 *
 * Honest limitation: `withTimeout` stops *waiting*; it can only truly *cancel*
 * work that cooperates with the AbortSignal it is handed. HTTP calls do. An
 * arbitrary tool may not — which is precisely why a timed-out risky tool is
 * marked side-effect-unknown rather than failed.
 */

export class TimeoutError extends Error {
  readonly name = 'TimeoutError';
  constructor(
    public readonly label: string,
    public readonly timeoutMs: number,
    public readonly sideEffectUnknown: boolean
  ) {
    super(
      sideEffectUnknown
        ? `${label}が${timeoutMs}msで応答しませんでした。実行されたかどうかは不明です。`
        : `${label}が${timeoutMs}msでタイムアウトしました。`
    );
  }
}

export class DeadlineExceededError extends Error {
  readonly name = 'DeadlineExceededError';
  constructor(public readonly label: string, public readonly budgetMs: number) {
    super(`${label}が全体の時間予算${budgetMs}msを超過しました。`);
  }
}

export interface WithTimeoutOptions {
  ms: number;
  label: string;
  /**
   * Whether a timeout leaves the outside world in an unknown state.
   * False only for genuinely side-effect-free work.
   */
  sideEffectUnknown?: boolean;
  /** Caller-supplied signal (e.g. a run deadline) combined with the timeout. */
  signal?: AbortSignal;
}

/**
 * Runs `fn`, handing it an AbortSignal so cooperative work is actually
 * cancelled rather than merely abandoned.
 */
export async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  options: WithTimeoutOptions
): Promise<T> {
  const { ms, label, sideEffectUnknown = true, signal: outerSignal } = options;
  const controller = new AbortController();

  const onOuterAbort = () => controller.abort();
  if (outerSignal) {
    if (outerSignal.aborted) controller.abort();
    else outerSignal.addEventListener('abort', onOuterAbort, { once: true });
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, ms);

  try {
    return await Promise.race([
      fn(controller.signal),
      new Promise<never>((_, reject) => {
        const onAbort = () => {
          if (timedOut) reject(new TimeoutError(label, ms, sideEffectUnknown));
        };
        if (controller.signal.aborted) onAbort();
        else controller.signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } catch (err: any) {
    // An SDK that honours the signal typically throws its own abort error;
    // translate it so callers see one consistent timeout type.
    if (timedOut && !(err instanceof TimeoutError)) {
      throw new TimeoutError(label, ms, sideEffectUnknown);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    outerSignal?.removeEventListener('abort', onOuterAbort);
  }
}

export interface RetryEvent {
  attempt: number;
  attempts: number;
  delayMs: number;
  error: any;
  label: string;
}

export interface RetryOptions {
  attempts: number;
  label: string;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Defaults to retrying only errors that are explicitly safe to repeat. */
  isRetryable?: (err: any) => boolean;
  onRetry?: (event: RetryEvent) => void;
  signal?: AbortSignal;
}

/**
 * Conservative by default: an error is retried only when it is known to be
 * safe. Anything whose side effect is unknown is never retried, and neither is
 * a client error, which would just fail again.
 */
export function defaultIsRetryable(err: any): boolean {
  if (err instanceof TimeoutError) return !err.sideEffectUnknown;
  if (err instanceof DeadlineExceededError) return false;

  // A safety refusal is a content outcome, not a transient fault. Repeating the
  // identical request just gets refused again.
  if (err?.refusal === true) return false;

  // SDK errors expose a typed status; prefer it over reading the message text.
  // A daily quota is exhausted, not transient — retrying burns the budget and
  // delays the honest failure. Per-minute rate limits are worth retrying.
  if (typeof err?.status === 'number' && err.status === 429) {
    const body = JSON.stringify(err?.error ?? err?.message ?? '');
    if (/PerDay|per_day|daily/i.test(body)) return false;
    return true;
  }

  const status = err?.status ?? err?.statusCode;
  if (typeof status === 'number') {
    if (status === 408 || status === 429) return true;
    return status >= 500 && status < 600;
  }

  const message = String(err?.message ?? '');
  if (/\b(429|500|502|503|504)\b/.test(message)) return true;
  if (/rate.?limit|overloaded|unavailable|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed/i.test(message)) {
    return true;
  }
  return false;
}

export async function retry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions): Promise<T> {
  const {
    attempts,
    label,
    baseDelayMs = 500,
    maxDelayMs = 8000,
    isRetryable = defaultIsRetryable,
    onRetry,
    signal,
  } = options;

  let lastError: any;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err: any) {
      lastError = err;
      const isLast = attempt >= attempts;
      if (isLast || !isRetryable(err) || signal?.aborted) throw err;

      // Exponential backoff with jitter, so repeated failures do not
      // synchronise into a burst against an already struggling API.
      const exponential = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      const delayMs = Math.round(exponential * (0.5 + Math.random() * 0.5));
      onRetry?.({ attempt, attempts, delayMs, error: err, label });
      await sleep(delayMs, signal);
    }
  }
  throw lastError;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}

/**
 * Wall-clock budget for a whole orchestrator run.
 *
 * Per-step timeouts alone cannot bound a run: enough steps that each finish
 * just under their limit still add up to an unbounded wait. The deadline is
 * checked between steps and exposed as a signal so an in-flight call is
 * cancelled when the budget runs out.
 */
export class Deadline {
  private readonly controller = new AbortController();
  private readonly timer: NodeJS.Timeout;
  readonly startedAt = Date.now();

  constructor(readonly budgetMs: number, readonly label = 'run') {
    this.timer = setTimeout(() => this.controller.abort(), budgetMs);
    this.timer.unref?.();
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get elapsedMs(): number {
    return Date.now() - this.startedAt;
  }

  get remainingMs(): number {
    return Math.max(0, this.budgetMs - this.elapsedMs);
  }

  get expired(): boolean {
    return this.remainingMs <= 0;
  }

  /** Caps a per-step timeout so no single step can outlive the run budget. */
  clamp(stepMs: number): number {
    return Math.max(1, Math.min(stepMs, this.remainingMs));
  }

  assertAlive() {
    if (this.expired) throw new DeadlineExceededError(this.label, this.budgetMs);
  }

  dispose() {
    clearTimeout(this.timer);
  }
}
