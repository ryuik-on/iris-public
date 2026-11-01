import { Tool, RiskLevel, ToolTrust } from '../core/types.js';

/**
 * IRIS が自分で見られるもの。
 *
 * レールや盤は、予定・今日の優先事項・学習タスク・使用量・健全性を毎回読んで
 * 画面に出している。**ところがチャットの IRIS は、同じものを道具として持って
 * いなかった**ので、画面に出ているのに「取得できません」と答えていた
 * （2026-10-01、「個別の差分までは特定できません」）。
 *
 * ここは読むだけ。画面が読んでいる既存の口をそのまま呼ぶので、数字の出どころが
 * 二つにならない。家計の取引は載せない（集計も含めて、ここでは触らない）。
 */

export type GetJson = (path: string) => Promise<any>;

const DAY = 86_400_000;

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function clock(iso: string | null | undefined): string | null {
  if (!iso || iso.length < 16) return null;
  return iso.slice(11, 16);
}

/** 一つの取得に失敗しても、全体を落とさない。**失敗は「無い」ではなく失敗として返す。** */
async function attempt<T>(label: string, f: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; label: string; error: string }> {
  try {
    return { ok: true, value: await f() };
  } catch (err: any) {
    return { ok: false, label, error: err?.message ?? String(err) };
  }
}

export async function readCalendar(get: GetJson, from?: string, days = 7) {
  const start = from || ymd(new Date());
  // days を API に渡さないと、何日と頼まれても 7 日分しか返らない。それを
  // 「14 日見ました」と読んだモデルが、8 日目以降を「未登録」と言っていた
  // （利用者「irisがしょっちゅう間違えてるって言ってくる」2026-10-10）。
  const span = Math.max(1, Math.min(Math.floor(days) || 7, 31));
  const data = await get(`/api/schedule?from=${encodeURIComponent(start)}&days=${span}`);
  const until = ymd(new Date(new Date(`${start}T00:00:00`).getTime() + span * DAY));
  const events = (data.events ?? [])
    .filter((e: any) => e.start.slice(0, 10) < until)
    .map((e: any) => ({
      title: e.title,
      date: e.start.slice(0, 10),
      start: e.allDay ? null : clock(e.start),
      end: e.allDay ? null : clock(e.end),
      allDay: e.allDay === true,
      calendar: e.calendar,
      location: e.location,
    }));
  // どこまで読めたか。読めなかった入り口があるのに「無い」と言わせない
  // （通信が切れた直後に、残りの写しだけで「授業が 104 件無い」と言った誤報 2026-10-16）。
  const sources: string[] = Array.isArray(data.sources) ? data.sources.map(String) : [];
  const missing = ['google', 'icloud'].filter((x) => !sources.includes(x));
  const read = {
    sources,
    complete: missing.length === 0 && !data.blocked,
    ...(missing.length || data.blocked
      ? { note: `読めなかった入り口: ${missing.join('・') || '不明'}。この結果に無い予定は、「無い」とは言い切れません（読めていないだけかもしれません）。` }
      : {}),
  };
  return { from: start, until, count: events.length, events, read };
}

export async function readFocus(get: GetJson) {
  const d = await get('/api/focus');
  return {
    date: d.date,
    daysToExam: d.daysToExam ?? null,
    items: (d.items ?? []).map((i: any) => ({
      area: i.label ?? i.area, title: i.title, due: i.due ?? null, because: i.because ?? null, detail: i.detail ?? null,
    })),
    unavailable: d.unavailable ?? undefined,
  };
}

export async function readStudyTasks(get: GetJson, limit = 15) {
  const d = await get('/api/fdp/tasks');
  const open = (d.tasks ?? []).filter((t: any) => t.status !== '完了' && t.status !== '中止');
  const rank = (t: any) => (typeof t.dueInDays === 'number' ? t.dueInDays : 9999);
  open.sort((a: any, b: any) => rank(a) - rank(b));
  return {
    openCount: open.length,
    tasks: open.slice(0, limit).map((t: any) => ({
      id: t.id, title: t.title, field: t.field, priority: t.priority, status: t.status,
      verdict: t.verdict, due: t.due, dueInDays: t.dueInDays, progress: t.progress,
      nextAction: typeof t.nextAction === 'string' ? t.nextAction.slice(0, 120) : null,
    })),
  };
}

export async function readUsage(get: GetJson) {
  const d = await get('/api/usage/cli');
  return {
    // **使った割合**。残量ではない。
    note: '数字は使った割合（0=未使用、100=使い切り）。null は読めなかったこと。',
    claude: { week: d.claudeLimits?.week?.usedPercent ?? null, session5h: d.claudeLimits?.session?.usedPercent ?? null, reason: d.claudeReason ?? d.claudeLimits?.reason ?? null },
    codex: { week: d.codex?.usedPercent ?? null, reason: d.codexReason ?? null },
  };
}

