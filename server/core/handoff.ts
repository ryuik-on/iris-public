import {
  DevelopmentTask,
  AgentRun,
  AgentResult,
  RunRole,
  assessRun,
} from '../services/dev_tasks_sqlite.js';
import { RepositoryState } from '../services/repo_state.js';
import { CodeContext, renderCodeContext } from '../services/code_context.js';
import { ToolRegistry } from '../tools/registry.js';
import { RiskLevel } from './types.js';

/**
 * Canonical agent handoff (§13).
 *
 * The problem this solves: passing an entire chat transcript between models is
 * expensive, lossy and non-reproducible. A handoff is instead a task-specific
 * packet — what the goal is, what "done" means, what has already been decided,
 * what already failed, and what the next consumer must return.
 *
 * It is versioned because it is a contract between systems, and stored with the
 * run that used it so a result can always be traced back to exactly what the
 * agent was told.
 */

export const HANDOFF_VERSION = 1;

export interface CanonicalHandoff {
  handoffVersion: number;
  generatedAt: string;

  task: {
    id: string;
    title: string;
    goal: string;
    successCriteria: string[];
    scope: string | null;
    nonGoals: string[];
    constraints: string[];
    status: string;
  };

  /** Settled decisions, so the next agent does not reopen them. */
  decisionsAlreadyMade: string[];

  repository: RepositoryState;
  relevantFiles: string[];

  /**
   * The actual code, when assembled. Without it a reviewer can only judge the
   * description of the work — which an independent review pointed out makes
   * its verdict formal rather than substantive.
   */
  codeContext?: CodeContext;

  /** Boundaries the receiving agent must not cross. */
  safetyBoundaries: string[];

  currentProgress: {
    completedRuns: number;
    lastOutcome: string | null;
    milestones: string | null;
    note: string | null;
  };

  /** What has already been tried and did not work, so it is not repeated. */
  knownFailures: Array<{ agent: string; role: string; summary: string; at: string }>;

  /**
   * Individual findings from prior reviews.
   *
   * Carried separately because a review's value is in its specific findings,
   * not its summary line. An independent review caught this exact gap: the
   * summary reached the next implementer while the findings stayed buried in
   * the stored result.
   */
  reviewFindings: Array<{
    reviewer: string;
    severity: string;
    location?: string;
    issue: string;
    recommendation?: string;
  }>;

  requiredOutput: {
    role: RunRole;
    instructions: string;
    resultSchema: Record<string, string>;
  };

  nextConsumer: string;
}

export interface BuildHandoffInput {
  task: DevelopmentTask;
  role: RunRole;
  agent: string;
  repository: RepositoryState;
  priorRuns?: Array<{ run: AgentRun; results: AgentResult[] }>;
  toolRegistry?: ToolRegistry;
  nextConsumer?: string;
  codeContext?: CodeContext;
}

const ROLE_INSTRUCTIONS: Record<RunRole, string> = {
  implement:
    'このハンドオフの Goal を実装してください。Success Criteria をすべて満たすこと。' +
    '実装後、変更ファイル・実行したテスト・残課題を構造化して返してください。' +
    '未確認のことを完了と報告しないでください。',
  review:
    '実装を独立した立場でレビューしてください。実装者の主張を無条件に信用せず、' +
    'Success Criteria に照らして実際に満たされているかを検証してください。' +
    '正しさ・安全境界・見落とし・より良い代替案を指摘してください。' +
    '問題がなければ「問題なし」と明言してください。',
  research:
    '実装は行わず、調査のみ行ってください。選択肢・トレードオフ・推奨案と、' +
    'その根拠および情報の鮮度を返してください。',
  verify:
    'Success Criteria が実際に満たされているかを検証してください。' +
    '検証方法と実際の出力を示してください。推測で合格としないでください。',
};

