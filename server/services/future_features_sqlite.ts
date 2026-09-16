import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

/** What IRIS intends to do about this feature. */
export type FeatureStatus =
  | 'CURRENT'
  | 'NEXT'
  | 'PLANNED'
  | 'DEFERRED'
  | 'EXPERIMENTAL'
  | 'REAL_WORLD_VERIFICATION_REQUIRED'
  | 'BLOCKED'
  | 'PROHIBITED'
  | 'OUT_OF_SCOPE'
  | 'EXPLICIT_DECISION_REQUIRED'
  | 'REJECTED'
  | 'COMPLETED';

/** How far it has actually been verified (§29). */
export type VerificationLevel =
  | 'NONE'
  | 'DESIGNED'
  | 'IMPLEMENTED'
  | 'UNIT_VERIFIED'
  | 'FIXTURE_VERIFIED'
  | 'RUNTIME_VERIFIED'
  | 'REAL_WORLD_VERIFIED'
  | 'PILOT_VALIDATED';

/** Whether it exists in the repository right now (§28). */
export type RepositoryReality =
  | 'VERIFIED_PRESENT'
  | 'PARTIAL'
  | 'REPORTED_BUT_NOT_FOUND'
  | 'NOT_IMPLEMENTED';

export type FeaturePriority = 'P0' | 'P1' | 'P2' | 'P3' | 'P4' | 'NONE';

export interface FutureFeature {
  id: string;
  /** Stable identity, so seeding is idempotent across runs. */
  key: string;
  title: string;
  domain: string;
  status: FeatureStatus;
  verification: VerificationLevel;
  reality: RepositoryReality;
  priority: FeaturePriority;
  /** Why it holds this status. Required — a status without a reason rots. */
  reason: string;
  resumeCondition: string | null;
  dependencies: string[];
  evidence: string[];
  source: string;
  risk: string | null;
  notes: string | null;
  lastReviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FutureFeatureInput {
  key: string;
  title: string;
  domain: string;
  status: FeatureStatus;
  verification?: VerificationLevel;
  reality?: RepositoryReality;
  priority?: FeaturePriority;
  reason: string;
  resumeCondition?: string | null;
  dependencies?: string[];
  evidence?: string[];
  source: string;
  risk?: string | null;
  notes?: string | null;
}

/**
 * Statuses that record a boundary rather than a plan.
 *
 * An entry in one of these states may not be moved out of it, and may not be
 * turned into a development task, through the API or through chat. IRIS must
 * not be able to quietly dissolve its own constraints by implementing ordinary
 * autonomy features (§27, §16). Changing one is a deliberate human act against
 * the database, not something the system offers.
 */
export const IMMUTABLE_STATUSES: FeatureStatus[] = ['PROHIBITED', 'OUT_OF_SCOPE'];

/** Statuses that must never become active work without a human decision first. */
export const NON_ACTIONABLE_STATUSES: FeatureStatus[] = [
  'PROHIBITED',
  'OUT_OF_SCOPE',
  'REJECTED',
  'EXPLICIT_DECISION_REQUIRED',
];

export class ImmutableFeatureError extends Error {
  constructor(public readonly key: string, public readonly status: FeatureStatus) {
    super(
      `"${key}" は ${status} です。この状態は安全境界の記録であり、IRIS 側からは変更できません。` +
        `変更が必要な場合はユーザーが明示的に判断してください。`
    );
    this.name = 'ImmutableFeatureError';
  }
}

export class FeatureNotFoundError extends Error {
  constructor(public readonly key: string) {
    super(`Future feature not found: ${key}`);
    this.name = 'FeatureNotFoundError';
  }
}

export class SqliteFutureFeatureStore {
  constructor(private db: Database.Database) {}

