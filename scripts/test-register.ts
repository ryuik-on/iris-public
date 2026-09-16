/**
 * Future Feature Register tests.
 *
 * The load-bearing assertions are the boundary ones. The register is where
 * IRIS records what it is forbidden to do, so the failure that matters is not
 * "a query returned the wrong rows" — it is IRIS quietly dissolving one of its
 * own constraints while implementing ordinary autonomy features (§27, §16).
 *
 * Run: npm run test:register
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { openDatabase } from '../server/services/db.js';
import {
  SqliteFutureFeatureStore,
  ImmutableFeatureError,
  FeatureNotFoundError,
  IMMUTABLE_STATUSES,
  NON_ACTIONABLE_STATUSES,
} from '../server/services/future_features_sqlite.js';
import { SqliteActivityLogStore } from '../server/services/activity_log_sqlite.js';
import { SqliteDevTaskStore } from '../server/services/dev_tasks_sqlite.js';
import { DevelopmentService } from '../server/core/development_service.js';
import { FutureFeatureService, NonActionableFeatureError } from '../server/core/future_features_service.js';
import { FUTURE_FEATURE_SEED } from '../server/data/future_features_seed.js';
import { createRegisterTools } from '../server/tools/register.js';
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
  const dir = mkdtempSync(join(tmpdir(), 'iris-register-'));
  const db = openDatabase(join(dir, 'r.db'));
  const store = new SqliteFutureFeatureStore(db);
  const activity = new SqliteActivityLogStore(db);
  const development = new DevelopmentService(new SqliteDevTaskStore(db), activity);
  const register = new FutureFeatureService(store, activity, development);

  try {
    // ---------------------------------------------------------------------
    section('Seed data integrity');

    const keys = FUTURE_FEATURE_SEED.map((f) => f.key);
    eq('seed keys are unique', keys.length, new Set(keys).size);
    check('every seed entry states a reason', FUTURE_FEATURE_SEED.every((f) => f.reason.trim().length > 0));
    check('every seed entry cites a source', FUTURE_FEATURE_SEED.every((f) => f.source.trim().length > 0));

    const declaredKeys = new Set(keys);
    const danglingDeps = FUTURE_FEATURE_SEED.flatMap((f) =>
      (f.dependencies ?? []).filter((d) => !declaredKeys.has(d)).map((d) => `${f.key} -> ${d}`)
    );
    eq('no dependency points at a missing entry', danglingDeps, []);

    /**
     * A cycle means neither entry can ever be started.
     *
     * `gmail_integration` depended on `important_communication_engine` and
     * that depended back on `gmail_integration` — by the register's own logic
     * both were permanently unreachable, and the reason field of the first
     * said plainly that Gmail was the prerequisite rather than the dependent.
     * Found by an independent audit on 2026-08-20; nothing here would have
     * noticed, because every dependency resolved to a real entry.
     */
    const graph = new Map(FUTURE_FEATURE_SEED.map((f) => [f.key, f.dependencies ?? []]));
    const cycles: string[] = [];
    const state = new Map<string, 'visiting' | 'done'>();
    const walk = (key: string, path: string[]) => {
      if (state.get(key) === 'done') return;
      if (state.get(key) === 'visiting') {
        cycles.push([...path.slice(path.indexOf(key)), key].join(' → '));
        return;
      }
      state.set(key, 'visiting');
      for (const dep of graph.get(key) ?? []) {
        if (graph.has(dep)) walk(dep, [...path, key]);
      }
      state.set(key, 'done');
    };
    for (const key of graph.keys()) walk(key, []);
    eq('no dependency cycle', cycles, []);

    const result = register.seedFromHandoffs();
    check('seeding inserts the full register', result.inserted === FUTURE_FEATURE_SEED.length, JSON.stringify(result));

    const again = register.seedFromHandoffs();
    eq('re-seeding inserts nothing', again.inserted, 0);
    eq('re-seeding refreshes in place', again.updated, FUTURE_FEATURE_SEED.length);

    // ---------------------------------------------------------------------
    section('Three axes stay separate (§28/§29)');

    // A fixture rather than a real entry. Pinning this to whatever the seed
    // happens to hold made the test fail the moment an audit corrected the
    // seed — which is the register working, not a regression. The behaviour
    // under test is that the axes are independent, not what any one feature
    // currently says.
    register.create({
      key: 'axis_fixture',
      title: '三軸の独立性を確かめるための固定データ',
      domain: 'test',
      status: 'PLANNED',
      reality: 'REPORTED_BUT_NOT_FOUND',
      verification: 'NONE',
      reason: '過去に実装報告があったが、監査で見つからなかった状態を表す。',
      source: 'test fixture',
    });
    const fixture = register.get('axis_fixture');
    eq('intent can be PLANNED', fixture.status, 'PLANNED');
    eq('while reality is REPORTED_BUT_NOT_FOUND', fixture.reality, 'REPORTED_BUT_NOT_FOUND');
    eq('and verification is separate again', fixture.verification, 'NONE');
    check(
      'a single column could not express all three',
      new Set([fixture.status, fixture.reality, fixture.verification]).size === 3
    );

    // Written against a fixture rather than against google_calendar, which is
    // what this asserted until the integration was built and the test failed
    // for being right. An entry's state is data that moves; the rule that an
    // unbuilt thing is PLANNED and NOT_IMPLEMENTED is what this file is for.
    // Pinning a test to a live row means the register cannot be updated
    // without breaking the suite, which teaches whoever hits it to change the
    // register back.
    register.create({
      key: 'unbuilt_fixture',
      title: '未着手の統合',
      domain: 'test',
      status: 'PLANNED',
      reality: 'NOT_IMPLEMENTED',
      verification: 'NONE',
      reason: '着手していない統合の状態を表す。',
      source: 'test fixture',
    });
    const unbuilt = register.get('unbuilt_fixture');
    eq('an unbuilt integration is PLANNED', unbuilt.status, 'PLANNED');
    eq('and simply not implemented', unbuilt.reality, 'NOT_IMPLEMENTED');
    // Not REPORTED_BUT_NOT_FOUND, which is a different claim: that someone
    // said it was done. Without a report behind it that reading is an
    // accusation with no accuser — the correction made to google_calendar on
    // 2026-08-19, before it was actually built.
    check('and is not accused of having been falsely reported', unbuilt.reality !== 'REPORTED_BUT_NOT_FOUND');

    // The shape of a completed entry, checked across every completed entry
    // rather than through one named row.
    const completed = register.list({ status: 'COMPLETED' });
    check('there is completed work to check', completed.length > 0);
    check(
      'completed work always cites evidence',
      completed.every((f: any) => (f.evidence ?? []).length > 0),
      completed.filter((f: any) => (f.evidence ?? []).length === 0).map((f: any) => f.key).join(', ')
    );
    check(
      'and never claims completion while recording no verification',
      completed.every((f: any) => f.verification !== 'NONE'),
      completed.filter((f: any) => f.verification === 'NONE').map((f: any) => f.key).join(', ')
    );
    // Any claim of having *checked* something has to say what was checked.
    //
    // `model_lifecycle_registry` claimed RUNTIME_VERIFIED with an empty
    // evidence list, and nothing caught it because the existing check only
    // looked at COMPLETED entries. A verification level is a claim about work
    // that was done; without a pointer to the work it is an assertion.
    //
    // DESIGNED is deliberately exempt: it means designed and not built, so
    // there is nothing to cite and demanding a citation would push people to
    // invent one.
    const CHECKED = ['UNIT_VERIFIED', 'RUNTIME_VERIFIED', 'REAL_WORLD_VERIFIED'];
    const claiming = register.list({}).filter((f: any) => CHECKED.includes(f.verification));
    check('entries claiming verification exist', claiming.length > 0);
    check(
      'and every one of them cites what was verified',
      claiming.every((f: any) => (f.evidence ?? []).length > 0),
      claiming.filter((f: any) => (f.evidence ?? []).length === 0).map((f: any) => f.key).join(', ')
    );

    check(
      'nor claims completion for something not present',
      completed.every((f: any) => f.reality === 'VERIFIED_PRESENT'),
      completed.filter((f: any) => f.reality !== 'VERIFIED_PRESENT').map((f: any) => f.key).join(', ')
    );

    const handoffBuilder = register.get('claude_handoff_builder');
    eq('a previously-missing component now resolves as present', handoffBuilder.reality, 'VERIFIED_PRESENT');
    check('and says so explicitly', /REPORTED_BUT_NOT_FOUND/.test(handoffBuilder.notes ?? ''));

    // ---------------------------------------------------------------------
    section('Boundaries cannot be dissolved (§27, §16)');

    const prohibited = register.list({ status: 'PROHIBITED' });
    check('prohibitions are recorded', prohibited.length >= 10, `${prohibited.length}`);
    check(
      'automatic money movement is among them',
      prohibited.some((f) => f.key === 'auto_money_movement')
    );
    check(
      'LINE auto-reply is among them',
      prohibited.some((f) => f.key === 'line_auto_reply')
    );

    await expectThrows(
      'a prohibition cannot be downgraded to PLANNED',
      () => register.update('auto_money_movement', { status: 'PLANNED' }),
      (err) => err instanceof ImmutableFeatureError
    );
    eq('and it stays prohibited', register.get('auto_money_movement').status, 'PROHIBITED');

    await expectThrows(
      'a prohibition cannot be marked COMPLETED',
      () => register.update('cvv_persistence', { status: 'COMPLETED' }),
      (err) => err instanceof ImmutableFeatureError
    );
    await expectThrows(
      'an out-of-scope item cannot be reopened',
      () => register.update('etax_auto_submission', { status: 'PLANNED' }),
      (err) => err instanceof ImmutableFeatureError
    );
    await expectThrows(
      'a prohibition cannot be deleted',
      () => store.delete('auto_bank_transfer'),
      (err) => err instanceof ImmutableFeatureError
    );
    check('it survives the deletion attempt', register.get('auto_bank_transfer') !== null);

    // Sharpening the reason for a prohibition is fine; lifting it is not.
    const sharpened = register.update('auto_borrowing', {
      reason: 'HARD SAFETY CONSTITUTION。自律性が高まっても維持する。',
    });
    eq('a prohibition stays prohibited when its reason is edited', sharpened.status, 'PROHIBITED');
    check('but the reason did update', /自律性/.test(sharpened.reason));

    // ---------------------------------------------------------------------
    section('Boundaries cannot become work');

    for (const key of ['auto_money_movement', 'etax_auto_submission']) {
      await expectThrows(
        `${key} cannot be promoted to a task`,
        () => register.promoteToTask(key),
        (err) => err instanceof NonActionableFeatureError
      );
    }

    // A fixture, for the reason the axis fixture above already documents.
    //
    // This was pinned to `coding_agent_invocation`, then to
    // `shell_command_tool`, and both stopped being decision-pending on
    // 2026-08-20 when the user actually decided them — the register working,
    // not a regression, and a test failure both times. The rule under test is
    // that EXPLICIT_DECISION_REQUIRED blocks promotion, not which feature
    // happens to hold that status this week.
    register.create({
      key: 'decision_pending_fixture',
      title: '利用者の判断待ちを表す固定データ',
      domain: 'test',
      status: 'EXPLICIT_DECISION_REQUIRED',
      reality: 'NOT_IMPLEMENTED',
      verification: 'NONE',
      reason: '判断待ちの項目が昇格を拒否されることを確かめるための固定データ。',
      source: 'test fixture',
    });
    await expectThrows(
      'a decision-pending item cannot be promoted without a human decision',
      () => register.promoteToTask('decision_pending_fixture'),
      (err) => err instanceof NonActionableFeatureError && /明示的/.test(err.message)
    );

    eq('no task was created by any refused promotion', development.listTasks().length, 0);
    check(
      'each refusal is recorded for audit',
      activity.list({ limit: 500 }).filter((e) => e.event === 'register.promotion_refused').length >= 3
    );

    check(
      'every non-actionable status is genuinely refused',
      NON_ACTIONABLE_STATUSES.every((s) => register.list({ status: s }).length >= 0)
    );
    check(
      'immutable statuses are a subset of non-actionable ones',
      IMMUTABLE_STATUSES.every((s) => NON_ACTIONABLE_STATUSES.includes(s))
    );

    // ---------------------------------------------------------------------
    section('Legitimate promotion');

    const { feature, task } = await register.promoteToTask('voice_presence_mvp');
    eq('a planned feature can become work', feature.status, 'CURRENT');
    check('the task carries the recorded reason as its goal', task.goal === feature.reason);
    check('a definition of done is generated', task.successCriteria.length >= 2);
    eq('the task exists', development.listTasks().length, 1);

    // Uses the fixture for the same reason: the rule is about the reality
    // value, not about which feature holds it this week.
    const { task: auditTask } = await register.promoteToTask('axis_fixture');
    check(
      'a feature whose reality is unverified is told to re-check the repository first',
      auditTask.successCriteria.some((c) => /リポジトリ実態/.test(c)),
      JSON.stringify(auditTask.successCriteria)
    );

    const { task: custom } = await register.promoteToTask('voice_experience_details', {
      successCriteria: ['独自の条件'],
    });
    eq('explicit success criteria win', custom.successCriteria, ['独自の条件']);

    // ---------------------------------------------------------------------
    section('Review cycle (§31)');

    // Freshly seeded, so nothing has aged yet. "Never reviewed" is not the
    // same as "neglected" — an entry written today has not been ignored, and
    // a report that names everything forever is one nobody opens twice.
    const due = register.dueForReview();
    eq('nothing written today is already overdue', due.length, 0);

    // A window of zero days means everything, which is how the rule is
    // checked without waiting ninety days for the test to become meaningful.
    const everything = register.dueForReview(0);
    check('with a zero-day window, unreviewed entries surface', everything.length > 0);
    check(
      'prohibitions are never surfaced for review',
      !everything.some((f) => IMMUTABLE_STATUSES.includes(f.status))
    );

    // The other half of the review: a deferral goes stale when the thing it
    // waited for happens, not when time passes.
    const unblocked = register.unblockedDeferrals();
    check(
      'a deferral whose dependencies all completed is surfaced',
      unblocked.every((f) => f.dependencies.length > 0)
    );
    check('completed work is not surfaced for review', !due.some((f) => f.status === 'COMPLETED'));

    const reviewed = register.markReviewed('receipt_ocr', '必要性はまだ発生していない');
    check('review is timestamped', typeof reviewed.lastReviewedAt === 'string');
    eq('reviewing does not change status', reviewed.status, 'DEFERRED');
    check(
      'a freshly reviewed entry drops off the due list',
      !register.dueForReview().some((f) => f.key === 'receipt_ocr')
    );
    check(
      'but it returns once the window passes',
      register.dueForReview(30, Date.now() + 31 * 24 * 60 * 60 * 1000).some((f) => f.key === 'receipt_ocr')
    );
    check(
      'a zero-day window makes everything due, regardless of clock ticks',
      register.dueForReview(0).some((f) => f.key === 'receipt_ocr')
    );

    // ---------------------------------------------------------------------
    section('Answering "what is deferred, and why"');

    const ocr = register.get('receipt_ocr');
    eq('OCR is deferred', ocr.status, 'DEFERRED');
    check('with a stated reason', /技術的に可能というだけ/.test(ocr.reason));
    check('and a resume condition', /必要性が発生/.test(ocr.resumeCondition ?? ''));

    // The rule, not the example. An earlier version asserted that some BLOCKED
    // entry mentioned an API key, which broke the moment that particular entry
    // was unblocked — the register working, read as a regression.
    const blocked = register.list({ status: 'BLOCKED' });
    check(
      'every blocked entry states what it is waiting on',
      blocked.every((f) => (f.resumeCondition ?? '').length > 0 || f.reason.length > 0),
      blocked.map((f) => f.key).join(', ')
    );
    check(
      'and none of them is blocked without saying why',
      blocked.every((f) => f.reason.trim().length > 10),
      blocked.map((f) => `${f.key}: ${f.reason}`).join(' | ')
    );

    // Search is a keyword match over the whole entry, so it finds anything
    // that merely mentions the word — an unrelated entry whose notes said
    // "gviz CSV" broke the version of this that asserted a property of every
    // hit. The rule being tested is about the finance adapters, so it is
    // asked about the finance adapters.
    const found = register.search('CSV');
    check('search finds the finance adapters', found.length >= 3, `${found.length}`);

    // Named rather than prefix-matched, for the same reason the comment above
    // gives. `finance_import_csv` — the base importer, built 2026-08-20 —
    // shares the prefix and does exist, so a prefix filter started asserting
    // that a working feature was unimplemented. The rule is about the
    // per-institution adapters, which is a list, so it is written as one.
    const ADAPTERS = ['finance_csv_jcb', 'finance_csv_pocket_card', 'finance_csv_sbi_shinsei'];
    const adapters = ADAPTERS.map((key) => register.get(key));
    eq('all three adapters are registered', adapters.length, 3);
    check('and search finds them', ADAPTERS.every((key) => found.some((f) => f.key === key)));
    check(
      'and none of them claims to exist',
      adapters.every((f) => f.reality === 'REPORTED_BUT_NOT_FOUND' || f.reality === 'NOT_IMPLEMENTED'),
      adapters.map((f) => `${f.key}=${f.reality}`).join(', ')
    );

    // ---------------------------------------------------------------------
    section('Register tools');

    const tools = new Map(createRegisterTools(register).map((t) => [t.name, t]));
    check(
      'reading the register never requires approval',
      ['list_future_features', 'get_future_feature', 'search_future_features',
       'list_safety_boundaries', 'list_features_due_for_review']
        .every((n) => tools.get(n)!.riskLevel === RiskLevel.READ)
    );
    eq('adding an entry is a WRITE', tools.get('add_future_feature')!.riskLevel, RiskLevel.WRITE);
    check(
      'there is deliberately no tool for lifting a prohibition',
      ![...tools.keys()].some((n) => /remove|delete|unprohibit|allow/.test(n)),
      [...tools.keys()].join(', ')
    );

    const boundaryTool: any = await tools.get('list_safety_boundaries')!.execute({});

    // Compared against the register, not against a number.
    //
    // This asserted `count >= 18` and broke the moment a decision was made —
    // the third assertion in this file pinned to how many entries happened to
    // hold a status that week, after `coding_agent_invocation` and
    // `shell_command_tool`. The rule is that the tool reports every
    // non-actionable entry and invents none, which is a comparison rather than
    // a count.
    const expected = register.boundaries().map((f) => f.key).sort();
    eq('the boundary tool reports every boundary', boundaryTool.count, expected.length);
    check('and there is at least one to report', expected.length > 0);
    check(
      'every non-actionable entry appears',
      expected.every((key) => JSON.stringify(boundaryTool).includes(key)),
      expected.join(', ')
    );
    check(
      'and every status it reports is a non-actionable one',
      register.boundaries().every((f) => NON_ACTIONABLE_STATUSES.includes(f.status))
    );
    check('and states they cannot be changed by IRIS', /変更できません/.test(boundaryTool.note));

    const addStatuses = (tools.get('add_future_feature')!.schema.properties as any).status.enum;
    check(
      'the add tool cannot create a boundary status',
      !addStatuses.includes('PROHIBITED') && !addStatuses.includes('OUT_OF_SCOPE'),
      addStatuses.join(', ')
    );

    const added: any = await tools.get('add_future_feature')!.execute({
      key: 'idea_from_chat',
      title: '会話中に出たアイデア',
      domain: 'ideas',
      status: 'DEFERRED',
      reason: '今は実装しないが忘れたくない',
    });
    eq('an idea can be captured from chat', added.status, 'DEFERRED');
    check('and is retrievable afterwards', register.get('idea_from_chat').title === '会話中に出たアイデア');

    await expectThrows(
      'an entry without a reason is rejected',
      () => register.create({ key: 'x', title: 'x', domain: 'x', status: 'PLANNED', reason: '  ', source: 't' }),
      (err) => /reason/.test(err.message)
    );
    await expectThrows(
      'an unknown key is reported',
      () => register.get('does_not_exist'),
      (err) => err instanceof FeatureNotFoundError
    );

    // ---------------------------------------------------------------------
    section('Seeding does not overwrite decisions');

    register.update('receipt_ocr', { status: 'NEXT', reason: 'ユーザーが必要と判断した' });
    register.seedFromHandoffs();
    eq(
      'a moved entry is not dragged back by re-seeding',
      register.get('receipt_ocr').status,
      'NEXT'
    );
    check('and keeps its updated reason', /ユーザーが必要と判断/.test(register.get('receipt_ocr').reason));
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Future Feature Register: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('All register tests passed.');
}

main().catch((err) => {
  console.error('\nTest harness crashed:', err);
  process.exit(1);
});
