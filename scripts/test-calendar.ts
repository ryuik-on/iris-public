/**
 * Calendar cache tests.
 *
 * The interesting property is not reading a file — it is refusing to let a
 * stale one pass as current. This exact cache sat seven days out of date
 * while the dashboard rendered from it every morning, and nothing about the
 * output looked wrong. A calendar that is quietly a week old is worse than no
 * calendar.
 *
 * Run: npm run test:calendar
 */
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  readCalendarCache, CACHE_STALE_AFTER_MS, CalendarUnavailableError, upcomingEvents,
} from '../server/services/calendar.js';

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

const NOW = Date.parse('2026-08-19T12:00:00.000Z');

function writeCache(dir: string, body: any, name = 'calendar.json'): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(body));
  return path;
}

function main() {
  const dir = mkdtempSync(join(tmpdir(), 'iris-cal-'));

  try {
    // ---------------------------------------------------------------------
    section('Reading what the dashboard already gathered');

    {
      const path = writeCache(dir, {
        ok: true,
        days: 14,
        synced_at: '2026-08-19T11:50:00',
        events: [
          { calendar: '自宅', summary: 'ギター会', date: '2026-08-19', time: '13:00', allday: false },
          { calendar: '職場', summary: '面談', date: '2026-08-21', time: '20:00', allday: false },
          { calendar: 'x@example.com', summary: '休講', date: '2026-08-22', allday: true },
        ],
      });
      const reading = readCalendarCache(path, NOW);

      eq('every event is read', reading.events.length, 3);
      eq('the title comes from summary', reading.events[0].title, 'ギター会');
      // Kept as written rather than converted: inventing a timezone would be
      // inventing precision the file does not have.
      eq('date and time are joined without inventing a zone', reading.events[0].start, '2026-08-19T13:00');
      eq('an all-day event has no time appended', reading.events[2].start, '2026-08-22');
      check('and is marked as all-day', reading.events[2].allDay);
      eq('the source is named', reading.source, 'cache');
      eq('calendars are listed', reading.calendarNames, ['x@example.com', '職場', '自宅']);
    }

    // ---------------------------------------------------------------------
    section('Freshness is reported as loudly as the contents');

    {
      const fresh = writeCache(dir, {
        synced_at: '2026-08-19T11:50:00',
        events: [{ calendar: 'a', summary: 'x', date: '2026-08-19' }],
      }, 'fresh.json');
      const reading = readCalendarCache(fresh, Date.parse('2026-08-19T11:55:00'));
      check('a recent cache is not stale', !reading.stale);
      check('and its age is small', reading.ageMs < 10 * 60_000, `${reading.ageMs}`);
      eq('the writer\'s own timestamp is preferred', reading.syncedAt, '2026-08-19T11:50:00');
    }

    {
      // The real failure this guards against: seven days old, rendered every
      // morning, nothing about it looking wrong.
      const old = writeCache(dir, {
        synced_at: '2026-08-12T07:00:00',
        events: [{ calendar: 'a', summary: '古い予定', date: '2026-08-12' }],
      }, 'old.json');
      const reading = readCalendarCache(old, Date.parse('2026-08-19T12:00:00'));
      check('a week-old cache is marked stale', reading.stale);
      check('with the age reported', reading.ageMs > 6 * 24 * 3600_000);
      // Still returned, not withheld — the caller decides what a stale answer
      // is worth, but cannot fail to notice that it is one.
      eq('the events are still returned', reading.events.length, 1);
    }

    {
      const boundary = writeCache(dir, {
        synced_at: new Date(NOW - CACHE_STALE_AFTER_MS - 1000).toISOString(),
        events: [],
      }, 'boundary.json');
      check('just past the threshold is stale', readCalendarCache(boundary, NOW).stale);

      const inside = writeCache(dir, {
        synced_at: new Date(NOW - CACHE_STALE_AFTER_MS + 60_000).toISOString(),
        events: [],
      }, 'inside.json');
      check('just inside it is not', !readCalendarCache(inside, NOW).stale);
    }

    {
      // No synced_at: fall back to the file's mtime, which is a weaker claim
      // but better than pretending not to know.
      const path = writeCache(dir, { events: [{ calendar: 'a', summary: 'x', date: '2026-08-19' }] }, 'nots.json');
      const old = (NOW - 3 * 86_400_000) / 1000;
      utimesSync(path, old, old);
      const reading = readCalendarCache(path, NOW);
      eq('no timestamp in the file is reported as such', reading.syncedAt, null);
      check('but the age still comes from somewhere', reading.stale);
    }

    // ---------------------------------------------------------------------
    section('A missing cache says how to make one');

    {
      let err: any;
      try { readCalendarCache(join(dir, 'nope.json'), NOW); } catch (e) { err = e; }
      check('a missing file is refused clearly', err instanceof CalendarUnavailableError);
      eq('with a code the caller can branch on', err.code, 'cache_missing');
      // The cause found in practice: the sync fails silently when Calendar.app
      // is not running, which is not a permission problem and does not look
      // like one.
      check('and names the actual prerequisite', /Calendar\.app/.test(err.hint ?? ''));
    }

    {
      writeFileSync(join(dir, 'broken.json'), '{ not json');
      let threw = false;
      try { readCalendarCache(join(dir, 'broken.json'), NOW); } catch { threw = true; }
      check('a corrupt cache throws rather than reporting an empty calendar', threw);
    }

    {
      const empty = writeCache(dir, { synced_at: '2026-08-19T11:59:00', events: [] }, 'empty.json');
      const reading = readCalendarCache(empty, NOW);
      eq('an empty calendar is a valid answer', reading.events.length, 0);
      check('and is not mistaken for staleness', !reading.stale);
      // Zero events and zero visible calendars look the same and mean
      // different things; the count is reported either way.
      eq('with no calendars claimed', reading.calendarsVisible, 0);
    }

    {
      const legacy = writeCache(dir, [
        { calendar: 'a', summary: '旧形式', date: '2026-08-19', time: '09:00' },
      ], 'legacy.json');
      const reading = readCalendarCache(legacy, NOW);
      eq('a bare array is still read', reading.events.length, 1);
      eq('with its title', reading.events[0].title, '旧形式');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }


  // -----------------------------------------------------------------------
  section('A failed sync is not an empty calendar');

  {
    // The writer replaces this file whether or not the fetch succeeded, and
    // stamps the failure with the moment it gave up. Read as a bag of events
    // that happens to be empty, it is the worst reading available: nothing
    // scheduled, and correctly claiming to be seconds old. Every staleness
    // check passes, because the data is gone rather than old.
    const dir = mkdtempSync(join(tmpdir(), 'iris-cal-fail-'));
    const path = writeCache(dir, {
      ok: false,
      error: 'Calendar got an error: Application isn’t running. (-600)',
      synced_at: new Date(NOW).toISOString(),
      days: 14,
    });

    let raised: CalendarUnavailableError | null = null;
    try { readCalendarCache(path, NOW); } catch (err) { raised = err as CalendarUnavailableError; }

    check('a recorded failure is raised, not read as zero events', raised !== null);
    eq('and has its own code', raised?.code, 'cache_failed');
    check('the writer\'s reason is carried through', /-600/.test(raised?.message ?? ''));
    check('and the hint says what to do', /calendar_sync/.test(raised?.hint ?? ''));

    // The distinction that matters: this must not be confused with a fortnight
    // that genuinely has nothing in it.
    const empty = writeCache(dir, { ok: true, events: [], days: 14, synced_at: new Date(NOW).toISOString() }, 'empty.json');
    const reading = readCalendarCache(empty, NOW);
    eq('a genuinely empty fortnight still reads', reading.events.length, 0);
    check('and is not stale', !reading.stale);

    rmSync(dir, { recursive: true, force: true });
  }


  // -----------------------------------------------------------------------
  section('An appointment that has happened is not the next one');

  {
    // Google is asked for a window beginning now, so it never returns the
    // past. The local cache holds whatever was in its window when it was
    // written, including this morning. Merging the two brought past events
    // back, and the daily focus announced a 13:00 appointment as "next" at
    // nearly five in the afternoon.
    const now = new Date('2026-08-19T16:48:00').getTime();
    const ev = (title: string, start: string | null, allDay = false) =>
      ({ title, start, end: null, allDay, calendar: 'test' });

    const events = [
      ev('ギター会', '2026-08-19T13:00'),
      ev('夕方の打ち合わせ', '2026-08-19T18:00'),
      ev('けやき台 面談', '2026-08-21T20:00'),
      ev('祝日', '2026-08-22', true),
      ev('無日付', null),
    ];

    const upcoming = upcomingEvents(events, now);
    const titles = upcoming.map((e) => e.title);
    check('an event earlier today is dropped', !titles.includes('ギター会'));
    check('but one later today is kept', titles.includes('夕方の打ち合わせ'));
    eq('and the soonest remaining one leads', titles[0], '夕方の打ち合わせ');
    check('an event without a start cannot be next', !titles.includes('無日付'));
    eq('later days follow in order', titles, ['夕方の打ち合わせ', 'けやき台 面談', '祝日']);
  }

  {
    const ev = (title: string, start: string, allDay = false) =>
      ({ title, start, end: null, allDay, calendar: 'test' });
    // A date carries no time. Dropping it at 00:01 would hide something that
    // is happening today, so an all-day event runs to the end of its day.
    const lateToday = new Date('2026-08-19T23:30:00').getTime();
    const allDay = upcomingEvents([ev('祝日', '2026-08-19', true)], lateToday);
    eq('an all-day event survives its own day', allDay.length, 1);

    const tomorrow = new Date('2026-08-20T00:30:00').getTime();
    eq('and is gone the next day', upcomingEvents([ev('祝日', '2026-08-19', true)], tomorrow).length, 0);

    // The cache writes local wall-clock with no offset, deliberately.
    const noon = new Date('2026-08-19T12:00:00').getTime();
    eq('a local timestamp is compared as local', upcomingEvents([ev('午後', '2026-08-19T13:00')], noon).length, 1);
    eq('and an offset one is respected', upcomingEvents([ev('午後', '2026-08-19T13:00:00+09:00')], noon).length, 1);
  }


  // -----------------------------------------------------------------------
  section('Old because nothing ran, or old because everything failed');

  {
    // Age alone cannot tell these apart, and only one of them means waiting
    // will not help. The sync script now keeps the previous events and files
    // the failure alongside them rather than replacing them with it.
    const dir = mkdtempSync(join(tmpdir(), 'iris-cal-kept-'));
    const path = writeCache(dir, {
      ok: true,
      synced_at: new Date(NOW - 3 * 60 * 60_000).toISOString(),
      days: 14,
      events: [{ summary: 'ギター会', date: '2026-08-19', time: '13:00', calendar: '自宅' }],
      last_error: 'Calendar got an error: Application isn’t running. (-600)',
      last_attempt_at: new Date(NOW).toISOString(),
    });

    const reading = readCalendarCache(path, NOW);
    eq('the kept events are read', reading.events.length, 1);
    check('the reading is not treated as a failure', reading.source === 'cache');
    check('the failure is surfaced', /-600/.test(reading.lastError ?? ''));
    check('with when it was attempted', Boolean(reading.lastAttemptAt));
    // The age is still the age of the data, not of the attempt — that is the
    // whole reason the writer leaves synced_at alone on failure.
    eq('age comes from the last success', Math.round(reading.ageMs / 60_000), 180);
    check('and three hours is not yet stale', !reading.stale);

    const healthy = writeCache(dir, {
      ok: true, synced_at: new Date(NOW).toISOString(), days: 14, events: [],
    }, 'healthy.json');
    check('a healthy cache claims no failure', readCalendarCache(healthy, NOW).lastError === undefined);

    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Calendar cache: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('All calendar tests passed.');
}

main();
