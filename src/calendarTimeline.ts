import type { ScheduleEvent } from './api';

export const NEXT_DAY_TIMELINE_MINUTES = 2 * 60;

export interface TimelineEvent extends ScheduleEvent {
  /** 0 is today; 1 is the following local calendar day. */
  dayOffset: number;
}

const datePart = (iso: string) => iso.slice(0, 10);
const clockMinutes = (iso: string) => Number(iso.slice(11, 13)) * 60 + Number(iso.slice(14, 16));

function dayDistance(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00`);
  const b = Date.parse(`${to}T00:00:00`);
  return Math.round((b - a) / 86_400_000);
}

/** Events shown by the today band, including the first two hours of tomorrow. */
export function eventsForTodayTimeline(events: ScheduleEvent[], today: string): TimelineEvent[] {
  const tomorrow = new Date(`${today}T00:00:00`);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowKey = tomorrow.toLocaleDateString('sv-SE');

  return events
    .flatMap((event) => {
      if (event.allDay || event.start.length < 16) return [];
      const startDay = datePart(event.start);
      if (startDay === today) return [{ ...event, dayOffset: 0 }];
      if (startDay === tomorrowKey && clockMinutes(event.start) < NEXT_DAY_TIMELINE_MINUTES) {
        return [{ ...event, dayOffset: 1 }];
      }
      return [];
    })
    .sort((a, b) => a.start.localeCompare(b.start));
}

/** Minutes on a 00:00 today → 02:00 tomorrow clock, represented as 0…1560. */
export function timelineMinutes(iso: string, today: string): number {
  return dayDistance(today, datePart(iso)) * 1440 + clockMinutes(iso);
}

/** The today-only list still needs a heading when only tomorrow's early events exist. */
export function todayListDays(days: string[], today: string, hasNextDayEarlyEvents: boolean): string[] {
  const shown = days.filter((day) => day === today);
  return shown.length > 0 || !hasNextDayEarlyEvents ? shown : [today];
}
