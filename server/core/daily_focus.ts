import { readFileSync, existsSync } from 'fs';
import { FdpSheets, SheetRow } from '../services/fdp_sheets.js';

/**
 * One thing per area, not everything known.
 *
 * Ported from the Founder Development Program dashboard, whose stated design
 * rule is the whole point: surface what to do now rather than everything
 * there is. A list of forty items and a list of five are different products,
 * and only one of them gets read on a busy morning.
 *
 * Almost every selection rule below exists because of a specific failure,
 * recorded in the original as a comment. They are carried over as rules
 * rather than re-derived, because re-deriving them means re-earning them.
 *
 * Read-only throughout. The spreadsheet and the OS repository are canon; this
 * reads them and writes nothing back.
 */

export type FocusArea = 'exam' | 'study' | 'improvement' | 'os' | 'work' | 'contest';

export interface FocusItem {
  area: FocusArea;
  label: string;
  /**
   * The row's own identifier where the source has one (T005, TSK-010, W003).
   *
   * Carried so this can be cross-checked against the dashboard it was ported
   * from: the same rules now exist in two implementations, and comparing
   * prose would compare presentation rather than the decision.
   */
  id?: string;
  /** The one thing. Null when there is genuinely nothing for this area. */
  title: string | null;
  detail?: string;
  due?: string;
  /**
   * Why this one and not another. The selection rules are not obvious and a
   * surfaced item that cannot explain itself invites second-guessing the
   * whole board.
   */
  because?: string;
  /**
   * False when the source could not be read. Distinct from having nothing to
   * show: "no exams" and "could not open the exam sheet" are opposite
   * situations that look identical in a list.
   */
  available: boolean;
  error?: string;
  /**
   * A deadline that forecloses something if missed, rather than merely
   * delaying it. Read from the sheet's own conventions, not invented here.
   */
  irreversible?: boolean;
  /** Something else already occupies that slot, per the sheet's own note. */
  conflict?: string;
}

export interface DailyFocus {
  date: string;
  items: FocusItem[];
  /** True when an exam is close enough that study is advice, not a plan. */
  examMode: boolean;
  daysToExam: number | null;
  /** Areas whose source failed. Named, so silence is never mistaken for calm. */
  unavailable: FocusArea[];
}

const WEEKDAYS = '日月火水木金土';

/**
 * How close an exam has to be before study becomes advisory rather than a plan.
 *
 * Advisory is exactly right: in the original this changes what is *said*, not
 * what is *selected*. The study task is still chosen by the same rules and
 * still shown — it just stops being presented as something to pile on. A
 * first pass here declared this constant and never used it, which is worse
 * than omitting it: it implies a filter that does not exist.
 */
export const EXAM_FOCUS_DAYS = 14;

export interface DailyFocusOptions {
  sheets: FdpSheets;
  /** Active_Projects.md from the OS repository. Read directly, never written. */
  osActiveProjectsPath: string;
  now?: () => Date;
}

export class DailyFocusService {
  constructor(private options: DailyFocusOptions) {}

  private today(): Date {
    return this.options.now ? this.options.now() : new Date();
  }

  async build(): Promise<DailyFocus> {
    const today = this.today();
    const items = await Promise.all([
      this.exam(today),
      this.study(today),
      this.improvement(),
      this.os(),
      this.work(today),
      this.contest(today),
    ]);

    // Exam proximity colours the study item rather than removing it, which is
    // what the original does. Applied after selection so the rules that pick
    // the task stay independent of how it is framed.
    const exam = items.find((i) => i.area === 'exam');
    const study = items.find((i) => i.area === 'study');
    const daysToExam = exam?.due ? daysBetween(today, new Date(`${exam.due}T00:00:00`)) : null;
    const examMode = daysToExam !== null && daysToExam <= EXAM_FOCUS_DAYS;
    if (examMode && study?.title) {
      study.because = `${study.because ?? ''}（試験まで${daysToExam}日。学習系は無理に積まない）`.trim();
    }

    return {
      date: isoDate(today),
      items,
      examMode,
      daysToExam,
      unavailable: items.filter((i) => !i.available).map((i) => i.area),
    };
  }

