/**
 * What IRIS can see of itself: calendar, focus, study, usage, health, and the one-shot summary.
 *
 * Run: npx tsx scripts/test-situation.ts
 */
import { createSituationTools, whatsGoingOn, readCalendar } from '../server/tools/situation.js';
import { RiskLevel } from '../server/core/types.js';

let passed = 0;
const failures: string[] = [];
const eq = (name: string, a: unknown, b: unknown) => { if (JSON.stringify(a) === JSON.stringify(b)) passed++; else failures.push(`${name}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };

const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();

const routes: Record<string, any> = {
  '/api/schedule': { sources: ['google', 'icloud'], events: [
    { title: '終日の予定', start: today, end: today, allDay: true, calendar: 'a' },
    { title: '薬理学', start: `${today}T08:30:00+09:00`, end: `${today}T11:50:00+09:00`, allDay: false, calendar: 'b', location: '教育棟' },
    { title: '遠い予定', start: '2099-01-01T09:00:00+09:00', end: '2099-01-01T10:00:00+09:00', allDay: false, calendar: 'b' },
  ] },
  '/api/focus': { date: today, daysToExam: 18, items: [{ label: '予定', area: 'calendar', title: '1 on 1', due: '2026-10-01T17:00:00+09:00' }] },
  '/api/fdp/tasks': { tasks: [
    { id: 'T2', title: '遅い', status: '進行中', dueInDays: 30, verdict: '順調' },
    { id: 'T1', title: '近い', status: '進行中', dueInDays: -3, verdict: '遅延' },
    { id: 'T3', title: '済み', status: '完了', dueInDays: 1 },
  ] },
  '/api/usage/cli': { claudeLimits: { week: { usedPercent: 54 }, session: { usedPercent: 0 } }, codex: { usedPercent: 49 } },
  '/api/health': { status: 'healthy', activeProvider: 'X', pendingApprovals: 2, configIssues: [], integrations: [{ id: 'a', label: 'A', state: 'ready' }, { id: 'b', label: 'B', state: 'needs_attention', reason: 'r' }] },
  '/api/health/stalls': { stalls: [{ at: new Date().toISOString(), ms: 900 }, { at: '2020-01-01T00:00:00Z', ms: 99999 }] },
  '/api/dev/runs/active': { runs: [] },
  '/api/delegated/runs': { runs: (() => {
    const t = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
    return [
      { id: 'r1', agent: 'claude', state: 'stopped', stopReason: 'completed', usd: 1, startedAt: t(10), handoffId: 'done-task' },
      // 止まったが、同じタスクにその後の完了がある
      { id: 'r2', agent: 'claude', state: 'stopped', stopReason: 'unmeterable', usd: null, startedAt: t(60), handoffId: 'done-task' },
      // 止まって、そのまま。タスクも進行中
      { id: 'r3', agent: 'claude', state: 'stopped', stopReason: 'time_limit', usd: 2, startedAt: t(30), handoffId: 'open-task' },
      // 止まったが、タスクは取りやめ
      { id: 'r4', agent: 'claude', state: 'stopped', stopReason: 'cost_limit', usd: 3, startedAt: t(40), handoffId: 'dropped-task' },
    ];
  })() },
  '/api/dev/tasks': { tasks: [{ id: 'done-task', status: 'in_progress' }, { id: 'open-task', status: 'in_progress' }, { id: 'dropped-task', status: 'abandoned' }] },
  '/api/lectures/divergence': { compared: true, missing: [], moved: [], shifted: [], surplus: [], days: 14 },
  '/api/proactive': { openers: [{ label: '開発', title: 't' }] },
  '/api/exam/next': { title: '薬理学期末試験', date: '2026-10-19', days: 18 },
  '/api/activity': { entries: [{ createdAt: 'x', level: 'info', event: 'context.observed' }, { createdAt: 'y', level: 'warn', event: 'dev.ledger_open_failed', message: 'm' }] },
};
const asked: string[] = [];
const get = async (path: string) => {
  asked.push(path);
  const key = path.split('?')[0];
  if (!(key in routes)) throw new Error(`no route ${key}`);
  return routes[key];
};

(async () => {
  const tools = createSituationTools(get);
  eq('every tool only reads', tools.every((t) => t.riskLevel === RiskLevel.READ), true);

  const cal = await readCalendar(get, today, 2);
  eq('events beyond the window are left out', cal.events.map((e: any) => e.title), ['終日の予定', '薬理学']);
  eq('times are clock times', [cal.events[1].start, cal.events[1].end], ['08:30', '11:50']);

  eq('the read says which sources answered', (await readCalendar(get, today, 2)).read.sources, ['google', 'icloud']);
  eq('a complete read says so', (await readCalendar(get, today, 2)).read.complete, true);
  const partialRead = { ...routes['/api/schedule'], sources: ['icloud'] };
  const getPartial = async (path: string) => (path.startsWith("/api/schedule") ? partialRead : get(path));
  const part: any = await readCalendar(getPartial, today, 2);
  eq('a read without Google is not complete', part.read.complete, false);
  eq('and names what was missing', /google/.test(part.read.note ?? ''), true);

  const gap: any = await tools.find((t) => t.name === 'check_lecture_calendar')!.execute({ days: 999 });
  eq('the lecture check asks for at most 400 days', asked[asked.length - 1], '/api/lectures/divergence?days=400');
  eq('and hands back the machine comparison', gap.missing, []);
  await readCalendar(get, today, 14);
  eq('the number of days asked for is passed on to the calendar', asked[asked.length - 1].endsWith('&days=14'), true);
  await readCalendar(get, today, 100);
  eq('a window longer than the calendar can give is cut to 31 days', asked[asked.length - 1].endsWith('&days=31'), true);

  const study: any = await tools.find((t) => t.name === 'get_study_tasks')!.execute({});
  eq('done tasks are dropped and the nearest due comes first', study.tasks.map((t: any) => t.id), ['T1', 'T2']);

  const usage: any = await tools.find((t) => t.name === 'get_usage')!.execute({});
  eq('usage is the used share', [usage.claude.week, usage.codex.week], [54, 49]);

  const health: any = await tools.find((t) => t.name === 'get_system_health')!.execute({});
  eq('only the stall from the last hour counts', health.stallsLastHour, { count: 1, longestMs: 900 });
  eq('an integration that is not ready is listed', health.integrationsNotReady.map((i: any) => i.id), ['b']);
  routes['/api/health'] = { ...routes['/api/health'], uptimeSeconds: 10 };
  const starting: any = await tools.find((t) => t.name === 'get_system_health')!.execute({});
  eq('just after start, integrations are not counted as problems', [starting.integrationsNotReady.length, starting.startingUp, starting.status], [0, true, 'starting']);
  routes['/api/health'] = { ...routes['/api/health'], uptimeSeconds: 600 };

  const activity: any = await tools.find((t) => t.name === 'get_activity_log')!.execute({});
  eq('internal observations are not listed', activity.entries.map((e: any) => e.event), ['dev.ledger_open_failed']);

  const all: any = await whatsGoingOn(get);
  eq('the summary carries pending approvals', all.pendingApprovals, 2);
  eq('and the next exam', all.nextExam.title, '薬理学期末試験');
  eq('and the waiting conversations', all.waitingConversations.length, 1);
  eq('nothing failed', all.couldNotRead, undefined);
  eq('only the unresolved stop needs attention',
    all.development.lastDay.filter((r: any) => r.needsAttention).map((r: any) => r.id), ['r3']);

  // One source failing must not hide the rest, and must not read as "nothing".
  const partial: any = await whatsGoingOn(async (p) => { if (p.startsWith('/api/focus')) throw new Error('boom'); return get(p); });
  eq('a failed source is named', partial.couldNotRead.some((m: string) => m.includes('今日の優先事項') && m.includes('boom')), true);
  eq('and is null, not empty', partial.focus, null);
  eq('the rest still arrive', partial.pendingApprovals, 2);

  console.log(`Situation: ${passed} passed, ${failures.length} failed`);
  if (failures.length) { console.log(failures.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
  console.log('All situation tests passed.');
})();
