/**
 * 自己開発の「気づく」段。決まった規則だけ、模型は使わない。
 *
 * 気づく段で模型を使うと、**見張りそのものが外れる**（朝一番に外れた要約を読まされる
 * のと同じ）。ここは安く、いつでも同じ答えが出るものに限る。直す段（コーディング
 * エージェント）は、ここが拾った根拠を読んで、本当に直すべきかを自分で判断する —
 * 拾いすぎても、空振りに終わるだけで、本番は壊れない。
 */

export interface FindingInput {
  dedupeKey: string;
  source: 'complaint' | 'selfcheck' | 'error' | 'overview';
  title: string;
  detail: string;
  evidence: string[];
}

export interface UserMessage {
  id: string;
  conversationId: string;
  content: string;
  createdAt: string;
}

/* ── あなたの不満 ─────────────────────────────────────────────── */

/** 不満をはっきり言っている語。 */
const STRONG = [
  /使いにくい|使い勝手|不便|ふべん/, /微妙/, /わかりにくい|分かりにくい|わからん|分からん/,
  /動かない|動いてない|反応(が)?ない|開かない|出てない|出ない|表示されない|変わってない|変わらない/,
  /消える|消えて|消えた/, /おかしい|バグ|エラー/, /直して|直してほしい|直してほしく|直せ/,
  /毎回.{0,6}(直|言|聞|確認)/, /ぐるぐる/, /遅い|重い|固まる|止まる/,
];

/** IRIS 自身の話をしている語。「予定を入れてほしい」のような ふつうの頼みと分ける。 */
const PRODUCT = /iris|アイリス|レーン|通知|画面|表示|機能|アプリ|ボタン|カレンダー|センター|ダッシュボード|盤|HUD|返事|会話|履歴/i;

/** ふつうの話しかけ（質問・依頼）に見えるもの。不満の語が無ければ拾わない。 */
const WISH = /(して|して欲しい|してほしい|ほしい|欲しい|できない[?？]?|できないの|ないの[?？]|どうにか|なんとか)/;

export function scoreComplaint(text: string): { score: number; hits: string[] } {
  const hits: string[] = [];
  let score = 0;
  for (const re of STRONG) {
    const m = re.exec(text);
    if (m) { score += 2; hits.push(m[0]); }
  }
  if (PRODUCT.test(text)) score += 1;
  if (WISH.test(text) && PRODUCT.test(text)) score += 1;
  return { score, hits };
}

/** 一つの会話の、一時間のあいだの不満は一つの候補にまとめる。 */
export function detectComplaints(messages: UserMessage[]): FindingInput[] {
  const groups = new Map<string, { conversationId: string; items: Array<{ text: string; hits: string[] }> }>();
  for (const m of messages) {
    const text = m.content.trim();
    if (text.length < 6 || text.startsWith('/')) continue;
    const { score, hits } = scoreComplaint(text);
    // 不満の語が一つ以上あり、IRIS の話か、不満の語が二つ以上。
    if (!(hits.length >= 1 && score >= 3)) continue;
    const key = `complaint:${m.conversationId}:${m.createdAt.slice(0, 13)}`;
    const group = groups.get(key) ?? { conversationId: m.conversationId, items: [] };
    group.items.push({ text, hits });
    groups.set(key, group);
  }
  return [...groups.entries()].map(([dedupeKey, g]) => ({
    dedupeKey,
    source: 'complaint' as const,
    title: g.items[0].text.replace(/\s+/g, ' ').slice(0, 56),
    detail: `会話 ${g.conversationId.slice(0, 8)} での、あなたの不満（${g.items.length} 件）。`,
    evidence: g.items.slice(0, 3).map((i) => `「${i.text.replace(/\s+/g, ' ').slice(0, 160)}」`),
  }));
}

/* ── 繰り返すエラー ───────────────────────────────────────────── */

export interface ActivityEntry {
  event: string;
  level: string;
  message: string | null;
  createdAt: string;
}

/** 警告やエラーに見えて、直す話ではないもの。 */
const BENIGN = new Set([
  'context.observed', 'proactive.opener_held', 'tool.retry', 'calendar.warmup',
  // 天気は取れなくても困らない（次の取得で戻る）。利用者が「毎回通知しなくてよい」と
  // 言った（2026-10-02）。四回の失敗が「直す案」と開発の実行を三本起こしたのはこれ。
  'weather.failed', 'weather.unreadable',
  // 直しの案が検査に落ちた、という自己開発の輪自身の結果。文は落ちた候補の題で、
  // その候補は自分の再試行と上限で追われている。これを候補にすると「落ちた直しを直す」
  // 実行が起き、それが落ちればまた数が増える（2026-10-18、根拠が他の候補の題だけだった）。
  'self.fix_rejected',
]);

