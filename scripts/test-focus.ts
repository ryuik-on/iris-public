/**
 * Daily focus tests.
 *
 * One thing per area, not everything known — a list of forty items and a list
 * of five are different products, and only one gets read on a busy morning.
 *
 * The selection rules are ported rather than re-derived, because each one was
 * earned by a specific failure in the dashboard this comes from. The tests
 * name those failures, so a later simplification has to argue with the
 * incident rather than with the code.
 *
 * The gviz guard gets the most attention: a request for a tab that does not
 * exist returns the *first* tab, with a 200 and no sign anything is wrong.
 *
 * Run: npm run test:focus
 */
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { FdpSheets, parseCsv } from '../server/services/fdp_sheets.js';
import { DailyFocusService, parseDate, daysBetween, readContestMarkings } from '../server/core/daily_focus.js';

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

/** Saturday, so the weekday-pinned rule is exercised. */
const TODAY = new Date(2026, 7, 22);

function csv(rows: string[][]): string {
  return rows.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(',')).join('\n');
}

function fakeFetch(tabs: Record<string, string>, log?: string[]): typeof fetch {
  return (async (url: any) => {
    const parsed = new URL(String(url));
    const tab = parsed.searchParams.get('sheet') ?? '';
    log?.push(tab);
    // gviz's actual behaviour: an unknown tab silently yields the first one.
    const body = tabs[tab] ?? tabs[Object.keys(tabs)[0]] ?? '';
    return { ok: true, status: 200, text: async () => body } as any;
  }) as any;
}

const SHEETS = {
  試験日程: csv([
    ['日付', '科目', '区分', '備考'],
    ['2026-08-28', '微生物・免疫学', '本試験', ''],
    ['2026-08-24', '神経科学', '本試験', ''],
  ]),
  課題台帳: csv([
    ['ID', '課題名', '分野', '優先度', '開始予定日', '期限', '状態', '管理区分'],
    ['T003', 'CSVツール', 'Python', '高', '2026-08-01', '2026-08-25', '進行中', ''],
    ['T007', '英語論文', '読解', '中', '2026-08-01', '2026-12-16', '進行中', '週次:土'],
    ['T009', '未来の課題', 'x', '低', '2026-09-01', '2026-09-30', '未着手', ''],
    ['T004', '着手済みだが開始日が未来', 'x', '高', '2026-09-01', '2026-08-26', '進行中', ''],
    ['T001', '終わったもの', 'x', '低', '2026-07-01', '2026-07-10', '完了', ''],
  ]),
  改善ログ: csv([
    ['何が問題か', '状態'],
    ['進行中のもの', '対応中'],
    ['放置されているもの', '未着手'],
    ['済んだもの', '検証済'],
  ]),
  コンテスト: csv([
    ['ID', '日付', '名称', '区分', '備考'],
    // Two days out, optional. The near thing that is not the important thing.
    ['C002', '2026-08-24', 'チーム結成締切', '締切', '23:59。個人参加なら無関係'],
    // Five weeks out, and missing it deletes the one after it.
    ['C011', '2026-09-24', '未踏アドバンスト エントリー締切', '締切',
      '13:00必着。★これを逃すと応募自体不可。※12:50 病理I講義中に締切'],
    ['C016', '2026-09-30', 'GMO DESIGN AWARD 応募締切', '締切', 'グランプリ100万'],
  ]),
  仕事: csv([
    ['ID', '区分', '内容', '状態', '期限', '次の行動'],
    ['W1', '予備校', '月次FB', '対応中', '2026-08-25', 'ダッシュボード更新'],
    ['W2', 'ランサーズ', '納品済み', '完了', '2026-08-01', ''],
  ]),
};

