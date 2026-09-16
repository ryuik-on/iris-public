import { spawn, ChildProcess } from 'child_process';
import { execFileSync } from 'child_process';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { realpathSync } from 'fs';

import {
  AgentPolicy,
  checkLaunch,
  childEnvironment,
  buildArgv,
  AGENTS,
  asAgentKind,
  looksLikeQuotaExhaustion,
  branchFor,
  binaryFor,
  AgentKind,
  worktreeSetup,
  worktreeCleanup,
  shouldStop,
  describeStop,
  StopReason,
  SLEEP_GAP_MS,
  Refusal,
} from '../core/agent_runner.js';
import {
  findTranscript,
  readTranscript,
  findCodexTranscript,
  readCodexTranscript,
  MeterReading,
} from './agent_meter.js';

/**
 * Runs a coding agent nobody is watching, and stops it.
 *
 * The stopping is the point. Starting a process is four lines; the rest of
 * this file exists because the run happens while the user is asleep, so every
 * limit has to hold without anyone to notice that it did not.
 *
 * The meter runs on a timer rather than at the end. A cost ceiling checked
 * when the process exits is not a ceiling, it is a receipt.
 */

export interface AgentRun {
  id: string;
  /** Which agent ran it. Decides how the run is metered and how it reports. */
  agent: AgentKind;
  repo: string;
  branch: string;
  /** Where the agent actually worked. Never the user's checkout. */
  worktree: string;
  handoffId: string;
  startedAt: string;
  endedAt: string | null;
  state: 'running' | 'stopped';
  stopReason: StopReason | null;
  stopMessage: string | null;
  /**
   * Last successful reading. Null when the meter has never answered.
   *
   * Kept for the record, not for display. Both agents run on subscriptions,
   * so this is a figure computed from token counts at list prices and nothing
   * is charged against it — a reasonable proxy, and not a number to put in
   * front of somebody as though it were money leaving.
   */
  usd: number | null;
  /**
   * Output tokens so far, which is the quantity that is actually spent.
   *
   * The meter has always read this and `AgentRun` threw it away, so the band
   * had nothing to say about a run in flight except a dollar figure that was
   * not true.
   */
  outputTokens: number | null;
  meterReason: string | null;
  /**
   * Which model ran it, as resolved at launch.
   *
   * Recorded even where the tokens cannot be — the third agent files no cost
   * anywhere, and knowing a review went to Opus while a verification went to
   * Flash is most of what the role-based routing needs to be judged on.
   */
  model: string | null;
  inputTokens: number | null;
  cacheReadTokens: number | null;
  exitCode: number | null;
  pid: number | null;
  /** What the agent said. Its own report when it produced one. */
  output?: string | null;
}

export interface AgentProcessOptions {
  policy: AgentPolicy;
  /**
   * Absolute path to the default agent's binary.
   *
   * Kept for the agent chosen by omission. A second agent resolves its own
   * path through `binaryFor`, so repointing one cannot silently repoint the
   * other.
   */
  binary: string;
  /** Where worktrees are created. Outside every allowed repository. */
  worktreeRoot: string;
  home: string;
  onEvent?: (event: { type: string; detail?: Record<string, any> }) => void;
  /** Injected so tests need no clock and no processes. */
  now?: () => number;
  spawnFn?: typeof spawn;
  pollMs?: number;
  /**
   * 実行が始まったとき・終わったときに呼ばれる。**台帳へ書くための口。**
   *
   * `runs` はメモリの `Map` なので、IRIS を起こし直すと走っていた実行ごと
   * 消える。**消えて困るのは監督だけではない** —— `/api/telemetry/models`
   * が「どのモデルも判断できるだけの試行がない」と言い続けていたのは、
   * 委任がどこにも記録されていなかったから（実測 2026-09-08）。
   *
   * 投げるのは実行そのもので、書き方はここでは決めない。**書けなくても
   * 実行は続ける**（呼ぶ側が投げた例外は握りつぶす）。台帳の失敗で走って
   * いる仕事を止めるのは、順番が逆。
   */
  onRunChanged?: (run: AgentRun) => void;
}

