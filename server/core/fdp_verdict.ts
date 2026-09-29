/**
 * The ledger's 自動判定, reproduced.
 *
 * It lives in the sheet as an ARRAYFORMULA. Moving the ledger into IRIS means
 * this has to be computed here — and that column is the only thing that
 * detects a task going quiet while nobody is looking, so getting it wrong
 * would remove the detector along with the thing it detects.
 *
 * So it is not guessed. The thresholds are read from the sheet's own 設定 tab
 * (更新停止 7日 / 期限間近 3日前 / 通知除外: 開始予定日前の未着手課題), and
 * `scripts/check-fdp-verdict.ts` recomputes every live row and compares
 * against what the sheet says. The formula in the sheet must not be switched
 * off until that comparison is clean.
 */
import { parseDate, daysBetween } from './daily_focus.js';

export type Verdict = '完了' | '遅延' | '保留' | '期限間近' | '更新停止' | '進捗停滞' | '順調';

/**
 * シートが使う言葉と、こちらの言葉の対応。
 *
 * 期限を過ぎた行をシートは **「期限超過」**、こちらは **「遅延」** と呼ぶ。
 * 同じ条件で立つ同じ状態で、**名前だけが違う。**
 *
 * 2026-09-02 まで誰も気づかなかったのは、**期限を過ぎた課題が一件も無かった**
 * から — 突き合わせは「全行一致」と言い続けていて、その分岐は一度も比べられて
 * いなかった。期限を一時的に過去へ動かして初めて出た。
 *
 * ここに置くのは、**突き合わせが文字列の比較だから。**対応を書かないと、
 * 期限超過の行が出るたびに「不一致」と報告され、**本物の食い違いが同じ顔で
 * 埋もれる。**
 */
export const SHEET_SYNONYM: Record<string, Verdict> = { 期限超過: '遅延' };

/** シートの言葉を、こちらの言葉に直す。知らない言葉はそのまま返す。 */
export function asOurWord(sheetSays: string): string {
  return SHEET_SYNONYM[sheetSays.trim()] ?? sheetSays.trim();
}

export interface VerdictSettings {
  /** 更新停止: this many days without a 最終更新日 bump counts as stopped. */
  stalledAfterDays: number;
  /** 期限間近: 期限がこの日数以内に入ったら、そう言う。 */
  dueSoonDays: number;
}

export const DEFAULT_SETTINGS: VerdictSettings = { stalledAfterDays: 7, dueSoonDays: 3 };

/**
 * 進捗停滞の幅。元の数式に `0.25` と直接書かれていた。
 *
 * 設定タブに項目が無いので、こちらにも設定として持たせない。**シートに無い
 * つまみをここで生やすと、変えられる場所が二つあるように見えて、実際には
 * 片方しか効かない。**
 */
const STALL_MARGIN = 0.25;

/** "7日" / "3日前" / "7" all mean the same number. */
export function parseDays(value: string | undefined): number | null {
  const m = (value ?? '').match(/(\d+)/);
  return m ? Number(m[1]) : null;
}

/** The 設定 tab, as the two numbers the verdict needs. */
export function settingsFromRows(rows: Record<string, string>[]): VerdictSettings {
  const byKey = new Map(rows.map((r) => [(r['設定項目'] ?? '').trim(), (r['値'] ?? '').trim()]));
  return {
    stalledAfterDays: parseDays(byKey.get('更新停止')) ?? DEFAULT_SETTINGS.stalledAfterDays,
    dueSoonDays: parseDays(byKey.get('期限間近')) ?? DEFAULT_SETTINGS.dueSoonDays,
  };
}

/**
 * One row's verdict.
 *
 * Order matters and is not arbitrary:
 *
 *   完了 wins over everything. A finished task that ran past its deadline is
 *   finished, not late.
 *
 *   遅延 before 保留. Parking a task does not move its deadline, and being
 *   told a parked task has run out of time is the point of saying anything.
 *
 *   保留 before 更新停止. That is the whole reason the hold exists: a task
 *   nobody touched for a month reads identically whether that was decided or
 *   forgotten, and only the hold separates them.
 *
 *   通知除外 comes before 更新停止. A task whose 開始予定日 has not arrived and
 *   which nobody has started cannot have stalled — there was nothing to stop.
 *   T008 is exactly this case: last touched in July, starting in November, and
 *   the sheet calls it 順調. Dropping this rule turns every future task into a
 *   false alarm, and a panel of false alarms is a panel nobody reads.
 *
 *   遅延 before 更新停止. Past its deadline is the worse fact of the two.
 */
