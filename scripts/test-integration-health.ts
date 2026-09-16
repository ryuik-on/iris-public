/**
 * Integration health tests.
 *
 * The case that matters is a replay. Between 2026-08-19 13:00 and 08-20 16:16
 * every Google path was dead and `/api/health` said `healthy` the whole time —
 * the check looked at the orchestrator and the schema version, and both were
 * fine. The first command NEXT.md tells the next session to run reported that
 * everything was in order for thirty-one hours.
 *
 * So the first test here is that exact state, and it has to come back
 * degraded. Everything else exists to stop the fix from being worse than the
 * problem: a check that goes red because iCloud was never set up gets ignored,
 * and an ignored health check occupies the place where a real one would go.
 *
 * The distinction the whole module turns on: Google was not erroring. It had
 * been configured, lost its token, and after that was never called — so it
 * produced no error, appeared in no contribution list, and set no lastError.
 * Every existing mechanism keyed on a source that tried and failed. Absence
 * has to be looked for on purpose.
 *
 * Run: npm run test:integration-health
 */
import {
  classify,
  summarize,
  credentialUsable,
  missingFrom,
  IntegrationProbe,
} from '../server/core/integration_health.js';

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

function main() {
  // -----------------------------------------------------------------------
  section('The thirty-one hours that reported healthy');

  {
    // The real state on 2026-08-19 13:00: a client id in .env, no token, and
    // a calendar read in which Google no longer appeared at all.
    const probes: IntegrationProbe[] = [
      {
        id: 'google_calendar',
        label: 'Google カレンダー',
        configured: true,
        answered: false,
        reason: 'トークンがありません。認可が必要です。',
        guidance: '認可をやり直してください。',
      },
      { id: 'icloud_calendar', label: 'iCloud カレンダー', configured: true, answered: true },
    ];

    const summary = summarize(probes);
    check('this is reported as degraded', summary.degraded === true);
    eq('and names what is wrong', summary.failing.map((f) => f.id), ['google_calendar']);
    eq('with a reason a reader can act on', summary.failing[0].reason, 'トークンがありません。認可が必要です。');
    check('the working source is not implicated', summary.integrations.find((i) => i.id === 'icloud_calendar')!.state === 'ready');
  }

  {
    // The same machine after re-authorization.
    const summary = summarize([
      { id: 'google_calendar', label: 'Google カレンダー', configured: true, answered: true },
      { id: 'icloud_calendar', label: 'iCloud カレンダー', configured: true, answered: true },
    ]);
    check('a recovered system is healthy again', summary.degraded === false);
    eq('with nothing failing', summary.failing, []);
  }

  // -----------------------------------------------------------------------
  section('Never configured is not the same as broken');

  {
    const summary = summarize([
      { id: 'icloud_calendar', label: 'iCloud カレンダー', configured: false },
      { id: 'google_calendar', label: 'Google カレンダー', configured: true, answered: true },
    ]);
    // A check that goes red for something nobody set up trains its reader to
    // ignore it, which is worse than not having one.
    check('an unconfigured integration does not degrade anything', summary.degraded === false);
    eq('and is named as not configured', summary.integrations[0].state, 'not_configured');
    check('with no reason invented for it', summary.integrations[0].reason === null);
  }

  // -----------------------------------------------------------------------
  section('Unknown is reported as unknown');

  {
    // Configured, and no cheap way to tell. Reported by name rather than
    // optimistically called ready.
    const report = classify({ id: 'x', label: 'X', configured: true });
    eq('no evidence either way is unknown', report.state, 'unknown');
    check('and says so', (report.reason ?? '').length > 0);
  }

  {
    // "Something is wrong and I cannot say what" is not an actionable report,
    // and raising it as a fault would make the check unreadable.
    const report = classify({ id: 'x', label: 'X', configured: true, answered: false });
    eq('a failure with no reason is downgraded', report.state, 'unknown');
    check('rather than claimed as a fault', report.state !== 'failing');
  }

  {
    const report = classify({
      id: 'x', label: 'X', configured: true, answered: false, reason: '   ',
    });
    eq('and whitespace does not count as a reason', report.state, 'unknown');
  }

  // -----------------------------------------------------------------------
  section('An expiring access token is not a fault');

  {
    // The ordinary state for most of every hour. Treating it as a failure puts
    // the check into a flicker nobody reads.
    const fresh = credentialUsable({ hasToken: true, hasRefreshToken: true, expired: false });
    check('a live token is usable', fresh.usable === true);

    const refreshable = credentialUsable({ hasToken: true, hasRefreshToken: true, expired: true });
    check('an expired one with a refresh token is still usable', refreshable.usable === true);
    check('and needs no reason', refreshable.reason === null);

    const stranded = credentialUsable({ hasToken: true, hasRefreshToken: false, expired: true });
    check('expired with nothing to renew it is not', stranded.usable === false);
    check('and says why', (stranded.reason ?? '').includes('リフレッシュトークン'));

    // 2026-08-19 05:51 produced exactly this: a grant that came back without a
    // refresh token, which then had an hour to live.
    const none = credentialUsable({ hasToken: false, hasRefreshToken: false, expired: false });
    check('no token at all is not usable', none.usable === false);
    check('and points at authorization', (none.reason ?? '').includes('認可'));
  }

  // -----------------------------------------------------------------------
  section('A source that stopped trying leaves no error to find');

  {
    // The detection that did not exist. Google errored nowhere, because it
    // never made a request.
    eq('an expected source absent from a reading is named', missingFrom(['google'], ['icloud', 'cache']), ['google']);
    eq('a source that contributed is not', missingFrom(['google'], ['google', 'icloud']), []);
    // Contributing zero events is not the same as not running: the source
    // still appears in the reading, which is what is being checked.
    eq('several can be missing at once', missingFrom(['google', 'icloud'], ['cache']), ['google', 'icloud']);
    eq('nothing expected means nothing missing', missingFrom([], ['cache']), []);
  }

  {
    // Composed the way the server composes it.
    const summary = summarize([
      {
        id: 'google_calendar',
        label: 'Google カレンダー',
        configured: true,
        // A usable token, and still not running — the weaker signal would have
        // called this ready.
        answered: missingFrom(['google'], ['icloud', 'cache']).length === 0,
        reason: '直近の読み取りに寄与していません。認可はありますが源として動いていません。',
      },
    ]);
    check('a token alone is not taken as evidence of working', summary.degraded === true);
    check('and the reason distinguishes it from a missing credential', summary.failing[0].reason!.includes('寄与していません'));
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Integration health: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('All integration health tests passed.');
}

main();
