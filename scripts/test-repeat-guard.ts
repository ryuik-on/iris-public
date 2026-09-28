/**
 * 記録された失敗を、繰り返す前に止められるか。
 *
 * 確かめるのは三つ。**該当を見つけること**、**該当しないものを止めないこと**、
 * そして **覆えていない記録を隠さないこと。**三つめが一番大事で、ここが
 * 抜けると 0件が「問題なし」に見える。
 *
 * Run: npm run test:repeat-guard
 */
import { guardAgainstRepeats, coverage, explainHits, RecordedFailure } from '../server/core/repeat_guard.js';

let passed = 0, failed = 0;
const failures: string[] = [];
function section(n: string) { console.log(`\n▸ ${n}`); }
function eq(n: string, a: any, b: any) {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (ok) { passed++; console.log(`  ✓ ${n}`); }
  else { failed++; failures.push(`${n}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`); console.log(`  ✗ ${n}`); }
}

/** 実際に記録されている三件（`/api/experiences?recurring=true`、2026-09-28）。 */
const RECORDED: RecordedFailure[] = [
  {
    attempt: 'コマンドを ; で繋いで検証とコミットを続ける',
    learned: '&& で繋ぐ。; は前段の失敗を無視して次に進む。',
    observations: 3,
  },
  {
    attempt: 'ユニットテストが通ったことをもって実装が正しいと判断する',
    learned: '実機で回す。エコー判定・カレンダーの網羅・TCC の帰属は、いずれも実機で初めて壊れた。',
    observations: 3,
  },
  {
    attempt: 'npm test の出力を grep してスイートの合否を判定する',
    learned: '終了コードで判定する。スイートがクラッシュすると失敗行が出ず、通過に見える。',
    observations: 2,
  },
];

section('記録された形を見つける');
{
  const hits = guardAgainstRepeats(
    { command: 'npm test ; git commit -m "done"' },
    RECORDED
  );
  eq('; で検証とコミットを繋いだら止まる', hits.map((h) => h.observations), [3]);
  eq('直し方が添う', hits[0]?.learned.startsWith('&& で繋ぐ'), true);
  eq('どこが該当したかを言う', hits[0]?.found.includes('git commit'), true);
}
{
  /*
   * 実際にこのセッションでやったこと（2026-09-28）。記録された失敗そのもので、
   * 出力を読み違えて「190 failed」と数えた。**記録は前からあった。**
   */
  const hits = guardAgainstRepeats(
    { command: "npm test 2>&1 | grep -E '✗|failed' | head -20" },
    RECORDED
  );
  eq('npm test を grep に渡したら止まる', hits.map((h) => h.attempt), ['npm test の出力を grep してスイートの合否を判定する']);
  eq('終了コードで判定せよと言う', hits[0]?.learned.includes('終了コード'), true);
}
{
  const hits = guardAgainstRepeats(
    { command: 'npm run typecheck && npm test ; git push' },
    RECORDED
  );
  eq('&& が混ざっていても、; の後ろが push なら止まる', hits.length, 1);
}

section('該当しないものは止めない');
{
  // `for` の `;` は区切りであって、失敗の無視ではない。
  const hits = guardAgainstRepeats(
    { command: 'for f in a b; do chflags nouchg "$f"; done' },
    RECORDED
  );
  eq('for ループの ; は止めない', hits.length, 0);
}
{
  // コミット文の中のセミコロン。引用の中は区切りではない。
  const hits = guardAgainstRepeats(
    { command: 'npm test && git commit -m "fix: a; then b"' },
    RECORDED
  );
  eq('引用の中の ; は止めない', hits.length, 0);
}
{
  const hits = guardAgainstRepeats({ command: 'npm test 2>&1 | tail -20' }, RECORDED);
  eq('出力を眺めるための tail は止めない', hits.length, 0);
}
{
  const hits = guardAgainstRepeats({ command: 'grep -rn "npm test" package.json' }, RECORDED);
  eq('npm test という文字列を探すだけなら止めない', hits.length, 0);
}
{
  const hits = guardAgainstRepeats({ command: 'git commit -m "wip"' }, RECORDED);
  eq('コミットだけなら止めない', hits.length, 0);
}
{
  const hits = guardAgainstRepeats({}, RECORDED);
  eq('命令が無ければ何も言わない', hits.length, 0);
}

section('ヒアドキュメントの本文はデータであって、命令ではない');
{
  /*
   * 実測 2026-09-28。この規則を入れるコミット自身が止められた —— コミット文に、
   * 止めたい形を例として引用していたから。続いて、その事例をこのファイルに
   * 書き足すための編集コマンドまで止まった。**規則が、自分を説明する文を
   * 禁止していた。**
   */
  const lines = [
    "git commit -F - <<'EOF'",
    'earlier today this session ran npm ' + 'test | grep -c failed',
    'and npm ' + 'test ; git commit was the other one',
    'EOF',
  ];
  const hits = guardAgainstRepeats({ command: lines.join('\n') }, RECORDED);
  eq('本文に書いた例では止まらない', hits.length, 0);
}
{
  // 本文を落としても、その外の命令は見る。
  const outside = ["git commit -F - <<'EOF'", 'message', 'EOF', 'npm ' + 'test ; git push'].join('\n');
  const hits = guardAgainstRepeats({ command: outside }, RECORDED);
  eq('本文の外は見る', hits.length, 1);
}
{
  // 区切り語が閉じていない（本文が途切れている）ときも、本文側は読まない。
  const unterminated = ["cat <<'EOF'", 'npm ' + 'test ; git commit -m x'].join('\n');
  const hits = guardAgainstRepeats({ command: unterminated }, RECORDED);
  eq('閉じていないヒアドキュメントでも本文は読まない', hits.length, 0);
}

