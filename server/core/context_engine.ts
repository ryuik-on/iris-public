/**
 * What IRIS believes about the present moment.
 *
 * The shape of this layer is the whole decision. A snapshot like
 *
 *     { occupied: true, location: "desk_area", confidence: 0.94 }
 *
 * is wrong in a way that is hard to see and expensive to unwind: one
 * confidence for the whole object hands the reader a 200ms-old presence
 * reading and a 40-minute-old location inference as if they were the same
 * claim. Freshness and confidence are properties of a *field*, because they
 * are properties of the observation that produced it.
 *
 * So nothing here stores "the current state". It stores observations — each
 * with its source, its confidence, and the moment it was made — and derives
 * the present from them on demand. That inversion buys three things that
 * matter later:
 *
 *   - "I don't know" stays distinct from "no". A sensor that has never
 *     reported presence must not make the house look empty. Absence of
 *     evidence is reported as absence of evidence, by name.
 *   - Confidence can only fall with age, never rise. An old reading is a
 *     weaker claim than a new one, and no arithmetic here can invent
 *     certainty that no sensor supplied.
 *   - A source that cannot say how often it is right is capped and labelled.
 *     An uncalibrated 0.94 is worse than no number at all, because the
 *     consumer will believe it. This is the same discipline the topic links
 *     already use: a guess and a fact are not stored as the same claim.
 */

export type Calibration = 'calibrated' | 'uncalibrated';

/** Coarse enough to be honest when the number underneath is not. */
export type ConfidenceBand = 'high' | 'medium' | 'low';

export interface SourceRegistration {
  id: string;
  label: string;
  /**
   * Whether this source's confidence means what a probability means: when it
   * says 0.9, it is right about nine times in ten. Almost nothing is
   * calibrated until someone has measured it.
   */
  calibration: Calibration;
  /**
   * Ceiling for an uncalibrated source. A string match or an untested
   * classifier does not get to claim near-certainty.
   */
  maxConfidence?: number;
}

export interface KindDescriptor {
  kind: string;
  description: string;
  /**
   * How long an observation of this kind still says anything. Past this it is
   * not low-confidence — it is gone, and the field goes back to unknown.
   */
  validForMs: number;
  /**
   * How fast belief decays inside that window. Omit for a claim that does not
   * weaken with age (a stated preference), set it short for one that does
   * (someone being in a room).
   */
  halfLifeMs?: number;
}

export interface ObservationInput {
  source: string;
  kind: string;
  value: unknown;
  /** As the source reported it, before capping or decay. */
  confidence: number;
  evidence?: string | null;
  /** Defaults to now; supplied when a source reports late. */
  observedAt?: string;
}

export interface Observation extends ObservationInput {
  observedAt: string;
  /** After the source's calibration ceiling, before any decay. */
  effectiveConfidence: number;
  evidence: string | null;
}

export interface ContextField {
  kind: string;
  value: unknown;
  source: string;
  sourceLabel: string;
  /** After the calibration ceiling and age decay. */
  confidence: number;
  /** What the source said, before either was applied. */
  reportedConfidence: number;
  band: ConfidenceBand;
  calibrated: boolean;
  observedAt: string;
  ageMs: number;
  /** True when age has reduced the confidence below what was reported. */
  decayed: boolean;
  evidence: string | null;
  /**
   * Other sources currently claiming something else. Present rather than
   * resolved: a fusion layer that hides disagreement is reporting more
   * certainty than it has.
   */
  disagreement?: Array<{ source: string; value: unknown; confidence: number }>;
}

export interface ContextSnapshot {
  at: string;
  fields: Record<string, ContextField>;
  /**
   * Registered kinds with nothing current to say. Named explicitly so a
   * reader cannot mistake silence for a negative answer.
   */
  unknown: string[];
  sources: Array<{ id: string; label: string; calibrated: boolean; observations: number }>;
}

