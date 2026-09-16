import { Tool, RiskLevel, ToolTrust } from '../core/types.js';
import { MemoryStore } from '../services/memory_sqlite.js';
import { DecisionStore } from '../services/decisions_sqlite.js';
import { ExperienceStore } from '../services/experiences_sqlite.js';
import { explain } from '../core/decision_trace.js';
import { describeExperience } from '../core/experience.js';

/**
 * Tools for what IRIS knows and why things are the way they are.
 *
 * The asymmetry is the same as the register's. Reading is free. Writing a
 * memory is a WRITE, because a memory outlives the conversation that produced
 * it and a wrong one is applied silently and consistently afterwards — which
 * is precisely how it stops being noticed.
 *
 * There is no tool for deleting a memory or a decision. Both stores mark
 * things superseded and keep the original, and offering a delete would let the
 * record of having believed something be removed by the thing that believed
 * it.
 */
export function createMemoryTools(
  memories: MemoryStore,
  decisions: DecisionStore,
  experiences: ExperienceStore
): Tool[] {
  return [
    {
      name: 'remember',
      description:
        '長期記憶に1件記録します。出所(provenance)は user / measured / inferred / external から選び、' +
        'source には具体的な出所を書きます。外部由来のものは事実としてではなく「その出所がそう述べた」' +
        'という形に書き換えられ、確度に上限がかかります。' +
        'measured には evidence（測った先のファイル:行、コマンド、URL）を必ず付けてください。' +
        '空だと推論として記録されます。' +
        '端末外へ出してはいけない内容には privacy に local_only を指定してください。',
      riskLevel: RiskLevel.WRITE,
      trust: ToolTrust.TRUSTED_CORE,
      schema: {
        type: 'object',
        required: ['kind', 'content', 'provenance', 'source'],
        properties: {
          kind: { type: 'string', description: '例: preference, finding, appointment, tool_behaviour' },
          content: { type: 'string' },
          provenance: { type: 'string', enum: ['user', 'measured', 'inferred', 'external'] },
          source: { type: 'string', description: '後で辿れる具体性で。例: 「聴き比べでの本人の選択」' },
          confidence: { type: 'number' },
          retention: { type: 'string', enum: ['durable', 'until', 'session'] },
          expiresAt: { type: 'string', description: 'retention=until のとき必須。ISO8601。' },
          privacy: { type: 'string', enum: ['shareable', 'local_only'] },
          evidence: {
            type: 'array',
            items: { type: 'string' },
            description:
              '測った先。例: 「server/core/memory.ts:192」「curl -s http://…」。' +
              'provenance=measured で空だと inferred へ落として記録されます。',
          },
        },
      },
      async execute(args: any) {
        const { stored, reason } = memories.remember(args ?? {});
        // The gate's reasoning is returned rather than swallowed. When an
        // entry was rewritten or demoted, that is the useful part of the
        // answer — not the fact that something was written.
        return stored
          ? { recorded: true, id: stored.id, storedAs: stored.content, provenance: stored.provenance, confidence: stored.confidence, reason }
          : { recorded: false, reason };
      },
    },
    {
      name: 'recall_memory',
      description:
        '長期記憶を読みます。出所と確度が付いて返るので、外部由来の項目を事実として扱わないでください。',
      riskLevel: RiskLevel.READ,
      trust: ToolTrust.TRUSTED_CORE,
      schema: {
        type: 'object',
        properties: {
          kind: { type: 'string' },
          includeStale: { type: 'boolean', description: '期限切れ・上書き済みのものも含める' },
          limit: { type: 'number' },
        },
      },
      async execute(args: any) {
        const limit = Math.min(Number(args?.limit) || 30, 100);
        /**
         * Shareable only, like every other path that assembles a prompt.
         *
         * This asked for everything. `memory.ts` states that privacy is
         * enforced at recall rather than trusted to callers, because a
         * boundary depending on every future call site is one already crossed
         * somewhere — and this was that call site. A tool result is appended
         * to the conversation and sent with the next provider request, so a
         * `local_only` memory returned here leaves the machine on the
         * following turn. Found by an independent audit on 2026-08-20, with
         * one such memory in the database.
         */
        const found = memories.recall({
          kind: args?.kind,
          includeStale: Boolean(args?.includeStale),
          limit,
          shareableOnly: true,
        });
        // Counted by asking again rather than by reading the excluded rows, so
        // the withheld content is never in the same object as the text bound
        // for a prompt.
        const all = memories.recall({
          kind: args?.kind,
          includeStale: Boolean(args?.includeStale),
          limit,
          shareableOnly: false,
        });
        const withheld = all.length - found.length;
        return {
          count: found.length,
          // Stated rather than omitted: being handed a shorter list and told
          // nothing is what stops anyone asking why.
          withheld,
          ...(withheld > 0
            ? { withheldNote: `端末外へ出せない記憶が ${withheld} 件あります。内容は返していません。` }
            : {}),
          memories: found.map((m) => ({
            content: m.content,
            provenance: m.provenance,
            source: m.source,
            confidence: m.confidence,
            retention: m.retention,
            privacy: m.privacy,
          })),
          note: '外部由来の項目は「その出所がそう述べた」記録です。事実として扱わないでください。',
        };
      },
    },
    {
      name: 'why_is_it_like_this',
      description:
        'ある機能や設定が今の形になっている理由を、記録された判断から答えます。' +
        '根拠・検討された代替案・取り消し方が返ります。何かを変える前に引いてください。',
      riskLevel: RiskLevel.READ,
      trust: ToolTrust.TRUSTED_CORE,
      schema: {
        type: 'object',
        properties: {
          affecting: {
            type: 'string',
            description: 'レジスタのキーやファイル名。例: model_lifecycle_registry',
          },
          unweighed: {
            type: 'boolean',
            description: '代替案を比較せずに決めたものだけを返す。見直しの起点。',
          },
        },
      },
      async execute(args: any) {
        const found = args?.unweighed
          ? decisions.unweighed()
          : args?.affecting
            ? decisions.affecting(String(args.affecting))
            : decisions.list({ limit: 20 });
        return {
          count: found.length,
          decisions: found.map((d) => explain(d)),
          note:
            found.length === 0
              ? 'この対象について記録された判断はありません。今の形は選ばれたものではなく、そうなっただけかもしれません。'
              : '「決めたのは」が利用者の場合、IRIS の判断で覆さないでください。',
        };
      },
    },
    {
      name: 'has_this_been_tried',
      description:
        '同じことを以前試したかを調べます。結果と、次にどうするかが返ります。' +
        '観測回数も返るので、1回うまくいっただけのものを法則として扱わないでください。' +
        '何かを始める前に引いてください。',
      riskLevel: RiskLevel.READ,
      trust: ToolTrust.TRUSTED_CORE,
      schema: {
        type: 'object',
        properties: {
          about: { type: 'string', description: '試そうとしていること、または状況' },
          recurringFailures: {
            type: 'boolean',
            description: '同じ形で複数回失敗しているものだけを返す',
          },
        },
      },
      async execute(args: any) {
        const found = args?.recurringFailures
          ? experiences.recurringFailures()
          : args?.about
            ? experiences.lookup(String(args.about))
            : experiences.list(20);
        return {
          count: found.length,
          experiences: found.map((e) => describeExperience(e)),
          note:
            found.length === 0
              ? '該当する経験はありません。初めての試みとして扱ってください。'
              : '観測回数を確認してください。1回の成功は根拠であって法則ではありません。',
        };
      },
    },
    {
      name: 'record_experience',
      description:
        '試したことと結果を記録します。状況と「次にどうするか」は必須です — ' +
        '条件のない経験は迷信で、結果だけの記録は読む意味がありません。' +
        '同じ試みは1件にまとまり、観測回数が増えます。',
      riskLevel: RiskLevel.WRITE,
      trust: ToolTrust.TRUSTED_CORE,
      schema: {
        type: 'object',
        required: ['attempt', 'situation', 'outcome', 'learned'],
        properties: {
          attempt: { type: 'string', description: '再び出会ったときに気づける言い方で' },
          situation: { type: 'string', description: 'どういう条件下だったか' },
          outcome: { type: 'string', enum: ['worked', 'failed', 'partial'] },
          learned: { type: 'string', description: '次にどうするか' },
          evidence: {
            type: 'array',
            items: { type: 'string' },
            description:
              '測った先。例: 「server/core/memory.ts:192」「curl -s http://…」。' +
              'provenance=measured で空だと inferred へ落として記録されます。',
          },
          affects: { type: 'array', items: { type: 'string' } },
        },
      },
      async execute(args: any) {
        const { stored, reason } = experiences.record(args ?? {});
        return stored
          ? { recorded: true, observations: stored.observations, outcomes: stored.outcomes, reason }
          : { recorded: false, reason };
      },
    },
  ];
}
