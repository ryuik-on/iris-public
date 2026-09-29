export interface Conversation {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationSummary extends Conversation {
  messageCount: number;
  lastMessagePreview: string | null;
}

export interface StoredMessage {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
}

export interface ConversationView {
  conversation: Conversation | null;
  messages: StoredMessage[];
  pendingApproval: any | null;
}

/**
 * The token this device is using, if it needs one.
 *
 * A browser on the machine itself never needs it — the server trusts loopback
 * — so this stays empty there and no part of the interface mentions it. It
 * only appears on a phone or another computer, which is exactly where a
 * credential is worth asking for.
 */
const TOKEN_KEY = 'iris.access-token';

export function storedToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    // Private browsing, or storage disabled. Nothing here is worth failing over.
    return null;
  }
}

export function rememberToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token.trim());
  } catch {
    /* the token still works for this page; it just will not survive a reload */
  }
}

export function forgetToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* nothing to do */
  }
}

/** The auth header, when there is one to send. */
function authHeaders(): Record<string, string> {
  const token = storedToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function request<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, {
    ...init,
    headers: { ...(init?.headers as Record<string, string> | undefined), ...authHeaders() },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    const error = new Error(err.error || `HTTP ${res.status}`) as Error & { code?: string; status?: number };
    error.code = err.code;
    error.status = res.status;
    throw error;
  }
  return res.json() as Promise<T>;
}

const jsonPost = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

/**
 * The server derives history from the database, so the client sends only the
 * current turn. This is what makes a duplicated user message structurally
 * impossible rather than merely avoided by convention.
 */
export function sendChatMessage(
  message: string,
  conversationId: string | null,
  /**
   * How the request was made. A voice turn is answered in a sentence rather
   * than a list, because the reply is about to be read out loud. It carries no
   * permission — the server treats it as presentation only.
   */
  channel: 'text' | 'voice' = 'text'
) {
  return request<any>('/api/chat', jsonPost({ message, conversationId, channel }));
}

/**
 * The same turn, read as it is written.
 *
 * `fetch` and a reader rather than EventSource, which cannot POST — the turn
 * has a body, so the request has to be a POST and the event parsing has to be
 * done here. It is a small format and this is the whole of it.
 *
 * Falls back to the plain call on any failure to start. Streaming is how the
 * reply is displayed, not whether it can be had, and a proxy that will not
 * pass an event stream should cost a nicer animation rather than an answer.
 */
export async function streamChatMessage(
  message: string,
  conversationId: string | null,
  channel: 'text' | 'voice',
  on: {
    accepted?(): void;
    delta(text: string): void;
    /** A retry threw away what came before it. Drop it. */
    reset(): void;
    /** What the run is doing now, for as long as it is doing it. */
    phase(name: 'thinking' | 'tool_execution'): void;
  }
): Promise<any> {
  let response: Response;
  try {
    response = await fetch('/api/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ message, conversationId, channel }),
    });
    if (response.status === 404 || response.status === 405) {
      return sendChatMessage(message, conversationId, channel);
    }
    if (!response.ok || !response.body) throw new Error(`送信結果を確認できません（HTTP ${response.status}）。`);
    on.accepted?.();
  } catch (error) {
    throw error instanceof Error ? error : new Error('送信結果を確認できません。');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let done: any = null;
  let failure: string | null = null;

  const handle = (block: string) => {
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trim());
    }
    if (data.length === 0) return;
    let payload: any;
    try {
      payload = JSON.parse(data.join('\n'));
    } catch {
      return;
    }
    if (event === 'delta') on.delta(String(payload.text ?? ''));
    else if (event === 'reset') on.reset();
    else if (event === 'phase') {
      const name = payload?.name;
      if (name === 'thinking' || name === 'tool_execution') on.phase(name);
    }
    else if (event === 'done') done = payload;
    else if (event === 'failed') failure = payload?.error ?? '応答に失敗しました。';
  };

  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    // Events are separated by a blank line, and a chunk can end mid-event.
    let split = buffer.indexOf('\n\n');
    while (split !== -1) {
      handle(buffer.slice(0, split));
      buffer = buffer.slice(split + 2);
      split = buffer.indexOf('\n\n');
    }
  }
  if (buffer.trim()) handle(buffer);

  if (failure) throw new Error(failure);
  if (!done) throw new Error('応答が途中で終わりました。');
  return done;
}

