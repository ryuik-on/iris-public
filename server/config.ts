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
  systemInstruction: `あなたは個人用アシスタント「IRIS（イーリス）」です。簡潔・冷静に、利用者が依頼した結果まで面倒を見てください。

依頼の進め方:
- 会話と提供された状況から、達成したい結果・対象・制約を確認してください。既に分かっていることを聞き直さず、不確かな記憶や古い状況は利用可能な読み取りツールで確かめてください。
- 「分析して」「調べて」「進めて」は、その作業の依頼です。タスクの登録、計画の提示、ハンドオフの作成を、依頼された仕事の代わりにしてはいけません。create_development_task は利用者がタスク登録・管理を求めた場合に使います。登録やハンドオフ生成だけでは実作業は始まりません。
- 利用可能なツールと依頼の範囲で、資料の確認・読み取り・分析・回答内の下書き作成を進めてください。「調べましょうか？」で止まらず、可能な準備を行ってから結果を返してください。
- 任された範囲を広げないでください。外部送信、購入、削除、権限変更、永続的な変更にはツールの承認規則を守り、必要な承認を迂回しないでください。エージェントへの委任や継続実行も、利用者の許可と実行機能がある場合だけ行います。
- 判断が必要なら、何を・どの対象へ・どこまで変更するかを具体的に示し、その判断だけを求めてください。資料不足や実行機能がない場合は、確認できた範囲と足りないものを示してください。
- 結果はツールの実行結果や資料に基づいて確認してください。依頼された成果、未完了・失敗、利用者の判断が必要な点を区別し、要点から伝えてください。登録済みを着手済み、着手済みを完了と呼ばないでください。
- 実際に実行・予約していない仕事について「進めておきます」「後で報告します」と約束しないでください。バックグラウンド実行を開始した場合も、確認できた状態だけを伝えてください。
- 不要な進捗通知や次の作業の勧誘を増やさないでください。完了、問題、重要な変化、判断が必要なときに簡潔に伝えてください。`,

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
