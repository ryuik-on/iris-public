import { GoogleGenAI } from '@google/genai';
import { AIProvider, AIProviderResponse } from './base.js';
import { Tool, ConversationTurn } from '../core/types.js';
import { toGeminiSchema } from './gemini_schema.js';

export class GeminiProvider implements AIProvider {
  id = 'gemini';
  vendor = 'gemini';
  name = 'Google Gemini';
  currentModel: string;
  private ai: GoogleGenAI;

  /**
   * Reports tools that could not be sent, and what was stripped from the rest.
   *
   * Optional so nothing else has to change to construct one, but the server
   * passes it: a tool disappearing from the model's reach with no trace is the
   * failure this whole conversion exists to stop being silent.
   */
  private onEvent?: (event: { type: string; detail?: Record<string, any> }) => void;

  /** Warned about once per tool, not once per message. */
  private warned = new Set<string>();

  constructor(
    apiKey?: string,
    model: string = 'gemini-3.6-flash',
    onEvent?: (event: { type: string; detail?: Record<string, any> }) => void
  ) {
    const key = apiKey || process.env.GEMINI_API_KEY;
    if (!key) throw new Error('GEMINI_API_KEY が設定されていません。');
    this.ai = new GoogleGenAI({ apiKey: key });
    this.currentModel = model;
    this.onEvent = onEvent;
  }

  setModel(modelName: string) { this.currentModel = modelName; }

