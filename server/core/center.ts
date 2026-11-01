/**
 * 通知センターの中身。
 *
 * 「さっきまで話していた内容がどこへ行ったか分からない」「朝のまとめや提案が毎回
 * どこにあるか分からない」「それぞれのログや状態をリアルタイムに見たい」
 * （利用者、2026-10-01）。レールの札・チャット・盤に散らばっていたものを、
 * **一か所の一枚**にする。ここは集めて並べるだけで、新しい判断はしない。
 *
 * 提案も、模型に書かせない。`whats_going_on` の事実から決まった規則で作る —
 * 朝一番に外れた提案を読まされるより、短くても当たっているほうがよい。
 */

export interface Proposal {
  id: string;
  text: string;
  detail?: string;
  /** 学習・課題の提案のとき、その課題の番号。画面が「期限を延ばす」「完了にする」を出す。 */
  taskId?: string;
  /** 着手・進捗を IRIS から尋ねる課題（未着手のまま、または進捗が停滞）。画面が答えの選択肢を出す。 */
  ask?: { status: string | null; progress: number | null };
  /** どこへ行けば良いか。画面が行き先を開く。 */
  to?: 'notices' | 'approvals' | 'development' | 'system';
}

/**
 * 着手・進捗を IRIS から尋ねる課題。保留と完了は尋ねない。
 * 通知センターの質問と、会話で聞く一言の、どちらもここから決める。
 */
export function tasksToCheckIn(summary: any): Array<{ id: string; title: string; status: string | null; progress: number | null; dueInDays: number | null }> {
  return ((summary?.studyDueSoon ?? []) as any[])
    .filter((t) => t.status !== '完了' && t.verdict !== '保留' && (t.status === '未着手' || t.verdict === '進捗停滞' || t.verdict === '更新停止'))
    .slice(0, 2)
    .map((t) => ({
      id: t.id, title: t.title, status: t.status ?? null,
      progress: typeof t.progress === 'number' ? t.progress : null,
      dueInDays: typeof t.dueInDays === 'number' ? t.dueInDays : null,
    }));
}

export function checkInMessage(tasks: ReturnType<typeof tasksToCheckIn>): { title: string; text: string } | null {
  if (!tasks.length) return null;
  const lines = tasks.map((t) => {
    const due = t.dueInDays === null ? '' : t.dueInDays < 0 ? `、${-t.dueInDays} 日超過` : `、あと ${t.dueInDays} 日`;
    const now = t.status === '未着手' ? '未着手' : `${t.status ?? '状態不明'}、進捗 ${Math.round((t.progress ?? 0) * 100)}%`;
    return `- ${t.id} ${t.title}（${now}${due}）`;
  });
  return {
    title: '課題の確認',
    text: [
      '次の課題が、動いていないように見えます。',
      ...lines,
      '',
      '着手していますか。どのくらい進んでいますか。「着手した」「半分くらい」「期限を○日に延ばして」「○日まで保留にして」のように言ってください。',
    ].join('\n'),
  };
}

/** 次の一手は、最初の一文だけを短く。検索式や経緯は、台帳の中で読めばよい。 */
export function shortAction(text: string): string {
  const first = String(text).split(/[。\n]/)[0].replace(/[A-Za-z]+\[[a-z]+\][^ ]*|\bAND\b/g, '').replace(/\s+/g, ' ').trim();
  const base = first.length >= 8 ? first : String(text).trim();
  return base.length > 56 ? `${base.slice(0, 55)}…` : base;
}

export function composeProposals(summary: any): Proposal[] {
  const out: Proposal[] = [];

  const needsCheckIn = (t: any) => t.status !== '完了' && t.verdict !== '保留' && (t.status === '未着手' || t.verdict === '進捗停滞' || t.verdict === '更新停止');
  const due = ((summary?.studyDueSoon ?? []) as any[])
    .filter((t) => (typeof t.dueInDays === 'number' && t.dueInDays <= 3) || needsCheckIn(t))
    .slice(0, 2);
  for (const t of due) {
    out.push({
      id: `study:${t.id}`,
      taskId: t.id,
      ...(needsCheckIn(t) ? { ask: { status: t.status ?? null, progress: typeof t.progress === 'number' ? t.progress : null } } : {}),
      text: `${t.title} を進める`,
      detail: [
        t.dueInDays < 0 ? `${-t.dueInDays} 日超過` : t.dueInDays === 0 ? '今日が期限' : `あと ${t.dueInDays} 日`,
        t.nextAction ? `次の一手: ${shortAction(t.nextAction)}` : null,
      ].filter(Boolean).join(' ／ '),
    });
  }

  if (summary?.pendingApprovals) {
    out.push({ id: 'approvals', text: `承認待ち ${summary.pendingApprovals} 件を処理する`, to: 'approvals' });
  }

  const waiting = (summary?.waitingConversations ?? []) as any[];
  if (waiting.length) {
    out.push({ id: 'waiting', text: `返事を待っている話 ${waiting.length} 件を見る`, to: 'notices' });
  }

  const stopped = ((summary?.development?.lastDay ?? []) as any[]).filter((r) => r.needsAttention === true);
  if (stopped.length) {
    out.push({ id: 'stopped', text: `途中で止まった開発の実行 ${stopped.length} 件を確かめる`, to: 'development' });
  }

  const problems = (summary?.health?.problems ?? []) as any[];
  if (problems.length) {
    out.push({ id: 'health', text: `使えない連携を直す（${problems.map((p) => p.label).join('・')}）`, to: 'system' });
  }


  const exam = summary?.nextExam;
  if (exam && typeof exam.days === 'number' && exam.days <= 21) {
    out.push({ id: 'exam', text: `${exam.title}まであと ${exam.days} 日。今日のどこかに復習の枠を一つ取る` });
  }

  return out.slice(0, 8);
}

