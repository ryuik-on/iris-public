/**
 * The notification centre: what it collects, the proposals it derives, the counts it shows.
 *
 * Run: npx tsx scripts/test-center.ts
 */
import { composeProposals, buildCenter, tasksToCheckIn, checkInMessage, shortAction } from '../server/core/center.js';
import { composeMorningBrief } from '../server/core/morning_brief.js';

let passed = 0;
const failures: string[] = [];
const ok = (name: string, cond: boolean, detail = '') => { if (cond) passed++; else failures.push(`${name} ${detail}`); };

const summary = {
  studyDueSoon: [
    { id: 'T1', title: '遅れている課題', dueInDays: -14, nextAction: 'まず 7 件を潰す' },
    { id: 'T2', title: '今週の課題', dueInDays: 2 },
    { id: 'T3', title: '遠い課題', dueInDays: 40 },
  ],
  pendingApprovals: 2,
  waitingConversations: [{ label: '開発' }],
  development: { lastDay: [{ needsAttention: true }, { needsAttention: false }] },
  nextExam: { title: '薬理学期末試験', days: 18 },
  health: { status: 'degraded', problems: [{ label: 'iCloud カレンダー' }] },
};

const proposals = composeProposals(summary);
ok('overdue and near-due study become proposals, a far one does not', proposals.some((p) => p.text.includes('遅れている課題')) && proposals.some((p) => p.text.includes('今週の課題')) && !proposals.some((p) => p.text.includes('遠い課題')));
ok('the next step is carried', proposals[0].detail?.includes('まず 7 件を潰す') === true);
ok('approvals point at the approvals view', proposals.find((p) => p.id === 'approvals')?.to === 'approvals');
ok('waiting conversations point at the notices', proposals.find((p) => p.id === 'waiting')?.to === 'notices');
ok('an unresolved stop is a proposal', proposals.some((p) => p.id === 'stopped'));
ok('an exam within three weeks adds a review slot', proposals.some((p) => p.id === 'exam'));
ok('a broken integration is named', proposals.some((p) => p.text.includes('iCloud カレンダー')));
{
  const q = composeProposals({ studyDueSoon: [
    { id: 'A', title: '未着手の遠い課題', dueInDays: 20, status: '未着手' },
    { id: 'B', title: '順調な遠い課題', dueInDays: 20, status: '進行中', verdict: '順調' },
    { id: 'C', title: '停滞', dueInDays: 20, status: '進行中', verdict: '進捗停滞', progress: 0.1 },
  ] });
  ok('an untouched far task is asked about', q.some((p) => p.taskId === 'A' && p.ask?.status === '未着手'));
  ok('a healthy far task is left alone', !q.some((p) => p.taskId === 'B'));
  ok('a stalled task is asked about, with its progress', q.find((p) => p.taskId === 'C')?.ask?.progress === 0.1);
}
{
  const tasks = tasksToCheckIn({ studyDueSoon: [
    { id: 'A', title: '未着手', dueInDays: -2, status: '未着手' },
    { id: 'H', title: '保留中', dueInDays: -2, status: '未着手', verdict: '保留' },
    { id: 'D', title: '完了', dueInDays: 1, status: '完了' },
  ] });
  ok('held and finished tasks are not asked about', tasks.length === 1 && tasks[0].id === 'A');
  ok('held tasks make no proposal-question either', !composeProposals({ studyDueSoon: [{ id: 'H', title: '保留中', dueInDays: 20, status: '未着手', verdict: '保留' }] }).some((p) => p.ask));
  const msg = checkInMessage(tasks)!;
  ok('the message names the task and ends with an answerable question', msg.text.includes('- A 未着手') && msg.text.includes('保留にして'));
  ok('nothing to ask means no message', checkInMessage([]) === null);
}
{
  const long = 'PubMedで Yamada T[au] AND Example[ad] AND 2023/01/01:2026/12/31[dp] を実行し、出たタイトルを全部読む（30分）。5論点マップは取り下げ、経緯はPLACE';
  const short = shortAction(long);
  ok('the next step drops the search syntax and the history', !short.includes('[au]') && !short.includes('PLACE') && short.length <= 56, short);
  ok('a short plain step is kept as is', shortAction('Week0 を通す') === 'Week0 を通す');
}
ok('at most eight', proposals.length <= 8);
ok('a quiet day proposes nothing', composeProposals({ studyDueSoon: [], pendingApprovals: 0, waitingConversations: [], development: { lastDay: [] }, nextExam: { title: 'x', days: 90 }, health: { problems: [] } }).length === 0);

const center = buildCenter({
  now: new Date('2026-10-01T09:00:00Z'),
  summary,
  brief: { title: 't', text: 'x' },
  notices: [
    { conversationId: 'a', ruleId: 'r', title: 'A', preview: '', createdAt: '2026-10-01T00:00:00Z', replied: false },
    { conversationId: 'b', ruleId: 'r', title: 'B', preview: '', createdAt: '2026-10-01T00:00:00Z', replied: true },
  ],
  runs: [
    { id: 'old', agent: 'claude', state: 'stopped', startedAt: '2026-09-30T00:00:00Z', handoffId: 'task1' },
    { id: 'now', agent: 'claude', state: 'running', startedAt: '2026-10-01T08:00:00Z', handoffId: 'task1' },
  ],
  taskTitles: { task1: '検索の道具' },
  approvals: [{ id: 'p', toolName: 'write_file', conversationId: 'a' }],
  activity: [],
});
ok('only the unanswered notices are unread', center.counts.unreadNotices === 1);
const readOne = buildCenter({ summary: null, brief: null, notices: [{ conversationId: 'a', ruleId: 'r', title: 'A', preview: '', createdAt: '2026-10-01T00:00:00Z', replied: false, read: true }], runs: [], taskTitles: {}, approvals: [], activity: [] });
ok('a notice that was opened no longer counts as unread', readOne.counts.unreadNotices === 0);
ok('running runs are counted', center.counts.runningRuns === 1);
ok('problems are integrations plus unresolved stops', center.counts.problems === 2);
ok('runs are newest first and carry the task title', center.runs[0].id === 'now' && center.runs[0].taskTitle === '検索の道具');
ok('approvals are counted', center.counts.approvals === 1);

const failed = buildCenter({ summary: null, summaryError: 'boom', brief: null, notices: [], runs: [], taskTitles: {}, approvals: [], activity: [] });
ok('when the summary failed, it is said rather than shown empty', failed.today.couldNotRead.some((m) => m.includes('boom')) && failed.today.proposals.length === 0 && failed.system === null);

const brief = composeMorningBrief({ now: '2026-10-01 07:00', todayRemaining: [], proposals: ['A を進める', 'B を見る'] });
ok('the morning brief carries the proposals', brief.text.includes('今日の提案') && brief.text.includes('- A を進める'));

console.log(`Centre: ${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log(failures.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
console.log('All centre tests passed.');
