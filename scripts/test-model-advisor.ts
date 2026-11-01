/**
 * The model advisor: cheapest of the sufficient, never cheapest of the unknown.
 *
 * Run: npx tsx scripts/test-model-advisor.ts
 */
import { adviseModel, profileFromUsageEvents } from '../server/core/model_advisor.js';
import { TelemetryService, type ModelPerformance } from '../server/core/telemetry_service.js';
import { openDatabase } from '../server/services/db.js';
import { SqliteDevTaskStore } from '../server/services/dev_tasks_sqlite.js';
import { DelegatedRunStore } from '../server/services/delegated_runs.js';

let passed = 0;
const failures: string[] = [];
const ok = (name: string, cond: boolean, detail = '') => { if (cond) passed++; else failures.push(`${name} ${detail}`); };

const perf = (agent: string, role: string, attempts: number, rate: number | null): ModelPerformance => ({
  agent, model: agent.includes(':') ? agent.split(':')[1] : agent, role, attempts,
  succeeded: Math.round(attempts * (rate ?? 0)), failed: attempts - Math.round(attempts * (rate ?? 0)),
  successRate: rate, medianDurationMs: null, usd: null, usdPerSuccess: null,
  evidence: attempts >= 20 ? 'reliable' : attempts >= 5 ? 'indicative' : 'insufficient', note: '',
});
const profile = { inputTokens: 20_000, outputTokens: 2_000, cacheReadTokens: 0, cacheCreationTokens: 0, samples: 10 };

{
  const p = profileFromUsageEvents([
    { model: 'a', usage: { inputTokens: 100, outputTokens: 10 } },
    { model: 'b', usage: { inputTokens: 300, outputTokens: 30, cacheReadTokens: 1000 } },
    { model: 'c' },
  ]);
  ok('profile is the mean per usage record, skipping records with no usage', p?.inputTokens === 200 && p?.outputTokens === 20 && p?.samples === 2);
  ok('no records means no profile', profileFromUsageEvents([]) === null);
}

{
  const a = adviseModel({ role: 'review', performance: [perf('openai:gpt-5.6-terra', 'review', 2, 1)], profile });
  ok('too little evidence declines to decide', a.basis === 'insufficient' && a.recommend === null);
  ok('and says what to do instead', a.reason.includes('実績をためて'));
}

{
  const a = adviseModel({
    role: 'review', profile,
    performance: [perf('openai:gpt-5.6-sol', 'review', 25, 0.95), perf('openai:gpt-6.1-sol', 'review', 12, 0.92), perf('openai:gpt-5.6-luna', 'review', 3, 1)],
  });
  ok('picks the cheapest model that is within ten points of the best', a.recommend === 'gpt-6.1-sol', JSON.stringify(a.recommend));
  ok('a perfect but thinly tested model is not trusted', a.recommend !== 'gpt-5.6-luna');
  ok('candidates are ordered by expected cost', a.candidates.every((c, i, l) => i === 0 || l[i - 1].expectedUsd <= c.expectedUsd));
}

{
  const a = adviseModel({
    role: 'implement', profile,
    performance: [perf('openai:gpt-5.6-sol', 'implement', 25, 0.95), perf('openai:gpt-6.1-sol', 'implement', 12, 0.6)],
  });
  ok('a cheaper model that fails too often is not chosen', a.recommend === 'gpt-5.6-sol', JSON.stringify(a.recommend));
}

{
  const a = adviseModel({ role: 'implement', profile, performance: [perf('openai:gpt-6.1-sol', 'implement', 30, 0.5)] });
  ok('when even the best is below the floor, no recommendation', a.recommend === null && a.basis === 'insufficient');
}