  async generateResponse(messages: ConversationTurn[], tools: Tool[], systemInstruction: string, signal?: AbortSignal, onDelta?: (text: string) => void): Promise<AIProviderResponse> {
    /**
     * Schemas are rewritten rather than passed through.
     *
     * Gemini takes an OpenAPI subset and rejects the *entire request* on the
     * first key it does not recognise — so one MCP tool carrying `$ref` or a
     * vendor extension used to make IRIS unable to answer at all, rather than
     * making that one tool unavailable. Anything that cannot be converted is
     * left out by name instead of taking the conversation with it.
     */
    const functionDeclarations: any[] = [];
    const skipped: Array<{ name: string; reason: string }> = [];

    for (const t of tools) {
      const converted = toGeminiSchema(t.schema);
      if (!converted.ok) {
        skipped.push({ name: t.name, reason: converted.reason ?? '変換できません。' });
        continue;
      }
      if (converted.removed.length > 0 && !this.warned.has(t.name)) {
        this.warned.add(t.name);
        this.onEvent?.({
          type: 'gemini.schema_reduced',
          detail: { tool: t.name, removed: converted.removed },
        });
      }
      functionDeclarations.push({
        name: t.name,
        description: t.description,
        parameters: converted.schema,
      });
    }

    if (skipped.length > 0) {
      // Every message, not once: a tool the model cannot reach is a standing
      // condition, and a single startup line is easy to have scrolled past.
      this.onEvent?.({
        type: 'gemini.tools_skipped',
        detail: { tools: skipped.map((s) => `${s.name}: ${s.reason}`) },
      });
    }

    const contents: any[] = messages.map((m) => {
      if (m.role === 'user') return { role: 'user', parts: [{ text: m.content || '' }] };
      if (m.role === 'assistant') {
        const parts: any[] = [];
        if (m.content) parts.push({ text: m.content });
        if (m.toolCalls) {
          /**
           * Every functionCall part needs a thought signature, not just the
           * ones that were issued with one.
           *
           * Gemini attaches the signature to the part that follows its
           * thinking, which for a turn that called several tools is the first
           * one. Sending the rest back bare is rejected outright — measured on
           * 2026-08-21: `400 INVALID_ARGUMENT`, "Function call is missing a
           * thought_signature ... position 2".
           *
           * It only showed up after an approval. An ordinary turn sends the
           * calls and never replays them; a turn that stopped for a person is
           * rebuilt from history and sent again, which is the only path where
           * the missing signatures are ever transmitted.
           *
           * So the turn's own signature stands in for the calls that lack one.
           * It belongs to the same block of thinking that produced all of them,
           * which is what the field is describing.
           */
          const fallback =
            m.providerMetadata?.thoughtSignature ??
            m.toolCalls.find((tc: any) => tc.providerMetadata?.thoughtSignature)
              ?.providerMetadata?.thoughtSignature;

          /**
           * History another provider wrote cannot be replayed as tool calls.
           *
           * The signatures are Gemini's own and nobody else issues them. A
           * conversation that ran on Anthropic and is resumed on Gemini — which
           * is what an approval saved days ago and answered today actually is —
           * has none, and no fallback can invent one. Sending the calls bare is
           * refused outright: measured on 2026-08-21, `400 INVALID_ARGUMENT`,
           * and the stored turn's metadata turned out to hold an
           * `anthropicContent` thinking block, not a thought signature.
           *
           * So the exchange is replayed as what it was rather than as what it
           * cannot be. The model is told, in text, which tools ran — enough to
           * follow the conversation, and honest about being a retelling. The
           * alternative is an approval that can never be granted once the
           * provider has changed, which is a decision lost to a routing detail.
           */
          const replayable = m.toolCalls.every(
            (tc: any) => tc.providerMetadata?.thoughtSignature || fallback
          );

          if (replayable) {
            for (const tc of m.toolCalls) {
              const part: any = { functionCall: { name: tc.name, args: tc.args } };
              const signature = tc.providerMetadata?.thoughtSignature ?? fallback;
              if (signature) part.thoughtSignature = signature;
              parts.push(part);
            }
          } else {
            const named = m.toolCalls.map((tc: any) => tc.name).join('、');
            parts.push({ text: `（この時点で ${named} を実行しました）` });
          }
        }
        return { role: 'model', parts };
      }
      if (m.role === 'tool') {
        /**
         * A result whose call was retold as text has to be retold too.
         *
         * Gemini pairs a `functionResponse` with the `functionCall` before it;
         * one without the other is an unmatched response and is rejected just
         * as firmly as a missing signature was.
         */
        const call = messages.find(
          (other) =>
            other.role === 'assistant' &&
            other.toolCalls?.some((tc: any) => tc.id === m.toolCallId)
        );
        const spoken =
          call &&
          !call.toolCalls?.every(
            (tc: any) =>
              tc.providerMetadata?.thoughtSignature ||
              call.providerMetadata?.thoughtSignature
          );
        if (spoken) {
          return {
            role: 'user',
            parts: [{ text: `（${m.toolName ?? 'tool'} の結果: ${JSON.stringify(m.toolResult ?? {}).slice(0, 800)}）` }],
          };
        }
        return { role: 'user', parts: [{ functionResponse: { name: m.toolName || 'tool', response: m.toolResult || {} } }] };
      }
      return { role: 'user', parts: [{ text: m.content || '' }] };
    });

    const request = {
      model: this.currentModel,
      contents,
      config: {
        systemInstruction: { parts: [{ text: systemInstruction }] },
        tools: functionDeclarations.length > 0 ? [{ functionDeclarations }] : undefined,
        // The SDK honours this, so a timeout cancels the HTTP request rather
        // than leaving it running and billable in the background.
        abortSignal: signal,
      },
    };

    /**
     * Streamed only when someone is listening.
     *
     * A run with no `onDelta` takes the single-response path it always took.
     * Both paths end at the same place — the parts of the final candidate —
     * and everything after this point is shared, so there is one place where
     * tool calls and usage are read out of a response rather than two that
     * have to agree.
     */
    let response: any;
    if (onDelta) {
      const stream = await this.ai.models.generateContentStream(request);
      const merged: any[] = [];
      let meta: any;
      for await (const chunk of stream as any) {
        const chunkParts = chunk?.candidates?.[0]?.content?.parts;
        if (Array.isArray(chunkParts)) {
          for (const part of chunkParts) {
            merged.push(part);
            // Thoughts are internal. Only text meant for the reader goes out.
            if (part?.text && !part?.thought) onDelta(part.text);
          }
        }
        // Totals are cumulative; only the last chunk's are complete.
        if (chunk?.usageMetadata) meta = chunk.usageMetadata;
      }
      response = { candidates: [{ content: { parts: merged } }], usageMetadata: meta };
    } else {
      response = await this.ai.models.generateContent(request);
    }

    const candidate = response.candidates?.[0];
    const parts = candidate?.content?.parts || [];
    let textContent = '';
    const toolCalls: any[] = [];

    for (const part of parts) {
      if (part.text) textContent += part.text;
      if (part.functionCall) {
        toolCalls.push({
          id: Math.random().toString(36).substring(2, 9),
          name: part.functionCall.name,
          args: (part.functionCall.args as any) || {},
          providerMetadata: part.thoughtSignature
            ? { thoughtSignature: part.thoughtSignature }
            : undefined,
        });
      }
    }

    const meta = (response as any).usageMetadata;
    return {
      content: textContent,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      // Gemini's promptTokenCount includes cached content, while Anthropic's
      // input_tokens excludes it. Normalise to the Anthropic convention —
      // input = uncached remainder — so usage from the two is summable.
      usage: meta
        ? {
            inputTokens: Math.max(
              0,
              (meta.promptTokenCount ?? 0) - (meta.cachedContentTokenCount ?? 0)
            ),
            // Thinking is billed at the output rate, and Gemini reports it
            // outside candidatesTokenCount — a turn measured on 2026-08-20 was
            // 17 output against 587 thinking. Anthropic and OpenAI both fold
            // theirs into the output count, so folding it here is the same
            // normalisation the input line above performs: without it the cost
            // of that turn would have been reported at a thirty-fifth of what
            // it was, and reported confidently.
            outputTokens: (meta.candidatesTokenCount ?? 0) + (meta.thoughtsTokenCount ?? 0),
            cacheReadTokens: meta.cachedContentTokenCount ?? 0,
            // Kept as the breakdown of the line above, not as an addition to it.
            thinkingTokens: meta.thoughtsTokenCount ?? 0,
          }
        : undefined,
    };
  }
}
