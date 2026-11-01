/**
 * The night patrol: facts gathered by code, claims kept only if they cite them.
 *
 * Run: npx tsx scripts/test-night-patrol.ts
 */
import { JarvisOrchestrator } from '../server/core/orchestrator.js';
import { RiskLevel } from '../server/core/types.js';
import { patrolDue, findOverlaps, collectFacts, buildPatrolPrompt, parsePatrolReply, composePatrolMessage, dayKey, buildWorkPrompt, buildCriticPrompt, slugify, MAX_NIGHT_WORK } from '../server/core/night_patrol.js';

let passed = 0;
const failures: string[] = [];
const ok = (name: string, cond: boolean, detail = '') => { if (cond) passed++; else failures.push(`${name} ${detail}`); };

const at = (h: number) => new Date(2026, 9, 3, h, 10);
ok('patrols between 2 and 6', patrolDue(at(2), false) && patrolDue(at(5), false));
ok('not in the daytime or evening', !patrolDue(at(1), false) && !patrolDue(at(6), false) && !patrolDue(at(14), false));
ok('once a day', !patrolDue(at(3), true));
ok('day key is local and zero padded', dayKey(new Date(2026, 0, 5, 3)) === '2026-01-05');

const ev = (title: string, start: string, end: string, allDay = false) => ({ title, start, end, allDay });
const overlaps = findOverlaps([
  ev('薬理学', '2026-10-05T09:00', '2026-10-05T10:30'),
  ev('病理学', '2026-10-05T10:00', '2026-10-05T11:00'),
  ev('病理学', '2026-10-05T10:00', '2026-10-05T11:00'), // the same event mirrored by another calendar
  ev('終日', '2026-10-05', '2026-10-06', true),
  ev('昼', '2026-10-05T12:00', '2026-10-05T13:00'),
]);
ok('overlapping timed events are found once', overlaps.length === 2 && overlaps.every(([a, b]) => a.title !== b.title), JSON.stringify(overlaps.length));
ok('work inside a shift of the same workplace is not a conflict', !findOverlaps([ev('サンプル 出勤', '2026-10-06T17:00', '2026-10-06T22:00'), ev('サンプル たろうくん', '2026-10-06T18:30', '2026-10-06T19:50')]).length);
ok('but the same shift against a different workplace still is', findOverlaps([ev('サンプル 出勤', '2026-10-06T17:00', '2026-10-06T22:00'), ev('コスモ 授業', '2026-10-06T18:30', '2026-10-06T19:50')]).length === 1);
ok('all-day and back-to-back events do not overlap', !findOverlaps([ev('a', '2026-10-05T09:00', '2026-10-05T10:00'), ev('b', '2026-10-05T10:00', '2026-10-05T11:00')]).length);

const facts = collectFacts({
  now: new Date(2026, 9, 3, 3, 0),
  events: [ev('薬理学', '2026-10-05T09:00', '2026-10-05T10:30'), ev('病理学', '2026-10-05T10:00', '2026-10-05T11:00')],
  tasks: [
    { id: 'T005', title: '研究室', status: '進行中', verdict: '進捗停滞', dueInDays: 28, progress: 0, stillDays: 3, nextAction: '論文リストを読む' },
    { id: 'T001', title: '終わった', status: '完了' },
  ],
  exam: { title: '薬理学期末試験', days: 16 },
  weekUsedPercent: { claude: 65, codex: null },
  unansweredNotices: [{ title: '課題の確認', ageDays: 3 }, { title: '新しい', ageDays: 0 }],
  awaitingApproval: 1, awaitingFixes: 0, failingChecks: ['calendar_readable'],
  couldNotRead: ['使用量: timeout'],
});
const text = facts.map((f) => f.text).join('\n');
ok('facts are numbered from F1', facts[0].id === 'F1' && facts.every((f, i) => f.id === `F${i + 1}`));
ok('an overlap is stated as a fact', text.includes('予定が重なっている'));
ok('finished tasks are left out', !text.includes('終わった'));
ok('unknown usage reads as unknown, not zero', text.includes('Codex 不明%'));
ok('only old unanswered notices count', text.includes('1 件') && text.includes('課題の確認') && !text.includes('新しい'));
ok('what could not be read is said, as not-read', text.includes('読めなかったもの（無い、ではない）: 使用量'));
ok('the prompt carries every fact and says the user is asleep', facts.every((f) => buildPatrolPrompt(facts, new Date(2026, 9, 3, 3, 0)).includes(f.text)) && buildPatrolPrompt(facts, new Date()).includes('就寝中'));

