/**
 * What is true right now, assembled rather than stored.
 *
 * The register described this as "IRIS が「今何が真か」を構造として保持する
 * ための中核" — a layer that *holds* the present. Building that would have
 * been a mistake, and the reason is visible in what already exists.
 *
 * The Context Engine is already the layer that composes a present out of
 * several sources: speech, IRIS's own state, and the calendar all register as
 * observation sources there, and a live snapshot on 2026-08-20 held
 * `calendar.next_event` alongside three kinds it correctly reported as
 * unknown. A second layer that also decided what is true now would need a
 * third to say which of the two to believe.
 *
 * The gap was somewhere else. `ContextEngine` had exactly one consumer —
 * `proactive_service` — so nothing IRIS believed about the present reached a
 * conversation. In a conversation the model had `get_current_time` and
 * `recall_memory`, and no way to see the schedule, the room, or its own
 * microphone. It was composing a present it could not look at.
 *
 * So this holds nothing. No table, no cache, no field of its own. It reads
 * three things that already exist and puts them in one shape:
 *
 *   the clock          — a model has none, which is why get_current_time was
 *                        the first primitive
 *   the Context Engine — the present, per field, with its own freshness
 *   `memories`         — the durable facts that qualify it
 *
 * Four things it deliberately does not do.
 *
 * It does not merge the fields into one confidence. A 200ms-old presence
 * reading and a 40-minute-old calendar entry are different claims, and the
 * Context Engine already refuses to average them. Averaging them one layer up
 * would undo that quietly.
 *
 * It does not drop `unknown`. A composition that returns only what is known
 * makes silence look like a negative answer, which is the specific failure
 * the Context Engine names in its own header.
 *
 * It does not write. Nothing observed here becomes a memory. A layer that
 * both reads the present and records it would make every read a small,
 * unreviewed decision about what is worth keeping.
 *
 * It re-asks the privacy question rather than inheriting an answer. This is a
 * new place where memories are assembled into something a model will read,
 * and `memory.ts` is explicit that the boundary is enforced at recall because
 * one that depends on every future call site is already crossed somewhere.
 * This is one of those future call sites.
 */

import { ContextEngine, ContextField, ContextSnapshot } from './context_engine.js';
import { Memory, shareable } from './memory.js';

/** Just enough of the memory store to read from it. Structural, so tests need no database. */
export interface MemoryReader {
  recall(options: { shareableOnly?: boolean; limit?: number }, now?: number): Memory[];
}

export interface LifeStateOptions {
  context: ContextEngine;
  memories: MemoryReader;
  now?: () => number;
  /** IANA zone. A wrong one is worse than none, so an unusable value falls back rather than throwing. */
  timeZone?: string;
  /** How many standing facts to carry. The present is a summary, not the archive. */
  memoryLimit?: number;
}

export interface LifeStateClock {
  iso: string;
  epochMs: number;
  timeZone: string;
  localized: string;
  weekday: string;
}

export interface LifeState {
  at: string;
  /**
   * The clock, spelled out.
   *
   * Carried rather than left to the caller because every consumer of this
   * needs it: "次の予定は19:30" says nothing without knowing what time it is
   * now, and the model cannot look.
   */
  clock: LifeStateClock;
  /** What is currently believed, one entry per field, each with its own age and confidence. */
  present: ContextField[];
  /**
   * Registered kinds with nothing current to say, by name.
   *
   * Kept as a first-class part of the answer. "誰もいない" and "在室を報告する
   * ものが何もない" are opposite situations that an omitted field renders
   * identically.
   */
  unknown: string[];
  /** Durable facts that qualify the present. Provenance and confidence intact. */
  standing: Memory[];
  /**
   * Memories excluded because they must not leave the machine.
   *
   * The count, never the content. Knowing something was withheld is what lets
   * anyone ask why; being handed a shorter list and told nothing does not.
   */
  withheld: number;
  sources: ContextSnapshot['sources'];
  /**
   * True when nothing at all is currently observed.
   *
   * Stated rather than inferred from an empty array, because the useful
   * reading of an empty `present` is "no source has reported", and a consumer
   * that has to work that out will eventually work it out wrong.
   */
  quiet: boolean;
}

const DEFAULT_MEMORY_LIMIT = 20;

/**
 * Assembles the present from what already exists.
 *
 * Read-only in both directions: it neither writes nor asks its inputs to
 * change. Constructing one is free and it caches nothing, so a stale answer
 * is not a state this can be in.
 */
export class LifeStateService {
  constructor(private options: LifeStateOptions) {}

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  current(): LifeState {
    const nowMs = this.now();
    const snapshot = this.options.context.current();

    const recalled = this.options.memories.recall(
      {
        // Asked for, not filtered afterwards. The store applies retention and
        // supersession at the same time, so nothing expired arrives here to be
        // forgotten about.
        shareableOnly: true,
        limit: this.options.memoryLimit ?? DEFAULT_MEMORY_LIMIT,
      },
      nowMs
    );

    // Defence in depth, and cheap. The store is asked for shareable entries
    // only; this refuses anything else that arrives regardless, because the
    // cost of the check is nothing and the cost of being wrong once is a
    // local_only memory in a prompt that left the machine.
    const standing = recalled.filter(shareable);
    const dropped = recalled.length - standing.length;

    // Strongest first. Ordering by confidence rather than by kind means a
    // reader who stops early stops on the best-supported claims, and the
    // Context Engine has already made each number comparable by capping
    // uncalibrated sources.
    const present = Object.values(snapshot.fields).sort((a, b) => b.confidence - a.confidence);

    return {
      at: snapshot.at,
      clock: describeClock(nowMs, this.options.timeZone),
      present,
      unknown: snapshot.unknown,
      standing,
      withheld: this.withheldCount(nowMs) + dropped,
      sources: snapshot.sources,
      quiet: present.length === 0,
    };
  }

