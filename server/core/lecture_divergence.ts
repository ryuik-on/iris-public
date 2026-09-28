/**
 * 講義日程表とカレンダーの食い違い。
 *
 * 「明日は8:30から授業あると思うんだけど」（利用者、2026-09-08）。
 * カレンダーは 09:40 と言い、日程表は 1限＝08:30 と言っていた。**日程表が
 * 正しかった。**気づいたのは本人の記憶で、IRIS は両方を持っていながら
 * 突き合わせていなかった。
 *
 * `calendar_divergence` が源どうしを比べるのと同じ形。違うのは、片方が
 * 大学の出した紙で、**版があって、刷ったあとに動く**こと。だから
 * 「日程表が正しい」とは言わない —— **違うと言うだけ。**どちらが正しいかは
 * 人が決める。
 */

export interface ScheduleLecture {
  title: string;
  /**
   * 授業か試験か。**扱いは同じ、重みは違う。**
   *
   * 突き合わせの規則は一つで足りる（どちらも紙の上の題名・日付・時限）。
   * 分けて持つのは、欠けを読む人にとって意味が違うから —— 授業を一コマ
   * 逃すのと、試験を逃すのは同じ事故ではない。
   */
  kind?: 'lecture' | 'exam';
  /** `yyyy-MM-dd` */
  date: string;
  period: number | null;
  /** `HH:MM`。決められなければ null。 */
  start: string | null;
  /** `measured` か `extrapolated`。外挿を実測として扱わないため。 */
  startBasis?: string | null;
  /** 何コマぶんか。紙の上の幅から。 */
  span?: number | null;
}

export interface CalendarLectureLike {
  title: string;
  /** `2026-09-09T08:30` または帯つき。終日は日付だけ。 */
  start?: string | null;
}

export interface LectureGap {
  title: string;
  /** 授業か試験か。読む側が重みを変えられるように。 */
  kind: 'lecture' | 'exam';
  date: string;
  period: number | null;
  /** 日程表の時刻。 */
  scheduled: string | null;
  /** カレンダーの時刻。無ければ null。 */
  calendar: string | null;
  /** 外挿由来の時刻で比べた、という印。 */
  extrapolated: boolean;
  /** 何コマぶんか。入れ直すときの長さに要る。 */
  span?: number | null;
}

export interface LectureDivergence {
  compared: boolean;
  reason: string | null;
  /** 日程表にあってカレンダーに無い。 */
  missing: LectureGap[];
  /** 両方にあるが時刻が違う。 */
  moved: LectureGap[];
  /**
   * 同じ授業が近くの別の日にある。**欠けでも時刻違いでもない。**
   *
   * 入れ直すと二日に並ぶので、`missing` から外してある。`calendar` には
   * 暦の側の日付が入る。
   */
  shifted: LectureGap[];
  /**
   * カレンダーにあって日程表に無い。**逆向き。**
   *
   * 検査は長らく「日程表にあってカレンダーに無い」しか見ていなかった。
   * 2026-09-16 に手で入れた「医学系演習/プライマリ・ケア演習Ⅱ1-3」は日程表
   * では 9/18 で、9/18 には正しい方が別にあった —— つまり**別の日の複製**。
   * 欠けでも時刻違いでも日ずれでもないので、検査は 0 件と言った。
   *
   * 講義らしい題名（日程表のどこかの授業と同じ題名）なのに、その日の日程表に
   * 無いものをここに出す。`shifted` として拾った側の予定は除く —— 同じものを
   * 二度言わない。
   *
   * 試験は番号を持たないので、この規則では拾えない。**設計どおり拾わない
   * ものは、拾えないと知っておく** —— 実際にそれで一件見落とした。暦の
   * 2026-10-26 08:30「病理学Ⅰ各論試験」は、紙では 10/29 にあり 10/26 には
   * 無い。欠けでも時刻違いでも日ずれでもなく、そして番号が無いので余分にも
   * ならなかった。**検査のどの欄にも出ない予定があった。**
   *
   * そこで試験は別の規則で拾う（下の `surplusExam`）。授業と同じ部分一致には
   * しない —— 「病理学Ⅰ各論試験の勉強」のような自分で入れた予定が、試験の
   * 題名を含むだけで余分になる。
   */
  surplus: LectureGap[];
  /** 比べた日数。 */
  days: number;
}

/** 同じ授業が「近く」と言える幅。前後3日。週内のずれを拾い、別の週は拾わない。 */
const NEARBY_DAYS = 3;

