import { findDuplicateEvents, composeLectureCheck } from '../server/core/lecture_check.js';

let passed = 0;
const failures: string[] = [];
const eq = (name: string, a: unknown, b: unknown) => { if (JSON.stringify(a) === JSON.stringify(b)) passed++; else failures.push(`${name}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };

const ev = (title: string, start: string, end: string, calendar = 'g', location?: string) => ({ title, start, end, calendar, location });

// 重複
const dups = findDuplicateEvents([
  ev('病理学Ⅰ実習41-42', '2026-10-19T12:50:00+09:00', '2026-10-19T15:00:00+09:00', 'g', '教育棟5F501'),
  ev('病理学Ⅰ実習 41-42', '2026-10-19T12:50:00+09:00', '2026-10-19T15:00:00+09:00'),
  ev('病理学I実習41-42', '2026-10-20T12:50:00+09:00', '2026-10-20T15:00:00+09:00'),
]);
eq('空白だけ違う二件は重複', dups.length, 1);
eq('重複の日時', dups[0]?.start, '2026-10-19T12:50');
eq('場所の有る無しが題の後ろに出る', dups[0]?.titles, ['病理学Ⅰ実習41-42（教育棟5F501）', '病理学Ⅰ実習 41-42（場所なし）']);
eq('別のカレンダーの同じ予定は重複ではない', findDuplicateEvents([
  ev('授業', '2026-10-19T09:00:00+09:00', '2026-10-19T10:00:00+09:00', 'a'), ev('授業', '2026-10-19T09:00:00+09:00', '2026-10-19T10:00:00+09:00', 'b')]).length, 0);
eq('終日の予定は見ない', findDuplicateEvents([ev('祝日', '2026-10-12', '2026-10-13'), ev('祝日', '2026-10-12', '2026-10-13')]).length, 0);
eq('時刻が違えば重複ではない', findDuplicateEvents([
  ev('授業', '2026-10-19T09:00:00+09:00', '2026-10-19T10:00:00+09:00'), ev('授業', '2026-10-19T13:00:00+09:00', '2026-10-19T14:00:00+09:00')]).length, 0);

// 文面
const clean = { compared: true, missing: [], moved: [], shifted: [], surplus: [] };
eq('ずれが無ければ何も言わない', composeLectureCheck({ gap: clean, duplicates: [], source: 'a.pdf', lastSource: 'a.pdf', couldNotRead: [] }), null);
eq('初回（前回の版が無い）は版の知らせを出さない', composeLectureCheck({ gap: clean, duplicates: [], source: 'a.pdf', lastSource: null, couldNotRead: [] }), null);
const missing = composeLectureCheck({ gap: { ...clean, missing: [{ date: '2026-10-19', title: '薬理学期末試験' }] }, duplicates: [], source: 'a.pdf', lastSource: 'a.pdf', couldNotRead: [] });
eq('無い授業は日付と題で出る', /10\/19 薬理学期末試験/.test(missing?.text ?? ''), true);
eq('版が変わったら知らせる', /新しくなりました/.test(composeLectureCheck({ gap: clean, duplicates: [], source: 'b.pdf', lastSource: 'a.pdf', couldNotRead: [] })?.text ?? ''), true);
eq('重複は件数と日時で出る', /重なっている 1 件.*10\/19 12:50/.test(composeLectureCheck({ gap: clean, duplicates: dups, source: 'a', lastSource: 'a', couldNotRead: [] })?.text ?? ''), true);
eq('突き合わせできなかったことは「ずれなし」にしない', /できませんでした: 日程表を読めません/.test(composeLectureCheck({ gap: { compared: false, reason: '日程表を読めません' }, duplicates: [], source: null, lastSource: null, couldNotRead: [] })?.text ?? ''), true);
eq('読めなかったものは書く', /読めなかったもの.*予定: 503/.test(composeLectureCheck({ gap: null, duplicates: [], source: null, lastSource: null, couldNotRead: ['予定: 503'] })?.text ?? ''), true);

console.log(`Lecture check: ${passed} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
console.log('All lecture check tests passed.');