const RESULT_SCHEMA: Record<RunRole, Record<string, string>> = {
  implement: {
    outcome: 'success | partial | failure',
    summary: '何をしたかの1〜3文',
    filesChanged: '変更したファイルパスの配列',
    testsRun: '実行したテストとその結果',
    remainingWork: '未完了の項目の配列',
    risks: '導入した可能性のあるリスク',
  },
  review: {
    outcome: 'success（問題なし） | partial（軽微な指摘） | failure（重大な問題）',
    summary: 'レビュー結論の1〜3文',
    findings: '{ severity, location, issue, recommendation } の配列',
    unmetCriteria: '満たされていない Success Criteria の配列',
    verifiedCriteria: '実際に確認できた Success Criteria の配列',
  },
  research: {
    outcome: 'success | partial | failure',
    summary: '結論の1〜3文',
    options: '{ option, benefit, cost, risk, reversibility } の配列',
    recommendation: '推奨案とその理由',
    freshness: '情報の鮮度と確認日',
  },
  verify: {
    outcome: 'success | partial | failure',
    summary: '検証結論の1〜3文',
    criteriaResults: '{ criterion, met, evidence } の配列',
    evidence: '実際のコマンド出力など',
  },
};

export function buildHandoff(input: BuildHandoffInput): CanonicalHandoff {
  const { task, role, agent, repository, priorRuns = [], toolRegistry } = input;

  const completed = priorRuns.filter(({ run }) => run.status === 'succeeded');
  const lastResult = priorRuns.flatMap(({ results }) => results).slice(-1)[0] ?? null;

  const knownFailures = priorRuns
    .flatMap(({ run, results }) =>
      results
        .filter((r) => r.outcome === 'failure' || r.outcome === 'partial')
        .map((r) => ({ agent: run.agent, role: run.role, summary: r.summary, at: r.createdAt }))
    )
    .slice(-10);

  // Findings from every review run, newest last, so the next implementer
  // inherits the specifics rather than a one-line verdict.
  const reviewFindings = priorRuns
    .filter(({ run }) => run.role === 'review')
    .flatMap(({ run, results }) =>
      results.flatMap((result) => {
        const findings = Array.isArray(result.detail?.findings) ? result.detail.findings : [];
        return findings.map((f: any) => ({
          reviewer: String(result.detail?.reviewer ?? run.agent),
          severity: String(f.severity ?? 'unknown'),
          location: f.location ? String(f.location) : undefined,
          issue: String(f.issue ?? ''),
          recommendation: f.recommendation ? String(f.recommendation) : undefined,
        }));
      })
    )
    .filter((f) => f.issue.length > 0)
    .slice(-30);

  const latestRun = priorRuns.slice(-1)[0]?.run;
  const assessment = latestRun ? assessRun(latestRun) : null;

  return {
    handoffVersion: HANDOFF_VERSION,
    generatedAt: new Date().toISOString(),

    task: {
      id: task.id,
      title: task.title,
      goal: task.goal,
      successCriteria: task.successCriteria,
      scope: task.scope,
      nonGoals: task.nonGoals,
      constraints: task.constraints,
      status: task.status,
    },

    decisionsAlreadyMade: task.decisions,
    repository,
    relevantFiles: task.relevantFiles,
    codeContext: input.codeContext,
    safetyBoundaries: describeSafetyBoundaries(toolRegistry),

    currentProgress: {
      completedRuns: completed.length,
      lastOutcome: lastResult?.outcome ?? null,
      milestones: assessment?.milestones ?? null,
      note: latestRun?.progress?.note ?? null,
    },

    knownFailures,
    reviewFindings,

    requiredOutput: {
      role,
      instructions: ROLE_INSTRUCTIONS[role],
      resultSchema: RESULT_SCHEMA[role],
    },

    nextConsumer: input.nextConsumer ?? agent,
  };
}

/**
 * Boundaries stated to the receiving agent explicitly. These are facts about
 * how IRIS behaves, not requests: an agent cannot opt out of them, but telling
 * it saves a round trip spent proposing something that will be refused.
 */
function describeSafetyBoundaries(toolRegistry?: ToolRegistry): string[] {
  const boundaries = [
    'WRITE / EXTERNAL_ACTION / DESTRUCTIVE のツールは必ずユーザー承認を経て実行される。skipApproval では回避できない。',
    'ファイル操作は IRIS ワークスペース内に限定される。ワークスペース外および機密ファイルへのアクセスは拒否される。',
    'main への merge、外部への push、本番デプロイは自動では行わない。',
    '金銭の移動、外部への自動送信は禁止。',
    'タイムアウトは失敗を意味しない。副作用のあるツールがタイムアウトした場合、実行済みの可能性があるため状態を確認すること。',
  ];

  if (toolRegistry) {
    const risky = toolRegistry
      .getAll()
      .filter((t) => t.riskLevel !== RiskLevel.READ)
      .map((t) => t.name);
    if (risky.length > 0) {
      boundaries.push(`承認が必要なツール: ${risky.join(', ')}`);
    }
  }

  return boundaries;
}

