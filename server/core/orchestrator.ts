import { AIProvider } from '../providers/base.js';
import { ToolRegistry } from '../tools/registry.js';
import { SqliteApprovalStore } from '../services/approval_sqlite.js';
import { RiskLevel, OrchestratorResponse, ConversationTurn } from './types.js';
import { CONFIG } from '../config.js';
import { countLocalOnly, withhold } from './privacy.js';
import { randomUUID } from 'crypto';
import { withTimeout, retry, Deadline, TimeoutError, DeadlineExceededError } from './resilience.js';
import { TokenUsage, EMPTY_USAGE, addUsage, estimateCost } from './usage.js';

/** Structured progress/telemetry events. Groundwork for stall detection. */
export type OrchestratorEvent =
  | { type: 'provider.retry'; attempt: number; attempts: number; delayMs: number; reason: string }
  | { type: 'provider.timeout'; timeoutMs: number }
  | { type: 'tool.retry'; tool: string; attempt: number; attempts: number; delayMs: number; reason: string }
  | { type: 'tool.timeout'; tool: string; sideEffectUnknown: boolean }
  | { type: 'tool.refused_for_origin'; tool: string; riskLevel: RiskLevel; origin: RunOrigin }
  /**
   * A tool returned data classified as local-only and it was not passed on.
   *
   * Worth an event of its own rather than a log line inside the check: a
   * boundary that stops something silently looks exactly like a tool that
   * found nothing, and this one exists precisely so the shortfall can be seen.
   */
  | { type: 'privacy.withheld'; tool: string; withheld: number }
  /**
   * A call ran on approval the user gave in advance rather than one requested
   * now. Emitted every time, because a standing approval that stops being
   * visible is the failure mode of granting one at all.
   */
  | { type: 'delegation.used'; tool: string; remainingUsd: number; expiresAt: string }
  /** The per-run ceiling was reached mid-loop, so the run stops here. */
  | { type: 'run.spend_limit'; usd: number; limitUsd: number; calls: number }
  | { type: 'run.deadline_exceeded'; budgetMs: number; elapsedMs: number }
  | {
      type: 'run.usage';
      model: string;
      usage: TokenUsage;
      usd: number;
      priced: boolean;
      calls: number;
      /**
       * Which provider served these calls, when routing chose one. A run that
       * fails over mid-way emits one event per model rather than pricing
       * everything against whichever provider happened to answer last.
       */
      servedBy?: string;
      /** The settings in force, so cost can later be compared against them. */
      settings?: Record<string, string | number>;
    };

export type OrchestratorEventSink = (event: OrchestratorEvent) => void;

/** Thrown when an approval decision targets a session that is no longer pending. */
export class StaleApprovalError extends Error {
  constructor(public readonly sessionId: string) {
    super('指定された承認セッションが存在しないか、既に処理済みです。');
    this.name = 'StaleApprovalError';
  }
}

/**
 * Who started this run.
 *
 * `user` is someone typing. `inferred` is IRIS acting on a guess about the
 * situation — a suggestion the user accepted, or a rule that fired. The
 * difference is not cosmetic: it decides which tools exist for the run.
 */
export type RunOrigin = 'user' | 'inferred';

/**
 * How the request reached IRIS, which decides only the shape of the reply.
 *
 * Deliberately separate from RunOrigin: speaking to IRIS does not make a run
 * more or less trusted, and this must never be read as permission.
 */
export type ReplyChannel = 'text' | 'voice';

/**
 * A reply being written, as it is written.
 *
 * `reset` exists because a provider call can be retried. An attempt that
 * streamed half a sentence and then failed has already put that half sentence
 * in front of the reader; without a way to say "discard that", the retry's
 * text lands after it and the reply is delivered twice, the first time
 * incomplete. The retry is the whole reason streaming needs more than one
 * callback.
 */
