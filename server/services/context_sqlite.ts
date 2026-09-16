import Database from 'better-sqlite3';
import { Observation } from '../core/context_engine.js';

/**
 * Durable situational observations — for the kinds a person has said to keep.
 *
 * This class is arranged around one rule: absence means off. An observation
 * kind with no retention policy is never written, so the initial state of
 * every sensor is "not recorded", and turning one on is something that has to
 * be done deliberately, per kind, with a retention period supplied at the same
 * moment.
 *
 * That is stricter than the surrounding system, on purpose. Conversations are
 * kept because a conversation is something the user chose to have. A record of
 * when someone was at their desk is produced whether or not they were thinking
 * about it, it accumulates into a picture of a person's days, and it describes
 * housemates and visitors who were never asked. Retention 8.5 says nothing is
 * deleted automatically; it does not say everything must be written down.
 */

export interface RetentionPolicy {
  kind: string;
  retainMs: number;
  maxRows: number;
  enabledAt: string;
  decidedBy: string;
  note: string | null;
}

export interface StoredObservation {
  id: number;
  kind: string;
  source: string;
  value: unknown;
  confidence: number;
  effectiveConfidence: number;
  evidence: string | null;
  observedAt: string;
  recordedAt: string;
}

export interface EnableInput {
  kind: string;
  retainMs: number;
  maxRows?: number;
  decidedBy?: string;
  note?: string | null;
}

/** A cap on rows as well as age: a fast sensor must not fill the disk. */
const DEFAULT_MAX_ROWS = 50_000;

export class SqliteContextStore {
  constructor(private db: Database.Database) {}

  /**
   * Starts keeping a kind. Both bounds are required — there is no call here
   * that results in an unbounded record.
   */
  enable(input: EnableInput): RetentionPolicy {
    if (!input.kind?.trim()) throw new Error('kind は必須です。');
    if (!(input.retainMs > 0)) {
      throw new Error('retainMs は正の値である必要があります（無期限保存は選択肢にありません）。');
    }
    const maxRows = input.maxRows ?? DEFAULT_MAX_ROWS;
    if (!(maxRows > 0)) throw new Error('maxRows は正の値である必要があります。');

    this.db
      .prepare(
        `INSERT INTO context_retention (kind, retain_ms, max_rows, enabled_at, decided_by, note)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(kind) DO UPDATE SET
           retain_ms = excluded.retain_ms,
           max_rows = excluded.max_rows,
           decided_by = excluded.decided_by,
           note = excluded.note`
      )
      .run(
        input.kind.trim(),
        Math.floor(input.retainMs),
        Math.floor(maxRows),
        new Date().toISOString(),
        input.decidedBy ?? 'user',
        input.note ?? null
      );

    return this.policy(input.kind.trim())!;
  }

  /**
   * Stops keeping a kind.
   *
   * What was already written stays unless deletion is asked for: removing
   * data the user did not ask to remove is its own kind of surprise (8.5).
   * The count of what remains is returned so it cannot be quietly forgotten
   * about.
   */
  disable(kind: string, options: { deleteExisting?: boolean } = {}): { removedPolicy: boolean; rowsRemaining: number; rowsDeleted: number } {
    const removedPolicy = this.db.prepare(`DELETE FROM context_retention WHERE kind = ?`).run(kind).changes > 0;
    let rowsDeleted = 0;
    if (options.deleteExisting) {
      rowsDeleted = this.db.prepare(`DELETE FROM context_observations WHERE kind = ?`).run(kind).changes;
    }
    const rowsRemaining = this.count(kind);
    return { removedPolicy, rowsRemaining, rowsDeleted };
  }

  policy(kind: string): RetentionPolicy | null {
    const row = this.db.prepare(`SELECT * FROM context_retention WHERE kind = ?`).get(kind) as any;
    return row ? mapPolicy(row) : null;
  }

  policies(): RetentionPolicy[] {
    return (this.db.prepare(`SELECT * FROM context_retention ORDER BY kind`).all() as any[]).map(mapPolicy);
  }

  /**
   * Writes an observation, if its kind is one being kept.
   *
   * Returns false when it is not — the common case, and not an error. A
   * caller handing every observation to this store is exactly the intended
   * use; the policy decides, not the caller.
   */
  record(observation: Observation): boolean {
    const policy = this.policy(observation.kind);
    if (!policy) return false;

