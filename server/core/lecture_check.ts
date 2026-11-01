/**
 * 夜の突き合わせ（講義日程表とカレンダー）の、判断と文面。
 *
 * 「irisがしょっちゅう間違えてるって言ってくる」（利用者、2026-10-10）。原因は、
 * 言う側が目で見比べていたこと。ここは機械で数えた結果だけを読み、**ずれが
 * 無い日は何も言わない**。言うのは、ずれ・重複・日程表の版が変わったときだけ。
 *
 * 読むだけで、直さない。直すのは、朝に利用者が頼んだときの承認つきの道具。
 */

export interface CalEventLike { title?: string | null; start?: string | null; end?: string | null; calendar?: string | null; location?: string | null }

export interface DuplicateGroup { start: string; calendar: string; titles: string[] }

const fold = (t: string) => String(t ?? '').normalize('NFKC').replace(/[\s　]+/g, '');

/**
 * 同じカレンダーの、同じ開始・同じ終了で、題が同じ（空白・全角半角・ローマ数字の違いは同じとみなす）予定。
 * 終日の予定は見ない（祝日や記念日が重なるのは普通）。
 */
export function findDuplicateEvents(events: CalEventLike[]): DuplicateGroup[] {
  const groups = new Map<string, CalEventLike[]>();
  for (const e of events) {
    if (!e.start || !String(e.start).includes('T')) continue;
    const key = `${e.calendar ?? ''}|${String(e.start).slice(0, 16)}|${String(e.end ?? '').slice(0, 16)}|${fold(e.title ?? '')}`;
    if (!fold(e.title ?? '')) continue;
    const list = groups.get(key) ?? [];
    list.push(e);
    groups.set(key, list);
  }
  return [...groups.values()]
    .filter((g) => g.length > 1)
    .map((g) => ({ start: String(g[0].start).slice(0, 16), calendar: g[0].calendar ?? '', titles: g.map((e) => `${e.title ?? ''}${e.location ? `（${e.location}）` : '（場所なし）'}`) }))
    .sort((a, b) => a.start.localeCompare(b.start));
}

export interface LectureGapLike {
  compared: boolean;
  reason?: string | null;
  missing?: Array<{ date: string; title: string }>;
  moved?: Array<{ date: string; title: string }>;
  shifted?: Array<{ date: string; title: string }>;
  surplus?: Array<{ date: string; title: string }>;
}

export interface LectureCheckInput {
  gap: LectureGapLike | null;
  duplicates: DuplicateGroup[];
  /** 日程表の版（ファイル名）。前回と違えば知らせる。 */
  source: string | null;
  lastSource: string | null;
  /** 読めなかったもの。「無い」ではない。 */
  couldNotRead: string[];
}

const list = (items: Array<{ date: string; title: string }> | undefined, n = 4) => {
  const xs = items ?? [];
  return xs.slice(0, n).map((x) => `${x.date.slice(5).replace('-', '/')} ${x.title}`).join('、') + (xs.length > n ? ` ほか ${xs.length - n} 件` : '');
};

export function composeLectureCheck(input: LectureCheckInput): { title: string; text: string } | null {
  const lines: string[] = [];
  const g = input.gap;
  if (g && g.compared) {
    if (g.missing?.length) lines.push(`日程表にあってカレンダーに無い授業 ${g.missing.length} 件: ${list(g.missing)}`);
    if (g.moved?.length) lines.push(`別の日に入っている授業 ${g.moved.length} 件: ${list(g.moved)}`);
    if (g.shifted?.length) lines.push(`時刻が違う授業 ${g.shifted.length} 件: ${list(g.shifted)}`);
    if (g.surplus?.length) lines.push(`日程表に無い授業がカレンダーにある ${g.surplus.length} 件: ${list(g.surplus)}`);
  }
  if (input.duplicates.length) {
    lines.push(`同じ時刻に同じ予定が重なっている ${input.duplicates.length} 件: ${input.duplicates.slice(0, 3).map((d) => `${d.start.slice(5, 10).replace('-', '/')} ${d.start.slice(11)} ${d.titles[0].replace(/（.*）$/, '')}`).join('、')}`);
  }
  if (input.source && input.lastSource && input.source !== input.lastSource) {
    lines.push(`日程表が新しくなりました（${input.lastSource} → ${input.source}）。`);
  }
  if (g && !g.compared) lines.push(`日程表との突き合わせができませんでした: ${g.reason ?? '理由は不明'}`);
  for (const m of input.couldNotRead) lines.push(`読めなかったもの（無い、ではない）: ${m}`);
  if (!lines.length) return null;
  return {
    title: '日程表とカレンダー',
    text: `夜のうちに、日程表とカレンダーを機械で突き合わせました。\n${lines.map((l) => `・${l}`).join('\n')}\n直すものがあれば、「直して」と言ってください（1 件ずつ承認の画面が出ます）。`,
  };
}
