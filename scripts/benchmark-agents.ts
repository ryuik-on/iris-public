/**
 * The same task, given to both agents, measured the same way.
 *
 * Routing work to "whichever agent is better at it" needs a basis, and the
 * evidence on hand does not provide one. What it provides is this:
 *
 *   claude  41,171 output tokens, 4.09M cache reads, $2.34, committed
 *   claude  34,308 output tokens, 2.50M cache reads, $1.52, committed
 *   codex    6,856 output tokens,  203k cache reads, $0.017, did not commit
 *   codex    9,378 output tokens, 1.03M cache reads, $0.05,  did not commit
 *   codex    8,272 output tokens, 2.31M cache reads, $0.072, did not commit
 *
 * Twenty times the price per output token, and four Codex runs that produced
 * nothing durable — for an infrastructure reason fixed on 2026-08-22, not a
 * reason about the model. Reading "Codex is cheap" out of that would be
 * reading a bug as a benchmark.
 *
 * So: run the same specification on both, and record what each one cost, how
 * long it took, whether it committed, and whether the acceptance criteria
 * were met. Judgement of the last one stays with a person — this measures,
 * and it does not score.
 *
 * Run: npx tsx scripts/benchmark-agents.ts <case-file.json>
 */
import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

const PORT = process.env.IRIS_PORT ?? '3002';
const BASE = `http://127.0.0.1:${PORT}`;

interface Case {
  title: string;
  goal: string;
  successCriteria: string[];
  constraints?: string[];
  repo: string;
  /** Minutes to wait before giving up on a run. */
  deadlineMinutes?: number;
}

interface Result {
  agent: string;
  runId: string | null;
  branch: string | null;
  state: string;
  stopReason: string | null;
  usd: number | null;
  elapsedSeconds: number;
  committed: boolean;
  filesChanged: string[];
  refusal: string | null;
}

function api(method: string, path: string, body?: unknown): any {
  const args = ['-s', '--max-time', '60', '-X', method, BASE + path];
  if (body !== undefined) args.push('-H', 'Content-Type: application/json', '-d', JSON.stringify(body));
  const out = execFileSync('curl', args, { encoding: 'utf-8', maxBuffer: 1 << 24 });
  try {
    return JSON.parse(out);
  } catch {
    return { raw: out };
  }
}

function git(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
  } catch {
    return '';
  }
}

async function runOne(spec: Case, agent: 'claude' | 'codex'): Promise<Result> {
  const started = Date.now();
  const base: Result = {
    agent,
    runId: null,
    branch: null,
    state: 'not_started',
    stopReason: null,
    usd: null,
    elapsedSeconds: 0,
    committed: false,
    filesChanged: [],
    refusal: null,
  };

  const task = api('POST', '/api/dev/tasks', {
    title: `${spec.title}（${agent}）`,
    goal: spec.goal,
    repo: spec.repo,
    successCriteria: spec.successCriteria,
    constraints: spec.constraints ?? [],
  });
  if (!task?.task?.id) return { ...base, refusal: task?.error ?? 'タスクを作れませんでした。' };

  /**
   * Dispatched through the tool path rather than `/api/agent/start`, because
   * that is the only one that takes an agent — and because a benchmark that
   * exercises a different code path than the product does is measuring
   * something else.
   */
  const started_ = api('POST', '/api/agent/start', { taskId: task.task.id, repo: spec.repo, agent });
  if (started_?.refused || !started_?.run?.id) {
    return { ...base, refusal: started_?.message ?? JSON.stringify(started_).slice(0, 200) };
  }

  const runId = started_.run.id as string;
  const branch = started_.run.branch as string;
  const deadline = started + (spec.deadlineMinutes ?? 20) * 60_000;

  let run: any = started_.run;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10_000));
    const runs = api('GET', '/api/agent/runs')?.runs ?? [];
    run = runs.find((r: any) => r.id === runId) ?? run;
    if (run.state !== 'running') break;
  }

  const worktree = started_.run.worktree as string | undefined;
  const head = worktree ? git(worktree, ['log', '--oneline', '-1']) : '';
  const baseHead = git(spec.repo, ['rev-parse', '--short', 'HEAD']);
  const committed = Boolean(head) && !head.startsWith(baseHead);
  const files = committed && worktree ? git(worktree, ['show', '--name-only', '--format=', 'HEAD']).split('\n').filter(Boolean) : [];

  return {
    agent,
    runId,
    branch,
    state: run.state ?? 'unknown',
    stopReason: run.stopReason ?? null,
    usd: typeof run.usd === 'number' ? run.usd : null,
    elapsedSeconds: Math.round((Date.now() - started) / 1000),
    committed,
    filesChanged: files,
    refusal: null,
  };
}

async function main() {
  const file = process.argv[2];
  if (!file || !existsSync(file)) {
    console.error('使い方: npx tsx scripts/benchmark-agents.ts <case-file.json>');
    process.exit(1);
  }
  const spec: Case = JSON.parse(readFileSync(file, 'utf-8'));

  console.log(`▸ ${spec.title}`);
  console.log(`  ${spec.goal}`);
  console.log();

  const results: Result[] = [];
  for (const agent of ['claude', 'codex'] as const) {
    console.log(`  ${agent} を起動…`);
    const result = await runOne(spec, agent);
    results.push(result);
    if (result.refusal) {
      console.log(`    拒否: ${result.refusal}`);
      continue;
    }
    console.log(
      `    ${result.state}/${result.stopReason ?? '-'}  ` +
        `$${result.usd?.toFixed(3) ?? '(読めず)'}  ${result.elapsedSeconds}秒  ` +
        `コミット ${result.committed ? 'あり' : 'なし'}  ${result.filesChanged.join(' ') || '-'}`
    );
  }

  const dir = join(process.cwd(), '.iris', 'benchmarks');
  mkdirSync(dir, { recursive: true });
  const out = join(dir, `${Date.now()}-${spec.title.replace(/[^\w一-龠ぁ-んァ-ン]/g, '_').slice(0, 40)}.json`);
  writeFileSync(out, JSON.stringify({ spec, results, at: new Date().toISOString() }, null, 2));
  console.log(`\n  記録: ${out}`);

  /**
   * No winner is declared. Cost and time are measured; whether the work is
   * any good is not something this can see, and a benchmark that pretends
   * otherwise would be the most expensive kind of wrong.
   */
  console.log('\n  ※ 成果の良し悪しは測っていません。枝を読んで人が判断してください。');
}

main();