  /** The next exam, and how close it is. */
  private async exam(today: Date): Promise<FocusItem> {
    const result = await this.options.sheets.fetchTab('試験日程', '科目');
    if (!result.ok) {
      return { area: 'exam', label: '医学部の試験', title: null, available: false, error: result.error };
    }

    const upcoming = result.rows
      .map((r) => ({ row: r, date: parseDate(r['日付']) }))
      .filter((e): e is { row: SheetRow; date: Date } => e.date !== null && daysBetween(today, e.date) >= 0)
      .sort((a, b) => a.date.getTime() - b.date.getTime());

    if (upcoming.length === 0) {
      return { area: 'exam', label: '医学部の試験', title: null, available: true };
    }

    const next = upcoming[0];
    const days = daysBetween(today, next.date);
    return {
      area: 'exam',
      label: '医学部の試験',
      title: next.row['科目'] || '(科目未記入)',
      detail: next.row['区分'] || undefined,
      due: isoDate(next.date),
      because: days === 0 ? '今日です' : `あと${days}日`,
      available: true,
    };
  }

  /**
   * The study task for today.
   *
   * Two rules, both from failures the original records:
   *
   *   A task pinned to a weekday goes first on that weekday. Sorting purely by
   *   deadline buried the weekly English-paper task in fourth place on the
   *   very Saturday it was for, because its deadline was the furthest away.
   *
   *   The "not started yet" filter checks the status as well as the date. A
   *   task already underway but whose planned start is still in the future was
   *   being dropped entirely.
   */
  private async study(today: Date): Promise<FocusItem> {
    const result = await this.options.sheets.fetchTab('課題台帳', '課題名');
    if (!result.ok) {
      return { area: 'study', label: '学習 (FDP)', title: null, available: false, error: result.error };
    }

    const weekdayChar = WEEKDAYS[today.getDay()];
    const candidates = result.rows
      .filter((r) => r['状態'] !== '完了')
      .filter((r) => {
        const start = parseDate(r['開始予定日']);
        return !(start && start > today && r['状態'] === '未着手');
      })
      .map((r) => {
        const kubun = (r['管理区分'] ?? '').trim();
        const pinnedToday = kubun.startsWith('週次:') && kubun.split(':')[1]?.trim() === weekdayChar;
        return { row: r, due: parseDate(r['期限']), pinnedToday, kubun };
      })
      .sort((a, b) => {
        if (a.pinnedToday !== b.pinnedToday) return a.pinnedToday ? -1 : 1;
        return (a.due?.getTime() ?? Infinity) - (b.due?.getTime() ?? Infinity);
      });

    if (candidates.length === 0) {
      return { area: 'study', label: '学習 (FDP)', title: null, available: true };
    }

    const pick = candidates[0];
    return {
      area: 'study',
      label: '学習 (FDP)',
      id: pick.row['ID'] || undefined,
      title: `${pick.row['ID'] ?? ''} ${pick.row['課題名'] ?? ''}`.trim(),
      detail: pick.row['分野'] || undefined,
      due: pick.due ? isoDate(pick.due) : undefined,
      because: pick.pinnedToday ? `${weekdayChar}曜固定の課題です` : '期限が最も近い',
      available: true,
    };
  }

  /**
   * The oldest unaddressed improvement note.
   *
   * Kept on screen deliberately. The original records why: recording feedback
   * was not enough on its own — an item sat in the log until it was raised out
   * loud. Visibility is the mechanism, not the record.
   */
  private async improvement(): Promise<FocusItem> {
    const result = await this.options.sheets.fetchTab('改善ログ', '何が問題か');
    if (!result.ok) {
      return { area: 'improvement', label: '未反映の改善', title: null, available: false, error: result.error };
    }

    const open = result.rows
      .filter((r) => !['検証済', '見送り'].includes((r['状態'] ?? '').trim()))
      // Untouched ones first, so what is being avoided does not sink under
      // what is merely in progress.
      .sort((a, b) => rank(a['状態']) - rank(b['状態']));

    if (open.length === 0) {
      return { area: 'improvement', label: '未反映の改善', title: null, available: true };
    }

    return {
      area: 'improvement',
      label: '未反映の改善',
      title: open[0]['何が問題か'] || '(記述なし)',
      detail: open[0]['状態'] || undefined,
      because: open.length > 1 ? `未反映が${open.length}件あります` : undefined,
      available: true,
    };
  }

