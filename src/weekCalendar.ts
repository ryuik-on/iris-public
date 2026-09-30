import type { ScheduleEvent } from './api';

/**
 * 週の暦を描くための計算。**描くことはしない。**
 *
 * 画面から切り離してあるのは、ここが間違えると**嘘の時刻に予定が座る**から。
 * 日をまたぐ予定、終日の予定、重なる予定 —— どれも見た目では「それらしく」
 * 描けてしまい、ずれていても誰も気づかない。試験で押さえる。
 */

/** `YYYY-MM-DD`。この機械の暦で。 */
export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

/**
 * その日を含む週の月曜。
 *
 * 月曜始まりにしたのは、**授業の週が月曜に始まる**から。日曜始まりだと
 * 一つの週の講義が二つの画面に割れ、土日が週の両端に離れる。
 */
export function mondayOf(d: Date): Date {
  const back = (d.getDay() + 6) % 7;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - back);
}

export interface PlacedEvent {
  event: ScheduleEvent;
  /** その日の 0 時からの分。日をまたぐものは、その日の中に切ってある。 */
  from: number;
  to: number;
  /** 重なりの中で何列目か、全部で何列か。 */
  column: number;
  columns: number;
  /** 前の日から続いている／次の日へ続く。**切ったことを隠さない。** */
  continuesBefore: boolean;
  continuesAfter: boolean;
}

export interface DayLayout {
  date: string;
  timed: PlacedEvent[];
  allDay: ScheduleEvent[];
}

const DAY = 24 * 60;

/**
 * 終日の予定がその日にかかるか。
 *
 * Google の終日は**終わりの日を含まない**（10/3 だけの予定は end が 10/4）。
 * 終わりが無ければ始まりの日だけ。日付は文字列のまま比べる —— `new Date('2026-10-03')`
 * は UTC の 0 時になり、東京では前日の 9 時に化ける。
 */
function allDayCovers(e: ScheduleEvent, date: string): boolean {
  const start = e.start.slice(0, 10);
  const end = e.end ? e.end.slice(0, 10) : null;
  if (!end || end <= start) return date === start;
  return start <= date && date < end;
}

/**
 * 重なる予定を横に並べる。
 *
 * 重なりの塊ごとに列を数える。**一日全体の最大で割ると、重なっていない予定まで
 * 細くなる**（下書きの一枚目がそうだった —— 10/6 の予定が全部半分の幅だった）。
 */
function assignColumns(items: Omit<PlacedEvent, 'column' | 'columns'>[]): PlacedEvent[] {
  const sorted = [...items].sort((a, b) => a.from - b.from || b.to - a.to);
  const out: PlacedEvent[] = [];
  let cluster: PlacedEvent[] = [];
  let clusterEnd = -1;
  let columnEnds: number[] = [];

  const flush = () => {
    const n = columnEnds.length;
    for (const p of cluster) p.columns = n;
    out.push(...cluster);
    cluster = [];
    columnEnds = [];
  };

  for (const item of sorted) {
    if (cluster.length > 0 && item.from >= clusterEnd) flush();
    let column = columnEnds.findIndex((end) => end <= item.from);
    if (column === -1) {
      column = columnEnds.length;
      columnEnds.push(item.to);
    } else {
      columnEnds[column] = item.to;
    }
    cluster.push({ ...item, column, columns: 0 });
    clusterEnd = Math.max(clusterEnd, item.to);
  }
  if (cluster.length > 0) flush();
  return out;
}

/**
 * 一日ぶんの配置。
 *
 * 時刻のある予定は、その日の 0 時〜24 時に**かかる部分だけ**を置く。
 * 開始日で束ねると、22 時から翌 2 時の予定が翌日に一分も現れず、翌朝が
 * 空いているように見える（サーバの空き時間も同じ理由で日ごとに切っている）。
 */
export function layoutDay(events: ScheduleEvent[], date: string): DayLayout {
  const [y, m, d] = date.split('-').map(Number);
  const dayStart = new Date(y, m - 1, d).getTime();
  const dayEnd = new Date(y, m - 1, d + 1).getTime();

  const allDay: ScheduleEvent[] = [];
  const timed: Omit<PlacedEvent, 'column' | 'columns'>[] = [];

  for (const e of events) {
    if (e.allDay || e.start.length < 16) {
      if (allDayCovers(e, date)) allDay.push(e);
      continue;
    }
    const start = Date.parse(e.start);
    if (Number.isNaN(start)) continue;
    const parsedEnd = e.end && e.end.length >= 16 ? Date.parse(e.end) : NaN;
    // 終わりの無い予定は 30 分として置く。**点は描けないので、床を置く。**
    const end = Number.isNaN(parsedEnd) || parsedEnd <= start ? start + 30 * 60_000 : parsedEnd;
    if (end <= dayStart || start >= dayEnd) continue;
    timed.push({
      event: e,
      from: Math.max(0, Math.round((start - dayStart) / 60_000)),
      to: Math.min(DAY, Math.round((end - dayStart) / 60_000)),
      continuesBefore: start < dayStart,
      continuesAfter: end > dayEnd,
    });
  }

  return { date, timed: assignColumns(timed), allDay };
}

/**
 * 縦軸の端。
 *
 * 既定は 8 時〜24 時。それより早い予定があれば、その時刻の頭まで広げる。
 * **切り取らない** —— 6 時の予定を 8 時の位置に描くと、嘘の時刻になる。
 * 週の全部の日で同じ縦軸にするので、日ごとではなく週で決める。
 */
export function hourRange(days: DayLayout[]): { from: number; to: number } {
  let from = 8 * 60;
  for (const day of days) {
    for (const p of day.timed) from = Math.min(from, Math.floor(p.from / 60) * 60);
  }
  return { from, to: DAY };
}
