import { JarvisOrchestrator, StaleApprovalError, ReplyChannel, ReplyStream } from './orchestrator.js';
import { ConversationTurn, OrchestratorResponse } from './types.js';
import {
  SqliteConversationStore,
  StoredConversation,
  StoredConversationMessage,
} from '../services/conversation_sqlite.js';
import { SqliteApprovalStore, PendingApprovalRecord } from '../services/approval_sqlite.js';
import { Titler } from '../services/conversation_title.js';
import { SqliteActivityLogStore } from '../services/activity_log_sqlite.js';
import { ToolRegistry } from '../tools/registry.js';

export class ConversationNotFoundError extends Error {
  constructor(public readonly conversationId: string) {
    super(`Conversation not found: ${conversationId}`);
    this.name = 'ConversationNotFoundError';
  }
}

export interface ChatResult extends OrchestratorResponse {
  conversationId: string;
  title: string | null;
  /** Messages newly persisted by this call, in order. */
  persisted: StoredConversationMessage[];
}

/**
 * Owns the durable side of a chat turn.
 *
 * Persistence contract:
 *  - the user turn is written exactly once, BEFORE the provider is called, so it
 *    survives provider errors, approval pauses and process restarts;
 *  - history handed to the model is read from the database, never from the
 *    client, so a client that echoes the current turn cannot duplicate it;
 *  - the assistant turn is written exactly once, and only when a run actually
 *    completes — a run that pauses for approval writes nothing;
 *  - errors are written to activity_logs, never to conversation_messages
 *    (decision 8.6).
 */
export class ChatService {
  constructor(
    private orchestrator: JarvisOrchestrator,
    private conversations: SqliteConversationStore,
    private approvals: SqliteApprovalStore,
    private activity: SqliteActivityLogStore,
    private tools?: ToolRegistry,
    /**
     * Optional. Without one the derived title stands, which is the behaviour
     * that existed before and is still a working thread with a usable name.
     */
    private titler?: Titler
  ) {}

  /** Resolves an existing thread or opens a new one. */
  resolveConversation(conversationId?: string | null): StoredConversation {
    if (conversationId) {
      const existing = this.conversations.getConversation(conversationId);
      if (!existing) throw new ConversationNotFoundError(conversationId);
      return existing;
    }
    return this.conversations.createConversation(null);
  }

  async sendMessage(input: {
    conversationId?: string | null;
    message: string;
    /**
     * Carried through to the orchestrator, which uses it to decide what the
     * run may touch. Defaults to a person; nothing becomes an inference by
     * omission.
     */
    origin?: 'user' | 'inferred';
    /**
     * How the request arrived. Voice turns get a spoken-shaped reply; it grants
     * nothing, so it is kept apart from `origin`.
     */
    channel?: ReplyChannel;
    /**
     * Present when someone is reading the reply as it is written.
     *
     * What gets persisted is still the finished text from the run, not the
     * concatenation of what was streamed. The deltas are a view of the reply
     * being written; the record is the reply.
     */
    stream?: ReplyStream;
  }): Promise<ChatResult> {
    const message = typeof input.message === 'string' ? input.message.trim() : '';
    if (!message) throw new Error('message は空にできません。');

    const conversation = this.resolveConversation(input.conversationId);
    const persisted: StoredConversationMessage[] = [];

    // Read previous turns BEFORE persisting the current one, preserving the
    // "history = previous turns only, message = current turn" contract.
    const history = this.toTurns(this.conversations.listMessages(conversation.id));

    persisted.push(this.conversations.addMessage(conversation.id, 'user', message));
    const title = this.conversations.ensureTitle(conversation.id, message);

    let result: OrchestratorResponse;
    try {
      result = await this.orchestrator.process({
        userMessage: message,
        history,
        conversationId: conversation.id,
        origin: input.origin ?? 'user',
        channel: input.channel ?? 'text',
        stream: input.stream,
      });
    } catch (err: any) {
      // The user turn stays persisted; the failure is auditable but not semantic.
      this.activity.error('chat.provider_error', {
        conversationId: conversation.id,
        message: err?.message || String(err),
        detail: { name: err?.name },
      });
      // Already recorded with full conversation context; the HTTP layer would
      // otherwise log the same failure again and double-count it in telemetry.
      if (err && typeof err === 'object') err.logged = true;
      throw err;
    }

    if (result.status === 'completed') {
      persisted.push(
        this.conversations.addMessage(conversation.id, 'assistant', result.reply || '了解いたしました。')
      );
      /**
       * A better name for the thread, once there is something to name it from.
       *
       * The title assigned above is the first forty-one characters of the
       * question, which is a truncation rather than a title. This replaces it
       * with a written one — but only for the first turn, only when nobody
       * has set a title by hand, and never before the reply exists.
       *
       * Not awaited. A thread is usable the moment it is created and the
       * name catching up a few seconds later costs nothing; making anyone
       * wait for it would be spending a person's time on filing.
       */
      if (history.length === 0) {
        void this.retitle(conversation.id, message, result.reply || '');
      }
    }

    this.logExecution(conversation.id, result);

    return {
      ...result,
      conversationId: conversation.id,
      title: title ?? this.conversations.getConversation(conversation.id)?.title ?? null,
      persisted,
    };
  }

