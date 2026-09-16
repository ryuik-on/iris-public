import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

import { Decision, DecisionInput, validateDecision } from '../core/decision_trace.js';

/**
 * Decision traces, stored.
 *
 * Revised rather than deleted, for the same reason memories are: a decision
 * that was later reversed is the most useful kind to be able to read, and a
 * store that drops it leaves the reversal looking unmotivated.
 */

interface Row {
  id: string;
  title: string;
  decided: string;
  decided_by: string;
  grounds_json: string;
  alternatives_json: string;
  rule: string | null;
  reversal: string | null;
  affects_json: string;
  topic_ref: string | null;
  created_at: string;
  revised_by: string | null;
}

function parseArray(json: string): any[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function toDecision(row: Row): Decision {
  return {
    id: row.id,
    title: row.title,
    decided: row.decided,
    decidedBy: row.decided_by as Decision['decidedBy'],
    grounds: parseArray(row.grounds_json).map(String),
    alternatives: parseArray(row.alternatives_json),
    rule: row.rule,
    reversal: row.reversal,
    affects: parseArray(row.affects_json).map(String),
    topicRef: row.topic_ref,
    createdAt: row.created_at,
    revisedBy: row.revised_by,
  };
}

export class DecisionStore {
  constructor(private db: Database.Database) {}

  record(input: DecisionInput, now = new Date()): { stored: Decision | null; reason: string } {
    const verdict = validateDecision(input);
    if (!verdict.ok || !verdict.adjusted) return { stored: null, reason: verdict.reason };
    const a = verdict.adjusted;

    const decision: Decision = {
      id: randomUUID(),
      title: a.title,
      decided: a.decided,
      decidedBy: a.decidedBy,
      grounds: a.grounds,
      alternatives: a.alternatives ?? [],
      rule: a.rule ?? null,
      reversal: a.reversal ?? null,
      affects: a.affects ?? [],
      topicRef: a.topicRef ?? null,
      createdAt: now.toISOString(),
      revisedBy: null,
    };

    this.db
      .prepare(
        `INSERT INTO decisions
           (id, title, decided, decided_by, grounds_json, alternatives_json,
            rule, reversal, affects_json, topic_ref, created_at, revised_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
      )
      .run(
        decision.id, decision.title, decision.decided, decision.decidedBy,
        JSON.stringify(decision.grounds), JSON.stringify(decision.alternatives),
        decision.rule, decision.reversal, JSON.stringify(decision.affects),
        decision.topicRef, decision.createdAt
      );

    return { stored: decision, reason: verdict.reason };
  }

  /** Marks a decision as superseded by a later one. The old row stays. */
  revise(oldId: string, newId: string): boolean {
    return (
      this.db.prepare(`UPDATE decisions SET revised_by = ? WHERE id = ? AND revised_by IS NULL`)
        .run(newId, oldId).changes > 0
    );
  }

  get(id: string): Decision | null {
    const row = this.db.prepare(`SELECT * FROM decisions WHERE id = ?`).get(id) as Row | undefined;
    return row ? toDecision(row) : null;
  }

  /**
   * Decisions, newest first.
   *
   * Revised ones are excluded by default and available on request — the
   * current answer is what is usually wanted, and the history is what is
   * wanted when the current answer is being questioned.
   */
  list(options: { includeRevised?: boolean; decidedBy?: string; limit?: number } = {}): Decision[] {
    const clauses: string[] = [];
    const params: any[] = [];
    if (!options.includeRevised) clauses.push('revised_by IS NULL');
    if (options.decidedBy) { clauses.push('decided_by = ?'); params.push(options.decidedBy); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM decisions ${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...params, Math.min(options.limit ?? 50, 500)) as Row[];
    return rows.map(toDecision);
  }

  /**
   * What has been decided about a given thing.
   *
   * The lookup that matters when someone is about to change something and
   * wants to know whether the current shape was chosen or merely arrived at.
   */
  affecting(key: string, includeRevised = false): Decision[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM decisions
         WHERE affects_json LIKE ? ${includeRevised ? '' : 'AND revised_by IS NULL'}
         ORDER BY created_at DESC`
      )
      .all(`%"${key}"%`) as Row[];
    return rows.map(toDecision);
  }

  /**
   * Decisions recorded without any alternatives.
   *
   * Not a fault list. It is where to look first when a choice turns out badly,
   * because "nothing else was considered" is the most common reason.
   */
  unweighed(): Decision[] {
    return this.list({ limit: 500 }).filter((d) => d.alternatives.length === 0);
  }
}
