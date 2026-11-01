/**
 * 出し先ごとの、一日の使用額の上限。
 *
 * 全体の上限（1 日 $10）は、全出し先の合計で、**どれか一つが使われすぎるのは防げない**。
 * 10/5 は、無料の Gemini が混雑で弾かれて、OpenAI に回り、1 日で $1.95 を使った
 * （利用者「高すぎじゃない？」）。上限に達した出し先は、その日だけ、順番から外す。
 * 外すだけで、会話は止めない（ほかの出し先に回る）。
 */
export interface UsageRecord { model?: string; servedBy?: string; usd?: number; at: string }

/** 出し先の鍵（router の key）→ そのモデル名かどうか。 */
const MODEL_OF: Record<string, RegExp> = {
  openai: /^(gpt-|o\d|chatgpt)/i,
  anthropic: /^claude-/i,
  'anthropic-fast': /^claude-/i,
  gemini: /^gemini-/i,
};

export function parseCaps(env: Record<string, string | undefined>): Record<string, number> {
  const caps: Record<string, number> = {};
  const openai = Number(env.IRIS_OPENAI_DAILY_USD ?? '1');
  if (Number.isFinite(openai) && openai >= 0) caps.openai = openai;
  const anthropic = env.IRIS_ANTHROPIC_DAILY_USD;
  if (anthropic !== undefined && anthropic !== '' && Number.isFinite(Number(anthropic))) caps.anthropic = Number(anthropic);
  return caps;
}

/** その日（現地）の、その出し先の使用額。 */
export function spentToday(key: string, records: UsageRecord[], now: Date): number {
  const test = MODEL_OF[key];
  if (!test) return 0;
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return records
    .filter((r) => Date.parse(r.at) >= start && typeof r.usd === 'number' && r.model && test.test(r.model))
    .reduce((s, r) => s + (r.usd ?? 0), 0);
}

export function isCapped(key: string, caps: Record<string, number>, records: UsageRecord[], now: Date): boolean {
  const cap = caps[key];
  if (cap === undefined) return false;
  return spentToday(key, records, now) >= cap;
}
