import { MODEL_PRICES, estimateCost, type TokenUsage } from './usage.js';
import type { ModelPerformance } from './telemetry_service.js';

/**
 * どのモデルを使うか、の判断材料。
 *
 * 「モデルのトークン量とかを統計とって、最適なモデルに切り替える」（利用者、
 * 2026-10-02）。IRIS だけでなく、普段 Claude や GPT を動かすときの判断にも使う
 * ので、IRIS の内部の都合を持たない純粋な関数にしてある。
 *
 * 材料は二つ。**実績**（その役の仕事を、そのモデルが何件やって、何件成功したか）と、
 * **トークンの使い方**（一件の仕事が平均でどれだけ読み書きするか）。後者に価格を
 * 掛けると「このモデルなら一件いくら」が出る。
 *
 * 守っている規則は三つ。
 *   1. 実績が足りない（`insufficient`）ものは、順位の根拠にしない。数件の成功率は
 *      ただの揺れで、`telemetry_service.ts` が比較を拒むのと同じ理由。
 *   2. 「安いほう」ではなく「足りている中で安いほう」。基準は、実績のある中で一番
 *      成功率が高いものから 10 ポイント以内、かつ 70% 以上。
 *   3. 実績の無いものは、推すのではなく**試す価値がある**として添える。価格が
 *      安いことは、足りていることの証拠ではない。
 *
 * 切り替えそのものはここでしない。これは「何を選ぶか」を述べるだけで、
 * 反映は人が決める。
 */

export interface TokenProfile {
  /** 一件あたりの平均。 */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** 何件の平均か。 */
  samples: number;
}

export interface UsageEvent { model?: string; usage?: Partial<TokenUsage> & Record<string, any> }

