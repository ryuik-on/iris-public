/**
 * What happened when this was tried before.
 *
 * Distinct from the two stores next to it, and the distinction is worth being
 * exact about. A memory says what is true. A decision says why a choice was
 * made. An experience says what happened when something was attempted — which
 * is neither a fact about the world nor a choice, but an observation about a
 * method.
 *
 * The register states the constraint in one line: 過去の成功は根拠であって
 * 法則ではない. Something that worked is evidence that it worked once, under
 * whatever conditions happened to hold. Treating it as a rule is how a system
 * accumulates confident habits that stopped being true.
 *
 * So the count is part of the record and never collapses into certainty. An
 * experience observed once and an experience observed eleven times are stored
 * the same way and read differently, and nothing here converts the second into
 * a law.
 *
 * The failures are the more useful half. Today produced three attempts that
 * failed repeatedly in the same shape — joining commands with `;` so a failure
 * did not stop the next step, checking a test suite by grepping its output
 * instead of its exit code, and shipping something that unit tests passed and
 * a live run broke. Each was noticed, fixed, and then repeated. A store that
 * only kept successes would have recorded none of them.
 */

export type Outcome =
  /** It did what was wanted. Once. */
  | 'worked'
  /** It did not. */
  | 'failed'
  /** Part of it did, and the record says which part. */
  | 'partial';

export interface ExperienceInput {
  /** What was tried, phrased so it can be recognised when it comes up again. */
  attempt: string;
  /** The conditions this was under. An experience without them is a superstition. */
  situation: string;
  outcome: Outcome;
  /** What to do about it next time. The part that makes this worth storing. */
  learned: string;
  evidence?: string[];
  affects?: string[];
}

export interface Experience extends ExperienceInput {
  id: string;
  evidence: string[];
  affects: string[];
  /** How many times this has been observed. Never rounded up to certainty. */
  observations: number;
  /** Outcomes seen, in order. A method that stopped working shows here first. */
  outcomes: Outcome[];
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface ExperienceVerdict {
  ok: boolean;
  adjusted?: ExperienceInput;
  reason: string;
}

/**
 * The key two attempts share when they are the same attempt.
 *
 * Deliberately crude — punctuation and spacing removed, nothing else. A
 * cleverer similarity would merge things that differ in ways that mattered,
 * and merging is not reversible: once two experiences are one row, the fact
 * that they were different is gone.
 */
export function attemptKey(attempt: string): string {
  return attempt.toLowerCase().replace(/[\s　、。,.!?！？「」『』()（）・]/g, '');
}

export function validateExperience(input: ExperienceInput): ExperienceVerdict {
  const attempt = input.attempt?.trim() ?? '';
  const learned = input.learned?.trim() ?? '';
  const situation = input.situation?.trim() ?? '';

  if (!attempt) return { ok: false, reason: '何を試したのかが書かれていません。' };
  if (!situation) {
    // Without the conditions it is not an experience, it is a superstition —
    // "this worked" with no account of when.
    return { ok: false, reason: '状況が書かれていません。条件のない経験は迷信です。' };
  }
  if (!learned) {
    // The outcome alone is a log entry. What makes it worth keeping is what to
    // do differently, and writing that down is where the thinking happens.
    return { ok: false, reason: '次にどうするかが書かれていません。結果だけでは記録する意味がありません。' };
  }

  return {
    ok: true,
    adjusted: {
      ...input,
      attempt,
      situation,
      learned,
      evidence: (input.evidence ?? []).filter(Boolean),
      affects: (input.affects ?? []).filter(Boolean),
    },
    reason: '記録します。',
  };
}

/**
 * How an experience should read when it is being consulted.
 *
 * The count is stated every time, and so is the fact that it is a count. One
 * observation phrased as advice reads exactly like a rule, and the difference
 * only survives if it is written down each time it is repeated.
 */
export function describeExperience(e: Experience): string {
  const outcome =
    e.outcome === 'worked' ? '成功' : e.outcome === 'failed' ? '失敗' : '部分的';
  const lines = [
    `${e.attempt}`,
    `  状況: ${e.situation}`,
    `  結果: ${outcome}（${e.observations}回の観測）`,
    `  次回: ${e.learned}`,
  ];

  if (e.observations > 1) {
    const failures = e.outcomes.filter((o) => o === 'failed').length;
    if (failures > 1) {
      // The line worth putting in front of somebody: this has gone wrong more
      // than once, in the same way.
      lines.push(`  ⚠ 同じ形で ${failures} 回失敗しています。`);
    }
    if (e.outcomes.includes('worked') && e.outcomes.includes('failed')) {
      lines.push('  ⚠ 成功と失敗の両方が観測されています。条件の違いを確かめてください。');
    }
  } else {
    lines.push('  観測は1回だけです。うまくいった根拠であって、うまくいく法則ではありません。');
  }

  if (e.affects.length > 0) lines.push(`  対象: ${e.affects.join(', ')}`);
  return lines.join('\n');
}
