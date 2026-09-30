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
export type OpenAIAPIMode = 'chat-completions' | 'responses';

export class OpenAIProvider implements AIProvider {
  id = 'openai';
  vendor = 'openai';
  name = 'OpenAI';
  currentModel: string;
  private client: OpenAI;
  private maxTokens: number;
  private apiMode: OpenAIAPIMode;

  constructor(
    apiKey?: string,
    model: string = process.env.OPENAI_MODEL || process.env.REVIEW_PRIMARY_MODEL || DEFAULT_OPENAI_MODEL,
    options: { api?: OpenAIAPIMode } = {}
  ) {
    const key = apiKey || process.env.OPENAI_API_KEY;
    if (!key) throw new Error('OPENAI_API_KEY が設定されていません。');
    // The orchestrator owns retries; a second backoff layer would stack.
    this.client = new OpenAI({ apiKey: key, maxRetries: 0 });
    this.currentModel = model;
    this.maxTokens = parseInt(process.env.OPENAI_MAX_TOKENS || '16000', 10) || 16000;
    const apiMode = options.api ?? process.env.OPENAI_API_MODE ?? 'chat-completions';
    if (apiMode !== 'responses' && apiMode !== 'chat-completions') {
      throw new Error(`OPENAI_API_MODE は responses または chat-completions を指定してください: ${apiMode}`);
    }
    this.apiMode = apiMode;
  }

  setModel(modelName: string) { this.currentModel = modelName; }

  describeSettings() {
    return { maxTokens: this.maxTokens, api: this.apiMode };
  }

  async generateResponse(
    messages: ConversationTurn[],
    tools: Tool[],
    systemInstruction: SystemInput,
    signal?: AbortSignal,
    onDelta?: (text: string) => void
  ): Promise<AIProviderResponse> {
    const model = this.currentModel;
    if (this.apiMode === 'responses') {
      return this.generateResponsesResponse(model, messages, tools, systemInstruction, signal, onDelta);
    }
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

  private async generateResponsesResponse(
    model: string,
    messages: ConversationTurn[],
    tools: Tool[],
    systemInstruction: SystemInput,
    signal?: AbortSignal,
    onDelta?: (text: string) => void
  ): Promise<AIProviderResponse> {
    const input: any[] = [];
    for (const message of messages) {
      if (message.role === 'user') {
        input.push({ role: 'user', content: message.content || '' });
      } else if (message.role === 'assistant') {
        const replay = message.providerMetadata?.openaiResponses;
        if (replay?.model === model && Array.isArray(replay.output)) {
          input.push(...replay.output);
        } else {
          if (message.content) input.push({ role: 'assistant', content: message.content });
          for (const call of message.toolCalls ?? []) {
            input.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.args ?? {}) });
          }
        }
      } else if (message.role === 'tool') {
        if (!message.toolCallId) throw new Error('Responses API のtool履歴に call_id がありません。');
        input.push({
          type: 'function_call_output',
          call_id: message.toolCallId,
          output: JSON.stringify(message.toolResult ?? {}),
        });
      }
    }

    const response = await this.client.responses.create(
      {
        model,
        instructions: flattenSystem(systemInstruction),
        input,
        max_output_tokens: this.maxTokens,
        store: false,
        include: ['reasoning.encrypted_content'],
        ...(tools.length ? {
          tools: [...tools].sort((a, b) => a.name.localeCompare(b.name)).map((tool) => ({
            type: 'function' as const,
            name: tool.name,
            description: tool.description,
            parameters: tool.schema as any,
            strict: false,
          })),
        } : {}),
      },
      { signal }
    );

    if (response.status !== 'completed') {
      const detail = response.incomplete_details?.reason ?? response.error?.message ?? response.status;
      throw new Error(`OpenAI Responses API が完了しませんでした (${detail})`);
    }
    const toolCalls = response.output.filter((item: any) => item.type === 'function_call').map((item: any) => {
      if (typeof item.call_id !== 'string' || typeof item.name !== 'string') {
        throw new Error('OpenAI Responses API が不正なfunction callを返しました。');
      }
      return { id: item.call_id, name: item.name, args: parseResponseArguments(item.arguments) };
    });
    const usage: any = response.usage;
    const cachedTokens = usage?.input_tokens_details?.cached_tokens ?? 0;
    const cacheWriteTokens = usage?.input_tokens_details?.cache_write_tokens ?? 0;
    const outputText = response.output_text || response.output.flatMap((item: any) =>
      item.type === 'message' ? (item.content ?? []).filter((part: any) => part.type === 'output_text').map((part: any) => part.text) : []
    ).join('');
    const refusal = response.output.flatMap((item: any) => item.type === 'message' ? item.content ?? [] : [])
      .find((item: any) => item.type === 'refusal')?.refusal;
    const content = outputText || refusal || '';
    if (content) onDelta?.(content);
    return {
      content,
      toolCalls: toolCalls.length ? toolCalls : undefined,
      providerMetadata: { openaiResponses: { model, output: response.output } },
      usage: usage ? {
        inputTokens: Math.max(0, usage.input_tokens - cachedTokens - cacheWriteTokens),
        outputTokens: usage.output_tokens,
        cacheReadTokens: cachedTokens,
        cacheCreationTokens: cacheWriteTokens,
        thinkingTokens: usage.output_tokens_details?.reasoning_tokens ?? 0,
      } : undefined,
    };
  }
}

function parseResponseArguments(raw: unknown): Record<string, any> {
  if (typeof raw !== 'string') throw new Error('OpenAI Responses API が不正なtool argumentsを返しました。');
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('OpenAI Responses API が不正なJSON tool argumentsを返しました。'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('OpenAI Responses API のtool argumentsはJSON objectである必要があります。');
  }
  return parsed as Record<string, any>;
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