  /**
   * Idempotent seeding by `key`.
   *
   * Re-seeding refreshes the descriptive fields of an entry but never its
   * status: once something has been reviewed and moved, a later seed run must
   * not silently drag it back to its documented default.
   */
  seed(entries: FutureFeatureInput[]): { inserted: number; updated: number; skipped: number } {
    let inserted = 0;
    let updated = 0;
    let skipped = 0;

    const tx = this.db.transaction(() => {
      for (const entry of entries) {
        const existing = this.getByKey(entry.key);
        if (!existing) {
          this.create(entry);
          inserted++;
        } else if (existing.status === entry.status) {
          this.db
            .prepare(
              `UPDATE future_features
                  SET title = ?, domain = ?, verification = ?, reality = ?, priority = ?,
                      reason = ?, resume_condition = ?, dependencies_json = ?,
                      evidence_json = ?, source = ?, risk = ?, notes = ?, updated_at = ?
                WHERE key = ?`
            )
            .run(
              entry.title,
              entry.domain,
              entry.verification ?? 'NONE',
              entry.reality ?? 'NOT_IMPLEMENTED',
              entry.priority ?? 'NONE',
              entry.reason,
              entry.resumeCondition ?? null,
              JSON.stringify(entry.dependencies ?? []),
              JSON.stringify(entry.evidence ?? []),
              entry.source,
              entry.risk ?? null,
              entry.notes ?? null,
              new Date().toISOString(),
              entry.key
            );
          updated++;
        } else {
          skipped++;
        }
      }
    });
    tx();

    return { inserted, updated, skipped };
  }

  create(entry: FutureFeatureInput): FutureFeature {
    const now = new Date().toISOString();
    const id = randomUUID();

    if (!entry.reason?.trim()) {
      throw new Error('reason は必須です。理由のない status は後で意味を失います。');
    }

    this.db
      .prepare(
        `INSERT INTO future_features
           (id, key, title, domain, status, verification, reality, priority, reason,
            resume_condition, dependencies_json, evidence_json, source, risk, notes,
            last_reviewed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`
      )
      .run(
        id,
        entry.key,
        entry.title,
        entry.domain,
        entry.status,
        entry.verification ?? 'NONE',
        entry.reality ?? 'NOT_IMPLEMENTED',
        entry.priority ?? 'NONE',
        entry.reason.trim(),
        entry.resumeCondition ?? null,
        JSON.stringify(entry.dependencies ?? []),
        JSON.stringify(entry.evidence ?? []),
        entry.source,
        entry.risk ?? null,
        entry.notes ?? null,
        now,
        now
      );

    return this.getByKey(entry.key)!;
  }

  getByKey(key: string): FutureFeature | null {
    const row = this.db.prepare(`SELECT * FROM future_features WHERE key = ?`).get(key) as any;
    return row ? mapFeature(row) : null;
  }