const DEFAULT_POLL_MS = 20_000;

export class AgentProcessService {
  private runs = new Map<string, AgentRun>();
  private children = new Map<string, ChildProcess>();
  private timers = new Map<string, NodeJS.Timeout>();
  /** When the meter last answered, per run. */
  private lastMeterOkAt = new Map<string, number>();
  /**
   * When each run was last polled, and how much of its life the machine spent
   * not running.
   *
   * A sleeping Mac does not stop the clock, so every wall-clock check would
   * otherwise report a ten-minute run as having exhausted a two-hour limit.
   */
  private lastPollAt = new Map<string, number>();
  private sleptMs = new Map<string, number>();

  constructor(private options: AgentProcessOptions) {}

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  private emit(type: string, detail?: Record<string, any>) {
    this.options.onEvent?.({ type, detail });
  }

  /**
   * Called when a run ends, with what it cost or null if that could not be
   * read. Separate from `onEvent`, which logs: this one is acted on, and a
   * caller that mistook a missing cost for zero would raise its own ceiling.
   */
  private completedHandlers: Array<(runId: string, usd: number | null) => void> = [];

  /** 台帳へ知らせる。**書けなくても実行は止めない。** */
  private note(run: AgentRun): void {
    try {
      this.options.onRunChanged?.(run);
    } catch {
      // 台帳の失敗で、走っている仕事を止めない。
    }
  }

  onCompleted(handler: (runId: string, usd: number | null) => void): void {
    this.completedHandlers.push(handler);
  }

