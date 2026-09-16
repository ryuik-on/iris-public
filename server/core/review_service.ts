import { AIProvider } from '../providers/base.js';
import { DevelopmentService } from './development_service.js';
import { SqliteActivityLogStore } from '../services/activity_log_sqlite.js';
import { renderHandoffMarkdown } from './handoff.js';
import { withTimeout, retry } from './resilience.js';
import { estimateCost } from './usage.js';
import { CONFIG } from '../config.js';

/**
 * Independent review (§62): LEVEL 3 of the development-orchestration ladder.
 *
 * This is the step that removes the manual Claude → GPT → Claude copy/paste.
 * The canonical handoff already existed and already specified what a reviewer
 * must return; what was missing was actually sending it to a second model and
 * capturing the answer.
 *
 * The word doing the work here is *independent*. A model reviewing its own
 * output is not a second opinion — it shares the blind spots that produced the
 * work. So the reviewer must be a different model, and this service refuses
 * rather than quietly self-reviewing when no second one is configured. A
 * review that looks like it happened but did not is worse than no review.
 */

export class NoIndependentReviewerError extends Error {
  constructor(public readonly primaryModel: string, public readonly available: string[]) {
    super(
      `独立レビューを実行できません。実装に使用したモデル（${primaryModel}）以外のモデルが設定されていません。` +
        `利用可能: ${available.join(', ') || 'なし'}。` +
        `自分自身にレビューさせても独立した第二意見にはならないため、実行しません。`
    );
    this.name = 'NoIndependentReviewerError';
  }
}

/**
 * How independent a review actually was.
 *
 * A different vendor is the strongest form — different training, different
 * blind spots. A different model from the same vendor is weaker but still a
 * genuine second opinion, and is reported as such rather than being passed off
 * as equivalent. The same model is not review at all and is refused.
 */
export type Independence = 'cross_provider' | 'cross_model';

/**
 * Whoever actually produced the work under review.
 *
 * Stated by the caller when it is not IRIS itself — a delegated run is
 * written by a coding agent, and the vendor behind that agent is what decides
 * whether a reviewer is genuinely from somewhere else. Claude Code is
 * Anthropic's; Codex is OpenAI's.
 */
export interface Implementer {
  model: string;
  vendor: string;
}

export class ReviewAlreadyRunningError extends Error {
  constructor(public readonly taskId: string, public readonly runId: string) {
    super(
      `このタスクのレビューは既に実行中です (run ${runId.slice(0, 8)})。` +
        `レビューは大きなハンドオフを丸ごと読むため、重複実行は費用も重複します。`
    );
    this.name = 'ReviewAlreadyRunningError';
  }
}

export type ReviewOutcome = 'success' | 'partial' | 'failure';

export interface ReviewFinding {
  severity: string;
  location?: string;
  issue: string;
  recommendation?: string;
}

export interface ReviewResult {
  outcome: ReviewOutcome;
  summary: string;
  findings: ReviewFinding[];
  unmetCriteria: string[];
  verifiedCriteria: string[];
  /** Present when the reviewer's reply could not be parsed as the required shape. */
  parseError?: string;
  rawReply: string;
}

export interface ReviewRunSummary {
  taskId: string;
  runId: string;
  reviewerModel: string;
  reviewerProvider: string;
  implementerModel: string;
  result: ReviewResult;
  usd: number;
  /** Reported so a weaker form of independence is never mistaken for the stronger one. */
  independence: Independence;
}

const REVIEW_SYSTEM_INSTRUCTION = `あなたは独立したレビュアーです。実装者とは別のモデルとして、実装者の主張を無条件に信用せずに検証してください。

- Success Criteria に照らして、実際に満たされているかを判断する。
- 正しさ・安全境界・見落とし・より良い代替案を指摘する。
- 確信が持てない指摘も、確信度を添えて報告する。重要度で自己検閲しない。
- 問題がなければ「問題なし」と明言する。無理に問題を作らない。

必ず指定された JSON のみを出力し、前後に説明文を付けないこと。`;

export class ReviewService {
  constructor(
    private development: DevelopmentService,
    private activity: SqliteActivityLogStore,
    /** Every configured provider, keyed by id. */
    private providers: Record<string, AIProvider>,
    /** The provider used for implementation — never eligible as its own reviewer. */
    private primaryProviderId: string,
    /**
     * Resolves the implementer at review time.
     *
     * With provider routing the implementer is not a startup setting: the run
     * may have been served by whichever provider still had quota. Asking now,
     * rather than trusting a fixed id, is what keeps "independent" true.
     */
    private resolvePrimary?: () => AIProvider | undefined
  ) {}

