import { subject } from './event_title.js';

/**
 * 予定の隙間から空き時間を出す。
 *
 * Different from everything else IRIS reports, because the answer is handed to
 * another person. If a calendar source is missing, the gaps it would have
 * filled read as free — and the mistake is sent to whoever asked. On
 * 2026-08-27 the Google calendar was down for a day and every class vanished;
 * free time built from that state would have offered hours spent in lectures.
 *
 * So this never guesses. It is given the sources that answered and refuses to
 * produce anything when one that should have is absent.
 */

export interface CalendarEventLike {
  title?: string;
  start?: string;
  end?: string;
  allDay?: boolean;
  calendar?: string;
}

export interface FreeSlot {
  /** `HH:MM` local. */
  from: string;
  to: string;
}

export interface FreeDay {
  /** `yyyy-MM-dd`. */
  date: string;
  slots: FreeSlot[];
  /**
   * 空きが無い、または狭い理由。
   *
   * An all-day event blocks the day, and saying which one lets the reader
   * overrule it — 「琉大祭だから空いていない」 is something they can judge, while
   * an empty line is not.
   */
  note: string | null;
}

export interface FreeTimeOptions {
  /** 空きとみなす時間帯。既定 9:00〜24:00（利用者が決めた）。 */
  fromHour?: number;
  toHour?: number;
  /** これより短い隙間は出さない。既定60分（利用者が決めた）。 */
  minimumMinutes?: number;
  /**
   * 終日でも一日を潰さないカレンダー。
   *
   * 「日本の祝日」の終日は予定ではなく印で、潰すと休日が一日中埋まって見える。
   * 実測 2026-08-31: 終日9件のうち4件が祝日だった。
   */
  ignoreAllDayFrom?: string[];
}

/**
 * これより短い隙間は空きとして出さない。**60分は利用者が決めた値。**
 *
 * 外に出してあるのは、`day_room` が同じ床を使うため。**同じ値を二箇所で
 * 決めない** —— 片方だけ直す日が来る。
 */
export const DEFAULT_MINIMUM_MINUTES = 60;

const DEFAULTS = {
  fromHour: 9,
  toHour: 24,
  minimumMinutes: DEFAULT_MINIMUM_MINUTES,
  ignoreAllDayFrom: ['日本の祝日'],
};

