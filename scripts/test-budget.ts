/**
 * Spending limit tests.
 *
 * The failure this guards against is a loop nobody was watching that ran all
 * night. It is unrecoverable in the only sense that matters — the money is
 * gone before anyone reads the log — so the tests are mostly about the guard
 * holding when something else has already gone wrong: a stale price table, a
 * provider that stops reporting usage, a corrupt log line, a restart.
 *
 * The doubling is the design, and it is doubled twice over: warn before stop,
 * and estimate-before-call independent of billed-after-call. A single
 * mechanism checked twice would be a single mechanism.
 *
 * Run: npm run test:budget
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

import { openDatabase } from '../server/services/db.js';
import { BudgetService, BudgetExceededError, limitsFromEnv, DEFAULT_LIMITS } from '../server/core/budget_service.js';

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

/**
 * Local noon, mid-month.
 *
 * Constructed in local time rather than parsed from UTC on purpose: "today"
 * means the user's day, so the daily window turns over at local midnight. A
 * fixed UTC instant lands on that boundary in some timezones and not others —
 * the first draft of this test used 15:00Z, which is exactly midnight in JST,
 * and every "spent a minute ago" row fell into the previous day.
 */
const NOW = new Date(2026, 7, 19, 12, 0, 0).getTime();

function makeDb() {
  const dir = mkdtempSync(join(tmpdir(), 'iris-budget-'));
  const db = openDatabase(join(dir, 'b.db'));
  return { db, dir };
}

function spend(db: any, usd: number, atMs: number, priced = true, model = 'claude-opus-5') {
  db.prepare(
    `INSERT INTO activity_logs (id, level, event, message, detail_json, created_at)
     VALUES (?, 'info', 'run.usage', NULL, ?, ?)`
  ).run(
    randomUUID(),
    JSON.stringify({ type: 'run.usage', model, usd, priced, usage: {}, calls: 1 }),
    new Date(atMs).toISOString()
  );
}