  /** Whoever actually did the work, falling back to the configured primary. */
  private primaryProvider(): AIProvider | undefined {
    return this.resolvePrimary?.() ?? this.providers[this.primaryProviderId];
  }

  /**
   * Providers that could serve as an independent reviewer: everything except
   * the one that did the work.
   */
  /**
   * Selection is by registry key, not by `provider.id`: a provider class
   * hardcodes its id, so two instances of the same class on different models
   * report the same id and cannot be told apart by it.
   */
  private entries(): Array<{ key: string; provider: AIProvider }> {
    return Object.entries(this.providers).map(([key, provider]) => ({ key, provider }));
  }

  /**
   * Who wrote the thing being reviewed.
   *
   * It was always IRIS's own provider, which is right when IRIS wrote the
   * code and wrong when it did not. A delegated run is written by Claude Code
   * or by Codex, and excluding IRIS's primary from reviewing *their* work
   * threw away the strongest candidate available: with Gemini configured as
   * the primary, Gemini — a different vendor from either agent — was the one
   * provider ruled out.
   */
  private implementerOf(implementer?: Implementer): { model: string; vendor: string } {
    if (implementer) return implementer;
    const primary = this.primaryProvider();
    return {
      model: primary?.currentModel ?? this.primaryProviderId,
      vendor: primary?.vendor ?? this.primaryProviderId,
    };
  }

  availableReviewers(implementer?: Implementer): Array<{ key: string; provider: AIProvider }> {
    const model = this.implementerOf(implementer).model;
    // Excluded by model, not by vendor: the same model under a different
    // registry key is still the same model, and shares its blind spots.
    return this.entries().filter(({ provider }) => provider.currentModel !== model);
  }

  canReview(): boolean {
    return this.availableReviewers().length > 0;
  }

  /**
   * Reviews a development task with a model other than the implementer's.
   * The run and its result are persisted, so a later handoff carries the
   * findings forward instead of the user re-explaining them.
   */
  /**
   * Creates the run row and returns it before any model call.
   *
   * The asynchronous endpoint previously answered 202 at its first await, which
   * could land before the row existed — a client that polled immediately found
   * nothing. Splitting creation out makes the run id available up front and
   * gives the caller something to reject duplicates against.
   */
  async prepareRun(
    taskId: string,
    options: { reviewerId?: string; implementer?: Implementer } = {}
  ) {
    const { model: implementerModel, vendor: primaryVendor } = this.implementerOf(options.implementer);
    const candidates = this.availableReviewers(options.implementer);

    if (candidates.length === 0) {
      this.activity.warn('review.refused_not_independent', {
        message: `実装モデル ${implementerModel} 以外のプロバイダがありません。`,
        detail: { taskId, primary: this.primaryProviderId },
      });
      throw new NoIndependentReviewerError(implementerModel, Object.keys(this.providers));
    }

    const selected = options.reviewerId
      ? candidates.find(({ key }) => key === options.reviewerId)
      : candidates.find(({ provider }) => provider.vendor !== primaryVendor) ?? candidates[0];

    if (!selected || selected.provider.currentModel === implementerModel) {
      throw new NoIndependentReviewerError(implementerModel, candidates.map(({ key }) => key));
    }

    // Refusing a second review while one is in flight: each costs a full model
    // call over a large handoff, so a duplicate is duplicated billing.
    const inFlight = this.development
      .getTask(taskId)
      .runs.find((r) => r.role === 'review' && ['pending', 'running'].includes(r.status));
    if (inFlight) {
      throw new ReviewAlreadyRunningError(taskId, inFlight.id);
    }

    const run = await this.development.startRun({
      taskId,
      agent: `${selected.key}:${selected.provider.currentModel}`,
      role: 'review',
    });

    return {
      run,
      selected,
      implementerModel,
      independence: (selected.provider.vendor === primaryVendor
        ? 'cross_model'
        : 'cross_provider') as Independence,
    };
  }

  async reviewTask(
    taskId: string,
    options: { reviewerId?: string; implementer?: Implementer } = {}
  ): Promise<ReviewRunSummary> {
    return this.executePreparedRun(taskId, await this.prepareRun(taskId, options));
  }

