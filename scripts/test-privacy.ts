/**
 * The boundary that keeps local-only data out of a prompt.
 *
 * These assertions are about what happens when the guard is wrong in each
 * direction. Missing a marked value sends someone's transactions to a model;
 * seeing one that is not there turns an ordinary tool result into a refusal.
 * Both are worth tests, and the first is worth more.
 *
 * Run: npx tsx scripts/test-privacy.ts
 */
import { countLocalOnly, withhold, markLocalOnly, LOCAL_ONLY } from '../server/core/privacy.js';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function section(name: string) {
  console.log(`\n▸ ${name}`);
}

function eq(name: string, actual: any, expected: any) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    failures.push(`${name}: ${JSON.stringify(actual)} ≠ ${JSON.stringify(expected)}`);
    console.log(`  ✗ ${name}: ${JSON.stringify(actual)} ≠ ${JSON.stringify(expected)}`);
  }
}

function main() {
  section('Finding what must not cross');

  {
    const row = { id: 1, amount: -1280, description: 'そよかぜ書店', privacy: LOCAL_ONLY };
    eq('a marked value on its own', countLocalOnly(row), 1);

    // The shape a tool would actually return.
    eq('marked rows inside a result', countLocalOnly({ transactions: [row, row, row] }), 3);

    // The case the wrapper-only version missed: the array returned bare, with
    // no envelope to carry the label.
    eq('marked rows with no wrapper', countLocalOnly([row, row]), 2);

    // And buried, because a tool result is whatever a tool decided to build.
    eq(
      'marked rows nested several deep',
      countLocalOnly({ result: { data: { page: { rows: [row] } } } }),
      1
    );
  }

  section('Not finding what is not there');

  {
    eq('an ordinary result is untouched', countLocalOnly({ status: 'ok', items: [1, 2, 3] }), 0);
    eq('null', countLocalOnly(null), 0);
    eq('a string', countLocalOnly('local_only'), 0);

    // The word appearing as data is not a classification. A calendar entry
    // about privacy must not become a refusal.
    eq(
      'the phrase in a text field',
      countLocalOnly({ title: 'privacy: local_only について話す' }),
      0
    );
    eq('a different value in the field', countLocalOnly({ privacy: 'shareable' }), 0);
  }

  section('A cycle cannot hang the run it protects');

  {
    const a: any = { name: 'a' };
    const b: any = { name: 'b', back: a };
    a.forward = b;
    let threw = false;
    let count = -1;
    try {
      count = countLocalOnly(a);
    } catch {
      threw = true;
    }
    eq('it returns', threw, false);
    eq('and finds nothing to withhold', count, 0);
  }

  section('What the model is told instead');

  {
    const message = withhold(34);
    eq('it is a withholding, not an error', message.status, 'withheld');

    /**
     * The count is the point. An error invites a retry and silence gets
     * summarised as "no transactions", which is a false statement about
     * someone's money — so the reply says the data exists and cannot be seen.
     */
    eq('it carries how many', message.withheld, 34);
    eq('and says so in words', message.guidance.includes('34'), true);
    eq('and names the rule', message.guidance.includes('finance_local_boundary'), true);
  }

  section('Marking at the source');

  {
    const rows = markLocalOnly([{ id: 1, amount: -500 }, { id: 2, amount: -900 }]);
    eq('every row is marked', rows.every((r) => r.privacy === LOCAL_ONLY), true);
    eq('the data survives', rows[1].amount, -900);
    eq('and the guard sees all of them', countLocalOnly(rows), 2);

    // Marking must not mutate what it was given: the caller may be holding the
    // same objects for something that stays on this machine.
    const original = [{ id: 1 }];
    markLocalOnly(original);
    eq('the input is left alone', (original[0] as any).privacy, undefined);
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Local-only boundary: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('All local-only boundary tests passed.');
}

main();
