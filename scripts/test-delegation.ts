/**
 * Approval granted in advance.
 *
 * The assertions that matter are the refusals, and among those the ones where
 * the wrong answer looks like working software: a grant whose numbers are
 * unreadable, a spend that failed to arrive, an expiry that cannot be parsed.
 * Each of those has an obvious lenient answer that would leave the ceiling
 * permanently open while every dispatch still appeared to be governed.
 *
 * Run: npx tsx scripts/test-delegation.ts
 */
import { decideDelegation, defaultGrant, DelegationGrant } from '../server/core/delegation.js';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function section(name: string) {
  console.log(`\n▸ ${name}`);
}

function eq(name: string, actual: any, expected: any) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    failures.push(`${name}: ${JSON.stringify(actual)} ≠ ${JSON.stringify(expected)}`);
    console.log(`  ✗ ${name}: ${JSON.stringify(actual)} ≠ ${JSON.stringify(expected)}`);
  }
}

const NOW = new Date('2026-08-21T10:00:00Z');
const REPO = '/Users/example/Downloads/iris';

const GRANT: DelegationGrant = {
  tool: 'start_coding_agent',
  repos: [REPO],
  dailyUsdCap: 5,
  maxConcurrent: 1,
  expiresAt: '2026-09-20T10:00:00Z',
  grantedAt: '2026-08-21T10:00:00Z',
  note: null,
};

function ask(over: Partial<Parameters<typeof decideDelegation>[0]> = {}) {
  return decideDelegation({
    grant: GRANT,
    tool: 'start_coding_agent',
    repo: REPO,
    origin: 'user',
    spentTodayUsd: 0,
    running: 0,
    now: NOW,
    ...over,
  });
}

function code(v: any): string {
  return v.satisfied ? 'satisfied' : v.code;
}

