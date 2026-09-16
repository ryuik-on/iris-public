/**
 * How much of the week unattended work may spend on its own.
 *
 * The first version refused above ninety percent of the week, which conflated
 * two different things. Daytime use is somebody sitting there choosing to
 * spend it; overnight use is nobody watching. A ceiling that adds them
 * together will stop the night's work because of the afternoon's — and, worse,
 * will let a runaway through on a Monday because the week is still mostly
 * empty.
 *
 * So the budget is a delta. When an unattended stretch begins, the current
 * weekly figure is written down; from then on the only question is how much
 * *this stretch* has added. Five points, and it stops. Whatever the day spent
 * before it is not this budget's business.
 *
 * The baseline is on disk. If it lived in memory, a server restart would
 * clear it — and the state where the accounting resets to zero is exactly the
 * state a runaway produces, so losing it would remove the ceiling at the one
 * moment it is being tested.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';

export interface AllowanceReading {
  /** Percent of the seven-day window used, or null when not reported. */
  weekPercent: number | null;
  /** Percent of the five-hour window used, or null when not reported. */
  sessionPercent: number | null;
  /** When the seven-day window resets, in epoch ms. */
  weekResetsAtMs: number | null;
  ageMinutes: number | null;
}

export interface Budget {
  /** Points of the week an unattended stretch may add before it stops. */
  points: number;
  /**
   * A gap this long starts a new stretch.
   *
   * Two hours: long enough that a night reads as one stretch even with pauses
   * between runs, short enough that tonight does not inherit last night's
   * spending.
   */
  newStretchAfterMinutes: number;
  /** Refuse above this share of the five-hour window. */
  sessionCeiling: number;
  /** Older than this and the reading is not used. */
  freshMinutes: number;
}

export const DEFAULT_BUDGET: Budget = {
  points: 5,
  newStretchAfterMinutes: 120,
  sessionCeiling: 95,
  freshMinutes: 30,
};

interface Baseline {
  weekPercent: number;
  startedAt: number;
  lastRunAt: number;
  /** The window this baseline belongs to. A reset invalidates it. */
  weekResetsAtMs: number | null;
}

export type AllowanceVerdict =
  | { allowed: true; spentPoints: number }
  | { allowed: false; code: 'budget' | 'session' | 'stale' | 'unknown'; message: string };

const FILE = (root: string) => join(root, '.iris', 'unattended-budget.json');

export function readBaseline(root: string): Baseline | null {
  try {
    const raw = JSON.parse(readFileSync(FILE(root), 'utf-8'));
    return typeof raw?.weekPercent === 'number' && typeof raw?.lastRunAt === 'number' ? raw : null;
  } catch {
    return null;
  }
}

export function writeBaseline(root: string, baseline: Baseline): void {
  const path = FILE(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(baseline, null, 2));
}

/**
 * Decides, and returns the baseline to store if the caller goes ahead.
 *
 * Split this way so the decision is pure and testable while the writing stays
 * at the call site: a gate that records a run it then refuses would spend the
 * budget on work that never happened.
 */
export function decide(
  reading: AllowanceReading | null,
  existing: Baseline | null,
  now: number,
  budget: Budget = DEFAULT_BUDGET
): { verdict: AllowanceVerdict; baseline: Baseline | null } {
  /**
   * No reading at all is not permission. It means either that the allowance
   * has never been measured, or that this account is billed by the API where
   * the ceiling is money and this is the wrong instrument. Both want a person.
   */
  if (!reading || reading.weekPercent === null) {
    return {
      verdict: { allowed: false, code: 'unknown', message: '使用量が取得できていないため、無人実行を開始しません。' },
      baseline: null,
    };
  }

  if (reading.ageMinutes !== null && reading.ageMinutes > budget.freshMinutes) {
    return {
      verdict: { allowed: false, code: 'stale', message: `使用量が ${reading.ageMinutes}分前の値です。` },
      baseline: null,
    };
  }

  if (reading.sessionPercent !== null && reading.sessionPercent >= budget.sessionCeiling) {
    return {
      verdict: {
        allowed: false,
        code: 'session',
        message: `5時間枠が ${reading.sessionPercent}% です。途中で止まる可能性が高いため見送ります。`,
      },
      baseline: null,
    };
  }

  /**
   * A new stretch starts when there has been a long enough gap, when nothing
   * is recorded, or when the week itself has rolled over — a baseline taken
   * against last week's figure would read as a large saving rather than a
   * fresh start.
   */
  const rolled =
    existing?.weekResetsAtMs != null &&
    reading.weekResetsAtMs != null &&
    existing.weekResetsAtMs !== reading.weekResetsAtMs;
  const stale = existing ? now - existing.lastRunAt > budget.newStretchAfterMinutes * 60_000 : true;

  if (!existing || stale || rolled) {
    return {
      verdict: { allowed: true, spentPoints: 0 },
      baseline: {
        weekPercent: reading.weekPercent,
        startedAt: now,
        lastRunAt: now,
        weekResetsAtMs: reading.weekResetsAtMs,
      },
    };
  }

  /**
   * Clamped at zero. The figure can fall — the week rolls, or a reading
   * arrives out of order — and a negative delta would read as budget earned
   * back rather than as noise.
   */
  const spent = Math.max(0, reading.weekPercent - existing.weekPercent);
  if (spent >= budget.points) {
    return {
      verdict: {
        allowed: false,
        code: 'budget',
        message:
          `無人での作業が、この間だけで週の ${spent}% を使いました（上限 ${budget.points}%）。` +
          `開始時点は ${existing.weekPercent}%、いまは ${reading.weekPercent}% です。`,
      },
      baseline: null,
    };
  }

  return {
    verdict: { allowed: true, spentPoints: spent },
    baseline: { ...existing, lastRunAt: now },
  };
}
