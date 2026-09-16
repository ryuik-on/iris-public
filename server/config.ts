import 'dotenv/config';

// IRIS runs on 3002. Port 3001 belongs to a separate local project and must not
// be reused, so the fallback here is 3002 rather than 3001.
const DEFAULT_PORT = 3002;

function intFromEnv(name: string, fallback: number): number {
  const parsed = parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const CONFIG = {
  assistantName: process.env.ASSISTANT_NAME || 'IRIS',
  port: parseInt(process.env.PORT || String(DEFAULT_PORT), 10) || DEFAULT_PORT,
  defaultProvider: 'anthropic',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-3.6-flash',
  maxToolLoops: 6,

  // Timeouts. A measured tool round trip against gemini-3.6-flash took ~55s,
  // so the provider budget is generous: cutting off legitimate slow thinking
  // would be worse than the hang it prevents.
  providerTimeoutMs: intFromEnv('IRIS_PROVIDER_TIMEOUT_MS', 120_000),
  providerAttempts: intFromEnv('IRIS_PROVIDER_ATTEMPTS', 3),
  toolTimeoutMs: intFromEnv('IRIS_TOOL_TIMEOUT_MS', 30_000),
  // Bounds a whole run: per-step timeouts alone still allow an unbounded total.
  runDeadlineMs: intFromEnv('IRIS_RUN_DEADLINE_MS', 300_000),

  // Review is a different shape of work from chat: a handoff carrying code runs
  // to tens of kilobytes and a reviewer reads all of it before answering. The
  // chat budget (measured round trips of 3–7s) is far too tight — a real
  // code-bearing review timed out at 120s.
  reviewTimeoutMs: intFromEnv('IRIS_REVIEW_TIMEOUT_MS', 600_000),
  // Fewer attempts than chat: each retry re-reads the whole handoff, so a
  // failing review is expensive to repeat.
  reviewAttempts: intFromEnv('IRIS_REVIEW_ATTEMPTS', 2),
  systemInstruction: `あなたは個人用AIオーケストレーター「IRIS（イーリス）」です。簡潔・冷静・論理的にサポートしてください。`,

  /**
   * Added for the turn only when the request arrived as speech.
   *
   * A written answer and a spoken one are not the same answer. Asked 「今日の
   * 予定は」 by voice on 2026-08-20, IRIS replied with a markdown list —
   * 件名 / 時間 / カレンダー — which the voice then read aloud, asterisks and
   * all. Stripping the marks (see normalizeForSpeech) stops it saying
   * 「アスタリスク」, but a list read aloud is still a list. The shape has to
   * be right before it is spoken, not repaired afterwards.
   */
  spokenInstruction: `この依頼は声で話しかけられたものです。返事はそのまま読み上げられます。
- 箇条書き、見出し、記号（*、-、#）は使わず、話し言葉の文で答えてください。
- 1〜2文にまとめてください。聞いて一度で分かる長さにします。
- 「以下の1件です」のような前置きは省き、要点から言ってください。
たとえば予定を聞かれたら「今日は19時30分から職場でそよかぜ書店があります」のように答えます。`,
};