export interface CenterNotice {
  conversationId: string;
  ruleId: string;
  title: string;
  preview: string;
  createdAt: string;
  /** この一言のあとに、利用者が話したか。 */
  replied: boolean;
  /** 開いた（または「すべて既読」にした）か。 */
  read?: boolean;
}

export interface CenterRun {
  id: string;
  agent: string;
  state: string;
  stopReason: string | null;
  usd: number | null;
  branch: string | null;
  startedAt: string;
  endedAt: string | null;
  taskId: string | null;
  taskTitle: string | null;
}

export interface CenterSnapshot {
  generatedAt: string;
  /** 一覧の上に出す数字。未返信の知らせ・承認待ち・動いている開発・直近の失敗。 */
  counts: { unreadNotices: number; approvals: number; runningRuns: number; problems: number };
  today: { brief: { title: string; text: string } | null; proposals: Proposal[]; summary: any | null; couldNotRead: string[] };
  notices: CenterNotice[];
  runs: CenterRun[];
  approvals: Array<{ id: string; toolName: string; conversationId: string; conversationTitle?: string }>;
  system: { status: string; activeProvider: string | null; problems: any[]; stallsLastHour: any; usage: any } | null;
  activity: Array<{ at: string; level: string; event: string; message: string | null }>;
  /** 自己開発：気づいたことと、直しの段。 */
  selfDev: { enabled: boolean; paused?: boolean; findings: any[]; recentlyDone: any[]; checks?: any };
}

export function buildCenter(input: {
  now?: Date;
  summary: any | null;
  summaryError?: string | null;
  brief: { title: string; text: string } | null;
  notices: CenterNotice[];
  runs: any[];
  taskTitles: Record<string, string>;
  approvals: any[];
  activity: any[];
  selfDev?: { enabled: boolean; paused?: boolean; findings: any[]; recentlyDone: any[]; checks?: any };
}): CenterSnapshot {
  const runs: CenterRun[] = input.runs
    .slice()
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
    .slice(0, 20)
    .map((r) => ({
      id: r.id, agent: r.agent, state: r.state, stopReason: r.stopReason ?? null,
      usd: r.usd ?? null, branch: r.branch ?? null, startedAt: r.startedAt, endedAt: r.endedAt ?? null,
      taskId: r.handoffId ?? null, taskTitle: r.handoffId ? input.taskTitles[r.handoffId] ?? null : null,
    }));

  const summary = input.summary;
  const problems = (summary?.health?.problems ?? []) as any[];
  return {
    generatedAt: (input.now ?? new Date()).toISOString(),
    counts: {
      unreadNotices: input.notices.filter((n) => !n.replied && !n.read).length,
      approvals: input.approvals.length,
      runningRuns: runs.filter((r) => r.state === 'running').length,
      problems: problems.length + ((summary?.development?.lastDay ?? []) as any[]).filter((r) => r.needsAttention === true).length,
    },
    today: {
      brief: input.brief,
      proposals: summary ? composeProposals(summary) : [],
      summary,
      couldNotRead: [
        ...((summary?.couldNotRead ?? []) as string[]),
        ...(input.summaryError ? [`今日のまとめ: ${input.summaryError}`] : []),
      ],
    },
    notices: input.notices,
    runs,
    approvals: input.approvals,
    system: summary?.health
      ? { status: summary.health.status, activeProvider: summary.health.activeProvider ?? null, problems, stallsLastHour: summary.health.stallsLastHour, usage: summary.usage }
      : null,
    activity: input.activity,
    selfDev: input.selfDev ?? { enabled: false, findings: [], recentlyDone: [] },
  };
}