export class UnknownSourceError extends Error {
  constructor(source: string) {
    super(`未登録の観測源です: ${source}`);
    this.name = 'UnknownSourceError';
  }
}

export class UnknownKindError extends Error {
  constructor(kind: string) {
    super(`未登録の観測種別です: ${kind}`);
    this.name = 'UnknownKindError';
  }
}

/** Uncalibrated sources cap here, matching the topic suggestion ceiling. */
const DEFAULT_UNCALIBRATED_CAP = 0.6;
/** Per kind. Enough for a short history without an unbounded sensor log. */
const DEFAULT_HISTORY_LIMIT = 200;

/**
 * The durable half, when the user has asked for one.
 *
 * Structural, not a concrete class, so the engine has no opinion about
 * storage and the tests need no database.
 */
export interface ContextStore {
  record(observation: Observation): boolean;
  /**
   * `now` is passed rather than read, so the store and the engine agree about
   * when "recent" is. A store reading the real clock while the engine writes
   * timestamps from an injected one disagree silently, and only once the wall
   * clock passes the injected value.
   */
  recent(kind: string, withinMs: number, limit?: number, now?: number): Array<{
    kind: string;
    source: string;
    value: unknown;
    confidence: number;
    effectiveConfidence: number;
    evidence: string | null;
    observedAt: string;
  }>;
  prune(now?: number): unknown;
}

export interface ContextEngineOptions {
  now?: () => number;
  historyLimit?: number;
  onEvent?: (event: { type: string; detail?: Record<string, any> }) => void;
  /**
   * Absent by default. Nothing about the present is written down unless the
   * user asked for it, per kind.
   */
  store?: ContextStore;
}

export class ContextEngine {
  private sources = new Map<string, SourceRegistration>();
  private kinds = new Map<string, KindDescriptor>();
  private observations = new Map<string, Observation[]>();
  private counts = new Map<string, number>();
  private readonly historyLimit: number;