/** `2026-09-01T13:00` などから、その日の分単位の位置。 */
function minutesOf(iso: string): number | null {
  const m = iso.match(/T(\d{2}):(\d{2})/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function clock(minutes: number): string {
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

/** `2026-09-08T22:00` → `2026-09-08`。終日なら値そのもの。 */
function dayOf(iso: string): string {
  return iso.slice(0, 10);
}

/** その日の翌日。文字列の足し算をしないための一箇所。 */
function nextDay(date: string): string {
  const at = new Date(`${date}T00:00:00`);
  at.setDate(at.getDate() + 1);
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/**
 * 予定を日ごとに切り分ける。**日をまたぐものは、またいだ日にも置く。**
 *
 * `freeForDay` には「日をまたぐ予定は呼び出し側で切っておく」と書いてあった。
 * **切っている呼び出し側は無かった。**予定は開始日だけで束ねられ、`minutesOf`
 * は ISO から時刻だけを拾って日付を捨てるので、
 *
 *   「9/8 22:00 〜 9/9 12:00」→ 9/8 に [1320, 720] という逆向きの区間として
 *   置かれ、**9/9 には一件も現れない。**その結果 9/9 は 9:00〜24:00 が
 *   まるごと空きになる。
 *
 * 見つけたのは astra のレビュー（2026-09-08）で、こちらでも再現した。
 * **これは外へ渡る数字**（`freeText` をそのまま人に貼る）なので、間違いは
 * 画面の中で止まらない。
 *
 * 終日の終わりは**翌日**（排他）。`.ics` と Google の決まりで、この repo の
 * 書き込み側も同じ扱いをしている。
 */
export function sliceByDay(
  events: CalendarEventLike[],
  dates: string[]
): Map<string, CalendarEventLike[]> {
  const wanted = new Set(dates);
  const byDay = new Map<string, CalendarEventLike[]>();
  const put = (date: string, event: CalendarEventLike) => {
    if (!wanted.has(date)) return;
    const held = byDay.get(date);
    if (held) held.push(event);
    else byDay.set(date, [event]);
  };

  for (const e of events) {
    const start = e.start ?? '';
    if (!/^\d{4}-\d{2}-\d{2}/.test(start)) continue;

    if (e.allDay) {
      // 終わりが無ければ一日。あれば翌日排他なので、その手前まで。
      const from = dayOf(start);
      const until = e.end && /^\d{4}-\d{2}-\d{2}/.test(e.end) ? dayOf(e.end) : nextDay(from);
      for (let day = from; day < until; day = nextDay(day)) {
        put(day, e);
        // 壊れた入力で無限に回らないように。ひと月を超える終日は切る。
        if (day > nextDay(from) && day >= dates[dates.length - 1]) break;
      }
      continue;
    }

    const from = dayOf(start);
    // 終わりが無いものは切りようが無い。開始の日にそのまま置き、長さは
    // `freeForDay` が最短の塊で埋める。**勝手に翌日まで伸ばさない。**
    if (!e.end || !/^\d{4}-\d{2}-\d{2}T/.test(e.end)) {
      put(from, e);
      continue;
    }
    const until = dayOf(e.end);
    if (until <= from) {
      put(from, e);
      continue;
    }
    for (let day = from; day <= until; day = nextDay(day)) {
      put(day, {
        ...e,
        // 前の日から続いているものは、その日の始まりから。
        start: day === from ? e.start : `${day}T00:00`,
        /*
         * 次の日へ続くものは、その日の終わりまで。`24:00` は同じ日付の
         * 文字列で書けないので `23:59` で止める。残る一分は
         * `minimumMinutes`（既定60分）に届かないので、隙間としては出ない。
         */
        end: day === until ? e.end : `${day}T23:59`,
      });
      if (day >= dates[dates.length - 1]) break;
    }
  }
  return byDay;
}

/**
 * 一日分の空き。
 *
 * `events` はその日の予定だけ。**日をまたぐ予定は `sliceByDay` で切っておく。**
 */
export function freeForDay(
  date: string,
  events: CalendarEventLike[],
  options: FreeTimeOptions = {}
): FreeDay {
  const o = { ...DEFAULTS, ...options };
  const dayStart = o.fromHour * 60;
  const dayEnd = o.toHour * 60;

  const blockingAllDay = events.find(
    (e) => e.allDay && !o.ignoreAllDayFrom.includes(e.calendar ?? '')
  );
  if (blockingAllDay) {
    return { date, slots: [], note: `${subject(blockingAllDay.title ?? '予定')}（終日）` };
  }

  /** 時刻のある予定だけが隙間を作る。終日で潰さないものは注記に回す。 */
  const busy: Array<[number, number]> = [];
  for (const e of events) {
    if (e.allDay) continue;
    const from = minutesOf(e.start ?? '');
    // 終了が無い予定は、少なくとも最短の塊ぶんは埋まっているとみなす。
    // 開始だけ書かれた予定を「一瞬で終わる」と扱うと、直後を空きとして出してしまう。
    const to = minutesOf(e.end ?? '') ?? (from === null ? null : from + o.minimumMinutes);
    if (from === null || to === null) continue;
    busy.push([Math.max(from, dayStart), Math.min(to, dayEnd)]);
  }
  busy.sort((a, b) => a[0] - b[0]);

  const slots: FreeSlot[] = [];
  let cursor = dayStart;
  for (const [from, to] of busy) {
    if (from - cursor >= o.minimumMinutes) slots.push({ from: clock(cursor), to: clock(from) });
    cursor = Math.max(cursor, to);
  }
  if (dayEnd - cursor >= o.minimumMinutes) slots.push({ from: clock(cursor), to: clock(dayEnd) });

  const ignored = events.filter((e) => e.allDay);
  return {
    date,
    slots,
    note: ignored.length > 0 ? `${subject(ignored[0].title ?? '予定')}（終日）` : null,
  };
}

/**
 * 貼り付ける用の素のテキスト。
 *
 * The screen can use colour and shape; this cannot — it is going into a
 * message. The sources and the time it was made travel with it, because a
 * warning shown on screen does not survive the copy.
 */
export function asPlainText(days: FreeDay[], sources: string[], at: Date): string {
  const week = '日月火水木金土';
  const lines = days.map((d) => {
    const date = new Date(`${d.date}T00:00:00`);
    const head = `${date.getMonth() + 1}/${date.getDate()}(${week[date.getDay()]})`;
    const body = d.slots.length > 0 ? d.slots.map((s) => `${s.from}-${s.to}`).join(', ') : '空きなし';
    return d.note ? `${head} ${body}  ※ ${d.note}` : `${head} ${body}`;
  });
  const stamp = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
  return `${lines.join('\n')}\n\n（${sources.join('・')} から作成 / ${stamp} 時点）`;
}
