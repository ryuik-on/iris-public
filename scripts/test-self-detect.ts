/**
 * Self-development, the noticing stage: complaints, repeated errors, repeated stalls.
 * No model; the rules must give the same answer every time.
 *
 * Run: npx tsx scripts/test-self-detect.ts
 */
import { detectComplaints, detectErrorRepeats, detectStalls, scoreComplaint } from '../server/core/self_detect.js';
import { SelfFindingStore, MAX_ATTEMPTS } from '../server/services/self_findings_sqlite.js';
import { openDatabase } from '../server/services/db.js';

let passed = 0;
const failures: string[] = [];
const ok = (name: string, cond: boolean, detail = '') => { if (cond) passed++; else failures.push(`${name} ${detail}`); };

const msg = (id: string, content: string, at = '2026-10-01T10:05:00Z', conv = 'c1') => ({ id, conversationId: conv, content, createdAt: at });

// ── complaints
ok('a clear complaint about the product is caught', detectComplaints([msg('1', 'レーンで朝2って書かれても何かわからん')]).length === 1);
ok('"動かない" about the screen is caught', detectComplaints([msg('1', '⌥⌘Kで週の暦開かないんだけど画面は変わらない')]).length === 1);
ok('an ordinary request is not a complaint', detectComplaints([msg('1', '来週の火曜に歯医者の予定を入れてほしい')]).length === 0);
ok('a plain question is not', detectComplaints([msg('1', '今日の予定は何がありますか')]).length === 0);
ok('a slash command is never a complaint', detectComplaints([msg('1', '/カレンダー 来週 動かない')]).length === 0);
ok('a short message is ignored', detectComplaints([msg('1', '遅い')]).length === 0);
const two = detectComplaints([msg('1', '通知が出てないよ。', '2026-10-01T10:05:00Z'), msg('2', '画面が消えるのなんで？', '2026-10-01T10:40:00Z')]);
ok('one conversation, one hour: one finding carrying both', two.length === 1 && two[0].evidence.length === 2);
ok('another hour is another finding', detectComplaints([msg('1', '通知が出てないよ。', '2026-10-01T10:05:00Z'), msg('2', '画面が消えるのなんで？', '2026-10-01T12:40:00Z')]).length === 2);
ok('the score names what matched', scoreComplaint('レーンが動かない').hits.includes('動かない'));

// ── errors
const now = new Date('2026-10-01T12:00:00Z');
const e = (event: string, level: string, at: string, message = 'm') => ({ event, level, message, createdAt: at });
const errs = detectErrorRepeats([
  e('dev.ledger_open_failed', 'warn', '2026-10-01T11:00:00Z', 'a'), e('dev.ledger_open_failed', 'warn', '2026-10-01T11:10:00Z', 'b'), e('dev.ledger_open_failed', 'warn', '2026-10-01T11:20:00Z', 'a'),
  e('tool.retry', 'warn', '2026-10-01T11:00:00Z'), e('tool.retry', 'warn', '2026-10-01T11:01:00Z'), e('tool.retry', 'warn', '2026-10-01T11:02:00Z'),
  e('rare.event', 'error', '2026-10-01T11:00:00Z'),
  e('old.event', 'warn', '2026-09-30T01:00:00Z'), e('old.event', 'warn', '2026-09-30T01:01:00Z'), e('old.event', 'warn', '2026-09-30T01:02:00Z'),
  e('conversation.deleted', 'warn', '2026-10-01T11:00:00Z', ''), e('conversation.deleted', 'warn', '2026-10-01T11:01:00Z', ''), e('conversation.deleted', 'warn', '2026-10-01T11:02:00Z', ''),
  e('finance.gmail_auto', 'warn', '2026-10-01T11:00:00Z', ''), e('finance.gmail_auto', 'warn', '2026-10-01T11:01:00Z', ''), e('finance.gmail_auto', 'warn', '2026-10-01T11:02:00Z', ''),
  e('weather.failed', 'warn', '2026-10-01T11:00:00Z', 'x'), e('weather.failed', 'warn', '2026-10-01T11:01:00Z', 'y'), e('weather.failed', 'warn', '2026-10-01T11:02:00Z', 'z'),
  e('fine.event', 'info', '2026-10-01T11:00:00Z'), e('fine.event', 'info', '2026-10-01T11:01:00Z'), e('fine.event', 'info', '2026-10-01T11:02:00Z'),
], now);
ok('only a failing warning that repeats three times is a finding; routine records in a warning colour are not', errs.map((x) => x.dedupeKey).sort().join() === 'error:dev.ledger_open_failed', errs.map((x) => x.dedupeKey).join());
ok('a weather failure is not worth a fix, however often it repeats (the user does not want to be told)', !errs.some((x) => x.dedupeKey.includes('weather')));
const rejected = detectErrorRepeats([
  e('self.fix_rejected', 'warn', '2026-10-01T09:00:00Z', '「self.check.deep」でサーバーが 5 回止まった（最長 9069 ms）'),
  e('self.fix_rejected', 'warn', '2026-10-01T10:00:00Z', '「breakdown.warmup」でサーバーが 2 回止まった（最長 30338 ms）'),
  e('self.fix_rejected', 'warn', '2026-10-01T11:00:00Z', '「tool.timeout」が 6 時間に 3 回（warn）'),
], now);
ok('fixes that failed verification are not themselves a finding (each failed finding already retries on its own)', rejected.length === 0, rejected.map((x) => x.dedupeKey).join());
ok('its evidence is the distinct messages', errs.find((x) => x.dedupeKey === 'error:dev.ledger_open_failed')!.evidence.length === 2);

