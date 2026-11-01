/**
 * 「/カレンダー 来週」のような一行を、見たい週の日付にする。
 *
 * 「コマンドでカレンダーを開いて、翌日以降や来週のものを見たい」（利用者、2026-10-01）。
 * 週の暦は右のパネルの奥にしか無かった。チャットの入力欄に打てる形にする。
 * 読めない言葉は、今週に読み替えず、`null`（コマンドではない）として返す —
 * 「来週」を頼んで今週が出ると、画面は来週の顔で今週を出す。
 */

const HEAD = /^\/(?:カレンダー|予定|週|cal|calendar)(?:\s+(.*))?$/i;

export function parseCalendarCommand(text: string, now: Date = new Date()): { start: Date } | null {
  const m = HEAD.exec(text.trim());
  if (!m) return null;
  const arg = (m[1] ?? '').trim();
  const day = (offset: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);

  if (arg === '' || arg === '今週' || arg === '今日') return { start: day(0) };
  if (arg === '明日') return { start: day(1) };
  if (arg === '明後日') return { start: day(2) };
  if (arg === '来週') return { start: day(7) };
  if (arg === '再来週') return { start: day(14) };
  if (arg === '先週') return { start: day(-7) };

  const weeks = /^(\d+)\s*週(?:間)?後$/.exec(arg);
  if (weeks) return { start: day(Number(weeks[1]) * 7) };
  const days = /^(\d+)\s*日後$/.exec(arg);
  if (days) return { start: day(Number(days[1])) };

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(arg);
  const md = /^(\d{1,2})[\/月](\d{1,2})日?$/.exec(arg);
  if (iso || md) {
    const [y, mo, d] = iso ? [Number(iso[1]), Number(iso[2]), Number(iso[3])] : [now.getFullYear(), Number(md![1]), Number(md![2])];
    const date = new Date(y, mo - 1, d);
    // 存在しない日（2/30）は、隣の日に読み替えず断る。
    if (date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
    return { start: date };
  }
  return null;
}
