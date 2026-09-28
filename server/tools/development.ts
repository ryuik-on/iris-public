import { Tool, RiskLevel, ToolTrust } from '../core/types.js';
import { DevelopmentService } from '../core/development_service.js';
import { RunRole } from '../services/dev_tasks_sqlite.js';

/**
 * Development-orchestration tools, so tasks and handoffs are reachable from the
 * conversation the user is already in rather than only through the API.
 *
 * Creating a task is a WRITE: it establishes durable state that later agents
 * will treat as authoritative, so it goes through approval like any other
 * write. Reads are free.
 */
export function createDevelopmentTools(development: DevelopmentService): Tool[] {
  return [
    {
      name: 'create_development_task',
      description:
        '利用者がタスク登録・管理を求めた場合に、開発タスクの目標と成功条件を記録します。分析・調査・実装そのものは実行しません。それらの依頼を登録で代替しないでください。',
      riskLevel: RiskLevel.WRITE,
      trust: ToolTrust.TRUSTED_CORE,
      schema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '短いタスク名。' },
          goal: { type: 'string', description: '達成したいことの説明。' },
          successCriteria: {
            type: 'array',
            items: { type: 'string' },
            description: '完了と判断できる条件。1つ以上必須。',
          },
          scope: { type: 'string', description: '今回の作業範囲。' },
          nonGoals: { type: 'array', items: { type: 'string' }, description: '今回やらないこと。' },
          constraints: { type: 'array', items: { type: 'string' }, description: '守るべき制約。' },
          relevantFiles: { type: 'array', items: { type: 'string' }, description: '関連ファイル。' },
        },
        required: ['title', 'goal', 'successCriteria'],
      },
      /**
       * The decision, in a sentence.
       *
       * The dialog used to show the arguments — the whole goal, which in one
       * real case was a two-thousand-character brief. What a person needs
       * before allowing this is what it will do and how big it is, and both
       * fit on one line. The arguments are still there, underneath, for when
       * the sentence is not enough.
       */
      summarise(args: any) {
        const title = String(args?.title ?? '').trim() || '無題';
        const count = Array.isArray(args?.successCriteria) ? args.successCriteria.length : 0;
        const limits = Array.isArray(args?.constraints) ? args.constraints.length : 0;
        const scope = limits > 0 ? `、制約 ${limits} 件` : '';
        return `「${title}」を開発タスクとして記録します。完了条件 ${count} 件${scope}。まだ着手はしません。`;
      },
      async execute(args: any) {
        const task = await development.createTask({
          title: args.title,
          goal: args.goal,
          successCriteria: args.successCriteria,
          scope: args.scope ?? null,
          nonGoals: args.nonGoals ?? [],
          constraints: args.constraints ?? [],
          relevantFiles: args.relevantFiles ?? [],
        });
        return {
          taskId: task.id,
          title: task.title,
          status: task.status,
          successCriteria: task.successCriteria,
        };
      },
    },

    {
      name: 'list_development_tasks',
      description: '開発タスクの一覧を取得します。進行中の作業や停滞している実行を確認できます。',
      riskLevel: RiskLevel.READ,
      trust: ToolTrust.TRUSTED_CORE,
      schema: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['planned', 'in_progress', 'blocked', 'review', 'done', 'abandoned'],
            description: '省略時はすべて。',
          },
        },
      },
      async execute(args: any) {
        const tasks = development.listTasks({ status: args?.status });
        return {
          count: tasks.length,
          tasks: tasks.map((t) => ({
            id: t.id,
            title: t.title,
            status: t.status,
            successCriteria: t.successCriteria.length,
            runCount: t.runCount,
            activeRuns: t.activeRuns,
            stalledRuns: t.stalledRuns,
            updatedAt: t.updatedAt,
          })),
        };
      },
    },

    {
      name: 'get_development_task',
      description: '開発タスクの詳細（成功条件・決定事項・実行履歴・結果）を取得します。',
      riskLevel: RiskLevel.READ,
      trust: ToolTrust.TRUSTED_CORE,
      schema: {
        type: 'object',
        properties: { taskId: { type: 'string' } },
        required: ['taskId'],
      },
      async execute(args: any) {
        const task = development.getTask(args.taskId);
        return {
          id: task.id,
          title: task.title,
          goal: task.goal,
          status: task.status,
          successCriteria: task.successCriteria,
          nonGoals: task.nonGoals,
          decisions: task.decisions,
          runs: task.runs.map((r) => ({
            id: r.id,
            agent: r.agent,
            role: r.role,
            status: r.status,
            stalled: r.assessment.stalled,
            milestones: r.assessment.milestones,
            results: r.results.map((res) => ({ outcome: res.outcome, summary: res.summary })),
          })),
        };
      },
    },

    {
      name: 'generate_agent_handoff',
      description:
        '別のモデルやコーディングエージェントに渡すための正準ハンドオフを生成します。目標・成功条件・決定事項・既知の失敗・リポジトリ状態・要求出力形式を1つにまとめます。生成のみで、実行はしません。',
      riskLevel: RiskLevel.READ,
      trust: ToolTrust.TRUSTED_CORE,
      schema: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          role: {
            type: 'string',
            enum: ['implement', 'review', 'research', 'verify'],
            description: '受け手に期待する役割。',
          },
          agent: { type: 'string', description: '受け手の名前（例: claude-code, gpt-reviewer）。' },
        },
        required: ['taskId', 'role'],
      },
      async execute(args: any) {
        const role = (args.role ?? 'implement') as RunRole;
        const agent = args.agent ?? 'unassigned';
        const markdown = await development.renderHandoff(args.taskId, role, agent);
        return { taskId: args.taskId, role, agent, format: 'markdown', handoff: markdown };
      },
    },

    {
      name: 'record_development_decision',
      description:
        '決定事項をタスクに記録します。以後のハンドオフに含まれ、後続のエージェントが同じ議論を蒸し返さなくなります。',
      riskLevel: RiskLevel.WRITE,
      trust: ToolTrust.TRUSTED_CORE,
      schema: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          decision: { type: 'string', description: '確定した内容を1文で。' },
        },
        required: ['taskId', 'decision'],
      },
      async execute(args: any) {
        const task = development.appendDecision(args.taskId, args.decision);
        return { taskId: task.id, decisionCount: task.decisions.length, decisions: task.decisions };
      },
    },
  ];
}