  list(): AgentRun[] {
    return [...this.runs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  get(id: string): AgentRun | null {
    return this.runs.get(id) ?? null;
  }

  private running(): number {
    return [...this.runs.values()].filter((r) => r.state === 'running').length;
  }

  /**
   * Starts a run, or explains why not.
   *
   * The repository is resolved before the allowlist is consulted, because the
   * allowlist compares resolved paths — a symlink or a `..` that lands inside
   * an allowed directory has to be the same string as the entry, or the check
   * is comparing spelling rather than location.
   */
  start(input: {
    handoffId: string;
    repo: string;
    prompt: string;
    /** Which agent. Defaults to the one that has produced merged work. */
    agent?: AgentKind;
    /**
     * Whether the agent's commands may open sockets — outbound and listening
     * alike, which the sandbox does not separate. Decided by `attendedNetwork`
     * before it gets here; this only carries it to the argv.
     */
    network?: boolean;
    /** Which model, where the agent offers a choice. */
    model?: string;
  }): { run: AgentRun } | { refusal: Refusal } {
    const kind: AgentKind = asAgentKind(input.agent);
    let repo: string;
    try {
      repo = realpathSync(input.repo);
    } catch {
      return { refusal: { code: 'repo_not_allowed', message: `解決できないパスです: ${input.repo}` } };
    }

    const clean = this.workingTreeClean(repo);
    const refusal = checkLaunch(
      { handoffId: input.handoffId, repo, clean, running: this.running() },
      this.options.policy
    );
    if (refusal) {
      this.emit('agent.refused', { repo, code: refusal.code, message: refusal.message });
      return { refusal };
    }

    const id = randomUUID().slice(0, 8);
    const branch = branchFor(id, this.options.policy);
    // Outside the repository, so the agent's directory is never mistaken for
    // the one a person is editing.
    const worktree = join(this.options.worktreeRoot, id);

    try {
      mkdirSync(this.options.worktreeRoot, { recursive: true });
      for (const argv of worktreeSetup(worktree, branch)) {
        execFileSync(argv[0], argv.slice(1), { cwd: repo, stdio: 'pipe' });
      }
    } catch (err: any) {
      return {
        refusal: { code: 'dirty_tree', message: `作業ツリーを作成できません: ${err?.message ?? err}` },
      };
    }

    const startedAtMs = this.now();
    const run: AgentRun = {
      id,
      agent: kind,
      repo,
      branch,
      worktree,
      handoffId: input.handoffId,
      startedAt: new Date(startedAtMs).toISOString(),
      endedAt: null,
      state: 'running',
      stopReason: null,
      stopMessage: null,
      usd: null,
      outputTokens: null,
      meterReason: null,
      model: input.model ?? AGENTS[kind].defaultModel ?? null,
      inputTokens: null,
      cacheReadTokens: null,
      exitCode: null,
      pid: null,
    };
    this.runs.set(id, run);
    this.note(run);
    this.lastMeterOkAt.set(id, startedAtMs);
    this.lastPollAt.set(id, startedAtMs);
    this.sleptMs.set(id, 0);

    const spawnFn = this.options.spawnFn ?? spawn;
    /**
     * Resolved per agent rather than taken from options, so the two cannot be
     * confused for one another. `binary` stays the default agent's path.
     */
    const binary =
      kind === 'claude'
        ? this.options.binary
        : binaryFor(kind, process.env, this.options.home);

    /**
     * Where the commits actually go.
     *
     * A worktree holds a `.git` *file* pointing at the parent repository, and
     * both the per-worktree directory and the shared object store live there.
     * Codex's sandbox has to be told about it explicitly or the agent can edit
     * and never commit — which is what four delegated runs did. Resolved from
     * git rather than assembled as `repo + '/.git'`, because a repository can
     * keep its git directory somewhere else entirely.
     */
    let gitDir: string | undefined;
    try {
      gitDir = execFileSync('git', ['-C', repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
        encoding: 'utf-8',
      }).trim() || undefined;
    } catch {
      // Left undefined: the agent runs without the extra directory and fails
      // to commit loudly, which is better than a path guessed wrong.
      gitDir = undefined;
    }

    const child = spawnFn(
      binary,
      buildArgv(input.prompt, kind, { gitDir, network: input.network, workdir: worktree, model: input.model }),
      {
        // The worktree, not the repository. The person's checkout never moves.
        cwd: worktree,
        // Built, never inherited. IRIS's process holds four providers' keys and
        // an iCloud app password, and a plain spawn would hand over all of them.
        env: childEnvironment(process.env),
        stdio: ['ignore', 'pipe', 'pipe'],
        /**
         * Its own process group, so a stubborn child can be killed with
         * everything it started.
         *
         * `detached: true` would normally also outlive the parent; it does not
         * here because the process is never `unref`'d, so Node keeps it in the
         * parent's lifetime while the group id makes escalation possible.
         */
        detached: true,
      }
    );

    run.pid = child.pid ?? null;
    this.children.set(id, child);

    /**
     * The child's own words, kept.
     *
     * Discarded in the first version, and the cost of that was immediate: a
     * run exited after three seconds and the reason — "Not logged in · Please
     * run /login" — existed only in a pipe nobody read. A failed unattended
     * run that cannot say why is a run nobody can fix in the morning.
     */
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });

    child.on('exit', (code) => {
      // `--output-format json` ends with the agent's own report, including
      // what it actually cost. That is authoritative in a way the transcript
      // is not — but it only arrives at the end, which is why the meter still
      // polls: a cost known when the process exits is a receipt, not a limit.
      const report = parseFinalReport(stdout);
      const run = this.runs.get(id);
      if (run) {
        /**
         * Only Claude Code ends with a report carrying its own cost. Codex
         * emits JSONL events and states no total, so its cost stays whatever
         * the meter last read — which is why the meter is not optional for it.
         */
        if (run.agent !== 'codex' && report?.total_cost_usd !== undefined) run.usd = report.total_cost_usd;
        if (report?.is_error) run.meterReason = String(report.result ?? 'エージェントがエラーで終了しました。');
        else if (code !== 0 && stderr) run.meterReason = stderr.slice(0, 500);
        run.output = (report?.result ? String(report.result) : stdout.slice(-2000)) || null;
      }
      /**
       * A run that ended because the plan was spent is not a run that ended.
       *
       * Recorded apart from `completed` so the record can answer how often the
       * ceiling is actually reached. For the agent whose allowance cannot be
       * read while it runs, the refusal is the only reading there is.
       */
      const spent = looksLikeQuotaExhaustion(`${stderr}\n${run?.output ?? ''}`);
      if (spent) {
        this.emit('agent.quota_exhausted', {
          run: id,
          agent: run?.agent ?? null,
          message: (run?.meterReason || stderr || '').slice(0, 300),
        });
      }
      this.finish(id, spent ? 'quota_exhausted' : 'completed', code ?? null);
    });
    child.on('error', (err: any) => {
      this.emit('agent.spawn_failed', { run: id, message: err?.message });
      this.finish(id, 'stopped_by_user', null);
    });

    const timer = setInterval(() => this.poll(id, startedAtMs), this.options.pollMs ?? DEFAULT_POLL_MS);
    timer.unref?.();
    this.timers.set(id, timer);

    this.emit('agent.started', { run: id, repo, branch, handoff: input.handoffId, pid: run.pid });
    return { run };
  }