  constructor(private options: ContextEngineOptions = {}) {
    this.historyLimit = options.historyLimit ?? DEFAULT_HISTORY_LIMIT;
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  registerSource(registration: SourceRegistration): SourceRegistration {
    const stored: SourceRegistration = {
      ...registration,
      maxConfidence: registration.maxConfidence ?? (
        registration.calibration === 'calibrated' ? 1 : DEFAULT_UNCALIBRATED_CAP
      ),
    };
    this.sources.set(stored.id, stored);
    return stored;
  }

  registerKind(descriptor: KindDescriptor): KindDescriptor {
    if (!(descriptor.validForMs > 0)) {
      throw new Error(`${descriptor.kind}: validForMs は正の値である必要があります。`);
    }
    this.kinds.set(descriptor.kind, descriptor);
    return descriptor;
  }

  /**
   * Records an observation. Never overwrites — an observation is a fact about
   * a moment, and a later one does not make an earlier one untrue.
   */
  observe(input: ObservationInput): Observation {
    const source = this.sources.get(input.source);
    if (!source) throw new UnknownSourceError(input.source);
    // Rejected rather than accepted with a default: a kind nobody described
    // has no validity window, so nothing could ever say when it expires.
    if (!this.kinds.has(input.kind)) throw new UnknownKindError(input.kind);

    const reported = clamp(input.confidence);
    const observation: Observation = {
      ...input,
      confidence: reported,
      effectiveConfidence: Math.min(reported, source.maxConfidence ?? 1),
      observedAt: input.observedAt ?? new Date(this.now()).toISOString(),
      evidence: input.evidence ?? null,
    };

    const list = this.observations.get(input.kind) ?? [];
    list.push(observation);
    // Kept in observation order, which is not arrival order: a source
    // reporting late must not appear to be the newest thing known.
    list.sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
    if (list.length > this.historyLimit) list.splice(0, list.length - this.historyLimit);
    this.observations.set(input.kind, list);
    this.counts.set(input.source, (this.counts.get(input.source) ?? 0) + 1);

    // The store decides whether this kind is one being kept. Handing it every
    // observation is the intended use — the policy is not the caller's to
    // know. A storage failure must not lose the live reading, which is the
    // one that matters right now.
    let persisted = false;
    try {
      persisted = this.options.store?.record(observation) ?? false;
    } catch (err: any) {
      this.options.onEvent?.({
        type: 'context.persist_failed',
        detail: { kind: input.kind, message: err?.message },
      });
    }

    this.options.onEvent?.({
      type: 'context.observed',
      detail: {
        kind: input.kind,
        source: input.source,
        confidence: observation.effectiveConfidence,
        capped: observation.effectiveConfidence < reported,
        persisted,
      },
    });

    return observation;
  }

  /**
   * The current belief about one attribute, or null when nothing current is
   * known. Null means unknown — never false, never a default.
   */
  field(kind: string): ContextField | null {
    const descriptor = this.kinds.get(kind);
    if (!descriptor) return null;

    const now = this.now();
    const live = (this.observations.get(kind) ?? [])
      .map((observation) => ({ observation, field: this.derive(observation, descriptor, now) }))
      .filter((entry): entry is { observation: Observation; field: ContextField } => entry.field !== null);

    if (live.length === 0) return null;

    /*
     * 一つの源につき、最新の観測だけを残す。
     *
     * 同じ源の古い観測と新しい観測が両方「生きている」と、確度が同点のとき
     * 並び替えが安定なので**古い方が勝ち**、新しい方が異論に回る。実測
     * 2026-09-11：08:30 の講義が始まって「次の予定」が naruto に変わったのに、
     * 画面は古い「病理学Ⅱ」を採用し、新しい値に「不一致」の札を付けていた。
     *
     * 源が言い直したなら、それがその源の言い分。**古い言い分は異論ではなく、
     * 取り下げられたもの。**異論は源と源のあいだにだけ立つ。
     */
    const latestBySource = new Map<string, { observation: Observation; field: ContextField }>();
    for (const entry of live) {
      const held = latestBySource.get(entry.field.source);
      if (!held || entry.observation.observedAt > held.observation.observedAt) {
        latestBySource.set(entry.field.source, entry);
      }
    }
    const current = [...latestBySource.values()];

    // Strongest current claim wins, and the losers are reported rather than
    // discarded.
    current.sort((a, b) => b.field.confidence - a.field.confidence);
    const winner = current[0].field;

    const others = current
      .slice(1)
      .filter((entry) => !sameValue(entry.field.value, winner.value))
      // One entry per dissenting source: a sensor repeating itself is not
      // extra evidence, and listing it twice would read as if it were.
      .filter((entry, index, all) => all.findIndex((e) => e.field.source === entry.field.source) === index)
      .map((entry) => ({
        source: entry.field.source,
        value: entry.field.value,
        confidence: entry.field.confidence,
      }));

    return others.length > 0 ? { ...winner, disagreement: others } : winner;
  }

  private derive(observation: Observation, descriptor: KindDescriptor, now: number): ContextField | null {
    const observedAtMs = Date.parse(observation.observedAt);
    if (!Number.isFinite(observedAtMs)) return null;

    const ageMs = now - observedAtMs;
    // A reading from the future is a clock problem, not a fresher truth.
    if (ageMs < 0) return null;
    if (ageMs >= descriptor.validForMs) return null;

    const source = this.sources.get(observation.source);
    const decayed = decay(observation.effectiveConfidence, ageMs, descriptor.halfLifeMs);

    return {
      kind: descriptor.kind,
      value: observation.value,
      source: observation.source,
      sourceLabel: source?.label ?? observation.source,
      confidence: decayed,
      reportedConfidence: observation.confidence,
      band: toBand(decayed),
      calibrated: source?.calibration === 'calibrated',
      observedAt: observation.observedAt,
      ageMs,
      decayed: decayed < observation.effectiveConfidence,
      evidence: observation.evidence,
    };
  }

  /** Everything currently believed, plus everything currently not known. */
  current(): ContextSnapshot {
    const fields: Record<string, ContextField> = {};
    const unknown: string[] = [];

    for (const kind of this.kinds.keys()) {
      const field = this.field(kind);
      if (field) fields[kind] = field;
      else unknown.push(kind);
    }

    return {
      at: new Date(this.now()).toISOString(),
      fields,
      unknown,
      sources: [...this.sources.values()].map((s) => ({
        id: s.id,
        label: s.label,
        calibrated: s.calibration === 'calibrated',
        observations: this.counts.get(s.id) ?? 0,
      })),
    };
  }

  /**
   * Raw observations, newest last. Includes expired ones: "when did this stop
   * being true" is a question the derived view cannot answer.
   */
  history(kind: string, limit = 50): Observation[] {
    const list = this.observations.get(kind) ?? [];
    return list.slice(-Math.max(1, limit));
  }

  describeKinds(): KindDescriptor[] {
    return [...this.kinds.values()];
  }

  /**
   * Reloads recent observations from the store into memory.
   *
   * Without this, every restart makes the house look empty until a sensor
   * speaks again — and "unknown" would be correct but useless when the answer
   * was on disk the whole time. Only observations still inside their validity
   * window are read; anything older could not affect the derived state anyway,
   * and loading it would just be reading a log into memory.
   *
   * Restored observations expire exactly as live ones do. A long shutdown
   * therefore restores nothing, which is the right answer.
   */
  restore(): { kind: string; restored: number }[] {
    if (!this.options.store) return [];
    const results: { kind: string; restored: number }[] = [];

    for (const descriptor of this.kinds.values()) {
      let rows: ReturnType<ContextStore['recent']> = [];
      try {
        rows = this.options.store.recent(
          descriptor.kind,
          descriptor.validForMs,
          this.historyLimit,
          this.now()
        );
      } catch (err: any) {
        this.options.onEvent?.({
          type: 'context.restore_failed',
          detail: { kind: descriptor.kind, message: err?.message },
        });
        continue;
      }
      if (rows.length === 0) continue;

      const restored: Observation[] = rows.map((row) => ({
        source: row.source,
        kind: row.kind,
        value: row.value,
        confidence: row.confidence,
        effectiveConfidence: row.effectiveConfidence,
        evidence: row.evidence,
        observedAt: row.observedAt,
      }));
      restored.sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
      this.observations.set(descriptor.kind, restored);
      results.push({ kind: descriptor.kind, restored: restored.length });
    }

    if (results.length > 0) {
      this.options.onEvent?.({ type: 'context.restored', detail: { kinds: results } });
    }
    return results;
  }

  /**
   * Drops observations, for a user who does not want a record of where they
   * were kept in memory any longer.
   */
  forget(kind?: string): number {
    if (kind) {
      const size = this.observations.get(kind)?.length ?? 0;
      this.observations.delete(kind);
      return size;
    }
    let total = 0;
    for (const list of this.observations.values()) total += list.length;
    this.observations.clear();
    return total;
  }
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Belief in a fact weakens with age.
 *
 * A heuristic, and only ever downward — no arithmetic here can invent
 * certainty that no sensor supplied. A source that knows its own decay should
 * report fresh observations instead of relying on this.
 */
function decay(confidence: number, ageMs: number, halfLifeMs?: number): number {
  if (!halfLifeMs || halfLifeMs <= 0) return confidence;
  return confidence * Math.pow(0.5, ageMs / halfLifeMs);
}

/**
 * The ordinal a consumer can use when the number should not be trusted as a
 * probability.
 */
function toBand(confidence: number): ConfidenceBand {
  if (confidence >= 0.75) return 'high';
  if (confidence >= 0.4) return 'medium';
  return 'low';
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
