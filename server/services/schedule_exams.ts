import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';

/**
 * 試験の日程を、大学が出した日程表から。
 *
 * The countdown used to rest entirely on somebody having typed the exam into a
 * calendar. On 2026-08-27 the Google calendar's refresh token expired at 02:33
 * and tomorrow's exam disappeared with it — no error on the band, just an
 * empty line where a countdown had been.
 *
 * The schedule PDF is what the university published. It does not depend on
 * anyone remembering to enter anything. `scripts/extract-schedule.py` turns it
 * into JSON once per version; this reads only the JSON, because a versioned
 * document is not something to parse on every request.
 *
 * Deliberately weaker than the calendar. The PDF carries a version date and
 * things move after it is printed, so where both have the same exam the
 * calendar wins. This answers when the calendar has nothing — which is the
 * situation it was built for.
 */

export interface ScheduleExam {
  title: string;
  /** Local date, `yyyy-MM-dd`. */
  date: string;
  /** Which published version this came from, so a stale answer can be spotted. */
  source: string;
}

export interface ScheduleRead {
  exams: ScheduleExam[];
  /**
   * Entries whose date could not be pinned down, kept rather than dropped.
   *
   * A gap somebody can see is worth more than a guess nobody can check: a
   * countdown that is a week early is worse than no countdown at all.
   */
  unresolved: number;
  source: string | null;
  reason: string | null;
}

const EMPTY = (reason: string): ScheduleRead => ({ exams: [], unresolved: 0, source: null, reason });

export interface ScheduledItem {
  title: string;
  date: string;
  period: number | null;
  start: string | null;
  startBasis: string | null;
  span: number | null;
}

export interface ScheduleLectureRead {
  lectures: ScheduledItem[];
  /**
   * 試験。**同じ紙の、同じ抽出結果から。**
   *
   * 長らく授業だけを突き合わせていた。試験は `readScheduleExams` が別に読み、
   * そちらは日付と題名しか持たないので、カレンダーと時刻を比べられなかった。
   * 結果として 2026-09-16 に「今日から年度末まで欠け0」と報告した裏で、
   * **病理学Ⅱ各論試験（10/26 12:50）がカレンダーに無かった。**別件を測って
   * いる途中に偶然見つかった —— 検査が見ていないものは、検査が0と言っても
   * 0ではない。
   *
   * 授業と同じ形（時限・開始・コマ数つき）で出すので、突き合わせは同じ規則で
   * 動く。再試・追試は抽出の時点で外れている（落ちなければ起きないものを
   * 「カレンダーに無い」と言わないため）。
   */
  exams: ScheduledItem[];
  /**
   * 格子の検算に落ちた箇所。**件数ではなく、どこかを持ち歩く。**
   *
   * 数だけ渡すと、比べる範囲の外の一件で全体が止まる（実測 2026-09-08、
   * 五ヶ月先の一件が今週の突き合わせを拒んだ）。
   */
  gridFaults: Array<{ between?: string[] }>;
  source: string | null;
  reason: string | null;
}

/**
 * 授業。試験と同じファイルから。
 *
 * `scripts/extract-schedule.py` は一つの JSON に `exams` と `lectures` の
 * 両方を書く。**同じ紙から出たものを二つのファイルに分けると、片方だけ
 * 作り直した日にずれる。**
 *
 * 時刻は PDF に無く、カレンダーから測った対応表（`periodTimes`）で付いて
 * いる。6限・7限は外挿なので `startBasis` にそう書いてある —— 読む側が
 * 重みを変えられるように。
 */

/**
 * 版の並び。**文字ではなく数で。**
 *
 * `exams-2026.10.3.json` と `exams-2026.6.19.json` を文字で並べると `'1' < '6'`
 * で 6月版が最新になる（2026-09-15 に気づいた。次の改訂で踏む穴）。
 * 数字に割れない名は末尾ではなく先頭に置く —— 古いものとして扱う。
 */
export function scheduleVersion(name: string): number[] {
  const m = name.match(/^exams-(\d+(?:\.\d+)*)\.json$/);
  return m ? m[1].split('.').map(Number) : [];
}

export function newestScheduleFile(files: string[]): string | undefined {
  const by = (a: string, b: string) => {
    const x = scheduleVersion(a), y = scheduleVersion(b);
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      const d = (x[i] ?? -1) - (y[i] ?? -1);
      if (d !== 0) return d;
    }
    return a.localeCompare(b);
  };
  return [...files].sort(by)[files.length - 1];
}

