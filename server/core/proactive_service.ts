import { ContextEngine, ContextField, ContextSnapshot } from './context_engine.js';

/**
 * Turning inferred situation into something IRIS says first.
 *
 * The distinction this file is built around is between *suggesting* and
 * *acting*. An inference is a guess; a guess may open a conversation, and it
 * may never be the thing that sends the email. So nothing here executes
 * anything. It produces proposals, each carrying the observations that
 * produced it, and a person decides.
 *
 * Deterministic on purpose — the same reasoning that kept conversation titles
 * and topic suggestions free of a model call. Spending a model call to decide
 * whether to bother the user would mean paying, continuously, for the
 * privilege of being interrupted.
 *
 * Four gates, each closing a specific way this becomes annoying or wrong:
 *
 *   unknown      — a rule cannot fire on a field nothing has reported. Absence
 *                  of evidence is not evidence, and a house whose sensor is
 *                  silent must not trigger "you left the lights on".
 *   confidence   — measured against the decayed, capped number, not what the
 *                  source claimed. A weak guess stays a weak guess.
 *   disagreement — while two sources contradict each other, nothing fires. If
 *                  the system cannot tell what is happening, it has nothing to
 *                  be proactive about.
 *   cooldown     — the difference between an assistant and a nag.
 */

export interface RuleCondition {
  kind: string;
  /** Omit to require only that something is currently known about the kind. */
  equals?: unknown;
  /** Applied to the decayed, calibration-capped confidence. */
  minConfidence: number;
  /**
   * Refuse to fire on a source that has never been measured against reality.
   * Set for anything whose consequence the user would resent being wrong.
   */
  requireCalibrated?: boolean;
  maxAgeMs?: number;
}

export interface ProactiveRule {
  id: string;
  description: string;
  conditions: RuleCondition[];
  /** What to put to the user. A proposal, in their language. */
  suggestion: string;
  cooldownMs: number;
  /**
   * The turn to run if the user accepts. Absent means the suggestion is
   * informational and accepting it does nothing but dismiss it.
   */
  prompt?: string;
}

export interface ProactiveSuggestion {
  id: string;
  ruleId: string;
  suggestion: string;
  prompt: string | null;
  createdAt: string;
  /** Exactly which observations justified this, so a person can disagree. */
  because: Array<{
    kind: string;
    value: unknown;
    source: string;
    confidence: number;
    calibrated: boolean;
    ageMs: number;
  }>;
}

export interface RuleEvaluation {
  ruleId: string;
  fired: boolean;
  /** Why not, when not. Named so a rule that never fires can be debugged. */
  blockedBy?: 'unknown' | 'value' | 'confidence' | 'uncalibrated' | 'stale' | 'disagreement' | 'cooldown';
  blockedOn?: string;
}

export interface ProactiveOptions {
  now?: () => number;
  onEvent?: (event: { type: string; detail?: Record<string, any> }) => void;
  /** Bounds the queue; a user who never looks must not accumulate forever. */
  maxPending?: number;
}

const DEFAULT_MAX_PENDING = 20;

export class ProactiveService {
  private rules = new Map<string, ProactiveRule>();
  private lastFiredAt = new Map<string, number>();
  private pending: ProactiveSuggestion[] = [];
  private counter = 0;

  constructor(private context: ContextEngine, private options: ProactiveOptions = {}) {}

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  addRule(rule: ProactiveRule): ProactiveRule {
    if (rule.conditions.length === 0) {
      // A rule with no conditions fires on nothing in particular, which is
      // the definition of an interruption.
      throw new Error(`${rule.id}: conditions は最低1つ必要です。`);
    }
    this.rules.set(rule.id, rule);
    return rule;
  }

  listRules(): ProactiveRule[] {
    return [...this.rules.values()];
  }

  /**
   * Checks every rule against the present. Returns what fired and, for what
   * did not, the gate that stopped it.
   */
  evaluate(snapshot: ContextSnapshot = this.context.current()): RuleEvaluation[] {
    return [...this.rules.values()].map((rule) => this.evaluateRule(rule, snapshot));
  }

