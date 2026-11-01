/**
 * "/カレンダー 来週" and friends: which week the typed command opens.
 *
 * Run: npx tsx scripts/test-calendar-command.ts
 */
import { parseCalendarCommand } from '../src/calendarCommand.js';

let passed = 0;
const failures: string[] = [];
const eq = (name: string, a: unknown, b: unknown) => { if (JSON.stringify(a) === JSON.stringify(b)) passed++; else failures.push(`${name}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };

const now = new Date(2026, 9, 1, 15, 0); // 2026-10-01 木
const ymd = (d: Date | undefined) => d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : null;
const at = (text: string) => ymd(parseCalendarCommand(text, now)?.start);

eq('bare command is this week', at('/カレンダー'), '2026-10-01');
eq('来週', at('/カレンダー 来週'), '2026-10-08');
eq('再来週', at('/予定 再来週'), '2026-10-15');
eq('先週', at('/週 先週'), '2026-09-24');
eq('明日', at('/カレンダー 明日'), '2026-10-02');
eq('3週間後', at('/カレンダー 3週間後'), '2026-10-22');
eq('10日後', at('/カレンダー 10日後'), '2026-10-11');
eq('an ISO date', at('/カレンダー 2026-10-26'), '2026-10-26');
eq('a month/day', at('/カレンダー 10/26'), '2026-10-26');
eq('月日 with kanji', at('/カレンダー 11月3日'), '2026-11-03');
eq('English alias', at('/cal'), '2026-10-01');
eq('a day that does not exist is refused', at('/カレンダー 2/30'), null);
eq('words it does not know are refused, not read as this week', at('/カレンダー そのうち'), null);
eq('ordinary text is not a command', at('来週の予定を教えて'), null);
eq('a command needs the slash', at('カレンダー 来週'), null);

console.log(`Calendar command: ${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log(failures.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
console.log('All calendar command tests passed.');
