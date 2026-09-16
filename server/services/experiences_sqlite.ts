import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

import {
  Experience, ExperienceInput, Outcome, attemptKey, validateExperience,
} from '../core/experience.js';

/**
 * Experiences, accumulated rather than appended.
 *
 * The same attempt recorded twice becomes one row with two observations, not
 * two rows. Which matters because the question asked of this store is "has
 * this been tried, and how did it go" — and an answer of "yes, eleven times,
 * failing on nine of them" is a different answer from eleven separate rows
 * that somebody has to count.
 */

interface Row {
  id: string;
  attempt_key: string;
  attempt: string;
  situation: string;
  outcome: string;
  outcomes_json: string;
  learned: string;
  evidence_json: string;
  affects_json: string;
  observations: number;
  first_seen_at: string;
  last_seen_at: string;
}

function parseArray(json: string): any[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function toExperience(row: Row): Experience {
  return {
    id: row.id,
    attempt: row.attempt,
    situation: row.situation,
    outcome: row.outcome as Outcome,
    outcomes: parseArray(row.outcomes_json) as Outcome[],
    learned: row.learned,
    evidence: parseArray(row.evidence_json).map(String),
    affects: parseArray(row.affects_json).map(String),
    observations: row.observations,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  };
}

export class ExperienceStore {
  constructor(private db: Database.Database) {}

  /**
   * Records an attempt and its outcome.
   *
   * Seen before, it adds an observation and updates what was learned — the
   * latest reading of a repeated attempt is the one worth acting on, while the
   * history of outcomes is kept so a method that stopped working is visible.
   */
  record(input: ExperienceInput, now = new Date()): { stored: Experience | null; reason: string } {
    const verdict = validateExperience(input);
    if (!verdict.ok || !verdict.adjusted) return { stored: null, reason: verdict.reason };
    const a = verdict.adjusted;
    const key = attemptKey(a.attempt);
    const at = now.toISOString();

    const existing = this.db
      .prepare(`SELECT * FROM experiences WHERE attempt_key = ?`)
      .get(key) as Row | undefined;

    if (existing) {
      const outcomes = [...(parseArray(existing.outcomes_json) as Outcome[]), a.outcome];
      this.db
        .prepare(
          `UPDATE experiences SET
             outcome = ?, outcomes_json = ?, learned = ?, situation = ?,
             evidence_json = ?, affects_json = ?,
             observations = observations + 1, last_seen_at = ?
           WHERE attempt_key = ?`
        )
        .run(
          a.outcome, JSON.stringify(outcomes), a.learned, a.situation,
          JSON.stringify([...parseArray(existing.evidence_json), ...(a.evidence ?? [])].slice(-20)),
          JSON.stringify(a.affects ?? []), at, key
        );
      const updated = this.db.prepare(`SELECT * FROM experiences WHERE attempt_key = ?`).get(key) as Row;
      return {
        stored: toExperience(updated),
        reason: `同じ試みの ${updated.observations} 回目として記録しました。`,
      };
    }

    const experience: Experience = {
      id: randomUUID(),
      attempt: a.attempt,
      situation: a.situation,
      outcome: a.outcome,
      outcomes: [a.outcome],
      learned: a.learned,
      evidence: a.evidence ?? [],
      affects: a.affects ?? [],
      observations: 1,
      firstSeenAt: at,
      lastSeenAt: at,
    };

    this.db
      .prepare(
        `INSERT INTO experiences
           (id, attempt_key, attempt, situation, outcome, outcomes_json, learned,
            evidence_json, affects_json, observations, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
      )
      .run(
        experience.id, key, experience.attempt, experience.situation, experience.outcome,
        JSON.stringify(experience.outcomes), experience.learned,
        JSON.stringify(experience.evidence), JSON.stringify(experience.affects), at, at
      );

    return { stored: experience, reason: '初めての観測として記録しました。' };
  }

  /**
   * Anything tried that resembles this.
   *
   * Substring matching on the attempt and the situation. Crude on purpose:
   * something that surfaces a near-miss for a person to dismiss is more useful
   * than something that silently decides two attempts were unrelated.
   */
  lookup(query: string, limit = 10): Experience[] {
    const needle = `%${query.trim()}%`;
    const rows = this.db
      .prepare(
        `SELECT * FROM experiences
         WHERE attempt LIKE ? OR situation LIKE ? OR learned LIKE ?
         ORDER BY observations DESC, last_seen_at DESC LIMIT ?`
      )
      .all(needle, needle, needle, Math.min(limit, 50)) as Row[];
    return rows.map(toExperience);
  }

  /**
   * Attempts that have gone wrong more than once, in the same shape.
   *
   * The list worth reading before starting anything. Today produced three of
   * these, each noticed and fixed and then repeated within hours.
   */
  recurringFailures(): Experience[] {
    const rows = this.db
      .prepare(`SELECT * FROM experiences WHERE observations > 1 ORDER BY observations DESC`)
      .all() as Row[];
    return rows
      .map(toExperience)
      .filter((e) => e.outcomes.filter((o) => o === 'failed').length > 1);
  }

  /** Where a method used to work and has stopped, or the reverse. */
  inconsistent(): Experience[] {
    const rows = this.db
      .prepare(`SELECT * FROM experiences WHERE observations > 1`)
      .all() as Row[];
    return rows
      .map(toExperience)
      .filter((e) => e.outcomes.includes('worked') && e.outcomes.includes('failed'));
  }

  list(limit = 50): Experience[] {
    const rows = this.db
      .prepare(`SELECT * FROM experiences ORDER BY last_seen_at DESC LIMIT ?`)
      .all(Math.min(limit, 200)) as Row[];
    return rows.map(toExperience);
  }
}