  async resolveApproval(sessionId: string, approved: boolean): Promise<ChatResult> {
    if (!sessionId || typeof sessionId !== 'string') {
      throw new Error('sessionId が必要です。');
    }

    let result: OrchestratorResponse;
    try {
      result = await this.orchestrator.resume(sessionId, approved);
    } catch (err: any) {
      if (err instanceof StaleApprovalError) {
        this.activity.warn('approval.stale', {
          sessionId,
          message: err.message,
          detail: { approved },
        });
      } else {
        this.activity.error('approval.resume_error', {
          sessionId,
          message: err?.message || String(err),
        });
      }
      if (err && typeof err === 'object') err.logged = true;
      throw err;
    }

    const conversationId = result.conversationId;
    const persisted: StoredConversationMessage[] = [];

    // An approval raised before conversations were linked has no thread to
    // write back to. The run still completes; it is simply not persisted.
    if (conversationId && result.status === 'completed') {
      persisted.push(
        this.conversations.addMessage(conversationId, 'assistant', result.reply || '了解いたしました。')
      );
    } else if (!conversationId) {
      this.activity.warn('approval.unlinked_conversation', {
        sessionId,
        message: 'Approval resolved without a linked conversation; reply not persisted.',
      });
    }

    this.activity.info(approved ? 'approval.approved' : 'approval.rejected', {
      conversationId: conversationId ?? null,
      sessionId,
      detail: { status: result.status },
    });
    if (conversationId) this.logExecution(conversationId, result);

    return {
      ...result,
      conversationId: conversationId ?? '',
      title: conversationId ? this.conversations.getConversation(conversationId)?.title ?? null : null,
      persisted,
    };
  }

  /**
   * Pending approvals for a thread, in the shape the UI already renders.
   * The tool description is resolved at read time so an approval restored after
   * a restart still explains what it is about to do.
   */
  pendingApprovalFor(conversationId: string) {
    const records = this.approvals.listPendingByConversation(conversationId);
    return records.length > 0 ? toApprovalView(records[0], this.describeTool(records[0].toolName)) : null;
  }

  listPendingApprovals() {
    return this.approvals
      .listPending()
      .map((record) => toApprovalView(record, this.describeTool(record.toolName)));
  }

  private describeTool(name: string): string {
    return this.tools?.get(name)?.description ?? '';
  }

  /**
   * Replaces a truncated title with a written one.
   *
   * Every failure here is swallowed on purpose. The thread already has a
   * usable name; a titler that threw would turn a cosmetic improvement into
   * a broken turn, which is the wrong trade for a label.
   */
  private async retitle(conversationId: string, question: string, reply: string): Promise<void> {
    if (!this.titler) return;
    try {
      const current = this.conversations.getConversation(conversationId)?.title ?? '';
      const suggested = await this.titler.suggest(question, reply);
      if (!suggested) return;
      // Re-read: a person may have named it by hand while this was in flight,
      // and a hand-written name is never replaced by a generated one.
      const now = this.conversations.getConversation(conversationId)?.title ?? '';
      if (now !== current) return;
      this.conversations.setTitle(conversationId, suggested);
    } catch {
      /* the derived title stands */
    }
  }

  private logExecution(conversationId: string, result: OrchestratorResponse) {
    if (result.executedTools && result.executedTools.length > 0) {
      this.activity.info('tools.executed', {
        conversationId,
        sessionId: result.sessionId,
        detail: result.executedTools.map((t) => ({
          name: t.name,
          failed: Boolean(t.result && typeof t.result === 'object' && 'error' in t.result),
        })),
      });
    }
    if (result.status === 'requires_approval' && result.pendingApproval) {
      this.activity.info('approval.requested', {
        conversationId,
        sessionId: result.sessionId,
        detail: {
          toolName: result.pendingApproval.toolName,
          riskLevel: result.pendingApproval.riskLevel,
        },
      });
    }
  }

  private toTurns(messages: StoredConversationMessage[]): ConversationTurn[] {
    return messages.map((m) => ({ role: m.role, content: m.content }));
  }
}

export function toApprovalView(record: PendingApprovalRecord, description = '') {
  let args: any = {};
  try {
    args = JSON.parse(record.argsJson);
  } catch {
    args = { unparsed: record.argsJson };
  }
  return {
    id: record.approvalId,
    sessionId: record.sessionId,
    conversationId: record.conversationId,
    toolCallId: record.toolCallId,
    toolName: record.toolName,
    args,
    riskLevel: record.riskLevel,
    description,
    createdAt: record.createdAt,
  };
}