/**
 * 題名を「科目・番号の範囲・注記」に分ける。
 *
 * 余分の判定に使う。部分一致（`same`）だと「琉大祭」が「琉大祭準備」に当たり、
 * 「循環器1-3（再）」が毎日「日程表に無い」と鳴る（実測 2026-09-15、意図して
 * 残した6件が毎日の提案になった）。
 *
 *   循環器4-6      → subject 循環器, 4..6
 *   神経5          → subject 神経, 5..5
 *   病理学Ⅱ41-42実習 → subject 病理学Ⅱ, 41..42（接尾の「実習」は落とす）
 *   循環器1-3（再） → annotated（**人が注記を付けたものは触らない**）
 *   琉大祭 / 病理学Ⅱ予備 → 番号が無い → 授業ではない
 */
export interface LectureKey {
  subject: string;
  from: number;
  to: number;
  /** （再）（最終）（学士不可）のような注記。付いていれば人の意図。 */
  annotated: boolean;
}

export function lectureKey(title: string): LectureKey | null {
  let t = fold(title);
  const annotated = /[（(][^（）()]*[）)]\s*$/.test(t);
  t = t.replace(/[（(][^（）()]*[）)]\s*$/, '');
  const m = t.match(/^(.+?)(\d+)(?:[-−–](\d+))?(?:実習|講義)?$/);
  if (!m) return null;
  const from = Number(m[2]);
  const to = m[3] ? Number(m[3]) : from;
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null;
  return { subject: m[1], from, to, annotated };
}

/** 空白と全角空白を落とす。折り返しで入る空白は意味を持たない。 */
function fold(title: string): string {
  return (
    title
      .replace(/[\s　]+/g, '')
      // 紙の「腎･泌」は半角の中点、暦の「腎・泌」は全角。**同じ字のつもりで
      // 打たれた別の符号**を、別物と読んでいた（実測 2026-09-12、11/9 の腎・泌2
      // が「日程表に無い」と誤報）。★は紙の初回印で、題名の一部ではない。
      .replace(/[･·]/g, '・')
      .replace(/★/g, '')
  );
}

/**
 * 同じ授業か。
 *
 * 題名は両方で微妙に違う（「病理学Ⅱ35-36 実習」と「病理学Ⅱ35-36実習」）。
 * 空白を落として、**どちらかがどちらかの頭に含まれていれば同じ**とみなす。
 * 「病理学Ⅱ31-32」と「病理学Ⅱ33-34」は先頭が同じなので、**回数まで見ないと
 * 別物が同じに見える** —— だから前方一致ではなく、短い方の全体が含まれるか。
 */
function same(a: string, b: string): boolean {
  const x = fold(a);
  const y = fold(b);
  if (!x || !y) return false;
  return x.includes(y) || y.includes(x);
}

/**
 * 試験が同じか。**部分一致にしない。**
 *
 * 授業の部分一致をそのまま使うと、暦の 2026-10-29「病理学Ⅰ各論試験（再）」が
 * 紙の 10/29「病理学Ⅰ各論試験」に当たって、食い違い無しと言う（実測
 * 2026-09-28）。**再試は試験ではない** —— 落ちなければ起きないものが、本番の
 * 代わりに立っていた。同じ理由で「病理学Ⅰ各論試験の勉強」も当たらない。
 *
 * 題名が短く区別しやすいので、試験では完全一致で足りる。折り返しの空白・
 * 半角中点・★は `fold` が先に落とす。
 */
function sameExam(a: string, b: string): boolean {
  const x = fold(a);
  const y = fold(b);
  return !!x && x === y;
}

