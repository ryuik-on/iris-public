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
 * 根拠が変われば（期限の過ぎた課題が増えた、日数が進んだ）別の話になる。
 *
 * ただし**別の話でも、別の会話にはしない。**同じ規則の前の会話に返事が無いまま
 * 根拠が変わると、日数が一つ進むたびに新しい会話が開き、未読が積もっていった
 * （「期限まであと◯日」が毎日一本）。返事待ちの会話があるあいだは、新しい根拠を
 * **その会話に書き足す**（`planOpeners`）。同じ規則の返事待ちは、いつも一本。
 *
 * ## 同じ巡回で出たものは一本にまとめる
 *
 * 一度の見回りで規則が三つ発火すると、会話が三本開いていた。同時に気づいた
 * ことは、一度に言う（`bundleOpener`）。
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
 * 同じ巡回で発火した提案を、一本の会話の最初の一言にする。
 *
 * 一件なら `openerFor` と同じもの。二件以上なら、件数を頭に、項目ごとに提案の文と
 * 根拠の行を並べ、問いは最後に一つだけ置く（項目ごとに問うと、どれに答えればよいか
 * 分からない）。鍵は項目ごとに `openerFor` の鍵を使う —— 控えも項目ごとに残すので、
 * 「同じ規則・同じ根拠・同じ日」の見分けはまとめても変わらない。
 */
export function bundleOpener(suggestions: ProactiveSuggestion[], at: Date = new Date()): Opener {
  if (suggestions.length === 0) throw new Error('まとめる提案がありません。');
  if (suggestions.length === 1) return openerFor(suggestions[0], at);

  const items = suggestions.map((s, i) => {
    const lines = s.because.flatMap((b) => linesOf(b.value));
    const head = `${i + 1}. ${s.suggestion.trim()}`;
    return lines.length > 0 ? `${head}\n${lines.map((l) => `   - ${l}`).join('\n')}` : head;
  });
  const title = `気になることが ${suggestions.length} 件あります`;
  return {
    key: suggestions.map((s) => openerFor(s, at).key).join('+'),
    title,
    text: [`${title}。`, items.join('\n'), BUNDLE_ASK].join('\n\n'),
  };
}
const BUNDLE_ASK = 'どれから話しますか。もう片付いているものがあれば、そう言ってください。';

/** 控えのうち、`planOpeners` が見るところ。 */
export interface OpenerLedger {
  has(key: string): boolean;
  /** この規則の、返事を待っている（まだ残っている）会話の控え。無ければ undefined。 */
  waitingFor(ruleId: string): { key: string; conversationId: string; createdAt: string } | undefined;
}

export interface OpenerPlan {
  /** 同じ規則・同じ根拠・同じ日の控えがある。何もしない。 */
  repeated: ProactiveSuggestion[];
  /** 返事待ちの会話が新しい（`holdMs` 以内）。まだ重ねない。 */
  held: Array<{ suggestion: ProactiveSuggestion; waitingOn: string }>;
  /** 返事待ちの会話に、新しい根拠を書き足す。控えはその一本を付け替える。 */
  refreshed: Array<{ suggestion: ProactiveSuggestion; opener: Opener; conversationId: string; previousKey: string }>;
  /** 新しく開くもの。まとめて一本（`bundle`）にする。 */
  fresh: Array<{ suggestion: ProactiveSuggestion; opener: Opener }>;
  bundle: Opener | null;
}

/** 返事待ちの会話に、次を書き足すまで待つ時間。それより前の書き足しは重ねない。 */
export const HOLD_MS = 24 * 3_600_000;

/**
 * 一度の巡回で発火した提案を、どう話すかに振り分ける。模型は呼ばない。
 *
 * 順に見るのは三つ。**同じ鍵の控えがある**なら何もしない（前からの「二度言わない」）。
 * **同じ規則の返事待ちがある**なら、新しい会話は開かない —— 開いて `holdMs` 以内なら
 * 待ち、過ぎていれば新しい根拠をその会話に書き足す。前は 24 時間を過ぎると二本目を
 * 開いていたので、返事をしないあいだ毎日一本ずつ増えた。**どちらでもなければ**新しく
 * 開き、同じ巡回の新しいものは一本にまとめる。
 */
export function planOpeners(
  suggestions: ProactiveSuggestion[],
  ledger: OpenerLedger,
  at: Date = new Date(),
  holdMs: number = HOLD_MS
): OpenerPlan {
  const plan: OpenerPlan = { repeated: [], held: [], refreshed: [], fresh: [], bundle: null };
  const seen = new Set<string>();
  for (const suggestion of suggestions) {
    // 同じ巡回で同じ規則が二度出ることは無いはずだが、出ても一本に数える。
    if (seen.has(suggestion.ruleId)) continue;
    seen.add(suggestion.ruleId);

    const opener = openerFor(suggestion, at);
    if (ledger.has(opener.key)) { plan.repeated.push(suggestion); continue; }
    const waiting = ledger.waitingFor(suggestion.ruleId);
    if (waiting) {
      if (at.getTime() - Date.parse(waiting.createdAt) < holdMs) {
        plan.held.push({ suggestion, waitingOn: waiting.conversationId });
      } else {
        plan.refreshed.push({ suggestion, opener, conversationId: waiting.conversationId, previousKey: waiting.key });
      }
      continue;
    }
    plan.fresh.push({ suggestion, opener });
  }
  if (plan.fresh.length > 0) plan.bundle = bundleOpener(plan.fresh.map((f) => f.suggestion), at);
  return plan;
}

/**
 * レールに出す二文字。
 *
 * レールの幅は 52 ポイントで、題は入らない。**入らないものを縮めて入れると、
 * 読めない字が並ぶだけで読めた気にさせる**（`Rail.swift` の予定の段と同じ理由）。
 * 何の話かが分かる語を一つ。中身は押した先の会話にある。
 */
const LABELS: Record<string, string> = {
  'watch.deadline-pressing': '期限',
  'watch.lectures-divergent': '講義',
  'watch.lectures-new-version': '講義',
  'watch.grant-dead': '認可',
  'watch.delegation-finished': '委任',
  'agent.started': '開発',
  'agent.gave-up': '開発',
  'morning.brief': '今朝',
  'self.fix': '改善',
};
export function railLabel(ruleId: string): string {
  return LABELS[ruleId] ?? '話';
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
