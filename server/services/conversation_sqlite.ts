import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

export interface StoredConversation {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationSummary extends StoredConversation {
  messageCount: number;
  lastMessagePreview: string | null;
}

export interface StoredConversationMessage {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
}

export const DEFAULT_CONVERSATION_TITLE = '新しい会話';

/**
 * Monotonic activity counter. Recency must be decided by order of activity, not
 * by wall-clock timestamps, which tie at millisecond resolution under fast or
 * agent-driven use.
 */
const NEXT_SEQ = '(SELECT COALESCE(MAX(updated_seq), 0) + 1 FROM conversations)';
const TITLE_MAX_CHARS = 40;

/**
 * Deterministic title generation (Reliable State decision 8.4).
 * No LLM call is spent on titling; refinement can be layered on later.
 * Uses code points so multi-byte characters and emoji are never split.
 */
export function deriveTitle(text: string): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (!cleaned) return DEFAULT_CONVERSATION_TITLE;
  const chars = Array.from(cleaned);
  if (chars.length <= TITLE_MAX_CHARS) return cleaned;
  return chars.slice(0, TITLE_MAX_CHARS - 1).join('') + '…';
}

/**
 * Durable conversation storage.
 *
 * A `conversationId` is a long-lived thread identity and is deliberately
 * distinct from the orchestrator's per-execution `sessionId`.
 *
 * Schema is owned by db.ts migrations; this class only reads and writes.
 */
export class SqliteConversationStore {
  constructor(private db: Database.Database) {}

  createConversation(title: string | null = null): StoredConversation {
    const now = new Date().toISOString();
    const id = randomUUID();

    this.db
      .prepare(
        `INSERT INTO conversations (id, title, created_at, updated_at, updated_seq)
         VALUES (?, ?, ?, ?, ${NEXT_SEQ})`
      )
      .run(id, title, now, now);

    return { id, title, createdAt: now, updatedAt: now };
  }

  getConversation(id: string): StoredConversation | null {
    const row = this.db
      .prepare(
        `SELECT id, title, created_at, updated_at
           FROM conversations
          WHERE id = ?`
      )
      .get(id) as any;

    return row ? mapConversation(row) : null;
  }

  /** Most recently active thread — what a fresh UI restores into (decision 8.2). */
  getMostRecentConversation(): StoredConversation | null {
    const row = this.db
      .prepare(
        `SELECT id, title, created_at, updated_at
           FROM conversations
          ORDER BY updated_seq DESC, updated_at DESC, rowid DESC
          LIMIT 1`
      )
      .get() as any;

    return row ? mapConversation(row) : null;
  }

  listConversations(limit = 50): ConversationSummary[] {
    const bounded = Math.min(Math.max(limit, 1), 500);
    const rows = this.db
      .prepare(
        `SELECT c.id,
                c.title,
                c.created_at,
                c.updated_at,
                (SELECT COUNT(*) FROM conversation_messages m
                  WHERE m.conversation_id = c.id) AS message_count,
                (SELECT m2.content FROM conversation_messages m2
                  WHERE m2.conversation_id = c.id
                  ORDER BY m2.created_at DESC, m2.rowid DESC
                  LIMIT 1) AS last_message
           FROM conversations c
          ORDER BY c.updated_seq DESC, c.updated_at DESC, c.rowid DESC
          LIMIT ?`
      )
      .all(bounded) as any[];

    return rows.map((row) => ({
      ...mapConversation(row),
      messageCount: row.message_count as number,
      lastMessagePreview: row.last_message ? previewOf(row.last_message) : null,
    }));
  }

  setTitle(conversationId: string, title: string): void {
    this.db.prepare(`UPDATE conversations SET title = ? WHERE id = ?`).run(title, conversationId);
  }

  /**
   * Assigns a title only if the thread does not have one yet, so an explicit
   * user-set title is never clobbered by a later message.
   */
  ensureTitle(conversationId: string, sourceText: string): string | null {
    const conversation = this.getConversation(conversationId);
    if (!conversation) return null;
    if (conversation.title && conversation.title.trim().length > 0) return conversation.title;

    const title = deriveTitle(sourceText);
    this.setTitle(conversationId, title);
    return title;
  }

  addMessage(
    conversationId: string,
    role: 'user' | 'assistant',
    content: string
  ): StoredConversationMessage {
    const now = new Date().toISOString();
    const id = randomUUID();

    // The INSERT itself is guarded by the enforced foreign key, so an unknown
    // conversationId fails at the database rather than on a racy pre-read.
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO conversation_messages
             (id, conversation_id, role, content, created_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(id, conversationId, role, content, now);

      this.db
        .prepare(`UPDATE conversations SET updated_at = ?, updated_seq = ${NEXT_SEQ} WHERE id = ?`)
        .run(now, conversationId);
    });

    try {
      tx();
    } catch (err: any) {
      if (typeof err?.message === 'string' && err.message.includes('FOREIGN KEY')) {
        throw new Error(`Conversation not found: ${conversationId}`);
      }
      throw err;
    }

    return { id, conversationId, role, content, createdAt: now };
  }

  listMessages(conversationId: string): StoredConversationMessage[] {
    const rows = this.db
      .prepare(
        `SELECT id, conversation_id, role, content, created_at
           FROM conversation_messages
          WHERE conversation_id = ?
          ORDER BY created_at ASC, rowid ASC`
      )
      .all(conversationId) as any[];

    return rows.map((row) => ({
      id: row.id,
      conversationId: row.conversation_id,
      role: row.role,
      content: row.content,
      createdAt: row.created_at,
    }));
  }

  /**
   * Retention decision 8.5: nothing is deleted automatically. This exists only
   * for an explicit, user-initiated delete. Messages and pending approvals go
   * with it via ON DELETE CASCADE; activity logs deliberately survive.
   */
  deleteConversation(conversationId: string): boolean {
    const info = this.db.prepare(`DELETE FROM conversations WHERE id = ?`).run(conversationId);
    return info.changes > 0;
  }
}

function mapConversation(row: any): StoredConversation {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function previewOf(content: string): string {
  const cleaned = content.replace(/\s+/g, ' ').trim();
  const chars = Array.from(cleaned);
  return chars.length <= 80 ? cleaned : chars.slice(0, 79).join('') + '…';
}
