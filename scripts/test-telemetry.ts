/**
 * Development telemetry tests.
 *
 * Almost every assertion here is about the system declining to answer. That is
 * the feature: a per-model scoreboard is easy, and a per-model scoreboard that
 * presents two attempts next to forty as if they were comparable is worse than
 * no scoreboard, because it will be believed.
 *
 * The other theme is cost per *outcome*. A model at half the price that needs
 * three attempts is not cheaper, and only dividing by completions shows that.
 *
 * Run: npm run test:telemetry
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

import { openDatabase } from '../server/services/db.js';
import { TelemetryService } from '../server/core/telemetry_service.js';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail?: string) {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
function eq(name: string, actual: any, expected: any) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, ok, ok ? undefined : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function section(t: string) { console.log(`\n▸ ${t}`); }

const T0 = Date.parse('2026-08-19T09:00:00.000Z');

function seed(db: any) {
  const taskId = randomUUID();
  db.prepare(
    `INSERT INTO development_tasks
       (id, title, goal, success_criteria_json, status, created_at, updated_at)
     VALUES (?, ?, ?, '[]', 'in_progress', ?, ?)`
  ).run(
    taskId, 'telemetry fixture', 'テレメトリ用の固定データ',
    new Date(T0).toISOString(), new Date(T0).toISOString()
  );

  let clock = T0;
  const addRun = (agent: string, role: string, status: string, durationMs = 60_000) => {
    clock += 1000;
    const started = new Date(clock).toISOString();
    const ended = new Date(clock + durationMs).toISOString();
    db.prepare(
      `INSERT INTO agent_runs
         (id, task_id, agent, role, status, handoff_json, started_at, ended_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, '{}', ?, ?, ?, ?)`
    ).run(randomUUID(), taskId, agent, role, status, started, ended, started, ended);
  };

  const addUsage = (model: string, usd: number) => {
    clock += 1000;
    db.prepare(
      `INSERT INTO activity_logs (id, level, event, message, detail_json, created_at)
       VALUES (?, 'info', 'run.usage', NULL, ?, ?)`
    ).run(
      randomUUID(),
      JSON.stringify({ type: 'run.usage', model, usd, usage: {}, calls: 1 }),
      new Date(clock).toISOString()
    );
  };

  return { taskId, addRun, addUsage };
}

function main() {
  const dir = mkdtempSync(join(tmpdir(), 'iris-telemetry-'));
  const db = openDatabase(join(dir, 't.db'));
  const telemetry = new TelemetryService(db);

  try {
    // ---------------------------------------------------------------------
    section('Nothing recorded is reported as nothing known');

    {
      const summary = telemetry.summary();
      eq('no runs means no rows', summary.models.length, 0);
      eq('and nothing decidable', summary.decidable, 0);
      check('with a note that says so plainly', /判断できるだけの試行がありません/.test(summary.note));
    }

    const { addRun, addUsage } = seed(db);

    // ---------------------------------------------------------------------
    section('A thin sample is labelled, not presented as a result');

    {
      addRun('openai:gpt-5.6-terra', 'review', 'succeeded');
      addRun('openai:gpt-5.6-terra', 'review', 'failed');

      const [row] = telemetry.performance({ role: 'review' });
      eq('the attempts are counted', row.attempts, 2);
      eq('and the successes', row.succeeded, 1);
      eq('the rate is computed', row.successRate, 0.5);
      // Computed but flagged: 50% from two runs is one coin flip.
      eq('but the evidence is called insufficient', row.evidence, 'insufficient');
      check('and the note says how many are needed', /5 件以上/.test(row.note));

      const summary = telemetry.summary();
      eq('nothing is decidable yet', summary.decidable, 0);
      check('while the runs are still counted', summary.totalRuns === 2);
    }

    // ---------------------------------------------------------------------
    section('Evidence accumulates, and the label moves with it');

    {
      for (let i = 0; i < 4; i++) addRun('anthropic:claude-opus-5', 'review', 'succeeded');
      addRun('anthropic:claude-opus-5', 'review', 'failed');

      const row = telemetry.performance({ role: 'review' }).find((r) => r.agent === 'anthropic:claude-opus-5')!;
      eq('five attempts reach the first threshold', row.evidence, 'indicative');
      check('and the note warns it is still provisional', /参考値/.test(row.note));
      eq('the rate reflects the runs', row.successRate, 0.8);

      // The rows worth acting on must not sit below the ones that cannot
      // support a decision.
      const ordered = telemetry.performance({ role: 'review' });
      eq('better-evidenced rows sort first', ordered[0].agent, 'anthropic:claude-opus-5');
    }

    // ---------------------------------------------------------------------
    section('Cost is per completed task, not per call');

    {
      // Half the price, but it only finishes half the time.
      addUsage('claude-opus-5', 1.0);
      addUsage('gpt-5.6-terra', 0.5);

      const rows = telemetry.performance({ role: 'review' });
      const opus = rows.find((r) => r.model === 'claude-opus-5')!;
      const terra = rows.find((r) => r.model === 'gpt-5.6-terra')!;

      eq('spend is attributed to the model', opus.usd, 1.0);
      eq('cost per success divides by completions', opus.usdPerSuccess, 0.25);
      eq('so the cheaper model is not the cheaper outcome', terra.usdPerSuccess, 0.5);
      check('which is the opposite of the per-call comparison', terra.usd! < opus.usd!);
    }

    {
      addRun('gemini:gemini-3.6-flash', 'review', 'failed');
      const row = telemetry.performance({ role: 'review' }).find((r) => r.model === 'gemini-3.6-flash')!;
      // Dividing by zero successes would report an infinite cost for a model
      // that has simply not finished anything yet.
      eq('a model with no successes has no cost-per-success', row.usdPerSuccess, null);
    }

    // ---------------------------------------------------------------------
    section('Runs still in flight are not counted against anyone');

    {
      const before = telemetry.performance({ role: 'review' }).find((r) => r.agent === 'anthropic:claude-opus-5')!;
      db.prepare(
        `INSERT INTO agent_runs (id, task_id, agent, role, status, handoff_json, created_at, updated_at)
         SELECT ?, task_id, 'anthropic:claude-opus-5', 'review', 'running', '{}', ?, ?
           FROM agent_runs LIMIT 1`
      ).run(randomUUID(), new Date(T0).toISOString(), new Date(T0).toISOString());

      const after = telemetry.performance({ role: 'review' }).find((r) => r.agent === 'anthropic:claude-opus-5')!;
      // Counting a pending run as a failure punishes a model for being slow to
      // finish rather than for being wrong.
      eq('an unfinished run does not change the attempts', after.attempts, before.attempts);
      eq('nor the success rate', after.successRate, before.successRate);
    }

    // ---------------------------------------------------------------------
    section('Roles are kept apart');

    {
      addRun('anthropic:claude-opus-5', 'implement', 'failed');
      const rows = telemetry.performance();
      const review = rows.find((r) => r.agent === 'anthropic:claude-opus-5' && r.role === 'review')!;
      const implement = rows.find((r) => r.agent === 'anthropic:claude-opus-5' && r.role === 'implement')!;
      // Reviewing and implementing are different jobs; a model good at one is
      // not thereby good at the other.
      check('the same model appears once per role', review.attempts !== implement.attempts);
      eq('and the implement row stands on its own evidence', implement.evidence, 'insufficient');
    }

    // ---------------------------------------------------------------------
    section('Comparison declines when the data cannot support it');

    {
      const thin = telemetry.compare('openai:gpt-5.6-terra', 'anthropic:claude-opus-5', 'review');
      eq('a thin sample yields no winner', thin.better, null);
      check('and the reason names the counts', /試行数が不足/.test(thin.reason));

      const missing = telemetry.compare('nope:a', 'nope:b', 'review');
      eq('unknown models yield no winner', missing.better, null);
      check('and say so', /記録されていません/.test(missing.reason));
    }

    {
      // Both sides now have enough runs, and the gap is real.
      for (let i = 0; i < 5; i++) addRun('openai:gpt-5.6-terra', 'review', 'failed');
      const decided = telemetry.compare('anthropic:claude-opus-5', 'openai:gpt-5.6-terra', 'review');
      eq('with enough evidence a winner is named', decided.better, 'anthropic:claude-opus-5');
      check('with the rates and counts in the reason', /% vs /.test(decided.reason));
    }

    {
      // Two models that differ by less than one run's worth of movement.
      for (let i = 0; i < 5; i++) addRun('x:model-a', 'verify', i < 3 ? 'succeeded' : 'failed');
      for (let i = 0; i < 5; i++) addRun('x:model-b', 'verify', i < 3 ? 'succeeded' : 'failed');
      const tied = telemetry.compare('x:model-a', 'x:model-b', 'verify');
      eq('an identical record produces no winner', tied.better, null);
      check('because the gap is under one run', /試行1件ぶん/.test(tied.reason));
    }

    // ---------------------------------------------------------------------
    section('Robustness');

    {
      db.prepare(
        `INSERT INTO activity_logs (id, level, event, message, detail_json, created_at)
         VALUES (?, 'info', 'run.usage', NULL, 'not json at all', ?)`
      ).run(randomUUID(), new Date(T0).toISOString());
      // A corrupt log line must not take the whole report with it.
      check('a malformed usage row is skipped', telemetry.performance().length > 0);
    }

    {
      const future = telemetry.performance({ sinceIso: '2099-01-01T00:00:00.000Z' });
      eq('a window with nothing in it is empty, not an error', future.length, 0);
    }
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Development telemetry: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('All telemetry tests passed.');
}

main();
