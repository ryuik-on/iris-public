/**
 * Pronunciation audit tests.
 *
 * The measurement is possible because IRIS knows exactly what it meant to say.
 * There is no ground truth for human speech; there is for its own. What comes
 * back through the microphone can therefore be compared with the source, and
 * the places they disagree are worth looking at.
 *
 * What the tests defend is that it stops there. A divergence has three causes
 * — the voice mispronounced it, recognition misheard it, or the room got in
 * the way — and they are indistinguishable from inside. Turning any of them
 * into a dictionary entry would encode recognition errors as pronunciation
 * rules, applied silently from then on.
 *
 * Run: npm run test:pronunciation-audit
 */
import { auditPronunciation, describeAudit } from '../server/core/pronunciation_audit.js';

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
  section('What actually came back today');

  {
    // Measured on 2026-08-19. The voice said はちがつにじゅうよっか correctly;
    // recognition wrote it as 8月二4日. A divergence, and not the voice's
    // fault — which is exactly why this reports rather than corrects.
    const audit = auditPronunciation(
      'それでは本日の状況をお伝えします。神経科学の本試験は8月24日、あと5日となりました。',
      'それでは本日の状況をお伝えします。神経科学の本試験は 8月二4日あと 5日となり'
    );
    check('the divergence is found', audit.divergences.length > 0);
    check('and points at the right place',
      audit.divergences.some((d) => d.context.includes('8月24日')),
      JSON.stringify(audit.divergences));
    check('coverage is reported', audit.coverage > 0.5, String(audit.coverage));

    const text = describeAudit(audit);
    // All three explanations, every time. A list headed "mispronunciations"
    // would teach the reader to accept recognition errors as facts.
    check('all three causes are stated', /読み上げの誤読/.test(text) && /認識の誤り/.test(text) && /雑音/.test(text));
    check('and that nothing is added automatically', /自動で追加しません/.test(text));
  }

  // -----------------------------------------------------------------------
  section('A clean reading is reported as clean');

  {
    const same = 'おはようございます。今日の予定を確認します。';
    const audit = auditPronunciation(same, same);
    eq('an exact match diverges nowhere', audit.divergences.length, 0);
    check('and says so', /一致しました/.test(describeAudit(audit)));

    // Punctuation and spacing survive neither synthesis nor recognition, and
    // reporting them would bury the real findings.
    const punctuated = auditPronunciation(
      'おはようございます。今日の予定を確認します。',
      'おはようございます 今日の予定を確認します'
    );
    eq('punctuation differences are not divergences', punctuated.divergences.length, 0);
  }

  // -----------------------------------------------------------------------
  section('What the microphone did not hear is not a mispronunciation');

  {
    // An echo that caught the opening says nothing about the rest. Reporting
    // the tail every time is how a report becomes something people stop
    // reading.
    const audit = auditPronunciation(
      '第一文です。第二文です。第三文です。第四文です。',
      '第一文です。第二文です。'
    );
    eq('the unheard tail is not reported', audit.divergences.length, 0);
    check('but the coverage says how little was checked', audit.coverage < 0.6, String(audit.coverage));
  }

  {
    // Neither is a late start.
    const audit = auditPronunciation(
      'それでは本日の状況をお伝えします。神経科学の本試験は8月24日です。',
      '神経科学の本試験は8月24日です。'
    );
    eq('a missing opening is not reported either', audit.divergences.length, 0);
  }

  // -----------------------------------------------------------------------
  section('A real mispronunciation, and the shape it takes');

  {
    // The case the user reported by ear: 30問 read as さんじゅうとい. The
    // transcript comes back with the wrong reading spelled out.
    const audit = auditPronunciation(
      '記述式の30問のうち完了は1問です。',
      '記述式の30といのうち完了は1といです。'
    );
    check('the divergence is found', audit.divergences.length > 0);
    check('with what was expected', audit.divergences.some((d) => d.expected.includes('問')));
    check('and what was heard instead', audit.divergences.some((d) => d.heard.includes('とい')));
  }

  // -----------------------------------------------------------------------
  section('When comparison is not possible');

  {
    // Nothing lined up. Almost always the microphone caught something else,
    // not that every word was wrong.
    const audit = auditPronunciation('明日の予定を確認します', 'まったく無関係な別の音声');
    eq('no divergences are claimed', audit.divergences.length, 0);
    check('and the reason is given', Boolean(audit.skipped), JSON.stringify(audit));
    check('saying it is not evidence about the voice', /判断材料になりません/.test(audit.skipped ?? ''));

    eq('an empty transcript is skipped', Boolean(auditPronunciation('何か', '').skipped), true);
    eq('and empty source too', Boolean(auditPronunciation('', '何か').skipped), true);
  }

  {
    // Single characters are reported, and that is a deliberate reversal. They
    // were filtered as recogniser noise until the filter removed the one case
    // this whole thing was built from: `8月24日` came back as `8月二4日`, a
    // difference of exactly one character. Length does not separate a finding
    // from noise, and filtering by it discards the findings while keeping the
    // appearance of precision.
    const audit = auditPronunciation('本日は晴天なり', '本日わ晴天なり');
    eq('a one-character difference is reported', audit.divergences.length, 1);
    eq('with what was expected', audit.divergences[0].expected, 'は');
    eq('and what came back', audit.divergences[0].heard, 'わ');
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Pronunciation audit: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('All pronunciation audit tests passed.');
}

main();
