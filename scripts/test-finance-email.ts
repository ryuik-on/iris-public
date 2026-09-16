/**
 * Card notification parsing tests.
 *
 * The fixtures are real messages, transcribed from the user's inbox on
 * 2026-08-20. That matters more here than anywhere else in this codebase: the
 * register's rule for this feature is 認識できないメールから金額を推測して記録
 * しない, and a fixture invented to match the parser proves the parser matches
 * the fixture. Twice today a format was assumed rather than read — a `--handoff`
 * flag that does not exist, and a card CSV whose amounts were positive — and
 * both passed every test until something real was put through them.
 *
 * The three issuers agree on nothing:
 *
 *   ポケットカード writes the label on one line and the value on the next, and
 *     sends `Mastercard加盟店` in place of a merchant name for every purchase.
 *   JCB writes label and value on one line, and its two notice types share a
 *     sender — so the body has to select the template.
 *   JCB's settled notice carries several purchases per message.
 *
 * Run: npm run test:finance-email
 */
import { parseEmail, detectTemplate, parseEmailDate, parseEmailAmount, normalizeWidth, EMAIL_TEMPLATES } from '../server/core/finance_email.js';

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

// ---------------------------------------------------------------- fixtures
const POCKETCARD = {
  id: 'm1',
  from: 'ポケットカード <announce@pinf.pocketcard.co.jp>',
  subject: 'ＺＯＺＯＣＡＲＤ２カード利用のお知らせ',
  body: [
    '●カード利用のお知らせ●',
    '',
    'テスト　様',
    '',
    'いつもＺＯＺＯＣＡＲＤ２をご利用いただき、誠にありがとうございます。',
    'ＺＯＺＯＣＡＲＤ２のご利用内容についてお知らせいたします。',
    '',
    '■ご利用先',
    'Mastercard加盟店',
    '',
    '■ご利用日時',
    '2026/08/20 00:05:08',
    '',
    '■ご利用金額',
    '600円',
  ].join('\n'),
};

const JCB_REALTIME = {
  id: 'm2',
  from: 'JCB Webmaster <mail@qa.jcb.co.jp>',
  subject: 'ＪＣＢカード／ショッピングご利用のお知らせ',
  body: [
    'テスト　太郎 様',
    'カード名称　：　【ＯＳ】サンプル　ＣＡＲＤ',
    '',
    'いつも【ＯＳ】サンプル　ＣＡＲＤをご利用いただきありがとうございます。',
    'ＪＣＢカードのご利用がありましたのでご連絡します。',
    '',
    '【ご利用日時(日本時間)】　2026/07/11 16:09',
    '【ご利用金額】　690円',
    '【ご利用先】　タリーズコーヒー',
    '',
    '▼ご留意点',
    '・国内の加盟店の場合、【ご利用先】はすべてカタカナ表示となります。（例：一休→イツキユウ）',
    '',
    '▼会費やサブスクリプションのお支払いでは、カードの利用時でなくても通知される場合があります',
    '　例）Amazonプライム年会費　5,900円　→　アマゾン　5,900円',
  ].join('\n'),
};

const JCB_SETTLED = {
  id: 'm3',
  from: 'JCB Webmaster <mail@qa.jcb.co.jp>',
  subject: '（売上到着分）ＪＣＢカード/ショッピングご利用のお知らせ',
  body: [
    'テスト　太郎 様',
    'カード名称　：　【ＯＳ】サンプル　ＣＡＲＤ',
    '',
    '　◆ご利用１',
    '　　【ご利用日】　2026/07/23',
    '　　【ご利用金額】　1,000円',
    '　　【ご利用先】　サンプル給油所　みなと店',
    '',
    '　※本通知は、カードご利用時に通知していないものが対象です。',
  ].join('\n'),
};

