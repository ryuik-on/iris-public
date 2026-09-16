/**
 * Which backups to keep, and which to let go.
 *
 * On 2026-08-20 the only copies of this database were two manual snapshots
 * from two days earlier, one of them a twentieth of the current size. Every
 * decision, experience and register correction made since existed in exactly
 * one place.
 *
 * The retention shape is thinned rather than flat, and the reason is about
 * when mistakes are noticed rather than about disk. A corrupt import is found
 * the day it happens if you are lucky, and in June if it was March's. Fourteen
 * daily copies cover the first case and none of the second; three hundred
 * daily copies cover both and cost a hundred times more for the coverage
 * nobody uses. So: dense where errors are usually caught, sparse where they
 * are occasionally caught, and nothing beyond a year.
 *
 * Selection is by calendar bucket, not by counting files. Counting assumes a
 * backup happened every day — and the days it did not are exactly the days
 * something was wrong.
 */

export interface BackupFile {
  name: string;
  /** When the snapshot was taken, from its own name. */
  takenAt: Date;
}

export interface RetentionPolicy {
  /** One per day, for this many days back. */
  dailyDays: number;
  /** One per ISO week, for this many weeks back. */
  weeklyWeeks: number;
  /** One per calendar month, for this many months back. */
  monthlyMonths: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = {
  dailyDays: 14,
  weeklyWeeks: 4,
  monthlyMonths: 12,
};

/** `iris-20260820-035400.db` → the moment it was taken. */
export function parseBackupName(name: string): Date | null {
  const match = /(\d{8})-(\d{6})/.exec(name);
  if (!match) return null;
  const [, date, time] = match;
  const iso =
    `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}` +
    `T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}`;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function backupName(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `iris-${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}` +
    `-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}.db`
  );
}

function dayKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function weekKey(d: Date): string {
  // Monday-based, which matters only for consistency: the same instant must
  // always land in the same bucket.
  const monday = new Date(d);
  const offset = (d.getDay() + 6) % 7;
  monday.setDate(d.getDate() - offset);
  return `w${dayKey(monday)}`;
}

function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Whole calendar days between two moments.
 *
 * Counted in days, not in milliseconds divided by a day. A snapshot taken at
 * 03:00 fourteen days ago is 14.375 days old by the clock and inside a
 * fourteen-day window by the calendar, and the first reading silently drops
 * the oldest daily backup a person expects to be there.
 */
function daysAgo(now: Date, then: Date): number {
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.round((startOfDay(now) - startOfDay(then)) / 86_400_000);
}

/**
 * Splits the files into what to keep and what to delete.
 *
 * A file is kept if it is the newest in any bucket it qualifies for, so one
 * snapshot can satisfy the daily, weekly and monthly rule at once — which is
 * what makes the total small.
 *
 * Anything unparseable is kept. A file this cannot read is a file it does not
 * understand, and deleting what you do not understand is how a backup
 * directory loses the one copy that mattered.
 */
export function selectBackups(
  files: BackupFile[],
  now: Date,
  policy: RetentionPolicy = DEFAULT_RETENTION
): { keep: string[]; remove: string[] } {
  const sorted = [...files].sort((a, b) => b.takenAt.getTime() - a.takenAt.getTime());
  const keep = new Set<string>();

  const claim = (bucketFor: (d: Date) => string, within: (f: BackupFile) => boolean) => {
    const taken = new Set<string>();
    for (const file of sorted) {
      if (!within(file)) continue;
      const bucket = bucketFor(file.takenAt);
      if (taken.has(bucket)) continue;
      taken.add(bucket);
      keep.add(file.name);
    }
  };

  claim(dayKey, (f) => daysAgo(now, f.takenAt) <= policy.dailyDays);
  claim(weekKey, (f) => daysAgo(now, f.takenAt) <= policy.weeklyWeeks * 7);
  claim(monthKey, (f) => daysAgo(now, f.takenAt) <= policy.monthlyMonths * 31);

  // The newest is always kept, whatever the arithmetic says. A policy that can
  // delete the most recent backup has a bug that only shows up at the worst
  // possible moment.
  if (sorted.length > 0) keep.add(sorted[0].name);

  return {
    keep: [...keep],
    remove: sorted.filter((f) => !keep.has(f.name)).map((f) => f.name),
  };
}