  list(options: { status?: FeatureStatus; domain?: string; priority?: FeaturePriority } = {}): FutureFeature[] {
    const clauses: string[] = [];
    const params: any[] = [];
    if (options.status) {
      clauses.push('status = ?');
      params.push(options.status);
    }
    if (options.domain) {
      clauses.push('domain = ?');
      params.push(options.domain);
    }
    if (options.priority) {
      clauses.push('priority = ?');
      params.push(options.priority);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    const rows = this.db
      .prepare(
        `SELECT * FROM future_features ${where}
          ORDER BY CASE priority
                     WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2
                     WHEN 'P3' THEN 3 WHEN 'P4' THEN 4 ELSE 5 END,
                   domain, title`
      )
      .all(...params) as any[];

    return rows.map(mapFeature);
  }

  search(query: string): FutureFeature[] {
    const like = `%${query}%`;
    const rows = this.db
      .prepare(
        `SELECT * FROM future_features
          WHERE title LIKE ? OR reason LIKE ? OR domain LIKE ? OR key LIKE ? OR notes LIKE ?
          ORDER BY domain, title`
      )
      .all(like, like, like, like, like) as any[];
    return rows.map(mapFeature);
  }

  /**
   * Updates an entry, refusing to move it out of a boundary status.
   * Descriptive fields of a boundary entry stay editable — sharpening the
   * reason for a prohibition is fine; lifting it is not.
   */
  update(key: string, patch: Partial<FutureFeatureInput>): FutureFeature {
    const existing = this.getByKey(key);
    if (!existing) throw new FeatureNotFoundError(key);

    if (patch.status && patch.status !== existing.status && IMMUTABLE_STATUSES.includes(existing.status)) {
      throw new ImmutableFeatureError(key, existing.status);
    }
    if (patch.status && IMMUTABLE_STATUSES.includes(patch.status) && !IMMUTABLE_STATUSES.includes(existing.status)) {
      // Adding a constraint is always allowed; only removing one is refused.
    }

    const merged = { ...existing, ...patch };
    this.db
      .prepare(
        `UPDATE future_features
            SET title = ?, domain = ?, status = ?, verification = ?, reality = ?,
                priority = ?, reason = ?, resume_condition = ?, dependencies_json = ?,
                evidence_json = ?, risk = ?, notes = ?, updated_at = ?
          WHERE key = ?`
      )
      .run(
        merged.title,
        merged.domain,
        merged.status,
        merged.verification,
        merged.reality,
        merged.priority,
        merged.reason,
        merged.resumeCondition ?? null,
        JSON.stringify(merged.dependencies ?? []),
        JSON.stringify(merged.evidence ?? []),
        merged.risk ?? null,
        merged.notes ?? null,
        new Date().toISOString(),
        key
      );

    return this.getByKey(key)!;
  }

  markReviewed(key: string, note?: string): FutureFeature {
    const existing = this.getByKey(key);
    if (!existing) throw new FeatureNotFoundError(key);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE future_features SET last_reviewed_at = ?, notes = COALESCE(?, notes), updated_at = ?
          WHERE key = ?`
      )
      .run(now, note ?? null, now, key);
    return this.getByKey(key)!;
  }

  /**
   * Entries due for review (§31): never reviewed, or not reviewed inside the
   * window. Boundary statuses are excluded — a prohibition does not expire and
   * surfacing it for periodic reconsideration would be the wrong nudge.
   */
  dueForReview(maxAgeDays = 90, now = Date.now()): FutureFeature[] {
    const cutoff = now - maxAgeDays * 24 * 60 * 60 * 1000;
    return this.list().filter((feature) => {
      if (IMMUTABLE_STATUSES.includes(feature.status)) return false;
      if (feature.status === 'COMPLETED' || feature.status === 'REJECTED') return false;
      // Never reviewed is not the same as stale. An entry written yesterday
      // has not been neglected; one written a year ago and never looked at
      // since has. Falling back to the creation date is what makes this list
      // short enough to be read — a report that names everything, forever,
      // is a report nobody opens twice.
      const last = feature.lastReviewedAt ?? feature.createdAt;
      if (!last) return true;
      // Inclusive: a window of 0 days means "everything is due", and an entry
      // reviewed exactly at the cutoff counts as due rather than depending on
      // whether the clock happened to tick between the two calls.
      return Date.parse(last) <= cutoff;
    });
  }

  counts(): Record<string, number> {
    const rows = this.db
      .prepare(`SELECT status, COUNT(*) AS n FROM future_features GROUP BY status`)
      .all() as any[];
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
  }

  delete(key: string): boolean {
    const existing = this.getByKey(key);
    if (!existing) return false;
    if (IMMUTABLE_STATUSES.includes(existing.status)) {
      throw new ImmutableFeatureError(key, existing.status);
    }
    return this.db.prepare(`DELETE FROM future_features WHERE key = ?`).run(key).changes > 0;
  }
}

function parseArray(value: any): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function mapFeature(row: any): FutureFeature {
  return {
    id: row.id,
    key: row.key,
    title: row.title,
    domain: row.domain,
    status: row.status,
    verification: row.verification,
    reality: row.reality,
    priority: row.priority,
    reason: row.reason,
    resumeCondition: row.resume_condition,
    dependencies: parseArray(row.dependencies_json),
    evidence: parseArray(row.evidence_json),
    source: row.source,
    risk: row.risk,
    notes: row.notes,
    lastReviewedAt: row.last_reviewed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
