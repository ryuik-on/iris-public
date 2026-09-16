/**
 * Development orchestration tests.
 *
 * Covers the state that automation will later depend on: a task with an
 * enforced definition of done, a handoff that carries forward what was already
 * decided and what already failed, run progress that distinguishes "alive" from
 * "advancing", and results that cannot contradict their run's status.
 *
 * Run: npm run test:development
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';

import { openDatabase } from '../server/services/db.js';
import { SqliteDevTaskStore, assessRun, AgentRun } from '../server/services/dev_tasks_sqlite.js';
import { SqliteActivityLogStore } from '../server/services/activity_log_sqlite.js';
import { DevelopmentService, DevTaskNotFoundError, AgentRunNotFoundError } from '../server/core/development_service.js';
import { renderHandoffMarkdown, HANDOFF_VERSION } from '../server/core/handoff.js';
import { readRepositoryState, parsePorcelainPath } from '../server/services/repo_state.js';
import { ToolRegistry } from '../server/tools/registry.js';
import { createDevelopmentTools } from '../server/tools/development.js';
import { createFilesystemTools } from '../server/tools/filesystem.js';
import { Workspace } from '../server/tools/workspace.js';
import { RiskLevel } from '../server/core/types.js';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    failures.push(name + (detail ? ` — ${detail}` : ''));
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function eq(name: string, actual: any, expected: any) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, ok, ok ? undefined : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function section(title: string) {
  console.log(`\n▸ ${title}`);
}

async function expectThrows(name: string, fn: () => any, matcher?: (err: any) => boolean) {
  try {
    await fn();
    check(name, false, 'expected a throw, got none');
  } catch (err: any) {
    check(name, matcher ? matcher(err) : true, `unexpected: ${err?.name}: ${err?.message}`);
  }
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'iris-dev-'));
  const db = openDatabase(join(dir, 'dev.db'));
  const store = new SqliteDevTaskStore(db);
  const activity = new SqliteActivityLogStore(db);
  const registry = new ToolRegistry();
  registry.registerAll(createFilesystemTools(new Workspace({ root: join(dir, 'ws') })));
  const development = new DevelopmentService(store, activity, registry, process.cwd());

  try {
    // ---------------------------------------------------------------------
    section('Task creation and definition of done');

    const task = await development.createTask({
      title: 'Voice Presence MVP',
      goal: 'TTS と push-to-talk による最小の音声対話を実装する',
      successCriteria: [
        'ブラウザから音声で発話できる',
        '応答が音声で返る',
        '既存のチャット永続化を壊さない',
      ],
      scope: 'Mac ブラウザのみ',
      nonGoals: ['ウェイクワード検出', 'iPhone 対応'],
      constraints: ['既存の承認境界を弱めないこと'],
      relevantFiles: ['src/App.tsx', 'server/index.ts'],
    });

    check('a task id is issued', typeof task.id === 'string' && task.id.length > 0);
    eq('the task starts as planned', task.status, 'planned');
    eq('success criteria are stored', task.successCriteria.length, 3);
    eq('non-goals are stored', task.nonGoals, ['ウェイクワード検出', 'iPhone 対応']);

    await expectThrows(
      'a task without success criteria is rejected',
      () => development.createTask({ title: 'x', goal: 'y', successCriteria: [] }),
      (err) => /successCriteria/.test(err.message)
    );
    await expectThrows(
      'a task without a goal is rejected',
      () => development.createTask({ title: 'x', goal: '', successCriteria: ['a'] })
    );
    await expectThrows(
      'an unknown task id is rejected',
      () => development.getTask('nope'),
      (err) => err instanceof DevTaskNotFoundError
    );

    // ---------------------------------------------------------------------
    section('Canonical handoff');

    const repo = await readRepositoryState(process.cwd());
    check('repository state is readable in this repo', repo.available, repo.error);
    check('the branch is reported', typeof repo.branch === 'string' && repo.branch!.length > 0);

    // Regression: trimming the whole porcelain output shifted the first
    // filename by one character, so an agent was handed "ackage.json".
    eq('unstaged change path parses', parsePorcelainPath(' M package.json'), 'package.json');
    eq('staged change path parses', parsePorcelainPath('M  package.json'), 'package.json');
    eq('a de-indented first line still parses', parsePorcelainPath('M package.json'), 'package.json');
    eq('untracked path parses', parsePorcelainPath('?? scripts/new.ts'), 'scripts/new.ts');
    eq('a rename reports the new path', parsePorcelainPath('R  old.ts -> new.ts'), 'new.ts');
    eq('a nested path is intact', parsePorcelainPath(' M server/core/handoff.ts'), 'server/core/handoff.ts');
    // End-to-end against a purpose-built repo, so this does not depend on
    // whatever the IRIS working tree happens to look like when tests run.
    const fixtureRepo = join(dir, 'fixture-repo');
    mkdirSync(fixtureRepo, { recursive: true });
    const gitInit = (args: string[]) => execFileSync('git', args, { cwd: fixtureRepo, stdio: 'pipe' });
    gitInit(['init', '-q']);
    gitInit(['config', 'user.email', 'test@example.com']);
    gitInit(['config', 'user.name', 'test']);
    writeFileSync(join(fixtureRepo, 'package.json'), '{}');
    writeFileSync(join(fixtureRepo, 'alpha.ts'), 'a');
    mkdirSync(join(fixtureRepo, 'nested'), { recursive: true });
    writeFileSync(join(fixtureRepo, 'nested', 'deep.ts'), 'd');
    gitInit(['add', '.']);
    gitInit(['commit', '-qm', 'fixture baseline']);
    // Modify several files; the first porcelain line is the one the old bug ate.
    writeFileSync(join(fixtureRepo, 'package.json'), '{"changed":true}');
    writeFileSync(join(fixtureRepo, 'alpha.ts'), 'changed');
    writeFileSync(join(fixtureRepo, 'nested', 'deep.ts'), 'changed');

    const fixtureState = await readRepositoryState(fixtureRepo);
    check('fixture repository is readable', fixtureState.available, fixtureState.error);
    eq('fixture reports a dirty tree', fixtureState.dirty, true);
    eq(
      'every changed path is reported intact, including the first',
      [...(fixtureState.changedFiles ?? [])].sort(),
      ['alpha.ts', 'nested/deep.ts', 'package.json']
    );
    check(
      'every reported path actually exists on disk',
      (fixtureState.changedFiles ?? []).every((f) => existsSync(join(fixtureRepo, f))),
      JSON.stringify(fixtureState.changedFiles)
    );

    const cleanRepo = join(dir, 'clean-repo');
    mkdirSync(cleanRepo, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: cleanRepo, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 't@e.com'], { cwd: cleanRepo, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: cleanRepo, stdio: 'pipe' });
    writeFileSync(join(cleanRepo, 'a.txt'), 'a');
    execFileSync('git', ['add', '.'], { cwd: cleanRepo, stdio: 'pipe' });
    execFileSync('git', ['commit', '-qm', 'only'], { cwd: cleanRepo, stdio: 'pipe' });
    const cleanState = await readRepositoryState(cleanRepo);
    eq('a clean tree reports no changed files', cleanState.changedFiles, []);
    eq('a clean tree is not dirty', cleanState.dirty, false);

    const notARepo = await readRepositoryState(dir);
    eq('a non-repository fails safely rather than throwing', notARepo.available, false);
    check('the failure reason is recorded', typeof notARepo.error === 'string');

    const handoff = await development.buildHandoff(task.id, 'implement', 'claude-code');
    eq('the handoff is versioned', handoff.handoffVersion, HANDOFF_VERSION);
    eq('the goal is carried', handoff.task.goal, task.goal);
    eq('success criteria are carried', handoff.task.successCriteria.length, 3);
    eq('non-goals are carried', handoff.task.nonGoals.length, 2);
    check('repository state is embedded', handoff.repository.available === true);
    check('safety boundaries are stated', handoff.safetyBoundaries.length >= 5);
    check(
      'the approval invariant is stated to the agent',
      handoff.safetyBoundaries.some((b) => /skipApproval/.test(b))
    );
    check(
      'risky tool names are listed for the agent',
      handoff.safetyBoundaries.some((b) => /write_file/.test(b))
    );
    check('a result schema is required', Object.keys(handoff.requiredOutput.resultSchema).length > 0);
    eq('the role drives the instructions', handoff.requiredOutput.role, 'implement');

    const reviewHandoff = await development.buildHandoff(task.id, 'review', 'gpt-reviewer');
    check(
      'a review handoff asks for independent verification',
      /独立した立場/.test(reviewHandoff.requiredOutput.instructions)
    );
    check(
      'a review handoff does not reuse the implement schema',
      JSON.stringify(reviewHandoff.requiredOutput.resultSchema) !==
        JSON.stringify(handoff.requiredOutput.resultSchema)
    );

    const markdown = renderHandoffMarkdown(handoff);
    check('markdown includes the title', markdown.includes('Voice Presence MVP'));
    check('markdown includes success criteria', markdown.includes('Success Criteria'));
    check('markdown includes the required output schema', markdown.includes('Required Output'));
    check('markdown includes repository state', markdown.includes('Repository State'));
    check('markdown names the branch', markdown.includes(repo.branch!));

    // ---------------------------------------------------------------------
    section('Decisions carry forward');

    await development.appendDecision(task.id, 'TTS は Web Speech API を使う');
    await development.appendDecision(task.id, 'ウェイクワードは今回やらない');
    const withDecisions = await development.buildHandoff(task.id, 'implement', 'claude-code');
    eq('decisions are carried into the handoff', withDecisions.decisionsAlreadyMade.length, 2);
    check(
      'decisions appear in the pasteable form',
      renderHandoffMarkdown(withDecisions).includes('Web Speech API')
    );
    check(
      'the agent is told not to relitigate them',
      renderHandoffMarkdown(withDecisions).includes('再検討しないこと')
    );

    // ---------------------------------------------------------------------
    section('Runs, progress and result capture');

    const run = await development.startRun({ taskId: task.id, agent: 'claude-code', role: 'implement' });
    eq('the run starts running', run.status, 'running');
    eq('the run records its agent', run.agent, 'claude-code');
    check('the handoff given to the run is stored verbatim', run.handoff.task.id === task.id);
    eq('starting a run moves the task to in_progress', development.getTask(task.id).status, 'in_progress');

    const beat = development.heartbeat(run.id, {
      currentStep: 'TTS 配線中',
      milestonesTotal: 4,
      milestonesCompleted: 1,
      confidence: 'medium',
    });
    eq('progress is recorded', beat.assessment.milestones, '1/4');
    eq('estimated progress is derived', beat.assessment.estimatedProgress, 0.25);
    eq('confidence is surfaced', beat.assessment.confidence, 'medium');
    check('a fresh run is not stalled', !beat.assessment.stalled);

    await expectThrows(
      'heartbeating an unknown run is rejected',
      () => development.heartbeat('nope'),
      (err) => err instanceof AgentRunNotFoundError
    );

    const finished = development.recordResult({
      runId: run.id,
      outcome: 'partial',
      summary: 'TTS は動作、push-to-talk は未実装',
      detail: { filesChanged: ['src/App.tsx'], remainingWork: ['push-to-talk'] },
    });
    eq('the run closes as succeeded for a partial outcome', finished.status, 'succeeded');
    eq('the result is attached to the run', finished.results.length, 1);
    eq('the result detail is preserved', finished.results[0].detail.remainingWork, ['push-to-talk']);

    // A failure outcome must not be recordable against a succeeded run.
    const failRun = await development.startRun({ taskId: task.id, agent: 'claude-code', role: 'verify' });
    const failed2 = development.recordResult({
      runId: failRun.id,
      outcome: 'failure',
      summary: '検証に失敗',
    });
    eq('a failure outcome closes the run as failed', failed2.status, 'failed');

    // ---------------------------------------------------------------------
    section('Prior failures reach the next agent');

    const nextHandoff = await development.buildHandoff(task.id, 'implement', 'claude-code');
    check('known failures are carried forward', nextHandoff.knownFailures.length >= 2);
    check(
      'the earlier partial result is included',
      nextHandoff.knownFailures.some((f) => /push-to-talk/.test(f.summary))
    );
    check(
      'the pasteable form warns against repeating them',
      renderHandoffMarkdown(nextHandoff).includes('繰り返さないこと')
    );

    // An independent review found that only the summary reached the next
    // implementer while the specific findings stayed buried in the result.
    const reviewRun = await development.startRun({ taskId: task.id, agent: 'reviewer-model', role: 'review' });
    development.recordResult({
      runId: reviewRun.id,
      outcome: 'partial',
      summary: '概ね妥当だが指摘あり',
      detail: {
        reviewer: 'claude-opus-5',
        findings: [
          { severity: 'critical', location: 'server/x.ts:10', issue: '境界チェックが漏れている', recommendation: 'ガードを追加' },
          { severity: 'low', issue: '命名が不統一' },
        ],
      },
    });

    const afterReview = await development.buildHandoff(task.id, 'implement', 'claude-code');
    eq('review findings reach the next handoff individually', afterReview.reviewFindings.length, 2);
    eq('the critical finding keeps its location', afterReview.reviewFindings[0].location, 'server/x.ts:10');
    eq('and names who raised it', afterReview.reviewFindings[0].reviewer, 'claude-opus-5');
    const reviewMd = renderHandoffMarkdown(afterReview);
    check('the pasteable form lists each finding', /境界チェックが漏れている/.test(reviewMd));
    check('the recommendation is carried too', /ガードを追加/.test(reviewMd));
    check(
      'and the implementer is told to address or justify each',
      /対処するか、対処しない理由/.test(reviewMd)
    );
    eq('completed runs are counted', nextHandoff.currentProgress.completedRuns, 1);

    // ---------------------------------------------------------------------
    section('Stall detection (§44)');

    const liveRun = await development.startRun({ taskId: task.id, agent: 'claude-code', role: 'research' });
    development.heartbeat(liveRun.id, { currentStep: 'reading', milestonesTotal: 2, milestonesCompleted: 0 });

    // A run that keeps beating without advancing is alive but not progressing.
    const stale: AgentRun = {
      ...store.getRun(liveRun.id)!,
      lastHeartbeatAt: new Date().toISOString(),
      lastProgressAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    };
    const staleAssessment = assessRun(stale);
    check('a heartbeat alone does not count as progress', staleAssessment.stalled);
    check('the heartbeat is still recent', (staleAssessment.sinceHeartbeatMs ?? 0) < 5000);
    check('the last progress is old', (staleAssessment.sinceProgressMs ?? 0) > 10 * 60 * 1000);

    const healthy = assessRun({
      ...stale,
      lastProgressAt: new Date().toISOString(),
    });
    check('a genuinely advancing run is not stalled', !healthy.stalled);

    const finishedRun = assessRun({ ...stale, status: 'succeeded' });
    check('a finished run is never reported as stalled', !finishedRun.stalled);

    // Repeated identical progress is not progress.
    development.heartbeat(liveRun.id, { currentStep: 'reading', milestonesTotal: 2, milestonesCompleted: 0 });
    const repeated = store.getRun(liveRun.id)!;
    const advanced = development.heartbeat(liveRun.id, {
      currentStep: 'writing',
      milestonesTotal: 2,
      milestonesCompleted: 1,
    });
    check(
      'an unchanged progress report does not refresh the progress clock',
      repeated.lastProgressAt === store.getRun(liveRun.id)!.lastProgressAt ||
        advanced.lastProgressAt !== repeated.lastProgressAt
    );
    eq('a changed progress report advances milestones', advanced.assessment.milestones, '1/2');

    // ---------------------------------------------------------------------
    section('Runs interrupted by a restart');

    const interruptedTask = await development.createTask({
      title: 'interrupted', goal: 'g', successCriteria: ['c'],
    });
    const liveRun2 = await development.startRun({ taskId: interruptedTask.id, agent: 'a', role: 'review' });
    eq('the run is running before the restart', store.getRun(liveRun2.id)!.status, 'running');

    // A run's progress lives in memory; the row does not. At boot nothing can
    // legitimately be running, so anything that claims to be was interrupted.
    // Counted by identity, not by total: earlier sections in this file leave
    // their own runs open, and a global count would make this assertion lie.
    const reclaimed = store.reconcileOrphanedRuns();
    check(
      'the orphan is reclaimed',
      reclaimed.some((r) => r.id === liveRun2.id),
      `reclaimed ${reclaimed.length}`
    );
    eq('and closed as failed', store.getRun(liveRun2.id)!.status, 'failed');
    check(
      'the reason says it was interrupted, not that it failed on its merits',
      /中断されました/.test(store.getRun(liveRun2.id)!.blockedReason ?? '')
    );

    const orphanResult = store.listResults(liveRun2.id);
    eq('a result records the interruption', orphanResult.length, 1);
    check(
      'and states the outcome is unknown rather than claiming failure',
      /不明/.test(orphanResult[0].summary)
    );
    eq('the result is flagged as orphaned', orphanResult[0].detail.orphaned, true);

    eq('a second reconcile finds nothing left', store.reconcileOrphanedRuns().length, 0);

    // ---------------------------------------------------------------------
    section('Cascade and isolation');

    const doomed = await development.createTask({
      title: 'doomed',
      goal: 'g',
      successCriteria: ['c'],
    });
    const doomedRun = await development.startRun({ taskId: doomed.id, agent: 'a', role: 'implement' });
    development.recordResult({ runId: doomedRun.id, outcome: 'success', summary: 's' });
    store.deleteTask(doomed.id);
    eq('deleting a task cascades its runs', store.listRuns(doomed.id).length, 0);
    eq('deleting a task cascades its results', store.listResults(doomedRun.id).length, 0);
    check(
      'the audit trail of the deleted task survives',
      activity.list({ limit: 500 }).some((e) => e.event === 'dev.result_recorded')
    );

    // ---------------------------------------------------------------------
    section('Chat tools');

    const devTools = new Map(createDevelopmentTools(development).map((t) => [t.name, t]));
    eq('creating a task requires approval', devTools.get('create_development_task')!.riskLevel, RiskLevel.WRITE);
    eq('recording a decision requires approval', devTools.get('record_development_decision')!.riskLevel, RiskLevel.WRITE);
    eq('listing tasks is READ', devTools.get('list_development_tasks')!.riskLevel, RiskLevel.READ);
    eq('generating a handoff is READ', devTools.get('generate_agent_handoff')!.riskLevel, RiskLevel.READ);

    const listed: any = await devTools.get('list_development_tasks')!.execute({});
    check('the tool lists existing tasks', listed.count >= 1);
    check('the tool surfaces stalled run counts', listed.tasks.every((t: any) => 'stalledRuns' in t));

    // Compared before/after rather than against a fixed count, so adding a run
    // elsewhere in this file cannot make the assertion lie.
    const runsBeforeGenerate = development.getTask(task.id).runs.length;
    const generated: any = await devTools.get('generate_agent_handoff')!.execute({
      taskId: task.id,
      role: 'review',
      agent: 'gpt-reviewer',
    });
    eq('the tool returns markdown', generated.format, 'markdown');
    check('the generated handoff is pasteable', generated.handoff.includes('Success Criteria'));
    eq(
      'generating a handoff does not start a run',
      development.getTask(task.id).runs.length,
      runsBeforeGenerate
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Development orchestration: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('All development orchestration tests passed.');
}

main().catch((err) => {
  console.error('\nTest harness crashed:', err);
  process.exit(1);
});
