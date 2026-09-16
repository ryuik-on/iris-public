import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

import {
  Memory, MemoryInput, MemoryPrivacy, MemoryProvenance, MemoryRetention,
  admit, current,
} from '../core/memory.js';

/**
 * Where memories live, and what may come back out.
 *
 * Two rules shape every query here.
 *
 * Nothing is deleted when it stops being true. A memory that was superseded is
 * still a record of what was believed and when that ended, and the register's
 * own history is full of cases where the second question mattered more than
 * the first — the microphone grant that had been given and silently
 * invalidated read exactly like one that was never given.
 *
 * Recall filters by privacy rather than trusting callers. A `local_only`
 * memory reaching a prompt bound for a provider is not a mistake anyone would
 * notice: the reply comes back normal. So the filter lives at the one place
 * every caller has to pass through.
 */

export interface RecallOptions {
  kind?: string;
  /** Only what may leave the machine. Required for anything building a prompt. */
  shareableOnly?: boolean;
  /** Include entries that have expired or been contradicted. */
  includeStale?: boolean;
  minConfidence?: number;
  limit?: number;
}

interface Row {
  id: string;
  kind: string;
  content: string;
  provenance: MemoryProvenance;
  source: string;
  confidence: number;
  retention: MemoryRetention;
  expires_at: string | null;
  privacy: MemoryPrivacy;
  evidence_json: string;
  topic_ref: string | null;
  created_at: string;
  superseded_by: string | null;
}

function toMemory(row: Row): Memory {
  let evidence: string[] = [];
  try {
    const parsed = JSON.parse(row.evidence_json);
    if (Array.isArray(parsed)) evidence = parsed.map(String);
  } catch {
    /* unreadable evidence is no evidence, which is not a reason to lose the memory */
  }
  return {
    id: row.id,
    kind: row.kind,
    content: row.content,
    provenance: row.provenance,
    source: row.source,
    confidence: row.confidence,
    retention: row.retention,
    expiresAt: row.expires_at,
    privacy: row.privacy,
    evidence,
    topicRef: row.topic_ref,
    createdAt: row.created_at,
    supersededBy: row.superseded_by,
  };
}

export class MemoryStore {
  constructor(private db: Database.Database) {}

  /**
   * Offers something for remembering.
   *
   * Everything passes the admission gate, including calls from inside IRIS.
   * A gate that trusted internal callers would be bypassed by exactly the path
   * that carries external text inward — a tool result is internal code holding
   * somebody else's prose.
   */
  remember(input: MemoryInput, now = new Date()): { stored: Memory | null; reason: string } {
    const verdict = admit(input);
    if (!verdict.admit || !verdict.adjusted) {
      return { stored: null, reason: verdict.reason };
    }
    const a = verdict.adjusted;
    const memory: Memory = {
      id: randomUUID(),
      kind: a.kind,
      content: a.content,
      provenance: a.provenance,
      source: a.source,
      confidence: a.confidence ?? 0,
      retention: a.retention ?? 'durable',
      expiresAt: a.expiresAt ?? null,
      privacy: a.privacy ?? 'shareable',
      evidence: a.evidence ?? [],
      topicRef: a.topicRef ?? null,
      createdAt: now.toISOString(),
      supersededBy: null,
    };

    this.db
      .prepare(
        `INSERT INTO memories
           (id, kind, content, provenance, source, confidence, retention,
            expires_at, privacy, evidence_json, topic_ref, created_at, superseded_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
      )
      .run(
        memory.id, memory.kind, memory.content, memory.provenance, memory.source,
        memory.confidence, memory.retention, memory.expiresAt, memory.privacy,
        JSON.stringify(memory.evidence), memory.topicRef, memory.createdAt
      );

    return { stored: memory, reason: verdict.reason };
  }

  /**
   * Records that one memory replaced another.
   *
   * The old row stays. What was believed, and when it stopped being believed,
   * are separate facts and the second is often the useful one.
   */
  supersede(oldId: string, newId: string): boolean {
    return (
      this.db.prepare(`UPDATE memories SET superseded_by = ? WHERE id = ? AND superseded_by IS NULL`)
        .run(newId, oldId).changes > 0
    );
  }

  get(id: string): Memory | null {
    const row = this.db.prepare(`SELECT * FROM memories WHERE id = ?`).get(id) as Row | undefined;
    return row ? toMemory(row) : null;
  }

  /**
   * What IRIS may bring to mind.
   *
   * `shareableOnly` is not defaulted on, because a caller that has not thought
   * about where the text is going should be made to say so rather than be
   * quietly given the safe answer and never learn the question exists.
   */
  recall(options: RecallOptions = {}, now = Date.now()): Memory[] {
    const clauses: string[] = [];
    const params: any[] = [];

    if (options.kind) { clauses.push('kind = ?'); params.push(options.kind); }
    if (options.shareableOnly) { clauses.push("privacy != 'local_only'"); }
    if (options.minConfidence !== undefined) {
      clauses.push('confidence >= ?');
      params.push(options.minConfidence);
    }
    if (!options.includeStale) clauses.push('superseded_by IS NULL');

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(
        `SELECT * FROM memories ${where}
         ORDER BY confidence DESC, created_at DESC
         LIMIT ?`
      )
      .all(...params, Math.min(options.limit ?? 50, 500)) as Row[];

    const memories = rows.map(toMemory);
    // Expiry is decided in code rather than SQL: `session` depends on age and
    // `until` on a timestamp, and expressing both in one WHERE clause makes
    // the rule harder to read than it is to apply.
    return options.includeStale ? memories : memories.filter((m) => current(m, now));
  }

  /** Counts by provenance. Meant to be read by a person deciding what to trust. */
  summary(): Array<{ provenance: string; kind: string; count: number }> {
    return this.db
      .prepare(
        `SELECT provenance, kind, COUNT(*) AS count
         FROM memories WHERE superseded_by IS NULL
         GROUP BY provenance, kind ORDER BY count DESC`
      )
      .all() as any[];
  }

  /**
   * Removes what has expired, keeping what was contradicted.
   *
   * An appointment that has passed is noise. A belief that turned out wrong is
   * a record, and the difference is why these are separate axes.
   */
  prune(now = Date.now()): number {
    const rows = this.db
      .prepare(`SELECT * FROM memories WHERE retention IN ('until','session') AND superseded_by IS NULL`)
      .all() as Row[];
    const dead = rows.map(toMemory).filter((m) => !current(m, now));
    const remove = this.db.prepare(`DELETE FROM memories WHERE id = ?`);
    for (const m of dead) remove.run(m.id);
    return dead.length;
  }
}
