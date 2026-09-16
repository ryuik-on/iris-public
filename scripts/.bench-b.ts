/**
 * Tests for selecting the next exam from calendar events.
 *
 * Run: npx tsx scripts/test-exam.ts
 */
import { CalendarEvent } from '../server/services/calendar.js';
import { nextExam } from '../server/services/exam.js';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function section(name: string) {
  console.log(`\n▸ ${name}`);
}

function eq(name: string, actual: any, expected: any) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    failures.push(`${name}: ${JSON.stringify(actual)} ≠ ${JSON.stringify(expected)}`);
    console.log(`  ✗ ${name}: ${JSON.stringify(actual)} ≠ ${JSON.stringify(expected)}`);
  }
}

const NOW = Date.parse('2026-08-22T09:00:00+09:00');

function event(title: string, start: string): CalendarEvent {
  return {
    title,
    start,
    end: null,
    allDay: false,
    calendar: '試験',
  };
}

function main() {
  section('No exam is scheduled');

  eq('an empty calendar returns null', nextExam([], () => NOW), null);

  section('Today is still the next exam');

  {
    const result = nextExam(
      [event('薬理学 中間試験', '2026-08-22T08:00:00+09:00')],
      () => NOW
    );
    eq('the exam is selected', result?.title, '薬理学 中間試験');
    eq('its local date is today', result?.date, '2026-08-22');
    eq('today is zero days away', result?.days, 0);
  }

  section('Retakes and make-up exams are excluded');

  {
    const result = nextExam(
      [
        event('薬理学 中間試験（再試）', '2026-08-23T09:00:00+09:00'),
        event('薬理学 中間試験 追試', '2026-08-24T09:00:00+09:00'),
        event('薬理学 中間試験', '2026-08-25T09:00:00+09:00'),
      ],
      () => NOW
    );
    eq('the ordinary exam remains', result?.title, '薬理学 中間試験');
    eq('retakes do not count as exams after it', result?.after, 0);
    eq('the ordinary exam is three days away', result?.days, 3);
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Exam selection: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const failure of failures) console.log(`  - ${failure}`);
    process.exit(1);
  }
  console.log('All exam selection tests passed.');
}

main();