export interface ReplyStream {
  delta(text: string): void;
  reset(): void;
  /**
   * What the run is doing now.
   *
   * Sent over the same channel as the text because that channel already
   * exists and is already open for exactly the duration this describes. The
   * alternative was a field on a polled endpoint, which would report a
   * two-second tool call roughly never.
   *
   * `tool_execution` has been a drawable state with nothing deriving it since
   * the states were written: the run reports which tools it used once it is
   * over, so reading a calendar looked identical to composing a sentence.
   */
  phase(name: 'thinking' | 'tool_execution'): void;
}

/**
 * Tools an inferred run may never reach.
 *
 * Not "may reach with approval" — may not reach. An approval prompt reading
 * "IRIS wants to send this email, because it thinks you are at your desk" is
 * a prompt people click through, and the guess would have become the cause of
 * an irreversible act. A guess is allowed to start a conversation and nothing
 * else.
 */
const FORBIDDEN_FOR_INFERRED = new Set([RiskLevel.EXTERNAL_ACTION, RiskLevel.DESTRUCTIVE]);

export class JarvisOrchestrator {
  private requireApprovalLevels = new Set([RiskLevel.WRITE, RiskLevel.EXTERNAL_ACTION, RiskLevel.DESTRUCTIVE]);

  /**
   * The per-run ceiling, consulted between steps.
   *
   * `run.usage` is emitted in the `finally` at the end of a run, so nothing
   * built on it can stop a run — by the time it fires the money is spent.
   * That left `perRunUsd` as a number printed at startup and enforced
   * nowhere: an independent audit on 2026-08-20 found the pre-call check
   * existed, was tested, and had no caller, while the daily limit was the
   * only thing actually bounding a runaway loop.
   *
   * Supplied rather than reached for, so the orchestrator keeps having no
   * opinion about money — it asks after each provider call whether what it
   * has spent so far is still allowed.
   */
  private spendCeiling?: (usdSoFar: number) => { stop: boolean; limitUsd: number } | null;

  setSpendCeiling(check: (usdSoFar: number) => { stop: boolean; limitUsd: number } | null) {
    this.spendCeiling = check;
  }

  /**
   * Consulted when a call would otherwise stop and ask for approval.
   *
   * Set only if the user has granted something. Unset — the default — every
   * approval is requested exactly as before, so the feature cannot change
   * behaviour by existing.
   */
  private checkDelegation?: (input: {
    tool: string;
    args: any;
    origin: RunOrigin;
  }) => { satisfied: true; remainingUsd: number; expiresAt: string } | { satisfied: false } | null;

  setDelegationCheck(check: NonNullable<JarvisOrchestrator['checkDelegation']>) {
    this.checkDelegation = check;
  }

  constructor(
    private provider: AIProvider,
    private toolRegistry: ToolRegistry,
    private approvalStore: SqliteApprovalStore,
    private maxLoops: number = CONFIG.maxToolLoops,
    private onEvent?: OrchestratorEventSink,
    /**
     * Renders what is currently believed about the situation, appended to the
     * system instruction. Returns empty when nothing is known — a prompt that
     * says "no information available" invites the model to invent some.
     */
    private situation?: () => string,
    /**
     * 返す先によって、頼む相手を変える。
     *
     * 「実際の会話なら速さが欲しいけど、パソコン内で話すだけなら精度のほうが
     * 必要」（利用者、2026-09-11）。声で待たされるのは沈黙になるが、文字なら
     * 一秒の差より判断の確かさが効く —— **同じ問いでも、返す先で正解が違う。**
     *
     * 実測（最初の言葉が出るまで、2026-09-11）：Haiku 4.5 が 0.91〜1.10秒、
     * Sonnet 5 が 1.50秒、いまの Gemini flash が 2.57秒。
     *
     * `channel` は既にここまで届いていた（`callProvider` の引数）ので、
     * 継ぎ目はここ。無ければ既定の相手をそのまま使う。
     */
    private providerFor?: (channel: ReplyChannel) => AIProvider | undefined
  ) {}

