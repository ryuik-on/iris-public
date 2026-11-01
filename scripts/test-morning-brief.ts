/**
 * The morning brief: facts in order, nothing added, what could not be read said so.
 *
 * Run: npx tsx scripts/test-morning-brief.ts
 */
import { composeMorningBrief } from '../server/core/morning_brief.js';
import { railLabel } from '../server/core/opener.js';

let passed = 0;
const failures: string[] = [];
const ok = (name: string, cond: boolean, detail = '') => { if (cond) passed++; else failures.push(`${name} ${detail}`); };

const full = composeMorningBrief({
  now: '2026-10-01 07:05',
  todayRemaining: [
    { title: '薬理学予備', start: '08:30', end: '11:50', allDay: false, location: '教育棟' },
    { title: '祝日', start: null, end: null, allDay: true },
  ],
  tomorrow: [{ title: '病理学', start: '09:40', allDay: false }],
  nextExam: { title: '薬理学期末試験', date: '2026-10-19', days: 18 },
  studyDueSoon: [
    { id: 'T1', title: '遅れている課題', dueInDays: -14 },
    { id: 'T2', title: '遠い課題', dueInDays: 46 },
    { id: 'T3', title: '今日が期限', dueInDays: 0 },
  ],
  development: { running: 1, lastDay: [{ state: 'stopped', stopReason: 'unmeterable', needsAttention: true }, { state: 'stopped', stopReason: 'unmeterable', needsAttention: false }, { state: 'stopped', stopReason: 'completed', needsAttention: false }] },
  waitingConversations: [{ label: '開発' }, { label: '開発' }, { label: '講義' }],
  pendingApprovals: 2,
  usage: { claude: { week: 85 }, codex: { week: 49 } },
  health: { status: 'degraded', problems: [{ label: 'iCloud カレンダー' }] },
});

ok('the title has the date and weekday', full.title === 'おはようございます（10/1 木）', full.title);
ok('today lists times, titles and places', full.text.includes('- 08:30〜11:50 薬理学予備（教育棟）') && full.text.includes('- 終日 祝日'));
ok('tomorrow names the first timed event', full.text.includes('明日') && full.text.includes('09:40 病理学'));
ok('the next exam says how far', full.text.includes('あと 18 日'));
ok('overdue and due-today study are listed, a distant one is not', full.text.includes('14 日超過') && full.text.includes('今日') && !full.text.includes('遠い課題'));
ok('only a stop that is still unresolved is flagged', full.text.includes('途中で止まった開発の実行が 1 件'));
ok('waiting conversations are counted with their kinds', full.text.includes('3 件') && full.text.includes('開発・講義'));
ok('approvals are named', full.text.includes('承認待ちが 2 件'));
ok('usage is mentioned only when high', full.text.includes('Claude の今週は 85%') && !full.text.includes('Codex の今週'));
ok('a health problem is named', full.text.includes('iCloud カレンダー が使えません') && full.text.includes('degraded'));

const quiet = composeMorningBrief({ now: '2026-10-02 07:00', todayRemaining: [], usage: { claude: { week: 10 }, codex: { week: null } }, health: { status: 'healthy', problems: [] } });
ok('an empty day says so', quiet.text.includes('予定はありません'));
ok('a quiet system adds no worry section', !quiet.text.includes('気にしておくこと'));

// 予定の入り口が読めていないときの空は、「予定なし」と言わない。
const unread = composeMorningBrief({ now: '2026-10-02 07:00', todayRemaining: [], calendarComplete: false });
ok('an empty list from an incomplete read is not "no events"', !unread.text.includes('予定はありません。') || unread.text.includes('ではありません'));
ok('an incomplete read is named as unread', unread.text.includes('予定を読めませんでした'));
ok('a complete empty read still says no events', composeMorningBrief({ now: '2026-10-02 07:00', todayRemaining: [], calendarComplete: true }).text.includes('予定はありません。'));

const partial = composeMorningBrief({ now: '2026-10-02 07:00', todayRemaining: [], couldNotRead: ['カレンダー: boom'] });
ok('what could not be read is said, not hidden', partial.text.includes('読めなかったもの') && partial.text.includes('カレンダー: boom'));

ok('the rail calls it 今朝', railLabel('morning.brief') === '今朝');

console.log(`Morning brief: ${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log(failures.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
console.log('All morning brief tests passed.');
