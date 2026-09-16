/**
 * Task ledger tests.
 *
 * The panel this feeds has one job the daily focus does not: showing which
 * tasks have stopped. Every test here names a way that reading could quietly
 * turn into a wrong reassurance.
 *
 * Run: npm run test:fdp-tasks
 */
import { FdpSheets } from '../server/services/fdp_sheets.js';
import { FdpTasksService, summariseTasks } from '../server/services/fdp_tasks.js';
import { DEFAULT_SETTINGS } from '../server/core/fdp_verdict.js';

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

const TODAY = new Date(2026, 7, 31); // 2026-08-31

function csv(rows: string[][]): string {
  return rows.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(',')).join('\n');
}

const HEADERS = ['ID', '課題名', '分野', '優先度', '開始予定日', '期限', '状態', '進捗率', '最終更新日', '次の行動', '自動判定'];

const LEDGER = csv([
  HEADERS,
  ['T001', '完了したもの', '管理', '高', '2026/07/16', '2026/07/19', '完了', '1', '2026/07/19', '', '完了'],
  ['T006', '機械学習基礎', 'AI基礎', '高', '2026/07/30', '2026/11/16', '進行中', '0.05', '2026/08/03', 'Week0', '更新停止'],
  ['T005', '研究室の現在地を確認する', '研究準備', '高', '2026/08/31', '2026/09/30', '未着手', '0', '2026/08/31', 'PubMed', '順調'],
  ['T009', '期限が読めない行', '手続き', '中', '', '', '未着手', '', '', '', '順調'],
  ['T010', '判定がまだ出ていない行', '手続き', '中', '2027/09/30', '2027/09/30', '未着手', '', '', '', ''],
  ['', '空行（IDなし）', '', '', '', '', '', '', '', '', ''],
]);

function fakeFetch(body: string, ok = true, status = 200): typeof fetch {
  return (async () => ({ ok, status, text: async () => body })) as any;
}

