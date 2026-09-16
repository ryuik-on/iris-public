/**
 * Experience store tests.
 *
 * The register's constraint is one line: 過去の成功は根拠であって法則ではない.
 * Something that worked is evidence that it worked once, under whatever
 * conditions happened to hold — and a store that loses the count cannot
 * express the difference between one observation and eleven.
 *
 * The failures are the half that matters. Today produced three attempts that
 * went wrong repeatedly in the same shape, each noticed and fixed and then
 * repeated within hours. A store that only kept what worked would have
 * recorded none of them.
 *
 * Run: npm run test:experience
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { openDatabase } from '../server/services/db.js';
import { ExperienceStore } from '../server/services/experiences_sqlite.js';
import { validateExperience, describeExperience } from '../server/core/experience.js';

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

const dir = mkdtempSync(join(tmpdir(), 'iris-exp-'));

function main() {
  const db = openDatabase(join(dir, 'e.db'));
  const store = new ExperienceStore(db);

  // -----------------------------------------------------------------------
  section('An experience needs its conditions and its lesson');

  {
    // Without the conditions it is not an experience, it is a superstition:
    // "this worked" with no account of when.
    const noSituation = validateExperience({
      attempt: 'tsc の出力を head に通して確認する',
      situation: '',
      outcome: 'failed',
      learned: 'x',
    });
    eq('conditions are required', noSituation.ok, false);
    check('and the word for what it would otherwise be', /迷信/.test(noSituation.reason));

    // The outcome alone is a log entry. Writing what to do differently is
    // where the thinking happens.
    const noLesson = validateExperience({
      attempt: 'x', situation: 'y', outcome: 'failed', learned: '  ',
    });
    eq('and so is the lesson', noLesson.ok, false);
    check('with the reason given', /記録する意味がありません/.test(noLesson.reason));
  }

  // -----------------------------------------------------------------------
  section('One observation is not a law');

  {
    const { stored } = store.record({
      attempt: 'launchd 配下で TCC の許可を得る',
      situation: 'マイクを常駐サービスから使う',
      outcome: 'worked',
      learned: 'ヘルパを独立した LaunchAgent にする。許可は起動元に帰属する。',
      evidence: ['子プロセス: notDetermined / 独立 LaunchAgent: authorized'],
      affects: ['speech_helper_launchd_packaging'],
    });
    eq('a first observation is counted as one', stored!.observations, 1);
    // Said in the text every time, because one observation phrased as advice
    // reads exactly like a rule.
    check('and says so when read',
      describeExperience(stored!).includes('うまくいく法則ではありません'));
  }

  // -----------------------------------------------------------------------
  section('The same attempt accumulates rather than duplicating');

  {
    const attempt = 'コマンドを ; で繋いでテストとコミットを続ける';
    const situation = '変更をコミットする前に検証する';
    for (const n of [1, 2]) {
      store.record({
        attempt,
        situation,
        outcome: 'failed',
        learned: '&& で繋ぐ。; は前段の失敗を無視して次に進む。',
        evidence: [`${n}回目`],
      });
    }
    const found = store.lookup('; で繋いで');
    eq('one row, not two', found.length, 1);
    eq('with both observations counted', found[0].observations, 2);
    eq('and both outcomes kept', found[0].outcomes, ['failed', 'failed']);

    // Punctuation differences are the same attempt.
    store.record({
      attempt: 'コマンドを、; で繋いで、テストとコミットを続ける。',
      situation,
      outcome: 'failed',
      learned: '&& で繋ぐ。',
    });
    eq('punctuation does not create a second row', store.lookup('; で繋いで').length, 1);
    eq('and the count grows', store.lookup('; で繋いで')[0].observations, 3);
  }

  // -----------------------------------------------------------------------
  section('What has gone wrong more than once');

  {
    const recurring = store.recurringFailures();
    check('a repeated failure is listed', recurring.length >= 1);
    check('and it is the right one', recurring.some((e) => e.attempt.includes('; で繋いで')));
    // The line worth putting in front of somebody before they start.
    check('read back, it warns about the repetition',
      describeExperience(recurring[0]).includes('同じ形で'));

    // A single failure is not a pattern and is not listed as one.
    store.record({
      attempt: '一度きりの失敗',
      situation: 'テスト',
      outcome: 'failed',
      learned: '特になし',
    });
    check('a single failure is not called recurring',
      !store.recurringFailures().some((e) => e.attempt === '一度きりの失敗'));
  }

  // -----------------------------------------------------------------------
  section('A method that stopped working');

  {
    const attempt = 'grep でテスト結果を確認する';
    store.record({
      attempt, situation: 'スイート全体の合否を見る', outcome: 'worked',
      learned: '失敗行を探せば足りる',
    });
    store.record({
      attempt, situation: 'スイート全体の合否を見る', outcome: 'failed',
      learned: 'クラッシュすると失敗行が出ないので通過に見える。終了コードで判定する。',
    });

    const mixed = store.inconsistent();
    check('both outcomes on one attempt are flagged', mixed.some((e) => e.attempt === attempt));
    const text = describeExperience(mixed.find((e) => e.attempt === attempt)!);
    check('and the reader is told to look at the conditions',
      text.includes('条件の違いを確かめてください'));
    // The latest lesson is the one to act on; the history is what shows the
    // change.
    check('the newest lesson is what is shown', text.includes('終了コードで判定する'));
  }

  // -----------------------------------------------------------------------
  section('Finding it again');

  {
    check('by what was attempted', store.lookup('LaunchAgent').length >= 1);
    check('by the situation', store.lookup('マイクを常駐').length >= 1);
    check('by what was learned', store.lookup('起動元に帰属').length >= 1);
    eq('and nothing matches nothing', store.lookup('存在しない話題').length, 0);
  }

  db.close();

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Experience: ${passed} passed, ${failed} failed`);
  rmSync(dir, { recursive: true, force: true });
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('All experience tests passed.');
}

main();
