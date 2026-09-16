import type { FreeDay, FreeSlot } from '../services/free_time.js';
import { DEFAULT_MINIMUM_MINUTES } from '../services/free_time.js';

/**
 * 今日、いまから先に残っている時間。
 *
 * `freeForDay` はその日ぜんたいの隙間を返す。**朝に見ても夕方に見ても同じ
 * 答え**なので、「いま何に手を付けられるか」には答えない。9:00〜12:00 が
 * 空いていると書いてあっても、いまが 14 時なら手を付けられない。
 *
 * 独立したレビュー（astra、2026-09-08）の指摘 ——「DailyFocus は分野別に
 * 一件ずつ選ぶだけで、合計が今日に収まるかを判断しない。**『全部大事』を
 * 短く並べても、選ぶ負担は本人に残る**」。所要時間は本人申告からと書いて
 * あったが、**申告の入る列がまだ無い。**そこで、こちらから言えることだけを
 * 言う ——「残りはこういう形で、いくら在るか」。
 *
 * **一件あたり何分かかるかは、こちらには分からない。**推測しない。
 * 「2時間の枠が一つと、1時間が二つ」まで分かれば、どれを今日に置くかは
 * 本人が決められる。
 */

export interface RoomSlot extends FreeSlot {
  minutes: number;
}

export interface DayRoom {
  slots: RoomSlot[];
  /**
   * いちばん長い枠。**`0` は「もう無い」、`null` は「言えない」。**
   *
   * この二つを混ぜると、読めていない日が「予定で埋まっている日」に見える。
   */
  longestMinutes: number | null;
  totalMinutes: number | null;
  /** 言えない理由。言えるときは `null`。 */
  reason: string | null;
}

const EMPTY = (reason: string): DayRoom => ({
  slots: [], longestMinutes: null, totalMinutes: null, reason,
});

/** `HH:MM` を、その日の分単位へ。 */
function minutesOf(clock: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(clock);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function roomLeftToday(
  free: FreeDay | null,
  now: Date,
  options: { minimumMinutes?: number; blocked?: string | null } = {}
): DayRoom {
  /*
   * 源が欠けているときは、数を出さない。
   *
   * `free_time` が同じところで止まっているのと同じ理由。授業が丸ごと消えた
   * 状態の「空き」は、授業中の時刻を空きとして渡すことになる。**ここは
   * その先で、しかも「いま手を付けられる」という顔をして出る。**
   */
  if (options.blocked) return EMPTY(options.blocked);
  if (!free) return EMPTY('今日の空きを読めていません。');

  const floor = options.minimumMinutes ?? DEFAULT_MINIMUM_MINUTES;
  const cursor = now.getHours() * 60 + now.getMinutes();

  const slots: RoomSlot[] = [];
  for (const slot of free.slots) {
    const from = minutesOf(slot.from);
    const to = minutesOf(slot.to);
    if (from === null || to === null) continue;
    // 過ぎた分を落とす。**始まりだけを動かす** —— 終わりは動かない。
    const start = Math.max(from, cursor);
    if (to - start < floor) continue;
    slots.push({
      from: `${pad(Math.floor(start / 60))}:${pad(start % 60)}`,
      to: slot.to,
      minutes: to - start,
    });
  }

  /*
   * 枠が一つも残っていないのは、**答え**であって欠落ではない。だから
   * `reason` は `null` のまま、数は 0 を返す。上の `EMPTY` と混ぜない。
   */
  return {
    slots,
    longestMinutes: slots.reduce((most, s) => Math.max(most, s.minutes), 0),
    totalMinutes: slots.reduce((sum, s) => sum + s.minutes, 0),
    reason: null,
  };
}

/** 人に見せる一行。`null` は「言えない」なので、数にしない。 */
export function describeRoom(room: DayRoom): string {
  if (room.reason) return room.reason;
  if (!room.slots.length) return '今日はもう空きがありません。';
  const longest = room.longestMinutes ?? 0;
  const hours = Math.floor(longest / 60);
  const mins = longest % 60;
  const biggest = hours ? `${hours}時間${mins ? `${mins}分` : ''}` : `${mins}分`;
  return `残り ${room.slots.length}枠 ・ 最長 ${biggest}`;
}