const OS_MD = `
| Task ID | Project ID | Task | Owner | Status | Depends On | Spec | Updated | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TSK-009 | PRJ-001 | 縦断Pilotを実施 | CEO | Done | — | x | 2026-07-29 | 完了 |
| TSK-010 | PRJ-001 | 結果を比較 | CEO | Blocked | TSK-009 | x | 2026-08-13 | Pilot窓の完了待ち |
| TSK-011 | PRJ-001 | 改善Backlogを決定 | CEO | Todo | TSK-010 | x | 2026-08-13 | — |
`;

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'iris-focus-'));
  const osPath = join(dir, 'Active_Projects.md');
  writeFileSync(osPath, OS_MD);

  const service = (tabs = SHEETS, log?: string[]) =>
    new DailyFocusService({
      sheets: new FdpSheets('sheet-id', fakeFetch(tabs as any, log)),
      osActiveProjectsPath: osPath,
      now: () => TODAY,
    });

  try {
    // ---------------------------------------------------------------------
    section('The trap that makes gviz dangerous');

    {
      // A request for a tab that does not exist returns the first tab, 200,
      // parsed correctly, about entirely the wrong subject. Every judgement
      // downstream would be confidently wrong.
      const sheets = new FdpSheets('id', fakeFetch({ 最初のタブ: csv([['別の列'], ['値']]) }));
      const result = await sheets.fetchTab('存在しないタブ', '科目');
      check('a wrong tab is caught by the required column', !result.ok);
      check('and the reason names the behaviour', /最初のタブを返す/.test(result.error ?? ''));
      eq('no rows are handed back', result.rows.length, 0);

      const right = await sheets.fetchTab('最初のタブ', '別の列');
      check('the intended tab passes the same guard', right.ok);
    }

    // ---------------------------------------------------------------------
    section('One item per area');

    {
      const focus = await service().build();
      eq('every area is represented', focus.items.length, 6);
      eq('and each carries at most one thing', focus.items.filter((i) => Array.isArray(i.title)).length, 0);
      eq('the areas are the agreed ones', focus.items.map((i) => i.area), ['exam', 'study', 'improvement', 'os', 'work', 'contest']);
    }

    // ---------------------------------------------------------------------
    section('Exams: the nearest one, and how near');

    {
      const [exam] = (await service().build()).items;
      // 8/24 is nearer than 8/28 despite appearing second in the sheet.
      eq('the nearest upcoming exam wins', exam.title, '神経科学');
      eq('with its date', exam.due, '2026-08-24');
      check('and the distance stated', /あと2日/.test(exam.because ?? ''), exam.because);
    }

    // ---------------------------------------------------------------------
    section('Study: the rules that were earned the hard way');

    {
      const study = (await service().build()).items[1];
      // Sorting purely by deadline buried the Saturday task in fourth place
      // on the very Saturday it was for, because its deadline was furthest.
      check('a weekday-pinned task wins on its weekday', study.title?.includes('T007'), study.title ?? '');
      check('and says why it jumped the queue', /土曜固定/.test(study.because ?? ''), study.because);
    }

    {
      const weekday = new DailyFocusService({
        sheets: new FdpSheets('id', fakeFetch(SHEETS as any)),
        osActiveProjectsPath: osPath,
        now: () => new Date(2026, 7, 20), // Thursday
      });
      const study = (await weekday.build()).items[1];
      eq('on other days the nearest deadline wins', study.title, 'T003 CSVツール');
      // A task already underway whose planned start is still in the future
      // was being dropped entirely by a filter that ignored status.
      check('a started task with a future start date is not dropped',
        (await weekday.build()).items[1].title !== 'T009 未来の課題');
    }

    {
      const onlyFuture = {
        ...SHEETS,
        課題台帳: csv([
          ['ID', '課題名', '分野', '優先度', '開始予定日', '期限', '状態', '管理区分'],
          ['T009', 'まだ始めない', 'x', '低', '2026-09-01', '2026-09-30', '未着手', ''],
        ]),
      };
      const study = (await service(onlyFuture).build()).items[1];
      // Not started and not due to start: correctly absent.
      eq('a genuinely not-yet-started task is excluded', study.title, null);
      check('and the area is still marked readable', study.available);
    }

    // ---------------------------------------------------------------------
    section('Exam proximity frames study rather than removing it');

    {
      // TODAY here is 8/22 and the nearest exam is 8/24: two days, inside the
      // window. (The first version of this said five, which was the distance
      // in the live data rather than in the fixture.)
      const focus = await service().build();
      check('exam mode is on', focus.examMode);
      eq('with the distance stated', focus.daysToExam, 2);
      const study = focus.items[1];
      // The original changes what is said, not what is selected — the task is
      // still chosen by the same rules and still shown.
      check('the study task is still selected', study.title !== null);
      check('and carries the warning', /無理に積まない/.test(study.because ?? ''), study.because);
    }

    {
      const far = {
        ...SHEETS,
        試験日程: csv([['日付', '科目', '区分', '備考'], ['2026-12-01', '遠い試験', '本試験', '']]),
      };
      const focus = await service(far).build();
      check('a distant exam leaves exam mode off', !focus.examMode);
      check('and the study item is unqualified', !/無理に積まない/.test(focus.items[1].because ?? ''));
    }

    // ---------------------------------------------------------------------
    section('Improvements: what is being avoided surfaces first');

    {
      const improvement = (await service().build()).items[2];
      // Recording feedback was not enough on its own; an item sat in the log
      // until someone said it out loud. Visibility is the mechanism.
      eq('an untouched item outranks one in progress', improvement.title, '放置されているもの');
      check('and the backlog size is stated', /2件/.test(improvement.because ?? ''), improvement.because);
    }

    // ---------------------------------------------------------------------
    section('OS: in progress, or the blocker if there is none');

    {
      const os = (await service().build()).items[3];
      // No In Progress row here, so the blocked one stands in — hiding it
      // would make the board look emptier than the work is.
      check('a blocked task stands in for a missing in-progress one', os.title?.includes('TSK-010'), os.title ?? '');
      check('and says so', /ブロック中/.test(os.because ?? ''));
    }

    {
      const withActive = join(dir, 'active.md');
      writeFileSync(withActive, OS_MD.replace('| Todo |', '| In Progress |'));
      const svc = new DailyFocusService({
        sheets: new FdpSheets('id', fakeFetch(SHEETS as any)),
        osActiveProjectsPath: withActive,
        now: () => TODAY,
      });
      const os = (await svc.build()).items[3];
      check('an in-progress task wins outright', os.title?.includes('TSK-011'), os.title ?? '');
      eq('and is labelled as such', os.because, '進行中');
    }

    // ---------------------------------------------------------------------
    section('Deadlines: lead time scales with what missing them costs');

    {
      const contest = (await service().build()).items[5];
      // C002 is two days away and C011 is thirty-three. C011 wins, because
      // missing it forecloses the application after it — by the time it is
      // two days out, knowing may no longer help.
      eq('a foreclosing deadline outranks a nearer optional one', contest.id, 'C011');
      check('and is marked irreversible', contest.irreversible === true);
      check('with the phrase that decided it quoted', /応募自体不可/.test(contest.because ?? ''), contest.because);
      // The sheet already noted the clash; IRIS repeats it rather than
      // rediscovering it.
      check('the clash recorded in the sheet is carried through', /講義中|12:50/.test(contest.conflict ?? ''), contest.conflict);
    }

    {
      const ordinary = {
        ...SHEETS,
        コンテスト: csv([
          ['ID', '日付', '名称', '区分', '備考'],
          ['C002', '2026-08-24', '近い任意の締切', '締切', '任意'],
          ['C016', '2026-09-30', '遠い任意の締切', '締切', '賞金あり'],
        ]),
      };
      const contest = (await service(ordinary).build()).items[5];
      eq('among recoverable deadlines the nearest wins', contest.id, 'C002');
      check('and none is called irreversible', !contest.irreversible);
    }

    {
      const distant = {
        ...SHEETS,
        コンテスト: csv([
          ['ID', '日付', '名称', '区分', '備考'],
          // Beyond the ordinary lead window: real, but not today's problem.
          ['C016', '2026-09-30', '遠い任意の締切', '締切', '任意'],
        ]),
      };
      const contest = (await service(distant).build()).items[5];
      eq('a distant recoverable deadline stays off the board', contest.title, null);
      check('while the area is still readable', contest.available);
    }

    {
      // The sheet's conventions, read rather than reinvented.
      const foreclose = readContestMarkings('13:00必着。★これを逃すと応募自体不可。');
      check('「逃すと…不可」marks foreclosure', foreclose.irreversible);
      check('「必着」does too', readContestMarkings('13:00必着').irreversible);
      check('an ordinary note does not', !readContestMarkings('23:59。任意').irreversible);
      check('a blank note does not', !readContestMarkings('').irreversible);
      // A wrong classification should be arguable, so it says what it matched.
      check('the matched phrase is reported', /応募自体不可/.test(foreclose.matched ?? ''));

      eq('a clash is picked up from ※', readContestMarkings('※12:50 病理I講義中に締切').conflict, '12:50 病理I講義中に締切');
      eq('and from ⚠️', readContestMarkings('⚠️琉大祭と衝突確定').conflict, '琉大祭と衝突確定');
      eq('with none reported when there is none', readContestMarkings('賞金100万').conflict, undefined);
    }

    // ---------------------------------------------------------------------
    section('A source that cannot be read is not an empty source');

    {
      const failing = new FdpSheets('id', (async () => { throw new Error('network down'); }) as any);
      const svc = new DailyFocusService({ sheets: failing, osActiveProjectsPath: osPath, now: () => TODAY });
      const focus = await svc.build();

      // "No exams" and "could not open the exam sheet" look identical in a
      // list and mean opposite things.
      const exam = focus.items[0];
      check('an unreachable sheet is marked unavailable', !exam.available);
      check('with the reason attached', /network down/.test(exam.error ?? ''));
      eq('and it does not masquerade as nothing to do', exam.title, null);
      check('the failed areas are listed together', focus.unavailable.length >= 5, JSON.stringify(focus.unavailable));

      // The local file still works, so one broken source does not blank the board.
      check('an area with a working source still reports', focus.items[3].available);
    }

    {
      const svc = new DailyFocusService({
        sheets: new FdpSheets('id', fakeFetch(SHEETS as any)),
        osActiveProjectsPath: join(dir, 'nope.md'),
        now: () => TODAY,
      });
      const os = (await svc.build()).items[3];
      check('a missing OS file is unavailable rather than empty', !os.available);
      check('and names the path', /nope\.md/.test(os.error ?? ''));
    }

    // ---------------------------------------------------------------------
    section('Parsing');

    {
      // Notes fields contain newlines; splitting on lines first tears a row.
      const rows = parseCsv('"a","b"\n"1","二\n行"\n');
      eq('a newline inside a quoted cell stays in the cell', rows[0]['b'], '二\n行');
      eq('doubled quotes become one', parseCsv('"a"\n"say ""hi"""')[0]['a'], 'say "hi"');
      eq('a trailing blank line is not a row', parseCsv('"a"\n"1"\n\n').length, 1);
      eq('an empty sheet is no rows', parseCsv('').length, 0);
    }

    {
      eq('an ISO date parses', parseDate('2026-08-24')?.getDate(), 24);
      eq('a slashed date parses', parseDate('2026/8/24')?.getDate(), 24);
      eq('an empty value is null', parseDate(''), null);
      eq('prose is null rather than a guess', parseDate('来週あたり'), null);
      // Date would silently roll this into March.
      eq('an impossible date is refused', parseDate('2026-02-31'), null);
      eq('days are counted by calendar day', daysBetween(new Date(2026, 7, 22, 23), new Date(2026, 7, 23, 1)), 1);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Daily focus: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('All focus tests passed.');
}

main().catch((err) => { console.error('\nTest harness crashed:', err); process.exit(1); });
