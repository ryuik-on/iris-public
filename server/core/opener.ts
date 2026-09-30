import type { ProactiveSuggestion } from './proactive_service.js';

/**
 * IRIS の側から、会話を始める。
 *
 * 「確認事項をダッシュボードから見れる、とかじゃなくてそもそも IRIS 側から
 * 俺に聞いて欲しい」「IRIS からの提案は文字で出されるというよりは IRIS との
 * 会話みたいな形が理想」（利用者、2026-09-30）。
 *
 * 提案は前から発火していた。届く先が無かった —— 積まれて、画面と盤が取りに
 * 行くのを待っていた。macOS の通知はこの機械では許可が下りない（実測、
 * `menubar/Notify.swift` の冒頭）。そこで**届け先を会話にする。**提案が出たら、
 * IRIS の一言を最初の発言として会話を一本開く。利用者はいつもの入力欄から
 * 答えればよく、答えはそのまま同じ会話の続きになる。
 *
 * ## 模型は呼ばない
 *
 * 文面は決まった形で組む。`proactive_service.ts` と同じ理由で ——**話しかける
 * かどうかに模型を払うと、邪魔されるためにずっと払い続けることになる。**
 * 答えが返ってきてから先は、ふつうの会話と同じく模型が受ける。
 *
 * ## 同じことを二度言わない
 *
 * 規則の冷却は再起動で消える（覚えているのは記憶の中だけ）ので、ここで
 * もう一段見る。**同じ規則・同じ根拠・同じ日**なら二度目は開かない。
 * 根拠が変われば（期限の過ぎた課題が増えた、日数が進んだ）別の話として開く。
 */

export interface Opener {
  /** 同じ話かどうかの鍵。規則・根拠・日付から作る。 */
  key: string;
  /** 会話の題。履歴の一覧に出る。 */
  title: string;
  /** IRIS の最初の一言。 */
  text: string;
}

/**
 * 規則ごとの、最後の問いかけ。
 *
 * 提案の文は「〜があります。」で終わるものがあり、それだけでは話しかけた
 * ことにならない。**答えられる問いで終える。**無い規則は、提案の文が問いで
 * 終わっていればそのまま、そうでなければ既定の問いを添える。
 */
const ASK: Record<string, string> = {
  'watch.deadline-pressing': 'どれから手をつけますか。もう片付いているものがあれば、そう言ってください。',
};
const DEFAULT_ASK = 'どうしますか。';

/** 題に使う長さ。履歴の一覧で一行に収まる程度。 */
const TITLE_CHARS = 24;

function localDate(at: Date): string {
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
}

/**
 * 根拠の値を、話の中で読める行にする。
 *
 * 文字列と文字列の並びだけを行にする。数や真偽は、提案の文がすでに言って
 * いる（「食い違っています」）ので、`lectures.divergent: 76` のような
 * **計器の読みを会話に混ぜない。**
 */
function linesOf(value: unknown): string[] {
  if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
  if (Array.isArray(value)) return value.flatMap((v) => (typeof v === 'string' && v.trim() ? [v.trim()] : []));
  return [];
}

function endsWithQuestion(text: string): boolean {
  return /[か？?]。?$/.test(text.trim());
}

export function openerFor(suggestion: ProactiveSuggestion, at: Date = new Date()): Opener {
  const lines = suggestion.because.flatMap((b) => linesOf(b.value));
  const head = suggestion.suggestion.trim();
  const ask = ASK[suggestion.ruleId] ?? (endsWithQuestion(head) ? null : DEFAULT_ASK);

  const parts = [head];
  if (lines.length > 0) parts.push(lines.map((l) => `- ${l}`).join('\n'));
  if (ask) parts.push(ask);

  const title = head.length > TITLE_CHARS ? `${head.slice(0, TITLE_CHARS - 1)}…` : head;
  const evidence = JSON.stringify(suggestion.because.map((b) => [b.kind, b.value]));

  return {
    key: `${suggestion.ruleId}|${localDate(at)}|${evidence}`,
    title,
    text: parts.join('\n\n'),
  };
}

/**
 * 会話の最初が IRIS の発言のときに、模型へ渡す履歴の頭に置く一行。
 *
 * 提供者の多くは**最初の発言が利用者であること**を求める（Anthropic は
 * 400 を返す）。かといって利用者が言っていないことを利用者の口に入れる
 * わけにはいかないので、**何が起きたかをそのまま書いた注記**を置く。
 */
export const OPENED_BY_IRIS_NOTE =
  '（この会話は利用者の発言からではなく、IRIS の見張りの提案から始まっている。' +
  '次の発言は IRIS が先に話しかけたもので、その次が利用者の返事。）';