  private evaluateRule(rule: ProactiveRule, snapshot: ContextSnapshot): RuleEvaluation {
    const last = this.lastFiredAt.get(rule.id);
    if (last !== undefined && this.now() - last < rule.cooldownMs) {
      return { ruleId: rule.id, fired: false, blockedBy: 'cooldown' };
    }

    const because: ProactiveSuggestion['because'] = [];

    for (const condition of rule.conditions) {
      const field: ContextField | undefined = snapshot.fields[condition.kind];

      // Nothing has said anything about this. That is not a "no".
      if (!field) {
        return { ruleId: rule.id, fired: false, blockedBy: 'unknown', blockedOn: condition.kind };
      }
      if (condition.equals !== undefined && JSON.stringify(field.value) !== JSON.stringify(condition.equals)) {
        return { ruleId: rule.id, fired: false, blockedBy: 'value', blockedOn: condition.kind };
      }
      // The decayed, capped number — not what the source claimed for itself.
      if (field.confidence < condition.minConfidence) {
        return { ruleId: rule.id, fired: false, blockedBy: 'confidence', blockedOn: condition.kind };
      }
      if (condition.requireCalibrated && !field.calibrated) {
        return { ruleId: rule.id, fired: false, blockedBy: 'uncalibrated', blockedOn: condition.kind };
      }
      if (condition.maxAgeMs !== undefined && field.ageMs > condition.maxAgeMs) {
        return { ruleId: rule.id, fired: false, blockedBy: 'stale', blockedOn: condition.kind };
      }
      // Two sensors contradicting each other is not a situation to act on.
      if (field.disagreement && field.disagreement.length > 0) {
        return { ruleId: rule.id, fired: false, blockedBy: 'disagreement', blockedOn: condition.kind };
      }

      because.push({
        kind: field.kind,
        value: field.value,
        source: field.source,
        confidence: field.confidence,
        calibrated: field.calibrated,
        ageMs: field.ageMs,
      });
    }

    this.enqueue(rule, because);
    return { ruleId: rule.id, fired: true };
  }

  private enqueue(rule: ProactiveRule, because: ProactiveSuggestion['because']) {
    const now = this.now();
    this.lastFiredAt.set(rule.id, now);

    const suggestion: ProactiveSuggestion = {
      id: `${rule.id}:${++this.counter}`,
      ruleId: rule.id,
      suggestion: rule.suggestion,
      prompt: rule.prompt ?? null,
      createdAt: new Date(now).toISOString(),
      because,
    };

    this.pending.push(suggestion);
    const limit = this.options.maxPending ?? DEFAULT_MAX_PENDING;
    if (this.pending.length > limit) this.pending.splice(0, this.pending.length - limit);

    this.options.onEvent?.({
      type: 'proactive.suggested',
      detail: { ruleId: rule.id, suggestionId: suggestion.id },
    });
  }

  listPending(): ProactiveSuggestion[] {
    return [...this.pending];
  }

  /**
   * Takes a suggestion the user chose to act on.
   *
   * Returns the turn to run, and nothing runs it here. The caller must use
   * origin `inferred`, which is what forbids the resulting turn from reaching
   * an irreversible tool.
   */
  accept(id: string): { prompt: string | null; suggestion: ProactiveSuggestion } {
    const index = this.pending.findIndex((s) => s.id === id);
    if (index === -1) throw new Error(`提案が見つかりません: ${id}`);
    const [suggestion] = this.pending.splice(index, 1);
    this.options.onEvent?.({ type: 'proactive.accepted', detail: { suggestionId: id, ruleId: suggestion.ruleId } });
    return { prompt: suggestion.prompt, suggestion };
  }

  dismiss(id: string): boolean {
    const index = this.pending.findIndex((s) => s.id === id);
    if (index === -1) return false;
    const [suggestion] = this.pending.splice(index, 1);
    // Recorded, because a rule the user keeps dismissing is a rule that is
    // wrong, and that should be visible rather than inferred from silence.
    this.options.onEvent?.({ type: 'proactive.dismissed', detail: { suggestionId: id, ruleId: suggestion.ruleId } });
    return true;
  }
}

/**
 * Renders the present for a model prompt.
 *
 * Written to be read by something that will otherwise treat every sentence as
 * fact. Each line carries its source, its age and how sure the system is, and
 * what is *not* known is stated explicitly — a model told only what is known
 * will happily assume the rest.
 */
export function renderContextForPrompt(snapshot: ContextSnapshot): string {
  const lines: string[] = [];
  const fields = Object.values(snapshot.fields);

  if (fields.length === 0 && snapshot.unknown.length === 0) return '';

  lines.push('# 現在の状況（推定）');
  lines.push(
    'これはセンサーからの推定であり、事実ではありません。' +
      '各行の確度と観測からの経過時間を考慮し、確度が低いものを断定しないでください。'
  );

  for (const field of fields) {
    const age = formatAge(field.ageMs);
    const calibration = field.calibrated ? '' : '・未較正';
    let line =
      `- ${field.kind}: ${JSON.stringify(field.value)} ` +
      `（${field.sourceLabel}${calibration}・確度 ${field.band}(${field.confidence.toFixed(2)})・${age}前）`;
    if (field.disagreement?.length) {
      // Surfaced in the prompt too: the model should hesitate for the same
      // reason a person would.
      line += ` ※別の観測源は ${JSON.stringify(field.disagreement[0].value)} と報告しています`;
    }
    lines.push(line);
  }

  if (snapshot.unknown.length > 0) {
    lines.push(
      `- 未観測（不明であって、否定ではありません）: ${snapshot.unknown.join(', ')}`
    );
  }

  return lines.join('\n');
}

function formatAge(ms: number): string {
  if (ms < 1000) return `${ms}ミリ秒`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}秒`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}分`;
  return `${Math.round(ms / 3_600_000)}時間`;
}
