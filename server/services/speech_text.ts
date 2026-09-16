/**
 * Rewrites notation that is read wrongly when spoken aloud.
 *
 * Heard on 2026-08-19: Chirp 3 HD read `8/24` as 「にじゅうよんぶんのはち」 —
 * twenty-four over eight. Not a mispronunciation but a different reading of
 * the same characters, and a defensible one: a slash between two numbers is a
 * fraction as often as it is a date. Nothing about the output sounds broken,
 * which is what makes it worth fixing here rather than hoping a listener
 * notices.
 *
 * The rewrite is to Japanese notation, not to kana. `8/24` becomes `8月24日`
 * and the engine reads it correctly from there. Spelling it out as
 * 「はちがつにじゅうよっか」 would mean owning the day-of-month readings, which
 * are irregular for a third of the month, and owning them per engine forever.
 * The smaller change is the one that keeps working when the voice changes.
 *
 * Applied to the spoken string only. The display and the transcript keep the
 * original, for the same reason the pronunciation dictionary does: a log
 * reading `8月24日` where the user wrote `8/24` has replaced one wrong record
 * with another.
 */

export interface SpeechRewrite {
  /** What was rewritten, so a wrong rule can be found by ear and then by eye. */
  from: string;
  to: string;
}

export interface NormalizedSpeech {
  text: string;
  applied: SpeechRewrite[];
}

/**
 * `M/D` is treated as a date.
 *
 * It is genuinely ambiguous — 3/4 is March 4th or three quarters — and this
 * resolves it one way for everything. That is a real cost, taken deliberately:
 * what IRIS says out loud is schedules, deadlines and progress, where a slash
 * between small numbers is a date essentially every time. A fraction read as a
 * date is a mistake someone hears immediately and can report; a date read as a
 * fraction is the one that has been happening.
 *
 * Guarded against the cases that are definitely not dates: anything inside a
 * URL or path, and any run of three or more slash-separated numbers, which is
 * a version or a path rather than a date.
 */
const SLASH_DATE = /(?<![\d/:.\w-])(\d{1,2})\/(\d{1,2})(?![\d/])/g;

/** ISO dates and timestamps, which arrive from calendars and the register. */
const ISO_TIMESTAMP = /(?<![\d-])(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2})?(?:[+-]\d{2}:\d{2}|Z)?/g;
const ISO_DATE = /(?<![\d-])(\d{4})-(\d{2})-(\d{2})(?![\d-])/g;

/**
 * Thousands separators, which split a number into pieces that get read
 * separately.
 *
 * Heard on 2026-08-19: `¥5,000` came out as 「5円、れいれいれい」 — the amount
 * broken at the comma, the leading `¥5` read as five yen, and the remaining
 * `000` read as three zeroes one after another. Both halves were wrong and
 * neither sounded like a malfunction.
 *
 * Requires groups of exactly three digits, so a comma between two numbers in
 * prose is left alone.
 */
const THOUSANDS = /(?<![\d.])(\d{1,3}(?:,\d{3})+)(?![\d])/g;

/**
 * A currency symbol in front of the amount, which Japanese reads after it.
 *
 * `¥5000` is ごせんえん, not えんごせん — and read as written the symbol lands
 * before the number it belongs to.
 */
const CURRENCY = /([¥￥\$])\s?(\d+(?:\.\d+)?)/g;

/** `19:30`, and `19:30:45` when the seconds are actually there. */
const CLOCK = /(?<![\d:.\w])(\d{1,2}):(\d{2})(?::(\d{2}))?(?![\d:])/g;

/**
 * Counters whose reading depends on there being a number in front.
 *
 * `30問` is さんじゅうもん; a bare 問 is とい, and 問い合わせ has to stay
 * とい. So this is a rule about the pair, not a word to look up — which is
 * why it lives here rather than in the reading dictionary, whose entries are
 * plain substitutions with no notion of what precedes them.
 *
 * Heard on 2026-08-19: `30問` came out as さんじゅうとい.
 *
 * Only counters actually observed to be misread are listed. A table of every
 * counter in Japanese would be mostly guesses, and a guessed reading applied
 * silently and consistently is worse than none — the same reason the reading
 * dictionary was kept short.
 */
const COUNTERS: Array<{ pattern: RegExp; kana: string }> = [
  { pattern: /(\d+)問(?!い)/g, kana: 'もん' },
];

/**
 * `**強調**`, `*強調*`, `__強調__`, `` `code` `` — the marks, not the words.
 *
 * Non-greedy and single-line, so a stray asterisk elsewhere in a sentence does
 * not swallow everything up to the next one.
 */
