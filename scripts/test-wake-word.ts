/**
 * Wake word tests.
 *
 * `src/App.tsx` states the constraint this operates under: the microphone
 * hears the room, not a decision to talk to IRIS, so a transcript goes into
 * the input box rather than being sent. That design is kept — this only
 * decides which utterances may skip the manual send.
 *
 * The two failures are not symmetric. Missing a wake word costs a button
 * press. Inventing one sends a private remark to a cloud model. So most of
 * this file is about not matching.
 *
 * Run: npm run test:wake-word
 */
import { detectWakeWord, WAKE_WORDS } from '../server/core/wake_word.js';

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

function main() {
  // -----------------------------------------------------------------------
  section('The name, however it was heard');

  {
    // 「イーリス」 is the name. Japanese recognition moves between hiragana,
    // katakana and romaji by context, and a long vowel is where it wavers —
    // accepting one spelling would be a name that works on most days.
    for (const spelling of ['イーリス', 'いーりす', 'イリス', 'いりす', 'アイリス', 'あいりす', 'IRIS', 'iris']) {
      const r = detectWakeWord(`${spelling}、今日の予定は？`);
      check(`${spelling} is heard as the name`, r.addressed, JSON.stringify(r));
      eq(`  and the request survives (${spelling})`, r.request, '今日の予定は？');
    }
  }

  {
    // Separators vary with the transcriber and must not eat the request.
    eq('a full-width comma', detectWakeWord('イーリス、明日の予定').request, '明日の予定');
    eq('a space', detectWakeWord('イーリス 明日の予定').request, '明日の予定');
    // Matched. Requiring a separator was the first rule and it did not survive
    // contact: spoken naturally there is no pause, and the transcriber wrote
    // 「イリス今日の予定は。」 with no comma. Every real request would have
    // landed in the input box — the feature not working.
    eq('no separator still works', detectWakeWord('イーリス明日の予定').request, '明日の予定');
    // The exact utterance from the first live attempt, 2026-08-20.
    const live = detectWakeWord('イリス今日の予定は。');
    check('the utterance that failed live now sends', live.addressed);
    eq('with the request intact', live.request, '今日の予定は。');
    eq('full-width romaji', detectWakeWord('ＩＲＩＳ 明日の予定').request, '明日の予定');

    // The name on its own is an address with no request — answered rather
    // than left silently in the box.
    const alone = detectWakeWord('イーリス');
    check('the name alone counts as addressed', alone.addressed);
    eq('with an empty request', alone.request, '');
  }

  // -----------------------------------------------------------------------
  section('What must never be sent');

  {
    // The failure the input-box design exists to prevent: a remark to someone
    // else in the room becoming a request to a cloud model.
    const remark = detectWakeWord('あとでコンビニ行くわ');
    check('a remark to someone else is not addressed', !remark.addressed);
    // Kept, not discarded: the user chose that a miss leaves the utterance in
    // the input box so nothing is lost.
    eq('but the words are kept', remark.request, 'あとでコンビニ行くわ');
    eq('and nothing matched', remark.matched, null);
  }

  {
    // The name in the middle is someone being talked *about*.
    check('mid-sentence is not an address', !detectWakeWord('さっきイーリスが言ってたやつ').addressed);
    check('nor at the end', !detectWakeWord('それってイーリス？').addressed);
    // The assertion this replaces could not fail — it was written as
    // `!x === false || true`. It was hiding a real false positive: a remark
    // about a shelf opens with a matching spelling and would have been sent.
    check('a proper noun starting with the name is not an address',
      !detectWakeWord('アイリスオーヤマの棚買った').addressed);
    check('nor is a longer word that merely begins with it',
      !detectWakeWord('イリスコーポレーションに電話した').addressed);

    // Empty and whitespace are not addresses.
    check('empty is not an address', !detectWakeWord('').addressed);
    check('whitespace is not an address', !detectWakeWord('   ').addressed);
  }

  {
    // Longest-first ordering: 「アイリス」 must not be claimed by a shorter
    // spelling that is a prefix of it, or the request would keep a stray 「ス」.
    const r = detectWakeWord('アイリス、体調どう？');
    eq('the longest matching spelling wins', r.matched, 'アイリス');
    eq('so the request is clean', r.request, '体調どう？');
  }

  {
    // Every configured spelling has to actually work, or the list is a
    // decoration.
    const broken = WAKE_WORDS.filter((w) => !detectWakeWord(`${w} テスト`).addressed);
    eq('every configured spelling matches', broken, []);
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Wake word: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('All wake word tests passed.');
}

main();
