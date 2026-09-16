/**
 * Why something was decided, kept where it can be asked about later.
 *
 * The activity log already records that decisions happened. What it cannot
 * answer is the question that actually comes up: why this and not the other
 * thing. Today that answer lived in commit messages and in whoever was in the
 * conversation at the time, which means it survives exactly as long as the
 * conversation does.
 *
 * Several decisions taken today are worth being able to interrogate later, and
 * each is a different shape:
 *
 *   Ordered the calendar sources by what each can honestly claim rather than
 *   by speed — and then found that ordering was the wrong idea entirely,
 *   because no single source sees everything.
 *
 *   Set the echo threshold to an absolute count after a proportional one
 *   failed live in a way no unit test had caught.
 *
 *   Did not build automatic model fallback, because provider-level failover
 *   already covers it and swapping models silently changes cost.
 *
 * The last one is the important case: a decision *not* to build something
 * leaves no code behind. Six months later the absence looks like an oversight
 * rather than a choice, and it gets built by someone who never saw the reason.
 *
 * Two properties this refuses to fake.
 *
 * A decision recorded with no alternatives is a decision that considered none.
 * The record says so rather than presenting a single option as a conclusion —
 * "we chose X" and "X was the only thing anyone thought of" are different, and
 * the second is worth knowing about.
 *
 * Who decided is kept separate from what was decided. The user choosing not to
 * build the coding agent invocation and IRIS concluding the same thing carry
 * completely different weight when the question is reopened.
 */

export type DecidedBy =
  /** The user said so. Not IRIS's to revisit unprompted. */
  | 'user'
  /** IRIS decided within its own scope. */
  | 'iris'
  /** Forced by something outside — an API's behaviour, a platform rule. */
  | 'constraint';

export interface Alternative {
  option: string;
  /** Why not this one. An alternative with no reason was not considered. */
  rejectedBecause: string;
}

export interface DecisionInput {
  /** Short enough to scan, specific enough to find. */
  title: string;
  /** What was actually decided, in the form it should be read later. */
  decided: string;
  decidedBy: DecidedBy;
  /** What made this the answer. Measurements, quotes, observed behaviour. */
  grounds: string[];
  /** The alternatives that were weighed, and why each lost. */
  alternatives?: Alternative[];
  /** A rule or principle applied, when one was. */
  rule?: string | null;
  /**
   * What it would take to undo this.
   *
   * Recorded because reversibility is what decides how much care a decision
   * deserved, and it is invisible afterwards. A schema migration and a default
   * setting read the same in a log.
   */
  reversal?: string | null;
  /** Register keys, files, commits — what this decision governs. */
  affects?: string[];
  topicRef?: string | null;
}

export interface Decision extends DecisionInput {
  id: string;
  alternatives: Alternative[];
  affects: string[];
  createdAt: string;
  /** Set when a later decision replaced this one. */
  revisedBy?: string | null;
}

export interface DecisionVerdict {
  ok: boolean;
  adjusted?: DecisionInput;
  /** What is missing or was corrected, said plainly. */
  reason: string;
}

/**
 * Checks a decision is recorded as what it is.
 *
 * Rejects little. Its job is to stop a record claiming more than was actually
 * done — an empty alternatives list is fine and is recorded as such, but it
 * must not be presented later as though options had been weighed.
 */
export function validateDecision(input: DecisionInput): DecisionVerdict {
  const title = input.title?.trim() ?? '';
  const decided = input.decided?.trim() ?? '';
  if (!title) return { ok: false, reason: '表題がありません。' };
  if (!decided) return { ok: false, reason: '何を決めたのかが書かれていません。' };

  const grounds = (input.grounds ?? []).map((g) => g.trim()).filter(Boolean);
  if (grounds.length === 0) {
    // A decision with no grounds is a preference. Recording it as a decision
    // would let it be cited later as though something supported it.
    return { ok: false, reason: '根拠が空です。根拠のない決定は決定ではなく好みです。' };
  }

  // An alternative without a reason was not weighed against anything; keeping
  // it would inflate the appearance of deliberation.
  const alternatives = (input.alternatives ?? []).filter(
    (a) => a.option?.trim() && a.rejectedBecause?.trim()
  );
  const dropped = (input.alternatives ?? []).length - alternatives.length;

  return {
    ok: true,
    adjusted: {
      ...input,
      title,
      decided,
      grounds,
      alternatives,
      affects: (input.affects ?? []).filter(Boolean),
      rule: input.rule?.trim() || null,
      reversal: input.reversal?.trim() || null,
    },
    reason:
      dropped > 0
        ? `理由のない代替案 ${dropped} 件を除きました。検討されていない選択肢は検討の証拠になりません。`
        : alternatives.length === 0
          ? '代替案なしとして記録します。比較されていないことも事実の一部です。'
          : '記録します。',
  };
}

/**
 * How a decision should read when it is being reconsidered.
 *
 * Written out rather than left to whoever renders it, because the omissions
 * are the point: a decision with no alternatives has to *say* it had none,
 * not merely lack a section.
 */
export function explain(decision: Decision): string {
  const who =
    decision.decidedBy === 'user' ? '利用者の判断'
    : decision.decidedBy === 'constraint' ? '外部制約による'
    : 'IRIS の判断';

  const lines = [
    `${decision.title}`,
    `決定: ${decision.decided}`,
    `決めたのは: ${who}`,
    `根拠:`,
    ...decision.grounds.map((g) => `  - ${g}`),
  ];

  if (decision.rule) lines.push(`適用した規則: ${decision.rule}`);

  if (decision.alternatives.length > 0) {
    lines.push('検討した代替案:');
    for (const a of decision.alternatives) lines.push(`  - ${a.option} — ${a.rejectedBecause}`);
  } else {
    // Stated, not omitted. Silence here reads as "nothing else was worth
    // considering" when it usually means nobody looked.
    lines.push('検討した代替案: なし（比較していない）');
  }

  lines.push(decision.reversal ? `取り消すには: ${decision.reversal}` : '取り消す手順: 未記録');
  if (decision.affects.length > 0) lines.push(`影響範囲: ${decision.affects.join(', ')}`);
  if (decision.revisedBy) lines.push(`この決定は後に見直されています (${decision.revisedBy})`);

  return lines.join('\n');
}