const idOverlap = facts.find((f) => f.text.includes('重なっている'))!.id;
const reply = JSON.stringify({ items: [
  { title: '月曜 9 時の予定が重なっている', why: '薬理学と病理学', suggestion: 'どちらかを動かす', facts: [idOverlap] },
  { title: '作り話', why: 'x', suggestion: 'y', facts: ['F99'] },
  { title: '根拠なし', why: 'x', suggestion: 'y', facts: [] },
  { title: '提案なし', why: 'x', suggestion: '', facts: ['F1'] },
] });
const parsed = parsePatrolReply('```json\n' + reply + '\n```', facts);
ok('an item that cites a real fact is kept', parsed.items.length === 1 && parsed.items[0].facts[0] === idOverlap);
ok('items citing nothing, a fact that does not exist, or with no suggestion are dropped', parsed.dropped === 3);
ok('prose around the JSON does not break parsing', parsePatrolReply('はい。' + reply + '以上', facts).items.length === 1);
ok('garbage yields nothing rather than a crash', parsePatrolReply('すみません', facts).items.length === 0 && parsePatrolReply('{broken', facts).items.length === 0);
ok('at most five items', parsePatrolReply(JSON.stringify({ items: Array.from({ length: 9 }, () => ({ title: 't', why: '', suggestion: 's', facts: ['F1'] })) }), facts).items.length === 5);

const msg = composePatrolMessage(parsed.items, new Date(2026, 9, 3, 3, 12))!;
ok('the message is numbered and ends with a question the user can answer by number', msg.text.includes('1. 月曜 9 時の予定が重なっている') && msg.text.includes('番号で言ってください'));
ok('a night with nothing to say says nothing', composePatrolMessage([], new Date()) === null);

// ── 夜の仕事
{
  const f2 = collectFacts({ now: new Date(), events: null, tasks: null, exam: null, weekUsedPercent: null, unansweredNotices: null, awaitingApproval: null, awaitingFixes: null, failingChecks: null, couldNotRead: [], more: ['課題 T005 の作業フォルダの最後の更新は 9 日前。'] });
  ok('extra material becomes numbered facts too', f2.length === 1 && f2[0].id === 'F1' && f2[0].text.includes('9 日前'));
  const w = (over: any = {}) => ({ kind: 'research', title: 't', goal: '研究室の直近 3 年の論文のタイトルを集めて要点をまとめる', deliverable: '要点 10 行', facts: ['F1'], ...over });
  const parsedW = parsePatrolReply(JSON.stringify({ items: [], work: [w(), w({ kind: 'send_email' }), w({ goal: '短い' }), w({ facts: ['F9'] }), w({ facts: [] })] }), f2);
  ok('only read-only kinds with a concrete goal and a real fact become night work', parsedW.work.length === 1 && parsedW.dropped === 4, JSON.stringify([parsedW.work.length, parsedW.dropped]));
  ok('night work is capped', parsePatrolReply(JSON.stringify({ items: [], work: Array.from({ length: 8 }, () => w()) }), f2).work.length === MAX_NIGHT_WORK);
  const job = parsedW.work[0];
  const prompt = buildWorkPrompt(job, f2);
  ok('the work prompt forbids writing and demands sources and honesty', prompt.includes('何も書き換えない') && prompt.includes('出典') && prompt.includes('分からない'));
  ok('and carries the goal and the cited fact', prompt.includes(job.goal) && prompt.includes('9 日前'));
  ok('the critic sees the facts and the draft', buildCriticPrompt(f2, '{"items":[]}').includes('F1:') && buildCriticPrompt(f2, '{"items":[]}').includes('下書き'));
  ok('slugs are safe file names, Japanese kept', slugify('研究室: 論文/リスト?') === '研究室-論文-リスト' && slugify('???') === 'work');
  const m = composePatrolMessage([], new Date(2026, 9, 3, 3, 0), [{ title: '論文の下調べ', path: '~/IRIS_Workspace/night/2026-10-03/x.md', conversationId: 'c', ok: true }, { title: '失敗した仕事', path: null, conversationId: null, ok: false, note: '時間切れ' }])!;
  ok('a night with only finished work still reports it, with the file and the failure', m.text.includes('夜のうちに進めたこと（2 件）') && m.text.includes('x.md') && m.text.includes('できませんでした: 時間切れ'));
}

// ── 夜の実行が持てる道具
{
  const o: any = Object.create(JarvisOrchestrator.prototype);
  ok('a night run may read', o.permits('night', RiskLevel.READ) === true);
  ok('a night run may not write, act outwardly or destroy — nobody is there to approve', [RiskLevel.WRITE, RiskLevel.EXTERNAL_ACTION, RiskLevel.DESTRUCTIVE].every((r) => o.permits('night', r) === false));
  ok('the other origins are unchanged', o.permits('user', RiskLevel.DESTRUCTIVE) === true && o.permits('inferred', RiskLevel.WRITE) === true && o.permits('inferred', RiskLevel.EXTERNAL_ACTION) === false);
}

console.log(`Night patrol: ${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log(failures.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
console.log('All night patrol tests passed.');
