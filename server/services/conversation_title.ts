/**
 * A name for a thread, written rather than cut.
 *
 * `deriveTitle` takes the first forty-one characters of whatever was said
 * first, which is a truncation, not a title: "codex にダッシュボードUIの設計相談
 * を任せて。成果物は docs/hud…" tells a person scanning a list almost nothing
 * that "ダッシュボードUIの設計相談" would not tell them in half the width.
 *
 * The decision recorded with that function says no model call is spent on
 * titling — and the same comment says refinement can be layered on later.
 * This is the layer. It runs after the reply, never before, so a thread is
 * usable the instant it exists and gets a better name a few seconds on.
 *
 * Deliberately the cheapest model available and a very small output. A title
 * is worth about a sentence of thought; anything more is spending the week's
 * allowance on filing.
 */

export interface Titler {
  /** Returns a short title, or null when one could not be produced. */
  suggest(firstUserMessage: string, firstReply: string): Promise<string | null>;
}

const MAX_CHARS = 24;

/**
 * Strips the things a model adds when asked for a title.
 *
 * Quotes, a trailing full stop, a leading "タイトル:" — all of which are the
 * model being helpful and none of which belong in a list of threads. Refuses
 * anything with a newline: that is a model that answered a different question,
 * and a wrong title is worse than a truncated one because it is confident.
 */
export function tidyTitle(raw: string): string | null {
  const first = raw.trim();
  if (!first || first.includes('\n')) return null;
  const cleaned = first
    .replace(/^(タイトル|title)\s*[:：]\s*/i, '')
    .replace(/^["'「『]|["'」』]$/g, '')
    .replace(/[。.]$/, '')
    .trim();
  if (!cleaned) return null;
  const chars = Array.from(cleaned);
  return chars.length <= MAX_CHARS ? cleaned : chars.slice(0, MAX_CHARS - 1).join('') + '…';
}

export function buildPrompt(firstUserMessage: string, firstReply: string): string {
  return [
    '次のやり取りに、一覧で見分けるための短い題名を付けてください。',
    '',
    '- 日本語で、24文字以内。名詞句にしてください。',
    '- 題名だけを返してください。前置きも引用符も句点も要りません。',
    '- 依頼の内容を表してください。「質問」「相談」のような一般語だけにしないでください。',
    '',
    '--- 利用者 ---',
    firstUserMessage.slice(0, 600),
    '',
    '--- IRIS ---',
    firstReply.slice(0, 600),
  ].join('\n');
}
