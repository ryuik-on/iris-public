/**
 * Whether an utterance was addressed to IRIS.
 *
 * The microphone hears the room, not a decision to talk to IRIS. `src/App.tsx`
 * already says so, and puts every transcript in the input box rather than
 * sending it — dictating straight into a sent message turns a remark to
 * someone else into a request. That judgement stands; this only decides which
 * utterances may skip the manual send.
 *
 * Missing a wake word costs a button press. Inventing one sends a private
 * remark to a cloud model. So the matching is deliberately narrow — the name
 * has to open the utterance — and anything unmatched keeps the existing
 * behaviour of landing in the input box, where nothing is lost.
 *
 * The name is 「イーリス」 and the transcriber will not spell it that way every
 * time. Japanese speech recognition moves between hiragana, katakana and
 * romaji by context, and a long vowel is exactly where it wavers. Accepting
 * one spelling would mean a name that works on most days.
 */

/** Spellings of the name that count. Matched at the start of an utterance. */
export const WAKE_WORDS = [
  'イーリス',
  'いーりす',
  'イリス',
  'いりす',
  'アイリス',
  'あいりす',
  'IRIS',
  'iris',
  'Iris',
];

/**
 * Katakana, including the long-vowel mark and the half-width forms.
 *
 * A name followed by more katakana is a compound noun far more often than an
 * address — 「アイリスオーヤマ」, 「イリスコーポレーション」.
 */
function isKatakana(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return (code >= 0x30a0 && code <= 0x30ff) || (code >= 0xff66 && code <= 0xff9d);
}

/** A single character that can stand between the name and the request. */
const SEPARATORS = /[\s、,。.!！?？:：」』〜ー]/;

/** The same set, stripped from the front of the remaining request. */
const LEADING_SEPARATORS = /^[\s、,。.!！?？:：」』]*/;

export interface WakeResult {
  /** True when the utterance opened with the name. */
  addressed: boolean;
  /** The request with the name removed, when it was addressed. */
  request: string;
  /** Which spelling matched, for a log that can explain a miss. */
  matched: string | null;
}

/**
 * Full-width to half-width, so a transcriber's choice of width is not a
 * different name.
 */
function normalize(text: string): string {
  return text
    .replace(/[Ａ-Ｚａ-ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .trim();
}

/**
 * Decides whether an utterance is a request to IRIS.
 *
 * Only at the start. A name in the middle is usually someone being talked
 * about rather than talked to — 「さっきイーリスが言ってたやつ」 is a remark to a
 * person, and sending it would be the exact failure the input-box design
 * exists to prevent.
 */
export function detectWakeWord(utterance: string, words: string[] = WAKE_WORDS): WakeResult {
  const text = normalize(utterance);
  if (!text) return { addressed: false, request: '', matched: null };

  // Longest first, so 「アイリス」 is not claimed by a shorter spelling that
  // happens to be a prefix of it.
  const ordered = [...words].sort((a, b) => b.length - a.length);

  for (const word of ordered) {
    const candidate = normalize(word);
    if (!text.toLowerCase().startsWith(candidate.toLowerCase())) continue;

    const after = text.slice(candidate.length);

    /**
     * A separator, or a next character that is not more katakana.
     *
     * Requiring a separator was the first rule and it did not survive contact:
     * spoken naturally there is no pause, and the transcriber wrote
     * 「イリス今日の予定は。」 with no comma at all. Every real request would
     * have landed in the input box, which is the feature not working.
     *
     * What the separator was actually protecting against is a proper noun that
     * happens to begin with the name — 「アイリスオーヤマの棚買った」, a remark
     * about a shelf, sent to a cloud model. Those continue in katakana,
     * because that is how a katakana compound is written. A request does not:
     * it starts with kanji or kana (今日, 明日, ちょっと).
     *
     * So the test is the script of the next character, which separates the two
     * cases without requiring a pause nobody makes.
     */
    const next = after[0] ?? '';
    const separated = after.length === 0 || SEPARATORS.test(next) || !isKatakana(next);
    if (!separated) continue;

    const rest = after.replace(LEADING_SEPARATORS, '');
    // The name alone is an address with no request. Treated as addressed so
    // IRIS can answer 「はい」 rather than silently keeping it in the box.
    return { addressed: true, request: rest, matched: word };
  }

  return { addressed: false, request: text, matched: null };
}