// ── stalls
const st = (at: string, ms: number, during: string | null) => ({ at, ms, during });
const stalls = detectStalls([
  st('2026-10-01T11:30:00Z', 5000, 'http GET /api/schedule'), st('2026-10-01T11:40:00Z', 4000, 'http GET /api/schedule'),
  st('2026-10-01T11:50:00Z', 9000, 'http GET /api/once'),
  st('2026-10-01T11:31:00Z', 15000, null), st('2026-10-01T11:41:00Z', 12000, null),
  st('2026-10-01T11:20:00Z', 1_800_000, null), st('2026-10-01T11:21:00Z', 1_900_000, null),
], now, 3600);
ok('a request that stalls the server twice is a finding', stalls.some((s) => s.dedupeKey === 'stall:http GET /api/schedule'));
ok('one stall is not', !stalls.some((s) => s.dedupeKey === 'stall:http GET /api/once'));
ok('unattributed long stalls are a finding when the server is warm', stalls.some((s) => s.dedupeKey === 'stall:unattributed'));
ok('sleep-length gaps are not counted', stalls.find((s) => s.dedupeKey === 'stall:unattributed')?.evidence.length === 2);
ok('just after start, unattributed stalls are not blamed', !detectStalls([st('2026-10-01T11:31:00Z', 15000, null), st('2026-10-01T11:41:00Z', 12000, null)], now, 60).some((s) => s.dedupeKey === 'stall:unattributed'));

// 起動の直後と、機械が忙しいときの停止は数えない。
const justBooted = detectStalls([
  st('2026-10-01T11:56:00Z', 5000, 'breakdown.warmup'), st('2026-10-01T11:57:00Z', 6000, 'breakdown.warmup'),
], new Date('2026-10-01T12:00:00Z'), 240);
ok('stalls in the first five minutes after start are not counted', justBooted.length === 0);
const busy = detectStalls([
  { ...st('2026-10-01T11:30:00Z', 5000, 'http GET /api/x'), load: 0.8 }, { ...st('2026-10-01T11:40:00Z', 4000, 'http GET /api/x'), load: 0.9 },
], now, 3600);
ok('stalls while the machine is busy are not counted', !busy.some((s) => s.dedupeKey === 'stall:http GET /api/x'));
const idleStall = detectStalls([
  { ...st('2026-10-01T11:30:00Z', 5000, 'http GET /api/y'), load: 0.1 }, { ...st('2026-10-01T11:40:00Z', 4000, 'http GET /api/y'), load: 0.2 },
], now, 3600);
ok('stalls on a quiet machine still are', idleStall.some((s) => s.dedupeKey === 'stall:http GET /api/y'));

// ── the store
const db = openDatabase(':memory:', { wal: false });
const store = new SelfFindingStore(db);
const input = { dedupeKey: 'k1', source: 'error' as const, title: 't', detail: 'd', evidence: ['a'] };
const first = store.report(input, new Date('2026-10-01T00:00:00Z'));
ok('a new finding is created open', first.created && first.finding.status === 'open');
const again = store.report({ ...input, evidence: ['b'] }, new Date('2026-10-01T01:00:00Z'));
ok('the same key adds an occurrence and evidence, not a second finding', !again.created && again.finding.occurrences === 2 && again.finding.evidence.length === 2 && store.list().length === 1);
ok('it is the next thing to fix', store.nextToFix()?.id === first.finding.id);
store.update(first.finding.id, { status: 'merged' });
ok('a merged finding is not offered again', store.nextToFix() === null);
const back = store.report(input, new Date('2026-10-02T00:00:00Z'));
ok('a recurrence after the fix reopens it and says so', back.reopened && back.finding.status === 'open' && (back.finding.note ?? '').includes('再発'));
store.update(first.finding.id, { attempts: MAX_ATTEMPTS });
ok('after the attempt limit it is no longer offered', store.nextToFix() === null);
store.update(first.finding.id, { status: 'dismissed', attempts: 0 });
store.report(input, new Date('2026-10-03T00:00:00Z'));
ok('a dismissed finding stays dismissed when seen again', store.get(first.finding.id)?.status === 'dismissed');

console.log(`Self detect: ${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log(failures.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
console.log('All self detect tests passed.');