function main() {
  // -----------------------------------------------------------------------
  section('ポケットカード — label on one line, value on the next');

  {
    const r = parseEmail(POCKETCARD);
    check('it is recognised', r.ok === true, r.reason);
    eq('as pocketcard', r.template!.id, 'pocketcard');
    eq('one purchase', r.purchases.length, 1);
    eq('the date', r.purchases[0].occurredOn, '2026-08-20');
    // A notification always describes money leaving, so the sign is applied
    // here rather than trusted to the reader.
    eq('the amount is negative', r.purchases[0].amount, -600);

    // The issuer sends the same string for every purchase. Recorded as
    // unknown rather than as a shop called `Mastercard加盟店`, because a
    // category rule built on that name would silently cover everything.
    eq('the placeholder merchant is not taken as a name', r.purchases[0].description, '(利用先不明)');
    check('and it is flagged', r.purchases[0].merchantUnknown === true);
  }

  // -----------------------------------------------------------------------
  section('JCB — two notice types, one sender');

  {
    const r = parseEmail(JCB_REALTIME);
    check('the realtime notice is recognised', r.ok === true, r.reason);
    eq('as the realtime template', r.template!.id, 'jcb_realtime');
    eq('the date comes from 【ご利用日時(日本時間)】', r.purchases[0].occurredOn, '2026-07-11');
    eq('the amount', r.purchases[0].amount, -690);
    eq('and the merchant is a real name', r.purchases[0].description, 'タリーズコーヒー');
    check('so it is not flagged unknown', r.purchases[0].merchantUnknown === false);

    // The body mentions ¥5,900 twice in an explanatory example. A parser that
    // searched for "a number followed by 円" would have found it.
    eq('the example amount in the footnotes is not picked up', r.purchases.length, 1);
    check('and 5,900 is nowhere in the result', !r.purchases.some((p) => p.amount === -5900));
  }

  {
    const r = parseEmail(JCB_SETTLED);
    check('the settled notice is recognised', r.ok === true, r.reason);
    // Same sender as the realtime one; only the body distinguishes them.
    eq('as the settled template', r.template!.id, 'jcb_settled');
    eq('the date comes from 【ご利用日】', r.purchases[0].occurredOn, '2026-07-23');
    eq('the amount with a thousands separator', r.purchases[0].amount, -1000);
    // Full-width characters in the merchant name survive.
    eq('the merchant', r.purchases[0].description, 'サンプル給油所　みなと店');
  }

  {
    // The realtime template must not claim a settled message, and vice versa.
    // They share a sender, so only the body can tell them apart.
    eq('the settled body excludes the realtime template', detectTemplate(JCB_SETTLED)!.id, 'jcb_settled');
    eq('and the realtime body excludes the settled one', detectTemplate(JCB_REALTIME)!.id, 'jcb_realtime');
  }

  {
    // Several purchases in one message. Reading only the first would drop the
    // rest with nothing to show that it had.
    const many = {
      ...JCB_SETTLED,
      body: JCB_SETTLED.body.replace(
        '　※本通知は、',
        [
          '　◆ご利用２',
          '　　【ご利用日】　2026/07/24',
          '　　【ご利用金額】　2,500円',
          '　　【ご利用先】　セブンイレブン',
          '',
          '　◆ご利用３',
          '　　【ご利用日】　2026/07/25',
          '　　【ご利用金額】　380円',
          '　　【ご利用先】　ローソン',
          '',
          '　※本通知は、',
        ].join('\n')
      ),
    };
    const r = parseEmail(many);
    eq('all three are read', r.purchases.length, 3);
    eq('with their own amounts', r.purchases.map((p) => p.amount), [-1000, -2500, -380]);
    eq('and their own dates', r.purchases.map((p) => p.occurredOn), ['2026-07-23', '2026-07-24', '2026-07-25']);
  }

  // -----------------------------------------------------------------------
  section('An unknown message is skipped by name');

  {
    const unknown = {
      id: 'x',
      from: 'いつもの店 <news@example.com>',
      subject: 'ポイント進呈のお知らせ',
      body: '500円分のポイントを進呈しました。',
    };
    const r = parseEmail(unknown);
    check('nothing is taken from it', r.ok === false);
    eq('and no purchase is invented', r.purchases, []);
    // A tally of unread messages is not actionable; a sender and a subject is.
    check('the sender is named', r.reason!.includes('example.com'));
    check('and the subject', r.reason!.includes('ポイント'));
  }

  {
    // A known sender with an unfamiliar body must also fail rather than being
    // read with whatever labels happen to be present.
    const changed = { ...JCB_REALTIME, body: 'ご利用がありました。詳細はMyJCBでご確認ください。' };
    check('a known sender with a changed body is refused', parseEmail(changed).ok === false);
  }

  {
    // A matched template with an unreadable block reports the block rather
    // than recording a purchase with a missing field.
    const broken = {
      ...POCKETCARD,
      body: POCKETCARD.body.replace('600円', 'ご確認ください'),
    };
    const r = parseEmail(broken);
    check('a purchase with no readable amount is not recorded', r.purchases.length === 0);
    eq('the block is reported', r.skipped.length, 1);
    check('with a reason', r.skipped[0].reason.includes('金額'));
  }

  // -----------------------------------------------------------------------
  section('Widths and formats');

  {
    eq('full-width digits become ascii', normalizeWidth('１２３'), '123');
    eq('full-width colon', normalizeWidth('：'), ':');
    eq('full-width slash', normalizeWidth('／'), '/');

    eq('a date with a time', parseEmailDate('2026/08/20 00:05:08'), '2026-08-20');
    eq('a date without one', parseEmailDate('2026/07/23'), '2026-07-23');
    eq('single-digit month and day', parseEmailDate('2026/7/3'), '2026-07-03');
    // A date that does not exist must not roll into the next month.
    eq('an impossible day is refused', parseEmailDate('2026/02/30'), null);
    eq('text is refused', parseEmailDate('ご確認ください'), null);

    eq('a thousands separator', parseEmailAmount('1,000円'), 1000);
    eq('full-width digits in an amount', parseEmailAmount('６９０円'), 690);
    eq('no yen sign needed', parseEmailAmount('600'), 600);
    // Empty is unknown, not free.
    eq('an empty amount is null', parseEmailAmount(''), null);
    eq('text is refused', parseEmailAmount('ご確認ください'), null);
  }

  {
    // Every template must name a sender and at least one required marker, or
    // it would match on the sender alone.
    check('every template names a sender', EMAIL_TEMPLATES.every((t) => t.sender.length > 0));
    check('and at least one body marker', EMAIL_TEMPLATES.every((t) => t.requires.length > 0));
    check('and a label for every field', EMAIL_TEMPLATES.every((t) => t.fields.date.length > 0 && t.fields.amount.length > 0));
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Card notifications: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('All card notification tests passed.');
}

main();
