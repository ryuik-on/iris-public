import {
  SqliteDevTaskStore,
  DevelopmentTask,
  AgentRun,
  AgentResult,
  RunRole,
  CreateTaskInput,
  assessRun,
} from '../services/dev_tasks_sqlite.js';
import { SqliteActivityLogStore } from '../services/activity_log_sqlite.js';
import { readRepositoryState } from '../services/repo_state.js';
import { collectCodeContext } from '../services/code_context.js';
import { buildHandoff, renderHandoffMarkdown, CanonicalHandoff } from './handoff.js';
import { ToolRegistry } from '../tools/registry.js';

export class DevTaskNotFoundError extends Error {
  constructor(public readonly id: string) {
    super(`Development task not found: ${id}`);
    this.name = 'DevTaskNotFoundError';
  }
}

export class AgentRunNotFoundError extends Error {
  constructor(public readonly id: string) {
    super(`Agent run not found: ${id}`);
    this.name = 'AgentRunNotFoundError';
  }
}

export interface RunView extends AgentRun {
  assessment: ReturnType<typeof assessRun>;
  results: AgentResult[];
}

export interface TaskView extends DevelopmentTask {
  runs: RunView[];
  results: AgentResult[];
}

/**
 * Development orchestration, at the level that is honest today.
 *
 * IRIS does not yet invoke coding agents itself — that needs process execution,
 * which is a deliberate separate decision. What it does now is own the state
 * that automation will need: the task and its definition of done, the canonical
 * handoff actually given to an agent, the run's progress, and the structured
 * result. Those are the pieces that currently live only in the user's head and
 * in copy-pasted chat scrollback.
 */
export class DevelopmentService {
  constructor(
    private store: SqliteDevTaskStore,
    private activity: SqliteActivityLogStore,
    private toolRegistry?: ToolRegistry,
    private repoCwd: string = process.cwd()
  ) {}

  // ------------------------------------------------------------------ tasks

  async createTask(input: CreateTaskInput): Promise<DevelopmentTask> {
    const task = this.store.createTask(input);
    this.activity.info('dev.task_created', {
      conversationId: input.conversationId ?? null,
      message: task.title,
      detail: { taskId: task.id, criteria: task.successCriteria.length },
    });
    return task;
  }

  getTask(id: string): TaskView {
    const task = this.store.getTask(id);
    if (!task) throw new DevTaskNotFoundError(id);

    const runs = this.store.listRuns(task.id).map((run) => this.toRunView(run));
    return { ...task, runs, results: runs.flatMap((r) => r.results) };
  }

  listTasks(options: { status?: any; limit?: number } = {}) {
    return this.store.listTasks(options).map((task) => {
      const runs = this.store.listRuns(task.id);
      const active = runs.filter((r) => ['pending', 'running', 'blocked'].includes(r.status));
      return {
        ...task,
        runCount: runs.length,
        activeRuns: active.length,
        stalledRuns: active.filter((r) => assessRun(r).stalled).length,
      };
    });
  }

  updateTask(id: string, patch: any): DevelopmentTask {
    if (!this.store.getTask(id)) throw new DevTaskNotFoundError(id);
    const task = this.store.updateTask(id, patch);
    this.activity.info('dev.task_updated', {
      message: task.title,
      detail: { taskId: task.id, status: task.status },
    });
    return task;
  }

  appendDecision(id: string, decision: string): DevelopmentTask {
    if (!this.store.getTask(id)) throw new DevTaskNotFoundError(id);
    const task = this.store.appendDecision(id, decision);
    // Decision trace (§55): what was settled, and when.
    this.activity.info('dev.decision_recorded', {
      message: decision,
      detail: { taskId: id },
    });
    return task;
  }

  // --------------------------------------------------------------- handoffs