  /** Runs a review whose run row already exists. */
  async executePreparedRun(
    taskId: string,
    prepared: Awaited<ReturnType<ReviewService['prepareRun']>>
  ): Promise<ReviewRunSummary> {
    const { run, selected, implementerModel, independence } = prepared;
    const reviewer = selected.provider;

    const handoff = renderHandoffMarkdown(run.handoff);
    const prompt = `${handoff}\n\n---\n\n上記のタスクをレビューし、指定された JSON 形式のみで回答してください。`;

    let reply = '';
    let usd = 0;
    try {
      const response = await retry(
        () =>
          withTimeout(
            (signal) =>
              reviewer.generateResponse(
                [{ role: 'user', content: prompt }],
                [],
                REVIEW_SYSTEM_INSTRUCTION,
                signal
              ),
            { ms: CONFIG.reviewTimeoutMs, label: 'レビュー呼び出し', sideEffectUnknown: false }
          ),
        {
          attempts: CONFIG.reviewAttempts,
          label: 'review',
          // Review retries were previously invisible: the service has its own
          // retry wrapper and never fed the activity log.
          onRetry: ({ attempt, attempts, delayMs, error }) =>
            this.activity.warn('review.retry', {
              message: `${attempt}/${attempts} 回目を再試行 (${delayMs}ms後): ${error?.message ?? error}`,
              detail: { taskId, runId: run.id, attempt, attempts },
            }),
        }
      );
      reply = response.content ?? '';
      if (response.usage) usd = estimateCost(reviewer.currentModel, response.usage).usd;
    } catch (err: any) {
      this.development.recordResult({
        runId: run.id,
        outcome: 'failure',
        summary: `レビュアーの呼び出しに失敗: ${err?.message ?? err}`,
      });
      throw err;
    }

    const result = parseReviewReply(reply);

    this.development.recordResult({
      runId: run.id,
      outcome: result.outcome,
      summary: result.summary,
      detail: {
        reviewer: reviewer.currentModel,
        reviewerProvider: selected.key,
        implementerModel,
        independence,
        findings: result.findings,
        unmetCriteria: result.unmetCriteria,
        verifiedCriteria: result.verifiedCriteria,
        ...(result.parseError ? { parseError: result.parseError } : {}),
      },
    });

    this.activity.info('review.completed', {
      message: result.summary,
      detail: {
        taskId,
        runId: run.id,
        reviewer: reviewer.currentModel,
        implementerModel,
        independence,
        outcome: result.outcome,
        findings: result.findings.length,
        usd,
      },
    });

    return {
      taskId,
      runId: run.id,
      reviewerModel: reviewer.currentModel,
      reviewerProvider: selected.key,
      implementerModel,
      result,
      usd,
      independence,
    };
  }
}

/**
 * Parses the reviewer's reply.
 *
 * A reviewer that returns unparseable text has still said something, and
 * discarding it would lose real findings — so the raw reply is always kept and
 * the parse failure is reported rather than swallowed. An unparseable review is
 * never reported as a clean pass.
 */
export function parseReviewReply(reply: string): ReviewResult {
  const raw = reply ?? '';
  const json = extractJson(raw);

  if (!json) {
    return {
      outcome: 'partial',
      summary: 'レビュー結果を構造化できませんでした。生の回答を確認してください。',
      findings: [],
      unmetCriteria: [],
      verifiedCriteria: [],
      parseError: 'JSON が見つかりませんでした。',
      rawReply: raw,
    };
  }

  try {
    const parsed = JSON.parse(json);
    const outcome: ReviewOutcome = ['success', 'partial', 'failure'].includes(parsed.outcome)
      ? parsed.outcome
      : 'partial';

    return {
      outcome,
      summary: typeof parsed.summary === 'string' && parsed.summary.trim()
        ? parsed.summary.trim()
        : 'レビュアーが要約を返しませんでした。',
      findings: normalizeFindings(parsed.findings),
      unmetCriteria: toStringArray(parsed.unmetCriteria),
      verifiedCriteria: toStringArray(parsed.verifiedCriteria),
      ...(['success', 'partial', 'failure'].includes(parsed.outcome)
        ? {}
        : { parseError: `outcome が不正でした: ${JSON.stringify(parsed.outcome)}` }),
      rawReply: raw,
    };
  } catch (err: any) {
    return {
      outcome: 'partial',
      summary: 'レビュー結果の JSON を解析できませんでした。',
      findings: [],
      unmetCriteria: [],
      verifiedCriteria: [],
      parseError: err?.message ?? String(err),
      rawReply: raw,
    };
  }
}

/** Models often wrap JSON in prose or a fenced block; take the outermost object. */
function extractJson(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  return candidate.slice(start, end + 1);
}

function normalizeFindings(value: any): ReviewFinding[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((f) => f && typeof f === 'object')
    .map((f) => ({
      severity: String(f.severity ?? 'unknown'),
      location: f.location ? String(f.location) : undefined,
      issue: String(f.issue ?? f.description ?? ''),
      recommendation: f.recommendation ? String(f.recommendation) : undefined,
    }))
    .filter((f) => f.issue.length > 0);
}

function toStringArray(value: any): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim());
}
