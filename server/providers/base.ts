import { Tool, ConversationTurn } from '../core/types.js';
import { TokenUsage } from '../core/usage.js';

/**
 * 模型に渡す前置き。**変わらない部分**と**呼ぶたびに変わる部分**を分けて持つ。
 *
 * 一つの文字列にしていたので、時刻や「◯秒前に観測」を含む状況の文が、
 * 固定の指示と同じ塊に入っていた。プロンプトキャッシュは前置きが一字でも
 * 違えば別物として扱うので、**毎回 2.6 万トークンを書き込み、一度も読めて
 * いなかった**（実測 2026-09-30：Sonnet 5 は書き込み 96.6 万・読み出し 1.4 万、
 * Haiku 4.5 は 66 万・0）。書き込みは入力の 1.25 倍なので、キャッシュを
 * 切っていた方が安かった（$5.17 に対して $4.32）。
 *
 * 分けて渡せば、キャッシュの区切りを固定部分だけに付けられる。区切りを
 * 付けられない提供者は `flattenSystem` で一つにする —— そのときも**固定部分を
 * 先に置く**ので、前方一致の自動キャッシュ（Gemini・OpenAI）にも効く。
 */
export interface SystemPrompt {
  stable: string;
  volatile: string;
}
export type SystemInput = string | SystemPrompt;

export function flattenSystem(system: SystemInput): string {
  if (typeof system === 'string') return system;
  return [system.stable, system.volatile].filter((s) => s && s.trim()).join('\n\n');
}

export interface AIProviderResponse {
  content: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    args: Record<string, any>;
    /** Opaque provider state to echo back on subsequent turns. */
    providerMetadata?: Record<string, any>;
  }>;
  /** Turn-level provider state (e.g. the raw content blocks to replay). */
  providerMetadata?: Record<string, any>;
  /** What this call actually consumed, when the provider reports it. */
  usage?: TokenUsage;
  /**
   * Which provider actually answered, when a router chose one.
   *
   * A run can span several calls and fail over part-way, so the model that
   * served a given call is a property of the call, not of the run. Cost is
   * attributed from these.
   */
  servedBy?: string;
  servedModel?: string;
}

export interface AIProvider {
  id: string;
  /**
   * Settings that change cost or quality, recorded alongside usage so a week
   * of data can answer "was a cheaper setting enough?" rather than just
   * "what did we spend?".
   */
  describeSettings?(): Record<string, string | number>;
  /**
   * Who trained the model. Two instances of the same vendor on different
   * models are a weaker form of independence than two vendors, and conflating
   * them would overstate how independent a review was.
   */
  vendor: string;
  name: string;
  currentModel: string;
  setModel(modelName: string): void;
  generateResponse(
    messages: ConversationTurn[],
    tools: Tool[],
    systemInstruction: SystemInput,
    /** Cancels the in-flight request when a timeout or run deadline fires. */
    signal?: AbortSignal,
    /**
     * Called with each piece of text as it arrives, when the provider can.
     *
     * Optional on both sides, which is what makes this safe to add to a router
     * that fails over between three vendors: a provider with no streaming
     * implementation calls this once at the end with the whole reply, so the
     * caller sees the same sequence of deltas either way and never has to ask
     * which kind it got. Streaming can then be implemented one vendor at a
     * time without a flag day.
     *
     * The deltas are the reply as it is being written. They are not the
     * return value — `content` is still the complete text, and anything that
     * needs the finished answer should use that.
     */
    onDelta?: (text: string) => void
  ): Promise<AIProviderResponse>;
}