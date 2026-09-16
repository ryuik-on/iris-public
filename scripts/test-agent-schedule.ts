/**
 * Scheduled agent run tests.
 *
 * This table is what lets work happen overnight without touching the approval
 * boundary. The first design got there by letting IRIS start agents on its own
 * judgement, which collides with two rules the orchestrator holds — a guess may
 * not cause an irreversible act, and anything above READ waits for a person.
 * Queueing sidesteps that instead of punching through it: the user decides
 * while awake, the row is the authorization, and the runner reads it back
 * later. No tool call, no inferred origin, no exception to revoke.
 *
 * So the tests are mostly about the row being trustworthy at 3am, when there
 * is nobody to notice it was not.
 *
 * Run: npm run test:agent-schedule
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { openDatabase } from '../server/services/db.js';
import { AgentScheduleStore } from '../server/services/agent_schedule_sqlite.js';

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

const dir = mkdtempSync(join(tmpdir(), 'iris-sched-'));
const NOW = new Date('2026-08-20T23:00:00+09:00');
const TONIGHT = new Date('2026-08-21T02:00:00+09:00');
const REPO = '/Users/example/Downloads/iris';

function main() {
  const db = openDatabase(join(dir, 's.db'));
  const store = new AgentScheduleStore(db);

  // -----------------------------------------------------------------------
  section('Queueing before bed');

  {
    const { queued, reason } = store.queue(
      { taskId: 'task-1', repo: REPO, dueAt: TONIGHT.toISOString() },
      NOW
    );
    check('a future time is accepted', queued !== null);
    eq('and starts queued', queued!.state, 'queued');
    check('the reason says when', reason.includes('実行します'));
    eq('nothing has run yet', queued!.runId, null);
  }

  {
    // "Later" that turns out to mean "now" is a surprise, and this is not a
    // thing that should ever surprise anyone.
    const past = store.queue({ taskId: 't', repo: REPO, dueAt: '2026-08-20T22:00:00+09:00' }, NOW);
    check('a past time is refused', past.queued === null);
    check('and says why', past.reason.includes('未来'));

    const same = store.queue({ taskId: 't', repo: REPO, dueAt: NOW.toISOString() }, NOW);
    check('so is the current instant', same.queued === null);

    eq('an unparseable time is refused', store.queue({ taskId: 't', repo: REPO, dueAt: 'tonight' }, NOW).queued, null);
    eq('a missing task is refused', store.queue({ taskId: '', repo: REPO, dueAt: TONIGHT.toISOString() }, NOW).queued, null);
    eq('a missing repo is refused', store.queue({ taskId: 't', repo: '', dueAt: TONIGHT.toISOString() }, NOW).queued, null);
  }

  // -----------------------------------------------------------------------
  section('Becoming due');

  {
    const before = store.due(new Date('2026-08-21T01:00:00+09:00'));
    eq('nothing is due before its time', before.length, 0);

    const after = store.due(new Date('2026-08-21T02:00:01+09:00'));
    eq('and it is due afterwards', after.length, 1);
    eq('with the task it was queued for', after[0].taskId, 'task-1');
  }

  {
    // A machine asleep at the due time must still run what was waiting rather
    // than skipping it silently — so eligibility is "due_at has passed", never
    // "due_at is近い".
    const muchLater = store.due(new Date('2026-08-25T09:00:00+09:00'));
    eq('a long-overdue row is still eligible', muchLater.length, 1);
  }

  // -----------------------------------------------------------------------
  section('It cannot start twice');

  {
    const item = store.due(new Date('2026-08-21T03:00:00+09:00'))[0];
    check('the first claim succeeds', store.claim(item.id) === true);
    // Two timers firing together must produce one run, not two agents editing
    // the same branch.
    check('a second claim does not', store.claim(item.id) === false);
    eq('and it is no longer due', store.due(new Date('2026-08-21T03:00:00+09:00')).length, 0);

    store.recordStarted(item.id, 'run-abc');
    eq('the run it became is recorded', store.get(item.id)!.runId, 'run-abc');
    eq('and its state says started', store.get(item.id)!.state, 'started');
  }

  // -----------------------------------------------------------------------
  section('A row that did not run says why');

  {
    const { queued } = store.queue(
      { taskId: 'task-2', repo: REPO, dueAt: '2026-08-22T02:00:00+09:00' },
      NOW
    );
    store.claim(queued!.id);
    // A morning with no branch and no explanation is the same as never having
    // queued anything.
    store.recordFailed(queued!.id, '作業ツリーに未コミットの変更があります。混ざるため実行しません。');

    const settled = store.get(queued!.id)!;
    eq('the state is failed', settled.state, 'failed');
    check('and the reason is readable', settled.note!.includes('未コミット'));
    check('with a time', settled.settledAt !== null);
    eq('it does not come back around', store.due(new Date('2026-08-30T00:00:00+09:00')).find((r) => r.id === queued!.id), undefined);
  }

  // -----------------------------------------------------------------------
  section('Cancelling');

  {
    const { queued } = store.queue(
      { taskId: 'task-3', repo: REPO, dueAt: '2026-08-23T02:00:00+09:00' },
      NOW
    );
    check('a queued row can be cancelled', store.cancel(queued!.id) === true);
    eq('and does not become due', store.due(new Date('2026-08-24T00:00:00+09:00')).find((r) => r.id === queued!.id), undefined);
    check('cancelling twice is not an error, just false', store.cancel(queued!.id) === false);

    // Something already running is not something a cancel can un-start.
    const { queued: other } = store.queue({ taskId: 'task-4', repo: REPO, dueAt: '2026-08-23T03:00:00+09:00' }, NOW);
    store.claim(other!.id);
    check('a started row cannot be cancelled', store.cancel(other!.id) === false);
    eq('and stays started', store.get(other!.id)!.state, 'started');
  }

  // -----------------------------------------------------------------------
  section('It survives a restart');

  {
    // The whole point is that it outlives the hours nobody is watching. A
    // queue held in memory would empty at 2am and look exactly like a night
    // with nothing scheduled.
    const { queued } = store.queue({ taskId: 'task-5', repo: REPO, dueAt: '2026-08-26T02:00:00+09:00' }, NOW);
    db.close();

    const reopened = openDatabase(join(dir, 's.db'));
    const after = new AgentScheduleStore(reopened);
    const found = after.get(queued!.id);
    check('the row is still there', found !== null);
    eq('still queued', found!.state, 'queued');
    eq('and still due at the time it was given', found!.dueAt, new Date('2026-08-26T02:00:00+09:00').toISOString());
    eq('and becomes due normally', after.due(new Date('2026-08-26T03:00:00+09:00')).length, 1);
    reopened.close();
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Agent schedule: ${passed} passed, ${failed} failed`);
  rmSync(dir, { recursive: true, force: true });
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('All agent schedule tests passed.');
}

main();
