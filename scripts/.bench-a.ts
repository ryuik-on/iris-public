/**
 * The exam countdown.
 *
 * This is the one number on the dashboard that is meant to sit there unchanged
 * for weeks, which is exactly why its edges are worth pinning down. A countdown
 * that is silently absent looks the same as a calendar with no exams in it, and
 * a countdown to a resit nobody expects to sit looks the same as a real one.
 * The three assertions that matter are: nothing to count returns nothing, an
 * exam this morning is still today, and a 再試 months out is not the answer.
 *
 * Every fixture is built from local-time components and `now` is injected, so
 * the results do not depend on the machine's timezone.
 *
 * Run: npx tsx scripts/test-exam.ts
 */
import { CalendarEvent } from '../server/services/calendar.js';
import { nextExam } from '../server/services/exam.js';

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

/**
 * Local noon on 2026-08-22. Noon rather than midnight so that a timezone with
 * a half-hour offset or a DST boundary cannot push "now" onto the wrong day.
 */
const NOW = new Date(2026, 7, 22, 12, 0, 0).getTime();
const now = () => NOW;

/** `yyyy-MM-ddTHH:mm`, which `Date.parse` reads as local time. */
function at(y: number, m: number, d: number, hh = 9, mm = 0): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${y}-${pad(m)}-${pad(d)}T${pad(hh)}:${pad(mm)}`;
}

function event(title: string, start: string | null, extra: Partial<CalendarEvent> = {}): CalendarEvent {
  return { title, start, end: null, allDay: false, calendar: '大学', ...extra };
}

function main() {
  // -----------------------------------------------------------------------
  section('Nothing to count down to');

  {
    eq('an empty calendar', nextExam([], now), null);

    // The common case: a calendar that is full, just not of exams. Returning
    // something here would mean counting down to a meeting.
    eq(
      'a calendar with no exams in it',
      nextExam([
        event('ゼミ', at(2026, 8, 24)),
        event('バイト', at(2026, 8, 25)),
        event('歯医者', at(2026, 9, 1)),
      ], now),
      null
    );

    // Exams that have already happened are not upcoming.
    eq(
      'only past exams',
      nextExam([
        event('生化学試験', at(2026, 8, 21)),
        event('解剖学考査', at(2026, 7, 3)),
      ], now),
      null
    );

    // An all-day entry from the cache can arrive with no date at all, and
    // `Date.parse` of a title-shaped string is NaN. Neither may become a
    // countdown to the epoch.
    eq('an exam with no start', nextExam([event('薬理学試験', null)], now), null);
    eq('an exam with an unparsable start', nextExam([event('薬理学試験', 'まだ未定')], now), null);
  }

  // -----------------------------------------------------------------------
  section('An exam today is still the next exam');

  {
    // Nine in the morning, and it is past noon. The exam has started or is
    // over, and it is still the most relevant thing on the calendar — dropping
    // it the moment it begins is the wrong edge.
    const today = nextExam([event('免疫学試験', at(2026, 8, 22, 9, 0))], now);
    eq('it is found', today?.title, '免疫学試験');
    eq('and it is zero days away', today?.days, 0);
    eq('dated today', today?.date, '2026-08-22');
    eq('with nothing after it', today?.after, 0);

    // Just before midnight tonight is the same day, not tomorrow.
    const tonight = nextExam([event('CBT', at(2026, 8, 22, 23, 30))], now);
    eq('late tonight is also today', tonight?.days, 0);

    // Today beats a later exam even though the later one is listed first.
    const both = nextExam([
      event('総合試験', at(2026, 9, 10)),
      event('免疫学試験', at(2026, 8, 22, 9, 0)),
    ], now);
    eq('today wins over a later exam', both?.title, '免疫学試験');
    eq('and the later one is counted behind it', both?.after, 1);
  }

  // -----------------------------------------------------------------------
  section('Retakes are not counted down to');

  {
    // 再試 sits in the calendar as a placeholder months ahead. It must not be
    // the number on screen, and it must not be the only reason a number
    // appears. Every title here is written 再試験 / 追試験 / 試験(再) so that
    // the exam pattern matches and the retake pattern is what excludes it —
    // a bare 再試 would fail the exam pattern and pass for the wrong reason.
    eq(
      'a resit alone leaves nothing to show',
      nextExam([event('生理学再試験', at(2026, 9, 5))], now),
      null
    );
    eq('追試 too', nextExam([event('薬理学追試験', at(2026, 9, 5))], now), null);
    eq('and the parenthesised forms', nextExam([
      event('病理学試験(再)', at(2026, 9, 5)),
      event('組織学試験（再）', at(2026, 9, 6)),
    ], now), null);

    // With a real exam behind it, the resit is skipped rather than shown first.
    const skipped = nextExam([
      event('生理学再試験', at(2026, 8, 25)),
      event('神経解剖試験', at(2026, 8, 28)),
    ], now);
    eq('a nearer resit does not win', skipped?.title, '神経解剖試験');
    eq('dated as the real exam', skipped?.date, '2026-08-28');
    eq('six days away', skipped?.days, 6);

    // And it is not counted in the tail either, or the screen would promise
    // more exams than there are.
    eq('nor is it counted behind', skipped?.after, 0);
  }

  // -----------------------------------------------------------------------
  section('What counts as an exam');

  {
    for (const title of ['生化学試験', '前期考査', '全国模試', 'CBT', 'OSCE']) {
      const found = nextExam([event(title, at(2026, 8, 30))], now);
      check(`${title} is one`, found?.title === title, `got ${JSON.stringify(found)}`);
    }

    // The pattern is deliberately narrow: better to miss an oddly-named exam
    // than to start counting down to a meeting about one.
    for (const title of ['試作品レビュー', '実習', 'ミーティング']) {
      eq(`${title} is not`, nextExam([event(title, at(2026, 8, 30))], now), null);
    }
  }

  // -----------------------------------------------------------------------
  section('The one that is nearest, and how many follow');

  {
    const found = nextExam([
      event('総合試験', at(2026, 10, 1)),
      event('神経解剖試験', at(2026, 8, 28, 13, 0)),
      event('生理学再試験', at(2026, 8, 24)),
      event('前期考査', at(2026, 9, 15)),
      event('解剖学考査', at(2026, 8, 20)),
      event('ゼミ', at(2026, 8, 23)),
    ], now);
    eq('the earliest upcoming exam wins', found?.title, '神経解剖試験');
    eq('with its own date', found?.date, '2026-08-28');
    eq('and its own distance', found?.days, 6);

    // Two remain: 前期考査 and 総合試験. The resit, the past exam and the
    // seminar are all out.
    eq('the tail counts only the ones that qualify', found?.after, 2);

    // A month out, so the arithmetic crosses a month boundary rather than
    // just incrementing a day.
    const far = nextExam([event('総合試験', at(2026, 10, 1))], now);
    eq('forty days is forty days', far?.days, 40);
    eq('and the date is the exam day', far?.date, '2026-10-01');
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Exam countdown: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('All exam countdown tests passed.');
}

main();
