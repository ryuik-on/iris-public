/**
 * Deciding whether IRIS should stop talking because someone else started.
 *
 * The mechanism is trivial — a partial transcript arrives while audio is
 * playing, and playback is aborted. Everything difficult here is about the one
 * fact that makes naive barge-in useless: the microphone hears the speaker.
 *
 * Wired directly, IRIS begins a sentence, its own voice arrives as a partial
 * transcript a moment later, and it interrupts itself. Every time, on the
 * first word. So the question this module answers is not "did the microphone
 * hear something" but "did it hear *someone else*", and the whole of it is
 * the difference between those.
 *
 * Three filters, in the order they cost least:
 *
 *   A grace period. Nothing counts for a moment after audio begins, because
 *   that window is exactly when the assistant's own first syllables come back
 *   round.
 *
 *   A length floor. A one-character partial is as likely to be a cough, a
 *   keyboard, or the tail of a word as it is an interruption, and stopping on
 *   one makes the assistant unusable in a room with any noise in it.
 *
 *   Self-echo. If what came back resembles what is currently being said, it is
 *   the speaker. This is the one that does the real work, and it is why the
 *   text being spoken has to be passed in rather than merely a flag saying
 *   that speech is happening.
 *
 * Being wrong in one direction costs an interruption that should not have
 * happened; being wrong in the other costs an assistant that talks over its
 * user. The second is worse, so the filters are kept as loose as they can be
 * while still surviving the echo.
 */

export interface BargeInDecision {
  /** Whether speech should be stopped. */
  interrupt: boolean;
  /** Why not, when not. Reported so a barge-in that never fires can be diagnosed. */
  reason:
    | 'interrupt'
    | 'not_speaking'
    | 'within_grace'
    | 'too_short'
    | 'self_echo';
}

export interface BargeInOptions {
  /**
   * How long after audio starts to ignore the microphone entirely.
   *
   * Covers the round trip of the assistant's own opening words. Too long and a
   * user cannot cut off a reply they immediately recognise as unwanted, which
   * is the main thing barge-in is for.
   */
  graceMs?: number;
  /** Shortest partial that will be treated as someone speaking. */
  minChars?: number;
  /**
   * How many characters of the partial have to appear, contiguously, in what
   * is being said before it is treated as echo.
   *
   * An absolute count, not a fraction. It was a fraction, and that was wrong
   * in a way only a live test showed: recognition diverges from the spoken
   * text somewhere — `8月24日` came back as `8月二十 4日` — and the longest
   * matching run is capped at wherever that first happens. A fractional
   * threshold rises as the partial grows while the achievable match does not,
   * so the longer the assistant's own voice echoed, the more confidently it
   * was classified as somebody else. It suppressed correctly for two seconds
   * and then interrupted itself, which is the precise failure this module
   * exists to prevent.
   */
  echoChars?: number;
}

const DEFAULTS = { graceMs: 900, minChars: 3, echoChars: 8 };

/** Strips what differs between what was written and what came back. */
function comparable(text: string): string {
  return text
    .toLowerCase()
    // Punctuation and spacing survive synthesis unreliably and never help the
    // comparison, and Japanese recognition returns text with neither.
    .replace(/[\s、。，．,.!?！？「」『』()（）\-—…]/g, '');
}

/**
 * Whether a transcript looks like part of what is currently being spoken.
 *
 * The question is whether a long enough run of the partial appears in the
 * spoken text — not whether enough *of the partial* is accounted for. Those
 * differ once recognition mishears something in the middle, which it always
 * eventually does, and only the first survives it.
 *
 * Eight characters is the floor. Two Japanese clauses of genuine speech
 * coinciding with eight consecutive characters of what the assistant happens
 * to be saying is not something that occurs by accident; four or five is.
 */
export function looksLikeSelfEcho(
  partial: string,
  speaking: string,
  echoChars = DEFAULTS.echoChars
): boolean {
  const heard = comparable(partial);
  const said = comparable(speaking);
  if (!heard || !said) return false;
  if (said.includes(heard)) return true;

  // The last character of a partial is the one still being decided.
  //
  // Recognition grows a partial from the left and revises its tail as more
  // audio arrives — `記述式の30` became `記述式の30の` and then `記述式の30問`.
  // Requiring a short partial to match in full therefore fails on exactly the
  // transitional frames, and the assistant interrupts itself mid-word. Both
  // the partial and the partial minus its unstable tail are tried.
  for (const candidate of [heard, heard.slice(0, -1)]) {
    if (candidate.length < DEFAULTS.minChars) continue;
    const need = Math.min(echoChars, candidate.length);
    for (let start = 0; start + need <= candidate.length; start++) {
      if (said.includes(candidate.slice(start, start + need))) return true;
    }
  }
  return false;
}

export interface BargeInState {
  /** Null when nothing is being spoken. This is the string sent to the voice. */
  speakingText: string | null;
  /**
   * The same utterance before the reading dictionary and notation rules ran.
   *
   * Needed because recognition returns neither form reliably. `30問` is spoken
   * as `30もん` and transcribed back as `30問` — recognition hears the sound
   * and writes standard orthography, which matches what was asked for rather
   * than what was said. Checking only the spoken form made the assistant's own
   * voice fail the echo test and interrupt itself.
   */
  originalText?: string | null;
  /** When the current utterance began. */
  startedAt: number | null;
}

export function shouldBargeIn(
  partial: string,
  state: BargeInState,
  now: number,
  options: BargeInOptions = {}
): BargeInDecision {
  const { graceMs, minChars, echoChars } = { ...DEFAULTS, ...options };

  if (!state.speakingText || state.startedAt === null) {
    return { interrupt: false, reason: 'not_speaking' };
  }
  if (now - state.startedAt < graceMs) {
    return { interrupt: false, reason: 'within_grace' };
  }
  if (comparable(partial).length < minChars) {
    return { interrupt: false, reason: 'too_short' };
  }
  // Either form counts. A transcript resembling what was asked for is as much
  // the assistant's own voice as one resembling what was emitted.
  if (
    looksLikeSelfEcho(partial, state.speakingText, echoChars) ||
    (state.originalText ? looksLikeSelfEcho(partial, state.originalText, echoChars) : false)
  ) {
    return { interrupt: false, reason: 'self_echo' };
  }
  return { interrupt: true, reason: 'interrupt' };
}