export async function readHealth(get: GetJson) {
  const [health, stalls] = await Promise.all([get('/api/health'), get('/api/health/stalls').catch(() => null)]);
  const hourAgo = Date.now() - 3_600_000;
  const recent = ((stalls?.stalls ?? []) as any[]).filter((s) => Date.parse(s.at) >= hourAgo);
  /**
   * 起動から 90 秒は、連携を問題として数えない。準備中なだけで、直す話ではない
   * （再起動の直後に「使えない連携を直す」という提案が出た、2026-10-01）。
   */
  const startingUp = typeof health.uptimeSeconds === 'number' && health.uptimeSeconds < 90;
  const problems = startingUp ? [] : (health.integrations ?? []).filter((i: any) => i.state !== 'ready');
  return {
    startingUp: startingUp || undefined,
    status: startingUp ? 'starting' : health.status,
    activeProvider: health.activeProvider,
    pendingApprovals: health.pendingApprovals,
    configIssues: health.configIssues ?? [],
    integrationsNotReady: problems.map((i: any) => ({ id: i.id, label: i.label, state: i.state, reason: i.reason, guidance: i.guidance })),
    stallsLastHour: { count: recent.length, longestMs: recent.reduce((m, s) => Math.max(m, s.ms), 0) },
  };
}

export async function readActivity(get: GetJson, limit = 20, level?: string) {
  const d = await get(`/api/activity?limit=${Math.max(1, Math.min(limit, 100))}`);
  const entries = (d.entries ?? [])
    .filter((e: any) => !level || e.level === level)
    // 内部の「観測した」は行の洪水になるだけで、読む価値が無い。
    .filter((e: any) => e.event !== 'context.observed')
    .map((e: any) => ({ at: e.createdAt, level: e.level, event: e.event, message: e.message ?? null }));
  return { count: entries.length, entries };
}

/** 「いま何が起きているか」を一つに。 */
export async function whatsGoingOn(get: GetJson) {
  const now = new Date();
  const [cal, focus, study, usage, health, active, runs, proactive, exam, devTasks] = await Promise.all([
    attempt('カレンダー', () => readCalendar(get, ymd(now), 2)),
    attempt('今日の優先事項', () => readFocus(get)),
    attempt('学習タスク', () => readStudyTasks(get, 5)),
    attempt('使用量', () => readUsage(get)),
    attempt('健全性', () => readHealth(get)),
    attempt('動いている開発', () => get('/api/dev/runs/active')),
    attempt('最近の委任', () => get('/api/delegated/runs')),
    attempt('返事待ちの会話', () => get('/api/proactive')),
    attempt('次の試験', () => get('/api/exam/next')),
    attempt('開発タスク', () => get('/api/dev/tasks')),
  ]);

  const failed = [cal, focus, study, usage, health, active, runs, proactive, exam, devTasks].filter((r) => !r.ok).map((r: any) => `${r.label}: ${r.error}`);

  const today = ymd(now);
  const nowClock = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const events = cal.ok ? cal.value.events : [];
  const remaining = events.filter((e: any) => e.date === today && (e.allDay || (e.end ?? e.start ?? '99:99') >= nowClock));
  const tomorrow = ymd(new Date(now.getTime() + DAY));

  const allRuns: any[] = runs.ok ? (runs.value.runs ?? []) : [];
  const recentRuns = allRuns.filter((r) => Date.now() - Date.parse(r.startedAt) < DAY);
  const taskStatus = new Map<string, string>(devTasks.ok ? (devTasks.value.tasks ?? []).map((t: any) => [t.id, t.status]) : []);
  /**
   * 気にすべきなのは、**まだ片付いていない**止まり方だけ。
   *
   * 途中で止まった実行でも、同じタスクにその後の完了があれば、あるいはタスク自体が
   * 完了・取りやめなら、もう言う話ではない。朝の知らせが、片付いた三件を「止まった」
   * と言った（2026-10-01）。タスクの状態を読めなかったときは、片付いたとは決めず、
   * 気にすべきほうに倒す。
   */
  const needsAttention = (r: any): boolean => {
    if (r.state !== 'stopped' || !r.stopReason || r.stopReason === 'completed') return false;
    const status = taskStatus.get(r.handoffId);
    if (status === 'done' || status === 'abandoned') return false;
    return !allRuns.some((o) => o.handoffId === r.handoffId && o.stopReason === 'completed' && Date.parse(o.startedAt) > Date.parse(r.startedAt));
  };

  return {
    now: `${today} ${nowClock}`,
    todayRemaining: remaining,
    tomorrow: events.filter((e: any) => e.date === tomorrow),
    // 予定を全部の入り口から読めたか。読めていないときの「予定なし」は、「無い」ではなく「読めていない」
    // （2026-10-17、20:47 に Google も iCloud も時間切れで、ホームが「直近の予定はありません」と言った）。
    calendarComplete: cal.ok ? cal.value.read.complete === true : false,
    nextExam: exam.ok ? exam.value : null,
    focus: focus.ok ? focus.value.items.slice(0, 5) : null,
    studyDueSoon: study.ok ? study.value.tasks.slice(0, 3) : null,
    development: active.ok || runs.ok ? {
      running: active.ok ? (active.value.runs ?? []).length : null,
      lastDay: recentRuns.map((r: any) => ({ id: r.id, agent: r.agent, state: r.state, stopReason: r.stopReason, usd: r.usd, needsAttention: needsAttention(r) })),
    } : null,
    waitingConversations: proactive.ok ? (proactive.value.openers ?? []).map((o: any) => ({ label: o.label, title: o.title })) : null,
    pendingApprovals: health.ok ? health.value.pendingApprovals : null,
    usage: usage.ok ? usage.value : null,
    health: health.ok ? { status: health.value.status, problems: health.value.integrationsNotReady, stallsLastHour: health.value.stallsLastHour, activeProvider: health.value.activeProvider } : null,
    // 取れなかったものは、無いこととして黙らず、ここに書く。
    couldNotRead: failed.length ? failed : undefined,
  };
}