    this.db
      .prepare(
        `INSERT INTO context_observations
           (kind, source, value_json, confidence, effective_confidence, evidence, observed_at, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        observation.kind,
        observation.source,
        JSON.stringify(observation.value ?? null),
        observation.confidence,
        observation.effectiveConfidence,
        observation.evidence ?? null,
        observation.observedAt,
        new Date().toISOString()
      );
    return true;
  }

  /**
   * Observations recent enough to still mean something, newest last.
   *
   * Used to warm the engine after a restart: without it, every restart makes
   * the house look empty until a sensor speaks again.
   */
  recent(kind: string, withinMs: number, limit = 500, now = Date.now()): StoredObservation[] {
    // The clock is a parameter, as it already is for `prune`. Reading the
    // real one here while the engine writes `observed_at` from an injected
    // one makes the two disagree about when "recent" is — and the disagreement
    // is invisible, because it only shows up once the wall clock passes
    // whatever timestamp the caller was using. A test of this passed all
    // morning and began failing in the afternoon for that reason alone.
    const cutoff = new Date(now - withinMs).toISOString();
    const rows = this.db
      .prepare(
        `SELECT * FROM context_observations
          WHERE kind = ? AND observed_at >= ?
          ORDER BY observed_at DESC
          LIMIT ?`
      )
      .all(kind, cutoff, Math.min(Math.max(limit, 1), 5_000)) as any[];
    return rows.map(mapObservation).reverse();
  }

  history(kind: string, limit = 200): StoredObservation[] {
    const rows = this.db
      .prepare(`SELECT * FROM context_observations WHERE kind = ? ORDER BY observed_at DESC LIMIT ?`)
      .all(kind, Math.min(Math.max(limit, 1), 5_000)) as any[];
    return rows.map(mapObservation).reverse();
  }

  count(kind?: string): number {
    const row = kind
      ? this.db.prepare(`SELECT COUNT(*) AS n FROM context_observations WHERE kind = ?`).get(kind)
      : this.db.prepare(`SELECT COUNT(*) AS n FROM context_observations`).get();
    return (row as any).n as number;
  }

  /**
   * Enforces the retention the user chose: by age, by row count, and by
   * whether the kind is still being kept at all.
   *
   * Rows whose policy was removed are deliberately left alone — disabling is
   * not a delete, and turning something off should not destroy what it
   * already gathered.
   */
  prune(now = Date.now()): { kind: string; byAge: number; byCount: number }[] {
    const results: { kind: string; byAge: number; byCount: number }[] = [];

    for (const policy of this.policies()) {
      const cutoff = new Date(now - policy.retainMs).toISOString();
      const byAge = this.db
        .prepare(`DELETE FROM context_observations WHERE kind = ? AND observed_at < ?`)
        .run(policy.kind, cutoff).changes;

      // Oldest first, so what survives a cap is the recent past.
      const byCount = this.db
        .prepare(
          `DELETE FROM context_observations
            WHERE id IN (
              SELECT id FROM context_observations
               WHERE kind = ?
               ORDER BY observed_at DESC, id DESC
               LIMIT -1 OFFSET ?
            )`
        )
        .run(policy.kind, policy.maxRows).changes;

      if (byAge > 0 || byCount > 0) results.push({ kind: policy.kind, byAge, byCount });
    }

    return results;
  }

  /** Deletes stored observations. Explicit, and reports what it removed. */
  forget(kind?: string): number {
    return kind
      ? this.db.prepare(`DELETE FROM context_observations WHERE kind = ?`).run(kind).changes
      : this.db.prepare(`DELETE FROM context_observations`).run().changes;
  }

  /**
   * Everything held for a kind, so the record can be taken out and read.
   * Data the user cannot get back out is data held on worse terms than they
   * agreed to.
   */
  exportAll(kind?: string): StoredObservation[] {
    const rows = kind
      ? (this.db.prepare(`SELECT * FROM context_observations WHERE kind = ? ORDER BY observed_at`).all(kind) as any[])
      : (this.db.prepare(`SELECT * FROM context_observations ORDER BY kind, observed_at`).all() as any[]);
    return rows.map(mapObservation);
  }

  /** What is being kept, how much of it, and since when. */
  summary(): Array<RetentionPolicy & { rows: number; oldest: string | null; newest: string | null }> {
    return this.policies().map((policy) => {
      const row = this.db
        .prepare(
          `SELECT COUNT(*) AS n, MIN(observed_at) AS oldest, MAX(observed_at) AS newest
             FROM context_observations WHERE kind = ?`
        )
        .get(policy.kind) as any;
      return { ...policy, rows: row.n, oldest: row.oldest ?? null, newest: row.newest ?? null };
    });
  }

  /**
   * Kinds holding data that nothing is keeping any more, so a disabled sensor
   * whose history is still on disk stays visible rather than becoming a
   * forgotten file.
   */
  orphaned(): Array<{ kind: string; rows: number }> {
    const rows = this.db
      .prepare(
        `SELECT o.kind AS kind, COUNT(*) AS n
           FROM context_observations o
           LEFT JOIN context_retention r ON r.kind = o.kind
          WHERE r.kind IS NULL
          GROUP BY o.kind`
      )
      .all() as any[];
    return rows.map((r) => ({ kind: r.kind, rows: r.n }));
  }
}

function mapPolicy(row: any): RetentionPolicy {
  return {
    kind: row.kind,
    retainMs: row.retain_ms,
    maxRows: row.max_rows,
    enabledAt: row.enabled_at,
    decidedBy: row.decided_by,
    note: row.note ?? null,
  };
}

function mapObservation(row: any): StoredObservation {
  let value: unknown = null;
  try {
    value = JSON.parse(row.value_json);
  } catch {
    /* a corrupt value must not make the rest of the record unreadable */
  }
  return {
    id: row.id,
    kind: row.kind,
    source: row.source,
    value,
    confidence: row.confidence,
    effectiveConfidence: row.effective_confidence,
    evidence: row.evidence ?? null,
    observedAt: row.observed_at,
    recordedAt: row.recorded_at,
  };
}
