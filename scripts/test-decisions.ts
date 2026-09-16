/**
 * Decision trace tests.
 *
 * The activity log already records that decisions happened. What it cannot
 * answer is why this and not the other thing — and that answer otherwise
 * survives only as long as the conversation it was made in.
 *
 * So what is tested here is mostly refusal to flatter. A record must not read
 * as more deliberate than the decision was: an empty alternatives list has to
 * say so out loud, an alternative with no reason must not pad the list, and a
 * decision with no grounds is not a decision at all.
 *
 * The case that motivated this is a decision *not* to build something —
 * automatic model fallback, and the coding agent invocation. Those leave no
 * code behind, so the absence reads as an oversight later and gets built by
 * someone who never saw the reasoning.
 *
 * Run: npm run test:decisions
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { openDatabase } from '../server/services/db.js';
import { DecisionStore } from '../server/services/decisions_sqlite.js';
import { validateDecision, explain } from '../server/core/decision_trace.js';

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

const dir = mkdtempSync(join(tmpdir(), 'iris-decisions-'));

function main() {
  const db = openDatabase(join(dir, 'd.db'));
  const store = new DecisionStore(db);

  // -----------------------------------------------------------------------
  section('A decision has to rest on something');

  {
    const none = validateDecision({
      title: '音声を Enceladus にする',
      decided: '既定の読み上げ音声を ja-JP-Chirp3-HD-Enceladus にする。',
      decidedBy: 'user',
      grounds: [],
    });
    // Without grounds it is a preference. Recording it as a decision would let
    // it be cited later as though something supported it.
    eq('no grounds means it is not recorded', none.ok, false);
    check('and the reason says what it actually is', /好み/.test(none.reason));

    eq('nor is one with no title',
      validateDecision({ title: '', decided: 'x', decidedBy: 'iris', grounds: ['y'] }).ok, false);
    eq('nor one that does not say what was decided',
      validateDecision({ title: 'x', decided: '   ', decidedBy: 'iris', grounds: ['y'] }).ok, false);
  }

  // -----------------------------------------------------------------------
  section('The record must not look more deliberate than it was');

  {
    const bare = store.record({
      title: 'カレンダーのソース順',
      decided: 'Google → iCloud → キャッシュ の順に読む。',
      decidedBy: 'iris',
      grounds: ['各ソースが何を正直に主張できるかで並べた'],
    });
    eq('a decision with no alternatives is still recorded', bare.stored !== null, true);
    // Said out loud rather than left as an absent section, because silence
    // reads as "nothing else was worth considering".
    // The wording differs between the two places on purpose: the stored
    // reason describes what happened, the explanation describes what to make
    // of it. Matching one against the other's phrasing was a test bug.
    check('and says it compared nothing', /比較されていない/.test(bare.reason), bare.reason);
    check('the explanation says so too',
      explain(bare.stored!).includes('検討した代替案: なし（比較していない）'));

    // An alternative with no reason was never weighed against anything.
    const padded = validateDecision({
      title: 'x', decided: 'y', decidedBy: 'iris', grounds: ['z'],
      alternatives: [
        { option: 'REST を使う', rejectedBecause: '' },
        { option: 'MCP を使う', rejectedBecause: 'tools/call が全て権限エラーで弾かれた' },
      ],
    });
    eq('an alternative with no reason is dropped', padded.adjusted!.alternatives!.length, 1);
    check('and the drop is reported', /検討されていない選択肢/.test(padded.reason));
  }

  // -----------------------------------------------------------------------
  section('Deciding not to build something');

  {
    // The case this exists for. No code is left behind, so six months later
    // the absence looks like an oversight rather than a choice.
    const { stored } = store.record({
      title: 'モデルの自動フォールバックを実装しない',
      decided: '設定モデルが消えたとき、候補へ自動で切り替える機能は作らない。',
      decidedBy: 'iris',
      grounds: [
        'provider_router の FAILOVER_KINDS に model_not_found が含まれており、404 で次のプロバイダへ移る',
        'モデルの差し替えは費用と挙動を黙って変える',
        '起動時と6時間ごとの検査が、壊れる前に警告する',
      ],
      alternatives: [
        {
          option: '欠落時に候補モデルへ自動で切り替える',
          rejectedBecause: '費用と応答特性が利用者に知らされないまま変わる',
        },
      ],
      rule: 'プロバイダを移るのは可視化済み、モデルを移るのは不可視',
      reversal: 'model_discovery の checkConfigured に切替処理を足す',
      affects: ['model_lifecycle_registry', 'provider_router'],
    });

    check('a decision not to build is recorded', stored !== null);
    const text = explain(stored!);
    check('the reasoning is readable back', text.includes('費用と挙動を黙って変える'));
    check('the alternative is there with its reason', text.includes('自動で切り替える'));
    check('and how to undo it', text.includes('取り消すには'));

    // The lookup that matters when someone is about to change this.
    const found = store.affecting('model_lifecycle_registry');
    eq('it is findable from what it governs', found.length, 1);
    eq('and from the other thing it governs', store.affecting('provider_router').length, 1);
    eq('but not from something unrelated', store.affecting('calendar_eventkit').length, 0);
  }

  {
    // Who decided is kept separate from what was decided.
    store.record({
      title: 'コーディングエージェントの起動は実装しない',
      decided: '設計のみ記録し、実装は保留する。',
      decidedBy: 'user',
      grounds: ['任意コマンド実行はワークスペース封じ込めを迂回しうる', '省けるのはコピー一手間だけ'],
    });
    const byUser = store.list({ decidedBy: 'user' });
    eq('a user decision is filed as the user\'s', byUser.length, 1);
    check('and reads as such', explain(byUser[0]).includes('利用者の判断'));
    // Because it is not IRIS's to revisit unprompted.
    check('IRIS\'s own decisions are separable',
      store.list({ decidedBy: 'iris' }).every((d) => d.decidedBy === 'iris'));
  }

  // -----------------------------------------------------------------------
  section('Decisions that were later reversed');

  {
    const first = store.record({
      title: 'エコー判定の閾値',
      decided: '一致した連続部分が認識文字列の60%以上ならエコーとみなす。',
      decidedBy: 'iris',
      grounds: ['認識は完全一致しないので割合で見る'],
    }).stored!;

    const second = store.record({
      title: 'エコー判定の閾値（改訂）',
      decided: '連続8文字以上が一致すればエコーとみなす。割合では見ない。',
      decidedBy: 'iris',
      grounds: [
        '実機で自分の声に割り込んだ',
        '認識は必ずどこかで食い違う（8月24日 → 8月二十 4日）ため一致長はそこで頭打ちになる',
        '割合の閾値は認識文が伸びるほど上がるので、エコーが長いほど他人と判定されやすくなっていた',
      ],
      alternatives: [
        { option: '割合の閾値を下げる', rejectedBecause: '長さへの依存が残り、同じ形で再発する' },
      ],
      affects: ['voice_experience_details'],
    }).stored!;

    check('a decision can be revised', store.revise(first.id, second.id));
    const live = store.list();
    check('the revised one drops out of the current list', !live.some((d) => d.id === first.id));
    // The most useful kind to be able to read: it says what was believed and
    // what the measurement did to it.
    check('but is still retrievable', store.get(first.id) !== null);
    check('and points at what replaced it', store.get(first.id)?.revisedBy === second.id);
    check('and says so when explained',
      explain(store.get(first.id)!).includes('後に見直されています'));
    check('history is available when asked for',
      store.list({ includeRevised: true }).some((d) => d.id === first.id));
  }

  // -----------------------------------------------------------------------
  section('Where to look when something turns out badly');

  {
    // Not a fault list. "Nothing else was considered" is the most common
    // reason a choice goes wrong, so it is worth being able to ask.
    const unweighed = store.unweighed();
    check('decisions with no alternatives can be listed', unweighed.length > 0);
    check('and they are exactly the ones that weighed nothing',
      unweighed.every((d) => d.alternatives.length === 0));
    check('while the deliberated ones are not in it',
      !unweighed.some((d) => d.title.includes('自動フォールバック')));
  }

  // -----------------------------------------------------------------------
  section('A correction marks what it corrects');

  {
    // `revisedBy` existed from the start and nothing could set it, so a
    // superseded decision kept reading as current. Two contradictory records,
    // both live, distinguishable only by timestamp.
    const { stored: first } = store.record({
      title: '接続を維持する理由',
      decided: '取り込んだツールがスキーマ変換を実データで検証し続けるため維持する。',
      decidedBy: 'iris',
      grounds: ['当時そう考えた'],
      affects: ['test_key'],
    });
    const { stored: second } = store.record({
      title: '接続を維持する理由（訂正）',
      decided: 'blocked なツールは登録されないため、変換は通らない。維持する理由は可視性である。',
      decidedBy: 'iris',
      grounds: ['asIrisTools() が blocked を除外することをコードで確認'],
      affects: ['test_key'],
    });

    check('both were recorded', Boolean(first && second));
    eq('marking succeeds', store.revise(first!.id, second!.id), true);

    // The original is kept. Having believed something is part of the record.
    const still = store.get ? store.get(first!.id) : null;
    if (still) check('the original row survives', still.id === first!.id);

    const current = store.list({});
    check('the superseded one is out of the default view', !current.some((d) => d.id === first!.id));
    check('and the correction is in it', current.some((d) => d.id === second!.id));

    const all = store.list({ includeRevised: true });
    check('it is still reachable when asked for', all.some((d) => d.id === first!.id));

    const marked = all.find((d) => d.id === first!.id);
    eq('and points at what replaced it', marked?.revisedBy, second!.id);

    // Only once: a second claim must not rewrite which decision replaced it.
    const { stored: third } = store.record({
      title: 'さらに別の決定',
      decided: 'x',
      decidedBy: 'iris',
      grounds: ['y'],
    });
    eq('a decision cannot be superseded twice', store.revise(first!.id, third!.id), false);
    eq(
      'and keeps pointing at the first correction',
      store.list({ includeRevised: true }).find((d) => d.id === first!.id)?.revisedBy,
      second!.id
    );
  }

  db.close();

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Decision trace: ${passed} passed, ${failed} failed`);
  rmSync(dir, { recursive: true, force: true });
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('All decision trace tests passed.');
}

main();
