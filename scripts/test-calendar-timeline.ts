import { eventsForTodayTimeline, timelineMinutes, todayListDays } from '../src/calendarTimeline.js';
import type { ScheduleEvent } from '../src/api.js';

const event = (start: string, end: string | null, title = start): ScheduleEvent => ({
  title, start, end, allDay: false,
});
const today = '2026-09-11';
const events = [
  event('2026-09-11T23:30:00+09:00', '2026-09-12T01:00:00+09:00', '跨ぐ練習'),
  event('2026-09-12T00:00:00+09:00', '2026-09-12T00:30:00+09:00', '午前0時'),
  event('2026-09-12T02:00:00+09:00', '2026-09-12T02:30:00+09:00', '境界外'),
  event('2026-09-12T01:59:00+09:00', '2026-09-12T02:00:00+09:00', '2時直前'),
];
const shown = eventsForTodayTimeline(events, today);
const check = (name: string, ok: boolean) => {
  if (!ok) throw new Error(`failed: ${name}`);
  console.log(`✓ ${name}`);
};

check('today and next-day early events are included', shown.length === 3);
check('next-day events are marked separately', shown.filter((e) => e.dayOffset === 1).length === 2);
check('midnight is 24:00 on the extended clock', timelineMinutes('2026-09-12T00:00:00+09:00', today) === 1440);
check('02:00 is the exclusive cutoff', !shown.some((e) => e.title === '境界外'));
check('a crossing event ends after it starts', timelineMinutes(events[0].end!, today) > timelineMinutes(events[0].start, today));
check('today heading remains for next-day-only early events', JSON.stringify(todayListDays(['2026-09-12'], today, true)) === JSON.stringify([today]));
console.log('Calendar timeline: all tests passed.');