/**
 * Markdown rendering.
 *
 * Until IRIS invokes agents itself, this is the practical payoff: one block to
 * paste into another model, instead of reassembling context by hand each time.
 */
export function renderHandoffMarkdown(handoff: CanonicalHandoff): string {
  const lines: string[] = [];
  const section = (title: string) => {
    lines.push('', `## ${title}`, '');
  };
  const list = (items: string[], empty = '（なし）') => {
    if (items.length === 0) lines.push(empty);
    else for (const item of items) lines.push(`- ${item}`);
  };

  lines.push(`# ${handoff.task.title}`);
  lines.push('');
  lines.push(`IRIS canonical handoff v${handoff.handoffVersion} — ${handoff.generatedAt}`);
  lines.push(`Task ID: \`${handoff.task.id}\` / Role: **${handoff.requiredOutput.role}**`);

  section('Goal');
  lines.push(handoff.task.goal);

  section('Success Criteria');
  list(handoff.task.successCriteria);

  if (handoff.task.scope) {
    section('Scope');
    lines.push(handoff.task.scope);
  }

  if (handoff.task.nonGoals.length > 0) {
    section('Non-Goals');
    list(handoff.task.nonGoals);
  }

  if (handoff.task.constraints.length > 0) {
    section('Constraints');
    list(handoff.task.constraints);
  }

  if (handoff.decisionsAlreadyMade.length > 0) {
    section('Decisions Already Made（再検討しないこと）');
    list(handoff.decisionsAlreadyMade);
  }

  section('Repository State');
  if (handoff.repository.available) {
    lines.push(`- branch: \`${handoff.repository.branch}\``);
    lines.push(`- HEAD: \`${handoff.repository.headCommit}\` ${handoff.repository.headSubject ?? ''}`);
    lines.push(`- working tree: ${handoff.repository.dirty ? '変更あり' : 'clean'}`);
    if (handoff.repository.changedFiles?.length) {
      lines.push(`- changed files: ${handoff.repository.changedFiles.join(', ')}`);
    }
    if (handoff.repository.recentCommits?.length) {
      lines.push('- recent commits:');
      for (const c of handoff.repository.recentCommits) lines.push(`  - \`${c.hash}\` ${c.subject}`);
    }
  } else {
    lines.push(`（リポジトリ情報を取得できませんでした: ${handoff.repository.error ?? 'unknown'}）`);
  }

  if (handoff.relevantFiles.length > 0) {
    section('Relevant Files');
    list(handoff.relevantFiles);
  }

  if (handoff.codeContext) {
    section('Code');
    lines.push(renderCodeContext(handoff.codeContext));
  }

  section('Safety Boundaries');
  list(handoff.safetyBoundaries);

  section('Current Progress');
  lines.push(`- 完了した run: ${handoff.currentProgress.completedRuns}`);
  if (handoff.currentProgress.milestones) lines.push(`- milestones: ${handoff.currentProgress.milestones}`);
  if (handoff.currentProgress.lastOutcome) lines.push(`- 直近の結果: ${handoff.currentProgress.lastOutcome}`);
  if (handoff.currentProgress.note) lines.push(`- 備考: ${handoff.currentProgress.note}`);

  if (handoff.knownFailures.length > 0) {
    section('Known Failures（繰り返さないこと）');
    for (const f of handoff.knownFailures) {
      lines.push(`- [${f.agent}/${f.role}] ${f.summary}`);
    }
  }

  if (handoff.reviewFindings.length > 0) {
    section('Review Findings（独立レビューの指摘。対処するか、対処しない理由を述べること）');
    for (const f of handoff.reviewFindings) {
      const where = f.location ? ` @${f.location}` : '';
      lines.push(`- **[${f.severity}]**${where} ${f.issue}`);
      if (f.recommendation) lines.push(`  - 推奨: ${f.recommendation}`);
      lines.push(`  - 指摘者: ${f.reviewer}`);
    }
  }

  section('Required Output');
  lines.push(handoff.requiredOutput.instructions);
  lines.push('');
  lines.push('次の形式で返してください:');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(handoff.requiredOutput.resultSchema, null, 2));
  lines.push('```');

  section('Next Consumer');
  lines.push(handoff.nextConsumer);

  return lines.join('\n');
}