export function verdictFor(
  row: Record<string, string>,
  today: Date,
  settings: VerdictSettings = DEFAULT_SETTINGS,
  /** YYYY-MM-DD the task is parked until, if it is parked. */
  heldUntil?: string | null
): Verdict {
  const status = (row['状態'] ?? '').trim();
  if (status === '完了') return '完了';

  const due = parseDate(row['期限']);
  // 遅延 outranks 保留 deliberately: parking a task does not move its
  // deadline, and a deadline that passed while it was parked is exactly the
  // thing worth being told.
  if (due && daysBetween(today, due) < 0) return '遅延';

  // A hold applies only while its end date is still ahead. An expired hold is
  // not a hold — the row simply stops mattering and the task is judged as it
  // would have been, which is what stops a pause turning into forgetting.
  const held = parseDate(heldUntil ?? undefined);
  if (held && daysBetween(today, held) >= 0) return '保留';

  /*
   * 期限間近。
   *
   * 2026-09-02 に元の数式を読むまで、ここは判定として存在せず、`dueSoonDays` は
   * 読み込まれるだけで一度も使われていなかった。突き合わせが「全行一致」と
   * 言い続けていたのは、**照合が IRIS の語彙を数え上げていたから** — シートに
   * しか出せない言葉は、比べる対象にすら入っていなかった。
   */
  if (due) {
    const until = daysBetween(today, due);
    if (until >= 0 && until <= settings.dueSoonDays) return '期限間近';
  }

  /*
   * ここから下は「もう始まっているはずの課題」だけの話。
   *
   * 元の数式は 更新停止 にも 進捗停滞 にも `開始予定日 <= 今日` を掛けていた。
   * 以前のこちらは代わりに「開始が先で、かつ状態が未着手なら順調」で降りていて、
   * **開始日が先なのに進行中になっている行**で答えが割れていた（シートは順調、
   * こちらは更新停止）。数式の条件をそのまま書く。
   */
  const start = parseDate(row['開始予定日']);
  const started = start !== null && daysBetween(today, start) <= 0;
  if (!started) return '順調';

  const touched = parseDate(row['最終更新日']);
  if (touched && daysBetween(touched, today) >= settings.stalledAfterDays) return '更新停止';

  /*
   * 進捗停滞: 期限までに使った時間の割合が、進捗率を 0.25 より大きく上回っている。
   *
   * 更新停止の**後**に来るのは数式のとおり。両方に当てはまる行 — 動いていなくて
   * 遅れてもいる — は 更新停止 と呼ぶ。動いていないことの方が先に手を打てる。
   *
   * 開始と期限が同日の行はゼロ除算になる。元の数式は `IFERROR(…, FALSE)` で
   * 「停滞ではない」に倒していたので、こちらもそう倒す。
   */
  if (due && start) {
    const span = daysBetween(start, due);
    const progress = Number((row['進捗率'] ?? '').trim() || '0');
    if (span > 0 && Number.isFinite(progress) && progress < 1) {
      const elapsed = daysBetween(start, today) / span;
      if (elapsed - progress > STALL_MARGIN) return '進捗停滞';
    }
  }

  return '順調';
}

/** 期限で急いでいる課題を選ぶための、最小の形。 */
export interface DatedTask {
  id?: string;
  title?: string;
  status?: string;
  verdict?: Verdict | string;
  /** 期限まで何日か。過ぎていれば負、当日は 0。 */
  dueInDays?: number | null;
}

/**
 * いま言うべき課題。
 *
 * 監視は長いあいだ「期限まであと1日」だけを見ていた。**前日に一度言って、
 * そのあとは何も言わない** —— 今日が期限（0日）も、過ぎた期限（負）も条件から
 * 外れる。実測 2026-09-30、当日の課題と 13 日超過の課題が、どちらも一度も
 * 鳴っていなかった。
 *
 * だから日数を数え直さない。**台帳が既に出している判定を読む** —— 閾値は
 * 設定タブにあり、二箇所で別々に決めると片方だけ古くなる。
 *
 * `保留` は外す。**手を止めると決めたものを急かさない** —— 決めたことを
 * 忘れたふりをするのは、黙っているより悪い。
 */
export function pressingTasks<T extends DatedTask>(tasks: T[]): T[] {
  return tasks.filter(
    (t) => (t?.verdict === '遅延' || t?.verdict === '期限間近') && t?.status !== '完了'
  );
}

/**
 * 一行で読める形にする。
 *
 * **件数では動けない。**「1件」と言われて何をすればいいかは分からない。
 * 名前と、あと何日かを言う（試験の食い違いで同じことを学んだ）。
 */
export function describePressing(task: DatedTask): string {
  const days = typeof task.dueInDays === 'number' ? task.dueInDays : null;
  const when = days === null ? '' : days < 0 ? `${-days}日超過` : days === 0 ? '今日' : `あと${days}日`;
  return `${task.id ?? ''} ${task.title ?? ''}（${task.verdict}${when ? '・' + when : ''}）`.trim();
}