export function approveToolAction(sessionId: string, approved: boolean) {
  return request<any>('/api/chat/approve', jsonPost({ sessionId, approved }));
}

export function fetchRecentConversation() {
  return request<ConversationView>('/api/conversations/recent');
}

export function fetchConversation(id: string) {
  return request<ConversationView>(`/api/conversations/${id}`);
}

/**
 * 履歴を一件消す。**戻せない。**
 *
 * 画面の側で一度確かめてから呼ぶ。押した指がそのまま消せてしまう場所に
 * 置くものではない。
 */
export function deleteConversation(id: string) {
  return request<{ ok: boolean }>(`/api/conversations/${id}`, { method: 'DELETE' });
}

export function listConversations() {
  return request<{ conversations: ConversationSummary[] }>('/api/conversations');
}

export function createConversation() {
  return request<ConversationView>('/api/conversations', { method: 'POST' });
}

export function fetchPendingApprovals() {
  return request<{ pendingApprovals: any[] }>('/api/approvals/pending');
}

/**
 * 会話の出し先を選ぶ。`provider` に `null` を渡すと既定へ戻る。
 *
 * 空文字ではなく `null`。**空文字は「無い」ではなく「空という値」**で、
 * 保存側でどちらとも読める。
 */
export const setLane = (lane: 'voice' | 'text', provider: string | null) =>
  request<any>('/api/settings/lanes', jsonPost({ lane, provider }));

export function fetchSettings() {
  return request<any>('/api/settings');
}

// ---------------------------------------------------------------------------
// Ambient layer: what IRIS currently believes, hears and speaks with.
// Each of these is read-only from the UI's point of view except where noted.

export interface ContextField {
  kind: string;
  value: unknown;
  source: string;
  sourceLabel: string;
  confidence: number;
  reportedConfidence: number;
  band: 'high' | 'medium' | 'low';
  calibrated: boolean;
  observedAt: string;
  ageMs: number;
  decayed: boolean;
  evidence: string | null;
  disagreement?: Array<{ source: string; value: unknown; confidence: number }>;
}

export interface ContextSnapshot {
  at: string;
  fields: Record<string, ContextField>;
  /** Kinds nothing has reported. Not negatives — absences. */
  unknown: string[];
  sources: Array<{ id: string; label: string; calibrated: boolean; observations: number }>;
  kinds?: Array<{ kind: string; description: string; validForMs: number; halfLifeMs?: number }>;
}

export interface SpeechStatus {
  state: 'idle' | 'starting' | 'listening' | 'stopping' | 'unavailable';
  startedAt: string | null;
  pending: number;
  dropped: number;
  partial: string | null;
  lastError: { code: string; message: string; hint?: string } | null;
  restarts: number;
  recent?: Array<{ text: string; at: string }>;
}

export interface RoutingStatus {
  routing: boolean;
  order?: string[];
  quotaResetTimeZone?: string;
  providers?: Array<{
    key: string;
    name: string;
    vendor: string;
    model: string;
    priority: number;
    available: boolean;
    reason: string | null;
    message: string | null;
    retryAt: string | null;
    servedCount: number;
    lastServedAt: string | null;
  }>;
}

export interface TtsStatus {
  engine: string;
  order: string[];
  voice: string | null;
  speaking: boolean;
  engines: Array<{ id: string; label: string; remote: boolean; ok: boolean; reason?: string }>;
  note: string;
}

export interface ProactiveState {
  rules: Array<{ id: string; description: string; suggestion: string; cooldownMs: number }>;
  pending: Array<{
    id: string;
    ruleId: string;
    suggestion: string;
    prompt: string | null;
    createdAt: string;
    because: Array<{ kind: string; value: unknown; source: string; confidence: number; calibrated: boolean; ageMs: number }>;
  }>;
}

