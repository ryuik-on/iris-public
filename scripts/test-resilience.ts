/**
 * Timeout, retry and deadline tests.
 *
 * The load-bearing assertion in this file is that a timed-out risky tool is
 * executed exactly once and reported as *unknown*, never as failed. Getting
 * that wrong means either telling the user an action did not happen when it
 * did, or silently performing a destructive action twice.
 *
 * Run: npm run test:resilience
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  withTimeout,
  retry,
  Deadline,
  TimeoutError,
  DeadlineExceededError,
  defaultIsRetryable,
} from '../server/core/resilience.js';
import { ToolRegistry, isAutoRetryable } from '../server/tools/registry.js';
import { RiskLevel, Tool, ConversationTurn } from '../server/core/types.js';
import { AIProvider, AIProviderResponse } from '../server/providers/base.js';
import { JarvisOrchestrator, OrchestratorEvent } from '../server/core/orchestrator.js';
import { SqliteApprovalStore } from '../server/services/approval_sqlite.js';
import { openDatabase } from '../server/services/db.js';
import { CONFIG } from '../server/config.js';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    failures.push(name + (detail ? ` — ${detail}` : ''));
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function eq(name: string, actual: any, expected: any) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, ok, ok ? undefined : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function section(title: string) {
  console.log(`\n▸ ${title}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A tool that hangs far longer than any timeout under test. */
