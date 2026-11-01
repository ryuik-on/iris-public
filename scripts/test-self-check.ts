/**
 * The live self-checks: what each one calls a failure, and that a throwing check is a failing check.
 *
 * Run: npx tsx scripts/test-self-check.ts
 */
import { runChecks, failuresToFindings, CHECKS } from '../server/core/self_check.js';

let passed = 0;
const failures: string[] = [];
const ok = (name: string, cond: boolean, detail = '') => { if (cond) passed++; else failures.push(`${name} ${detail}`); };

const healthy: Record<string, any> = {
  '/api/health': { status: 'healthy', uptimeSeconds: 900, integrations: [] },
  '/api/usage/cli': {}, '/api/proactive': {}, '/api/calendar?days=2': { events: [] }, '/api/exam/next': {},
  '/api/center': { counts: {}, today: { couldNotRead: [], brief: { title: 't', text: 'x' } }, notices: [], runs: [], selfDev: {} },
  '/api/build': { id: 'abc' },
  '/api/ui/open?peek=1': { conversationId: null, view: null },
  '/api/schedule?days=2': { events: [] },
  '/api/lectures/divergence?days=30': { compared: true },
  '/api/dev/tasks': { tasks: [] }, '/api/delegated/runs': { runs: [] }, '/api/dev/runs/active': { runs: [] },
};
function ctx(overrides: Record<string, any> = {}, extra: Partial<Parameters<typeof runChecks>[0]> = {}) {
  const routes = { ...healthy, ...overrides };
  let pending: any = null;
  return {
    get: async (p: string) => {
      if (p === '/api/ui/open') { const v = pending; pending = null; return v ?? { conversationId: null, view: null }; }
      const v = routes[p];
      if (v instanceof Error) throw v;
      if (v === undefined) throw new Error(`no route ${p}`);
      return v;
    },
    post: async (p: string, body: any) => { if (p === '/api/ui/open') pending = { conversationId: null, view: body.view }; return { ok: true }; },
    now: () => new Date('2026-10-01T10:00:00+09:00'),
    deep: false,
    ...extra,
  };
}
const byName = (rs: Awaited<ReturnType<typeof runChecks>>, n: string) => rs.find((r) => r.name === n)!;

(async () => {
  const good = await runChecks(ctx());
  ok('everything passes on a healthy server', good.every((r) => r.ok), JSON.stringify(good.filter((r) => !r.ok)));
  ok('deep-only checks are skipped by the quick suite', !good.some((r) => r.name === 'external_tools_live'));
  ok('failuresToFindings is empty when all pass', failuresToFindings(good).length === 0);

  const degraded = await runChecks(ctx({ '/api/health': { status: 'degraded', uptimeSeconds: 900, integrations: [{ label: 'iCloud', state: 'error' }], configIssues: [] } }));
  ok('a degraded server fails the health check and names the integration', !byName(degraded, 'health').ok && byName(degraded, 'health').detail.includes('iCloud'));
  const young = await runChecks(ctx({ '/api/health': { status: 'degraded', uptimeSeconds: 30, integrations: [{ label: 'iCloud', state: 'starting' }] } }));
  ok('just after start, integrations still warming up are not a failure', byName(young, 'health').ok);

  const boom = await runChecks(ctx({ '/api/usage/cli': new Error('ECONNRESET') }));
  ok('a throwing read is a failing check', !byName(boom, 'rail_data_fast').ok && byName(boom, 'rail_data_fast').detail.includes('ECONNRESET'));

  const unread = await runChecks(ctx({ '/api/center': { counts: {}, today: { couldNotRead: ['予定: boom'] }, notices: [], runs: [], selfDev: {} } }));
  ok('a centre that could not read its parts fails', !byName(unread, 'center_snapshot').ok);

  const stale = await runChecks(ctx({ '/api/lectures/divergence?days=30': { compared: false, reason: 'no schedule' } }));
  ok('an unrun comparison fails', !byName(stale, 'lecture_divergence').ok);

  const held = await runChecks(ctx({ '/api/ui/open?peek=1': { conversationId: 'abc', view: null } }));
  ok('a deposit someone else made is left alone and not a failure', byName(held, 'ui_deposit_roundtrip').ok);

  const noBrief = await runChecks(ctx({ '/api/center': { counts: {}, today: { couldNotRead: [], brief: null }, notices: [], runs: [], selfDev: {} } }));
  ok('after 07:30 a missing morning brief fails', !byName(noBrief, 'morning_brief_today').ok);
  const early = await runChecks({ ...ctx({ '/api/center': { counts: {}, today: { couldNotRead: [], brief: null }, notices: [], runs: [], selfDev: {} } }), now: () => new Date('2026-10-01T06:00:00+09:00') });
  ok('before 07:30 it is not a failure', byName(early, 'morning_brief_today').ok);

  const orphan = await runChecks(ctx({
    '/api/dev/tasks': { tasks: [{ id: 't1', title: '宙に浮いた', status: 'in_progress', updatedAt: '2026-10-01T00:00:00+09:00' }] },
  }));
  ok('an in-progress task nothing has touched for hours is flagged', !byName(orphan, 'dev_tasks_not_orphaned').ok);
  const live = await runChecks(ctx({
    '/api/dev/tasks': { tasks: [{ id: 't1', title: '動いている', status: 'in_progress', updatedAt: '2026-10-01T00:00:00+09:00' }] },
    '/api/delegated/runs': { runs: [{ handoffId: 't1', state: 'running', startedAt: '2026-10-01T09:50:00+09:00' }] },
  }));
  ok('one with a running run is not', byName(live, 'dev_tasks_not_orphaned').ok);

  const deep = await runChecks(ctx({}, { deep: true, probes: [{ name: 'pubmed', run: async () => 'ok' }, { name: 'jrct', run: async () => { throw new Error('HTTP 503'); } }] }));
  ok('a deep probe that fails is named', !byName(deep, 'external_tools_live').ok && byName(deep, 'external_tools_live').detail.includes('jrct: HTTP 503'));

  const findings = failuresToFindings(deep);
  ok('a failed check becomes a selfcheck finding with a stable key', findings.length === 1 && findings[0].dedupeKey === 'selfcheck:external_tools_live' && findings[0].source === 'selfcheck');
  ok('every check has a unique name', new Set(CHECKS.map((c) => c.name)).size === CHECKS.length);

  console.log(`Self check: ${passed} passed, ${failures.length} failed`);
  if (failures.length) { console.log(failures.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
  console.log('All self check tests passed.');
})();
