/**
 * 予定の入れ先と題の形を、これまでの予定から学ぶ。
 *
 * 「サンプルっていう項目が出てこない」（利用者、2026-10-02）。入れる先は毎回
 * 選ぶ決まり（黙って既定の箱に入れない）だが、**選ぶ手間を減らすのは別の話**。
 * 「サンプル …」で始まる予定が、いつも職場の暦に入っているなら、その箱を先に選んでおく。
 * 決めるのは人のまま（選び直せる）。選んだ理由は、画面に書く。
 *
 * 件数が少ないもの、暦が割れているものは、先に選ばない。
 */
interface PastEvent { title?: string; calendar?: string }

const MIN_COUNT = 3;
const MIN_SHARE = 0.8;

function lead(title: string | undefined): string | null {
  const parts = (title ?? '').trim().split(/[\s　]+/);
  return parts.length >= 2 && parts[0].length >= 3 ? parts[0] : null;
}

export function learnCalendarHabit(past: PastEvent[], draftTitle: string, typed = ''): { lead: string; calendar: string; count: number; title: string } | null {
  const title = draftTitle.trim();
  const byLead = new Map<string, Map<string, number>>();
  for (const e of past) {
    const l = lead(e.title);
    if (!l || !e.calendar) continue;
    const m = byLead.get(l) ?? new Map<string, number>();
    m.set(e.calendar, (m.get(e.calendar) ?? 0) + 1);
    byLead.set(l, m);
  }
  // 下書きの題が、知っている頭の語で始まるもの。長い語を先に。
  // 題から外されていても、**打った文に**その語があれば、同じ予定とみなす（読み取りの模型が
  // 「サンプル」を題名ではなく場所の飾りと見て外した: 2026-10-02、「田中さんの面談」になった）。
  const leads = [...byLead.keys()].sort((a, b) => b.length - a.length);
  const inTitle = leads.find((l) => title.startsWith(l));
  const known = inTitle ?? leads.find((l) => typed.includes(l));
  if (!known) return null;
  const counts = byLead.get(known)!;
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  const [calendar, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (total < MIN_COUNT || count / total < MIN_SHARE) return null;
  // 「サンプル田中さん面談」→「サンプル 田中さん面談」。これまでの題の形（頭の語、空白、中身）にそろえる。
  const rest = title.slice(known.length);
  const normalized = !inTitle
    ? `${known} ${title}`
    : /^[\s　]/.test(rest) || rest === '' ? title : `${known} ${rest}`;
  return { lead: known, calendar, count, title: normalized };
}
