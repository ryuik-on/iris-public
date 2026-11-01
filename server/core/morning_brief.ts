/**
 * 朝の知らせの文面。
 *
 * 「ほしい情報を言わないと出さない」（利用者、2026-10-01）への答え。毎朝、IRIS の
 * 側から一本の会話を置く。**模型に書かせない。**`whats_going_on` が返した事実を
 * 並べるだけで、言い換えも推測も足さない — 朝一番に外れた要約を読まされるのは、
 * 何も言われないよりも悪い。
 *
 * 画面（レール）がすでに言っていることは繰り返さない、ではなく、**ここは画面を
 * 開かなくても一日が分かる**ための一枚。取れなかったものは、無いことにせず
 * 最後に書く。
 */

export interface BriefInput {
  now: string; // 'YYYY-MM-DD HH:mm'
  todayRemaining?: Array<{ title: string; start: string | null; end: string | null; allDay: boolean; location?: string }>;
  tomorrow?: Array<{ title: string; start: string | null; allDay: boolean }>;
  /** false = 予定の入り口の一部が読めていない。空の一覧を、「予定なし」と読ませない。 */
  calendarComplete?: boolean;
  nextExam?: { title: string; date: string; days: number } | null;
  studyDueSoon?: Array<{ id: string; title: string; dueInDays: number | null; verdict?: string }> | null;
  development?: { running: number | null; lastDay: Array<{ state: string; stopReason: string | null; needsAttention?: boolean }> } | null;
  waitingConversations?: Array<{ label: string }> | null;
  pendingApprovals?: number | null;
  usage?: { claude: { week: number | null }; codex: { week: number | null } } | null;
  health?: { status: string; problems: Array<{ label: string }> } | null;
  couldNotRead?: string[];
  /** 今日の提案（`center.ts` の規則から）。 */
  proposals?: string[];
}

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

function when(e: { start: string | null; end: string | null; allDay: boolean }): string {
  if (e.allDay) return '終日';
  return e.end ? `${e.start}〜${e.end}` : (e.start ?? '');
}

export function composeMorningBrief(input: BriefInput): { title: string; text: string } {
  const date = input.now.slice(0, 10);
  const weekday = WEEKDAYS[new Date(`${date}T12:00:00Z`).getUTCDay()];
  const title = `おはようございます（${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))} ${weekday}）`;

  const sections: string[] = [title];

  const today = input.todayRemaining ?? [];
  sections.push(
    today.length
      ? `**今日の予定**\n${today.map((e) => `- ${when(e)} ${e.title}${e.location ? `（${e.location}）` : ''}`).join('\n')}`
      : input.calendarComplete === false
        ? '**今日の予定**\n- 予定を読めませんでした（通信が戻ってから、もう一度確かめてください）。「予定はありません」ではありません。'
        : '**今日の予定**\n- 予定はありません。'
  );

  const tomorrow = input.tomorrow ?? [];
  if (tomorrow.length) {
    const first = tomorrow.find((e) => !e.allDay) ?? tomorrow[0];
    sections.push(`**明日**\n- ${tomorrow.length} 件。最初は ${first.allDay ? '終日' : first.start} ${first.title}`);
  }

  if (input.nextExam) sections.push(`**次の試験**\n- ${input.nextExam.title}（${input.nextExam.date}、あと ${input.nextExam.days} 日）`);

  const due = (input.studyDueSoon ?? []).filter((t) => t.dueInDays !== null && t.dueInDays <= 7);
  if (due.length) {
    sections.push(
      `**学習の期限**\n${due.map((t) => `- ${t.title}（${t.dueInDays! < 0 ? `${-t.dueInDays!} 日超過` : t.dueInDays === 0 ? '今日' : `あと ${t.dueInDays} 日`}）`).join('\n')}`
    );
  }

  if (input.proposals?.length) {
    sections.push(`**今日の提案**\n${input.proposals.slice(0, 4).map((p) => `- ${p}`).join('\n')}`);
  }

  const notes: string[] = [];
  if (input.development?.running) notes.push(`開発が ${input.development.running} 件動いています。`);
  // 片付いていない止まり方だけ（同じタスクに後から完了がある、タスクが完了・取りやめ、は数えない）。
  const stopped = (input.development?.lastDay ?? []).filter((r) => r.needsAttention === true);
  if (stopped.length) notes.push(`昨日から、途中で止まった開発の実行が ${stopped.length} 件あります。`);
  if (input.pendingApprovals) notes.push(`承認待ちが ${input.pendingApprovals} 件あります。`);
  const waiting = input.waitingConversations ?? [];
  if (waiting.length) notes.push(`返事を待っている話が ${waiting.length} 件あります（${[...new Set(waiting.map((w) => w.label))].join('・')}）。`);
  const high = [
    input.usage?.claude.week != null && input.usage.claude.week >= 80 ? `Claude の今週は ${input.usage.claude.week}% 使っています。` : null,
    input.usage?.codex.week != null && input.usage.codex.week >= 80 ? `Codex の今週は ${input.usage.codex.week}% 使っています。` : null,
  ].filter(Boolean) as string[];
  notes.push(...high);
  if (input.health && input.health.status !== 'healthy') notes.push(`IRIS の状態が ${input.health.status} です。`);
  for (const p of input.health?.problems ?? []) notes.push(`${p.label} が使えません。`);
  if (notes.length) sections.push(`**気にしておくこと**\n${notes.map((n) => `- ${n}`).join('\n')}`);

  if (input.couldNotRead?.length) {
    sections.push(`**読めなかったもの**（無い、ではありません）\n${input.couldNotRead.map((m) => `- ${m}`).join('\n')}`);
  }

  return { title, text: sections.join('\n\n') };
}