function hangingTool(name: string, riskLevel: RiskLevel, runs: { count: number }): Tool {
  return {
    name,
    description: `hangs (${riskLevel})`,
    riskLevel,
    schema: { type: 'object', properties: {} },
    async execute() {
      runs.count++;
      await sleep(10_000);
      return { neverReached: true };
    },
  };
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'iris-resilience-'));

  try {
    // ---------------------------------------------------------------------
    section('withTimeout');

    const fast = await withTimeout(async () => 'done', { ms: 500, label: 'fast' });
    eq('a fast call returns normally', fast, 'done');

    try {
      await withTimeout(() => sleep(5000).then(() => 'late'), { ms: 60, label: 'slow' });
      check('a slow call times out', false, 'no throw');
    } catch (err: any) {
      check('a slow call times out', err instanceof TimeoutError);
      eq('timeout reports its label', err.label, 'slow');
      eq('timeout defaults to side-effect-unknown', err.sideEffectUnknown, true);
    }

    try {
      await withTimeout(() => sleep(5000), { ms: 60, label: 'pure', sideEffectUnknown: false });
    } catch (err: any) {
      eq('an explicitly pure call is not side-effect-unknown', err.sideEffectUnknown, false);
    }

    let observedAbort = false;
    try {
      await withTimeout(
        (signal) =>
          new Promise((_, reject) => {
            signal.addEventListener('abort', () => {
              observedAbort = true;
              reject(new Error('aborted by signal'));
            });
          }),
        { ms: 60, label: 'cancellable' }
      );
    } catch {
      /* expected */
    }
    check('the callee receives an abort signal, enabling real cancellation', observedAbort);

    const original = new Error('genuine failure');
    try {
      await withTimeout(async () => { throw original; }, { ms: 1000, label: 'failing' });
    } catch (err: any) {
      check('a real error is not disguised as a timeout', err === original);
    }

    // ---------------------------------------------------------------------
    section('retry policy');

    let attemptCount = 0;
    const recovered = await retry(
      async () => {
        attemptCount++;
        if (attemptCount < 3) {
          const e: any = new Error('503 service unavailable');
          e.status = 503;
          throw e;
        }
        return 'recovered';
      },
      { attempts: 4, label: 'transient', baseDelayMs: 1 }
    );
    eq('a transient failure is retried to success', recovered, 'recovered');
    eq('it took exactly the expected attempts', attemptCount, 3);

    let permanentAttempts = 0;
    try {
      await retry(
        async () => {
          permanentAttempts++;
          const e: any = new Error('400 bad request');
          e.status = 400;
          throw e;
        },
        { attempts: 4, label: 'permanent', baseDelayMs: 1 }
      );
    } catch {
      /* expected */
    }
    eq('a client error is not retried', permanentAttempts, 1);

    check('429 is retryable', defaultIsRetryable(Object.assign(new Error('x'), { status: 429 })));
    check('503 is retryable', defaultIsRetryable(Object.assign(new Error('x'), { status: 503 })));
    check('400 is not retryable', !defaultIsRetryable(Object.assign(new Error('x'), { status: 400 })));
    check('network reset is retryable', defaultIsRetryable(new Error('socket hang up')));
    check(
      'a side-effect-unknown timeout is NEVER retryable',
      !defaultIsRetryable(new TimeoutError('write', 100, true))
    );
    check(
      'a side-effect-free timeout is retryable',
      defaultIsRetryable(new TimeoutError('generate', 100, false))
    );
    check(
      'a deadline breach is never retryable',
      !defaultIsRetryable(new DeadlineExceededError('run', 100))
    );

    // A daily quota is exhausted, not transient: retrying burns the remaining
    // budget and delays an honest failure. Per-minute limits do recover.
    const dailyQuota: any = new Error('quota exceeded');
    dailyQuota.status = 429;
    dailyQuota.error = { error: { details: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] } };
    check('a daily quota exhaustion is NOT retried', !defaultIsRetryable(dailyQuota));

    const perMinute: any = new Error('rate limited');
    perMinute.status = 429;
    perMinute.error = { error: { details: [{ quotaId: 'GenerateRequestsPerMinute' }] } };
    check('a per-minute rate limit is retried', defaultIsRetryable(perMinute));

    // A safety refusal is a content outcome; the identical request refuses again.
    const refusal: any = new Error('declined');
    refusal.refusal = true;
    check('a safety refusal is never retried', !defaultIsRetryable(refusal));

    // ---------------------------------------------------------------------
    section('Deadline');

    const deadline = new Deadline(200, 'test run');
    check('a fresh deadline is alive', !deadline.expired);
    eq('a step timeout is clamped to the remaining budget', deadline.clamp(10_000) <= 200, true);
    await sleep(260);
    check('the deadline expires', deadline.expired);
    check('an expired deadline aborts its signal', deadline.signal.aborted);
    try {
      deadline.assertAlive();
      check('an expired deadline throws on assert', false, 'no throw');
    } catch (err: any) {
      check('an expired deadline throws on assert', err instanceof DeadlineExceededError);
    }
    deadline.dispose();

    // ---------------------------------------------------------------------
    section('Risk-aware tool retry policy (§47)');

    check('READ is auto-retryable', isAutoRetryable(RiskLevel.READ));
    check('WRITE is NOT auto-retryable', !isAutoRetryable(RiskLevel.WRITE));
    check('EXTERNAL_ACTION is NOT auto-retryable', !isAutoRetryable(RiskLevel.EXTERNAL_ACTION));
    check('DESTRUCTIVE is NOT auto-retryable', !isAutoRetryable(RiskLevel.DESTRUCTIVE));

    const readRuns = { count: 0 };
    const writeRuns = { count: 0 };
    const destructiveRuns = { count: 0 };

    const registry = new ToolRegistry();
    registry.register(hangingTool('hang_read', RiskLevel.READ, readRuns));
    registry.register(hangingTool('hang_write', RiskLevel.WRITE, writeRuns));
    registry.register(hangingTool('hang_destructive', RiskLevel.DESTRUCTIVE, destructiveRuns));

    const readOutcome = await registry.executeTool('hang_read', {}, { timeoutMs: 60 });
    eq('a hung READ times out', readOutcome.timedOut, true);
    eq('a hung READ is not side-effect-unknown', readOutcome.sideEffectUnknown, false);
    eq('a hung READ is retried once', readRuns.count, 2);

    const writeOutcome = await registry.executeTool('hang_write', {}, { timeoutMs: 60 });
    eq('a hung WRITE times out', writeOutcome.timedOut, true);
    eq('a hung WRITE is reported side-effect-unknown', writeOutcome.sideEffectUnknown, true);
    eq('a hung WRITE runs EXACTLY once — never retried', writeRuns.count, 1);

    const destructiveOutcome = await registry.executeTool('hang_destructive', {}, { timeoutMs: 60 });
    eq('a hung DESTRUCTIVE is side-effect-unknown', destructiveOutcome.sideEffectUnknown, true);
    eq('a hung DESTRUCTIVE runs EXACTLY once', destructiveRuns.count, 1);

    check(
      'the unknown outcome is not phrased as a failure',
      /不明/.test(writeOutcome.error || '') && !/失敗しました/.test(writeOutcome.error || ''),
      writeOutcome.error
    );

    // A transient READ failure recovers rather than surfacing to the user.
    let flakyRuns = 0;
    const flakyRegistry = new ToolRegistry();
    flakyRegistry.register({
      name: 'flaky_read',
      description: 'fails once then succeeds',
      riskLevel: RiskLevel.READ,
      schema: { type: 'object', properties: {} },
      async execute() {
        flakyRuns++;
        if (flakyRuns === 1) throw new Error('ECONNRESET');
        return { ok: true };
      },
    });
    const flakyOutcome = await flakyRegistry.executeTool('flaky_read', {});
    eq('a flaky READ recovers transparently', flakyOutcome.result, { ok: true });
    eq('it took two attempts', flakyRuns, 2);

    let flakyWriteRuns = 0;
    flakyRegistry.register({
      name: 'flaky_write',
      description: 'fails once then succeeds',
      riskLevel: RiskLevel.WRITE,
      schema: { type: 'object', properties: {} },
      async execute() {
        flakyWriteRuns++;
        throw new Error('ECONNRESET');
      },
    });
    const flakyWrite = await flakyRegistry.executeTool('flaky_write', {});
    check('a flaky WRITE surfaces its error', Boolean(flakyWrite.error));
    eq('a flaky WRITE is never retried even on a network error', flakyWriteRuns, 1);

    // ---------------------------------------------------------------------
    section('Orchestrator integration');

    const db = openDatabase(join(dir, 'r.db'));
    const approvals = new SqliteApprovalStore(db);
    const events: OrchestratorEvent[] = [];

    // A provider that hangs on its first call, then answers.
    let providerCalls = 0;
    let sawSignal = false;
    const flakyProvider: AIProvider = {
      id: 'flaky',
      name: 'Flaky Provider',
      currentModel: 'v1',
      setModel() {},
      async generateResponse(_m: ConversationTurn[], _t, _s, signal?: AbortSignal): Promise<AIProviderResponse> {
        providerCalls++;
        if (signal) sawSignal = true;
        if (providerCalls === 1) {
          await new Promise((_, reject) => {
            signal?.addEventListener('abort', () => reject(new Error('aborted')));
            setTimeout(() => reject(new Error('never')), 10_000);
          });
        }
        return { content: 'ok after recovery' };
      },
    };

    const originalProviderTimeout = CONFIG.providerTimeoutMs;
    (CONFIG as any).providerTimeoutMs = 80;

    const orchestrator = new JarvisOrchestrator(
      flakyProvider,
      new ToolRegistry(),
      approvals,
      6,
      (e) => events.push(e)
    );

    const result = await orchestrator.process({ userMessage: 'hello', history: [] });
    eq('a hung provider call recovers on retry', result.status, 'completed');
    eq('the recovered reply is returned', result.reply, 'ok after recovery');
    eq('the provider was called twice', providerCalls, 2);
    check('the provider received a cancellation signal', sawSignal);
    check('the timeout was recorded as telemetry', events.some((e) => e.type === 'provider.timeout'));
    check('the retry was recorded as telemetry', events.some((e) => e.type === 'provider.retry'));

    // A provider that always hangs must eventually give up, not hang forever.
    (CONFIG as any).providerTimeoutMs = 50;
    (CONFIG as any).providerAttempts = 2;
    const deadProvider: AIProvider = {
      id: 'dead',
      name: 'Dead Provider',
      currentModel: 'v1',
      setModel() {},
      async generateResponse(_m, _t, _s, signal?: AbortSignal) {
        return new Promise<AIProviderResponse>((_, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')));
          setTimeout(() => reject(new Error('never')), 30_000);
        });
      },
    };
    const deadOrchestrator = new JarvisOrchestrator(deadProvider, new ToolRegistry(), approvals, 6);

    const startedAt = Date.now();
    try {
      await deadOrchestrator.process({ userMessage: 'hello', history: [] });
      check('a permanently hung provider gives up', false, 'no throw');
    } catch (err: any) {
      check('a permanently hung provider gives up', err instanceof TimeoutError, `${err?.name}: ${err?.message}`);
    }
    const elapsed = Date.now() - startedAt;
    check(`it gave up promptly (${elapsed}ms, bounded)`, elapsed < 5000, `${elapsed}ms`);

    (CONFIG as any).providerTimeoutMs = originalProviderTimeout;
    (CONFIG as any).providerAttempts = 3;
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Resilience: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('All resilience tests passed.');
}

main().catch((err) => {
  console.error('\nTest harness crashed:', err);
  process.exit(1);
});