  /**
   * One check of time and spend.
   *
   * Exposed so a test can drive it without a clock or a process, and because
   * an interval that can only be observed by waiting is an interval nobody
   * tests.
   */
  poll(id: string, startedAtMs: number): StopReason | null {
    const run = this.runs.get(id);
    if (!run || run.state !== 'running') return null;

    const nowMs = this.now();

    /**
     * How far the wall clock moved since the last poll.
     *
     * The interval is on the order of seconds, so a gap of minutes means the
     * machine was not running — and everything below is a wall-clock
     * difference that a sleep would push past its limit at once.
     */
    const sinceLastPoll = nowMs - (this.lastPollAt.get(id) ?? nowMs);
    const gap = sinceLastPoll > (this.options.pollMs ?? DEFAULT_POLL_MS) * 3 ? sinceLastPoll : 0;
    if (gap > 0) {
      this.sleptMs.set(id, (this.sleptMs.get(id) ?? 0) + gap);
      // The meter cannot have been answering while nothing was running, so it
      // is not held against it either.
      this.lastMeterOkAt.set(id, nowMs);
    }
    this.lastPollAt.set(id, nowMs);

    const reading = this.meter(run, startedAtMs);
    if (reading.usage?.outputTokens !== undefined) run.outputTokens = reading.usage.outputTokens;
    if (reading.usage?.inputTokens !== undefined) run.inputTokens = reading.usage.inputTokens;
    if (reading.usage?.cacheReadTokens !== undefined) run.cacheReadTokens = reading.usage.cacheReadTokens;
    // The model the transcript reports wins over the one asked for: a session
    // can be switched mid-run, and what ran is the fact worth keeping.
    if (reading.model) run.model = reading.model;
    if (reading.usd !== null) {
      run.usd = reading.usd;
      run.meterReason = null;
      this.lastMeterOkAt.set(id, nowMs);
    } else {
      run.meterReason = reading.reason;
    }

    const silentSince = this.lastMeterOkAt.get(id) ?? startedAtMs;
    const reason = shouldStop(
      {
        startedAtMs,
        nowMs,
        usd: reading.usd,
        meterSilentMs: nowMs - silentSince,
        costMetered: AGENTS[run.agent].costMeter === 'transcript',
        largestGapMs: gap,
        sleptMs: this.sleptMs.get(id) ?? 0,
      },
      this.options.policy
    );
    if (reason) this.stop(id, reason);
    return reason;
  }

  /**
   * What this run has spent, read from whichever transcript its agent writes.
   *
   * The two are found differently, and the difference is a real weakness on
   * one side. Claude Code files a transcript under a directory derived from
   * the working directory, so a run's transcript can be identified by *where*
   * it ran. Codex files by date only, so the sole thing separating this run's
   * rollout from another's is the time bound — which is why concurrent Codex
   * runs are a worse idea than concurrent Claude runs, and why the delegation
   * default is one at a time.
   */
  private meter(run: AgentRun, startedAtMs: number): MeterReading {
    /**
     * Some agents file no cost at all. Said here rather than letting the
     * transcript search come back empty and read as a broken meter.
     */
    if (AGENTS[run.agent].costMeter === 'none') {
      return {
        usd: null,
        usage: null,
        model: null,
        messages: 0,
        transcript: null,
        reason: 'このエージェントは費用を記録しません。上限は実行時間です。',
      };
    }

    const transcript =
      run.agent === 'codex'
        ? findCodexTranscript(this.options.home, startedAtMs)
        : findTranscript(this.options.home, run.worktree, startedAtMs);

    if (!transcript) {
      return {
        usd: null,
        usage: null,
        model: null,
        messages: 0,
        transcript: null,
        reason: 'この実行の転記がまだ見つかりません。',
      };
    }
    return run.agent === 'codex' ? readCodexTranscript(transcript) : readTranscript(transcript);
  }