  /**
   * The in-progress OS task, read straight from the governance repository.
   *
   * In progress wins; a blocked task is the fallback, because a blocked task
   * is still the current one and hiding it makes the board look emptier than
   * the work is.
   */
  private async os(): Promise<FocusItem> {
    const path = this.options.osActiveProjectsPath;
    if (!existsSync(path)) {
      return {
        area: 'os',
        label: 'MedRecall / OS',
        title: null,
        available: false,
        error: `Active_Projects.md が見つかりません: ${path}`,
      };
    }

    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch (err: any) {
      return { area: 'os', label: 'MedRecall / OS', title: null, available: false, error: err?.message };
    }

    let blocked: FocusItem | null = null;
    for (const line of text.split('\n')) {
      if (!line.startsWith('| TSK-')) continue;
      const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      if (cells.length < 9) continue;
      const [id, , task, , status, , , , notes] = cells;
      if (status === 'In Progress') {
        return { area: 'os', label: 'MedRecall / OS', id, title: `${id} ${task}`, detail: notes.slice(0, 120), because: '進行中', available: true };
      }
      if (status === 'Blocked' && !blocked) {
        blocked = { area: 'os', label: 'MedRecall / OS', id, title: `${id} ${task}`, detail: notes.slice(0, 120), because: 'ブロック中（進行中のTaskなし）', available: true };
      }
    }
    return blocked ?? { area: 'os', label: 'MedRecall / OS', title: null, available: true };
  }

  /**
   * The contest deadline that most needs attention.
   *
   * Not simply the nearest. An entry deadline that forecloses an application
   * outranks a nearer optional one, and is surfaced weeks earlier, because
   * the point of knowing is being able to act — and for a foreclosing
   * deadline that stops being true well before the date arrives.
   */
  private async contest(today: Date): Promise<FocusItem> {
    const result = await this.options.sheets.fetchTab('コンテスト', '名称');
    if (!result.ok) {
      return { area: 'contest', label: 'コンテスト', title: null, available: false, error: result.error };
    }

    const upcoming = result.rows
      .map((r) => {
        const date = parseDate(r['日付']);
        const marks = readContestMarkings(r['備考'] ?? '');
        return { row: r, date, ...marks };
      })
      .filter((e): e is typeof e & { date: Date } => e.date !== null)
      .map((e) => ({ ...e, days: daysBetween(today, e.date) }))
      .filter((e) => e.days >= 0)
      .filter((e) => e.days <= (e.irreversible ? LEAD_DAYS_IRREVERSIBLE : LEAD_DAYS_ORDINARY))
      .sort((a, b) => {
        // Foreclosing first, then by date. A recoverable deadline two days
        // out is a smaller problem than one in five weeks that cannot be
        // re-entered.
        if (a.irreversible !== b.irreversible) return a.irreversible ? -1 : 1;
        return a.days - b.days;
      });

    if (upcoming.length === 0) {
      return { area: 'contest', label: 'コンテスト', title: null, available: true };
    }

    const pick = upcoming[0];
    return {
      area: 'contest',
      label: 'コンテスト',
      id: pick.row['ID'] || undefined,
      title: pick.row['名称'] || '(名称未記入)',
      detail: pick.row['備考']?.slice(0, 120) || undefined,
      due: isoDate(pick.date),
      because: pick.irreversible
        ? `あと${pick.days}日・逃すと取り返しがつきません（${pick.matched}）`
        : `あと${pick.days}日`,
      irreversible: pick.irreversible,
      conflict: pick.conflict,
      available: true,
    };
  }

