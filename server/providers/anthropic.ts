import Anthropic from '@anthropic-ai/sdk';
import { AIProvider, AIProviderResponse } from './base.js';
import { Tool, ConversationTurn } from '../core/types.js';

/**
 * Anthropic provider, on the official SDK.
 *
 * The previous implementation hand-rolled fetch against a hardcoded
 * `claude-3-5-sonnet-20241022`, which was retired in October 2025 — so it would
 * have 404'd the moment a key was supplied. That is exactly the model-lifecycle
 * failure the handoff warns about, so the model id is now configurable and the
 * default is a current one.
 *
 * Adaptive thinking is on: IRIS orchestrates tools and multi-step work, which
 * is what it exists for. On Claude Opus 5 thinking is the default anyway.
 *
 * Prompt caching uses two breakpoints, because they serve different reuse:
 *
 *   1. after the system prompt — covers tools + system, which are byte-identical
 *      for every request IRIS ever makes, including the first turn of a brand
 *      new conversation. Measured traffic runs ~61:1 input to output, and this
 *      prefix is most of that input, so it is where the money is.
 *   2. auto-placed at the end of messages — covers the conversation so far, so a
 *      tool loop's second call reads what its first call just wrote, and each
 *      new turn reads the whole prior thread.
 *
 * Caching is a prefix match, so the prefix must be byte-stable: the system
 * instruction is a constant (no interpolated timestamp), and tools are sorted
 * by name so registration order can never reshuffle the prefix.
 */

export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5';

/** Effort controls depth and spend; `high` is the API default. */
export type AnthropicEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * この模型が adaptive thinking と effort を受け付けるか。
 *
 * **名前で判定する。**問い合わせる口はあるが、起動のたびに聞きに行くと
 * 繋がらない日に会話ごと止まる。Haiku 系だけが受け付けない、というのが
 * いまの事実で、増えたらここに足す。
 */
function supportsAdaptiveThinking(model: string): boolean {
  return !/haiku/i.test(model);
}

export class AnthropicProvider implements AIProvider {
  id = 'anthropic';
  vendor = 'anthropic';
  name = 'Anthropic Claude';
  currentModel: string;
  private client: Anthropic;
  private effort: AnthropicEffort;
  private maxTokens: number;
  private cacheEnabled: boolean;

  constructor(apiKey?: string, model: string = process.env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL) {
    const key = apiKey || process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error('ANTHROPIC_API_KEY が設定されていません。');
    // Retries are handled by the orchestrator's risk-aware policy, so the SDK's
    // own retry layer is disabled to avoid two independent backoffs stacking.
    this.client = new Anthropic({ apiKey: key, maxRetries: 0 });
    this.currentModel = model;
    this.effort = (process.env.ANTHROPIC_EFFORT as AnthropicEffort) || 'high';
    this.maxTokens = parseInt(process.env.ANTHROPIC_MAX_TOKENS || '16000', 10) || 16000;
    // On by default; ANTHROPIC_PROMPT_CACHE=off disables it for A/B measurement.
    this.cacheEnabled = (process.env.ANTHROPIC_PROMPT_CACHE || 'on').toLowerCase() !== 'off';
  }

  setModel(modelName: string) { this.currentModel = modelName; }

  describeSettings() {
    return { effort: this.effort, maxTokens: this.maxTokens, promptCache: this.cacheEnabled ? 'on' : 'off' };
  }

  async generateResponse(
    messages: ConversationTurn[],
    tools: Tool[],
    systemInstruction: string,
    signal?: AbortSignal
  ): Promise<AIProviderResponse> {
    // Sorted so the rendered prefix cannot change if registration order does.
    const formattedTools = [...tools]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.schema as any,
      }));

    const formattedMessages: Anthropic.MessageParam[] = [];
    for (const m of messages) {
      if (m.role === 'user') {
        formattedMessages.push({ role: 'user', content: m.content || '' });
      } else if (m.role === 'assistant') {
        // Replay the assistant turn's original content blocks verbatim when we
        // have them. Thinking blocks must come back unchanged on the same
        // model, and reconstructing them from text would corrupt the turn.
        const replay = m.providerMetadata?.anthropicContent;
        if (Array.isArray(replay) && replay.length > 0) {
          formattedMessages.push({ role: 'assistant', content: replay });
          continue;
        }

        const blocks: any[] = [];
        if (m.content) blocks.push({ type: 'text', text: m.content });
        if (m.toolCalls) {
          for (const tc of m.toolCalls) {
            blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args });
          }
        }
        formattedMessages.push({
          role: 'assistant',
          content: blocks.length > 0 ? blocks : (m.content || ''),
        });
      } else if (m.role === 'tool') {
        formattedMessages.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: m.toolCallId || 'tool',
              content: JSON.stringify(m.toolResult ?? {}),
            },
          ],
        });
      }
    }

    const message = await this.client.messages.create(
      {
        model: this.currentModel,
        // Breakpoint 1: tools render before system, so marking the last system
        // block caches both together.
        system: [
          {
            type: 'text',
            text: systemInstruction,
            ...(this.cacheEnabled ? { cache_control: { type: 'ephemeral' } } : {}),
          },
        ],
        max_tokens: this.maxTokens,
        /*
         * 思考と effort は、対応している模型にだけ送る。
         *
         * Haiku 4.5 は adaptive thinking も `output_config.effort` も受け付けず、
         * **400 を返す**（実測 2026-09-11、声の列を Haiku に向けた初回：
         * `adaptive thinking is not supported on this model`）。無条件に送って
         * いたのは、これまで Sonnet と Opus しか繋いでいなかったから。
         *
         * 速い列で思考を落とすのは妥協ではない。**声の返事に長考は要らない**
         * ので、対応していてもここでは切る判断はありえた。いまは能力に従う。
         */
        ...(supportsAdaptiveThinking(this.currentModel)
          ? { thinking: { type: 'adaptive' }, output_config: { effort: this.effort } }
          : {}),
        messages: formattedMessages,
        ...(formattedTools.length > 0 ? { tools: formattedTools } : {}),
        // Breakpoint 2: auto-placed on the last cacheable block, so the growing
        // conversation accrues hits. Auto-placement rather than manual, because
        // a replayed assistant turn can end in a block type that cannot carry
        // cache_control.
        ...(this.cacheEnabled ? { cache_control: { type: 'ephemeral' } } : {}),
      } as any,
      { signal }
    );

    // Safety classifiers can decline a request: HTTP 200, empty or partial
    // content. Reading content[0] unconditionally would break here.
    if (message.stop_reason === 'refusal') {
      const category = (message as any).stop_details?.category ?? 'unknown';
      const error = new Error(
        `モデルが安全上の理由でこの要求を拒否しました (${category})。`
      ) as Error & { refusal?: boolean };
      error.refusal = true;
      throw error;
    }

    let textContent = '';
    const toolCalls: any[] = [];

    for (const block of message.content) {
      if (block.type === 'text') textContent += block.text;
      if (block.type === 'tool_use') {
        toolCalls.push({ id: block.id, name: block.name, args: block.input || {} });
      }
    }

    return {
      content: textContent,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      // Kept so the next turn can replay this turn's blocks unchanged.
      providerMetadata: { anthropicContent: message.content },
      usage: {
        inputTokens: message.usage.input_tokens ?? 0,
        outputTokens: message.usage.output_tokens ?? 0,
        cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
        cacheCreationTokens: message.usage.cache_creation_input_tokens ?? 0,
      },
    };
  }
}