  setProvider(newProvider: AIProvider) { this.provider = newProvider; }

  /**
   * `history` is previous turns only; `userMessage` is the current new turn.
   * The orchestrator appends the current turn itself — callers must not
   * pre-append it (this is the chat contract that fixed the duplication bug).
   */
  async process(req: {
    userMessage: string;
    history: ConversationTurn[];
    conversationId?: string | null;
    origin?: RunOrigin;
    /**
     * How the request arrived — not who made it, which is `origin`. Only the
     * shape of the reply depends on this; it never widens what the run may do.
     */
    channel?: ReplyChannel;
    /** Present when someone is reading the reply as it is written. */
    stream?: ReplyStream;
  }): Promise<OrchestratorResponse> {
    const sessionId = randomUUID();
    const workingHistory: ConversationTurn[] = [...req.history, { role: 'user', content: req.userMessage }];
    return this.runLoop(
      sessionId,
      req.conversationId ?? null,
      workingHistory,
      [],
      req.origin ?? 'user',
      req.channel ?? 'text',
      req.stream
    );
  }

  /** Whether a run of this origin may use a tool of this risk level. */
  private permits(origin: RunOrigin, riskLevel: RiskLevel): boolean {
    return origin === 'user' || !FORBIDDEN_FOR_INFERRED.has(riskLevel);
  }

  async resume(sessionId: string, approved: boolean): Promise<OrchestratorResponse> {
    // Atomic claim: a replayed or concurrent decision cannot execute the tool twice.
    const pendingRecord = this.approvalStore.claimPending(sessionId, approved ? 'approved' : 'rejected');
    if (!pendingRecord) throw new StaleApprovalError(sessionId);

    const history: ConversationTurn[] = JSON.parse(pendingRecord.historyJson);
    const args = JSON.parse(pendingRecord.argsJson);
    const executedTools: Array<{ name: string; args: any; result: any }> = [];

    if (approved) {
      const outcome = await this.toolRegistry.executeTool(pendingRecord.toolName, args);
      const toolResultData = this.toToolResult(pendingRecord.toolName, outcome);
      executedTools.push({ name: pendingRecord.toolName, args, result: toolResultData });
      history.push({ role: 'tool', toolName: pendingRecord.toolName, toolCallId: pendingRecord.toolCallId, toolResult: toolResultData });
    } else {
      const rejectedResult = { status: 'rejected', message: 'ユーザーによって実行が拒否されました。' };
      executedTools.push({ name: pendingRecord.toolName, args, result: rejectedResult });
      history.push({ role: 'tool', toolName: pendingRecord.toolName, toolCallId: pendingRecord.toolCallId, toolResult: rejectedResult });
    }

    // Carried across the approval: a run that began as a guess is still a
    // guess after the user allowed one write.
    return this.runLoop(sessionId, pendingRecord.conversationId, history, executedTools, pendingRecord.origin);
  }

  /**
   * Turns an execution outcome into what the model is told.
   *
   * A timed-out risky tool is reported as *unknown*, never as failed. Telling
   * the model the write failed would invite it to retry and write twice; the
   * correct behaviour is to verify before acting again.
   */
  /**
   * Everything a tool returns passes through here on its way into the
   * conversation, which is why the local-only check sits at this point and
   * not at any of the four call sites.
   */
  private toToolResult(toolName: string, outcome: any) {
    const result = this.toToolResultInner(toolName, outcome);

    const marked = countLocalOnly(result);
    if (marked > 0) {
      /**
       * Logged, and loudly. A boundary that stops something without saying so
       * is indistinguishable from a tool that returned nothing, and the whole
       * point of this one is that the shortfall must be visible.
       */
      this.onEvent?.({
        type: 'privacy.withheld',
        tool: toolName,
        withheld: marked,
      });
      return withhold(marked);
    }
    return result;
  }

