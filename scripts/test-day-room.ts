/**
 * いまから先に残っている時間。
 *
 * 確かめるのは主に**「言えない」と「無い」を混ぜないこと。**枠が残って
 * いないのは答えで、読めていないのは答えではない。画面ではどちらも
 * 「空きなし」に見えるので、ここで分けておかないと分かれない。
 *
 * Run: npx tsx scripts/test-day-room.ts
 */
import { roomLeftToday, describeRoom } from '../server/core/day_room.js';
import type { FreeDay } from '../server/services/free_time.js';

let passed = 0, failed = 0;
const failures: string[] = [];
function section(name: string) { console.log(`\n▸ ${name}`); }
function eq(name: string, actual: any, expected: any) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(`${name}: ${JSON.stringify(actual)} ≠ ${JSON.stringify(expected)}`); console.log(`  ✗ ${name}`); }
}

const day = (slots: Array<[string, string]>): FreeDay => ({
  date: '2026-09-08',
  slots: slots.map(([from, to]) => ({ from, to })),
  note: null,
});
const at = (h: number, m = 0) => new Date(2026, 8, 8, h, m);

section('過ぎた分を落とす');
{
  const free = day([['09:00', '12:00'], ['13:00', '17:00']]);

  const morning = roomLeftToday(free, at(8));
  eq('始まる前なら両方まるごと', morning.slots.map((s) => [s.from, s.to]),
     [['09:00', '12:00'], ['13:00', '17:00']]);
  eq('合計もまるごと', morning.totalMinutes, 180 + 240);

  const midday = roomLeftToday(free, at(10, 30));
  eq('進行中の枠は、いまから', midday.slots.map((s) => [s.from, s.to]),
     [['10:30', '12:00'], ['13:00', '17:00']]);
  eq('最長は残っている方', midday.longestMinutes, 240);

  const evening = roomLeftToday(free, at(16, 30));
  eq('60分に満たない残りは出さない', evening.slots.length, 0);
  eq('それは「無い」であって「言えない」ではない', evening.reason, null);
  eq('数は 0 で返る', [evening.longestMinutes, evening.totalMinutes], [0, 0]);
}

section('「言えない」と「無い」を混ぜない');
{
  /*
   * 源が欠けている日の空きは、授業中の時刻を空きとして渡すことになる。
   * `free_time` が同じところで止まっているのと同じ理由で、ここも止まる。
   * **そしてこちらは「いま手を付けられる」という顔で出る**ぶん、悪い。
   */
  const blocked = roomLeftToday(day([['09:00', '24:00']]), at(10), {
    blocked: 'Google が読めていないため、空き時間は出しません。',
  });
  eq('塞がっていれば枠を出さない', blocked.slots, []);
  eq('数は null。0 ではない', [blocked.longestMinutes, blocked.totalMinutes], [null, null]);
  eq('理由をそのまま持つ', blocked.reason?.includes('Google'), true);

  const missing = roomLeftToday(null, at(10));
  eq('読めていない日も null', missing.longestMinutes, null);
  eq('理由がある', typeof missing.reason === 'string', true);
}

section('人に見せる一行');
{
  eq('枠と最長を言う',
     describeRoom(roomLeftToday(day([['13:00', '17:00'], ['19:00', '20:30']]), at(12))),
     '残り 2枠 ・ 最長 4時間');
  eq('端数も言う',
     describeRoom(roomLeftToday(day([['13:00', '14:30']]), at(12))),
     '残り 1枠 ・ 最長 1時間30分');
  eq('無いときは無いと言う',
     describeRoom(roomLeftToday(day([]), at(12))),
     '今日はもう空きがありません。');
  // 言えないときは、数の代わりに理由がそのまま出る。
  eq('言えないときは理由',
     describeRoom(roomLeftToday(null, at(12))),
     '今日の空きを読めていません。');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`Day room: ${passed} passed, ${failed} failed`);
if (failed) { console.log('\nFailures:'); for (const f of failures) console.log('  - ' + f); process.exit(1); }
console.log('All day room tests passed.');
