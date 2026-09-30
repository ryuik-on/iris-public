import type Database from 'better-sqlite3';

/**
 * IRIS が先に話しかけた会話の控え。
 *
 * 置く理由は `db.ts` の移行 32 に書いた —— 規則の冷却は再起動で消えるので、
 * **同じ話で二本目の会話を開かない**ための記録。
 */
export interface OpenerRecord {
  key: string;
  conversationId: string;
  ruleId: string;
  suggestionId: string;
  createdAt: string;
}

export class ProactiveOpenerStore {
  constructor(private db: Database.Database) {}

  has(key: string): boolean {
    return this.db.prepare(`SELECT 1 FROM proactive_openers WHERE key = ?`).get(key) !== undefined;
  }

  record(r: OpenerRecord): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO proactive_openers (key, conversation_id, rule_id, suggestion_id, created_at)
         VALUES (@key, @conversationId, @ruleId, @suggestionId, @createdAt)`
      )
      .run(r);
  }

  /**
   * 新しい順に。**まだ残っている会話のものだけ**、返事があったかどうかを添えて。
   *
   * 返事の有無は会話の中身から数える（利用者の発言が一つでもあるか）。
   * 別に「返した」印を持つと、会話と印が食い違ったときにどちらを信じるかを
   * 決めなければならなくなる。**事実は一箇所に。**
   */
  recent(limit = 20): Array<OpenerRecord & { title: string | null; replied: boolean; text: string | null }> {
    return this.db
      .prepare(
        `SELECT o.key, o.conversation_id AS conversationId, o.rule_id AS ruleId,
                o.suggestion_id AS suggestionId, o.created_at AS createdAt,
                c.title AS title,
                EXISTS (SELECT 1 FROM conversation_messages m WHERE m.conversation_id = o.conversation_id AND m.role = 'user') AS replied,
                (SELECT m.content FROM conversation_messages m WHERE m.conversation_id = o.conversation_id
                  ORDER BY m.created_at ASC, m.rowid ASC LIMIT 1) AS text
           FROM proactive_openers o
           JOIN conversations c ON c.id = o.conversation_id
          ORDER BY o.created_at DESC
          LIMIT ?`
      )
      .all(limit)
      .map((row: any) => ({ ...row, replied: row.replied === 1 }));
  }
}
