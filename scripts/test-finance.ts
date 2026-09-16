/**
 * Financial CSV import tests.
 *
 * The user decided this shape on 2026-08-20: files live outside the workspace
 * so `read_file` cannot reach them, line items never leave the machine and
 * expire after 13 months, monthly totals may go into a prompt and are kept.
 *
 * The tests that matter most are about being wrong in the expensive direction.
 * A parser that guesses which column is money does not fail loudly — it
 * produces a plausible year of spending in the wrong months or the wrong sign,
 * and the mistake reads as a pattern rather than a bug. So most of this file
 * is about refusing rather than parsing.
 *
 * The other half is the retention promise: line items go, aggregates stay.
 * An implementation that recomputed totals from line items on demand would
 * pass every test written against a fresh database and quietly report zero
 * spending for last year once the first rows expired.
 *
 * Run: npm run test:finance
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { openDatabase } from '../server/services/db.js';
import { FinanceStore } from '../server/services/finance_sqlite.js';
import { reconcile } from '../server/core/finance_reconcile.js';
import {
  parseCsv,
  parseDate,
  parseAmount,
  splitCsvLine,
  detectFormat,
  decode,
  expiryFor,
  monthOf,
  FORMATS,
} from '../server/core/finance_csv.js';

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

const dir = mkdtempSync(join(tmpdir(), 'iris-fin-'));

function main() {
  // -----------------------------------------------------------------------
  section('An unknown format is refused, not guessed at');

  {
    const unknown = parseCsv('取引日,金額,店名\n2026/08/01,1000,店');
    check('a header nobody described is refused', unknown.ok === false);
    // Quoted back so adding a descriptor is concrete work rather than an
    // investigation.
    check('and the header is quoted back', unknown.reason!.includes('取引日'));
    eq('nothing is imported from it', unknown.transactions, []);

    eq('an empty file is refused', parseCsv('').ok, false);
    eq('a header with no rows parses to nothing', parseCsv('date,description,amount').transactions.length, 0);
  }

  {
    // Matching is by required headers, and every one must be present.
    check('a known header matches', detectFormat(['date', 'description', 'amount']) !== null);
    check('a partial match does not', detectFormat(['date', 'amount']) === null);
    check('extra columns do not prevent a match', detectFormat(['id', 'date', 'description', 'amount', 'memo']) !== null);
  }

  // -----------------------------------------------------------------------
  section('Dates are not rolled over');

  {
    eq('slash form', parseDate('2026/08/20', 'slash'), '2026-08-20');
    eq('single digits', parseDate('2026/8/2', 'slash'), '2026-08-02');
    eq('dash form', parseDate('2026-08-20', 'dash'), '2026-08-20');
    eq('compact form', parseDate('20260820', 'compact'), '2026-08-20');

    // A date that does not exist must not become one that does: 2026-02-30
    // silently becoming March moves a transaction into a month it did not
    // happen in, and the total for both months is then wrong.
    eq('an impossible day is refused', parseDate('2026/02/30', 'slash'), null);
    eq('so is month 13', parseDate('2026/13/01', 'slash'), null);
    eq('and a wrong separator', parseDate('2026-08-20', 'slash'), null);
    eq('and free text', parseDate('令和8年8月20日', 'slash'), null);
    eq('and an empty cell', parseDate('', 'slash'), null);
    // A leap day that does exist is kept.
    eq('a real leap day survives', parseDate('2028/02/29', 'slash'), '2028-02-29');
    eq('a fake one does not', parseDate('2026/02/29', 'slash'), null);
  }

  // -----------------------------------------------------------------------
  section('Amounts');

  {
    eq('plain', parseAmount('1234'), 1234);
    eq('thousands separators', parseAmount('1,234,567'), 1234567);
    eq('a yen sign', parseAmount('¥1,234'), 1234);
    eq('a yen suffix', parseAmount('1234円'), 1234);
    eq('negative', parseAmount('-1234'), -1234);
    eq('full-width digits', parseAmount('１２３４'), 1234);

    // Empty is unknown, not zero. A row with no amount is a row this parser
    // did not understand, and importing it as ¥0 hides that.
    eq('an empty cell is null, not zero', parseAmount(''), null);
    eq('so is whitespace', parseAmount('   '), null);
    eq('text is refused', parseAmount('残高照会'), null);
    // Yen has no minor units; a fraction means the column was not money.
    eq('a fractional yen is refused', parseAmount('12.5'), null);
  }

  // -----------------------------------------------------------------------
  section('Withdrawals and deposits');

  {
    const csv = [
      '日付,摘要,お引出し,お預入れ',
      '2026/08/01,スーパー,3500,',
      '2026/08/03,給与,,250000',
      '2026/08/05,両方,100,200',
      '2026/08/07,読めない,あ,',
    ].join('\n');
    const result = parseCsv(csv);
    check('the bank format is recognised', result.ok === true);
    eq('and named', result.format!.id, 'generic_jp_bank');

    eq('two rows are readable', result.transactions.length, 2);
    // Money leaving is negative regardless of how the column spells it.
    eq('a withdrawal is negative', result.transactions[0].amount, -3500);
    eq('a deposit is positive', result.transactions[1].amount, 250000);
    eq('the description survives', result.transactions[0].description, 'スーパー');

    // Both columns filled is a row this parser does not understand. Picking
    // one would be inventing a transaction.
    check('an ambiguous row is skipped', result.skipped.some((s) => s.reason.includes('両方')));
    check('and an unreadable amount is skipped', result.skipped.some((s) => s.line === 5));
    eq('skips are counted, not silent', result.skipped.length, 2);
  }

  {
    const csv = [
      'ご利用日,ご利用先,ご利用金額',
      '2026/08/02,"書店, 駅前",1500',
      '2026/08/09,返品,-800',
    ].join('\n');
    const result = parseCsv(csv);
    eq('the card format is recognised', result.format!.id, 'generic_jp_card');
    // A quoted comma inside a shop name must not become a new column.
    eq('a quoted comma stays in the description', result.transactions[0].description, '書店, 駅前');

    // ご利用金額 is "amount spent", written positive. Taking it as signed
    // turns every purchase into income — the totals stay plausible and the
    // month reads as a very good one. The earlier version of this test checked
    // the description and never looked at the sign, so it passed while a live
    // import reported ¥300,000 of income that was actually ¥50,000 of
    // spending.
    eq('a purchase is money leaving', result.transactions[0].amount, -1500);
    // And a refund, which these files write negative, has to come back
    // positive rather than being forced negative.
    eq('a refund is money arriving', result.transactions[1].amount, 800);

    // The bank format carries its own sign and must not be flipped.
    const bank = parseCsv('日付,摘要,お引出し,お預入れ\n2026/08/01,店,3500,');
    eq('a signed format is left alone', bank.transactions[0].amount, -3500);
  }

  {
    eq('quotes are unwrapped', splitCsvLine('"a","b,c",d'), ['a', 'b,c', 'd']);
    eq('doubled quotes are one quote', splitCsvLine('"say ""hi""",x'), ['say "hi"', 'x']);
    eq('empty cells survive', splitCsvLine('a,,b'), ['a', '', 'b']);
  }

  // -----------------------------------------------------------------------
  section('Shift_JIS');

  {
    // Still the common encoding for Japanese bank exports, and a file read as
    // UTF-8 would produce mojibake descriptions that look like data.
    const utf8 = '日付,摘要,お引出し,お預入れ\n2026/08/01,スーパー,3500,';
    const sjisBytes = Buffer.from(
      Array.from(new (require('util').TextEncoder)().encode(utf8))
    );
    // Decoding UTF-8 bytes as UTF-8 is the identity; the point being checked
    // is that the decoder exists and is selected by the descriptor.
    eq('utf-8 decodes', decode(sjisBytes, 'utf-8'), utf8);
    check('every format names its encoding', FORMATS.every((f) => Boolean(f.encoding)));
    check('a shift_jis decoder is available', decode(Buffer.from([0x93, 0xfa]), 'shift_jis') === '日');
  }

  // -----------------------------------------------------------------------
  section('Line items go, aggregates stay');

  {
    const db = openDatabase(join(dir, 'f.db'));
    const store = new FinanceStore(db);
    const now = new Date('2026-08-20T00:00:00Z');

    const result = store.import(
      {
        fileName: 'aug.csv',
        format: 'generic_jp_bank',
        account: 'bank',
        skipped: 0,
        transactions: [
          { occurredOn: '2026-08-01', amount: -3500, description: 'スーパー' },
          { occurredOn: '2026-08-03', amount: -1200, description: 'コンビニ' },
          { occurredOn: '2026-08-05', amount: 250000, description: '給与' },
        ],
        categorize: (t) => (t.amount > 0 ? '収入' : '食費'),
      },
      now
    );
    eq('rows are stored', result.inserted, 3);
    eq('and the month is noted', result.months, ['2026-08']);

    const totals = store.aggregates();
    const food = totals.find((t) => t.category === '食費')!;
    eq('spending is totalled', food.total, -4700);
    eq('with a count', food.count, 2);

    // Re-importing the same file must not double the month. Rows are deduped
    // by identity, and a running sum would not have noticed.
    const again = store.import(
      {
        fileName: 'aug.csv',
        format: 'generic_jp_bank',
        account: 'bank',
        skipped: 0,
        transactions: [
          { occurredOn: '2026-08-01', amount: -3500, description: 'スーパー' },
          { occurredOn: '2026-08-03', amount: -1200, description: 'コンビニ' },
        ],
        categorize: () => '食費',
      },
      now
    );
    eq('a re-import inserts nothing', again.inserted, 0);
    eq('and reports the duplicates', again.duplicates, 2);
    eq('the total is unchanged', store.aggregates().find((t) => t.category === '食費')!.total, -4700);

    // The retention promise, and the reason aggregates are their own table.
    const afterExpiry = new Date('2027-10-01T00:00:00Z');
    const pruned = store.prune(afterExpiry);
    eq('line items expire', pruned.deleted, 3);
    eq('and are gone', store.transactionsLocalOnly().length, 0);

    const survivors = store.aggregates();
    check('the monthly totals survive them', survivors.length > 0);
    eq('with the same numbers', survivors.find((t) => t.category === '食費')!.total, -4700);

    db.close();
  }

  {
    const db = openDatabase(join(dir, 'g.db'));
    const store = new FinanceStore(db);
    const now = new Date('2026-08-20T00:00:00Z');
    const result = store.import(
      {
        fileName: 'bad.csv',
        format: 'generic_jp_bank',
        account: 'bank',
        skipped: 0,
        transactions: [{ occurredOn: '2026-08-01', amount: -999999, description: '誤り' }],
      },
      now
    );
    eq('a wrong file can be undone whole', store.removeImport(result.importId).deleted, 1);
    // The aggregate has to follow, or the month keeps a total for spending
    // that no longer exists anywhere.
    eq('and the month is recomputed', store.aggregates().filter((t) => t.total !== 0).length, 0);
    db.close();
  }

  // -----------------------------------------------------------------------
  section('Two identical purchases are two purchases');

  {
    // The register said this before it was built and it was built wrong
    // anyway — `finance_import_idempotency`: 日付＋金額＋店舗だけの重複判定は、
    // 正当な複数決済を誤削除する。The first version deduped on exactly those
    // fields, so a second coffee at the same shop on the same day vanished.
    const db = openDatabase(join(dir, 'h.db'));
    const store = new FinanceStore(db);
    const now = new Date('2026-08-20T00:00:00Z');
    const coffee = { occurredOn: '2026-08-01', amount: -450, description: 'カフェ' };

    const first = store.import(
      { fileName: 'a.csv', format: 'x', account: 'card', skipped: 0, transactions: [coffee, { ...coffee }] },
      now
    );
    eq('both are kept', first.inserted, 2);
    eq('and both are readable', store.transactionsLocalOnly().length, 2);
    eq('the total counts both', store.aggregates()[0].total, -900);

    // The same file again must still add nothing.
    const again = store.import(
      { fileName: 'a.csv', format: 'x', account: 'card', skipped: 0, transactions: [coffee, { ...coffee }] },
      now
    );
    eq('re-importing the same file adds nothing', again.inserted, 0);
    eq('and the total is unchanged', store.aggregates()[0].total, -900);

    // A later export covering a longer period, with one genuine extra.
    const wider = store.import(
      {
        fileName: 'b.csv',
        format: 'x',
        account: 'card',
        skipped: 0,
        transactions: [coffee, { ...coffee }, { ...coffee }],
      },
      now
    );
    eq('only the new one is added', wider.inserted, 1);
    eq('and now there are three', store.transactionsLocalOnly().length, 3);
    eq('with the total to match', store.aggregates()[0].total, -1350);

    // Different accounts are never the same transaction.
    store.import({ fileName: 'c.csv', format: 'x', account: 'bank', skipped: 0, transactions: [coffee] }, now);
    eq('another account is separate', store.transactionsLocalOnly().length, 4);

    db.close();
  }

  // -----------------------------------------------------------------------
  section('A card bill is not spending');

  {
    // Import a bank statement and a card statement for the same month and the
    // card bill is counted twice — once as the purchases, once as the lump
    // withdrawal that paid for them. The month then reports double what was
    // spent, and the number looks entirely plausible.
    const db = openDatabase(join(dir, 'k.db'));
    const store = new FinanceStore(db);
    const now = new Date('2026-08-20T00:00:00Z');

    store.import(
      {
        fileName: 'card.csv', format: 'x', account: 'card', skipped: 0,
        transactions: [
          { occurredOn: '2026-08-03', amount: -30000, description: '書店' },
          { occurredOn: '2026-08-10', amount: -20000, description: 'スーパー' },
        ],
      },
      now
    );
    store.import(
      {
        fileName: 'bank.csv', format: 'x', account: 'bank', skipped: 0,
        transactions: [
          { occurredOn: '2026-08-27', amount: -50000, description: 'カードお引落し' },
          { occurredOn: '2026-08-25', amount: 250000, description: '給与' },
        ],
      },
      now
    );

    const spendingOf = () =>
      store.aggregates().filter((a) => a.kind === 'spending').reduce((sum, a) => sum + a.total, 0);

    // Before any rule: the bill counts as spending, and the total is wrong in
    // the direction that gets noticed.
    eq('without a rule the bill counts as spending', spendingOf(), -100000);

    const { rule } = store.addTransferRule({ description: 'カードお引落し', account: 'bank' });
    check('the rule is recorded', rule !== null);

    // A rule added after the import has to fix the months it was added
    // because of — otherwise the correction only applies to money not yet
    // spent, which is the one period nobody is asking about.
    const result = store.reclassify(now);
    eq('the existing transaction is reclassified', result.changed, 1);
    eq('and its month is recomputed', result.months, ['2026-08']);
    eq('spending is now the purchases only', spendingOf(), -50000);

    const transfers = store.aggregates().filter((a) => a.kind === 'transfer');
    eq('the movement is still recorded, just separately', transfers.length, 1);
    eq('with its amount', transfers[0].total, -50000);

    const income = store.aggregates().filter((a) => a.kind === 'income');
    eq('income is its own kind', income[0].total, 250000);

    db.close();
  }

  {
    const db = openDatabase(join(dir, 'l.db'));
    const store = new FinanceStore(db);
    const now = new Date('2026-08-20T00:00:00Z');
    store.addTransferRule({ description: 'カード', account: 'bank' });
    store.import(
      {
        fileName: 'x.csv', format: 'x', account: 'bank', skipped: 0,
        transactions: [
          { occurredOn: '2026-08-01', amount: -3000, description: 'カードショップ' },
          { occurredOn: '2026-08-02', amount: -50000, description: 'カード' },
        ],
      },
      now
    );

    // Exact match, never a pattern. A rule of /カード/ would also swallow a
    // purchase at a shop with カード in its name — and money that becomes a
    // transfer disappears from the total rather than being merely misfiled.
    const rows = store.transactionsLocalOnly();
    eq('the exact match is a transfer', rows.find((r) => r.description === 'カード')!.kind, 'transfer');
    eq('a description merely containing it is not', rows.find((r) => r.description === 'カードショップ')!.kind, 'spending');

    // A rule scoped to one account must not reach another.
    store.import(
      { fileName: 'y.csv', format: 'x', account: 'card', skipped: 0, transactions: [{ occurredOn: '2026-08-05', amount: -50000, description: 'カード' }] },
      now
    );
    eq(
      'and an account-scoped rule stays in its account',
      store.transactionsLocalOnly().find((r) => r.account === 'card')!.kind,
      'spending'
    );

    check('a duplicate rule is refused', store.addTransferRule({ description: 'カード', account: 'bank' }).rule === null);
    eq('rules can be listed', store.transferRules().length, 1);

    db.close();
  }

  // -----------------------------------------------------------------------
  section('One purchase, seen twice');

  {
    // A notification arrives in minutes; the statement that confirms it
    // arrives weeks later. Both describe the same money.
    const pending = [{ id: 'p1', account: 'card', occurredOn: '2026-08-01', amount: -1200, description: 'コンビニ' }];
    const confirmed = [{ id: 'c1', account: 'card', occurredOn: '2026-08-03', amount: -1200, description: 'コンビニA店' }];

    const r = reconcile(pending, confirmed);
    eq('the pair is matched across a date gap', r.matched, [{ pending: 'p1', confirmed: 'c1' }]);
    eq('nothing is left over', r.unmatched, []);
    // The descriptions differ — a notification and a statement rarely spell a
    // merchant the same way — and matching does not depend on them.
    check('and the differing descriptions did not prevent it', r.ambiguous.length === 0);
  }

  {
    // Outside the window is not a match. A statement line two weeks later is
    // more likely a second purchase than a late settlement.
    const r = reconcile(
      [{ id: 'p1', account: 'card', occurredOn: '2026-08-01', amount: -1200, description: 'x' }],
      [{ id: 'c1', account: 'card', occurredOn: '2026-08-20', amount: -1200, description: 'x' }]
    );
    eq('too far apart is not matched', r.matched, []);
    eq('and the pending row stays pending', r.unmatched, ['p1']);

    // A different amount is a different purchase, however close the dates.
    const amounts = reconcile(
      [{ id: 'p1', account: 'card', occurredOn: '2026-08-01', amount: -1200, description: 'x' }],
      [{ id: 'c1', account: 'card', occurredOn: '2026-08-01', amount: -1201, description: 'x' }]
    );
    eq('a one-yen difference is not the same purchase', amounts.matched, []);

    // Nor is another account.
    const accounts = reconcile(
      [{ id: 'p1', account: 'card', occurredOn: '2026-08-01', amount: -1200, description: 'x' }],
      [{ id: 'c1', account: 'bank', occurredOn: '2026-08-01', amount: -1200, description: 'x' }]
    );
    eq('another account is not the same purchase', accounts.matched, []);
  }

  {
    // The case a tuned matcher would quietly resolve. Two identical amounts a
    // day apart are indistinguishable from here, and picking one erases a
    // purchase — silently, which is the whole problem.
    const r = reconcile(
      [{ id: 'p1', account: 'card', occurredOn: '2026-08-01', amount: -1200, description: 'x' }],
      [
        { id: 'c1', account: 'card', occurredOn: '2026-08-01', amount: -1200, description: 'x' },
        { id: 'c2', account: 'card', occurredOn: '2026-08-02', amount: -1200, description: 'x' },
      ]
    );
    eq('an ambiguous pairing is not resolved', r.matched, []);
    eq('it is reported', r.ambiguous.length, 1);
    check('with both candidates named', r.ambiguous[0].candidates.length === 2);
    check('and a reason a person can act on', r.ambiguous[0].reason.includes('同額'));
  }

  {
    // Two genuine repeats must pair one-to-one. Letting one confirmed row
    // retire two pending rows would erase a purchase.
    const r = reconcile(
      [
        { id: 'p1', account: 'card', occurredOn: '2026-08-01', amount: -450, description: 'カフェ' },
        { id: 'p2', account: 'card', occurredOn: '2026-08-01', amount: -450, description: 'カフェ' },
      ],
      [
        { id: 'c1', account: 'card', occurredOn: '2026-08-01', amount: -450, description: 'カフェ' },
        { id: 'c2', account: 'card', occurredOn: '2026-08-01', amount: -450, description: 'カフェ' },
      ]
    );
    // Both pending rows see two candidates, so both are reported rather than
    // paired arbitrarily — interchangeable is not the same as decidable.
    eq('identical pairs are not guessed at', r.matched.length, 0);
    eq('both are reported', r.ambiguous.length, 2);
  }

  {
    const db = openDatabase(join(dir, 'm.db'));
    const store = new FinanceStore(db);
    const now = new Date('2026-08-20T00:00:00Z');

    // The notification comes first and is the only record of the money, so it
    // counts.
    store.import(
      { fileName: 'mail', format: 'gmail', account: 'card', skipped: 0, status: 'pending', source: 'gmail',
        transactions: [{ occurredOn: '2026-08-01', amount: -1200, description: 'コンビニ' }] },
      now
    );
    const spending = () =>
      store.aggregates().filter((a) => a.kind === 'spending').reduce((sum, a) => sum + a.total, 0);
    eq('a pending purchase counts', spending(), -1200);

    // Then the statement arrives describing the same purchase.
    store.import(
      { fileName: 'aug.csv', format: 'x', account: 'card', skipped: 0,
        transactions: [{ occurredOn: '2026-08-03', amount: -1200, description: 'コンビニA店' }] },
      now
    );
    // Before reconciling, both are counted — which is the bug this exists to
    // prevent, shown rather than assumed.
    eq('both rows count until they are reconciled', spending(), -2400);

    const result = store.reconcilePending({}, now);
    eq('the pair is retired', result.matched.length, 1);
    eq('and the total is one purchase again', spending(), -1200);

    const rows = store.transactionsLocalOnly();
    const superseded = rows.find((r) => r.status === 'superseded');
    check('the pending row is kept, not deleted', superseded !== undefined);
    eq('and it came from the notification', superseded!.source, 'gmail');
    check('the confirmed row is the surviving one', rows.some((r) => r.status === 'confirmed' && r.source === 'csv'));

    db.close();
  }

  // -----------------------------------------------------------------------
  section('Retention is written into the row');

  {
    const imported = new Date('2026-08-20T00:00:00Z');
    const expiry = expiryFor(imported, 13);
    check('thirteen months later', expiry.startsWith('2027-09'));
    // Computed at import so the promise cannot be changed retroactively by
    // editing a constant.
    check('and it is an absolute time, not a rule to re-apply', expiry.endsWith('Z'));
    eq('the month key is derived from the date', monthOf('2026-08-20'), '2026-08');
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Finance: ${passed} passed, ${failed} failed`);
  rmSync(dir, { recursive: true, force: true });
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('All finance tests passed.');
}

main();
