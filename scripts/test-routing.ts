/**
 * Provider routing tests.
 *
 * The policy under test is a cost policy: spend the free daily allowance
 * first, then pay. Two ways it could go wrong, and both are worse than not
 * routing at all —
 *
 *   1. The chat dies. Quota runs out mid-sentence and the turn fails instead
 *      of continuing somewhere else.
 *   2. The free tier is skipped. A cooldown outlives the thing it was waiting
 *      for and the user quietly pays all day for tokens they already had.
 *
 * So most of these assertions are about failing over, and about coming back.
 *
 * Run: npm run test:routing
 */
import { ProviderRouter, resolvePriority, nextDailyReset, RouterEvent } from '../server/core/provider_router.js';
import { AIProvider, AIProviderResponse } from '../server/providers/base.js';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail?: string) {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
function eq(name: string, actual: any, expected: any) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, ok, ok ? undefined : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function section(t: string) { console.log(`\n▸ ${t}`); }

/** A provider whose next outcome the test decides. */
class FakeProvider implements AIProvider {
  calls = 0;
  nextError: any = null;
  constructor(
    public id: string,
    public vendor: string,
    public currentModel: string,
    public name = id
  ) {}
  setModel(m: string) { this.currentModel = m; }
  describeSettings() { return { vendorSetting: this.vendor }; }
  async generateResponse(): Promise<AIProviderResponse> {
    this.calls++;
    if (this.nextError) {
      const err = this.nextError;
      throw err;
    }
    return { content: `hello from ${this.id}`, usage: { inputTokens: 10, outputTokens: 5 } as any };
  }
}

function httpError(status: number, message: string) {
  const err: any = new Error(message);
  err.status = status;
  return err;
}

/** The shape Gemini actually returns when the free daily allowance is gone. */
function geminiDailyQuotaError() {
  return httpError(
    429,
    'You exceeded your current quota. quota_metric: generate_content_free_tier_requests, ' +
      'quota_id: GenerateRequestsPerDayPerProjectPerModel-FreeTier, quota_value: 250'
  );
}

const call = (r: ProviderRouter) => r.generateResponse([], [], 'sys');

async function main() {
  // -----------------------------------------------------------------------
  section('The free tier is drained first');

  {
    const gemini = new FakeProvider('gemini', 'gemini', 'gemini-3.6-flash');
    const anthropic = new FakeProvider('anthropic', 'anthropic', 'claude-opus-5');
    const router = new ProviderRouter([
      { key: 'gemini', provider: gemini },
      { key: 'anthropic', provider: anthropic },
    ]);

    for (let i = 0; i < 5; i++) await call(router);
    eq('every call goes to the free provider while it works', gemini.calls, 5);
    eq('the paid provider is not touched', anthropic.calls, 0);
    eq('the served provider is reported on the response', (await call(router)).servedBy, 'gemini');
    eq('and identity reflects who answered, not the router', router.currentModel, 'gemini-3.6-flash');
  }

  // -----------------------------------------------------------------------
  section('Running out mid-day fails over instead of failing');

  {
    const gemini = new FakeProvider('gemini', 'gemini', 'gemini-3.6-flash');
    const anthropic = new FakeProvider('anthropic', 'anthropic', 'claude-opus-5');
    const events: RouterEvent[] = [];
    const router = new ProviderRouter(
      [{ key: 'gemini', provider: gemini }, { key: 'anthropic', provider: anthropic }],
      { onEvent: (e) => events.push(e) }
    );

    gemini.nextError = geminiDailyQuotaError();
    const res = await call(router);
    check('the turn still gets an answer', res.content.includes('anthropic'));
    eq('served by the next provider in the order', res.servedBy, 'anthropic');
    check('the failover is recorded', events.some((e) => e.type === 'router.failover'));
    check(
      'and so is why the provider went away',
      events.some((e) => e.type === 'router.provider_unavailable' && e.kind === 'quota_exhausted')
    );

    gemini.nextError = null;
    const before = gemini.calls;
    await call(router);
    eq('the exhausted provider is skipped rather than retried every turn', gemini.calls, before);
    eq('and the paid one keeps serving', anthropic.calls, 2);
  }

  // -----------------------------------------------------------------------
  section('It goes back to the free tier as soon as it could have refilled');

  {
    let now = Date.parse('2026-08-19T18:00:00Z');
    const gemini = new FakeProvider('gemini', 'gemini', 'gemini-3.6-flash');
    const anthropic = new FakeProvider('anthropic', 'anthropic', 'claude-opus-5');
    const events: RouterEvent[] = [];
    const router = new ProviderRouter(
      [{ key: 'gemini', provider: gemini }, { key: 'anthropic', provider: anthropic }],
      { onEvent: (e) => events.push(e), now: () => now, quotaResetTimeZone: 'America/Los_Angeles' }
    );

    gemini.nextError = geminiDailyQuotaError();
    await call(router);
    gemini.nextError = null;

    const health = router.health().find((h) => h.key === 'gemini')!;
    check('the free provider is marked unavailable', !health.available);
    eq('with the reason kept', health.reason, 'quota_exhausted');
    check('and a time it will be tried again', health.retryAt !== null);

    const cooldownMs = Date.parse(health.retryAt!) - now;
    check('the wait is bounded, not open-ended', cooldownMs <= 60 * 60_000, `${cooldownMs}ms`);

    // A 429 costs no money and no quota, so probing early is nearly free while
    // giving up early costs a day of paid tokens. Bias must be toward probing.
    now += cooldownMs;
    await call(router);
    eq('it returns to the free tier the moment the cooldown lapses', gemini.calls, 2);
    check('and the recovery is visible', events.some((e) => e.type === 'router.recovered'));
  }

  // -----------------------------------------------------------------------
  section('Repeated exhaustion backs off, but never past the daily reset');

  {
    // 23:30 Pacific: the refill is half an hour away, and no backoff may
    // outlive it — that is precisely the case where a fixed cooldown would
    // burn the next day's free allowance.
    let now = Date.parse('2026-08-20T06:30:00Z');
    const gemini = new FakeProvider('gemini', 'gemini', 'gemini-3.6-flash');
    const anthropic = new FakeProvider('anthropic', 'anthropic', 'claude-opus-5');
    const router = new ProviderRouter(
      [{ key: 'gemini', provider: gemini }, { key: 'anthropic', provider: anthropic }],
      { now: () => now, quotaResetTimeZone: 'America/Los_Angeles' }
    );

    for (let i = 0; i < 6; i++) {
      gemini.nextError = geminiDailyQuotaError();
      const until = Date.parse(router.health().find((h) => h.key === 'gemini')!.retryAt ?? new Date(now).toISOString());
      now = Math.max(now, until);
      await call(router);
    }

    const retryAt = Date.parse(router.health().find((h) => h.key === 'gemini')!.retryAt!);
    const reset = nextDailyReset(now, 'America/Los_Angeles');
    check(
      'the wait never extends past the next refill',
      retryAt <= reset,
      `retryAt=${new Date(retryAt).toISOString()} reset=${new Date(reset).toISOString()}`
    );
  }

  // -----------------------------------------------------------------------
  section('Failing over is for provider faults, not bad requests');

  {
    const gemini = new FakeProvider('gemini', 'gemini', 'gemini-3.6-flash');
    const anthropic = new FakeProvider('anthropic', 'anthropic', 'claude-opus-5');
    const openai = new FakeProvider('openai', 'openai', 'gpt-5.6-terra');
    const router = new ProviderRouter([
      { key: 'gemini', provider: gemini },
      { key: 'anthropic', provider: anthropic },
      { key: 'openai', provider: openai },
    ]);

    // A request the provider rejects on its merits will be rejected by all of
    // them. Trying each in turn converts one refusal into three bills.
    gemini.nextError = httpError(400, 'Invalid JSON payload received. Unknown name "foo".');
    let threw = false;
    try { await call(router); } catch { threw = true; }
    check('a malformed request surfaces instead of being retried elsewhere', threw);
    eq('the paid providers are never called', anthropic.calls + openai.calls, 0);
    check('and the provider is not written off for it', router.health()[0].available);

    // A disconnected generation is cancelled and passed to the next route.
    gemini.nextError = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    threw = false;
    try { await call(router); } catch { threw = true; }
    check('a network fault hands the request to another provider', !threw);
    eq('the next provider receives it once', anthropic.calls + openai.calls, 1);
  }

  // -----------------------------------------------------------------------
  section('An overloaded or throttled provider steps aside briefly');

  {
    let now = Date.parse('2026-08-19T12:00:00Z');
    const gemini = new FakeProvider('gemini', 'gemini', 'gemini-3.6-flash');
    const anthropic = new FakeProvider('anthropic', 'anthropic', 'claude-opus-5');
    const router = new ProviderRouter(
      [{ key: 'gemini', provider: gemini }, { key: 'anthropic', provider: anthropic }],
      { now: () => now }
    );

    gemini.nextError = httpError(529, 'Overloaded');
    await call(router);
    eq('the turn is served by the next provider', anthropic.calls, 1);

    const retryAt = Date.parse(router.health()[0].retryAt!);
    check('capacity trouble gets a short wait, not a daily one', retryAt - now <= 10 * 60_000);
  }

  {
    /*
     * 529 は Anthropic の綴り。**Gemini は 503 でそれを言う。**分類できない失敗は
     * 引き継ぎに入らないので、既定の一番手（無料枠）が混んだだけで会話が終わって
     * いた —— 実測 2026-09-29、`FAILOVER:` が一度も出ずに turn が死んだ。
     */
    let now = Date.parse('2026-09-29T12:00:00Z');
    const gemini = new FakeProvider('gemini', 'gemini', 'gemini-3.6-flash');
    const anthropic = new FakeProvider('anthropic', 'anthropic', 'claude-opus-5');
    const events: RouterEvent[] = [];
    const router = new ProviderRouter(
      [{ key: 'gemini', provider: gemini }, { key: 'anthropic', provider: anthropic }],
      { now: () => now, onEvent: (e) => events.push(e) }
    );

    gemini.nextError = httpError(
      503,
      '{"error":{"code":503,"message":"This model is currently experiencing high demand.","status":"UNAVAILABLE"}}'
    );
    await call(router);
    eq('Gemini の 503 でも次が答える', anthropic.calls, 1);
    check('引き継ぎとして記録される', events.some((e) => e.type === 'router.failover' && e.kind === 'overloaded'));
  }

  // -----------------------------------------------------------------------
  section('A dead chat is never the answer');

  {
    let now = Date.parse('2026-08-19T12:00:00Z');
    const gemini = new FakeProvider('gemini', 'gemini', 'gemini-3.6-flash');
    const anthropic = new FakeProvider('anthropic', 'anthropic', 'claude-opus-5');
    const events: RouterEvent[] = [];
    const router = new ProviderRouter(
      [{ key: 'gemini', provider: gemini }, { key: 'anthropic', provider: anthropic }],
      { now: () => now, onEvent: (e) => events.push(e) }
    );

    gemini.nextError = geminiDailyQuotaError();
    anthropic.nextError = httpError(429, 'quota exceeded for this month');
    let threw = false;
    try { await call(router); } catch { threw = true; }
    check('when everything is down the failure is honest', threw);

    // Every cooldown is a guess about a future nobody can see. Refusing the
    // turn because all the guesses are pessimistic would let a wrong guess
    // silence the assistant — so it tries the soonest one anyway.
    gemini.nextError = null;
    anthropic.nextError = null;
    const res = await call(router);
    check('but a turn is still attempted while all are in cooldown', res.content.length > 0);
    check('and the user can see it happened', events.some((e) => e.type === 'router.all_unavailable'));
  }

  // -----------------------------------------------------------------------
  section('A cancelled run stops, rather than spreading');

  {
    const gemini = new FakeProvider('gemini', 'gemini', 'gemini-3.6-flash');
    const anthropic = new FakeProvider('anthropic', 'anthropic', 'claude-opus-5');
    const router = new ProviderRouter([
      { key: 'gemini', provider: gemini },
      { key: 'anthropic', provider: anthropic },
    ]);

    const controller = new AbortController();
    controller.abort();
    gemini.nextError = geminiDailyQuotaError();

    let threw = false;
    try { await router.generateResponse([], [], 'sys', controller.signal); } catch { threw = true; }
    check('the abort surfaces', threw);
    eq('a caller who stopped caring is not billed for a second provider', anthropic.calls, 0);
    check('and the provider is not penalised for a cancelled call', router.health()[0].available);
  }

  // -----------------------------------------------------------------------
  section('Streaming stays immediate, and replacement clears only stale text');

  {
    let finish: (() => void) | undefined;
    const streaming: AIProvider = {
      id: 'streaming', name: 'Streaming', vendor: 'test', currentModel: 'streaming-v1', setModel() {},
      async generateResponse(_messages, _tools, _system, _signal, onDelta) {
        onDelta?.('届いた断片');
        return new Promise<AIProviderResponse>((resolve) => { finish = () => resolve({ content: '届いた断片の完了' }); });
      },
    };
    const router = new ProviderRouter([{ key: 'streaming', provider: streaming }]);
    const deltas: string[] = [];
    let completed = false;
    const pending = router.generateResponse([], [], 'sys', undefined, (text) => deltas.push(text)).then(() => { completed = true; });
    await Promise.resolve();
    eq('a successful candidate forwards its first delta before completion', deltas, ['届いた断片']);
    check('the response has not completed when that delta is visible', !completed);
    finish?.();
    await pending;
  }

  {
    let receivedHistory: any;
    let receivedTools: any;
    const slow: AIProvider = {
      id: 'slow', name: 'Slow', vendor: 'test', currentModel: 'slow-v1', setModel() {},
      async generateResponse(_messages, _tools, _system, signal, onDelta) {
        onDelta?.('古い断片');
        return new Promise<AIProviderResponse>((_, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
      },
    };
    const successor: AIProvider = {
      id: 'successor', name: 'Successor', vendor: 'test', currentModel: 'successor-v1', setModel() {},
      async generateResponse(messages, tools, _system, _signal, onDelta) {
        receivedHistory = messages;
        receivedTools = tools;
        onDelta?.('新しい断片');
        return { content: '新しい断片の完了' };
      },
    };
    const router = new ProviderRouter(
      [{ key: 'slow', provider: slow }, { key: 'successor', provider: successor }],
      { attemptTimeoutMs: 25 }
    );
    const history: any[] = [{ role: 'user', content: '依頼' }, { role: 'tool', toolName: 'read_only', toolCallId: 't1', toolResult: { cached: true } }];
    const tools: any[] = [{ name: 'read_only' }];
    let visible = '';
    let resets = 0;
    const response = await router.generateResponse(history, tools, 'sys', undefined,
      (text) => { visible += text; },
      () => { resets++; visible = ''; }
    );
    eq('a timed-out candidate is replaced by the next provider', response.servedBy, 'successor');
    eq('the stale partial reply is reset before the successor streams', visible, '新しい断片');
    eq('the stream resets exactly for the handoff', resets, 1);
    check('the replacement retains conversation history', receivedHistory === history);
    check('the replacement retains available tools', receivedTools === tools);
  }

  {
    let successorCalls = 0;
    const waiting: AIProvider = {
      id: 'waiting', name: 'Waiting', vendor: 'test', currentModel: 'waiting-v1', setModel() {},
      async generateResponse(_messages, _tools, _system, signal) {
        return new Promise<AIProviderResponse>((_, reject) => signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
      },
    };
    const successor: AIProvider = {
      id: 'successor', name: 'Successor', vendor: 'test', currentModel: 'successor-v1', setModel() {},
      async generateResponse() { successorCalls++; return { content: 'must not run' }; },
    };
    const router = new ProviderRouter(
      [{ key: 'waiting', provider: waiting }, { key: 'successor', provider: successor }],
      { attemptTimeoutMs: 200 }
    );
    const controller = new AbortController();
    const pending = router.generateResponse([], [], 'sys', controller.signal).catch(() => undefined);
    setTimeout(() => controller.abort(), 10);
    await pending;
    eq('a run deadline or user cancellation starts no replacement call', successorCalls, 0);
  }

  // -----------------------------------------------------------------------
  section('Clearing a cooldown after fixing the cause');

  {
    const gemini = new FakeProvider('gemini', 'gemini', 'gemini-3.6-flash');
    const anthropic = new FakeProvider('anthropic', 'anthropic', 'claude-opus-5');
    const router = new ProviderRouter([
      { key: 'gemini', provider: gemini },
      { key: 'anthropic', provider: anthropic },
    ]);

    gemini.nextError = httpError(401, 'invalid x-api-key');
    await call(router);
    check('a bad key takes the provider out of rotation', !router.health()[0].available);

    // The cooldown was an estimate made before the user fixed anything.
    eq('clearing reports what it cleared', router.reset('gemini'), 1);
    check('and the provider is back', router.health()[0].available);
    eq('clearing an already-clear provider is a no-op', router.reset('anthropic'), 0);
  }

  // -----------------------------------------------------------------------
  section('Preference order');

  {
    const gemini = new FakeProvider('gemini', 'gemini', 'g');
    const anthropic = new FakeProvider('anthropic', 'anthropic', 'c');
    const review = new FakeProvider('anthropic-review', 'anthropic', 'c2');
    const openai = new FakeProvider('openai', 'openai', 'o');
    const configured: Record<string, AIProvider> = {
      anthropic, 'anthropic-review': review, gemini, openai,
    };

    eq(
      'the free tier is first by default, whatever order the keys were registered in',
      resolvePriority(configured, undefined).map((e) => e.key),
      ['gemini', 'anthropic', 'openai']
    );
    eq(
      'an explicit order wins',
      resolvePriority(configured, 'openai,gemini').map((e) => e.key),
      ['openai', 'gemini', 'anthropic']
    );
    eq(
      'a provider named in the order but not configured is dropped, not an error',
      resolvePriority({ gemini }, 'anthropic,gemini,openai').map((e) => e.key),
      ['gemini']
    );
    check(
      'the review-only instance never serves chat',
      !resolvePriority(configured, undefined).some((e) => e.key === 'anthropic-review')
    );
    eq('duplicates in the configured order collapse', resolvePriority(configured, 'gemini,gemini').map((e) => e.key).filter((k) => k === 'gemini').length, 1);
  }

  // -----------------------------------------------------------------------
  section('Daily reset arithmetic');

  {
    const tz = 'America/Los_Angeles';
    const noon = Date.parse('2026-08-19T19:00:00Z'); // 12:00 PDT
    const reset = nextDailyReset(noon, tz);
    check('the reset is in the future', reset > noon);
    check('and within a day', reset - noon <= 86_400_000);
    eq(
      'it lands on local midnight',
      new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false })
        .format(new Date(reset)),
      '00:00'
    );

    const justBefore = Date.parse('2026-08-20T06:59:00Z'); // 23:59 PDT
    check('a minute before midnight waits about a minute', nextDailyReset(justBefore, tz) - justBefore <= 120_000);

    // An unknown zone must degrade to a working guess, not break routing.
    check('an unusable timezone still yields a future reset', nextDailyReset(noon, 'Not/AZone') > noon);
  }

  // -----------------------------------------------------------------------
  section('Cost attribution follows the provider that actually served');

  {
    const gemini = new FakeProvider('gemini', 'gemini', 'gemini-3.6-flash');
    const anthropic = new FakeProvider('anthropic', 'anthropic', 'claude-opus-5');
    const router = new ProviderRouter([
      { key: 'gemini', provider: gemini },
      { key: 'anthropic', provider: anthropic },
    ]);

    const first = await call(router);
    eq('the model on the response is the one that ran', first.servedModel, 'gemini-3.6-flash');
    eq('settings describe the provider that answered', router.describeSettings().vendorSetting, 'gemini');
    eq('and record where it was routed', router.describeSettings().routedTo, 'gemini');

    gemini.nextError = geminiDailyQuotaError();
    const second = await call(router);
    eq('after failover the attribution moves too', second.servedModel, 'claude-opus-5');
    eq('as does the vendor used for review independence', router.vendor, 'anthropic');
    eq('and the implementer key', router.lastServedKey(), 'anthropic');
  }

  // -----------------------------------------------------------------------
  section('A spending limit costs capability, not the conversation');

  {
    const gemini = new FakeProvider('gemini', 'gemini', 'gemini-3.6-flash');
    const anthropic = new FakeProvider('anthropic', 'anthropic', 'claude-opus-5');
    const events: RouterEvent[] = [];
    let paid = true;
    const router = new ProviderRouter(
      [{ key: 'anthropic', provider: anthropic }, { key: 'gemini', provider: gemini }],
      { onEvent: (e) => events.push(e), paidAllowed: () => paid, freeKeys: ['gemini'] }
    );

    await call(router);
    eq('while in budget the preferred paid provider serves', anthropic.calls, 1);

    // Asked per request, so a limit reached mid-conversation applies to the
    // next turn rather than at startup only.
    paid = false;
    const res = await call(router);
    eq('over the limit the turn still gets an answer', res.servedBy, 'gemini');
    eq('and the paid provider is not called', anthropic.calls, 1);
    check('the restriction is reported', events.some((e) => e.type === 'router.budget_restricted'));

    paid = true;
    await call(router);
    eq('raising the limit restores the paid provider', anthropic.calls, 2);
  }

  {
    const anthropic = new FakeProvider('anthropic', 'anthropic', 'claude-opus-5');
    const openai = new FakeProvider('openai', 'openai', 'gpt-5.6-terra');
    const router = new ProviderRouter(
      [{ key: 'anthropic', provider: anthropic }, { key: 'openai', provider: openai }],
      { paidAllowed: () => false, freeKeys: ['gemini'] }
    );

    let message = '';
    try { await call(router); } catch (err: any) { message = err.message; }
    // "We hit the spending limit" and "the providers are down" call for
    // completely different actions, so they must not read the same.
    check('with nothing free left, the reason given is the budget', /支出上限/.test(message), message);
    eq('and nothing paid was called', anthropic.calls + openai.calls, 0);
  }

  section('A provider that hit its own daily cap is skipped, not forced');

  {
    const openai = new FakeProvider('openai', 'openai', 'gpt-6.1-sol');
    const gemini = new FakeProvider('gemini', 'gemini', 'gemini-3.6-flash');
    const events: RouterEvent[] = [];
    let openaiOk = true;
    const router = new ProviderRouter(
      [{ key: 'openai', provider: openai }, { key: 'gemini', provider: gemini }],
      { onEvent: (e) => events.push(e), providerAllowed: (k) => (k === 'openai' ? openaiOk : true), freeKeys: ['gemini'] }
    );
    await call(router);
    eq('under its cap, the preferred provider serves', openai.calls, 1);
    openaiOk = false;
    const res = await call(router);
    eq('over its cap, the turn goes to the next provider', res.servedBy, 'gemini');
    eq('and the capped provider is not called', openai.calls, 1);
    check('the cap is reported', events.some((e) => (e as any).type === 'router.provider_capped'));
    gemini.nextError = httpError(429, 'Too Many Requests');
    let message = '';
    try { await call(router); } catch (err: any) { message = String(err?.message ?? err); }
    check('when the only other provider fails, a capped one is not forced — the turn fails and says why', openai.calls === 1 && message.length > 0, message);
  }

  {
    const openai = new FakeProvider('openai', 'openai', 'gpt-6.1-sol');
    const router = new ProviderRouter([{ key: 'openai', provider: openai }], { providerAllowed: () => false });
    let message = '';
    try { await call(router); } catch (err: any) { message = String(err?.message ?? err); }
    check('with everything capped, the refusal names the cap and the setting', message.includes('上限') && message.includes('IRIS_OPENAI_DAILY_USD'), message);
    eq('and nothing was called', openai.calls, 0);
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Provider routing: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('All routing tests passed.');
}

main().catch((err) => { console.error('\nTest harness crashed:', err); process.exit(1); });