export function findLectureDivergence(input: {
  lectures: ScheduleLecture[];
  /**
   * 試験。**授業と同じ規則で突き合わせるが、余分の判定には入れない。**
   *
   * 余分（暦にあって紙に無い）は科目と番号で見ている。試験の題名には番号が
   * 無いので、そもそも判定にかからない —— 手で入れた再試を「日程表に無い」と
   * 言わないのは、この性質に頼っている。**設計どおり拾わないものは、拾えないと
   * 知っておく。**
   */
  exams?: ScheduleLecture[];
  events: CalendarLectureLike[];
  from: string;
  to: string;
  /** 日程表が読めなかった理由。あれば比べない。 */
  scheduleReason?: string | null;
  /** カレンダーが読めなかった理由。あれば比べない。 */
  calendarReason?: string | null;
  /**
   * 格子の検算に落ちた箇所の日付。**件数ではなく、どこか。**
   *
   * 数だけで止めると、比べる範囲の外の不一致で全体が止まる。実際に止まった:
   * 2027-02-11 の次が 2027-02-13 という一件（建国記念の日の前後で、そもそも
   * 不一致ですらないかもしれない）で、**五ヶ月先の一件が今週の突き合わせを
   * 拒んでいた。**読めないと言うのは正しいが、読めていない場所を超えて
   * 広げるのは、正しさではなく諦め。
   */
  gridFaults?: Array<{ between?: [string, string] | string[] }>;
}): LectureDivergence {
  const days =
    Math.round((Date.parse(`${input.to}T00:00:00`) - Date.parse(`${input.from}T00:00:00`)) / 86_400_000) + 1;
  const empty = (reason: string): LectureDivergence => ({
    compared: false, reason, missing: [], moved: [], shifted: [], surplus: [], days,
  });

  /*
   * 読めなかった側があるときは比べない。**片方しか無い比較は比較ではない。**
   * `calendar_divergence` と同じ規則で、理由も同じ —— 「カレンダーに無い」は
   * カレンダーが読めているときにしか言えない。
   */
  if (input.scheduleReason) return empty(`講義日程を読めていません（${input.scheduleReason}）。`);
  if (input.calendarReason) return empty(`カレンダーを読めていません（${input.calendarReason}）。`);
  const inside = (input.gridFaults ?? []).filter((f) => {
    const pair = f.between ?? [];
    return pair.some((d) => typeof d === 'string' && d >= input.from && d <= input.to);
  });
  if (inside.length) {
    const where = inside
      .map((f) => (f.between ?? []).join(' の次が '))
      .join('、');
    return empty(`講義日程の格子が、比べる範囲の中で合っていません（${where}）。日付を信用できないので比べません。`);
  }

  const byDay = new Map<string, CalendarLectureLike[]>();
  for (const e of input.events) {
    const key = String(e.start ?? '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue;
    const held = byDay.get(key);
    if (held) held.push(e);
    else byDay.set(key, [e]);
  }

  const missing: LectureGap[] = [];
  const moved: LectureGap[] = [];
  const shifted: LectureGap[] = [];
  /** `shifted` の相手として使った暦の予定。`surplus` で二度数えない。 */
  const claimed = new Set<CalendarLectureLike>();
  /** その日で既に照合に使った予定。同じ題名の別のコマに二度当てない。 */
  const usedOnDay = new Set<CalendarLectureLike>();
  /*
   * 紙の上のもの、ひとまとめ。**試験を後回しにしない。**
   *
   * 同じ日に授業と試験が並ぶ（10/19 は 1限から薬理学期末試験、4限から病理学Ⅰ
   * 実習）。片方だけを先に全部照合すると、`usedOnDay` の取り合いが日付順では
   * なく種類順になる。日付で並べて、同じ日は時限の早い順に見る。
   */
  const scheduled: ScheduleLecture[] = [...input.lectures.map((l) => ({ ...l, kind: l.kind ?? ('lecture' as const) })),
    ...(input.exams ?? []).map((e) => ({ ...e, kind: 'exam' as const }))]
    .sort((a, b) => (a.date === b.date ? (a.start ?? '').localeCompare(b.start ?? '') : a.date.localeCompare(b.date)));

  for (const l of scheduled) {
    if (l.date < input.from || l.date > input.to) continue;
    const here = byDay.get(l.date) ?? [];
    /*
     * 同じ題名が一日に複数あるとき（1/22 の「腎・泌」×3）、最初に見つけた一つに
     * 全部を照合すると、残りが「時刻違い」に見える（実測 2026-09-15）。
     * **時刻の合うものを先に取り、無ければまだ使っていないものを取る。**
     */
    const clockOf = (e: CalendarLectureLike) => {
      const at = String(e.start ?? '');
      return at.length >= 16 ? at.slice(11, 16) : null;
    };
    /** 試験は完全一致、授業は部分一致。理由は `sameExam` に。 */
    const alike = (paper: string, event: string) =>
      l.kind === 'exam' ? sameExam(paper, event) : same(paper, event);
    // 同じ日の別の授業に時刻がぴったり合う予定は、代替として取らない
    // —— 先に処理された授業が、後の授業の予定を横取りしない。
    const reservedByAnother = (e: CalendarLectureLike) =>
      scheduled.some((o) => o !== l && o.date === l.date && !!o.start && same(o.title, e.title) && clockOf(e) === o.start);
    const match =
      here.find((e) => !usedOnDay.has(e) && alike(l.title, e.title) && !!l.start && clockOf(e) === l.start) ??
      here.find((e) => !usedOnDay.has(e) && alike(l.title, e.title) && !reservedByAnother(e));
    if (match) usedOnDay.add(match);
    const gap: LectureGap = {
      title: l.title,
      kind: l.kind ?? 'lecture',
      date: l.date,
      period: l.period,
      scheduled: l.start,
      calendar: null,
      extrapolated: l.startBasis === 'extrapolated',
      span: l.span ?? null,
    };
    if (!match) {
      /*
       * その日に無くても、**近くの日に同じ題名があれば「無い」とは言わない。**
       *
       * 突き合わせは日ごとなので、**日付がずれている予定は「その日に無い」に
       * 見える。**それを欠けとして入れると、暦の上に同じ授業が二日並ぶ。
       * 実際にそうなった（2026-09-08、77件入れたうち13件が一日ずれの二重。
       * 病理学Ⅱ35-36実習 が 9/10 と 9/11 の両方に載った）。
       *
       * どちらの日が正しいかは、ここでは決めない。**日がずれていること自体を
       * 報告する。**紙にも暦にも版があり、片方を正しいと決めるのは人の仕事。
       */
      const near = input.events.find((e) => {
        if (!alike(l.title, e.title)) return false;
        const at = String(e.start ?? '').slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(at)) return false;
        const apart = Math.abs(Date.parse(`${at}T00:00:00`) - Date.parse(`${l.date}T00:00:00`)) / 86_400_000;
        return apart > 0 && apart <= NEARBY_DAYS;
      });
      if (near) {
        claimed.add(near);
        shifted.push({ ...gap, calendar: String(near.start ?? '').slice(0, 10) });
        continue;
      }
      missing.push(gap);
      continue;
    }
    const at = String(match.start ?? '');
    const clock = at.length >= 16 ? at.slice(11, 16) : null;
    // 時刻が読めないものは、違うとも同じとも言わない。
    if (!clock || !l.start || clock === l.start) continue;
    moved.push({ ...gap, calendar: clock });
  }

  /*
   * 余分は科目と番号で見る。
   *
   * 「その日の日程表に、同じ科目で番号が重なる授業があるか」。無ければ余分。
   * 科目そのものが日程表のどこにも無いなら授業ではない（飲み会、mtg）。
   * 番号が無い題名（琉大祭、予備）も授業ではない。**注記が付いたもの**
   * （（再）（最終））は人が意図して入れたものとして触らない。
   */
  const keyed = input.lectures
    .map((l) => ({ l, k: lectureKey(l.title) }))
    .filter((x): x is { l: ScheduleLecture; k: LectureKey } => x.k !== null);
  const subjects = new Set(keyed.map((x) => x.k.subject));
  const surplus: LectureGap[] = [];
  for (const [date, here] of byDay) {
    if (date < input.from || date > input.to) continue;
    for (const e of here) {
      if (claimed.has(e)) continue;
      const k = lectureKey(e.title);
      if (!k || k.annotated) continue;
      if (!subjects.has(k.subject)) continue;
      const scheduledHere = keyed.some(
        (x) => x.l.date === date && x.k.subject === k.subject && x.k.from <= k.to && k.from <= x.k.to
      );
      if (scheduledHere) continue;
      const at = String(e.start ?? '');
      surplus.push({
        title: e.title,
        // 余分は番号のある授業の題名でしか成立しない。試験はここに来ない。
        kind: 'lecture',
        date,
        period: null,
        scheduled: null,
        calendar: at.length >= 16 ? at.slice(11, 16) : null,
        extrapolated: false,
      });
    }
  }

  /*
   * 暦にあって、その日の紙に無い試験。
   *
   * 授業の余分と違い、**題名がそのまま一致するときだけ**言う（空白・中点・★を
   * 落としたあとの完全一致）。部分一致にすると「病理学Ⅰ各論試験の勉強」
   * 「病理学Ⅱ各論試験対策」のような自分の予定が、試験の題名を含むだけで
   * 余分に見える。
   *
   * 注記が付いたもの（（再）（追））は人が意図して入れたものなので触らない
   * —— 再試は落ちなければ起きないので、紙には無くて当たり前。
   */
  const examTitles = new Set((input.exams ?? []).map((e) => fold(e.title)));
  for (const [date, here] of byDay) {
    if (date < input.from || date > input.to) continue;
    for (const e of here) {
      if (claimed.has(e) || usedOnDay.has(e)) continue;
      const title = fold(e.title);
      if (!examTitles.has(title)) continue;
      if (/[（(][^（）()]*[）)]\s*$/.test(title)) continue;
      const scheduledHere = (input.exams ?? []).some((x) => x.date === date && fold(x.title) === title);
      if (scheduledHere) continue;
      const at = String(e.start ?? '');
      surplus.push({
        title: e.title,
        kind: 'exam',
        date,
        period: null,
        scheduled: null,
        calendar: at.length >= 16 ? at.slice(11, 16) : null,
        extrapolated: false,
      });
    }
  }

  return { compared: true, reason: null, missing, moved, shifted, surplus, days };
}
