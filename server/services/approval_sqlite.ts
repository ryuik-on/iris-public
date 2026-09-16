import Database from 'better-sqlite3';
import { RiskLevel } from '../core/types.js';

export interface PendingApprovalRecord {
  approvalId: string;
  sessionId: string;
  conversationId: string | null;
  toolCallId: string;
  toolName: string;
  argsJson: string;
  riskLevel: RiskLevel;
  historyJson: string;
  /**
   * Whether a person started this run or IRIS inferred it. Persisted because
   * the restriction on an inferred run has to survive the approval that
   * interrupted it.
   */
  origin: 'user' | 'inferred';
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
  resolvedAt: string | null;
}

export interface SavePendingInput {
  approvalId: string;
  sessionId: string;
  conversationId?: string | null;
  toolCallId: string;
  toolName: string;
  argsJson: string;
  riskLevel: RiskLevel;
  historyJson: string;
  origin?: 'user' | 'inferred';
}

/**
 * Durable approval state.
 *
 * Schema is owned by db.ts migrations; this class only reads and writes.
 * Approvals belong to their originating conversation (decision 8.7) while
 * remaining globally discoverable via `listPending()`.
 */
export class SqliteApprovalStore {
  constructor(private db: Database.Database) {}

  savePending(record: SavePendingInput): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO pending_approvals
           (approval_id, session_id, conversation_id, tool_call_id, tool_name,
            args_json, risk_level, history_json, origin, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
      )
      .run(
        record.approvalId,
        record.sessionId,
        record.conversationId ?? null,
        record.toolCallId,
        record.toolName,
        record.argsJson,
        record.riskLevel,
        record.historyJson,
        record.origin ?? 'user',
        now
      );
  }

  getPendingBySessionId(sessionId: string): PendingApprovalRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM pending_approvals
          WHERE session_id = ? AND status = 'pending'
          ORDER BY created_at DESC, rowid DESC
          LIMIT 1`
      )
      .get(sessionId) as any;

    return row ? mapRow(row) : null;
  }

  /**
   * Atomically transitions the newest pending approval for a session and
   * returns it, or returns null if there was nothing to claim.
   *
   * Read-then-resolve was racy: two concurrent approve calls could both observe
   * the same pending row and execute the tool twice. Claiming inside a single
   * transaction and requiring `changes === 1` makes continuation exactly-once
   * and makes a stale or replayed approval fail safely instead of re-executing.
   */
  claimPending(sessionId: string, status: 'approved' | 'rejected'): PendingApprovalRecord | null {
    const now = new Date().toISOString();

    const tx = this.db.transaction((): PendingApprovalRecord | null => {
      const row = this.db
        .prepare(
          `SELECT * FROM pending_approvals
            WHERE session_id = ? AND status = 'pending'
            ORDER BY created_at DESC, rowid DESC
            LIMIT 1`
        )
        .get(sessionId) as any;

      if (!row) return null;

      const info = this.db
        .prepare(
          `UPDATE pending_approvals
              SET status = ?, resolved_at = ?
            WHERE approval_id = ? AND status = 'pending'`
        )
        .run(status, now, row.approval_id);

      if (info.changes !== 1) return null;

      return mapRow({ ...row, status, resolved_at: now });
    });

    return tx();
  }

  /** Globally discoverable pending approvals (decision 8.7). */
  listPending(limit = 50): PendingApprovalRecord[] {
    const bounded = Math.min(Math.max(limit, 1), 500);
    const rows = this.db
      .prepare(
        `SELECT * FROM pending_approvals
          WHERE status = 'pending'
          ORDER BY created_at DESC, rowid DESC
          LIMIT ?`
      )
      .all(bounded) as any[];

    return rows.map(mapRow);
  }

  listPendingByConversation(conversationId: string): PendingApprovalRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM pending_approvals
          WHERE conversation_id = ? AND status = 'pending'
          ORDER BY created_at DESC, rowid DESC`
      )
      .all(conversationId) as any[];

    return rows.map(mapRow);
  }

  /** Non-atomic resolve retained for administrative use; the chat path uses claimPending. */
  resolve(sessionId: string, status: 'approved' | 'rejected'): number {
    const now = new Date().toISOString();
    const info = this.db
      .prepare(
        `UPDATE pending_approvals
            SET status = ?, resolved_at = ?
          WHERE session_id = ? AND status = 'pending'`
      )
      .run(status, now, sessionId);
    return info.changes;
  }
}

function mapRow(row: any): PendingApprovalRecord {
  return {
    approvalId: row.approval_id,
    sessionId: row.session_id,
    conversationId: row.conversation_id ?? null,
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    argsJson: row.args_json,
    riskLevel: row.risk_level,
    historyJson: row.history_json,
    // Older rows predate the column entirely; they were all typed by a person.
    origin: row.origin === 'inferred' ? 'inferred' : 'user',
    status: row.status,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at ?? null,
  };
}
