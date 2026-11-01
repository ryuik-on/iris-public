/**
 * The tools that move things: calendar events, opening targets, and writing under the home directory.
 * Every one of them is behind the approval screen; these tests pin what each will and will not do.
 *
 * Run: npx tsx scripts/test-actions.ts
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createActionTools } from '../server/tools/actions.js';
import { createFilesystemTools } from '../server/tools/filesystem.js';
import { Workspace, WorkspaceAccessError } from '../server/tools/workspace.js';
import { RiskLevel } from '../server/core/types.js';

let passed = 0;
const failures: string[] = [];
const ok = (name: string, cond: boolean, detail = '') => { if (cond) passed++; else failures.push(`${name} ${detail}`); };
const eq = (name: string, a: unknown, b: unknown) => ok(name, JSON.stringify(a) === JSON.stringify(b), `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
async function rejects(name: string, f: () => Promise<unknown>, pattern: RegExp) {
  try { await f(); failures.push(`${name}: did not throw`); }
  catch (err: any) { ok(name, pattern.test(err?.message ?? ''), `wrong error: ${err?.message}`); }
}
function throwsReason(name: string, f: () => unknown, reason: string) {
  try { f(); failures.push(`${name}: did not throw`); }
  catch (err: any) { ok(name, err instanceof WorkspaceAccessError && err.reason === reason, `reason=${err?.reason ?? err?.message}`); }
}

(async () => {
  // ── calendar ────────────────────────────────────────────────
  const posts: Array<{ path: string; body: any }> = [];
  let findAnswer: any = { found: [{ id: 'evt1', start: '2026-10-05T12:50:00+09:00' }] };
  const post = async (p: string, body: any) => {
    posts.push({ path: p, body });
    if (p.endsWith('/find')) return findAnswer;
    return { ok: true };
  };
  const ran: string[][] = [];
  const patches: Array<{ path: string; body: any }> = [];
  const patchResult: any = { ok: true, mirror: { ok: true } };
  const patch = async (p: string, body: any) => { patches.push({ path: p, body }); return patchResult; };
  const tools = createActionTools(
    { get: async () => ({ targets: [] }), post, patch, canReadPath: (p) => { if (p.includes('secret')) throw new Error('denied'); return p.replace('~', '/home'); } },
    { canReadPath: (p) => { if (p.includes('secret')) throw new Error('denied'); return p.replace('~', os.tmpdir()); }, run: async (c, a) => { ran.push([c, ...a]); }, appExists: (n) => n === 'Notes' }
  );
  const t = (name: string) => tools.find((x) => x.name === name)!;

  eq('creating and moving events need approval', [t('create_calendar_event').riskLevel, t('reschedule_calendar_event').riskLevel], [RiskLevel.WRITE, RiskLevel.WRITE]);
  eq('opening something is an external action', t('open_target').riskLevel, RiskLevel.EXTERNAL_ACTION);
  eq('deleting events is the most guarded level, editing is a write', [t('delete_calendar_events').riskLevel, t('update_calendar_event').riskLevel], [RiskLevel.DESTRUCTIVE, RiskLevel.WRITE]);
  eq('there is no way to delete without going through that one tool', tools.filter((x) => /delete|remove/.test(x.name)).map((x) => x.name), ['delete_calendar_events']);

  await rejects('a relative date is refused', async () => t('create_calendar_event').execute({ title: 'x', start: '来週の火曜', calendarId: 'c', source: 'google' }), /絶対値/);
  await rejects('an all-day event needs a plain date', async () => t('create_calendar_event').execute({ title: 'x', start: '2026-10-05T09:00', allDay: true, calendarId: 'c', source: 'google' }), /YYYY-MM-DD/);
  await t('create_calendar_event').execute({ title: '歯医者', start: '2026-10-05T15:00', end: '2026-10-05T16:00', calendarId: 'c', source: 'icloud' });
  eq('the event is posted as given, with where it goes', posts.at(-1), { path: '/api/calendar/events', body: { title: '歯医者', start: '2026-10-05T15:00', end: '2026-10-05T16:00', allDay: false, location: null, calendarId: 'c', source: 'icloud' } });

  await t('reschedule_calendar_event').execute({ calendarId: 'c', date: '2026-10-05', title: '薬理学', newStart: '2026-10-05T13:00' });
  eq('a found event is moved by id, with confirm', posts.at(-1)!.body, { calendarId: 'c', confirm: true, items: [{ id: 'evt1', start: '2026-10-05T13:00', end: null }] });
  findAnswer = { found: [{ id: null }] };
  const before = posts.length;
  await rejects('an event that cannot be narrowed to one is not touched', async () => t('reschedule_calendar_event').execute({ calendarId: 'c', date: '2026-10-05', title: '薬理学', newStart: '2026-10-05T13:00' }), /一件に絞れません/);
  eq('and nothing was written', posts.length, before + 1); // only the find

  // ── edit and delete ─────────────────────────────────────────
  findAnswer = { found: [{ id: 'evt9', start: '2026-10-21T13:00:00+09:00' }] };
  posts.length = 0;
  await t('update_calendar_event').execute({ calendarId: 'g', date: '2026-10-21', title: '愛楽園見学実習', newEnd: '2026-10-21T17:20', reason: '日程表では 17:20 まで' });
  eq('an edit finds exactly one event, then updates it by id with confirm and a reason', posts.map((x) => x.path), ['/api/calendar/events/find', '/api/calendar/events/update']);
  eq('only the named fields go out', posts[1].body, { calendarId: 'g', id: 'evt9', confirm: true, reason: '日程表では 17:20 まで', title: null, location: null, start: null, end: '2026-10-21T17:20' });
  await rejects('an edit that changes nothing is refused', async () => t('update_calendar_event').execute({ calendarId: 'g', date: '2026-10-21', title: 'x' }), /直す項目/);
  await rejects('a free-form new time is refused', async () => t('update_calendar_event').execute({ calendarId: 'g', date: '2026-10-21', title: 'x', newEnd: '17時' }), /YYYY-MM-DDTHH:mm/);
  findAnswer = { found: [{ id: null }] };
  posts.length = 0;
  await rejects('an edit that cannot be narrowed to one event touches nothing', async () => t('update_calendar_event').execute({ calendarId: 'g', date: '2026-10-21', title: 'x', newTitle: 'y' }), /一件に絞れません/);
  eq('and only searched', posts.map((x) => x.path), ['/api/calendar/events/find']);

  findAnswer = { found: [{ date: '2026-10-16', title: '病理学II予備', id: 'a', start: '2026-10-16T16:20:00+09:00' }, { date: '2026-10-27', title: '薬理学追試験', id: 'b', start: '2026-10-27T08:30:00+09:00' }] };
  posts.length = 0;
  const del: any = await t('delete_calendar_events').execute({ calendarId: 'g', reason: '日程表に無い／誤配置', items: [{ date: '2026-10-16', title: '病理学II予備' }, { date: '2026-10-27', title: '薬理学追試験' }] });
  eq('a delete resolves every item first, then removes by id with confirm and a reason', posts.map((x) => x.path), ['/api/calendar/events/find', '/api/calendar/events/remove']);
  eq('the removal carries exactly the resolved ids', [posts[1].body.ids, posts[1].body.confirm, posts[1].body.reason], [['a', 'b'], true, '日程表に無い／誤配置']);
  eq('the result says what was deleted', del.deleted.map((d: any) => d.title), ['病理学II予備', '薬理学追試験']);
  findAnswer = { found: [{ date: '2026-10-16', title: 'A', id: 'a' }, { date: '2026-10-27', title: 'B', id: null }] };
  posts.length = 0;
  await rejects('if any one cannot be narrowed, nothing at all is deleted', async () => t('delete_calendar_events').execute({ calendarId: 'g', reason: 'r', items: [{ date: '2026-10-16', title: 'A' }, { date: '2026-10-27', title: 'B' }] }), /何も消していません/);
  ok('and no removal was even attempted', !posts.some((x) => x.path.endsWith('/remove')));
  await rejects('a delete with no reason is refused', async () => t('delete_calendar_events').execute({ calendarId: 'g', reason: ' ', items: [{ date: '2026-10-16', title: 'A' }] }), /理由/);
  await rejects('more than ten at once is refused', async () => t('delete_calendar_events').execute({ calendarId: 'g', reason: 'r', items: Array.from({ length: 11 }, () => ({ date: '2026-10-16', title: 'A' })) }), /10 件まで/);
  findAnswer = { found: [{ date: '2026-10-29', title: '病理学I各論試験（再）', id: 'w', start: '2026-10-29T08:30:00+09:00' }] };
  posts.length = 0;
  await t('delete_calendar_events').execute({ calendarId: 'g', reason: '重複', items: [{ date: '2026-10-29', title: '病理学I各論試験（再）', time: '08:30' }] });
  eq('a start time is passed on to the search, so look-alike titles can be told apart', posts[0].body.items[0].time, '08:30');
  await rejects('a malformed time is refused', async () => t('delete_calendar_events').execute({ calendarId: 'g', reason: 'r', items: [{ date: '2026-10-29', title: 'A', time: '8時半' }] }), /HH:mm/);
  await rejects('a delete with a malformed date is refused', async () => t('delete_calendar_events').execute({ calendarId: 'g', reason: 'r', items: [{ date: '10/16', title: 'A' }] }), /YYYY-MM-DD/);

  // ── FDP ledger ──────────────────────────────────────────────
  eq('changing a ledger entry needs approval', t('update_fdp_task').riskLevel, RiskLevel.WRITE);
  await t('update_fdp_task').execute({ id: 'T005', field: 'dueDate', value: '2026-10-10' });
  eq('a date is sent in the ledger\'s own form', patches.at(-1), { path: '/api/fdp/tasks/T005', body: { field: 'dueDate', value: '2026/10/10', writtenBy: 'iris.chat（利用者の依頼）' } });
  await t('update_fdp_task').execute({ id: 'T011', field: 'status', value: '完了' });
  eq('a status is sent as is', patches.at(-1)!.body.value, '完了');
  await rejects('an impossible date is refused', async () => t('update_fdp_task').execute({ id: 'T005', field: 'dueDate', value: '2026/02/30' }), /存在しない日付/);
  await rejects('a free-form date is refused', async () => t('update_fdp_task').execute({ id: 'T005', field: 'dueDate', value: '来週' }), /YYYY/);
  await rejects('an unknown status is refused', async () => t('update_fdp_task').execute({ id: 'T005', field: 'status', value: 'おわり' }), /未着手/);
  await rejects('a progress above 1 is refused', async () => t('update_fdp_task').execute({ id: 'T005', field: 'progress', value: '91' }), /0〜1/);
  await rejects('an id that is not a task number is refused', async () => t('update_fdp_task').execute({ id: '研究室', field: 'status', value: '完了' }), /T005/);
  await rejects('a field that may not be written is refused', async () => t('update_fdp_task').execute({ id: 'T005', field: 'title', value: 'x' }), /直せない項目/);
  eq('holding needs approval', t('hold_fdp_task').riskLevel, RiskLevel.WRITE);
  await t('hold_fdp_task').execute({ id: 'T005', until: '2026/10/20', reason: '試験期間' });
  eq('a hold goes to the hold route with an end date in the store\'s form', posts.at(-1), { path: '/api/fdp/tasks/T005/hold', body: { heldUntil: '2026-10-20', reason: '試験期間', setBy: 'iris.chat（利用者の依頼）' } });
  await rejects('a hold without a real end date is refused', async () => t('hold_fdp_task').execute({ id: 'T005', until: '来月' }), /YYYY/);
  const slow: any = await t('update_fdp_task').execute({ id: 'T005', field: 'nextAction', value: 'x' });
  eq('a mirror that succeeded says both were updated', slow.note.includes('スプレッドシートを更新'), true);
  patchResult.mirror = { ok: false, error: 'タイムアウト' };
  const timedOut: any = await t('update_fdp_task').execute({ id: 'T005', field: 'nextAction', value: 'y' });
  eq('a mirror that timed out says the ledger is updated and the sheet is to be checked', timedOut.note.includes('IRIS の台帳は更新') && timedOut.note.includes('あとで確かめて'), true);

  // ── open_target ─────────────────────────────────────────────
  await t('open_target').execute({ target: 'https://pubmed.ncbi.nlm.nih.gov/' });
  eq('an https URL opens', ran.at(-1), ['open', 'https://pubmed.ncbi.nlm.nih.gov/']);
  await rejects('a file: URL is refused', async () => t('open_target').execute({ target: 'file:///etc/passwd' }), /http/);
  await rejects('a javascript: URL is refused', async () => t('open_target').execute({ target: 'javascript:alert(1)' }), /http/);
  await rejects('an app name that is not installed is refused', async () => t('open_target').execute({ target: 'Evil App' }), /見つかりません/);
  await rejects('shell syntax is not an app name', async () => t('open_target').execute({ target: 'Notes; rm -rf ~' }), /見つかりません/);
  await t('open_target').execute({ target: 'Notes' });
  eq('an installed app opens by name', ran.at(-1), ['open', '-a', 'Notes']);
  await rejects('a path that read access refuses is not opened', async () => t('open_target').execute({ target: '/secret/file' }), /denied/);

  // ── writing under the home directory ────────────────────────
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-write-'));
  const work = path.join(tmp, 'work');
  const homeish = path.join(tmp, 'home');
  fs.mkdirSync(work, { recursive: true });
  fs.mkdirSync(path.join(homeish, 'Documents'), { recursive: true });
  fs.mkdirSync(path.join(homeish, 'Library'), { recursive: true });
  const ws = new Workspace({ root: work, readRoots: [homeish], writeRoots: [homeish] });

  ok('a path under a write root resolves', ws.resolveWrite(path.join(homeish, 'Documents', 'note.txt')) === path.join(fs.realpathSync(homeish), 'Documents', 'note.txt'));
  throwsReason('Library is not writable', () => ws.resolveWrite(path.join(homeish, 'Library', 'x')), 'denied_read_only_segment');
  throwsReason('a .env is not writable', () => ws.resolveWrite(path.join(homeish, 'Documents', '.env')), 'denied_pattern');
  throwsReason('outside every write root is refused', () => ws.resolveWrite(path.join(tmp, 'elsewhere', 'x')), 'outside_workspace');
  throwsReason('IRIS\'s own code is not writable', () => new Workspace({ root: work, writeRoots: [process.cwd()] }).resolveWrite(path.join(process.cwd(), 'server', 'index.ts')), 'denied_write_target');
  throwsReason('deleting stays inside the workspace', () => ws.resolve(path.join(homeish, 'Documents', 'note.txt')), 'outside_workspace');

  // Home-level rules, against the real home directory (no files are touched).
  const real = new Workspace({ root: work, writeRoots: [os.homedir()] });
  throwsReason('~/.zshrc is not writable', () => real.resolveWrite('~/.zshrc'), 'denied_write_target');
  throwsReason('~/Applications is not writable', () => real.resolveWrite('~/Applications/IRIS.app/x'), 'denied_write_target');
  throwsReason('~/Library is not writable', () => real.resolveWrite('~/Library/LaunchAgents/x.plist'), 'denied_read_only_segment');
  ok('~/Documents is writable', (() => { try { real.resolveWrite('~/Documents/iris-note.txt'); return true; } catch { return false; } })());

  const [, , write] = createFilesystemTools(ws);
  const target = path.join(homeish, 'Documents', 'note.txt');
  await write.execute({ path: target, content: 'one' });
  await rejects('a second write does not replace by default', async () => write.execute({ path: target, content: 'two' }), /既に存在/);
  eq('the file kept its first content', fs.readFileSync(target, 'utf8'), 'one');
  await write.execute({ path: target, content: 'two', mode: 'overwrite' });
  eq('overwrite must be asked for', fs.readFileSync(target, 'utf8'), 'two');
  await write.execute({ path: 'inside.txt', content: 'a' });
  await write.execute({ path: 'inside.txt', content: 'b' });
  eq('inside the workspace the old default holds', fs.readFileSync(path.join(work, 'inside.txt'), 'utf8'), 'b');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`Actions: ${passed} passed, ${failures.length} failed`);
  if (failures.length) { console.log(failures.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
  console.log('All action tests passed.');
})();
