import Database from 'better-sqlite3';

/**
 * Finding what was said, across every thread.
 *
 * Topics answer "which conversations belong to this work". This answers "where
 * did I say that", which is the question the user should never have to hold in
 * their head (decision 8.3) — and the one topics cannot reach, because
 * anything never linked to a topic is otherwise unfindable.
 *
 * The handoff rules out the obvious alternative by name: sending every
 * conversation to the model on each turn is not an acceptable answer. So this
 * is a tool the model calls when it needs something, not context stuffed into
 * every request. That also keeps it inside the spending limits — a search
 * costs a SQLite query, not tokens.
 *
 * Index and tokenizer are owned by db.ts migration 11.
 */

export interface SearchHit {
  messageId: string;
  conversationId: string;
  conversationTitle: string | null;
  role: 'user' | 'assistant';
  createdAt: string;
  /** The matching text with surrounding context, not the whole message. */
  snippet: string;
  /** Lower is a better match, as FTS5 reports it. */
  rank: number;
  topics: string[];
}

export interface SearchResult {
  query: string;
  hits: SearchHit[];
  /** True when the query itself could not be searched, rather than not matching. */
  tooShort: boolean;
  note: string;
}

/**
 * trigram indexes overlapping three-character runs, so anything shorter has
 * nothing to match against. Measured, not assumed: 平滑筋 matches, 設計 does
 * not.
 */
export const MIN_QUERY_LENGTH = 3;

export class SearchService {
  constructor(private db: Database.Database) {}

  /**
   * Searches message text.
   *
   * A query too short to index returns `tooShort` rather than an empty list,
   * because "there is nothing" and "I could not look" are different answers
   * and only one of them means the user should try something else.
   */
  search(
    query: string,
    options: { limit?: number; conversationId?: string; role?: 'user' | 'assistant' } = {}
  ): SearchResult {
    const trimmed = query?.trim() ?? '';
    if (trimmed.length < MIN_QUERY_LENGTH) {
      return {
        query: trimmed,
        hits: [],
        tooShort: true,
        note: `検索語は${MIN_QUERY_LENGTH}文字以上必要です（3文字単位で索引しているため）。`,
      };
    }

    const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
    const clauses = ['message_search MATCH ?'];
    const params: any[] = [asPhrase(trimmed)];

    if (options.conversationId) {
      clauses.push('s.conversation_id = ?');
      params.push(options.conversationId);
    }
    if (options.role) {
      clauses.push('s.role = ?');
      params.push(options.role);
    }

    let rows: any[];
    try {
      rows = this.db
        .prepare(
          `SELECT s.message_id, s.conversation_id, s.role, s.created_at,
                  snippet(message_search, 0, '«', '»', '…', 20) AS snippet,
                  rank,
                  c.title AS conversation_title
             FROM message_search s
             LEFT JOIN conversations c ON c.id = s.conversation_id
            WHERE ${clauses.join(' AND ')}
            ORDER BY rank
            LIMIT ?`
        )
        .all(...params, limit) as any[];
    } catch (err: any) {
      // FTS5 rejects some punctuation as malformed query syntax. A user typing
      // a quotation mark should get no results, not a stack trace.
      return {
        query: trimmed,
        hits: [],
        tooShort: false,
        note: `検索できませんでした: ${err?.message ?? String(err)}`,
      };
    }

    const topics = this.topicsByConversation(rows.map((r) => r.conversation_id));

    return {
      query: trimmed,
      hits: rows.map((row) => ({
        messageId: row.message_id,
        conversationId: row.conversation_id,
        conversationTitle: row.conversation_title ?? null,
        role: row.role,
        createdAt: row.created_at,
        snippet: row.snippet,
        rank: row.rank,
        topics: topics.get(row.conversation_id) ?? [],
      })),
      tooShort: false,
      note: rows.length === 0 ? '一致する発言はありませんでした。' : `${rows.length} 件見つかりました。`,
    };
  }

  /**
   * Topic names for the conversations a search touched.
   *
   * Included because a hit is more useful when it says what body of work it
   * came from — the same reason the register keeps evidence next to claims.
   */
  private topicsByConversation(conversationIds: string[]): Map<string, string[]> {
    const unique = [...new Set(conversationIds)];
    if (unique.length === 0) return new Map();

    const placeholders = unique.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT ct.conversation_id, t.name
           FROM conversation_topics ct
           JOIN topics t ON t.id = ct.topic_id
          WHERE ct.conversation_id IN (${placeholders})`
      )
      .all(...unique) as any[];

    const map = new Map<string, string[]>();
    for (const row of rows) {
      const list = map.get(row.conversation_id) ?? [];
      list.push(row.name);
      map.set(row.conversation_id, list);
    }
    return map;
  }

  /** How much there is to search. Useful for telling empty from broken. */
  stats(): { indexed: number; messages: number; inSync: boolean } {
    const indexed = (this.db.prepare('SELECT COUNT(*) n FROM message_search').get() as any).n;
    const messages = (this.db.prepare('SELECT COUNT(*) n FROM conversation_messages').get() as any).n;
    return { indexed, messages, inSync: indexed === messages };
  }

  /**
   * Rebuilds the index from the messages table.
   *
   * Should never be needed — triggers keep it in step — which is exactly why
   * it exists: when it is needed, it will be at a moment when nobody wants to
   * write it.
   */
  reindex(): { indexed: number } {
    const rebuild = this.db.transaction(() => {
      this.db.exec('DELETE FROM message_search');
      this.db.exec(
        `INSERT INTO message_search (content, message_id, conversation_id, role, created_at)
         SELECT content, id, conversation_id, role, created_at FROM conversation_messages`
      );
    });
    rebuild();
    return { indexed: this.stats().indexed };
  }
}

/**
 * Wraps the query as an FTS5 phrase.
 *
 * Without this, a query containing a space or an operator word is parsed as
 * FTS5 syntax — 「心電図 AND」 is a syntax error, and 「読み方 教えて」 silently
 * becomes an AND of two terms rather than the phrase the user typed. Quoting
 * makes the search mean what was typed.
 */
function asPhrase(query: string): string {
  return `"${query.replace(/"/g, '""')}"`;
}
