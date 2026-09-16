/**
 * Independent review tests.
 *
 * The assertion this file exists for is that "independent" is enforced, not
 * assumed: a model reviewing its own work shares the blind spots that produced
 * the work, so the service must refuse rather than quietly self-review. A
 * review that looks like it happened but did not is worse than no review.
 *
 * Run: npm run test:review
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { openDatabase } from '../server/services/db.js';
import { SqliteDevTaskStore } from '../server/services/dev_tasks_sqlite.js';
import { SqliteActivityLogStore } from '../server/services/activity_log_sqlite.js';
import { DevelopmentService } from '../server/core/development_service.js';
import {
  ReviewService,
  NoIndependentReviewerError,
  ReviewAlreadyRunningError,
  parseReviewReply,
} from '../server/core/review_service.js';
import { AIProvider, AIProviderResponse } from '../server/providers/base.js';

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

function scriptedProvider(id: string, model: string, reply: string): AIProvider & { calls: number } {
  return {
    id,
    vendor: id.split('-')[0],
    name: id,
    currentModel: model,
    calls: 0,
    setModel(m: string) { this.currentModel = m; },
    async generateResponse(): Promise<AIProviderResponse> {
      (this as any).calls++;
      return { content: reply, usage: { inputTokens: 500, outputTokens: 200 } };
    },
  } as any;
}

const GOOD_REVIEW = JSON.stringify({
  outcome: 'partial',
  summary: '概ね妥当だが、エラー処理に見落としがある。',
  findings: [
    { severity: 'high', location: 'server/x.ts:42', issue: 'null チェックが漏れている', recommendation: 'ガードを追加' },
    { severity: 'low', issue: '命名が一貫していない' },
  ],
  unmetCriteria: ['エラー時に安全に失敗する'],
  verifiedCriteria: ['TypeScript が通る', 'ビルドが通る'],
});

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'iris-review-'));
  const db = openDatabase(join(dir, 'r.db'));
  const activity = new SqliteActivityLogStore(db);
  const development = new DevelopmentService(new SqliteDevTaskStore(db), activity);

  try {
    const task = await development.createTask({
      title: 'テスト対象タスク',
      goal: '何かを実装する',
      successCriteria: ['TypeScript が通る', 'ビルドが通る', 'エラー時に安全に失敗する'],
    });

    // ---------------------------------------------------------------------
    section('Independence is enforced, not assumed');

    const anthropic = scriptedProvider('anthropic', 'claude-sonnet-5', GOOD_REVIEW);

    // Only the implementer is configured — self-review must be refused.
    const soloService = new ReviewService(development, activity, { anthropic }, 'anthropic');
    check('a lone provider cannot review', !soloService.canReview());
    eq('no reviewer is offered', soloService.availableReviewers().length, 0);

    await expectThrows(
      'reviewing with only the implementer configured is refused',
      () => soloService.reviewTask(task.id),
      (err) => err instanceof NoIndependentReviewerError
    );
    eq('the implementer was never asked to review itself', anthropic.calls, 0);
    eq('and no review run was recorded', development.getTask(task.id).runs.length, 0);
    check(
      'the refusal explains why rather than just failing',
      activity.list({ limit: 100 }).some((e) => e.event === 'review.refused_not_independent')
    );

    // ---------------------------------------------------------------------
    section('Review with a genuinely different model');

    const gemini = scriptedProvider('gemini', 'gemini-3.6-flash', GOOD_REVIEW);
    const service = new ReviewService(development, activity, { anthropic, gemini }, 'anthropic');

    check('a second provider enables review', service.canReview());
    eq('the implementer is excluded from the reviewer list', service.availableReviewers().map((r) => r.key), ['gemini']);

    const summary = await service.reviewTask(task.id);
    eq('the reviewer is not the implementer', summary.reviewerProvider !== 'anthropic', true);
    eq('the reviewer model is recorded', summary.reviewerModel, 'gemini-3.6-flash');
    eq('the implementer model is recorded alongside it', summary.implementerModel, 'claude-sonnet-5');
    eq('the reviewer was called exactly once', gemini.calls, 1);
    eq('the implementer was still never called', anthropic.calls, 0);

    eq('the outcome is carried through', summary.result.outcome, 'partial');
    eq('findings are captured', summary.result.findings.length, 2);
    eq('the high-severity finding keeps its location', summary.result.findings[0].location, 'server/x.ts:42');
    eq('unmet criteria are captured', summary.result.unmetCriteria, ['エラー時に安全に失敗する']);
    eq('verified criteria are captured', summary.result.verifiedCriteria.length, 2);
    check('a cost is estimated for the review', summary.usd >= 0);

    // ---------------------------------------------------------------------
    section('The review is persisted, not just returned');

    const reviewed = development.getTask(task.id);
    const reviewRuns = reviewed.runs.filter((r) => r.role === 'review');
    eq('a review run is recorded', reviewRuns.length, 1);
    eq('the run names the reviewing model', reviewRuns[0].agent, 'gemini:gemini-3.6-flash');
    eq('the run closed with a result', reviewRuns[0].results.length, 1);
    eq('the stored detail keeps the findings', reviewRuns[0].results[0].detail.findings.length, 2);
    eq('the stored detail names both models', reviewRuns[0].results[0].detail.implementerModel, 'claude-sonnet-5');

    // The next handoff must inherit the findings rather than the user re-explaining.
    const nextHandoff = await development.buildHandoff(task.id, 'implement', 'claude-code');
    check(
      'the next implementer handoff carries the review forward',
      nextHandoff.knownFailures.some((f) => /見落とし/.test(f.summary)),
      JSON.stringify(nextHandoff.knownFailures)
    );

    // ---------------------------------------------------------------------
    section('Choosing among several reviewers');

    const openai = scriptedProvider('openai', 'gpt-4o', GOOD_REVIEW);
    const multi = new ReviewService(development, activity, { anthropic, gemini, openai }, 'anthropic');
    eq('both non-implementers are eligible', multi.availableReviewers().map((r) => r.key).sort(), ['gemini', 'openai']);

    const chosen = await multi.reviewTask(task.id, { reviewerId: 'openai' });
    eq('an explicit reviewer is honoured', chosen.reviewerProvider, 'openai');
    eq('the requested reviewer was the one called', openai.calls, 1);

    // Two models from one vendor is a real second opinion, but a weaker one
    // than two vendors — reported, never conflated.
    const sameVendor = scriptedProvider('anthropic-review', 'claude-opus-5', GOOD_REVIEW);
    const vendorService = new ReviewService(
      development, activity, { anthropic, 'anthropic-review': sameVendor }, 'anthropic'
    );
    check('a second model from the same vendor enables review', vendorService.canReview());
    eq(
      'the same-vendor reviewer is addressable by its registry key, not its class id',
      vendorService.availableReviewers().map((r) => r.key),
      ['anthropic-review']
    );
    const byKey = await vendorService.reviewTask(task.id, { reviewerId: 'anthropic-review' });
    eq('selecting it by key works', byKey.reviewerProvider, 'anthropic-review');
    const sameVendorReview = await vendorService.reviewTask(task.id);
    eq('it is reported as cross_model, not cross_provider', sameVendorReview.independence, 'cross_model');
    eq('the reviewing model differs from the implementer', sameVendorReview.reviewerModel, 'claude-opus-5');

    // Given both, a different vendor is preferred over a same-vendor model.
    const preference = new ReviewService(
      development, activity, { anthropic, 'anthropic-review': sameVendor, gemini }, 'anthropic'
    );
    const preferred = await preference.reviewTask(task.id);
    eq('a different vendor is preferred when available', preferred.independence, 'cross_provider');

    // Same model under a different provider key is still the same model.
    const cloned = scriptedProvider('anthropic-clone', 'claude-sonnet-5', GOOD_REVIEW);
    const clonedService = new ReviewService(
      development, activity, { anthropic, 'anthropic-clone': cloned }, 'anthropic'
    );
    check('the same model under another key is not an independent reviewer', !clonedService.canReview());
    await expectThrows(
      'reviewing with a clone of the implementer is refused',
      () => clonedService.reviewTask(task.id),
      (err) => err instanceof NoIndependentReviewerError
    );
    eq('the clone was never called', cloned.calls, 0);

    await expectThrows(
      'the implementer cannot be requested as its own reviewer',
      () => multi.reviewTask(task.id, { reviewerId: 'anthropic' }),
      (err) => err instanceof NoIndependentReviewerError
    );

    // ---------------------------------------------------------------------
    section('Parsing a reviewer that does not cooperate');

    const fenced = parseReviewReply('了解しました。\n```json\n' + GOOD_REVIEW + '\n```\nご確認ください。');
    eq('JSON inside a fenced block is extracted', fenced.outcome, 'partial');
    eq('and its findings survive the prose around it', fenced.findings.length, 2);

    const prose = parseReviewReply('レビューした結果、特に問題はありませんでした。');
    eq('an unparseable reply is NOT reported as a clean pass', prose.outcome, 'partial');
    check('the parse failure is reported', Boolean(prose.parseError));
    check('the raw reply is preserved rather than discarded', /特に問題は/.test(prose.rawReply));

    const broken = parseReviewReply('{ "outcome": "success", "summary": ');
    eq('malformed JSON does not become a pass', broken.outcome, 'partial');
    check('the JSON error is reported', Boolean(broken.parseError));

    const badOutcome = parseReviewReply(JSON.stringify({ outcome: 'looks-fine', summary: 'ok' }));
    eq('an unrecognised outcome degrades to partial, not success', badOutcome.outcome, 'partial');
    check('and says why', /outcome/.test(badOutcome.parseError ?? ''));

    const clean = parseReviewReply(JSON.stringify({ outcome: 'success', summary: '問題なし', findings: [] }));
    eq('a genuine clean pass is preserved', clean.outcome, 'success');
    check('a clean pass has no parse error', !clean.parseError);

    const junkFindings = parseReviewReply(
      JSON.stringify({ outcome: 'partial', summary: 's', findings: ['文字列', null, { issue: '' }, { issue: '実在する指摘' }] })
    );
    eq('malformed findings are dropped, valid ones kept', junkFindings.findings.length, 1);
    eq('the surviving finding is the real one', junkFindings.findings[0].issue, '実在する指摘');

    // ---------------------------------------------------------------------
    section('The run exists before the caller is told it started');

    const raceTask = await development.createTask({
      title: 'race', goal: 'g', successCriteria: ['c'],
    });
    const raceService = new ReviewService(development, activity, { anthropic, gemini }, 'anthropic');
    const geminiCallsBeforeRace = gemini.calls;

    // The asynchronous endpoint used to answer at its first await, which could
    // land before the row existed — a client polling immediately found nothing.
    const prepared = await raceService.prepareRun(raceTask.id);
    check('the run id is available before any model call', typeof prepared.run.id === 'string');
    check('and the row is already readable', development.getRun(prepared.run.id) !== null);
    eq('the reviewer is decided up front', prepared.selected.key, 'gemini');
    eq('as is the independence level', prepared.independence, 'cross_provider');
    eq('the reviewer has not been called yet', gemini.calls, geminiCallsBeforeRace);

    // A second review while one is in flight is duplicated billing.
    await expectThrows(
      'a duplicate review is refused while one is running',
      () => raceService.prepareRun(raceTask.id),
      (err) => err instanceof ReviewAlreadyRunningError
    );

    const completed = await raceService.executePreparedRun(raceTask.id, prepared);
    eq('the prepared run is the one that executes', completed.runId, prepared.run.id);
    eq('and the reviewer ran exactly once', gemini.calls, geminiCallsBeforeRace + 1);

    // Once finished, a fresh review is allowed again.
    const second = await raceService.prepareRun(raceTask.id);
    check('a new review may start after the first finishes', second.run.id !== prepared.run.id);
    await raceService.executePreparedRun(raceTask.id, second);

    // ---------------------------------------------------------------------
    section('A failing reviewer is recorded, not swallowed');

    const dead: AIProvider = {
      id: 'dead', vendor: 'dead', name: 'dead', currentModel: 'dead-1', setModel() {},
      async generateResponse(): Promise<AIProviderResponse> {
        const e: any = new Error('400 bad request');
        e.status = 400;
        throw e;
      },
    };
    const failing = new ReviewService(development, activity, { anthropic, dead }, 'anthropic');
    const before = development.getTask(task.id).runs.length;
    await expectThrows('a reviewer failure propagates', () => failing.reviewTask(task.id));

    const after = development.getTask(task.id).runs;
    eq('the failed attempt is still recorded as a run', after.length, before + 1);
    const failedRun = after[after.length - 1];
    eq('and the run is closed as failed', failedRun.status, 'failed');
    check('with the reason attached', /呼び出しに失敗/.test(failedRun.results[0].summary));
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Independent review: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('All review tests passed.');
}

main().catch((err) => {
  console.error('\nTest harness crashed:', err);
  process.exit(1);
});