export interface FdpTask {
  id: string;
  title: string;
  field: string | null;
  priority: string | null;
  status: string | null;
  /** Computed by IRIS from the reproduced rule. 保留 only exists here. */
  verdict: string | null;
  /** What the sheet's own 自動判定 column said. Null when blank. */
  sheetVerdict: string | null;
  heldUntil: string | null;
  heldUntilInDays: number | null;
  holdReason: string | null;
  holdSetBy: string | null;
  due: string | null;
  /** Negative when overdue. Null when 期限 is unreadable. */
  dueInDays: number | null;
  start: string | null;
  startsInDays: number | null;
  lastUpdated: string | null;
  /** Days since 最終更新日 — what 更新停止 is actually counting. */
  stillDays: number | null;
  /** 0–1, or null when unrecorded. Null is not 0. */
  progress: number | null;
  nextAction: string | null;
  doneCriteria?: string | null;
  /** どこで進めるか。実在する道だけ。無ければ null（手続き系はこれが本当）。 */
  workplace?: { path: string; kind: 'folder' | 'file'; basis: 'folder-by-id' | 'path-in-text' } | null;
  /** その課題を進めているセッション。中にいるものが先、生きているものが先。 */
  sessions?: Array<{
    id: string; name: string | null; live: boolean; resume: string;
    kind: 'claude' | 'codex'; lastAt: string; doingNow: string | null;
    scope: 'inside' | 'enclosing';
  }>;
}

/** その課題のセッションを前に出す（Claude のみ。Codex には開く扉が無い）。 */
export const raiseTaskSession = (id: string, session?: string) =>
  request<any>(`/api/fdp/tasks/${encodeURIComponent(id)}/session`, jsonPost(session ? { session } : {}));

/** 作業場所を Finder で開く。サーバがこの機械で動いているからできる。 */
export const openTaskWorkplace = (id: string) => request<any>(`/api/fdp/tasks/${encodeURIComponent(id)}/open`, jsonPost({}));

/**
 * Read, or the reason it could not be. A failed read must not arrive looking
 * like an empty ledger, so the two shapes are different types.
 */
export interface FdpVerdictSettings {
  /** 更新停止: days without a 最終更新日 bump before a task counts as stopped. */
  stalledAfterDays: number;
  dueSoonDays: number;
}

export type FdpTasksReading =
  | {
      ok: true;
      tasks: FdpTask[];
      doneCount: number;
      /** The ledger's thresholds, so no screen holds its own copy of "7". */
      settings: FdpVerdictSettings;
      /** Where the rows came from. 'iris' once the ledger has been imported. */
      source: 'iris' | 'sheet';
      /** Writes that never reached the spreadsheet. Its readers are stale by these. */
      unmirroredWrites: number;
      readAt: string;
    }
  | { ok: false; error: string; readAt: string };

export const fetchFdpTasks = () => request<FdpTasksReading>('/api/fdp/tasks');

/**
 * 予定の一覧。**サーバには最初からあったのに、画面が一度も呼んでいなかった。**
 *
 * `blocked` が入っているときは、**読めていない源がある**という意味。その
 * ときサーバは空き時間を出さない — 予定が欠けたまま「空いています」と人に
 * 渡すことになるから。画面もその判断に従い、理由をそのまま出す。
 */
export interface ScheduleEvent {
  title: string;
  shortTitle?: string | null;
  start: string;
  end: string | null;
  allDay: boolean;
  calendar?: string | null;
}

export interface FreeDay {
  date: string;
  slots: Array<{ from: string; to: string }>;
  note?: string | null;
}

export interface ScheduleReading {
  days: number;
  events: ScheduleEvent[];
  free: FreeDay[];
  freeText: string | null;
  sources: string[];
  blocked: string | null;
}

export const fetchSchedule = (days = 7) =>
  request<ScheduleReading>(`/api/schedule?days=${encodeURIComponent(String(days))}`);

/**
 * 家計の集計。**共有してよい側だけ。**
 *
 * サーバは家計を二つに分けている — 月ごとの集計（これ）と、個別の取引
 * （`/api/finance/transactions`、`privacy: 'local_only'` の印が付く）。
 * 分けてあるのは、集計なら人にも模型にも渡せるが、一件ずつの買い物は
 * 渡せないから。**画面が読むのは集計の方だけ。**
 *
 * `status` が `pending` の行は、Gmail の通知から取っただけで**明細と
 * 突き合わせていない**もの。確定した金額として出してはいけない。
 */