/**
 * 失敗に見えるか。**警告の色で書かれた普通の記録**が多い（会話を消した、バックアップを
 * コピーした、Gmail を取り込んだ）。それを「同じ警告が繰り返している」と数えると、
 * 直すものが無いのに直そうとする（2026-10-01、最初の走査で五件のうち三件がこれ）。
 * `error` はそのまま、`warn` は事件名か文に失敗を示す語があるものだけ。
 */
const FAILURE_WORDS = /fail|error|unreadable|timeout|timed.?out|denied|refus|invalid|broken|unavailable|stall|missing|rejected|crash|失敗|読めな|できな|落ち|拒否|エラー|届かな|返しませんでした/i;
function looksLikeFailure(e: ActivityEntry): boolean {
  return e.level === 'error' || FAILURE_WORDS.test(e.event) || FAILURE_WORDS.test(e.message ?? '');
}

export function detectErrorRepeats(entries: ActivityEntry[], now = new Date(), windowHours = 6, minCount = 3): FindingInput[] {
  const since = now.getTime() - windowHours * 3_600_000;
  const groups = new Map<string, ActivityEntry[]>();
  for (const e of entries) {
    if (e.level !== 'warn' && e.level !== 'error') continue;
    if (BENIGN.has(e.event) || Date.parse(e.createdAt) < since || !looksLikeFailure(e)) continue;
    const list = groups.get(e.event) ?? [];
    list.push(e);
    groups.set(e.event, list);
  }
  return [...groups.entries()]
    .filter(([, list]) => list.length >= minCount)
    .map(([event, list]) => ({
      dedupeKey: `error:${event}`,
      source: 'error' as const,
      title: `「${event}」が ${windowHours} 時間に ${list.length} 回（${list[0].level}）`,
      detail: '同じ警告・エラーが繰り返し記録されています。',
      evidence: [...new Set(list.map((e) => e.message).filter((m): m is string => !!m))].slice(0, 3),
    }));
}

/* ── 繰り返す停止 ─────────────────────────────────────────────── */

export interface StallEntry { at: string; ms: number; during: string | null; load?: number }

/** スリープの跨ぎは作業の停止ではない。これより長いものは数えない。 */
const SLEEP_MS = 120_000;

/** 起動してから、これだけの間の停止は数えない（温まる途中。再起動のたびに出ていた）。 */
const WARMUP_MS = 5 * 60_000;
/** 機械全体の負荷（÷ 芯の数）がこれ以上のときの停止は数えない（テストや検査で忙しいだけ）。 */
const BUSY_LOAD = 0.5;

export function detectStalls(stalls: StallEntry[], now = new Date(), uptimeSeconds = Infinity): FindingInput[] {
  const since = now.getTime() - 3_600_000;
  const bootAt = Number.isFinite(uptimeSeconds) ? now.getTime() - uptimeSeconds * 1000 : -Infinity;
  /*
   * 数えない停止：
   *   - 起動の直後（`warmup` など）。再起動のたびに、同じ項目が上がり直していた（2026-10-17、
   *     一日に何度も再起動した日に、「改善」が同じ停止の項目で埋まった）。
   *   - 機械全体が忙しいとき。サーバーの作りが重いのではなく、他の仕事に芯を取られている。
   *   - スリープの長さのもの。
   */
  const recent = stalls.filter((s) =>
    Date.parse(s.at) >= since && s.ms < SLEEP_MS
    && Date.parse(s.at) >= bootAt + WARMUP_MS
    && !(typeof s.load === 'number' && s.load >= BUSY_LOAD));
  const out: FindingInput[] = [];

  // 何の最中か分かる停止：同じ要求で 3 秒以上が二度。
  const byDuring = new Map<string, StallEntry[]>();
  for (const s of recent) {
    if (!s.during || s.ms < 3000) continue;
    byDuring.set(s.during, [...(byDuring.get(s.during) ?? []), s]);
  }
  for (const [during, list] of byDuring) {
    if (list.length < 2) continue;
    out.push({
      dedupeKey: `stall:${during}`,
      source: 'error',
      title: `「${during}」でサーバーが ${list.length} 回止まった（最長 ${Math.max(...list.map((s) => s.ms))} ms）`,
      detail: '要求の中の重い処理が、イベントループを塞いでいます。',
      evidence: list.slice(0, 3).map((s) => `${s.at.slice(11, 19)} ${s.ms} ms`),
    });
  }

  // 何の最中か分からない停止：起動から 5 分を過ぎて、10 秒以上が二度。起動の直後は温まる途中。
  if (uptimeSeconds > 300) {
    const unattributed = recent.filter((s) => !s.during && s.ms >= 10_000);
    if (unattributed.length >= 2) {
      out.push({
        dedupeKey: 'stall:unattributed',
        source: 'error',
        title: `原因の分からない停止が ${unattributed.length} 回（最長 ${Math.max(...unattributed.map((s) => s.ms))} ms）`,
        detail: '要求の外（タイマーなど）で、サーバーが 10 秒以上止まっています。',
        evidence: unattributed.slice(0, 3).map((s) => `${s.at.slice(11, 19)} ${s.ms} ms`),
      });
    }
  }
  return out;
}