  /**
   * Builds the packet for the next agent. Prior runs and their results are
   * folded in, so a second agent inherits what already failed instead of
   * rediscovering it.
   */
  async buildHandoff(
    taskId: string,
    role: RunRole,
    agent: string,
    options: { includeCode?: boolean } = {}
  ): Promise<CanonicalHandoff> {
    const task = this.store.getTask(taskId);
    if (!task) throw new DevTaskNotFoundError(taskId);

    const priorRuns = this.store.listRuns(taskId).map((run) => ({
      run,
      results: this.store.listResults(run.id),
    }));

    // Code is assembled for review and verification, where judging the
    // implementation is the job. An implement handoff describes work not yet
    // done, so shipping the current source would mostly add cost.
    const wantsCode = options.includeCode ?? (role === 'review' || role === 'verify');
    const codeContext = wantsCode
      ? await collectCodeContext(this.repoCwd, task.relevantFiles)
      : undefined;

    return buildHandoff({
      task,
      role,
      agent,
      repository: await readRepositoryState(this.repoCwd),
      priorRuns,
      toolRegistry: this.toolRegistry,
      codeContext,
    });
  }

  async renderHandoff(
    taskId: string,
    role: RunRole,
    agent: string,
    options: { includeCode?: boolean } = {}
  ): Promise<string> {
    return renderHandoffMarkdown(await this.buildHandoff(taskId, role, agent, options));
  }

  // -------------------------------------------------------------------- runs

  /** Creates a run and stores the exact handoff it was given, for traceability. */
  async startRun(input: { taskId: string; agent: string; role: RunRole }): Promise<RunView> {
    const handoff = await this.buildHandoff(input.taskId, input.role, input.agent);
    const created = this.store.createRun({ ...input, handoff });
    const run = this.store.startRun(created.id);

    // A task with work in flight is in progress, without the user restating it.
    const task = this.store.getTask(input.taskId)!;
    if (task.status === 'planned') this.store.updateTask(task.id, { status: 'in_progress' });

    this.activity.info('dev.run_started', {
      message: `${input.agent} / ${input.role}`,
      detail: { taskId: input.taskId, runId: run.id },
    });

    return this.toRunView(run);
  }

  heartbeat(runId: string, progress?: any): RunView {
    if (!this.store.getRun(runId)) throw new AgentRunNotFoundError(runId);
    return this.toRunView(this.store.heartbeat(runId, progress));
  }

  blockRun(runId: string, reason: string): RunView {
    if (!this.store.getRun(runId)) throw new AgentRunNotFoundError(runId);
    const run = this.store.blockRun(runId, reason);
    this.activity.warn('dev.run_blocked', { message: reason, detail: { runId } });
    return this.toRunView(run);
  }

  /**
   * Captures a structured result and closes the run.
   *
   * The run's terminal status is derived from the reported outcome rather than
   * accepted separately, so a run cannot be recorded as succeeded while its
   * result says it failed.
   */
  recordResult(input: { runId: string; outcome: any; summary: string; detail?: any }): RunView {
    const existing = this.store.getRun(input.runId);
    if (!existing) throw new AgentRunNotFoundError(input.runId);

    this.store.recordResult(input);
    const status = input.outcome === 'failure' ? 'failed' : 'succeeded';
    const run = this.store.finishRun(input.runId, status);

    this.activity.log({
      level: input.outcome === 'failure' ? 'warn' : 'info',
      event: 'dev.result_recorded',
      message: input.summary,
      detail: { runId: input.runId, taskId: existing.taskId, outcome: input.outcome },
    });

    return this.toRunView(run);
  }

  getRun(runId: string): RunView {
    const run = this.store.getRun(runId);
    if (!run) throw new AgentRunNotFoundError(runId);
    return this.toRunView(run);
  }

  /**
   * Runs that are alive but not advancing (§44). Derived on read from progress
   * timestamps, so no background job is required for it to be correct.
   */
  listStalledRuns(): RunView[] {
    return this.store
      .listActiveRuns()
      .map((run) => this.toRunView(run))
      .filter((run) => run.assessment.stalled);
  }

  listActiveRuns(): RunView[] {
    return this.store.listActiveRuns().map((run) => this.toRunView(run));
  }

  private toRunView(run: AgentRun): RunView {
    return { ...run, assessment: assessRun(run), results: this.store.listResults(run.id) };
  }
}
