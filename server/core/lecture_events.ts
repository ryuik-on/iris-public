/**
 * 日程表の授業を、カレンダーに入れられる形にする。
 *
 * 「日程表8:30って書いてどうするの？実際に拾えた予定なら正式に予定として
 * 入れて欲しい」（利用者、2026-09-08）。**そのとおりで、注記は何も直さない。**
 *
 * ここは形を作るだけ。**書き込みはしない。**入れるかどうかは承認の側。
 */

export interface LectureSeed {
  title: string;
  /** `yyyy-MM-dd` */
  date: string;
  period: number | null;
  /** `HH:MM`。決まらなければ null。 */
  start: string | null;
  startBasis?: string | null;
  /** 何コマぶんか。紙の上の結合セルの幅から。読めなければ null。 */
  span?: number | null;
}

export interface LectureEvent {
  title: string;
  /** `2026-09-09T08:30` */
  start: string;
  /** `2026-09-09T10:40`。長さが決められなければ null。 */
  end: string | null;
  allDay: false;
  /** 長さの根拠。決められなかったときは `null` で、`end` も null。 */
  lengthBasis: 'measured' | null;
  /** 何コマぶんと読んだか。読めなければ null。 */
  periods: number | null;
}

/**
 * 題名のコマ数。「病理学Ⅱ31-32」なら2、「薬理学43-45」なら3。
 *
 * **紙の幅（`span`）が読めているときは、そちらが先。**題名の番号は 77件中
 * 18件にしか無く、残り 59件（「琉大祭準備」「動物実験の基礎」など）は
 * 番号を持たない。番号だけを頼りにすると、その 59件の長さを既定値で埋める
 * ことになる —— **推測が予定の顔でカレンダーに入る。**題名の番号は、幅が
 * 読めなかったときの控え。
 */
export function periodsIn(title: string): number | null {
  const m = /(\d{1,3})\s*[-–—〜~]\s*(\d{1,3})/.exec(title);
  if (!m) return null;
  const from = Number(m[1]);
  const to = Number(m[2]);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null;
  const count = to - from + 1;
  // 一日に7コマしかない。それを超える読み取りは、番号の読み違い。
  return count >= 1 && count <= 7 ? count : null;
}

/**
 * コマ数から長さ（分）。**カレンダーから測った値。**
 *
 * 2026-08-18〜09-08 の授業の実績:
 *   08:30 開始で 200分 ×4 ／ 12:50 開始で 130分 ×6 ／ 130分と200分しか無い。
 * 題名のコマ数と突き合わせると、2コマ=130分、3コマ=200分。
 *
 * **1コマと4コマ以上は観測が無い。**推測で埋めず `null` を返す —— 長さの
 * 分からない予定は、終わりを空けたまま入れる方がいい。
 */
/**
 * 時限の始まり。`scripts/extract-schedule.py` の `PERIOD_TIMES` と同じ表。
 *
 * **間隔は一定ではない。**3限と4限のあいだだけ120分空いている —— 昼。
 *
 *   1限 08:30  2限 09:40  3限 10:50 ┊ 4限 12:50  5限 14:00  6限 15:10  7限 16:20
 *                                  ↑ 120分
 */
const PERIOD_START: Record<number, string> = {
  1: '08:30', 2: '09:40', 3: '10:50', 4: '12:50', 5: '14:00', 6: '15:10', 7: '16:20',
};

/** 一コマの長さ。**60分で統一、変則なし**（利用者、2026-09-08）。 */
const PERIOD_MINUTES = 60;

/**
 * 何限から何コマかで、終わりの時刻。
 *
 * 最初は `コマ数 × 70 - 10` という式にしていた。2コマ=130・3コマ=200 に
 * 合い、1コマ=60 にも合ったので正しく見えた。**昼を跨ぐと合わない。**
 * 3限と4限のあいだだけ120分空いているので、1限から7コマは式では480分
 * （〜16:30）、実際は530分（〜17:20）。**50分ずれる。**
 *
 * 表を引けば式は要らない。**最後の時限の始まり + 60分。**間隔の不均一を
 * こちらで持たなくて済む。
 */
function endMinutes(period: number, span: number): { clock: string; basis: 'measured' } | null {
  const last = period + span - 1;
  const at = PERIOD_START[last];
  if (!at) return null;
  const [h, m] = at.split(':').map(Number);
  const total = h * 60 + m + PERIOD_MINUTES;
  const p = (n: number) => String(n).padStart(2, '0');
  return { clock: `${p(Math.floor(total / 60) % 24)}:${p(total % 60)}`, basis: 'measured' };
}

/**
 * 入れられるものだけを返す。
 *
 * 始まりが決まらないものは**落とす** —— 時刻の無い授業を終日で入れると、
 * その日が丸ごと埋まって見える。落としたことは呼び手が数えられるように、
 * 入力と出力の件数の差で分かる。
 */
export function toLectureEvents(seeds: LectureSeed[]): {
  events: LectureEvent[];
  /** 始まりが決まらず入れられなかったもの。 */
  skipped: LectureSeed[];
} {
  const events: LectureEvent[] = [];
  const skipped: LectureSeed[] = [];
  for (const s of seeds) {
    if (!s.start || !/^\d{2}:\d{2}$/.test(s.start)) {
      skipped.push(s);
      continue;
    }
    // 紙の幅が先。無ければ題名の番号。どちらも無ければ長さを決めない。
    const periods = (typeof s.span === 'number' && s.span > 0 ? s.span : null) ?? periodsIn(s.title);
    /*
     * 終わりは**表から**。何限に始まるかが分からなければ、長さも決めない。
     * `period` が無いのに `start` があるということは起こらないが、片方だけで
     * 埋めると、そこだけ違う根拠の値が混ざる。
     */
    const finish = periods !== null && s.period ? endMinutes(s.period, periods) : null;
    events.push({
      title: s.title,
      start: `${s.date}T${s.start}`,
      end: finish ? `${s.date}T${finish.clock}` : null,
      allDay: false,
      lengthBasis: finish ? finish.basis : null,
      periods,
    });
  }
  return { events, skipped };
}