{
  const a = adviseModel({
    role: 'review', profile,
    performance: [perf('openai:gpt-6.1-sol', 'review', 12, 0.92), perf('openai:gpt-5.6-sol', 'review', 9, 0.95)],
    among: ['gpt-6.1-sol', 'gpt-5.6-sol', 'gpt-5.6-luna'],
  });
  ok('an unmeasured, much cheaper model is offered as a trial, not a recommendation', a.trial === 'gpt-5.6-luna' && a.recommend === 'gpt-6.1-sol');
}

{
  const a = adviseModel({ role: 'review', profile, performance: [perf('claude-code', 'implement', 15, 0.9)] });
  ok('evidence for another role does not count', a.basis === 'insufficient');
  ok('roles that are unknown to the price table are ignored, not a crash', adviseModel({ role: 'x', profile: null, performance: [], among: ['no-such-model'] }).candidates.length === 0);
}

// ── 委任の実績に、実際に使ったモデル名が残る（始まりでは分からず、終わりに分かる）
{
  const db = openDatabase(':memory:', { wal: false });
  const store = new DelegatedRunStore(db);
  for (let i = 0; i < 6; i++) {
    store.start({ id: `r${i}`, agent: 'claude', model: null, repo: '/r', branch: null, handoffId: null, startedAt: '2026-10-02T01:00:00Z' });
    store.finish(`r${i}`, { stopReason: i === 5 ? 'failed' : 'completed', exitCode: 0, usd: 0.1, endedAt: '2026-10-02T01:05:00Z', model: 'claude-sonnet-5-5' });
  }
  const row: any = db.prepare("SELECT model FROM delegated_runs WHERE id='r0'").get();
  ok('the model seen in the transcript is written when the run finishes', row.model === 'claude-sonnet-5-5');
  store.start({ id: 'k', agent: 'claude', model: 'claude-opus-5-5', repo: '/r', branch: null, handoffId: null, startedAt: '2026-10-02T02:00:00Z' });
  store.finish('k', { stopReason: 'completed', exitCode: 0, usd: 0, endedAt: '2026-10-02T02:01:00Z' });
  ok('a model named at the start is not erased by a finish that does not know it', (db.prepare("SELECT model FROM delegated_runs WHERE id='k'").get() as any).model === 'claude-opus-5-5');
  const performance = new TelemetryService(db).performance({ role: 'delegate' });
  ok('the telemetry now says which model did the delegated work', performance.some((p) => p.agent === 'claude:claude-sonnet-5-5' && p.attempts === 6));
  const a = adviseModel({ role: 'delegate', performance, profile });
  ok('and the advisor can use it: five of six succeeded on an indicative sample', a.basis === 'measured' && a.recommend === 'claude-sonnet-5-5', JSON.stringify([a.basis, a.recommend]));
}

// ── 実装の実行にも、使ったモデルが残る
{
  const db = openDatabase(':memory:', { wal: false });
  const dev = new SqliteDevTaskStore(db);
  const task = dev.createTask({ title: 't', goal: 'g', successCriteria: ['c'] } as any);
  for (let i = 0; i < 6; i++) {
    const run = dev.createRun({ taskId: task.id, agent: 'claude-code', role: 'implement', handoff: {} });
    dev.startRun(run.id);
    if (i < 5) dev.setRunModel(run.id, 'claude-opus-5-5');
    dev.finishRun(run.id, 'succeeded');
  }
  const perf = new TelemetryService(db).performance({ role: 'implement' });
  ok('implement runs with a recorded model are counted under that model', perf.some((p) => p.agent === 'claude-code:claude-opus-5-5' && p.attempts === 5));
  ok('a run with no recorded model stays under the tool name rather than being guessed', perf.some((p) => p.agent === 'claude-code' && p.attempts === 1));
  const a = adviseModel({ role: 'implement', performance: perf, profile });
  ok('and the advisor can then recommend from implement results', a.basis === 'measured' && a.recommend === 'claude-opus-5-5', JSON.stringify([a.basis, a.recommend]));
}

console.log(`Model advisor: ${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log(failures.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
console.log('All model advisor tests passed.');
