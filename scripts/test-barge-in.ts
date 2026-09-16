/**
 * Barge-in tests.
 *
 * The mechanism is trivial and is not what these test. What they test is the
 * single fact that makes naive barge-in useless: the microphone hears the
 * speaker. Wired directly, IRIS begins a sentence, its own voice comes back as
 * a partial transcript, and it interrupts itself on the first word — every
 * time, in every room.
 *
 * So most of this file is about refusing to stop. Being wrong one way costs an
 * interruption that should not have happened; being wrong the other way costs
 * an assistant that talks over its user. The second is worse, which is why the
 * filters are kept as loose as they can be while still surviving the echo.
 *
 * Run: npm run test:barge-in
 */
import { shouldBargeIn, looksLikeSelfEcho } from '../server/core/barge_in.js';

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

const T0 = 1_000_000;
const SAYING =
  'おはようございます。8月24日の神経科学本試験まで、あと5日です。' +
  '今日の学習は、記述式の30問から始めることをお勧めします。';

/** Speaking, and past the grace period. */
const speaking = { speakingText: SAYING, startedAt: T0 };
const later = T0 + 5_000;

function main() {
  // -----------------------------------------------------------------------
  section('The assistant must not interrupt itself');

  {
    // The failure this whole module exists for. Every one of these is a
    // fragment of what is currently being said, arriving back through the
    // microphone.
    for (const echo of [
      'おはようございます',
      '8月24日の神経科学',
      '本試験まで、あと5日です',
      '記述式の30問から',
      'から始めることをお勧め',
    ]) {
      eq(`"${echo}" is recognised as its own voice`, shouldBargeIn(echo, speaking, later).reason, 'self_echo');
    }

    // Recognition does not return the punctuation that was synthesised, and
    // Japanese recognition returns none at all.
    eq(
      'echo is recognised without punctuation',
      shouldBargeIn('おはようございます8月24日の神経科学本試験まで', speaking, later).reason,
      'self_echo'
    );
    // Nor does it always start where the utterance did.
    eq(
      'and from the middle of the utterance',
      shouldBargeIn('あと5日です今日の学習は', speaking, later).reason,
      'self_echo'
    );
  }

  {
    // Recognition is imperfect, so an echo arrives slightly wrong. A run of it
    // still has to be found.
    eq(
      'a partly-misheard echo is still an echo',
      shouldBargeIn('記述式の30問からはじめる', speaking, later).reason,
      'self_echo'
    );
  }

  {
    // The failure a live test produced and the unit tests did not.
    //
    // Recognition wrote `8月二十 4日` for spoken `8月24日`, so the longest
    // matching run is capped at that divergence. Under a fractional threshold
    // the requirement grew with the partial while the achievable match did
    // not: it suppressed correctly for two seconds and then interrupted
    // itself. Every one of these is the assistant's own voice, getting longer.
    const misheard = [
      'それでは本日の状況をお伝えします。神経科学の本試験は 8月二十 4日と',
      'それでは本日の状況をお伝えします。神経科学の本試験は 8月二十 4日あと 5日となりました。',
      'それでは本日の状況をお伝えします。神経科学の本試験は 8月二十 4日あと 5日となりました。今日の学習',
    ];
    const real = {
      speakingText:
        'それでは本日の状況をお伝えします。神経科学の本試験は8月24日、あと5日となりました。' +
        '今日の学習は記述式の問題から始めることをお勧めします。',
      startedAt: T0,
    };
    for (const heard of misheard) {
      eq(
        `a ${heard.length}-character echo is still an echo`,
        shouldBargeIn(heard, real, later).reason,
        'self_echo'
      );
    }
    check(
      'and a longer echo is not more likely to be mistaken for a person',
      misheard.every((h) => !shouldBargeIn(h, real, later).interrupt)
    );
  }

  {
    // The normalisation that fixed the reading broke the echo test, and only a
    // live run showed it. `30問` is handed to the voice as `30もん`;
    // recognition hears さんじゅうもん and writes it back in standard
    // orthography as `30問` — matching what was asked for rather than what was
    // emitted. Checking only the spoken form made the assistant's own voice
    // fail the test, and barge-in interrupted it mid-sentence.
    const withOriginal = {
      speakingText: '記述式の30もんのうち、完了は1もんです。',
      originalText: '記述式の30問のうち、完了は1問です。',
      startedAt: T0,
    };
    eq(
      'an echo matching the original is still an echo',
      shouldBargeIn('記述式の 30問のうち', withOriginal, later).reason,
      'self_echo'
    );
    eq(
      'and one matching the spoken form still is',
      shouldBargeIn('記述式の30もんのうち', withOriginal, later).reason,
      'self_echo'
    );
    // Recognition revises the tail of a partial as more audio arrives:
    // `記述式の30` became `記述式の30の` and then `記述式の30問`. The middle
    // frame matches neither form in full, and requiring it to did exactly what
    // this module exists to prevent — the assistant interrupted itself
    // mid-word, on the second live run, after the first fix.
    eq(
      'a partial caught mid-revision is still an echo',
      shouldBargeIn('記述式の 30の', withOriginal, later).reason,
      'self_echo'
    );

    // Neither form should make a genuine interruption invisible.
    eq(
      'while a person still interrupts',
      shouldBargeIn('ちょっと待って', withOriginal, later).interrupt,
      true
    );
    eq(
      'and a short one does too',
      shouldBargeIn('ストップして', withOriginal, later).interrupt,
      true
    );
  }

  // -----------------------------------------------------------------------
  section('But it must stop for a person');

  {
    for (const said of [
      'ちょっと待って',
      'それはいい',
      'ストップ',
      '明日の予定を教えて',
    ]) {
      eq(`"${said}" interrupts`, shouldBargeIn(said, speaking, later).interrupt, true);
    }
  }

  {
    // The point of barge-in: a reply recognised as unwanted can be cut off
    // while it is still being given.
    const decision = shouldBargeIn('もういい、やめて', speaking, later);
    eq('an unwanted reply can be cut off', decision.interrupt, true);
    eq('and says so plainly', decision.reason, 'interrupt');
  }

  // -----------------------------------------------------------------------
  section('The cheap filters, in order');

  {
    eq(
      'nothing happens when nothing is being said',
      shouldBargeIn('ちょっと待って', { speakingText: null, startedAt: null }, later).reason,
      'not_speaking'
    );

    // The grace period covers the round trip of the assistant's own opening
    // words, which is exactly when a false interruption would fire.
    eq(
      'the opening moment is ignored',
      shouldBargeIn('ちょっと待って', speaking, T0 + 100).reason,
      'within_grace'
    );
    check(
      'and the grace period is short enough to be useful',
      shouldBargeIn('ちょっと待って', speaking, T0 + 1_500).interrupt,
      'a user has to be able to cut off a reply they immediately dislike'
    );

    // A one-character partial is as likely to be a cough or a keyboard.
    eq('a single character does not count', shouldBargeIn('あ', speaking, later).reason, 'too_short');
    eq('nor does whitespace', shouldBargeIn('  ', speaking, later).reason, 'too_short');
    eq('nor nothing at all', shouldBargeIn('', speaking, later).reason, 'too_short');
  }

  // -----------------------------------------------------------------------
  section('Echo detection on its own');

  {
    check('an exact fragment matches', looksLikeSelfEcho('あと5日です', SAYING));
    check('unrelated speech does not', !looksLikeSelfEcho('ちょっと待って', SAYING));
    check('an empty partial matches nothing', !looksLikeSelfEcho('', SAYING));
    check('and nothing being spoken matches nothing', !looksLikeSelfEcho('あと5日', ''));

    // A word that happens to appear in the utterance is not an echo of it —
    // otherwise asking about something IRIS just mentioned could never
    // interrupt, which is the most likely reason to interrupt at all.
    check(
      'a short shared word does not make an interruption into an echo',
      !looksLikeSelfEcho('今日の予定を全部教えてほしい', SAYING),
      'the user asking about the topic must still be able to cut in'
    );
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Barge-in: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('All barge-in tests passed.');
}

main();
