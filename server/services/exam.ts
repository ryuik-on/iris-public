import { CalendarEvent } from './calendar.js';

/**
 * The next exam, and how many days away it is.
 *
 * Asked for as something to keep on screen permanently, which is unusual for
 * this band — almost everything here earns its place by changing. This does
 * not change and that is the point: a countdown is only useful while it is
 * still long enough to act on, and the reason to show it every day is that
 * nobody looks up an exam date on the day it stops being far away.
 *
 * Found by matching titles rather than by a separate list, because the dates
 * are already in the calendar and a second place to keep them is a second
 * place to forget to update. The pattern is deliberately narrow: it is better
 * to miss an oddly-named exam than to start counting down to a meeting.
 */

const EXAM = /試験|考査|模試|CBT|OSCE/;

/**
 * Whether a title reads as an exam, by the same test the countdown uses.
 *
 * Exported so nobody writes a second copy of the pattern. A second copy is how
 * one caller decides an entry is an exam and another decides it is not.
 */
export function looksLikeExam(title: string): boolean {
  return EXAM.test(title) && !RETAKE.test(title);
}

/**
 * Retakes are excluded from the count.
 *
 * 再試 and 追試 sit in the calendar as placeholders months ahead, and counting
 * down to a resit nobody expects to sit would put a discouraging and probably
 * irrelevant number on screen every day.
 */
const RETAKE = /再試|追試|\(再\)|（再）/;

export interface NextExam {
  title: string;
  /** Local date, `yyyy-MM-dd`. */
  date: string;
  /** Whole days from today. Zero means it is today. */
  days: number;
  /** How many more are in the window after this one. */
  after: number;
}

export function nextExam(events: CalendarEvent[], now = () => Date.now()): NextExam | null {
  const today = new Date(now());
  const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();

  const upcoming = events
    .filter((e) => e.start && EXAM.test(e.title) && !RETAKE.test(e.title))
    .map((e) => ({ event: e, at: Date.parse(e.start as string) }))
    .filter((e) => Number.isFinite(e.at))
    .map((e) => {
      const day = new Date(e.at);
      return {
        ...e,
        dayStart: new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime(),
      };
    })
    // Today still counts: an exam this morning is the most relevant thing on
    // the calendar, and dropping it the moment it starts is the wrong edge.
    .filter((e) => e.dayStart >= midnight)
    .sort((a, b) => a.at - b.at);

  const first = upcoming[0];
  if (!first) return null;

  const local = new Date(first.dayStart);
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    title: first.event.title,
    date: `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())}`,
    days: Math.round((first.dayStart - midnight) / 86_400_000),
    after: upcoming.length - 1,
  };
}
