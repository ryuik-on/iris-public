import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

export type ActivityLevel = 'info' | 'warn' | 'error';

export interface ActivityLogEntry {
  id: string;
  conversationId: string | null;
  sessionId: string | null;
  level: ActivityLevel;
  event: string;
  message: string | null;
  detail: any | null;
  createdAt: string;
}

export interface ActivityLogInput {
  conversationId?: string | null;
  sessionId?: string | null;
  level: ActivityLevel;
  event: string;
  message?: string | null;
  detail?: any;
}

/**
 * System/tool/error events.
 *
 * Reliable State decision 8.6: API, tool and internal errors must NOT become
 * permanent assistant messages in `conversation_messages`. They land here so the
 * semantic conversation stays clean while failures remain auditable.
 *
 * Schema is created by migration 3 in db.ts, not here.
 */
export class SqliteActivityLogStore {
  constructor(private db: Database.Database) {}

  log(input: ActivityLogInput): ActivityLogEntry {
    const id = randomUUID();
    const now = new Date().toISOString();
    const detailJson = input.detail === undefined ? null : safeStringify(input.detail);

    this.db
      .prepare(
        `INSERT INTO activity_logs
           (id, conversation_id, session_id, level, event, message, detail_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.conversationId ?? null,
        input.sessionId ?? null,
        input.level,
        input.event,
        input.message ?? null,
        detailJson,
        now
      );

    return {
      id,
      conversationId: input.conversationId ?? null,
      sessionId: input.sessionId ?? null,
      level: input.level,
      event: input.event,
      message: input.message ?? null,
      detail: input.detail ?? null,
      createdAt: now,
    };
  }

  info(event: string, input: Omit<ActivityLogInput, 'level' | 'event'> = {}) {
    return this.log({ ...input, level: 'info', event });
  }

  warn(event: string, input: Omit<ActivityLogInput, 'level' | 'event'> = {}) {
    return this.log({ ...input, level: 'warn', event });
  }

  error(event: string, input: Omit<ActivityLogInput, 'level' | 'event'> = {}) {
    return this.log({ ...input, level: 'error', event });
  }

  list(options: { conversationId?: string; level?: ActivityLevel; limit?: number } = {}): ActivityLogEntry[] {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 1000);
    const clauses: string[] = [];
    const params: any[] = [];

    if (options.conversationId) {
      clauses.push('conversation_id = ?');
      params.push(options.conversationId);
    }
    if (options.level) {
      clauses.push('level = ?');
      params.push(options.level);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(
        `SELECT id, conversation_id, session_id, level, event, message, detail_json, created_at
           FROM activity_logs
           ${where}
          ORDER BY created_at DESC, rowid DESC
          LIMIT ?`
      )
      .all(...params, limit) as any[];

    return rows.map(mapRow);
  }
}

function mapRow(row: any): ActivityLogEntry {
  let detail: any = null;
  if (row.detail_json) {
    try {
      detail = JSON.parse(row.detail_json);
    } catch {
      detail = { unparsed: row.detail_json };
    }
  }
  return {
    id: row.id,
    conversationId: row.conversation_id,
    sessionId: row.session_id,
    level: row.level,
    event: row.event,
    message: row.message,
    detail,
    createdAt: row.created_at,
  };
}

function safeStringify(value: any): string {
  try {
    return JSON.stringify(value) ?? 'null';
  } catch {
    return JSON.stringify({ unserializable: String(value) });
  }
}
