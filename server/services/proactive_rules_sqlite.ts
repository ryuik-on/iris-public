import type Database from 'better-sqlite3';
import type { ProactiveRule } from '../core/proactive_service.js';

/**
 * 先回りの規則の置き場。
 *
 * `ProactiveService` は規則を配列で持つ。**起動のたびに空になる**ので、
 * 足す口があっても足したものは残らなかった —— 提案が一件も出たことが
 * ないのは、その半分がこれ（残りの半分は、評価を誰も呼んでいないこと）。
 *
 * 無効にした規則は**消さずに残す。**消すと、なぜ在ったかも消える。
 */
export class ProactiveRuleStore {
  constructor(private db: Database.Database) {}

  save(rule: ProactiveRule, now = new Date()): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO proactive_rules
           (id, description, conditions_json, suggestion, cooldown_ms, prompt, created_at, enabled)
         VALUES (@id, @description, @conditions, @suggestion, @cooldown, @prompt,
                 COALESCE((SELECT created_at FROM proactive_rules WHERE id = @id), @now),
                 COALESCE((SELECT enabled FROM proactive_rules WHERE id = @id), 1))`
      )
      .run({
        id: rule.id,
        description: rule.description,
        conditions: JSON.stringify(rule.conditions),
        suggestion: rule.suggestion,
        cooldown: rule.cooldownMs,
        prompt: rule.prompt ?? null,
        now: now.toISOString(),
      });
  }

  /** 有効なものだけ。無効は残っているが、評価には出さない。 */
  enabled(): ProactiveRule[] {
    return this.db
      .prepare(`SELECT * FROM proactive_rules WHERE enabled = 1 ORDER BY created_at`)
      .all()
      .map(shape)
      .filter((r): r is ProactiveRule => r !== null);
  }

  setEnabled(id: string, on: boolean): boolean {
    return (
      this.db.prepare(`UPDATE proactive_rules SET enabled = ? WHERE id = ?`).run(on ? 1 : 0, id)
        .changes > 0
    );
  }
}

function shape(row: any): ProactiveRule | null {
  let conditions: any;
  try {
    conditions = JSON.parse(row.conditions_json);
  } catch {
    // 読めない条件を「条件なし」として通すと、**常に真の規則**になる。落とす。
    return null;
  }
  if (!Array.isArray(conditions)) return null;
  return {
    id: row.id,
    description: row.description,
    conditions,
    suggestion: row.suggestion,
    cooldownMs: Number(row.cooldown_ms) || 0,
    ...(row.prompt ? { prompt: row.prompt } : {}),
  };
}
