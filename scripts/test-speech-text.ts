/**
 * Spoken-notation rewriting tests.
 *
 * The failure this exists for did not sound like a failure. Chirp 3 HD read
 * `8/24` as 「にじゅうよんぶんのはち」 — twenty-four over eight — fluently and
 * with correct intonation. Nothing about the audio was wrong except the
 * meaning, which is the hardest kind of error to catch by listening.
 *
 * So the tests are mostly about the boundaries: what must be rewritten, and
 * what must be left alone even though it looks similar. Rewriting too eagerly
 * produces the same class of error in the other direction.
 *
 * Run: npm run test:speech-text
 */
import { normalizeForSpeech } from '../server/services/speech_text.js';

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
const say = (s: string) => normalizeForSpeech(s).text;

function main() {
  // -----------------------------------------------------------------------
  section('The reading that was actually wrong');

  {
    eq('a slash date becomes a Japanese date', say('8/24の試験'), '8月24日の試験');
    eq('single digits too', say('9/3に提出'), '9月3日に提出');
    eq('leading zeros are dropped', say('08/04'), '8月4日');
    eq('several in one line', say('8/20と8/21'), '8月20日と8月21日');
    // The rewrite is reported, so a rule that fires wrongly can be found by
    // eye after being noticed by ear.
    const { applied } = normalizeForSpeech('8/24の試験');
    eq('the rewrite is recorded', applied, [{ from: '8/24', to: '8月24日' }]);
  }

  // -----------------------------------------------------------------------
  section('What must not be turned into a date');

  {
    // Outside a real month or day it is arithmetic, and reading it as a date
    // would be inventing one.
    eq('an impossible month is left alone', say('24/8'), '24/8');
    eq('an impossible day is left alone', say('8/45'), '8/45');
    eq('and zero is not a month', say('0/5'), '0/5');

    // Three numbers is a version or a path.
    eq('a version is left alone', say('v1/2/3'), 'v1/2/3');
    eq('a path is left alone', say('~/Documents/iris/'), '~/Documents/iris/');
    eq('a URL is left alone', say('https://example.com/8/24'), 'https://example.com/8/24');
    eq('an api path is left alone', say('/api/calendar'), '/api/calendar');

    // Attached to other characters it is not a bare date.
    eq('a ratio inside a word is left alone', say('A/B'), 'A/B');
  }

  // -----------------------------------------------------------------------
  section('Clock times');

  {
    eq('a clock time is spelled out', say('19:30に開始'), '19時30分に開始');
    eq('on the hour drops the minutes', say('8:00'), '8時');
    eq('seconds are kept when present', say('19:30:45'), '19時30分45秒');
    eq('a single-digit hour works', say('9:05'), '9時5分');

    // Not every colon between numbers is a time.
    eq('an impossible hour is left alone', say('25:00'), '25:00');
    eq('an impossible minute is left alone', say('19:70'), '19:70');
    // Minutes are two digits in a clock time. `1:1` is a ratio or a score,
    // and the expectation here was written the wrong way round first time —
    // the code was already correct.
    eq('a ratio is left alone', say('1:1'), '1:1');
    eq('and a score too', say('3:2で勝利'), '3:2で勝利');
  }

  // -----------------------------------------------------------------------
  section('The timestamps the calendar actually produces');

  {
    // These arrive from the merged calendar reading, which is where most of
    // what IRIS reads aloud comes from.
    eq(
      'an offset timestamp becomes a date and a time',
      say('2026-08-21T20:00:00+09:00'),
      '2026年8月21日20時'
    );
    eq('minutes are kept when there are any', say('2026-08-20T19:30:00+09:00'), '2026年8月20日19時30分');
    eq('a bare ISO date works', say('2026-08-24'), '2026年8月24日');
    eq('a Z timestamp works', say('2026-08-24T08:30:00Z'), '2026年8月24日8時30分');

    // The clock rule must not get at the middle of a timestamp first.
    check('a timestamp is not half-rewritten', !say('2026-08-21T20:00:00+09:00').includes('-'));
  }

  // -----------------------------------------------------------------------
  section('A whole line of the kind IRIS says');

  {
    const line =
      'おはようございます。8/24の神経科学本試験まで、あと5日です。' +
      '次の予定は8/20 19:30のそよかぜ書店。TSK-009の起点作成は8/21が締切です。';
    const spoken = say(line);
    check('the dates are all rewritten', !/\d\/\d/.test(spoken), spoken);
    check('the clock is rewritten', spoken.includes('19時30分'), spoken);
    // Identifiers with digits must survive: TSK-009 is a name, not a date.
    check('an identifier is untouched', spoken.includes('TSK-009'), spoken);
    check('and the prose is unchanged', spoken.startsWith('おはようございます。'));
  }

  {
    // Nothing to do is the common case and must cost nothing.
    const plain = '今日の学習は記述式の問題から始めることをお勧めします。';
    eq('a line with no notation is returned unchanged', say(plain), plain);
    eq('and reports no rewrites', normalizeForSpeech(plain).applied.length, 0);
    eq('empty input is safe', say(''), '');
  }


  // -----------------------------------------------------------------------
  section('Amounts, heard wrong in two ways at once');

  {
    // Heard on 2026-08-19: `¥5,000` came out as 「5円、れいれいれい」. The comma
    // split the number, the leading `¥5` was read as five yen, and the
    // remaining `000` as three zeroes in a row. Both halves wrong, and neither
    // sounded like a malfunction.
    eq('a separated amount is read as one number', say('¥5,000を下回る'), '5000円を下回る');
    eq('the symbol moves after the amount', say('¥5000'), '5000円');
    eq('separators go from any size of number', say('1,234,567円'), '1234567円');
    eq('dollars work too', say('$19.99'), '19.99ドル');
    eq('and a full-width yen sign', say('￥1,200'), '1200円');

    // A comma in prose is not a thousands separator, and neither is one
    // between two small numbers.
    eq('prose commas are left alone', say('りんご, みかん'), 'りんご, みかん');
    eq('and a list of small numbers is not one number', say('3,4番'), '3,4番');
    eq('nor is a two-digit group', say('12,34'), '12,34');

    // The rules have to compose: separators are removed before the currency
    // rule looks, or it matches only the leading digits.
    eq('an amount inside a sentence with a date', say('2026-08-24の¥1,000'), '2026年8月24日の1000円');
  }


  // -----------------------------------------------------------------------
  section('Counters that need a number in front of them');

  {
    // Heard on 2026-08-19: `30問` came out as さんじゅうとい. The reading of 問
    // depends on whether a number precedes it, so this is a rule about the
    // pair rather than a word to look up — which is why the reading
    // dictionary, whose entries are plain substitutions, cannot express it.
    eq('a counted 問 is もん', say('記述式の30問'), '記述式の30もん');
    eq('including a single one', say('1問が完了'), '1もんが完了');
    eq('and several in a sentence', say('10問中1問が完了'), '10もん中1もんが完了');
    eq('and after 第', say('第3問'), '第3もん');

    // The words that must not be touched. A bare 問 is とい, and 問い合わせ
    // would be ruined by a blanket substitution.
    eq('問い合わせ is left alone', say('問い合わせが2件'), '問い合わせが2件');
    eq('一問一答 has no digits and is left alone', say('一問一答'), '一問一答');
    eq('and 問い after a number is still 問い', say('30問い'), '30問い');
  }

  section('Markdown, which is layout and not speech');

  {
    // 2026-08-20, asked 「今日の予定は」 out loud. The reply was a markdown
    // list and the voice read the marks: 「アスタリスク 件名 アスタリスク」.
    // It then heard itself say 「アスタ」, could not match that against its
    // own script — which holds `**`, not the word — decided someone was
    // interrupting, and stopped mid-sentence.
    eq('emphasis loses its marks', say('**件名:** そよかぜ書店'), '件名: そよかぜ書店');
    eq('single asterisks too', say('*強調*された'), '強調された');
    eq('and underscores', say('__太字__です'), '太字です');
    eq('and backticks', say('`code` を実行'), 'code を実行');
    eq('a list marker is dropped', say('- 職場'), '職場');
    eq('whichever marker it is', say('* 職場'), '職場');
    eq('and a heading marker', say('## 今日の予定'), '今日の予定');

    eq(
      'the calendar reply that started this',
      say('- **時間:** 19:30 〜'),
      '時間: 19時30分 〜'
    );

    // Marks are removed; arithmetic and prose are not.
    eq('a lone asterisk is left alone', say('3 * 4 の答え'), '3 * 4 の答え');
    eq('a hyphen inside a sentence stays', say('東京-大阪'), '東京-大阪');
    eq('and one that opens nothing stays', say('注意*'), '注意*');
  }

  section('A table is read as its cells, not its pipes');

  {
    // Tables arrived with the reading layer, and the voice inherits them.
    // Left alone they would be read out as 「たてぼう」 the way the asterisks
    // were read as 「アスタリスク」 — the same failure one level up.
    eq('the separator row is not spoken', say('|季節|気温|\n|---|---|\n|春|15度|'), '季節 気温\n春 15度');
    eq('a lone pipe in a sentence stays', say('A|B の形式'), 'A|B の形式');
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Spoken notation: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('All spoken-notation tests passed.');
}

main();