/** `run.usage` の記録から、一件あたりの平均を出す。一件も無ければ null。 */
export function profileFromUsageEvents(events: UsageEvent[]): TokenProfile | null {
  const used = events.filter((e) => e.usage && typeof e.usage.outputTokens === 'number');
  if (!used.length) return null;
  const sum = (key: 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheCreationTokens') =>
    used.reduce((s, e) => s + (Number((e.usage as any)[key]) || 0), 0) / used.length;
  return {
    inputTokens: Math.round(sum('inputTokens')),
    outputTokens: Math.round(sum('outputTokens')),
    cacheReadTokens: Math.round(sum('cacheReadTokens')),
    cacheCreationTokens: Math.round(sum('cacheCreationTokens')),
    samples: used.length,
  };
}

export interface Candidate {
  model: string;
  /** その profile で一件あたりいくらか。 */
  expectedUsd: number;
  /** 実績。無ければ null（未検証）。 */
  measured: { attempts: number; successRate: number; evidence: ModelPerformance['evidence'] } | null;
}

export interface Advice {
  role: string;
  /** measured = 実績に基づく／insufficient = 実績が足りず、決められない。 */
  basis: 'measured' | 'insufficient';
  recommend: string | null;
  /** 実績は無いが、安くて試す価値のあるもの。推薦ではない。 */
  trial: string | null;
  reason: string;
  candidates: Candidate[];
  profile: TokenProfile | null;
  pricingNote: string;
}

const RELEVANT = (m: string) => !/(image|realtime|transcribe|live|tts|whisper|embedding)/.test(m);
const SUCCESS_MARGIN = 0.1;
const SUCCESS_FLOOR = 0.7;

/** 実績の行のモデル名（`openai:gpt-5.6-terra` や日付付き）を、価格表の鍵に合わせる。 */
function matchModel(rowModel: string, priced: string[]): string | null {
  const bare = rowModel.includes(':') ? rowModel.slice(rowModel.indexOf(':') + 1) : rowModel;
  if (priced.includes(bare)) return bare;
  const prefixed = priced.filter((p) => bare.startsWith(p)).sort((a, b) => b.length - a.length)[0];
  return prefixed ?? null;
}

export function adviseModel(input: {
  role: string;
  performance: ModelPerformance[];
  profile: TokenProfile | null;
  /** 候補を絞るとき。無ければ価格表のすべて。 */
  among?: string[];
  prices?: Record<string, unknown>;
  pricingLastVerified?: string;
}): Advice {
  const priced = Object.keys(input.prices ?? MODEL_PRICES).filter(RELEVANT);
  const pool = (input.among?.length ? input.among : priced).filter((m) => priced.includes(m));
  // 平均の使い方が分からないときは、入力 20k・出力 2k の中くらいの仕事とみなす。
  const profile = input.profile ?? { inputTokens: 20_000, outputTokens: 2_000, cacheReadTokens: 0, cacheCreationTokens: 0, samples: 0 };
  const pricingNote = `価格は ${input.pricingLastVerified ?? '不明'} に確かめた表による。${input.profile ? `一件の使い方は直近 ${profile.samples} 件の平均。` : '一件の使い方の記録が無いので、入力 2万・出力 2千トークンの仮の仕事で見積もった。'}`;

  const measuredRows = new Map<string, ModelPerformance>();
  for (const row of input.performance.filter((r) => r.role === input.role)) {
    const key = matchModel(row.agent.includes(':') ? row.agent : row.model, priced) ?? matchModel(row.model, priced);
    if (!key) continue;
    const prev = measuredRows.get(key);
    if (!prev || row.attempts > prev.attempts) measuredRows.set(key, row);
  }

  const candidates: Candidate[] = pool.map((model) => {
    const row = measuredRows.get(model);
    const usage: TokenUsage = {
      inputTokens: profile.inputTokens, outputTokens: profile.outputTokens,
      cacheReadTokens: profile.cacheReadTokens, cacheCreationTokens: profile.cacheCreationTokens,
    };
    return {
      model,
      expectedUsd: Math.round(estimateCost(model, usage).usd * 10_000) / 10_000,
      measured: row && row.successRate !== null ? { attempts: row.attempts, successRate: row.successRate, evidence: row.evidence } : null,
    };
  }).sort((a, b) => a.expectedUsd - b.expectedUsd);

  const proven = candidates.filter((c) => c.measured && c.measured.evidence !== 'insufficient');
  if (!proven.length) {
    const cheapest = candidates.find((c) => !c.measured) ?? candidates[0] ?? null;
    return {
      role: input.role, basis: 'insufficient', recommend: null, trial: null, profile: input.profile, candidates, pricingNote,
      reason: `「${input.role}」の仕事は、どのモデルも判断できるだけの実績がありません（各 5 件以上必要）。` +
        `いま使っているモデルのままにして、実績をためてください。` +
        (cheapest ? `価格だけで見ると一番安いのは ${cheapest.model}（一件 約 $${cheapest.expectedUsd}）ですが、足りるかどうかは分かりません。` : ''),
    };
  }

  const best = Math.max(...proven.map((c) => c.measured!.successRate));
  const enough = proven.filter((c) => c.measured!.successRate >= Math.max(best - SUCCESS_MARGIN, SUCCESS_FLOOR));
  if (!enough.length) {
    return {
      role: input.role, basis: 'insufficient', recommend: null, trial: null, profile: input.profile, candidates, pricingNote,
      reason: `実績のあるモデルの成功率が、どれも ${Math.round(SUCCESS_FLOOR * 100)}% に届きません（最高 ${Math.round(best * 100)}%）。安さで選ぶ段階ではありません。`,
    };
  }
  const pick = enough[0]; // 一件あたりの費用が低い順に並んでいる
  const trial = candidates.find((c) => !c.measured && c.expectedUsd <= pick.expectedUsd * 0.7 && c.model !== pick.model) ?? null;
  return {
    role: input.role, basis: 'measured', recommend: pick.model, trial: trial?.model ?? null, profile: input.profile, candidates, pricingNote,
    reason: `${pick.model} は成功率 ${Math.round(pick.measured!.successRate * 100)}%（${pick.measured!.attempts} 件）で、` +
      `実績のある中で足りているうち一番安い（一件 約 $${pick.expectedUsd}）。` +
      (trial ? `実績は無いが ${trial.model} は約 $${trial.expectedUsd} と安く、数件だけ試す価値はあります（足りる証拠はまだ無い）。` : ''),
  };
}
