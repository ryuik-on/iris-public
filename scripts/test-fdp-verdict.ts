/**
 * 自動判定の再現テスト。
 *
 * 実データの検算（npm run fdp:check）は今日の台帳では 遅延 を一度も踏まない。
 * 期限を過ぎた未完了の課題が現在ゼロだからで、**実データで一致したことは
 * 遅延の分岐が正しいことの証拠にならない**。そこはここで固定する。
 *
 * Run: npm run test:fdp-verdict
 */
import { verdictFor, settingsFromRows, parseDays, DEFAULT_SETTINGS, pressingTasks, describePressing } from '../server/core/fdp_verdict.js';

let passed = 0, failed = 0;
const failures: string[] = [];
function eq(name: string, actual: any, expected: any) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name); console.log(`  ✗ ${name} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}
function section(t: string) { console.log(`\n▸ ${t}`); }

const TODAY = new Date(2026, 8, 1); // 2026-09-01

const row = (o: Partial<Record<string, string>>): Record<string, string> => ({
  状態: '進行中', 開始予定日: '2026/08/01', 期限: '2026/12/16', 最終更新日: '2026/09/01', ...o,
} as Record<string, string>);

section('閾値の読み取り');
eq('「7日」から7', parseDays('7日'), 7);
eq('「3日前」から3', parseDays('3日前'), 3);
eq('数字が無ければ null', parseDays('毎朝'), null);
eq('設定タブから両方拾う',
  settingsFromRows([
    { 設定項目: '更新停止', 値: '7日' },
    { 設定項目: '期限間近', 値: '3日前' },
    { 設定項目: '毎日確認', 値: '08:00' },
  ]),
  { stalledAfterDays: 7, dueSoonDays: 3 });
eq('欠けていれば既定値に落ちる', settingsFromRows([]), DEFAULT_SETTINGS);

section('完了が最優先');
eq('完了は完了', verdictFor(row({ 状態: '完了' }), TODAY), '完了');
// 終わった仕事は、締切を過ぎていても「遅延」ではない。
eq('期限を過ぎた完了も完了', verdictFor(row({ 状態: '完了', 期限: '2026/07/01' }), TODAY), '完了');
eq('放置された完了も完了', verdictFor(row({ 状態: '完了', 最終更新日: '2026/01/01' }), TODAY), '完了');

section('遅延（実データでは踏まないので、ここが唯一の担保）');
eq('期限を過ぎた未完了は遅延', verdictFor(row({ 期限: '2026/08/25' }), TODAY), '遅延');
eq('遅延は更新停止より優先', verdictFor(row({ 期限: '2026/08/25', 最終更新日: '2026/01/01' }), TODAY), '遅延');
// 当日はまだ過ぎていないので遅延ではない。期限間近の側に入る。
eq('期限が今日ならまだ遅延ではない', verdictFor(row({ 期限: '2026/09/01' }), TODAY), '期限間近');
eq('期限が読めなければ遅延にしない', verdictFor(row({ 期限: '' }), TODAY), '順調');

section('通知除外 — 開始予定日前の未着手');
// T008 が実物。7月に触ったきりで11月開始、シートは「順調」と言う。
// この規則を落とすと、未来の課題が全部ニセの警報になる。
eq('未来開始の未着手は順調',
  verdictFor(row({ 状態: '未着手', 開始予定日: '2026/11/03', 最終更新日: '2026/07/30' }), TODAY), '順調');
/*
 * ここは 2026-09-02 に向きが変わった。以前は「未来開始でも進行中なら除外しない」
 * として 更新停止 を期待していた。元の数式を読むと、除外は状態を見ておらず
 * `開始予定日 <= 今日` だけで掛かっている — つまりシートはこの行を 順調 と
 * 呼んでいた。**推測で作った規則が、実データに該当行が無いあいだ、正しい顔を
 * していた。**
 *
 * 開始が先なのに進行中、というのは記入の食い違いであって、判定が拾うものでは
 * ない。拾わせたくなったら、それは数式の再現ではなく新しい決定になる。
 */
eq('未来開始なら状態にかかわらず順調',
  verdictFor(row({ 状態: '進行中', 開始予定日: '2026/11/03', 最終更新日: '2026/07/30' }), TODAY), '順調');
eq('開始日が今日なら除外しない',
  verdictFor(row({ 状態: '未着手', 開始予定日: '2026/09/01', 最終更新日: '2026/07/30' }), TODAY), '更新停止');

section('更新停止 — 閾値ちょうどの境目');
eq('7日前は更新停止', verdictFor(row({ 最終更新日: '2026/08/25' }), TODAY), '更新停止');
eq('6日前はまだ順調', verdictFor(row({ 最終更新日: '2026/08/26' }), TODAY), '順調');
eq('閾値は設定で動く',
  verdictFor(row({ 最終更新日: '2026/08/26' }), TODAY, { stalledAfterDays: 3, dueSoonDays: 3 }), '更新停止');
eq('最終更新日が空なら更新停止にしない', verdictFor(row({ 最終更新日: '' }), TODAY), '順調');

section('保留 — 意図して止めているのか、忘れているのか');
// 「29日 動いていません」だけでは、決めて止めたのか落としたのかが分からない。
// 保留はその区別を台帳に持たせるためのもので、期限が本体。
eq('期限内の保留は保留',
  verdictFor(row({ 最終更新日: '2026/01/01' }), TODAY, DEFAULT_SETTINGS, '2026-11-10'), '保留');
eq('今日までの保留はまだ保留',
  verdictFor(row({ 最終更新日: '2026/01/01' }), TODAY, DEFAULT_SETTINGS, '2026-09-01'), '保留');
// ここが要点。期限の切れた保留は保留として扱わない。扱えば、寝かせたつもりの
// 課題が永久に「保留」と表示され、忘れていることと区別が付かなくなる。
eq('期限の切れた保留は更新停止に戻る',
  verdictFor(row({ 最終更新日: '2026/01/01' }), TODAY, DEFAULT_SETTINGS, '2026-08-31'), '更新停止');
eq('保留の期限が読めなければ保留にしない',
  verdictFor(row({ 最終更新日: '2026/01/01' }), TODAY, DEFAULT_SETTINGS, ''), '更新停止');
eq('保留が無ければ従来どおり',
  verdictFor(row({ 最終更新日: '2026/01/01' }), TODAY, DEFAULT_SETTINGS, null), '更新停止');
// 止めると決めていても期限は来る。そこは知らせるべき事実なので遅延が勝つ。
eq('遅延は保留より優先',
  verdictFor(row({ 期限: '2026/08/25' }), TODAY, DEFAULT_SETTINGS, '2026-11-10'), '遅延');
eq('完了は保留より優先',
  verdictFor(row({ 状態: '完了' }), TODAY, DEFAULT_SETTINGS, '2026-11-10'), '完了');
// 動いている課題を保留にしても、保留と言う。判定は事実を言うだけで評価しない。
eq('最近動いていても保留は保留',
  verdictFor(row({ 最終更新日: '2026/09/01' }), TODAY, DEFAULT_SETTINGS, '2026-11-10'), '保留');

section('シートにしか出せなかった判定');
/*
 * この節が無かったせいで、突き合わせは 10 行すべて一致と言い続けていた。
 * 照合が **こちらの語彙を数え上げていた** ので、シートにしか出せない
 * 期限間近 と 進捗停滞 は、比べる対象にすら入っていなかった。数式を消す前に
 * 気づける形ではなかった。
 */

// 期限間近: 今日から3日以内。今日ちょうども入る（数式は F>=TODAY()）。
eq('期限が3日後なら期限間近',
  verdictFor(row({ 期限: '2026/09/04' }), TODAY, DEFAULT_SETTINGS), '期限間近');
eq('期限が今日なら期限間近',
  verdictFor(row({ 期限: '2026/09/01' }), TODAY, DEFAULT_SETTINGS), '期限間近');
// 進捗停滞に先を越されないよう、期間を長く取って進捗も追いつかせておく。
eq('期限が4日後なら期限間近ではない',
  verdictFor(row({ 期限: '2026/09/05', 開始予定日: '2026/06/01', 進捗率: '0.95' }), TODAY, DEFAULT_SETTINGS), '順調');
// 期限を過ぎていれば遅延。間近は「まだ来ていない」ものだけ。
eq('期限を過ぎていれば期限間近ではなく遅延',
  verdictFor(row({ 期限: '2026/08/31' }), TODAY, DEFAULT_SETTINGS), '遅延');
// 数式では期限間近が更新停止より上にある。順序そのものが仕様。
eq('期限間近は更新停止より優先',
  verdictFor(row({ 期限: '2026/09/02', 最終更新日: '2026/01/01' }), TODAY, DEFAULT_SETTINGS), '更新停止' === '' ? '' : '期限間近');

// 進捗停滞: 使った時間の割合が進捗率を 0.25 より大きく上回っている。
// 開始 08/01・期限 12/16（137日）で今日は31日目 = 0.226。進捗0なら 0.226 で、
// 0.25 を超えないので停滞ではない。ここは境目のすぐ内側。
eq('少し遅れているだけなら順調',
  verdictFor(row({ 進捗率: '0' }), TODAY, DEFAULT_SETTINGS), '順調');
// 開始 06/01・期限 12/16（198日）で今日は92日目 = 0.465。進捗0.1なら 0.365。
eq('大きく遅れていれば進捗停滞',
  verdictFor(row({ 開始予定日: '2026/06/01', 進捗率: '0.1' }), TODAY, DEFAULT_SETTINGS), '進捗停滞');
eq('進捗が追いついていれば順調',
  verdictFor(row({ 開始予定日: '2026/06/01', 進捗率: '0.9' }), TODAY, DEFAULT_SETTINGS), '順調');
// 数式では更新停止が先。両方に当てはまる行は更新停止と呼ぶ。
eq('動いていないことの方が先',
  verdictFor(row({ 開始予定日: '2026/06/01', 進捗率: '0.1', 最終更新日: '2026/01/01' }), TODAY, DEFAULT_SETTINGS), '更新停止');
// 元の数式の IFERROR(…, FALSE) にあたる。開始と期限が同日でゼロ除算になる行を
// 「停滞ではない」に倒す。落とすのでも、停滞と呼ぶのでもない。
eq('開始と期限が同日なら停滞にしない',
  verdictFor(row({ 開始予定日: '2026/09/01', 期限: '2026/09/01', 進捗率: '0' }), TODAY, DEFAULT_SETTINGS), '期限間近');

section('まだ始まっていない課題');
/*
 * 数式は 更新停止 にも 進捗停滞 にも `開始予定日 <= 今日` を掛けていた。
 * こちらは代わりに「開始が先で、かつ状態が未着手なら順調」で降りていたので、
 * **開始日が先なのに進行中になっている行**だけ答えが割れていた。実データに
 * その行が無かったので、突き合わせには一度も出てこなかった。
 */
eq('開始が先なら、動いていなくても順調（未着手）',
  verdictFor(row({ 状態: '未着手', 開始予定日: '2026/11/03', 最終更新日: '2026/01/01' }), TODAY, DEFAULT_SETTINGS), '順調');
eq('開始が先なら、状態が進行中でも順調',
  verdictFor(row({ 状態: '進行中', 開始予定日: '2026/11/03', 最終更新日: '2026/01/01' }), TODAY, DEFAULT_SETTINGS), '順調');
eq('開始日が読めなければ、始まっていない扱い',
  verdictFor(row({ 開始予定日: '', 最終更新日: '2026/01/01' }), TODAY, DEFAULT_SETTINGS), '順調');

/*
 * いま言うべき課題。監視は「期限まであと1日」だけを見ていたので、**前日に一度
 * 言って、そのあとは何も言わなかった。**実測 2026-09-30、当日の課題と 13 日
 * 超過の課題が、どちらも一度も鳴っていない。台帳は同じものを 期限間近・遅延 と
 * 判定していた。
 */
{
  const tasks = [
    { id: 'T005', title: '研究室の下調べ', verdict: '期限間近', status: '未着手', dueInDays: 0 },
    { id: 'T011', title: 'GCI', verdict: '遅延', status: '進行中', dueInDays: -13 },
    { id: 'T006', title: 'ML', verdict: '更新停止', status: '進行中', dueInDays: 47 },
    { id: 'T008', title: '生物統計', verdict: '順調', status: '未着手', dueInDays: 77 },
    { id: 'T099', title: '済んだもの', verdict: '遅延', status: '完了', dueInDays: -30 },
    { id: 'T098', title: '止めたもの', verdict: '保留', status: '保留', dueInDays: -5 },
  ];
  const picked = pressingTasks(tasks).map((t) => t.id);
  eq('今日が期限のものを拾う', picked.includes('T005'), true);
  eq('期限を過ぎたものも拾う', picked.includes('T011'), true);
  eq('更新停止は期限の話ではないので拾わない', picked.includes('T006'), false);
  eq('順調は拾わない', picked.includes('T008'), false);
  // 終わった仕事は、締切を過ぎていても急かさない。
  eq('完了は拾わない', picked.includes('T099'), false);
  // 手を止めると決めたものを急かすのは、決めたことを忘れたふりをすること。
  eq('保留は拾わない', picked.includes('T098'), false);
  eq('拾ったのは二件', picked.length, 2);
}
{
  // 件数では動けない。名前と、あと何日かを言う。
  eq('超過は超過と言う', describePressing({ id: 'T011', title: 'GCI', verdict: '遅延', dueInDays: -13 }), 'T011 GCI（遅延・13日超過）');
  eq('当日は今日と言う', describePressing({ id: 'T005', title: '研究室の下調べ', verdict: '期限間近', dueInDays: 0 }), 'T005 研究室の下調べ（期限間近・今日）');
  eq('先の期限は残り日数', describePressing({ id: 'T007', title: '論文', verdict: '期限間近', dueInDays: 3 }), 'T007 論文（期限間近・あと3日）');
  eq('日数が読めなければ、日数を言わない', describePressing({ id: 'T009', title: '手続き', verdict: '遅延', dueInDays: null }), 'T009 手続き（遅延）');
}

console.log(`\n${failed === 0 ? '✓' : '✗'} ${passed} passed, ${failed} failed`);
if (failed > 0) { console.log(failures.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
