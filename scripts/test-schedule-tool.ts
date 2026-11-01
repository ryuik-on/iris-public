/**
 * The lecture-schedule tool: IRIS reads the imported schedule, and nothing else.
 *
 * Run: npx tsx scripts/test-schedule-tool.ts
 */
import { createScheduleTools, SCHEDULE_ORIGINALS } from '../server/tools/schedule.js';
import { readScheduleLectures, isGakushiOnly, ScheduleLectureRead } from '../server/services/schedule_exams.js';
import { RiskLevel } from '../server/core/types.js';

let passed = 0;
const failures: string[] = [];
function eq(name: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) passed++;
  else failures.push(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
async function rejects(name: string, f: () => Promise<unknown>, pattern: RegExp) {
  try { await f(); failures.push(`${name}: did not throw`); }
  catch (err: any) { if (pattern.test(err?.message ?? '')) passed++; else failures.push(`${name}: wrong error ${err?.message}`); }
}

const item = (date: string, title: string, period: number, span: number, start: string) =>
  ({ title, date, period, span, start, startBasis: 'measured' });

const fake: ScheduleLectureRead = {
  lectures: [
    item('2026-09-29', '薬理学52-54', 1, 3, '08:30'),
    item('2026-09-29', '病理学Ⅰ33-34', 4, 2, '12:50'),
    item('2026-10-05', '薬理学 58-60 (実習オリエンテーション)', 4, 3, '12:50'),
  ],
  exams: [item('2026-10-26', '病理学Ⅱ各論試験', 4, 1, '12:50')],
  gridFaults: [], source: '講義日程_2026.6.19.pdf', reason: null,
};

(async () => {
  const [tool] = createScheduleTools(() => fake);
  eq('a read-only tool', tool.riskLevel, RiskLevel.READ);

  const day: any = await tool.execute({ from: '2026-09-29' });
  eq('a day lists its items in time order', day.items.map((i: any) => i.title), ['薬理学52-54', '病理学Ⅰ33-34']);
  eq('weekday is the calendar weekday', day.items[0].weekday, '火');
  eq('a three-period morning ends at 11:50', day.items[0].end, '11:50');
  eq('the originals are named', day.originals, SCHEDULE_ORIGINALS);

  const q: any = await tool.execute({ query: '薬理学58-60' });
  eq('spaces in the title do not hide a match', q.items.map((i: any) => i.date), ['2026-10-05']);
  eq('58-60 is not on 9/29', (await tool.execute({ from: '2026-09-29', query: '58-60' }) as any).matched, 0);
  eq('an empty answer says it read successfully', (await tool.execute({ from: '2026-09-29', query: '58-60' }) as any).note.includes('成功'), true);

  const exam: any = await tool.execute({ from: '2026-10-26' });
  eq('exams are included and marked', exam.items[0].kind, '試験');

  await rejects('no date and no query is refused', async () => tool.execute({}), /指定してください/);
  await rejects('a bad date is refused', async () => tool.execute({ from: '9/29' }), /YYYY-MM-DD/);

  const [broken] = createScheduleTools(() => ({ lectures: [], exams: [], gridFaults: [], source: null, reason: '講義日程の取り込みがありません。' }));
  await rejects('an unreadable schedule is an error, not "none"', async () => broken.execute({ from: '2026-09-29' }), /読めませんでした/);

  eq('a 学士-only lecture is recognised, spaces and all', isGakushiOnly('動物実験 の基礎（学 士）1'), true);
  eq('a title cut short is still recognised', isGakushiOnly('の基礎（学 士）8※501 使用不可'), true);
  eq('the 学士入学 orientation is recognised', isGakushiOnly('学士入学 生オリエン テーション'), true);
  eq('a note that names 学士編入学生 is not a 学士 lecture', isGakushiOnly('体験学習（学士編入学生は7時限履修のため不可）'), false);
  eq('an ordinary lecture is not', isGakushiOnly('薬理学58-60 (実習オリエンテーション)'), false);

  // The real imported schedule, when it is here.
  const real = readScheduleLectures(process.cwd());
  if (real.lectures.length) {
    const [live] = createScheduleTools(() => real);
    eq('the real schedule has no 動物実験の基礎（学士）', real.lectures.some((l) => /動物実験/.test(l.title) && isGakushiOnly(l.title)), false);
    eq('and says how many it left out', (real.notApplicable ?? 0) >= 16, true);
    eq('the real schedule has 薬理学58-60 only on 10/5',
      ((await live.execute({ query: '薬理学58-60' })) as any).items.map((i: any) => i.date), ['2026-10-05']);
  }

  console.log(`Schedule tool: ${passed} passed, ${failures.length} failed`);
  if (failures.length) { console.log(failures.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
  console.log('All schedule tool tests passed.');
})();