async function main() {
  section('並びと選別');
  {
    const rows = (await new FdpSheets('x', fakeFetch(LEDGER)).fetchTab('課題台帳', '課題名')).rows;
    const { tasks, doneCount } = summariseTasks(rows, TODAY);

    eq('完了は一覧から外れて件数になる', doneCount, 1);
    check('完了した行は tasks に残らない', !tasks.some((t) => t.id === 'T001'));
    check('IDが空の行は数えない', tasks.length === 4);
    // 手が要るものが先、その中で期限の近い順。並び順をサーバで決めるのは、
    // web と盤で「どれが急ぎか」の答えが割れないようにするため。
    eq('更新停止が順調より先に来る', tasks.map((t) => t.id), ['T006', 'T005', 'T010', 'T009']);
    // 期限のない行が先頭に来ると、締切が無いものが一番急ぎに見える。
    eq('期限が読めない行は末尾', tasks[tasks.length - 1].id, 'T009');
    eq('残り日数は今日基準', tasks.find((t) => t.id === 'T005')!.dueInDays, 30);
  }

  section('無い値を作らない');
  {
    const rows = (await new FdpSheets('x', fakeFetch(LEDGER)).fetchTab('課題台帳', '課題名')).rows;
    const { tasks } = summariseTasks(rows, TODAY);
    const byId = Object.fromEntries(tasks.map((t) => [t.id, t]));

    // シートの自動判定は「シートがそう言った」という別の事実として運ぶ。
    // 空セルを「順調」に丸めると、数式が届いていない行が問題なしに見える。
    eq('シートの自動判定は空セルなら null', byId['T010'].sheetVerdict, null);
    eq('シートの自動判定はそのまま運ぶ', byId['T006'].sheetVerdict, '更新停止');
    // verdict は IRIS が計算する。保留はシートに存在しない概念なので、
    // シートの列を運ぶだけでは保留を表現できない。
    eq('verdict は再現した規則で計算する', byId['T006'].verdict, '更新停止');
    eq('シートが空欄でも verdict は出る', byId['T010'].verdict, '順調');
    // 進捗率の空欄を 0 にすると「着手して0%」と「未記入」が同じ見た目になる。
    eq('進捗率の空セルは null（0にしない）', byId['T010'].progress, null);
    eq('進捗率の 0 は 0 のまま', byId['T005'].progress, 0);
    eq('期限が読めなければ dueInDays は null', byId['T009'].dueInDays, null);
  }

  section('画面の言葉に使う日数もサーバで出す');
  {
    const rows = (await new FdpSheets('x', fakeFetch(LEDGER)).fetchTab('課題台帳', '課題名')).rows;
    const { tasks } = summariseTasks(rows, TODAY);
    const byId = Object.fromEntries(tasks.map((t) => [t.id, t]));

    // 「29日 動いていません」を画面で組み立てるための数。クライアントに
    // 引き算させると、web と盤で日を跨いだ瞬間にずれる。
    eq('最終更新からの日数を運ぶ', byId['T006'].stillDays, 28);
    eq('最終更新日が無ければ null', byId['T009'].stillDays, null);
    // 「11月3日 開始予定」と「止まっている」を見分けるための数。
    eq('開始予定日までの日数を運ぶ', byId['T010'].startsInDays, 395);
    eq('開始予定日が無ければ null', byId['T009'].startsInDays, null);
  }

  section('保留は読みに反映される');
  {
    const rows = (await new FdpSheets('x', fakeFetch(LEDGER)).fetchTab('課題台帳', '課題名')).rows;
    const holds = new Map([
      ['T006', { taskId: 'T006', heldUntil: '2026-10-31', reason: '薬理期末が終わるまで', setBy: 'user', setAt: '2026-08-31T00:00:00.000Z' }],
    ]);
    const { tasks } = summariseTasks(rows, TODAY, DEFAULT_SETTINGS, holds);
    const t6 = tasks.find((t) => t.id === 'T006')!;
    eq('保留中は保留と出る', t6.verdict, '保留');
    // シート側は保留を知らないので、食い違うのが正しい。
    eq('シートは相変わらず更新停止と言っている', t6.sheetVerdict, '更新停止');
    eq('保留の期限を運ぶ', t6.heldUntil, '2026-10-31');
    eq('保留の残り日数を運ぶ', t6.heldUntilInDays, 61);
    eq('理由を運ぶ', t6.holdReason, '薬理期末が終わるまで');
    eq('誰が止めたかを運ぶ', t6.holdSetBy, 'user');
    const other = tasks.find((t) => t.id === 'T005')!;
    eq('保留していない課題は影響を受けない', other.heldUntil, null);
    // 意図して止めたものは、手が要るものより下に落ちる。
    eq('保留は一番下', tasks[tasks.length - 1].id, 'T006');
  }

  section('期限を過ぎた行');
  {
    const overdue = csv([HEADERS, ['T099', '過ぎたもの', '', '', '2026/08/01', '2026/08/24', '進行中', '', '', '', '遅延']]);
    const rows = (await new FdpSheets('x', fakeFetch(overdue)).fetchTab('課題台帳', '課題名')).rows;
    const { tasks } = summariseTasks(rows, TODAY);
    eq('超過は負の日数で出る', tasks[0].dueInDays, -7);
  }

  section('読めなかったときは「0件」と別物になる');
  {
    const down = await new FdpTasksService(new FdpSheets('x', fakeFetch('', false, 500))).read(TODAY);
    check('シートが落ちたら ok:false', down.ok === false);
    check('理由が入る', down.ok === false && !!down.error);
    check('tasks を持たない（空配列を返さない）', !('tasks' in down));

    // gviz は存在しないタブに対して「最初のタブ」を200で返す。列で気づく。
    const wrongTab = csv([['日付', '科目'], ['2026/09/17', '微・免（再試）']]);
    const guarded = await new FdpTasksService(new FdpSheets('x', fakeFetch(wrongTab))).read(TODAY);
    check('別タブを掴んだら ok:false', guarded.ok === false);
    check('別タブの理由に列名が出る', guarded.ok === false && guarded.error.includes('課題名'));

    const empty = await new FdpTasksService(new FdpSheets('x', fakeFetch(csv([HEADERS])))).read(TODAY);
    check('本当に0件なら ok:true の 0件', empty.ok === true && empty.tasks.length === 0);
  }

  console.log(`\n${failed === 0 ? '✓' : '✗'} ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log(failures.map((f) => `  - ${f}`).join('\n'));
    process.exit(1);
  }
}

main();
