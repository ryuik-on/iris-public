/**
 * 週の暦の配置。
 *
 * ここが間違えると、予定が**それらしい顔で嘘の時刻に座る。**日をまたぐもの、
 * 終日のもの、重なるもの —— どれも描けてしまうので、目では気づけない。
 *
 * Run: npx tsx scripts/test-week-calendar.ts
 */
import { addDays, dayKey, hourRange, layoutDay, mondayOf } from '../src/weekCalendar.js';
import type { ScheduleEvent } from '../src/api.js';

let passed = 0, failed = 0;
const failures: string[] = [];
function section(n: string) { console.log(`\n▸ ${n}`); }
function eq(n: string, a: any, b: any) {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (ok) { passed++; console.log(`  ✓ ${n}`); }
  else { failed++; failures.push(`${n}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`); console.log(`  ✗ ${n}`); }
}

const timed = (start: string, end: string | null, title = start): ScheduleEvent => ({
  title, start: `${start}:00+09:00`, end: end ? `${end}:00+09:00` : null, allDay: false,
});
const allDay = (start: string, end: string | null, title: string): ScheduleEvent => ({
  title, start, end, allDay: true,
});

section('週は月曜から');
{
  // 2026-09-30 は水曜（`date -j` で確かめた）。
  eq('水曜の週の月曜', dayKey(mondayOf(new Date(2026, 8, 30))), '2026-09-28');
  eq('日曜は前の月曜の週', dayKey(mondayOf(new Date(2026, 9, 4))), '2026-09-28');
  eq('月曜はその日', dayKey(mondayOf(new Date(2026, 9, 5))), '2026-10-05');
  eq('月をまたいでも足せる', dayKey(addDays(new Date(2026, 8, 28), 7)), '2026-10-05');
}

section('時刻のある予定');
{
  const day = layoutDay([timed('2026-09-30T08:30', '2026-09-30T10:40', '病理学')], '2026-09-30');
  eq('始まりは 0 時からの分', day.timed[0].from, 8 * 60 + 30);
  eq('終わりも', day.timed[0].to, 10 * 60 + 40);
  eq('別の日には出ない', layoutDay([timed('2026-09-30T08:30', '2026-09-30T10:40')], '2026-10-01').timed.length, 0);
}
{
  // 22 時から翌 2 時。**開始日で束ねると、翌日に一分も現れない。**
  const e = timed('2026-10-01T22:00', '2026-10-02T02:00', '夜勤');
  const first = layoutDay([e], '2026-10-01').timed[0];
  const second = layoutDay([e], '2026-10-02').timed[0];
  eq('一日目は 24 時で切る', [first.from, first.to], [22 * 60, 24 * 60]);
  eq('一日目は次へ続くと言う', first.continuesAfter, true);
  eq('二日目にも現れる', [second.from, second.to], [0, 2 * 60]);
  eq('二日目は前から続くと言う', second.continuesBefore, true);
}
{
  const e = timed('2026-10-01T09:00', null, '終わりの無い予定');
  const p = layoutDay([e], '2026-10-01').timed[0];
  eq('終わりの無い予定は 30 分の床', p.to - p.from, 30);
}

section('終日の予定');
{
  // Google の終日は終わりの日を含まない。
  const e = allDay('2026-10-03', '2026-10-04', 'SUPER BEAVER');
  eq('その日に出る', layoutDay([e], '2026-10-03').allDay.length, 1);
  eq('終わりの日には出ない', layoutDay([e], '2026-10-04').allDay.length, 0);
  eq('前の日にも出ない（UTC で読むと前日に化ける）', layoutDay([e], '2026-10-02').allDay.length, 0);
  eq('縦軸には置かない', layoutDay([e], '2026-10-03').timed.length, 0);
}
{
  const e = allDay('2026-10-03', '2026-10-06', '三日間');
  eq('何日もかかるものは各日に出る',
     ['2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06'].map((d) => layoutDay([e], d).allDay.length),
     [1, 1, 1, 0]);
  eq('終わりが無ければ始まりの日だけ', layoutDay([allDay('2026-10-03', null, 'x')], '2026-10-04').allDay.length, 0);
}

section('重なる予定は並べる');
{
  // 10/6 の実データ：16:20-17:20 と 17:00-22:00 が重なり、朝と昼は重ならない。
  const day = layoutDay([
    timed('2026-10-06T08:30', '2026-10-06T11:50', '薬理学'),
    timed('2026-10-06T12:50', '2026-10-06T15:00', '病理学'),
    timed('2026-10-06T16:20', '2026-10-06T17:20', '動物実験'),
    timed('2026-10-06T17:00', '2026-10-06T22:00', '出勤'),
  ], '2026-10-06');
  const by = (t: string) => day.timed.find((p) => p.event.title === t)!;
  eq('重なっていない予定は全幅（下書きでは半分になっていた）', [by('薬理学').columns, by('病理学').columns], [1, 1]);
  eq('重なる二つは二列', [by('動物実験').columns, by('出勤').columns], [2, 2]);
  eq('別の列に置く', by('動物実験').column !== by('出勤').column, true);
}
{
  // 終わりと始まりが同じ時刻なら、重なっていない。
  const day = layoutDay([
    timed('2026-10-01T08:30', '2026-10-01T09:30', 'a'),
    timed('2026-10-01T09:30', '2026-10-01T10:30', 'b'),
  ], '2026-10-01');
  eq('接しているだけなら並べない', day.timed.map((p) => p.columns), [1, 1]);
}
{
  // 同じ時刻の二つ（別のカレンダーに同じ予定）。隠さず並べる。
  const day = layoutDay([
    timed('2026-09-30T18:30', '2026-09-30T19:30', 'HOT PEPPER'),
    timed('2026-09-30T18:30', '2026-09-30T19:30', '散髪'),
  ], '2026-09-30');
  eq('同じ時刻の二つは二列', day.timed.map((p) => p.columns), [2, 2]);
}
{
  // 一列目が空いたら再利用する。三つ目が三列目に行くと、必要以上に細くなる。
  const day = layoutDay([
    timed('2026-10-01T09:00', '2026-10-01T10:00', 'a'),
    timed('2026-10-01T09:30', '2026-10-01T11:00', 'b'),
    timed('2026-10-01T10:00', '2026-10-01T10:30', 'c'),
  ], '2026-10-01');
  const c = day.timed.find((p) => p.event.title === 'c')!;
  eq('空いた列を使う', [c.column, c.columns], [0, 2]);
}

section('縦軸');
{
  eq('既定は 8 時から 24 時', hourRange([layoutDay([timed('2026-10-01T09:00', '2026-10-01T10:00')], '2026-10-01')]),
     { from: 480, to: 1440 });
  eq('早い予定があれば、その時刻の頭まで広げる',
     hourRange([layoutDay([timed('2026-10-01T06:40', '2026-10-01T07:10')], '2026-10-01')]).from, 360);
  eq('前の日から続くものは 0 時から',
     hourRange([layoutDay([timed('2026-09-30T23:00', '2026-10-01T01:00')], '2026-10-01')]).from, 0);
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`Week calendar: ${passed} passed, ${failed} failed`);
if (failed) { console.log('\nFailures:'); for (const f of failures) console.log('  - ' + f); process.exit(1); }
console.log('All week calendar tests passed.');
