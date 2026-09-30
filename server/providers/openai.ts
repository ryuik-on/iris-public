import OpenAI from 'openai';
import { AIProvider, AIProviderResponse, SystemInput, flattenSystem } from './base.js';
import { Tool, ConversationTurn } from '../core/types.js';

/**
 * OpenAI provider.
 *
 * Exists primarily so review can be genuinely independent: a model reviewing
 * its own work is not a second opinion. The model id is configurable rather
 * than baked in, for the same reason the Anthropic one is — a hardcoded id
 * rots silently and only fails once someone supplies a key.
 */

export const DEFAULT_OPENAI_MODEL = 'gpt-4o';

export class OpenAIProvider implements AIProvider {
  id = 'openai';
  vendor = 'openai';
  name = 'OpenAI';
  currentModel: string;
  private client: OpenAI;
  private maxTokens: number;

  constructor(
    apiKey?: string,
    model: string = process.env.OPENAI_MODEL || process.env.REVIEW_PRIMARY_MODEL || DEFAULT_OPENAI_MODEL
  ) {
    const key = apiKey || process.env.OPENAI_API_KEY;
    if (!key) throw new Error('OPENAI_API_KEY が設定されていません。');
    // The orchestrator owns retries; a second backoff layer would stack.
    this.client = new OpenAI({ apiKey: key, maxRetries: 0 });
    this.currentModel = model;
    this.maxTokens = parseInt(process.env.OPENAI_MAX_TOKENS || '16000', 10) || 16000;
  }

  setModel(modelName: string) { this.currentModel = modelName; }

  describeSettings() {
    return { maxTokens: this.maxTokens };
  }

  async generateResponse(
    messages: ConversationTurn[],
    tools: Tool[],
    systemInstruction: SystemInput,
    signal?: AbortSignal,
    onDelta?: (text: string) => void
  ): Promise<AIProviderResponse> {
    const formatted: any[] = [{ role: 'system', content: flattenSystem(systemInstruction) }];

    for (const m of messages) {
      if (m.role === 'user') {
        formatted.push({ role: 'user', content: m.content || '' });
      } else if (m.role === 'assistant') {
        const entry: any = { role: 'assistant', content: m.content || null };
        if (m.toolCalls?.length) {
          entry.tool_calls = m.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: JSON.stringify(tc.args ?? {}) },
          }));
        }
        formatted.push(entry);
      } else if (m.role === 'tool') {
        formatted.push({
          role: 'tool',
          tool_call_id: m.toolCallId || 'tool',
          content: JSON.stringify(m.toolResult ?? {}),
        });
      }
    }

    const response = await this.client.chat.completions.create(
      {
        model: this.currentModel,
        messages: formatted,
        max_completion_tokens: this.maxTokens,
        ...(tools.length > 0
          ? {
              tools: [...tools]
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((t) => ({
                  type: 'function' as const,
                  function: { name: t.name, description: t.description, parameters: t.schema as any },
                })),
            }
          : {}),
      },
      { signal }
    );

    const choice = response.choices[0];
    const toolCalls = (choice?.message?.tool_calls ?? []).map((tc: any) => ({
      id: tc.id,
      name: tc.function?.name,
      // OpenAI returns arguments as a JSON string; a malformed one must not
      // take down the run, so it surfaces as an argument the tool will reject.
      args: parseArguments(tc.function?.arguments),
    }));

    const usage = response.usage;
    return {
      content: choice?.message?.content ?? '',
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: usage
        ? {
            inputTokens: Math.max(
              0,
              (usage.prompt_tokens ?? 0) - ((usage as any).prompt_tokens_details?.cached_tokens ?? 0)
            ),
            outputTokens: usage.completion_tokens ?? 0,
            cacheReadTokens: (usage as any).prompt_tokens_details?.cached_tokens ?? 0,
            thinkingTokens: (usage as any).completion_tokens_details?.reasoning_tokens ?? 0,
          }
        : undefined,
    };
  }
}

function parseArguments(raw: unknown): Record<string, any> {
  if (typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return { _unparsedArguments: raw };
  }
}