export function createSituationTools(get: GetJson): Tool[] {
  const read = { riskLevel: RiskLevel.READ, trust: ToolTrust.TRUSTED_CORE } as const;
  return [
    {
      name: 'whats_going_on',
      description:
        '「いま何が起きているか」を一度に返します。今日の残りの予定、明日の予定、次の試験、今日の優先事項、期限の近い学習、動いている開発と直近の委任、返事待ちの会話、承認待ち、使用量、IRIS 自身の健全性。' +
        '予定や状況を尋ねられたら、まずこれを呼びます。取れなかったものは couldNotRead に出ます（無い、とは違います）。',
      ...read,
      schema: { type: 'object', properties: {} },
      async execute() { return whatsGoingOn(get); },
    },
    {
      name: 'get_calendar',
      description: 'カレンダー（Google と iCloud を合わせたもの）の予定を返します。from は YYYY-MM-DD（省略で今日）、days は日数（既定 7、最大 31）。返りの read.complete が false のときは、読めなかった入り口があるので、「予定が無い」と断定しません。それより先は、from を動かして続けて読みます。',
      ...read,
      schema: { type: 'object', properties: { from: { type: 'string' }, days: { type: 'number' } } },
      async execute(args: any) {
        const from = typeof args?.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(args.from) ? args.from : undefined;
        return readCalendar(get, from, typeof args?.days === 'number' ? args.days : 7);
      },
    },
    {
      name: 'check_lecture_calendar',
      description:
        '医学科の講義日程表（PDF）とカレンダーが合っているかを、IRIS が機械的に突き合わせた結果を返します。' +
        '「日程表とカレンダーが食い違っていないか」と聞かれたら、get_calendar と lecture_schedule を自分で見比べず、必ずこれを使います（見比べると、読めた日数の差で「未登録」と誤ります）。' +
        'days は今日から何日先まで見るか（既定 14、最大 400）。missing=カレンダーに無い、moved=別の日に入っている、shifted=時刻が違う、surplus=日程表に無い授業。どれも 0 件なら合っています。',
      ...read,
      schema: { type: 'object', properties: { days: { type: 'number', description: '既定 14、最大 400' } } },
      async execute(args: any) {
        const days = Math.max(1, Math.min(Math.floor(Number(args?.days)) || 14, 400));
        return get(`/api/lectures/divergence?days=${days}`);
      },
    },
    {
      name: 'get_focus',
      description: '今日の優先事項（予定・試験・学習・改善・業務・コンテスト）を返します。レールや盤が出しているものと同じです。',
      ...read,
      schema: { type: 'object', properties: {} },
      async execute() { return readFocus(get); },
    },
    {
      name: 'get_study_tasks',
      description: '学習タスク（FDP）の未完了を、期限の近い順に返します。',
      ...read,
      schema: { type: 'object', properties: { limit: { type: 'number', description: '既定 15' } } },
      async execute(args: any) { return readStudyTasks(get, typeof args?.limit === 'number' ? Math.max(1, Math.min(args.limit, 50)) : 15); },
    },
    {
      name: 'get_usage',
      description: 'Claude と Codex の今週・5 時間枠の「使った割合」を返します（残量ではありません）。判断の直前に呼びます。',
      ...read,
      schema: { type: 'object', properties: {} },
      async execute() { return readUsage(get); },
    },
    {
      name: 'get_system_health',
      description: 'IRIS 自身の状態（動作中のプロバイダ、連携の準備、承認待ち、直近 1 時間の停止）を返します。',
      ...read,
      schema: { type: 'object', properties: {} },
      async execute() { return readHealth(get); },
    },
    {
      name: 'get_activity_log',
      description: 'IRIS の最近の活動記録を返します（内部の観測は除く）。level は info / warn / error。',
      ...read,
      schema: { type: 'object', properties: { limit: { type: 'number' }, level: { type: 'string', enum: ['info', 'warn', 'error'] } } },
      async execute(args: any) { return readActivity(get, typeof args?.limit === 'number' ? args.limit : 20, args?.level); },
    },
  ];
}
