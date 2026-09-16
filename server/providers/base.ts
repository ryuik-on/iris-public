import { Tool, ConversationTurn } from '../core/types.js';
import { TokenUsage } from '../core/usage.js';

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
    systemInstruction: string,
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