  stop(id: string, reason: StopReason = 'stopped_by_user'): AgentRun | null {
    const run = this.runs.get(id);
    if (!run || run.state !== 'running') return run ?? null;

    const child = this.children.get(id);
    if (child) {
      child.kill('SIGTERM');
      /**
       * Escalation keyed on the process exiting, not on `killed`.
       *
       * `child.killed` means a signal was delivered, not that anything died —
       * it is true the instant SIGTERM is sent, so the guard it was written
       * as (`if (!child.killed) kill('SIGKILL')`) could never fire. A child
       * that ignores SIGTERM went on spending with no ceiling and no meter,
       * while the API reported it stopped. Found by an independent audit on
       * 2026-08-20; the comment describing the case was already here.
       */
      let exited = false;
      child.once('exit', () => { exited = true; });
      const escalate = setTimeout(() => {
        if (exited) return;
        this.emit('agent.sigkill', { run: id, pid: child.pid ?? null });
        try {
          // The negative pid targets the process group, so a shell that spawned
          // its own children does not leave them behind.
          if (child.pid) process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* no group, or already gone */
        }
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }, 5_000);
      escalate.unref?.();
    }
    return this.finish(id, reason, run.exitCode);
  }

  private finish(id: string, reason: StopReason, exitCode: number | null): AgentRun | null {
    const run = this.runs.get(id);
    if (!run || run.state === 'stopped') return run ?? null;

    const timer = this.timers.get(id);
    if (timer) clearInterval(timer);
    this.timers.delete(id);
    this.children.delete(id);
    this.lastPollAt.delete(id);

    run.state = 'stopped';
    run.stopReason = reason;
    run.stopMessage = describeStop(reason, this.options.policy);
    run.endedAt = new Date(this.now()).toISOString();
    run.exitCode = exitCode;

    this.note(run);

    for (const handler of this.completedHandlers) {
      try {
        handler(id, typeof run.usd === 'number' && Number.isFinite(run.usd) ? run.usd : null);
      } catch {
        // A listener must not stop a run from being recorded as finished.
      }
    }

    this.emit(reason === 'completed' ? 'agent.completed' : 'agent.stopped', {
      run: id,
      reason,
      message: run.stopMessage,
      usd: run.usd,
      branch: run.branch,
      repo: run.repo,
      // Left in place deliberately: the diff is the product of the run, and
      // removing the directory before anyone looked at it would discard it.
      worktree: run.worktree,
      failure: run.meterReason,
      // Recorded so 'it hit the time limit' and 'the machine slept' are never
      // the same line in the morning.
      sleptMs: this.sleptMs.get(id) ?? 0,
    });
    return run;
  }

  /** Whether the repository has nothing uncommitted. */
  private workingTreeClean(repo: string): boolean {
    try {
      const out = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf-8' });
      return out.trim().length === 0;
    } catch {
      // A directory git cannot read is not a clean one.
      return false;
    }
  }
}


/**
 * The agent's closing report, from `--output-format json`.
 *
 * Read from the tail rather than parsed as a whole: the stream can carry other
 * lines, and only the final object is the report.
 */
function parseFinalReport(stdout: string): any | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  for (const line of trimmed.split('\n').reverse()) {
    const candidate = line.trim();
    if (!candidate.startsWith('{')) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      /* not the report; keep looking backwards */
    }
  }
  return null;
}