export function readScheduleLectures(root: string): ScheduleLectureRead {
  const dir = join(root, '.iris', 'schedule');
  const none = (reason: string): ScheduleLectureRead => ({
    lectures: [], exams: [], gridFaults: [], source: null, reason,
  });
  if (!existsSync(dir)) return none('講義日程の取り込みがありません。');
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.startsWith('exams-') && f.endsWith('.json')).sort();
  } catch (err: any) {
    return none(`講義日程を読めません: ${err?.message ?? err}`);
  }
  const newest = newestScheduleFile(files);
  if (!newest) return none('講義日程の抽出結果がありません。');
  try {
    const parsed = JSON.parse(readFileSync(join(dir, newest), 'utf-8'));
    const source = String(parsed?.source ?? newest);
    /*
     * 授業の欄が無い抽出結果は、**古い版の道具で作ったもの。**「授業が0件」
     * とは言わない —— 取っていないのと、無いのは別。
     */
    if (!Array.isArray(parsed?.lectures)) {
      return { ...none('この抽出結果には授業が入っていません（古い版の取り込み）。'), source };
    }
    const shape = (rows: any[]): ScheduledItem[] =>
      rows
        .filter((l: any) => typeof l?.title === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(l?.date ?? ''))
        .map((l: any) => ({
          // 抽出が題名の途中で折り返すことがある（「病理学Ⅱ各論試 験★」）。
          // 突き合わせ側が空白を落とすので、ここでは形を変えない。
          title: String(l.title).trim(),
          date: l.date,
          period: typeof l.period === 'number' ? l.period : null,
          start: typeof l.start === 'string' ? l.start : null,
          startBasis: typeof l.startBasis === 'string' ? l.startBasis : null,
          span: typeof l.span === 'number' ? l.span : null,
        }));
    const lectures = shape(parsed.lectures);
    /*
     * 試験の欄が無い抽出結果でも、授業の突き合わせは続ける。**片方が取れて
     * いないことは、もう片方を止める理由にならない。**
     */
    const exams = Array.isArray(parsed?.exams) ? shape(parsed.exams) : [];
    return {
      lectures,
      exams,
      gridFaults: Array.isArray(parsed?.gridFaults) ? parsed.gridFaults : [],
      source,
      reason: null,
    };
  } catch (err: any) {
    return none(`講義日程の抽出結果が壊れています: ${err?.message ?? err}`);
  }
}

/**
 * The newest extraction in the directory.
 *
 * Newest by filename rather than by modification time: the version is in the
 * name (`exams-2026.6.19.json`) and copying a file changes its timestamp
 * without changing which edition it is.
 */
export function readScheduleExams(root: string): ScheduleRead {
  const dir = join(root, '.iris', 'schedule');
  if (!existsSync(dir)) return EMPTY('講義日程の取り込みがありません。');

  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.startsWith('exams-') && f.endsWith('.json')).sort();
  } catch (err: any) {
    return EMPTY(`講義日程を読めません: ${err?.message ?? err}`);
  }
  const newest = newestScheduleFile(files);
  if (!newest) return EMPTY('講義日程の抽出結果がありません。');

  try {
    const parsed = JSON.parse(readFileSync(join(dir, newest), 'utf-8'));
    const source = String(parsed?.source ?? newest);
    const exams: ScheduleExam[] = (Array.isArray(parsed?.exams) ? parsed.exams : [])
      .filter((e: any) => typeof e?.title === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(e?.date ?? ''))
      .map((e: any) => ({ title: e.title.trim(), date: e.date, source }));
    return {
      exams,
      unresolved: Array.isArray(parsed?.unresolved) ? parsed.unresolved.length : 0,
      source,
      reason: null,
    };
  } catch (err: any) {
    return EMPTY(`講義日程の抽出結果が壊れています: ${err?.message ?? err}`);
  }
}

/**
 * Whether the calendar already knows about this exam.
 *
 * Matched on the date alone, not on the title. The same exam is written
 * differently in the two places — 「微生物・免疫学試験（後半）」 against whatever
 * somebody typed — and requiring the strings to agree would make the schedule
 * announce a duplicate of an exam already on the band.
 */
export function alreadyKnown(date: string, calendarDates: Set<string>): boolean {
  return calendarDates.has(date);
}