  private toToolResultInner(toolName: string, outcome: any) {
    if (outcome.timedOut) {
      this.onEvent?.({
        type: 'tool.timeout',
        tool: toolName,
        sideEffectUnknown: Boolean(outcome.sideEffectUnknown),
      });
      if (outcome.sideEffectUnknown) {
        return {
          status: 'unknown',
          error: outcome.error,
          sideEffectUnknown: true,
          guidance:
            'このツールはタイムアウトしました。実行された可能性があります。再実行する前に、必ず現在の状態を確認してください。',
        };
      }
      return { status: 'timeout', error: outcome.error };
    }
    return outcome.error ? { error: outcome.error } : outcome.result;
  }

  private async runLoop(
    sessionId: string,
    conversationId: string | null,
    history: ConversationTurn[],
    executedTools: any[],
    origin: RunOrigin = 'user',
    channel: ReplyChannel = 'text',
    stream?: ReplyStream
  ): Promise<OrchestratorResponse> {
    // Narrowed, never widened. An inferred run is offered a smaller toolset so
    // the model does not propose something it will then be refused; the refusal
    // below is the guarantee, this is the courtesy.
    const availableTools = this.toolRegistry
      .getAll()
      .filter((tool) => this.permits(origin, tool.riskLevel));
    /*
     * 頼む相手は、走り始めに一度だけ決める。
     *
     * 一回の走りが道具の往復で何度もモデルを呼ぶので、**途中で相手が変わると
     * 費用の記録も「誰が答えたか」も混ざる。**声か文字かは走りのあいだ変わら
     * ないので、ここで決めて最後まで使う。
     */
    const provider = this.providerFor?.(channel) ?? this.provider;
    const deadline = new Deadline(CONFIG.runDeadlineMs, 'orchestrator run');
    let loopCount = 0;
    // A run can span several provider calls (one per tool round trip), so cost
    // is reported for the run rather than per call — but keyed by the model
    // that actually served, since a router may fail over part-way and pricing
    // the whole run against one model would silently misreport the bill.
    const byModel = new Map<
      string,
      { usage: TokenUsage; calls: number; servedBy?: string; settings?: Record<string, string | number> }
    >();
    let providerCalls = 0;

    try {
      while (loopCount < this.maxLoops) {
        loopCount++;
        // Checked between steps: per-step timeouts alone cannot bound a run,
        // since enough steps finishing just under their limit still add up.
        if (deadline.expired) {
          this.onEvent?.({ type: 'run.deadline_exceeded', budgetMs: deadline.budgetMs, elapsedMs: deadline.elapsedMs });
          throw new DeadlineExceededError('orchestrator run', deadline.budgetMs);
        }

        stream?.phase('thinking');
        const response = await this.callProvider(provider, history, availableTools, deadline, channel, stream);
        providerCalls++;
        const servedModel = response.servedModel ?? provider.currentModel;
        const bucket = byModel.get(servedModel) ?? {
          usage: { ...EMPTY_USAGE },
          calls: 0,
          servedBy: response.servedBy,
        };
        bucket.calls++;
        // Read now rather than at the end: a router reports the settings of
        // whoever just answered, and by the end that may be someone else.
        bucket.settings = provider.describeSettings?.();
        if (response.usage) bucket.usage = addUsage(bucket.usage, response.usage);
        byModel.set(servedModel, bucket);

        /**
         * Checked between steps, like the deadline above it.
         *
         * The cost of the run so far is the sum of what every model in it has
         * billed. A per-step check cannot bound a run — enough steps each
         * under the limit still add up — and a check at the end is a receipt.
         */
        if (this.spendCeiling) {
          let spentSoFar = 0;
          for (const [model, b] of byModel) spentSoFar += estimateCost(model, b.usage).usd;
          const verdict = this.spendCeiling(spentSoFar);
          if (verdict?.stop) {
            this.onEvent?.({
              type: 'run.spend_limit',
              usd: spentSoFar,
              limitUsd: verdict.limitUsd,
              calls: providerCalls,
            });
            return {
              status: 'completed',
              reply:
                `1実行あたりの上限 $${verdict.limitUsd} に達したため、ここで停止しました` +
                `（この実行で $${spentSoFar.toFixed(4)}）。続きが必要なら、改めて指示してください。`,
              executedTools,
              sessionId,
              conversationId,
            };
          }
        }

        if (!response.toolCalls || response.toolCalls.length === 0) {
          return {
            status: 'completed',
            reply: response.content || '了解いたしました。',
            executedTools,
            sessionId,
            conversationId,
          };
        }

        history.push({
          role: 'assistant',
          content: response.content,
          toolCalls: response.toolCalls,
          providerMetadata: response.providerMetadata,
        });

        for (const call of response.toolCalls) {
          const tool = this.toolRegistry.get(call.name);
          const riskLevel = tool ? tool.riskLevel : RiskLevel.READ;

          // The boundary, enforced independently of which tools were offered:
          // a model that names a forbidden tool anyway is refused, not asked
          // about. A guess must not become the cause of an irreversible act.
          if (tool && !this.permits(origin, riskLevel)) {
            this.onEvent?.({ type: 'tool.refused_for_origin', tool: call.name, riskLevel, origin });
            const refusal = {
              error: true,
              message:
                `${call.name} は推定にもとづく実行では使用できません（${riskLevel}）。` +
                'この操作が必要な場合は、利用者に依頼してください。',
            };
            executedTools.push({ name: call.name, args: call.args, result: refusal });
            history.push({ role: 'tool', toolName: call.name, toolCallId: call.id, toolResult: refusal });
            continue;
          }

          /**
           * Approval the user gave in advance, if they gave one.
           *
           * The invariant below is unchanged: risk level still decides, and no
           * tool may declare itself exempt. This asks a different question —
           * whether the *person* has already approved this tool, for this
           * repository, within limits they set — and it is consulted only for
           * a call that would otherwise stop and ask. A guess never reaches
           * it: `decideDelegation` refuses an inferred origin outright, for
           * the same reason `FORBIDDEN_FOR_INFERRED` exists above.
           *
           * The hook is absent unless something has been granted, so the
           * default path through this gate is exactly what it was.
           */
          const delegated =
            tool && this.requireApprovalLevels.has(riskLevel)
              ? this.checkDelegation?.({ tool: call.name, args: call.args, origin }) ?? null
              : null;

          if (delegated?.satisfied) {
            /**
             * Announced, never silent. The whole risk of approving something
             * in advance is that it stops being visible, so a call made under
             * a grant says so — with what is left and when the grant ends.
             */
            this.onEvent?.({
              type: 'delegation.used',
              tool: call.name,
              remainingUsd: delegated.remainingUsd,
              expiresAt: delegated.expiresAt,
            });
          }

          // Security invariant: risk level decides, never the tool's skipApproval flag.
          if (tool && this.requireApprovalLevels.has(riskLevel) && !delegated?.satisfied) {
            const approvalId = randomUUID();
            this.approvalStore.savePending({
              approvalId,
              sessionId,
              conversationId,
              toolCallId: call.id,
              toolName: call.name,
              argsJson: JSON.stringify(call.args),
              riskLevel,
              historyJson: JSON.stringify(history),
              origin,
            });

            return {
              status: 'requires_approval',
              sessionId,
              conversationId,
              pendingApproval: {
                id: approvalId,
                toolCallId: call.id,
                toolName: call.name,
                args: call.args,
                riskLevel,
                description: tool.description,
                // What this particular call does, when the tool can say. The
                // description says what the tool is for; this says what is
                // about to happen.
                summary: tool.summarise?.(call.args),
                createdAt: new Date().toISOString(),
              },
              executedTools,
            };
          }

          // Said before the call, not after: the point of this is the seconds
          // during which it is happening.
          stream?.phase('tool_execution');
          const outcome = await this.toolRegistry.executeTool(call.name, call.args, {
            signal: deadline.signal,
            timeoutMs: deadline.clamp(CONFIG.toolTimeoutMs),
            onRetry: (info) => this.onEvent?.({ type: 'tool.retry', ...info }),
          });
          const toolResultData = this.toToolResult(call.name, outcome);
          executedTools.push({ name: call.name, args: call.args, result: toolResultData });
          history.push({ role: 'tool', toolName: call.name, toolCallId: call.id, toolResult: toolResultData });
        }
      }

      return { status: 'completed', reply: '処理上限に達しました。', executedTools, sessionId, conversationId };
    } finally {
      deadline.dispose();
      // A run that reached the provider but produced nothing still reports its
      // attempt honestly, rather than vanishing from the cost record.
      if (providerCalls > 0 && byModel.size === 0) {
        byModel.set(provider.currentModel, { usage: { ...EMPTY_USAGE }, calls: providerCalls });
      }
      for (const [model, bucket] of byModel) {
        const cost = estimateCost(model, bucket.usage);
        this.onEvent?.({
          type: 'run.usage',
          model,
          usage: bucket.usage,
          usd: cost.usd,
          priced: cost.priced,
          calls: bucket.calls,
          servedBy: bucket.servedBy,
          settings: bucket.settings ?? provider.describeSettings?.(),
        });
      }
    }
  }

