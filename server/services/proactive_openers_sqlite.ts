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
   * この規則の、返事を待っている控えの最新のもの。期限は切らない。
   *
   * 「返事待ち」は `recent` と同じく会話の中身から数える。消された会話のものは
   * 返さない —— 消したのは「要らない」という返事で、そこへ書き足すことはできない。
   * `recent(50)` から探すと、控えが 50 件を超えたとき古い返事待ちが見えなくなり、
   * 同じ規則で二本目を開いてしまうので、ここは件数で切らずに引く。
   */
  waitingFor(ruleId: string): OpenerRecord | undefined {
    return this.db
      .prepare(
        `SELECT o.key, o.conversation_id AS conversationId, o.rule_id AS ruleId,
                o.suggestion_id AS suggestionId, o.created_at AS createdAt
           FROM proactive_openers o
           JOIN conversations c ON c.id = o.conversation_id
          WHERE o.rule_id = ?
            AND NOT EXISTS (SELECT 1 FROM conversation_messages m
                             WHERE m.conversation_id = o.conversation_id AND m.role = 'user' AND m.created_at > o.created_at)
          ORDER BY o.created_at DESC
          LIMIT 1`
      )
      .get(ruleId) as OpenerRecord | undefined;
  }

  /**
   * 返事待ちの控えを、新しい根拠のものに付け替える。行は増やさない。
   *
   * 新しい行を足すと、同じ会話・同じ規則の返事待ちが二件に数えられる（通知の一覧に
   * 二度出る）。鍵・提案・時刻を新しくし、既読を外す —— 中身が変わったので、もう一度
   * 読んでもらう。時刻を進めても「返事があったか」は変わらない（返事が無い行だけを
   * 付け替えるので）。
   */
  refresh(previousKey: string, next: { key: string; suggestionId: string; createdAt: string }): boolean {
    return (
      this.db
        .prepare(
          `UPDATE proactive_openers SET key = @key, suggestion_id = @suggestionId, created_at = @createdAt, read_at = NULL
            WHERE key = @previousKey`
        )
        .run({ ...next, previousKey }).changes === 1
    );
  }

  /**
   * 新しい順に。**まだ残っている会話のものだけ**、返事があったかどうかを添えて。
   *
   * 返事の有無は会話の中身から数える（**この一言のあとに**利用者の発言があるか）。
   * 同じ会話に IRIS が続けて話しかけることがあるので、「発言が一つでもあるか」
   * では、返事をしたことのある会話に足した一言が、返事待ちに見えなくなる。
   * 別に「返した」印を持つと、会話と印が食い違ったときにどちらを信じるかを
   * 決めなければならなくなる。**事実は一箇所に。**
   */
  /** この会話の知らせを既読にする。会話が知らせのものでなければ、何もしない。 */
  markRead(conversationId: string, at = new Date()): number {
    return this.db
      .prepare(`UPDATE proactive_openers SET read_at = ? WHERE conversation_id = ? AND read_at IS NULL`)
      .run(at.toISOString(), conversationId).changes;
  }

  markAllRead(at = new Date()): number {
    return this.db.prepare(`UPDATE proactive_openers SET read_at = ? WHERE read_at IS NULL`).run(at.toISOString()).changes;
  }

  recent(limit = 20): Array<OpenerRecord & { title: string | null; replied: boolean; read: boolean; text: string | null }> {
    return this.db
      .prepare(
        `SELECT o.key, o.conversation_id AS conversationId, o.rule_id AS ruleId,
                o.suggestion_id AS suggestionId, o.created_at AS createdAt,
                c.title AS title,
                (o.read_at IS NOT NULL) AS read,
                EXISTS (SELECT 1 FROM conversation_messages m WHERE m.conversation_id = o.conversation_id AND m.role = 'user' AND m.created_at > o.created_at) AS replied,
                (SELECT m.content FROM conversation_messages m WHERE m.conversation_id = o.conversation_id
                  ORDER BY m.created_at ASC, m.rowid ASC LIMIT 1) AS text
           FROM proactive_openers o
           JOIN conversations c ON c.id = o.conversation_id
          ORDER BY o.created_at DESC
          LIMIT ?`
      )
      .all(limit)
      .map((row: any) => ({ ...row, replied: row.replied === 1, read: row.read === 1 }));
  }
}
