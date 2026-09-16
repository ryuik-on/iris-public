/**
 * 台帳を IRIS 側に持ったときの規則。
 *
 * Run: npm run test:fdp-ledger
 */
import { openDatabase } from '../server/services/db.js';
import { FdpLedgerStore, asSheetRow, WRITABLE } from '../server/services/fdp_ledger_sqlite.js';
import { verdictFor } from '../server/core/fdp_verdict.js';

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
function eq(name: string, a: any, b: any) {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  check(name, ok, ok ? undefined : `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
function section(t: string) { console.log(`\n▸ ${t}`); }

const NOW = new Date(2026, 8, 1);
const ROWS = [
  { ID: 'T005', 課題名: '研究室の現在地を確認する', 分野: '研究準備', 優先度: '高',
    開始予定日: '2026/08/31', 期限: '2026/09/30', 状態: '未着手', 進捗率: '0',
    '想定時間(h)': '3', '実績時間(h)': '', 最終更新日: '2026/08/31',
    '完了条件／成果物': '…', 次の行動: 'PubMed', 大阪大学実習への接続: '…',
    自動判定: '順調', 管理区分: 'Founder Development Program' },
  { ID: 'T006', 課題名: '機械学習基礎', 分野: 'AI基礎', 優先度: '高',
    開始予定日: '2026/07/30', 期限: '2026/11/16', 状態: '進行中', 進捗率: '0.05',
    最終更新日: '2026/08/03', 次の行動: 'Week0', 自動判定: '更新停止' } as any,
  { ID: '', 課題名: '空行' } as any,
];

const db = openDatabase(':memory:', { wal: false });
const store = new FdpLedgerStore(db);

section('取り込み');
{
  const r = store.importFromSheet(ROWS, NOW);
  eq('IDのある行だけ入る', [r.imported, r.skipped], [2, 1]);
  eq('件数', store.count(), 2);
  const t = store.get('T005')!;
  eq('文字列が入る', t.title, '研究室の現在地を確認する');
  eq('数値は数値で入る', t.progress, 0);
  // 空欄を 0 にすると「記録なし」と「0時間やった」が同じになる。
  eq('空欄の数値は null', t.actualHours, null);
  eq('取り込み直後は書き込み主体なし', t.updatedBy, null);
  // 取り込みは冪等。二度走らせても増えない。
  store.importFromSheet(ROWS, NOW);
  eq('二度目でも件数は増えない', store.count(), 2);
}

section('判定は台帳の行からそのまま出せる');
{
  const t6 = store.get('T006')!;
  eq('シートの見出し形に戻せる', asSheetRow(t6)['状態'], '進行中');
  eq('その形のまま判定できる', verdictFor(asSheetRow(t6), NOW), '更新停止');
}

section('書き込みは誰がやったかを残す');
{
  const w = store.update('T006', 'status', '完了', 'user', NOW);
  eq('前の値を持つ', w.oldValue, '進行中');
  eq('新しい値を持つ', w.newValue, '完了');
  eq('シートのどの列に対応するか', w.sheetColumn, '状態');
  const t = store.get('T006')!;
  eq('本体が変わる', t.status, '完了');
  eq('主体が残る', t.updatedBy, 'user');
  // 最終更新日が動かないと、更新停止の判定が書き込みを見落とす。
  eq('最終更新日が今日になる', t.lastUpdated, '2026/09/01');
  eq('判定が変わる', verdictFor(asSheetRow(t), NOW), '完了');

  const h = store.history('T006') as any[];
  eq('履歴が1件', h.length, 1);
  eq('履歴に主体が入る', h[0].writtenBy, 'user');
}

section('書けないもの・書けない主体は断る');
{
  let e1 = '';
  try { store.update('T006', '自動判定', '順調', 'user', NOW); } catch (err: any) { e1 = err.message; }
  check('自動判定は書き換えられない', e1.includes('書き換えできない'), e1);
  check('自動判定はそもそも書ける項目に入っていない', !('自動判定' in WRITABLE));

  let e2 = '';
  try { store.update('T006', 'status', '完了', '  ', NOW); } catch (err: any) { e2 = err.message; }
  check('主体なしは断る', e2.includes('主体'), e2);

  let e3 = '';
  try { store.update('T999', 'status', '完了', 'user', NOW); } catch (err: any) { e3 = err.message; }
  check('無い課題は断る', e3.includes('見つかりません'), e3);

  let e4 = '';
  try { store.update('T006', 'progress', 'いっぱい', 'user', NOW); } catch (err: any) { e4 = err.message; }
  check('数値の項目に文字は入らない', e4.includes('数値'), e4);
}

section('シートへ届かなかった書き込みは数えられる');
{
  const before = store.unmirrored().length;
  const w = store.update('T005', 'nextAction', '検索式を実行する', 'iris-70', NOW);
  // 記録するまでは未反映。既に溜まっている分にもう1件積み上がる。
  eq('書いた直後は未反映', store.unmirrored().length, before + 1);
  store.recordMirror(w.rowId, false, 'HTTP 500');
  const stale = store.unmirrored();
  eq('失敗しても未反映のまま', stale.length, before + 1);
  eq('理由が残る', stale.find((r) => r.taskId === 'T005')!.error, 'HTTP 500');
  store.recordMirror(w.rowId, true);
  // シートが古いままなのを 0 と見せると、日次メールが古い値を配り続けても気づけない。
  eq('反映できたら消える', store.unmirrored().length, before);
  check('反映前の書き込みは残ったまま', before > 0);
}

section('取り込みは IRIS の書き込みを消しうる');
{
  // だから API は2回目を force なしで断る。ここではその危険を固定しておく。
  const before = store.get('T006')!.status;
  eq('書き込み後の値', before, '完了');
  store.importFromSheet(ROWS, NOW);
  eq('取り込み直すとシートの値に戻る', store.get('T006')!.status, '進行中');
}

console.log(`\n${failed === 0 ? '✓' : '✗'} ${passed} passed, ${failed} failed`);
if (failed > 0) { console.log(failures.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