  private systemInstruction(channel: ReplyChannel): string {
    let rendered = '';
    try {
      rendered = this.situation?.() ?? '';
    } catch {
      // Situational context is an enhancement. Failing to build it must not
      // stop the user from being answered.
      rendered = '';
    }
    const parts = [CONFIG.systemInstruction];
    if (rendered) parts.push(rendered);
    if (channel === 'voice') parts.push(CONFIG.spokenInstruction);
    return parts.join('\n\n');
  }

  /**
   * A generation request has no effect on the user's world, so a timeout here
   * is safe to retry — unlike a tool call. The signal is passed down so the
   * HTTP request is actually cancelled rather than left running and billable.
   */
  private async callProvider(
    provider: AIProvider,
    history: ConversationTurn[],
    availableTools: any[],
    deadline: Deadline,
    channel: ReplyChannel = 'text',
    stream?: ReplyStream
  ) {
    /**
     * Every attempt starts the reply over.
     *
     * `retry` may run this more than once, and a failed attempt can have
     * emitted text before it failed. Resetting at the top of each attempt is
     * what keeps a retry from appending a second copy of the reply to half of
     * the first one.
     */
    let sawDelta = false;
    const forward = stream
      ? (text: string) => {
          sawDelta = true;
          stream.delta(text);
        }
      : undefined;

    const response = await retry(
      () =>
        withTimeout(
          (signal) => {
            if (stream) {
              stream.reset();
              sawDelta = false;
            }
            return provider.generateResponse(
              history,
              availableTools,
              this.systemInstruction(channel),
              signal,
              forward
            );
          },
          {
            ms: deadline.clamp(CONFIG.providerTimeoutMs),
            label: 'モデル呼び出し',
            sideEffectUnknown: false,
            signal: deadline.signal,
          }
        ).catch((err) => {
          if (err instanceof TimeoutError) {
            this.onEvent?.({ type: 'provider.timeout', timeoutMs: err.timeoutMs });
          }
          throw err;
        }),
      {
        attempts: CONFIG.providerAttempts,
        label: 'provider',
        signal: deadline.signal,
        onRetry: ({ attempt, attempts, delayMs, error }) =>
          this.onEvent?.({
            type: 'provider.retry',
            attempt,
            attempts,
            delayMs,
              reason: error?.message || String(error),
          }),
      }
    );

    /**
     * A provider with no streaming implementation still owes the caller the
     * same sequence of events. Emitting the finished text once here means the
     * reader sees one shape regardless of which of three vendors answered,
     * and streaming can be added to the others without anything downstream
     * changing.
     */
    if (stream && !sawDelta && response?.content) stream.delta(response.content);
    return response;
  }
}