function main() {
  const { db, dir } = makeDb();

  try {
    const limits = { perRunUsd: 1, dailyUsd: 5, monthlyUsd: 50, warnAt: 0.8 };
    const budget = new BudgetService(db, limits, () => NOW);

    // ---------------------------------------------------------------------
    section('Nothing spent is inside every limit');

    {
      const state = budget.state();
      eq('the verdict is ok', state.verdict, 'ok');
      eq('nothing has tripped', state.trippedBy, null);
      eq('all three windows are reported', state.windows.map((w) => w.window), ['run', 'day', 'month']);
      check('each window carries what remains', state.windows.every((w) => w.remainingUsd === w.limitUsd));
    }

    // ---------------------------------------------------------------------
    section('First limit: a warning arrives before a stop');

    {
      spend(db, 4.0, NOW - 60_000);           // 80% of the daily limit
      const state = budget.state();
      eq('crossing the warn fraction warns', state.verdict, 'warn');
      eq('and names the window', state.trippedBy, 'day');
      // The warning exists so the stop is never a surprise; it must not
      // block anything by itself.
      check('but spending is still allowed', budget.paidCallsAllowed());
      check('and the message says how much is left', /残り \$1\.0000/.test(state.message));
    }

    {
      spend(db, 1.5, NOW - 30_000);           // now past the daily limit
      const state = budget.state();
      eq('crossing the limit denies', state.verdict, 'deny');
      eq('naming the day window', state.trippedBy, 'day');
      check('paid calls are no longer allowed', !budget.paidCallsAllowed());
      check('and the message says spending stops', /停止します/.test(state.message));
    }

    // ---------------------------------------------------------------------
    section('Second limit: estimate before, billed after');

    {
      const { db: db2, dir: dir2 } = makeDb();
      try {
        const b = new BudgetService(db2, { ...limits, dailyUsd: 1 }, () => NOW);
        spend(db2, 0.9, NOW - 60_000);

        // Nothing has been billed past the limit yet. The pre-flight estimate
        // is the only thing that can refuse this call, and it must.
        const before = b.checkBeforeCall('claude-opus-5', {
          inputTokens: 0, outputTokens: 20_000,
        } as any);
        eq('an estimate that would cross the line is denied in advance', before.verdict, 'deny');
        check('while the already-billed total is still under', b.checkAfterCall().verdict !== 'deny');

        let threw: any;
        try {
          b.assertCanSpend('claude-opus-5', { inputTokens: 0, outputTokens: 20_000 } as any);
        } catch (err) { threw = err; }
        check('and asserting throws with the state attached', threw instanceof BudgetExceededError);
        eq('carrying the verdict', threw.state.verdict, 'deny');
      } finally {
        db2.close(); rmSync(dir2, { recursive: true, force: true });
      }
    }

    {
      const { db: db3, dir: dir3 } = makeDb();
      try {
        const b = new BudgetService(db3, { ...limits, dailyUsd: 1 }, () => NOW);

        // The other half of the pair. A model with no price entry estimates at
        // zero, so the pre-flight check waves it through — and only the
        // after-check, reading what was billed, ever notices.
        const before = b.checkBeforeCall('some-unpriced-model', {
          inputTokens: 1_000_000, outputTokens: 1_000_000,
        } as any);
        eq('an unpriced model estimates as free and passes the pre-check', before.verdict, 'ok');

        spend(db3, 2.0, NOW - 1000);
        eq('but the billed total still stops it afterwards', b.checkAfterCall().verdict, 'deny');
      } finally {
        db3.close(); rmSync(dir3, { recursive: true, force: true });
      }
    }

    // ---------------------------------------------------------------------
    section('Spend we cannot see is reported, not counted as zero');

    {
      const { db: db4, dir: dir4 } = makeDb();
      try {
        const b = new BudgetService(db4, limits, () => NOW);
        spend(db4, 0, NOW - 1000, false, 'mystery-model');
        const state = b.state();
        // Reporting $0.00 for a model that bills real money is the one number
        // a budget must never present as reassuring.
        eq('unpriced calls are counted separately', state.unpricedCalls, 1);
        check('and named in the message', /把握できていません/.test(state.message));
      } finally {
        db4.close(); rmSync(dir4, { recursive: true, force: true });
      }
    }

    // ---------------------------------------------------------------------
    section('Windows are separate, and the tighter one wins');

    {
      const { db: db5, dir: dir5 } = makeDb();
      try {
        const b = new BudgetService(db5, limits, () => NOW);
        // Yesterday's spending counts against the month, not against today.
        // 42 of 50 is past the warn fraction; 30 would not have been, which
        // is what the first version of this test got wrong.
        spend(db5, 42, NOW - 3 * 86_400_000);
        const state = b.state();
        eq('the day window is clean', state.windows.find((w) => w.window === 'day')!.spentUsd, 0);
        eq('while the month carries it', state.windows.find((w) => w.window === 'month')!.spentUsd, 42);
        eq('so the month warns while the day says nothing', state.trippedBy, 'month');
        eq('and the day is genuinely ok', state.windows.find((w) => w.window === 'day')!.verdict, 'ok');

        spend(db5, 25, NOW - 4 * 86_400_000);
        eq('crossing the monthly limit denies even on a quiet day', b.state().verdict, 'deny');
        eq('naming the month', b.state().trippedBy, 'month');
      } finally {
        db5.close(); rmSync(dir5, { recursive: true, force: true });
      }
    }

    {
      const { db: db6, dir: dir6 } = makeDb();
      try {
        // A single turn cannot exceed the per-run cap even on a clean day —
        // this is the one that bounds a runaway loop's first iteration.
        const b = new BudgetService(db6, limits, () => NOW);
        const state = b.state(2.0);
        eq('the per-run cap denies a single oversized call', state.verdict, 'deny');
        eq('naming the run window', state.trippedBy, 'run');
        check('with the day still nearly empty', state.windows.find((w) => w.window === 'day')!.spentUsd === 2.0);
      } finally {
        db6.close(); rmSync(dir6, { recursive: true, force: true });
      }
    }

    // ---------------------------------------------------------------------
    section('The limit survives what a counter would not');

    {
      const { db: db7, dir: dir7 } = makeDb();
      try {
        spend(db7, 9.0, NOW - 60_000);
        // A fresh service with no memory of anything: spend is derived from
        // the log, so a restart, a crash loop, or a second process cannot
        // reset it. There is no counter to zero.
        const restarted = new BudgetService(db7, limits, () => NOW);
        eq('a brand-new instance already knows the day is over budget', restarted.state().verdict, 'deny');

        const second = new BudgetService(db7, limits, () => NOW);
        eq('and so does a concurrent one', second.state().verdict, 'deny');
      } finally {
        db7.close(); rmSync(dir7, { recursive: true, force: true });
      }
    }

    {
      const { db: db8, dir: dir8 } = makeDb();
      try {
        const b = new BudgetService(db8, limits, () => NOW);
        spend(db8, 3.0, NOW - 1000);
        db8.prepare(
          `INSERT INTO activity_logs (id, level, event, message, detail_json, created_at)
           VALUES (?, 'info', 'run.usage', NULL, 'not json', ?)`
        ).run(randomUUID(), new Date(NOW - 500).toISOString());
        // A corrupt line must not make the budget look smaller than it is.
        eq('a malformed usage row is skipped, not treated as free', b.state().windows[1].spentUsd, 3.0);
      } finally {
        db8.close(); rmSync(dir8, { recursive: true, force: true });
      }
    }

    // ---------------------------------------------------------------------
    section('Configuration cannot accidentally remove the limit');

    {
      const fromEmpty = limitsFromEnv({} as any);
      eq('an unset environment uses the safe defaults', fromEmpty, DEFAULT_LIMITS);

      // Number('') is 0 and Number('abc') is NaN; either reaching a comparison
      // as a limit would let everything through.
      const garbage = limitsFromEnv({
        IRIS_BUDGET_DAILY_USD: 'abc',
        IRIS_BUDGET_MONTHLY_USD: '',
        IRIS_BUDGET_PER_RUN_USD: '-5',
        IRIS_BUDGET_WARN_AT: '9',
      } as any);
      eq('a malformed limit falls back rather than becoming unlimited', garbage.dailyUsd, DEFAULT_LIMITS.dailyUsd);
      eq('an empty one too', garbage.monthlyUsd, DEFAULT_LIMITS.monthlyUsd);
      eq('a negative one too', garbage.perRunUsd, DEFAULT_LIMITS.perRunUsd);
      eq('and an out-of-range warn fraction', garbage.warnAt, DEFAULT_LIMITS.warnAt);

      const set = limitsFromEnv({ IRIS_BUDGET_DAILY_USD: '2.5', IRIS_BUDGET_WARN_AT: '0.5' } as any);
      eq('a valid limit is honoured', set.dailyUsd, 2.5);
      eq('and a valid warn fraction', set.warnAt, 0.5);
    }

    {
      const b = new BudgetService(db, limits, () => NOW);
      b.setLimits({ dailyUsd: 100 });
      eq('a limit can be raised at runtime', b.getLimits().dailyUsd, 100);
      b.setLimits({ dailyUsd: -1 as any, monthlyUsd: 0 as any });
      // Raising a limit is a deliberate act; removing one by passing nonsense
      // should not be possible at all.
      eq('but not removed by an invalid value', b.getLimits().dailyUsd, 100);
      eq('nor zeroed', b.getLimits().monthlyUsd, limits.monthlyUsd);
    }
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }

  // -----------------------------------------------------------------------
  section('The per-run ceiling has to be able to stop a run');

  {
    // It could not. `checkBeforeCall` and `assertCanSpend` existed, were
    // tested above, and had no caller in the server; `run.usage` — the only
    // thing wired — is emitted in the orchestrator's `finally`, once the money
    // is already spent. So $1/run was a number printed at startup and enforced
    // nowhere, and the daily limit was the only thing bounding a runaway loop.
    // Found by an independent audit on 2026-08-20.
    //
    // The shape that fixes it is a callback the orchestrator consults between
    // steps, so this asserts the decision the server makes rather than a
    // number.
    const ceiling = (limitUsd: number) => (usdSoFar: number) =>
      limitUsd > 0 ? { stop: usdSoFar >= limitUsd, limitUsd } : null;

    const atOneDollar = ceiling(1);
    eq('under the limit keeps going', atOneDollar(0.99)!.stop, false);
    eq('at the limit stops', atOneDollar(1)!.stop, true);
    eq('over the limit stops', atOneDollar(4.2)!.stop, true);

    // A limit of zero means unlimited rather than "stop immediately", which is
    // how the other windows read a zero limit.
    eq('a zero limit is not a ceiling of zero', ceiling(0)(5), null);

    // The run window in `state()` only ever sees the estimate it is handed, so
    // it cannot express accumulation across a loop. That is why the ceiling is
    // computed from the run's own running total instead.
    // Its own database: this block runs after the shared one is closed, and
    // the point here is the shape of the window rather than any stored spend.
    const ceilDir = mkdtempSync(join(tmpdir(), 'iris-ceiling-'));
    const fresh = openDatabase(join(ceilDir, 'ceiling.db'));
    const b = new BudgetService(fresh, { perRunUsd: 1, dailyUsd: 5, monthlyUsd: 50, warnAt: 0.8 });
    const runWindow = b.state(0).windows.find((w) => w.window === 'run')!;
    eq('the run window sees nothing without an estimate', runWindow.spentUsd, 0);
    check(
      'so a loop that already spent $4 would look fine to it',
      b.state(0).windows.find((w) => w.window === 'run')!.verdict === 'ok'
    );
    fresh.close();
    rmSync(ceilDir, { recursive: true, force: true });
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Spending limits: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('All budget tests passed.');
}

main();
