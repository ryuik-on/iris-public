/**
 * 日程表の授業を、カレンダーに入れられる形にする。
 *
 * 確かめるのは主に**長さを作らないこと。**終わりの分からない予定に既定値を
 * 入れると、推測が予定の顔で本物のカレンダーに残る。
 *
 * Run: npx tsx scripts/test-lecture-events.ts
 */
import { toLectureEvents, periodsIn } from '../server/core/lecture_events.js';

let passed = 0, failed = 0;
const failures: string[] = [];
function section(n: string) { console.log(`\n▸ ${n}`); }
function eq(n: string, a: any, b: any) {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (ok) { passed++; console.log(`  ✓ ${n}`); }
  else { failed++; failures.push(`${n}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`); console.log(`  ✗ ${n}`); }
}

section('長さは、紙の上の幅から');
{
  /*
   * 時限は 70分間隔（08:30 / 09:40 / 10:50、実測）。カレンダーの授業は
   * 130分と 200分だけで、2コマ=130・3コマ=200。どちらも 70n-10 に乗る。
   */
  const { events } = toLectureEvents([
    { title: '病理学Ⅱ31-32', date: '2026-09-09', period: 1, start: '08:30', span: 2 },
    { title: '薬理学46-48', date: '2026-09-14', period: 1, start: '08:30', span: 3 },
  ]);
  eq('2コマは130分', events[0].end, '2026-09-09T10:40');
  eq('3コマは200分', events[1].end, '2026-09-14T11:50');
  eq('実測だと言う', events.map((e) => e.lengthBasis), ['measured', 'measured']);
}

section('昼を跨ぐ長さ');
{
  /*
   * 最初は `コマ数 × 70 - 10` にしていた。2コマ=130・3コマ=200 に合い、
   * 1コマ=60 にも合ったので正しく見えた。**3限と4限のあいだだけ120分空いて
   * いる** —— 昼。跨ぐと式が合わない。表を引けば式は要らない。
   */
  const { events } = toLectureEvents([
    { title: '動物実験の基礎', date: '2026-09-29', period: 7, start: '16:20', span: 1 },
    { title: '琉大祭準備', date: '2026-09-25', period: 1, start: '08:30', span: 7 },
    { title: '午後2コマ', date: '2026-09-25', period: 4, start: '12:50', span: 2 },
  ]);
  eq('1コマは60分', events[0].end, '2026-09-29T17:20');
  // 式なら 08:30+480 = 16:30。実際は 7限 16:20 + 60 = 17:20。
  eq('7コマは昼のぶん長い', events[1].end, '2026-09-25T17:20');
  eq('午後だけの2コマは130分', events[2].end, '2026-09-25T15:00');
  eq('根拠は表', events.map((e) => e.lengthBasis), ['measured', 'measured', 'measured']);
}

section('幅が読めないときは題名の番号。どちらも無ければ長さを決めない');
{
  eq('番号から読む', periodsIn('病理学Ⅱ31-32'), 2);
  eq('三つぶん', periodsIn('薬理学43-45'), 3);
  eq('番号が無ければ null', periodsIn('琉大祭準備'), null);
  // 一日は7コマ。それを超える読みは番号の読み違い。
  eq('大きすぎる幅は読み違い', periodsIn('資料1-90'), null);

  const { events } = toLectureEvents([
    { title: '病理学Ⅱ31-32', date: '2026-09-09', period: 1, start: '08:30' },
  ]);
  eq('幅が無ければ番号に落ちる', events[0].end, '2026-09-09T10:40');

  const unknown = toLectureEvents([
    { title: '琉大祭準備', date: '2026-09-25', period: 1, start: '08:30' },
  ]);
  eq('どちらも無ければ終わりは空', unknown.events[0].end, null);
  eq('根拠も空。既定値で埋めない', unknown.events[0].lengthBasis, null);
}

section('始まりが決まらないものは入れない');
{
  const { events, skipped } = toLectureEvents([
    { title: '時限不明', date: '2026-09-09', period: null, start: null, span: 2 },
    { title: '入る方', date: '2026-09-09', period: 1, start: '08:30', span: 2 },
  ]);
  eq('落とす', events.length, 1);
  // 終日で入れると、その日が丸ごと埋まって見える。
  eq('落としたことは数えられる', skipped.map((s) => s.title), ['時限不明']);
}

section('表に無い時限は、長さを決めない');
{
  /*
   * 一日は7限まで。8限から始まる、あるいは7限を超えて伸びるものは表を
   * 引けない。**そこで式に戻ると、跨ぎの間違いが復活する。**空にする。
   */
  const { events } = toLectureEvents([
    { title: '範囲外', date: '2026-09-09', period: 7, start: '16:20', span: 3 },
  ]);
  eq('終わりは空', events[0].end, null);
  eq('根拠も空', events[0].lengthBasis, null);
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`Lecture events: ${passed} passed, ${failed} failed`);
if (failed) { console.log('\nFailures:'); for (const f of failures) console.log('  - ' + f); process.exit(1); }
console.log('All lecture event tests passed.');