export interface FinanceMonthRow {
  month: string;
  kind: string;
  status: string;
  category: string;
  total: number;
  count: number;
}

export interface FinanceSummary {
  months: FinanceMonthRow[];
  spendingByMonth: Array<{ month: string; total: number }>;
  imports: Array<{ id: string; fileName: string; format: string; rows: number; skipped: number; importedAt: string }>;
  transferRules: number;
  note: string;
}

/**
 * 次の試験。無ければ `null`。
 *
 * 他のものは変わるから見る値打ちがあるが、これは逆で、**動かないから出す。**
 * 日付が近づくこと自体が読みたいもので、遠いうちは見ないから、遠いうちに
 * 見えていないと気づく機会が無い。
 *
 * `from` が付いていたら、暦ではなく**印刷された講義日程表**から答えている
 * という意味。日程表には版があり、刷ったあとに動くので、出どころは一緒に出す。
 */
export interface NextExam {
  title: string;
  date: string;
  days: number;
  /** この試験のあとに控えている数。 */
  after: number;
  from?: string;
}

export const fetchNextExam = () => request<NextExam | null>('/api/exam/next');

export const fetchFinanceSummary = () => request<FinanceSummary>('/api/finance/summary');


/**
 * Park a task until a date. The date is required by the server, not by
 * politeness: a hold with no end never expires, and a pause that never expires
 * is indistinguishable from having forgotten.
 */
export const holdFdpTask = (id: string, heldUntil: string, reason: string, setBy: string) =>
  request<{ ok: true }>(`/api/fdp/tasks/${encodeURIComponent(id)}/hold`,
    jsonPost({ heldUntil, reason, setBy }));

export const releaseFdpTask = (id: string, releasedBy: string) =>
  request<{ ok: true; released: boolean }>(`/api/fdp/tasks/${encodeURIComponent(id)}/hold`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ releasedBy }),
  });

export const fetchContext = () => request<ContextSnapshot>('/api/context');
export const fetchSpeechStatus = () => request<SpeechStatus>('/api/speech/status');
export const fetchRouting = () => request<RoutingStatus>('/api/providers/routing');
export const fetchTts = () => request<TtsStatus>('/api/tts');
export const fetchProactive = () => request<ProactiveState>('/api/proactive');

/**
 * 過ぎた会話の中を探す。
 *
 * 索引はサーバに前からあり（2026-09-08 の時点で 162 通、`inSync`）、
 * **どの画面からも呼ばれていなかった。**
 *
 * 三文字未満は索引の単位に満たないので、サーバが `tooShort` を返す。
 * 呼ぶ側で握りつぶさず、そのまま人に見せる —— 「0件」と「短すぎる」は
 * 別のことで、前者だけ出すと言葉を変える理由が分からない。
 */
export interface SearchHit {
  messageId: string;
  conversationId: string;
  conversationTitle: string | null;
  role: 'user' | 'assistant';
  createdAt: string;
  /** 前後を切り取った本文。合った語は « » で囲まれている。 */
  snippet: string;
}

export interface SearchReading {
  query: string;
  hits: SearchHit[];
  tooShort?: boolean;
  note?: string | null;
}

export const searchMessages = (q: string) =>
  request<SearchReading>(`/api/search?q=${encodeURIComponent(q)}`);

export const startListening = () => request<SpeechStatus>('/api/speech/start', jsonPost({}));
export const stopListening = () => request<SpeechStatus>('/api/speech/stop', jsonPost({}));
export const drainTranscripts = () =>
  request<{
    transcripts: Array<{
      text: string;
      at: string;
      /** True when the utterance opened with the wake word. */
      addressed: boolean;
      /** The text with the name removed, when it was addressed. */
      request: string;
      matched: string | null;
    }>;
    dropped: number;
    wakeWords: string[];
  }>('/api/speech/drain', jsonPost({}));

export const speakText = (text: string) => request<any>('/api/tts/speak', jsonPost({ text }));
export const stopSpeaking = () => request<any>('/api/tts/stop', jsonPost({}));

export const acceptSuggestion = (id: string, conversationId: string | null) =>
  request<any>(`/api/proactive/${encodeURIComponent(id)}/accept`, jsonPost({ conversationId }));
