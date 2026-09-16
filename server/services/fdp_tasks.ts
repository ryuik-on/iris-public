/**
 * The whole task ledger, not just today's one.
 *
 * `daily_focus` already reads the same tab, but it answers a different
 * question: "what is the one thing to do now". That is the right answer on a
 * busy morning and the wrong one when the question is "which of these has
 * stopped moving" — which is what the ledger is actually asked, and what
 * nothing currently shows.
 *
 * Three rules, each from a failure this machine has already had:
 *
 *   A sheet that could not be read is not an empty sheet. `ok: false` and
 *   `tasks: []` must never be confused; the panel says "読めませんでした" and
 *   the reason, because "0件" reads as "nothing to do".
 *
 *   `自動判定` is the sheet's own column, computed by an ARRAYFORMULA there.
 *   It is carried through untouched. Re-deriving it here would give two
 *   answers to one question and no way to tell which is current.
 *
 *   A blank `自動判定` is its own state, not "順調". The formula has not
 *   reached that row yet, or the row is malformed. Saying "順調" for it would
 *   be inventing a value the ledger does not hold.
 */
import { FdpSheets } from './fdp_sheets.js';
import { parseDate, daysBetween } from '../core/daily_focus.js';
import { settingsFromRows, DEFAULT_SETTINGS, verdictFor, type VerdictSettings } from '../core/fdp_verdict.js';
import type { Hold } from './fdp_holds_sqlite.js';
import { asSheetRow, type FdpLedgerStore } from './fdp_ledger_sqlite.js';

export interface FdpTask {
  id: string;
  title: string;
  field: string | null;
  priority: string | null;
  /** 未着手 / 進行中 / 完了 — what the person set. */
  status: string | null;
  /**
   * The verdict, computed here rather than read off the sheet.
   *
   * `fdp_verdict.ts` reproduces the sheet's ARRAYFORMULA and `npm run
   * fdp:check` confirms they agree on every live row. Computing it here is
   * what lets 保留 exist at all: the sheet has no idea a task can be parked,
   * so a verdict read from it could never say so.
   */
  verdict: string | null;
  /** What the sheet's own 自動判定 said, for comparison. Null when blank. */
  sheetVerdict: string | null;
  /** YYYY-MM-DD this task is parked until, or null. */
  heldUntil: string | null;
  /** Days until the hold runs out. Negative once it has. */
  heldUntilInDays: number | null;
  holdReason: string | null;
  /** Who parked it — a person or a session. */
  holdSetBy: string | null;
  due: string | null;
  /** Negative when overdue. Null when there is no readable 期限. */
  dueInDays: number | null;
  start: string | null;
  /** Positive while the start date is still ahead. Null when unreadable. */
  startsInDays: number | null;
  lastUpdated: string | null;
  /**
   * Days since 最終更新日 — the number the verdict 更新停止 is made of.
   *
   * Carried so the panel can say "29日 動いていません" instead of the column
   * name. A reader who is told the number does not need the threshold
   * explained to them; a reader told "更新停止" has to be taught it.
   */
  stillDays: number | null;
  /** 0–1. Null when the cell is blank — not 0. */
  progress: number | null;
  nextAction: string | null;
  /** 完了条件／成果物。作業場所を探すのに要る —— 成果物の道はここに書かれる。 */
  doneCriteria: string | null;
}

export type FdpTasksReading =
  | {
      ok: true;
      tasks: FdpTask[];
      doneCount: number;
      /**
       * The ledger's own thresholds, carried to whoever draws this.
       *
       * So a panel can write "7日以上 動いていません" without holding a copy
       * of the number. The sheet's 設定 tab can change it; a hardcoded 7 in
       * two front-ends could not follow.
       */
      settings: VerdictSettings;
      /** 'iris' once the ledger has been imported; 'sheet' until then. */
      source: 'iris' | 'sheet';
      /** Writes that have not reached the spreadsheet. Its readers are stale by these. */
      unmirroredWrites: number;
      readAt: string;
    }
  | { ok: false; error: string; readAt: string };

function text(row: Record<string, string>, column: string): string | null {
  const value = (row[column] ?? '').trim();
  return value === '' ? null : value;
}

/**
 * Rows to the shape the panel needs.
 *
 * Completed tasks leave the list and become a count. Four finished rows above
 * the two that have stalled is how the stalled ones stop being read.
 */