  /**
   * How many current memories were held back for privacy.
   *
   * Counted by asking twice rather than by reading the excluded entries, so
   * the local_only content is never loaded into the same object as the text
   * bound for a prompt.
   */
  private withheldCount(nowMs: number): number {
    const limit = this.options.memoryLimit ?? DEFAULT_MEMORY_LIMIT;
    const all = this.options.memories.recall({ shareableOnly: false, limit }, nowMs);
    return all.filter((m) => !shareable(m)).length;
  }
}

function describeClock(nowMs: number, requested?: string): LifeStateClock {
  const now = new Date(nowMs);
  const systemZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  let timeZone = requested?.trim() || systemZone;
  let localized: string;
  let weekday: string;

  try {
    localized = new Intl.DateTimeFormat('ja-JP', { timeZone, dateStyle: 'full', timeStyle: 'medium' }).format(now);
    weekday = new Intl.DateTimeFormat('ja-JP', { timeZone, weekday: 'long' }).format(now);
  } catch {
    // A bad zone must not take the whole present with it. The time is still
    // knowable; only the formatting was wrong, and the fallback says which
    // zone actually produced these strings.
    timeZone = systemZone;
    localized = new Intl.DateTimeFormat('ja-JP', { timeZone, dateStyle: 'full', timeStyle: 'medium' }).format(now);
    weekday = new Intl.DateTimeFormat('ja-JP', { timeZone, weekday: 'long' }).format(now);
  }

  return { iso: now.toISOString(), epochMs: nowMs, timeZone, localized, weekday };
}

/**
 * The present, rendered for a reader that cannot inspect the object.
 *
 * Freshness is spelled out per line rather than left as a millisecond count,
 * because "42分前" is a thing a reader weighs and `ageMs: 2520000` is not.
 * Uncalibrated sources are labelled in the line itself for the same reason the
 * memory renderer labels provenance: a number the reader cannot place is worse
 * than no number, because it will be believed.
 */
export function renderLifeState(state: LifeState): string {
  const lines = [`【現在】${state.clock.localized}（${state.clock.timeZone}）`];

  if (state.present.length === 0) {
    lines.push('- 現在観測されているものはありません。');
  } else {
    for (const field of state.present) {
      const parts = [
        `- ${field.kind}: ${formatValue(field.value)}`,
        `〔${field.sourceLabel} / ${describeAge(field.ageMs)}`,
        field.calibrated ? `確度 ${field.confidence.toFixed(2)}` : `確度 ${field.confidence.toFixed(2)}（未校正）`,
      ];
      // Disagreement is surfaced, not resolved. A fused view that hides a
      // dissenting source reports more certainty than it has.
      if (field.disagreement?.length) {
        parts.push(`/ 異なる報告 ${field.disagreement.length}件`);
      }
      lines.push(`${parts.join(' ')}〕`);
    }
  }

  if (state.unknown.length > 0) {
    lines.push(`- 不明（報告がない、または古すぎる）: ${state.unknown.join('、')}`);
    lines.push('  「不明」は「いいえ」ではありません。答えが無いのではなく、答えを持つ観測がありません。');
  }

  if (state.standing.length > 0) {
    lines.push('【現在を補う恒久的な事実】');
    const label: Record<Memory['provenance'], string> = {
      user: '本人の発言',
      measured: '実測',
      inferred: '推論',
      external: '外部由来',
    };
    for (const m of state.standing) {
      lines.push(`- ${m.content}  〔${label[m.provenance]} / 確度 ${m.confidence.toFixed(2)}〕`);
    }
  }

  if (state.withheld > 0) {
    lines.push(`- （端末外へ出せない記憶が ${state.withheld} 件あります。内容は渡していません。）`);
  }

  return lines.join('\n');
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '不明';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object') {
    const o = value as Record<string, unknown>;
    // A next-event object read as raw JSON is the thing a person actually
    // wants to read, so it gets a shape rather than a stringify.
    if (typeof o.title === 'string') {
      return [o.title, o.start ? `開始 ${o.start}` : null, o.calendar ? `(${o.calendar})` : null]
        .filter(Boolean)
        .join(' ');
    }
  }
  return JSON.stringify(value);
}

/** Age as something a reader weighs, rather than a millisecond count. */
export function describeAge(ageMs: number): string {
  if (ageMs < 0) return '未来の時刻';
  const seconds = Math.floor(ageMs / 1000);
  if (seconds < 60) return `${seconds}秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}時間前`;
  return `${Math.floor(hours / 24)}日前`;
}
