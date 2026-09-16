import { Tool, RiskLevel, ToolTrust } from '../core/types.js';
import { AgentKind } from '../core/agent_runner.js';

/**
 * Handing work to a coding agent, from inside the conversation.
 *
 * Everything this needs already existed — worktree isolation, an environment
 * built rather than inherited, a spend meter, a stall detector, a review by a
 * second model — and none of it was reachable by asking. Launching was an HTTP
 * endpoint, so IRIS could write the task down and prepare the handoff and then
 * had to wait for someone to make the call itself. The machine worked and the
 * request "やっておいて" did not reach it.
 *
 * Task creation and launch are one call rather than two on purpose. Split
 * across `create_development_task` and a separate start, a person delegating
 * this still approves twice — and two approvals for one decision is the button
 * this was meant to remove. One call is one decision, which is also what a
 * grant can be scoped to.
 *
 * The risk level stays WRITE. A dispatch spends money and starts a
 * subprocess, and calling that READ to make it flow more easily would be a
 * lie told to the one mechanism that reads it. It runs without asking when the
 * user has granted it in advance, and asks otherwise.
 */

export interface DispatchOutcome {
  taskId: string;
  runId: string;
  branch: string;
  agent: AgentKind;
  /** Why that agent, so a routed dispatch can be corrected. */
  routedBecause?: string;
  repo: string;
}

export interface DispatchRefusal {
  refused: true;
  code: string;
  message: string;
}

export function createAgentDispatchTools(deps: {
  dispatch: (input: {
    title: string;
    goal: string;
    successCriteria: string[];
    constraints: string[];
    relevantFiles: string[];
    repo: string | null;
    /** Omitted means the allowance decides. */
    agent?: AgentKind;
    needsNetwork?: boolean;
  }) => Promise<DispatchOutcome | DispatchRefusal>;
  listRuns: () => Array<Record<string, unknown>>;
  /** The repositories a dispatch may target, for the description and errors. */
  allowedRepos: () => string[];
}): Tool[] {
  return [
    {
      name: 'start_coding_agent',
      description:
        'コーディングエージェント（Claude Code または Codex）に実装作業を任せます。' +
        'タスクの記録・引き継ぎ書の作成・エージェントの起動までを一度に行います。' +
        '作業は隔離された作業ツリーの中で行われ、成果は新しいブランチに commit されます。' +
        '本体のブランチには入りません（取り込みは利用者が行います）。' +
        'push はできません。',
      riskLevel: RiskLevel.WRITE,
      trust: ToolTrust.TRUSTED_CORE,
      schema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '短いタスク名。' },
          goal: {
            type: 'string',
            description:
              '達成したいことの説明。エージェントはこれと成功条件しか読みません。' +
              'この会話の文脈は伝わらないため、単体で意味が通るように書いてください。',
          },
          successCriteria: {
            type: 'array',
            items: { type: 'string' },
            description:
              '完了と判断できる条件。1つ以上必須。' +
              '検証できる形（テストが通る、コマンドが成功する等）で書いてください。',
          },
          constraints: {
            type: 'array',
            items: { type: 'string' },
            description: '守るべき制約。触ってはいけない場所など。',
          },
          relevantFiles: { type: 'array', items: { type: 'string' }, description: '関連ファイル。' },
          repo: {
            type: 'string',
            description: '対象リポジトリの絶対パス。省略時は既定のリポジトリ。',
          },
          needsNetwork: {
            type: 'boolean',
            description:
              'この作業に外向きの通信が要るか（依存関係の取得、公開ドキュメントの参照、API の疎通確認など）。' +
              'true なら claude に固定されます。Codex のシェルは既定で外に出られないためです。' +
              '（模型自身の web 道具はこれとは別で、砂場では止まりません。'
              + 'agent_runner.ts の attendedNetwork を参照。）',
          },
          agent: {
            type: 'string',
            enum: ['claude', 'codex'],
            description:
              'どちらに任せるか。省略すると、週の使用量が少ない方が選ばれます' +
              '（2種類のベンチマークでは得意分野の差が出なかったため、判断材料は使用量と通信可否のみ）。' +
              'codex が実行するコマンドは、既定ではネットワークに出られません' +
              '（seatbelt がソケットの bind ごと止めます。2026-08-22 実測: ' +
              'curl は HTTP 000/exit 6、ping は 100% loss、DNS は Operation not permitted）。' +
              '設定 sandbox_workspace_write.network_access で開けられますが、' +
              'IRIS は開けていません。依存関係の取得が必要な作業は claude へ。',
          },
        },
        required: ['title', 'goal', 'successCriteria'],
      },
      summarise(args: any) {
        const title = String(args?.title ?? '').trim() || '無題';
        const who = args?.agent === 'codex' ? 'Codex' : 'Claude Code';
        const count = Array.isArray(args?.successCriteria) ? args.successCriteria.length : 0;
        const where = typeof args?.repo === 'string' && args.repo
          ? `${args.repo.split('/').pop()} で`
          : '';
        return `${who} に「${title}」を${where}任せます。完了条件 ${count} 件。` +
          '成果は新しいブランチに残り、本体には自動では入りません。';
      },
      async execute(args: any) {
        const criteria = Array.isArray(args.successCriteria)
          ? args.successCriteria.filter((c: unknown) => typeof c === 'string' && c.trim())
          : [];

        /**
         * Refused here rather than passed down. An unattended agent with no
         * definition of done reports success by writing something plausible,
         * and there is nobody watching to disagree.
         */
        if (criteria.length === 0) {
          return {
            error: true,
            message:
              '成功条件が必要です。無人で実行されるため、完了を判断する基準がないと' +
              '「それらしい結果」を完了として報告することになります。',
          };
        }

        // Undefined rather than defaulted: "not stated" is what lets the
        // allowance decide, and coercing it here would make every dispatch
        // claim to have chosen Claude on purpose.
        const agent: AgentKind | undefined =
          args.agent === 'codex' ? 'codex' : args.agent === 'claude' ? 'claude' : undefined;

        const result = await deps.dispatch({
          title: String(args.title ?? '').trim() || '（無題）',
          goal: String(args.goal ?? ''),
          successCriteria: criteria,
          constraints: Array.isArray(args.constraints) ? args.constraints : [],
          relevantFiles: Array.isArray(args.relevantFiles) ? args.relevantFiles : [],
          repo: typeof args.repo === 'string' && args.repo.trim() ? args.repo.trim() : null,
          agent,
          needsNetwork: args.needsNetwork === true,
        });

        if ('refused' in result) {
          return {
            error: true,
            code: result.code,
            message: result.message,
            allowedRepos: deps.allowedRepos(),
          };
        }

        return {
          started: true,
          ...result,
          note:
            `${result.agent} が ${result.branch} で作業を始めました。` +
            '進捗は list_agent_runs で確認できます。' +
            '成果はブランチに残り、本体には自動では入りません。',
        };
      },
    },

    {
      name: 'list_agent_runs',
      description:
        'コーディングエージェントの実行状況を確認します。' +
        '実行中のもの、終わったもの、停止した理由と費用がわかります。',
      riskLevel: RiskLevel.READ,
      trust: ToolTrust.TRUSTED_CORE,
      schema: { type: 'object', properties: {} },
      async execute() {
        const runs = deps.listRuns();
        return {
          runs,
          count: runs.length,
          /**
           * Said every time. A branch that exists is not a change that
           * happened, and the gap between the two is where an agent's work
           * gets mistaken for done.
           */
          note: '成果はブランチにあります。本体に取り込むかどうかは利用者が決めます。',
        };
      },
    },
  ];
}