section('記録に無い失敗は止めない');
{
  /*
   * 止める権限は記録から来る。**述語が知っていても、記録の側に無ければ
   * 言わない。**削除された記録が述語だけで生き残ると、根拠のない禁止になる。
   */
  const hits = guardAgainstRepeats({ command: 'npm test ; git commit -m "x"' }, []);
  eq('記録が空なら、述語が該当しても止めない', hits.length, 0);
}
{
  const onlyOne: RecordedFailure[] = [RECORDED[2]];
  const hits = guardAgainstRepeats({ command: 'npm test ; git commit -m "x"' }, onlyOne);
  eq('その記録が無いものは止めない', hits.length, 0);
}

section('テストが通ったことを正しさと読む場面を、行いに変わる瞬間に掴む');
{
  /*
   * 判断そのものは命令の綴りに現れない。掴めるのは**判断が行いに変わる瞬間** ——
   * 記録された場所（音声・カレンダー・権限）を変えて、実機を一度も動かさずに
   * コミットするところ。記録の learned が「実機で回す」であって「テストを増やす」
   * ではないのが根拠。
   */
  const hits = guardAgainstRepeats(
    {
      command: 'git commit -m "barge-in fixed"',
      changedPaths: ['server/core/barge_in.ts', 'scripts/test-barge-in.ts'],
      realRunSeen: false,
    },
    RECORDED
  );
  eq('実機を動かしていなければ止まる', hits.map((h) => h.attempt), ['ユニットテストが通ったことをもって実装が正しいと判断する']);
  eq('どのファイルが理由かを言う', hits[0]?.found.includes('server/core/barge_in.ts'), true);
  eq('実機で回せと言う', hits[0]?.learned.includes('実機で回す'), true);
}
{
  const hits = guardAgainstRepeats(
    {
      command: 'git commit -m "barge-in fixed"',
      changedPaths: ['server/core/barge_in.ts'],
      realRunSeen: true,
    },
    RECORDED
  );
  eq('実機を動かしていれば止めない', hits.length, 0);
}
{
  /*
   * **分からないときは止めない。**止める権限は記録と証拠から来ていて、証拠の
   * 欠落から来ていない。
   */
  const hits = guardAgainstRepeats(
    { command: 'git commit -m "x"', changedPaths: ['server/core/barge_in.ts'] },
    RECORDED
  );
  eq('実機を動かしたか分からなければ止めない', hits.length, 0);
}
{
  const hits = guardAgainstRepeats(
    {
      command: 'git commit -m "docs"',
      changedPaths: ['README.md', 'server/core/fdp_workplace.ts'],
      realRunSeen: false,
    },
    RECORDED
  );
  eq('実機でしか分からない場所を触っていなければ止めない', hits.length, 0);
}
{
  // 盤（Swift）は画面に出るものなので、画面でしか確かめられない。
  const hits = guardAgainstRepeats(
    { command: 'git push origin HEAD', changedPaths: ['menubar/Rail.swift'], realRunSeen: false },
    RECORDED
  );
  eq('push も同じ扱い', hits.length, 1);
}
{
  // コミットでない命令では、この記録は鳴らない。
  const hits = guardAgainstRepeats(
    { command: 'npm run typecheck', changedPaths: ['menubar/Rail.swift'], realRunSeen: false },
    RECORDED
  );
  eq('コミットしないうちは鳴らない', hits.length, 0);
}
{
  // 記録が無ければ、証拠が揃っていても止めない。
  const hits = guardAgainstRepeats(
    { command: 'git commit -m "x"', changedPaths: ['server/core/barge_in.ts'], realRunSeen: false },
    [RECORDED[0]]
  );
  eq('この記録が無ければ止めない', hits.length, 0);
}

section('覆えていない記録を隠さない');
{
  const c = coverage(RECORDED);
  eq('記録されている3件すべてに述語がある', c.covered.length, 3);
  eq('覆えていない記録は無い', c.uncovered, []);
  eq('文言が合っているので、迷子の述語は無い', c.orphanDetectors, []);
}
{
  /*
   * 記録の文言を書き直すと、述語は静かに外れる。**外れたことが見える**のが
   * この欄の役目 —— 見えなければ、止まらなくなったことに気づけない。
   */
  const renamed: RecordedFailure[] = [
    { attempt: 'コマンドをセミコロンで繋ぐ', learned: '&& で繋ぐ。', observations: 3 },
  ];
  const c = coverage(renamed);
  eq('文言を書き直すと、述語が迷子として出る', c.orphanDetectors.length, 3);
  eq('その記録は覆えていない側に入る', c.uncovered, ['コマンドをセミコロンで繋ぐ']);
}

section('止めた理由は、止めた場所で全部言う');
{
  const hits = guardAgainstRepeats({ command: 'npm test ; git commit -m "x"' }, RECORDED);
  const text = explainHits(hits);
  eq('回数が入る', text.includes('3 回失敗'), true);
  eq('直し方が入る', text.includes('&& で繋ぐ'), true);
  eq('該当箇所が入る', text.includes('git commit'), true);
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`Repeat guard: ${passed} passed, ${failed} failed`);
if (failed) { console.log('\nFailures:'); for (const f of failures) console.log('  - ' + f); process.exit(1); }
console.log('All repeat guard tests passed.');