  /** The nearest work commitment. */
  private async work(today: Date): Promise<FocusItem> {
    const result = await this.options.sheets.fetchTab('仕事', '内容');
    if (!result.ok) {
      return { area: 'work', label: '仕事', title: null, available: false, error: result.error };
    }

    const open = result.rows
      .filter((r) => !['完了', '終了'].includes((r['状態'] ?? '').trim()))
      .map((r) => ({ row: r, due: parseDate(r['期限']) }))
      .sort((a, b) => (a.due?.getTime() ?? Infinity) - (b.due?.getTime() ?? Infinity));

    if (open.length === 0) {
      return { area: 'work', label: '仕事', title: null, available: true };
    }

    const pick = open[0];
    const days = pick.due ? daysBetween(today, pick.due) : null;
    return {
      area: 'work',
      label: '仕事',
      id: pick.row['ID'] || undefined,
      title: pick.row['内容'] || '(内容未記入)',
      detail: pick.row['次の行動'] || pick.row['区分'] || undefined,
      due: pick.due ? isoDate(pick.due) : undefined,
      because: days === null ? undefined : days < 0 ? `${-days}日超過` : `あと${days}日`,
      available: true,
    };
  }
}

/**
 * Lead time, scaled to what missing it costs.
 *
 * A deadline you can re-enter next month needs a day's warning. One that
 * forecloses an application entirely needs weeks — by the time it is two days
 * away, knowing about it may no longer help. This is the same distinction
 * IRIS already draws between a tool that writes and one that cannot be
 * undone, applied to a date.
 */
const LEAD_DAYS_IRREVERSIBLE = 45;
const LEAD_DAYS_ORDINARY = 14;

/**
 * Reads the sheet's own markings.
 *
 * The conventions are the user's, already in use across twenty-four rows:
 * 「必着」for arrive-by, 「これを逃すと…不可」for foreclosure, ⚠️ for a known
 * clash. Inventing a parallel vocabulary would mean maintaining two, and the
 * one in the sheet is the one that gets updated.
 */
export function readContestMarkings(note: string): { irreversible: boolean; conflict?: string; matched?: string } {
  const text = note ?? '';
  const foreclosure = text.match(/(これを逃すと[^。]*不可|逃すと[^。]*できな[いず]|応募自体不可)/);
  const mustArrive = text.match(/必着/);
  // ⚠️ is two code points — U+26A0 plus the variation selector U+FE0F — and a
  // character class matches only one of them, leaving the selector attached to
  // the captured text. Matched as a unit, with the selector optional because
  // the sheet contains both forms.
  const clash = text.match(/(?:\u26A0\uFE0F?|※)\s*([^。]*(?:衝突|同日|重な|講義中|試験)[^。]*)/);

  return {
    irreversible: Boolean(foreclosure || mustArrive),
    conflict: clash ? clash[1].trim() : undefined,
    // Reported so a wrong classification is visible rather than silent.
    matched: (foreclosure ?? mustArrive)?.[0],
  };
}

function rank(status: string | undefined): number {
  return (status ?? '').trim() === '未着手' ? 0 : 1;
}

/** Accepts the shapes the sheet actually contains, and refuses to guess. */
export function parseDate(value: string | undefined): Date | null {
  const text = (value ?? '').trim();
  if (!text) return null;
  const match = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (!match) return null;
  const [, y, m, d] = match;
  const parsed = new Date(Number(y), Number(m) - 1, Number(d));
  // Rejects 2026-02-31, which Date would silently roll into March.
  if (parsed.getMonth() !== Number(m) - 1 || parsed.getDate() !== Number(d)) return null;
  return parsed;
}

export function daysBetween(from: Date, to: Date): number {
  const a = new Date(from.getFullYear(), from.getMonth(), from.getDate()).getTime();
  const b = new Date(to.getFullYear(), to.getMonth(), to.getDate()).getTime();
  return Math.round((b - a) / 86_400_000);
}

function isoDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
