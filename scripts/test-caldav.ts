/**
 * CalDAV / iCalendar parsing tests.
 *
 * Two things are being defended here.
 *
 * The first is that a calendar containing events must never be read as a
 * calendar containing none. That failure has now happened twice on this
 * codebase from different causes — a sync script writing its error over the
 * events, and this client's own component filter looking for `name="VEVENT"`
 * when iCloud writes `name='VEVENT'` — and both times the symptom was a
 * confident, wrong "nothing scheduled".
 *
 * The second is that times have to agree with the other sources. Merging is
 * done on the title and the first sixteen characters of the start, so a
 * timestamp rendered in the wrong zone does not produce a visible error; it
 * produces a duplicate, quietly, for one event.
 *
 * Run: npm run test:caldav
 */
import { parseVEvents } from '../server/services/caldav_calendar.js';

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

/** An iCalendar document, with the CRLF line endings the format actually uses. */
function ics(...lines: string[]): string {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', ...lines, 'END:VCALENDAR'].join('\r\n');
}

function main() {
  // -----------------------------------------------------------------------
  section('An event is read as an event');

  {
    const events = parseVEvents(
      ics(
        'BEGIN:VEVENT',
        'SUMMARY:けやき台 面談',
        'DTSTART;TZID=Asia/Tokyo:20260821T110000',
        'DTEND;TZID=Asia/Tokyo:20260821T120000',
        'LOCATION:本社 3F',
        'END:VEVENT'
      ),
      '職場'
    );

    eq('one event is found', events.length, 1);
    eq('with its title', events[0].title, 'けやき台 面談');
    eq('and the calendar it came from', events[0].calendar, '職場');
    eq('and its location', events[0].location, '本社 3F');
    check('and it is not all-day', events[0].allDay === false);
    // The machine and the calendar are both in Tokyo, so the wall clock is
    // preserved. The point of the assertion is the first sixteen characters,
    // which is what merging compares.
    check('the wall-clock time survives', (events[0].start ?? '').startsWith('2026-08-21T11:00'));
  }

  {
    // A date has no time, and giving it one would invent precision that has to
    // be argued with in every later comparison.
    const events = parseVEvents(
      ics('BEGIN:VEVENT', 'SUMMARY:夏 ワイン', 'DTSTART;VALUE=DATE:20260830', 'DTEND;VALUE=DATE:20260831', 'END:VEVENT'),
      '自宅'
    );
    eq('an all-day event keeps a bare date', events[0].start, '2026-08-30');
    check('and is marked as all-day', events[0].allDay === true);
  }

  {
    // UTC on the wire, local on the way out — otherwise merging compares a
    // Tokyo morning against a UTC one and files them as different events.
    const events = parseVEvents(
      ics('BEGIN:VEVENT', 'SUMMARY:UTC の予定', 'DTSTART:20260821T010000Z', 'END:VEVENT'),
      'test'
    );
    const start = events[0].start ?? '';
    check('a UTC timestamp is converted, not copied', !start.endsWith('Z'), start);
    check('and carries an offset', /[+-]\d{2}:\d{2}$/.test(start), start);
  }

  // -----------------------------------------------------------------------
  section('The awkward parts of the format');

  {
    // iCalendar wraps at 75 octets and continues with a leading space. A title
    // long enough to wrap arrives in pieces, and reads as a malformed property
    // until it is put back together.
    const long = 'とても長い予定名がここに入っていて折り返される';
    const folded = ics(
      'BEGIN:VEVENT',
      `SUMMARY:${long.slice(0, 10)}`,
      ` ${long.slice(10)}`,
      'DTSTART:20260821T010000Z',
      'END:VEVENT'
    );
    eq('a folded line is rejoined', parseVEvents(folded, 'test')[0].title, long);
  }

  {
    const escaped = parseVEvents(
      ics('BEGIN:VEVENT', 'SUMMARY:打ち合わせ\\, 資料あり\\nもう一行', 'DTSTART:20260821T010000Z', 'END:VEVENT'),
      'test'
    );
    check('escaped commas are unescaped', escaped[0].title.includes('打ち合わせ, 資料あり'));
    check('and escaped newlines become newlines', escaped[0].title.includes('\n'));
  }

  {
    // A cancelled occurrence still arrives in the response; showing it would
    // put a meeting on the schedule that is not happening.
    const events = parseVEvents(
      ics(
        'BEGIN:VEVENT', 'SUMMARY:中止された会議', 'STATUS:CANCELLED', 'DTSTART:20260821T010000Z', 'END:VEVENT',
        'BEGIN:VEVENT', 'SUMMARY:生きている会議', 'DTSTART:20260821T020000Z', 'END:VEVENT'
      ),
      'test'
    );
    eq('a cancelled event is dropped', events.length, 1);
    eq('and the other one is kept', events[0].title, '生きている会議');
  }

  {
    // An expanded recurrence arrives as several VEVENTs sharing a UID. They
    // are separate occurrences and must stay separate — this is the whole
    // reason for asking the server to expand, since the AppleScript path
    // returns only the series master and therefore showed none of them.
    const events = parseVEvents(
      ics(
        'BEGIN:VEVENT', 'UID:abc', 'SUMMARY:そよかぜ書店', 'DTSTART;TZID=Asia/Tokyo:20260820T103000', 'END:VEVENT',
        'BEGIN:VEVENT', 'UID:abc', 'SUMMARY:そよかぜ書店', 'DTSTART;TZID=Asia/Tokyo:20260823T063000', 'END:VEVENT',
        'BEGIN:VEVENT', 'UID:abc', 'SUMMARY:そよかぜ書店', 'DTSTART;TZID=Asia/Tokyo:20260827T103000', 'END:VEVENT'
      ),
      '職場'
    );
    eq('every occurrence is kept', events.length, 3);
    check('at their own times', new Set(events.map((e) => e.start)).size === 3);
  }

  {
    eq('an event without a start is not an event', parseVEvents(
      ics('BEGIN:VEVENT', 'SUMMARY:時刻なし', 'END:VEVENT'), 'test'
    ).length, 0);
    eq('an event without a title still counts', parseVEvents(
      ics('BEGIN:VEVENT', 'DTSTART:20260821T010000Z', 'END:VEVENT'), 'test'
    )[0].title, '(無題)');
    eq('an empty document yields nothing', parseVEvents(ics(), 'test').length, 0);
    eq('and so does rubbish', parseVEvents('not a calendar at all', 'test').length, 0);
  }

  {
    // VTODO and VJOURNAL share the file format. Only events belong here.
    const mixed = ics(
      'BEGIN:VTODO', 'SUMMARY:買い物', 'DTSTART:20260821T010000Z', 'END:VTODO',
      'BEGIN:VEVENT', 'SUMMARY:会議', 'DTSTART:20260821T020000Z', 'END:VEVENT'
    );
    const events = parseVEvents(mixed, 'test');
    eq('a todo is not read as an event', events.length, 1);
    eq('only the event is returned', events[0].title, '会議');
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`CalDAV: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('All CalDAV tests passed.');
}

main();
