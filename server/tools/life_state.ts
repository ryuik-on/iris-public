import { Tool, RiskLevel, ToolTrust } from '../core/types.js';
import { LifeStateService, renderLifeState, describeAge } from '../core/life_state.js';

/**
 * The present, reachable from inside a conversation.
 *
 * This is the whole reason the layer exists. IRIS already assembled a view of
 * now — the Context Engine has done it since it was built — but the only
 * consumer was the proactive service, so in a conversation the model could
 * see a clock and its long-term memory and nothing between them.
 *
 * READ, and trusted core. It reads three in-process stores and calls nothing
 * outward; there is no network, no cost, and nothing to approve. It writes
 * nothing, so calling it twice is the same as calling it once.
 *
 * One tool rather than three. `get_current_time`, a calendar reader and a
 * presence reader would let the model assemble the present itself, which means
 * assembling it differently each time and dropping whichever part it did not
 * think to ask for — most likely `unknown`, which is the part that keeps
 * silence from reading as a negative.
 */
export function createLifeStateTools(lifeState: LifeStateService): Tool[] {
  return [
    {
      name: 'get_current_state',
      description:
        '今何が真かを1つにまとめて返します。現在時刻、観測されている状況（在室・直近の発話・次の予定など。' +
        '各項目に観測源・鮮度・確度が付きます）、それを補う恒久的な記憶を含みます。' +
        'unknown は「いいえ」ではなく「報告がない、または古すぎる」という意味です。' +
        '日付・予定・状況に依存する判断の前に使用してください。get_current_time より上位で、時刻も含みます。',
      riskLevel: RiskLevel.READ,
      trust: ToolTrust.TRUSTED_CORE,
      schema: {
        type: 'object',
        properties: {
          format: {
            type: 'string',
            enum: ['structured', 'text'],
            description: '省略時は structured。text は人間が読む形の1つの文字列を返します。',
          },
        },
      },
      async execute(args: any) {
        const state = lifeState.current();

        if (args?.format === 'text') {
          return { text: renderLifeState(state) };
        }

        return {
          clock: state.clock,
          // Ages are rendered alongside the raw number rather than instead of
          // it. The model reasons better about "42分前" than about 2520000,
          // and something downstream may still want to compare.
          present: state.present.map((f) => ({
            kind: f.kind,
            value: f.value,
            source: f.sourceLabel,
            confidence: f.confidence,
            band: f.band,
            calibrated: f.calibrated,
            observedAt: f.observedAt,
            age: describeAge(f.ageMs),
            ageMs: f.ageMs,
            decayed: f.decayed,
            evidence: f.evidence,
            disagreement: f.disagreement,
          })),
          unknown: state.unknown,
          unknownMeans: '報告がないか、報告が古すぎて現在について何も言えない状態です。「いいえ」ではありません。',
          standing: state.standing.map((m) => ({
            content: m.content,
            provenance: m.provenance,
            source: m.source,
            confidence: m.confidence,
          })),
          withheld: state.withheld,
          quiet: state.quiet,
          sources: state.sources,
        };
      },
    },
  ];
}