export const dismissSuggestion = (id: string) =>
  request<any>(`/api/proactive/${encodeURIComponent(id)}/dismiss`, jsonPost({}));

export interface BudgetWindow {
  window: 'run' | 'day' | 'month';
  spentUsd: number;
  limitUsd: number;
  remainingUsd: number;
  usedFraction: number;
  verdict: 'ok' | 'warn' | 'deny';
}

export interface BudgetState {
  limits: { perRunUsd: number; dailyUsd: number; monthlyUsd: number; warnAt: number };
  windows: BudgetWindow[];
  verdict: 'ok' | 'warn' | 'deny';
  trippedBy: string | null;
  message: string;
  /** Calls from models with no price entry — spend that cannot be seen. */
  unpricedCalls: number;
  checkedAt: string;
}

export const fetchBudget = () => request<BudgetState>('/api/budget');

/**
 * What the coding assistants on this machine have used.
 *
 * Deliberately not part of the budget call. That is money IRIS spent through
 * its own keys; this is how much of a flat-rate allowance is gone, which is a
 * different unit and a different question.
 */
export interface CliUsageState {
  codex: {
    planType: string | null;
    usedPercent: number;
    windowMinutes: number;
    resetsAtMs: number | null;
    recordedAtMs: number | null;
  } | null;
  codexReason: string | null;
  claude: {
    usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number };
    sessions: number;
    messages: number;
    indicativeUsd: number;
    /**
     * Always null here. The allowance is not in the transcripts — it arrives
     * through the status line and lives in `claudeLimits`.
     */
    usedPercent: null;
  } | null;
  claudeReason: string | null;
  /**
   * The allowance, relayed from Claude Code's status line.
   *
   * Separate from `claude` above, which is counted from the transcripts. The
   * tokens are a measurement; this is a message, and it is only as fresh as
   * the last time Claude Code drew its status line — hence `ageMinutes`,
   * which is never folded away.
   */
  claudeLimits: {
    session: { usedPercent: number; resetsAtMs: number | null } | null;
    week: { usedPercent: number; resetsAtMs: number | null } | null;
    model: string | null;
    capturedAtMs: number | null;
    ageMinutes: number | null;
    reason: string | null;
  } | null;
  checkedAt: string;
}

export const fetchCliUsage = () => request<CliUsageState>('/api/usage/cli');

/* ── Delegation: approval given once, instead of asked for every time ────── */

export interface DelegationState {
  granted: boolean;
  grant?: {
    tool: string;
    repos: string[];
    dailyUsdCap: number;
    maxConcurrent: number;
    expiresAt: string;
    note: string | null;
  };
  today?: { usd: number; unmetered: number; chargedUsd: number; capUsd: number };
  allowedRepos?: string[];
}

export function fetchDelegation(): Promise<DelegationState> {
  return request<DelegationState>('/api/delegation');
}

export function grantDelegation(input: {
  dailyUsdCap?: number;
  maxConcurrent?: number;
  days?: number;
}): Promise<DelegationState> {
  return request<DelegationState>('/api/delegation', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export function revokeDelegation(): Promise<DelegationState> {
  return request<DelegationState>('/api/delegation', { method: 'DELETE' });
}

/* ── The MED-AI Builder Lab ledger, as IRIS reads it ─────────────────────── */

export interface LedgerTaskView {
  id: string | null;
  title: string;
  status: 'Todo' | 'In Progress' | 'Blocked' | 'Done' | 'Unknown';
  owner: string;
  dependsOn: string[];
  notes: string;
  updated: string;
}

export interface LedgerProjectView {
  id: string | null;
  name: string;
  status: string;
  priority: string;
  progress: {
    total: number;
    done: number;
    blocked: number;
    inProgress: number;
    todo: number;
    unknown: number;
  };
  tasks: LedgerTaskView[];
}

export type PortfolioView =
  | {
      ok: true;
      source: string;
      projects: LedgerProjectView[];
      decisions: number;
      labs: unknown[];
      repos: Array<{ name: string; path: string; lastCommit: string | null; registered: boolean }>;
      warnings: string[];
    }
  | { ok: false; source: string; reason: string };

export function fetchPortfolio(): Promise<PortfolioView> {
  return request<PortfolioView>('/api/portfolio');
}
