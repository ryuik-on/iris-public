/**
 * Checking what IRIS said against what came back through the microphone.
 *
 * The idea is the user's, and it turns on something that human speech cannot
 * offer: when IRIS speaks, the correct text is known exactly. There is no
 * ground truth for what a person said — that is why transcription is hard —
 * but IRIS wrote the sentence it just read aloud. Anything the microphone
 * brings back that disagrees with it is a place worth looking.
 *
 * The comparison already happens. Barge-in asks whether an incoming partial
 * resembles the utterance in progress, to tell the user's voice from the
 * assistant's own. It uses the answer as one bit and discards where and how
 * the two diverged — and that discarded difference is the measurement.
 *
 * What it cannot do is fix anything, and the reason is that a divergence has
 * three causes that look identical from here:
 *
 *   The voice mispronounced it. `30問` read as さんじゅうとい.
 *   Recognition misheard it. `8月24日`, spoken correctly, transcribed `8月二4日`.
 *   The room interfered.
 *
 * Only a listener can tell those apart. Deriving a reading from a divergence
 * would encode recognition errors as pronunciation rules — which is the
 * failure the reading dictionary is deliberately kept short to avoid, since a
 * wrong entry is then applied silently and consistently and stops being
 * noticeable. So this produces candidates for a person to confirm, and nothing
 * else.
 *
 * It also only works through a speaker. With earphones there is no acoustic
 * path back and nothing to compare, which is the same fact that makes barge-in
 * easy in that case.
 */

export interface Divergence {
  /** What the source text had at this point. */
  expected: string;
  /** What came back instead. */
  heard: string;
  /** Enough of the surrounding text to recognise the place. */
  context: string;
}

export interface PronunciationAudit {
  /** The text handed to the voice, after the reading dictionary. */
  spoken: string;
  /** The best transcript of it that came back. */
  heard: string;
  /** How much of the utterance the microphone actually covered, 0..1. */
  coverage: number;
  divergences: Divergence[];
  /** Why no audit was possible, when none was. */
  skipped?: string;
}

/** Removed before comparing: neither side produces these consistently. */
function comparable(text: string): { text: string; map: number[] } {
  const kept: string[] = [];
  const map: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (/[\s　、。，．,.!?！？「」『』（）()・…—\-]/.test(c)) continue;
    kept.push(c);
    map.push(i);
  }
  return { text: kept.join(''), map };
}

/**
 * The longest common subsequence, as index pairs.
 *
 * Character-level and quadratic, which is fine for one utterance and would not
 * be for a transcript. Bounded below so a pathological input cannot stall the
 * speech path.
 */
function align(a: string, b: string): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0 || n * m > 4_000_000) return [];

  const table: Uint32Array = new Uint32Array((n + 1) * (m + 1));
  const at = (i: number, j: number) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[at(i, j)] =
        a[i] === b[j]
          ? table[at(i + 1, j + 1)] + 1
          : Math.max(table[at(i + 1, j)], table[at(i, j + 1)]);
    }
  }

  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (table[at(i + 1, j)] >= table[at(i, j + 1)]) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}

/**
 * How much of the source has to line up before the comparison means anything.
 *
 * Japanese shares characters freely, so two unrelated sentences match here and
 * there by accident and produce a long list of differences that describes
 * nothing. Below this the honest answer is that the microphone caught
 * something else.
 */
const MIN_MATCH_RATIO = 0.4;

/**
 * Compares an utterance with its echo.
 *
 * Only the span the microphone actually covered is examined. An echo that
 * caught the first two sentences says nothing about the third, and reporting
 * the rest as divergent would bury the real findings under the tail every
 * time — which is how a report becomes something people stop reading.
 */
export function auditPronunciation(spoken: string, heard: string): PronunciationAudit {
  const base = { spoken, heard };

  if (!spoken.trim() || !heard.trim()) {
    return { ...base, coverage: 0, divergences: [], skipped: '比較する材料がありません。' };
  }

  const s = comparable(spoken);
  const h = comparable(heard);
  const pairs = align(s.text, h.text);

  const matchRatio = pairs.length / s.text.length;
  if (pairs.length === 0 || matchRatio < MIN_MATCH_RATIO) {
    // Nothing lined up at all. Almost always means the microphone caught
    // something else entirely, not that every word was mispronounced.
    return {
      ...base,
      coverage: 0,
      divergences: [],
      skipped: '一致する箇所がありません。別の音を拾った可能性が高く、誤読の判断材料になりません。',
    };
  }

  const firstMatch = pairs[0][0];
  const lastMatch = pairs[pairs.length - 1][0];
  const covered = lastMatch - firstMatch + 1;
  const coverage = covered / s.text.length;

  const divergences: Divergence[] = [];
  for (let k = 0; k < pairs.length - 1; k++) {
    const [si, hi] = pairs[k];
    const [sj, hj] = pairs[k + 1];
    const expected = s.text.slice(si + 1, sj);
    const gotten = h.text.slice(hi + 1, hj);
    if (!expected && !gotten) continue;
    // Single characters are reported too. They were filtered as recogniser
    // noise until the filter removed the one case this was built from —
    // `8月24日` came back as `8月二4日`, a difference of exactly one character.
    // Length does not separate a real finding from noise, and pretending it
    // does throws away the findings while keeping the confidence.

    // Located in the original text so the report points at something the user
    // can find, not at the stripped comparison form.
    const from = s.map[Math.max(0, si - 3)] ?? 0;
    const to = s.map[Math.min(s.map.length - 1, sj + 3)] ?? spoken.length - 1;
    divergences.push({
      expected,
      heard: gotten,
      context: spoken.slice(from, to + 1),
    });
  }

  return { ...base, coverage, divergences };
}

/**
 * The audit as something to read.
 *
 * States all three explanations every time. A list of divergences headed
 * "mispronunciations" would train whoever reads it to accept recognition
 * errors as facts about the voice, and there is no way to tell from here which
 * one any given line is.
 */
export function describeAudit(audit: PronunciationAudit): string {
  if (audit.skipped) return `読み上げの照合: ${audit.skipped}`;
  if (audit.divergences.length === 0) {
    return `読み上げの照合: 原稿と一致しました（${Math.round(audit.coverage * 100)}% を照合）。`;
  }
  const lines = [
    `読み上げの照合: ${audit.divergences.length} 箇所が原稿と違って聞こえました` +
      `（${Math.round(audit.coverage * 100)}% を照合）。`,
  ];
  for (const d of audit.divergences) {
    lines.push(`  原稿「${d.expected}」→ 聞こえた「${d.heard}」  …${d.context}…`);
  }
  lines.push(
    '原因は3通りあります: 読み上げの誤読、認識の誤り、周囲の雑音。' +
      'この3つは音を聞いた人にしか区別できないため、辞書には自動で追加しません。'
  );
  return lines.join('\n');
}