export function summariseTasks(
  rows: Record<string, string>[],
  today: Date,
  settings: VerdictSettings = DEFAULT_SETTINGS,
  holds: Map<string, Hold> = new Map()
): { tasks: FdpTask[]; doneCount: number } {
  const open: FdpTask[] = [];
  let doneCount = 0;

  for (const row of rows) {
    const id = (row['ID'] ?? '').trim();
    if (!id) continue;
    if ((row['状態'] ?? '').trim() === '完了') {
      doneCount++;
      continue;
    }

    const due = parseDate(row['期限']);
    const start = parseDate(row['開始予定日']);
    const touched = parseDate(row['最終更新日']);
    const rawProgress = (row['進捗率'] ?? '').trim();
    const progress = rawProgress === '' ? null : Number(rawProgress);
    const hold = holds.get(id) ?? null;
    const heldUntil = hold ? parseDate(hold.heldUntil) : null;

    open.push({
      id,
      title: text(row, '課題名') ?? '(課題名なし)',
      field: text(row, '分野'),
      priority: text(row, '優先度'),
      status: text(row, '状態'),
      verdict: verdictFor(row, today, settings, hold?.heldUntil ?? null),
      sheetVerdict: text(row, '自動判定'),
      heldUntil: hold?.heldUntil ?? null,
      heldUntilInDays: heldUntil ? daysBetween(today, heldUntil) : null,
      holdReason: hold?.reason ?? null,
      holdSetBy: hold?.setBy ?? null,
      due: text(row, '期限'),
      dueInDays: due ? daysBetween(today, due) : null,
      start: text(row, '開始予定日'),
      startsInDays: start ? daysBetween(today, start) : null,
      lastUpdated: text(row, '最終更新日'),
      stillDays: touched ? daysBetween(touched, today) : null,
      progress: progress !== null && Number.isFinite(progress) ? progress : null,
      nextAction: text(row, '次の行動'),
      doneCriteria: text(row, '完了条件／成果物'),
    });
  }

  // What needs a hand first, then soonest deadline.
  //
  // Sorted here rather than in each front-end so the web panel and the native
  // board cannot end up disagreeing about which task is the urgent one. A row
  // with no readable 期限 sorts last within its group — an unset deadline is
  // not an urgent one — and 保留 sorts below everything, because a task parked
  // on purpose is the one thing on the list that has already been dealt with.
  const rank: Record<string, number> = { 遅延: 0, 更新停止: 1, 順調: 2, 保留: 3 };
  open.sort(
    (a, b) =>
      (rank[a.verdict ?? ''] ?? 2) - (rank[b.verdict ?? ''] ?? 2) ||
      (a.dueInDays ?? Infinity) - (b.dueInDays ?? Infinity)
  );
  return { tasks: open, doneCount };
}

export class FdpTasksService {
  constructor(
    private sheets: FdpSheets,
    /** Held tasks, from IRIS. Absent in tests that only care about the sheet. */
    private holds: { active(): Map<string, Hold> } = { active: () => new Map() },
    /** The ledger once it has been imported. Until then the sheet is read directly. */
    private ledger?: FdpLedgerStore
  ) {}

  /**
   * `today` fixes both the day arithmetic and `readAt`, and it is fixed here,
   * on the server.
   *
   * Every caller of one read gets the same `dueInDays`. Letting a client
   * subtract dates itself would put the web panel and the native board a day
   * apart for whichever of them rendered after midnight.
   */
  async read(today: Date = new Date()): Promise<FdpTasksReading> {
    const readAt = today.toISOString();
    // Thresholds still come from the sheet's 設定 tab. They are configuration
    // the person edits, not ledger rows that sessions write, so there is no
    // reason for them to move. Unreadable falls back rather than failing the
    // whole read.
    const config = await this.sheets.fetchTab('設定', '設定項目');
    const settings = config.ok ? settingsFromRows(config.rows) : DEFAULT_SETTINGS;

    // Once imported, the ledger answers from here and the network is not
    // touched for it at all — which is the point of the move.
    if (this.ledger && this.ledger.count() > 0) {
      const rows = this.ledger.all().map(asSheetRow);
      return {
        ok: true,
        ...summariseTasks(rows, today, settings, this.holds.active()),
        settings,
        source: 'iris',
        unmirroredWrites: this.ledger.unmirrored().length,
        readAt,
      };
    }

    const result = await this.sheets.fetchTab('課題台帳', '課題名');
    if (!result.ok) {
      return { ok: false, error: result.error ?? '課題台帳を読めませんでした。', readAt };
    }
    return {
      ok: true,
      ...summariseTasks(result.rows, today, settings, this.holds.active()),
      settings,
      source: 'sheet',
      unmirroredWrites: 0,
      readAt,
    };
  }
}
