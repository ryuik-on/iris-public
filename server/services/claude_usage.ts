import { readFileSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Claude Code's usage against its own caps.
 *
 * The percentage cannot be computed here. The transcripts under
 * `~/.claude/projects` carry every token — input, output, both cache
 * counters — so the volume is knowable, but a percentage needs the cap and
 * the cap is not on this machine. `rateLimits` exists as a field in the
 * session records and is null in all 478 places it appears; the figure comes
 * from the server, and `/usage` asks for it.
 *
 * The status line is the one local surface it passes through. Claude Code
 * hands a status-line command a JSON payload on stdin, and that payload
 * carries `rate_limits` — five-hour and seven-day, each with a used
 * percentage and the epoch second it resets. So a small script keeps a copy
 * of the payload and this reads the copy. Same shape as the Codex meter next
 * to it, which works because Codex writes its own limits into every rollout.
 *
 * What that costs: the figure is only as fresh as the last time Claude Code
 * drew a status line. A machine where nobody has opened it today has a
 * yesterday number, which is why the age is reported alongside and never
 * folded away.
 */

export interface Band {
  usedPercent: number;
  resetsAtMs: number | null;
}

export interface ClaudeUsage {
  /** The five-hour window. Null when the payload had no figure for it. */
  session: Band | null;
  /** The seven-day window. */
  week: Band | null;
  model: string | null;
  /** When the status line last handed this over. */
  capturedAtMs: number | null;
  /** How old that is, in minutes. The caller decides what is too old. */
  ageMinutes: number | null;
  /** Why there is nothing, when there is nothing. Never silence. */
  reason: string | null;
}

const EMPTY = (reason: string): ClaudeUsage => ({
  session: null,
  week: null,
  model: null,
  capturedAtMs: null,
  ageMinutes: null,
  reason,
});

function band(raw: any): Band | null {
  const pct = raw?.used_percentage;
  // A percentage of nothing is not zero. Subscriptions that do not carry
  // limits send the field absent, and a bar sitting at 0% would say the
  // week is untouched rather than unmeasured.
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return null;
  const at = raw?.resets_at;
  return {
    usedPercent: Math.max(0, Math.min(100, Math.round(pct))),
    resetsAtMs: typeof at === 'number' && Number.isFinite(at) ? at * 1000 : null,
  };
}

/**
 * Whether a band still describes the window it was read from.
 *
 * The status line hands over a snapshot and nothing rewrites it afterwards, so
 * the figure sits in the file until some Claude Code session runs again. That
 * is fine for an hour and wrong after a reset: on 2026-08-25 the payload was
 * from 08-23 23:59, its week had rolled over at 21:00, and IRIS spent two days
 * telling every session that Claude was 100% spent while the real figure was
 * 1%. Nothing looked broken — the number was present, plausible and served
 * without complaint — and with SPENT_PERCENT at 90 it steered every dispatch
 * away from the agent that in fact had a full week.
 *
 * This is the same defect that was fixed on the Codex side on 2026-08-23, and
 * it survived here because the reader computed `ageMinutes`, wrote "the caller
 * decides what is too old" above it, and no caller ever did.
 *
 * Two ways a reading can belong to a window that is over: it was taken before
 * the window began, or the window has since ended. Both are checked against
 * the reset time the payload already carries. Without one there is nothing to
 * compare and the reading stands — unverifiable is not the same as wrong.
 */
export function describesCurrentWindow(
  reading: Band | null,
  capturedAtMs: number | null,
  windowMs: number,
  nowMs: number
): boolean {
  if (!reading || reading.resetsAtMs === null) return true;
  if (nowMs >= reading.resetsAtMs) return false;
  if (capturedAtMs !== null && capturedAtMs < reading.resetsAtMs - windowMs) return false;
  return true;
}

const FIVE_HOURS_MS = 5 * 60 * 60_000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60_000;

export function readClaudeUsage(home: string, now = () => Date.now()): ClaudeUsage {
  const path = join(home, '.claude', 'iris-usage.json');
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return EMPTY(
      'Claude Code のステータス行がまだ一度も動いていません。Claude Code を開くと届きます。'
    );
  }

  let payload: any;
  try {
    payload = JSON.parse(raw);
  } catch {
    return EMPTY('使用量の受け渡しファイルを読めません。');
  }

  let capturedAtMs: number | null = null;
  const stamped = Date.parse(payload?._capturedAt ?? '');
  if (Number.isFinite(stamped)) capturedAtMs = stamped;
  else {
    // Falls back to the file's own time rather than giving up: the age is the
    // part that stops a stale figure from passing as a current one.
    try {
      capturedAtMs = statSync(path).mtimeMs;
    } catch {
      capturedAtMs = null;
    }
  }

  const limits = payload?.rate_limits ?? {};
  const nowMs = now();
  const rawSession = band(limits.five_hour);
  const rawWeek = band(limits.seven_day);

  /**
   * Dropped rather than shown when the window they describe is over. A figure
   * from a spent week reads exactly like a current one, which is why it has to
   * be refused here instead of being left to whoever renders it.
   */
  const sessionFresh = describesCurrentWindow(rawSession, capturedAtMs, FIVE_HOURS_MS, nowMs);
  const weekFresh = describesCurrentWindow(rawWeek, capturedAtMs, SEVEN_DAYS_MS, nowMs);
  const session = sessionFresh ? rawSession : null;
  const week = weekFresh ? rawWeek : null;

  const stale = (rawSession && !sessionFresh) || (rawWeek && !weekFresh);

  return {
    session,
    week,
    model: typeof payload?.model?.display_name === 'string' ? payload.model.display_name : null,
    capturedAtMs,
    ageMinutes: capturedAtMs === null ? null : Math.max(0, Math.round((nowMs - capturedAtMs) / 60_000)),
    reason:
      session || week
        ? null
        : stale
          ? '前の期間の記録しかありません。Claude Code を一度動かすと新しい値が届きます。'
          : 'ステータス行は届いていますが、上限の情報が入っていません（Pro / Max のみ提供されます）。',
  };
}
