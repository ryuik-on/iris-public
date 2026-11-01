/**
 * Learning where an event belongs and how its title is shaped, from past events.
 *
 * Run: npx tsx scripts/test-calendar-habit.ts
 */
import { learnCalendarHabit } from '../server/core/calendar_habit.js';

let passed = 0;
const failures: string[] = [];
const ok = (name: string, cond: boolean, detail = '') => { if (cond) passed++; else failures.push(`${name} ${detail}`); };

const e = (title: string, calendar: string) => ({ title, calendar });
const past = [
  e('サンプル 出勤', '職場'), e('サンプル チーフ講師mtg', '職場'), e('サンプル たろうくん', '職場'), e('サンプル 面談', '職場'),
  e('コスモ', '職場'), e('薬理学52-54', 'Google'), e('病理学35-36 実習', 'Google'),
];
const h = learnCalendarHabit(past, 'サンプル田中さん面談');
ok('a title starting with a known workplace goes to the calendar it always went to', h?.calendar === '職場' && h.lead === 'サンプル' && h.count === 4, JSON.stringify(h));
ok('and takes the shape of the earlier titles: head word, space, the rest', h?.title === 'サンプル 田中さん面談');
ok('a title already in that shape is left alone', learnCalendarHabit(past, 'サンプル 田中さん面談')?.title === 'サンプル 田中さん面談');
ok('an unknown first word learns nothing', learnCalendarHabit(past, '歯医者の予約') === null);
ok('too few examples are not a habit', learnCalendarHabit([e('A社 出勤', '職場'), e('A社 mtg', '職場')], 'A社会議') === null);
ok('a split habit is not a habit either', learnCalendarHabit([e('B社 a', '職場'), e('B社 b', '職場'), e('B社 c', '自宅'), e('B社 d', '自宅')], 'B社 x') === null);
ok('single-word past titles carry no head word', learnCalendarHabit([e('コスモ', '職場'), e('コスモ', '職場'), e('コスモ', '職場')], 'コスモ授業') === null);
ok('the longest known head word wins', learnCalendarHabit([...past, e('サンプル本社 来訪', '自宅'), e('サンプル本社 打合せ', '自宅'), e('サンプル本社 食事', '自宅')], 'サンプル本社の件')?.calendar === '自宅');

// 題から外された頭の語は、打った文から戻す
const typed = '10/7の20時から、サンプル田中さん面談';
const r = learnCalendarHabit(past, '田中さんの面談', typed);
ok('a head word the reader dropped from the title is restored from what was typed', r?.title === 'サンプル 田中さんの面談' && r.calendar === '職場', JSON.stringify(r));
ok('without it in the typed text nothing is added', learnCalendarHabit(past, '田中さんの面談', '10/7の20時から田中さん面談') === null);
ok('a title that already has it is not doubled', learnCalendarHabit(past, 'サンプル 田中さんの面談', typed)?.title === 'サンプル 田中さんの面談');

console.log(`Calendar habit: ${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log(failures.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
console.log('All calendar habit tests passed.');