function main() {
  section('A grant within its limits is enough');

  {
    const v = ask();
    eq('satisfied', v.satisfied, true);
    eq('and says what is left', (v as any).remainingUsd, 5);
    eq('and until when', (v as any).expiresAt, '2026-09-20T10:00:00Z');

    eq('partway through the budget still passes', code(ask({ spentTodayUsd: 4.99 })), 'satisfied');
    eq('and reports the remainder', (ask({ spentTodayUsd: 4.5 }) as any).remainingUsd, 0.5);
  }

  section('Nothing granted means nothing is satisfied');

  {
    eq('no grant at all', code(ask({ grant: null })), 'none');
  }

  section('Scope is stated, not matched');

  {
    eq('a different tool', code(ask({ tool: 'send_email' })), 'tool');
    eq('a repository outside the grant', code(ask({ repo: '/Users/example/other' })), 'repo');

    // The scope is exact paths. A prefix is a different directory, and a
    // pattern here would be a pattern in `allowedRepos` too.
    eq('a path below one in scope', code(ask({ repo: `${REPO}/server` })), 'repo');
    eq('a path above one in scope', code(ask({ repo: '/Users/example/Downloads' })), 'repo');

    eq(
      'a grant scoped to nothing',
      code(ask({ grant: { ...GRANT, repos: [] } })),
      'repo'
    );
  }

  section('A guess cannot spend the grant');

  {
    /**
     * The same rule as FORBIDDEN_FOR_INFERRED, repeated because this is the
     * path that would otherwise route around it. Money and a subprocess are
     * exactly what a wrong guess must not reach unattended.
     */
    eq('inferred is refused', code(ask({ origin: 'inferred' })), 'inferred');
    eq('and an unknown origin is not user', code(ask({ origin: '' })), 'inferred');
    eq('nor is something that merely looks like it', code(ask({ origin: 'user_inferred' })), 'inferred');
  }

  section('A grant ends');

  {
    eq(
      'after its expiry',
      code(ask({ now: new Date('2026-09-20T10:00:01Z') })),
      'expired'
    );
    // The boundary belongs to the refusal: at the stated instant it is over.
    eq(
      'exactly at its expiry',
      code(ask({ now: new Date('2026-09-20T10:00:00Z') })),
      'expired'
    );
    eq(
      'one second before is still live',
      code(ask({ now: new Date('2026-09-20T09:59:59Z') })),
      'satisfied'
    );
  }

  section('The ceilings fire');

  {
    eq('at the daily cap', code(ask({ spentTodayUsd: 5 })), 'budget');
    eq('and beyond it', code(ask({ spentTodayUsd: 12.4 })), 'budget');
    eq('at the concurrency limit', code(ask({ running: 1 })), 'concurrent');
    eq('and beyond it', code(ask({ running: 4 })), 'concurrent');
  }

  section('What is unreadable is not permitted');

  {
    /**
     * The important group. Every one of these has a lenient reading that would
     * leave the grant permanently open — and because the dispatch would still
     * be checked, logged and reported, the failure would look exactly like
     * normal operation.
     */
    eq(
      'a spend that could not be read is over budget, not under',
      code(ask({ spentTodayUsd: NaN })),
      'budget'
    );
    eq(
      'a cap of NaN never fires, so it is malformed',
      code(ask({ grant: { ...GRANT, dailyUsdCap: NaN } })),
      'malformed'
    );
    eq(
      'an infinite cap is not a cap',
      code(ask({ grant: { ...GRANT, dailyUsdCap: Infinity } })),
      'malformed'
    );
    eq('a cap of zero', code(ask({ grant: { ...GRANT, dailyUsdCap: 0 } })), 'malformed');
    eq('a negative cap', code(ask({ grant: { ...GRANT, dailyUsdCap: -1 } })), 'malformed');
    eq(
      'a fractional concurrency limit',
      code(ask({ grant: { ...GRANT, maxConcurrent: 1.5 } })),
      'malformed'
    );
    eq(
      'a concurrency limit of zero',
      code(ask({ grant: { ...GRANT, maxConcurrent: 0 } })),
      'malformed'
    );
    eq(
      'an expiry that cannot be parsed',
      code(ask({ grant: { ...GRANT, expiresAt: 'いつまでも' } })),
      'malformed'
    );
    eq(
      'a running count that could not be read',
      code(ask({ running: NaN })),
      'concurrent'
    );
    eq(
      'repos that is not a list',
      code(ask({ grant: { ...GRANT, repos: null as any } })),
      'malformed'
    );
  }

  section('The order of refusals');

  {
    /**
     * A malformed grant is reported as malformed even when it is also expired
     * and out of scope — the person needs the reason they can act on, and a
     * grant that cannot be read is not fixed by editing its dates.
     */
    eq(
      'unreadable beats everything',
      code(
        ask({
          grant: { ...GRANT, dailyUsdCap: NaN, expiresAt: '2020-01-01T00:00:00Z' },
          tool: 'other',
        })
      ),
      'malformed'
    );
    // And an inferred run is refused before its scope is even consulted, so
    // the answer never suggests that widening the scope would help.
    eq(
      'inferred beats scope',
      code(ask({ origin: 'inferred', tool: 'other', repo: '/elsewhere' })),
      'inferred'
    );
  }

  section('What is offered by default');

  {
    const g = defaultGrant('start_coding_agent', [REPO], NOW);
    eq('one tool', g.tool, 'start_coding_agent');
    eq('one repository', g.repos, [REPO]);
    eq('a small daily cap', g.dailyUsdCap, 5);
    eq('one at a time', g.maxConcurrent, 1);

    // It ends. A grant without an end is a setting, and a setting is what
    // someone turns on in April and has forgotten by August.
    eq('and it expires', g.expiresAt, '2026-09-20T10:00:00.000Z');
    eq('which the decision honours', code(ask({ grant: g })), 'satisfied');
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Delegation: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('All delegation tests passed.');
}

main();
