/**
 * How much of the week unattended work may spend on its own.
 *
 * The budget is a delta rather than a ceiling, and every assertion here is
 * about a way that delta can quietly become meaningless: a baseline that
 * resets when it should hold, one that holds when it should reset, and a
 * missing reading treated as an empty week.
 *
 * Run: npx tsx scripts/test-allowance-gate.ts
 */
import { decide, DEFAULT_BUDGET } from '../server/core/allowance_gate.js';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function section(name: string) { console.log(`\n▸ ${name}`); }
function eq(name: string, actual: any, expected: any) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(`${name}: ${JSON.stringify(actual)} ≠ ${JSON.stringify(expected)}`); console.log(`  ✗ ${name}`); }
}

const T = 1_700_000_000_000;
const RESET = T + 3 * 86_400_000;
const read = (week: number | null, opts: Partial<{ session: number; reset: number | null; age: number }> = {}) => ({
  weekPercent: week,
  sessionPercent: opts.session ?? 10,
  weekResetsAtMs: opts.reset === undefined ? RESET : opts.reset,
  ageMinutes: opts.age ?? 2,
});
const base = (weekPercent: number, lastRunAt = T) => ({
  weekPercent, startedAt: T, lastRunAt, weekResetsAtMs: RESET,
});

section('The day before is not this budget’s business');
{
  /**
   * The reason the ceiling was replaced. At 87% of the week already spent by
   * hand, an absolute limit refuses the night's first run — and on a Monday
   * the same limit waves a runaway through because the week is still empty.
   */
  const { verdict } = decide(read(87), null, T);
  eq('a nearly spent week still starts a stretch', verdict.allowed, true);
  eq('having spent nothing yet', (verdict as any).spentPoints, 0);
}

section('Five points of its own');
{
  eq('four points in', decide(read(91), base(87), T + 60_000).verdict.allowed, true);
  eq('five points in', decide(read(92), base(87), T + 60_000).verdict.allowed, false);
  const v = decide(read(92), base(87), T + 60_000).verdict as any;
  eq('and it is named', v.code, 'budget');
  eq('with both ends quoted', v.message.includes('87') && v.message.includes('92'), true);
}

section('A stretch ends when nobody has run anything for a while');
{
  const gap = DEFAULT_BUDGET.newStretchAfterMinutes * 60_000 + 1;
  const { verdict, baseline } = decide(read(92), base(87), T + gap);
  eq('the old baseline is not carried over', verdict.allowed, true);
  eq('a new one starts here', baseline?.weekPercent, 92);
  // Just inside the gap is the same stretch, and still over budget.
  eq('but not one minute early', decide(read(92), base(87), T + gap - 120_000).verdict.allowed, false);
}

section('A week that has rolled is a new week');
{
  /**
   * Without this, the first run after a reset compares 2% against last week's
   * 87% and reads as budget earned back — and the run after that inherits a
   * baseline that can never be exceeded.
   */
  const rolled = { ...read(2), weekResetsAtMs: RESET + 7 * 86_400_000 };
  const { verdict, baseline } = decide(rolled, base(87), T + 60_000);
  eq('it starts over', verdict.allowed, true);
  eq('against the new figure', baseline?.weekPercent, 2);
}

section('A figure that fell is noise, not savings');
{
  // Clamped at zero: a reading arriving out of order must not hand back
  // budget that was already spent.
  const { verdict } = decide(read(80), base(87), T + 60_000);
  eq('still allowed', verdict.allowed, true);
  eq('and nothing is credited', (verdict as any).spentPoints, 0);
}

section('Nothing known is not permission');
{
  eq('no reading', decide(null, base(10), T).verdict.allowed, false);
  eq('no weekly figure', decide(read(null), base(10), T).verdict.allowed, false);
  eq('named', (decide(null, base(10), T).verdict as any).code, 'unknown');
  const old = read(10, { age: DEFAULT_BUDGET.freshMinutes + 1 });
  eq('a stale reading', decide(old, base(10), T).verdict.allowed, false);
  eq('exactly at the limit is fresh', decide(read(10, { age: DEFAULT_BUDGET.freshMinutes }), base(10), T).verdict.allowed, true);
}

section('The five-hour window only stops work that would stall');
{
  eq('busy but usable', decide(read(10, { session: 94 }), base(10), T).verdict.allowed, true);
  eq('effectively spent', decide(read(10, { session: 95 }), base(10), T).verdict.allowed, false);
  eq('named separately', (decide(read(10, { session: 95 }), base(10), T).verdict as any).code, 'session');
}

section('A refused run leaves no trace');
{
  // Otherwise a stretch that never ran would move the baseline, and the
  // budget would be spent on work that did not happen.
  eq('over budget writes nothing', decide(read(92), base(87), T + 60_000).baseline, null);
  eq('stale writes nothing', decide(read(10, { age: 999 }), base(10), T).baseline, null);
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`Unattended budget: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('All unattended budget tests passed.');