const MARKDOWN_EMPHASIS = /(?:\*\*\*|\*\*|\*|__|_|`)([^\n*_`]+?)(?:\*\*\*|\*\*|\*|__|_|`)/g;

/** A list marker at the start of a line, which is layout rather than speech. */
const MARKDOWN_BULLET = /^[ \t]*[-*+•]\s+/gm;

/** `#`, `##` — the same. */
const MARKDOWN_HEADING = /^[ \t]*#{1,6}\s+/gm;

/**
 * A table's separator row, which carries no words at all.
 *
 * Tables arrived with the reading layer and the voice inherited them: left
 * alone, `|---|---|` is read out loud, dash by dash. The same failure the
 * asterisks were, one level up — anything written for the eye reaches the ear
 * unless something takes it out.
 */
const TABLE_RULE = /^[ \t]*\|?[\s:|-]*-[\s:|-]*\|?[ \t]*$\n?/gm;

/**
 * The pipes in a row, but only in a row.
 *
 * A line has to open and close with one to count, so `A|B の形式` keeps its
 * pipe and `|春|15度|` becomes two spoken cells.
 */
const TABLE_ROW = /^[ \t]*\|(.+)\|[ \t]*$/gm;

/** Where a slash is structure rather than a date. */
const URLISH = /(?:https?:\/\/|\/{2,}|~?\/[\w.-]+\/)/;

function stripLeadingZero(n: string): string {
  const v = String(Number(n));
  return v;
}

/**
 * Rewrites one line, leaving anything URL-shaped alone.
 *
 * Paths and URLs are split out first rather than being excluded by a cleverer
 * expression, because every attempt to write one expression that understands
 * both dates and paths ends up understanding neither.
 */
export function normalizeForSpeech(text: string): NormalizedSpeech {
  const applied: SpeechRewrite[] = [];
  const record = (from: string, to: string) => {
    if (from !== to) applied.push({ from, to });
    return to;
  };

  // Split on whitespace-delimited tokens that look like a URL or a path, and
  // pass those through untouched.
  const parts = text.split(/(\S*(?:https?:\/\/|\/\/)\S*|\S*~?\/[\w.-]+\/\S*)/g);

  const rewritten = parts.map((part) => {
    if (!part || URLISH.test(part)) return part;

    let out = part;

    /**
     * Markdown, removed before anything reads it out loud.
     *
     * The reply is written for a screen and then handed to a voice, and the
     * voice read the punctuation: on 2026-08-20 a calendar answer came out as
     * 「アスタリスク 19時」. Worse, IRIS then heard itself say 「アスタ」,
     * failed to match it against its own script — which contains `**`, not the
     * word — and treated it as someone interrupting. It stopped its own
     * sentence.
     *
     * Emphasis and list markers carry nothing a listener can hear, so they go.
     * The words between them stay exactly as written.
     */
    out = out.replace(MARKDOWN_EMPHASIS, (whole, inner) => record(whole, inner));
    out = out.replace(MARKDOWN_BULLET, (whole) => record(whole, ''));
    out = out.replace(MARKDOWN_HEADING, (whole) => record(whole, ''));
    out = out.replace(TABLE_RULE, (whole) => record(whole, ''));
    out = out.replace(TABLE_ROW, (whole, inner) =>
      record(whole, String(inner).split('|').map((c: string) => c.trim()).filter(Boolean).join(' '))
    );

    // Separators first, so everything after this sees one number rather than
    // several. A currency rule looking at `¥5,000` otherwise matches only the
    // `5`.
    out = out.replace(THOUSANDS, (whole) => record(whole, whole.replace(/,/g, '')));

    out = out.replace(CURRENCY, (whole, symbol, amount) =>
      record(whole, symbol === '$' ? `${amount}ドル` : `${amount}円`)
    );

    // Timestamps first: they contain both a date and a clock, and letting the
    // clock rule see them first would rewrite the middle of one.
    out = out.replace(ISO_TIMESTAMP, (whole, y, m, d, hh, mm) =>
      record(
        whole,
        `${Number(y)}年${Number(m)}月${Number(d)}日${Number(hh)}時${Number(mm) === 0 ? '' : `${Number(mm)}分`}`
      )
    );

    out = out.replace(ISO_DATE, (whole, y, m, d) =>
      record(whole, `${Number(y)}年${Number(m)}月${Number(d)}日`)
    );

    out = out.replace(CLOCK, (whole, hh, mm, ss) => {
      const hour = Number(hh);
      const minute = Number(mm);
      if (hour > 23 || minute > 59) return whole;
      const seconds = ss !== undefined ? `${Number(ss)}秒` : '';
      return record(whole, `${hour}時${minute === 0 && !seconds ? '' : `${minute}分`}${seconds}`);
    });

    for (const { pattern, kana } of COUNTERS) {
      out = out.replace(pattern, (whole, n) => record(whole, `${n}${kana}`));
    }

    out = out.replace(SLASH_DATE, (whole, m, d) => {
      const month = Number(m);
      const day = Number(d);
      // Outside a real month or day it is arithmetic, and reading it as a date
      // would be inventing one.
      if (month < 1 || month > 12 || day < 1 || day > 31) return whole;
      return record(whole, `${stripLeadingZero(m)}月${stripLeadingZero(d)}日`);
    });

    return out;
  });

  return { text: rewritten.join(''), applied };
}
