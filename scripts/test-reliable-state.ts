/**
 * Reliable State runtime tests.
 *
 * These exercise the real SQLite file, the real stores, the real orchestrator
 * and the real ChatService against a scripted provider. TypeScript alone cannot
 * prove any of the properties below.
 *
 * Restart semantics are tested by actually closing the database handle and
 * reopening the same file, which is what a backend restart does.
 *
 * Run: npm test
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type Database from 'better-sqlite3';

import { openDatabase, getSchemaVersion, LATEST_SCHEMA_VERSION } from '../server/services/db.js';
import { SqliteConversationStore, deriveTitle } from '../server/services/conversation_sqlite.js';
import { SqliteApprovalStore } from '../server/services/approval_sqlite.js';
import { SqliteActivityLogStore } from '../server/services/activity_log_sqlite.js';
import { JarvisOrchestrator, StaleApprovalError } from '../server/core/orchestrator.js';
import { ChatService, ConversationNotFoundError } from '../server/core/chat_service.js';
import { ToolRegistry } from '../server/tools/registry.js';
import { RiskLevel, Tool, ConversationTurn } from '../server/core/types.js';
import { AIProvider, AIProviderResponse } from '../server/providers/base.js';

// ---------------------------------------------------------------- test harness

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    failures.push(name + (detail ? ` — ${detail}` : ''));
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function eq(name: string, actual: any, expected: any) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, ok, ok ? undefined : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function section(title: string) {
  console.log(`\n▸ ${title}`);
}

async function expectThrows(name: string, fn: () => any, matcher?: (err: any) => boolean) {
  try {
    await fn();
    check(name, false, 'expected a throw, got none');
  } catch (err: any) {
    check(name, matcher ? matcher(err) : true, matcher ? `unexpected error: ${err?.name}: ${err?.message}` : undefined);
  }
}

// ------------------------------------------------------------- scripted provider

type Step =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; args?: any; text?: string };

class ScriptedProvider implements AIProvider {
  id = 'scripted';
  name = 'Scripted Test Provider';
  currentModel = 'scripted-v1';
  calls: ConversationTurn[][] = [];
  private queue: Step[] = [];
  private failNext: Error | null = null;
  private failAlwaysError: Error | null = null;

  setModel(m: string) { this.currentModel = m; }
  script(...steps: Step[]) { this.queue.push(...steps); return this; }
  /** Fails a single attempt; the retry layer may recover from it. */
  failWith(err: Error) { this.failNext = err; return this; }
  /** Fails every attempt, so the error reaches the caller. */
  failAlways(err: Error | null) { this.failAlwaysError = err; return this; }

  async generateResponse(messages: ConversationTurn[]): Promise<AIProviderResponse> {
    this.calls.push(JSON.parse(JSON.stringify(messages)));

    if (this.failAlwaysError) throw this.failAlwaysError;

    if (this.failNext) {
      const err = this.failNext;
      this.failNext = null;
      throw err;
    }

    const step = this.queue.shift() ?? { kind: 'text' as const, text: 'default reply' };
    if (step.kind === 'text') return { content: step.text };
    return {
      content: step.text ?? '',
      toolCalls: [{ id: `call-${this.calls.length}`, name: step.name, args: step.args ?? {} }],
    };
  }
}

// ------------------------------------------------------------------------ tools

let readToolRuns = 0;
let writeToolRuns = 0;

const readTool: Tool = {
  name: 'read_probe',
  description: 'READ tool, auto-executes.',
  riskLevel: RiskLevel.READ,
  schema: { type: 'object', properties: {} },
  async execute() {
    readToolRuns++;
    return { ok: true, runs: readToolRuns };
  },
};

// The invariant under test: skipApproval must NOT bypass approval for WRITE.
const writeToolClaimingSkip: Tool = {
  name: 'write_probe',
  description: 'WRITE tool that dishonestly requests skipApproval.',
  riskLevel: RiskLevel.WRITE,
  skipApproval: true,
  schema: { type: 'object', properties: { value: { type: 'string' } } },
  async execute(args: any) {
    writeToolRuns++;
    return { written: args?.value ?? null, runs: writeToolRuns };
  },
};

const failingTool: Tool = {
  name: 'failing_probe',
  description: 'READ tool that always throws.',
  riskLevel: RiskLevel.READ,
  schema: { type: 'object', properties: {} },
  async execute() {
    throw new Error('tool exploded');
  },
};

// ------------------------------------------------------------------------- rig

interface Rig {
  db: Database.Database;
  conversations: SqliteConversationStore;
  approvals: SqliteApprovalStore;
  activity: SqliteActivityLogStore;
  orchestrator: JarvisOrchestrator;
  chat: ChatService;
  provider: ScriptedProvider;
  registry: ToolRegistry;
}

function buildRig(dbPath: string, provider: ScriptedProvider): Rig {
  const db = openDatabase(dbPath);
  const conversations = new SqliteConversationStore(db);
  const approvals = new SqliteApprovalStore(db);
  const activity = new SqliteActivityLogStore(db);

  const registry = new ToolRegistry();
  registry.register(readTool);
  registry.register(writeToolClaimingSkip);
  registry.register(failingTool);

  const orchestrator = new JarvisOrchestrator(provider, registry, approvals);
  const chat = new ChatService(orchestrator, conversations, approvals, activity);

  return { db, conversations, approvals, activity, orchestrator, chat, provider, registry };
}

/** Simulates a backend restart against the same database file. */
function restart(rig: Rig, dbPath: string, provider: ScriptedProvider): Rig {
  rig.db.close();
  return buildRig(dbPath, provider);
}

function countMessages(rig: Rig, conversationId: string, role?: 'user' | 'assistant') {
  const messages = rig.conversations.listMessages(conversationId);
  return role ? messages.filter((m) => m.role === role).length : messages.length;
}

// ------------------------------------------------------------------------ main

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'iris-reliable-state-'));
  const dbPath = join(dir, 'test.db');
  const provider = new ScriptedProvider();
  let rig = buildRig(dbPath, provider);

  try {
    // ---------------------------------------------------------------------
    section('Schema, pragmas and migrations');

    eq('schema is at the latest version', getSchemaVersion(rig.db), LATEST_SCHEMA_VERSION);
    eq('foreign_keys pragma is ON', rig.db.pragma('foreign_keys', { simple: true }), 1);
    eq('journal_mode is WAL', String(rig.db.pragma('journal_mode', { simple: true })).toLowerCase(), 'wal');

    const tables = (rig.db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all() as Array<{ name: string }>).map((r) => r.name);
    check(
      'all expected tables exist',
      ['activity_logs', 'conversation_messages', 'conversations', 'pending_approvals'].every((t) =>
        tables.includes(t)
      ),
      tables.join(', ')
    );

    const approvalCols = (rig.db.prepare(`PRAGMA table_info(pending_approvals)`).all() as any[]).map((c) => c.name);
    check('pending_approvals has conversation_id', approvalCols.includes('conversation_id'));

    // Migrations must be idempotent: reopening applies nothing and stays healthy.
    rig = restart(rig, dbPath, provider);
    eq('re-open keeps schema version stable', getSchemaVersion(rig.db), LATEST_SCHEMA_VERSION);

    // ---------------------------------------------------------------------
    section('Foreign key behaviour is intentional and enforced');

    await expectThrows(
      'message with unknown conversation_id is rejected',
      () => rig.conversations.addMessage('does-not-exist', 'user', 'orphan'),
      (err) => /Conversation not found/.test(err.message)
    );

    const cascadeConv = rig.conversations.createConversation('cascade');
    rig.conversations.addMessage(cascadeConv.id, 'user', 'to be cascaded');
    rig.approvals.savePending({
      approvalId: 'cascade-approval',
      sessionId: 'cascade-session',
      conversationId: cascadeConv.id,
      toolCallId: 'tc',
      toolName: 'write_probe',
      argsJson: '{}',
      riskLevel: RiskLevel.WRITE,
      historyJson: '[]',
    });
    rig.activity.info('cascade.probe', { conversationId: cascadeConv.id });

    rig.conversations.deleteConversation(cascadeConv.id);
    eq('deleting a conversation cascades its messages', countMessages(rig, cascadeConv.id), 0);
    eq(
      'deleting a conversation cascades its pending approvals',
      rig.approvals.listPendingByConversation(cascadeConv.id).length,
      0
    );
    check(
      'activity logs deliberately survive conversation deletion',
      rig.activity.list({ conversationId: cascadeConv.id }).length === 1
    );

    // ---------------------------------------------------------------------
    section('Conversation identity, titles and listing');

    provider.script({ kind: 'text', text: 'first reply' });
    const first = await rig.chat.sendMessage({
      message: '心臓の刺激伝導系について整理したい',
    });

    check('a durable conversationId is issued', typeof first.conversationId === 'string' && first.conversationId.length > 0);
    check('conversationId differs from execution sessionId', first.conversationId !== first.sessionId);
    eq('title is generated deterministically', first.title, '心臓の刺激伝導系について整理したい');
    eq('deriveTitle truncates long input at 40 code points', Array.from(deriveTitle('あ'.repeat(100))).length, 40);
    eq('deriveTitle collapses whitespace', deriveTitle('  a \n b  '), 'a b');
    eq('deriveTitle falls back for empty input', deriveTitle('   '), '新しい会話');

    const second = rig.conversations.createConversation(null);
    check('multiple conversations coexist', rig.conversations.listConversations().length >= 2);
    eq('most recent conversation is the newest touched', rig.conversations.getMostRecentConversation()?.id, second.id);

    // Sending to the older thread makes it most-recent again.
    provider.script({ kind: 'text', text: 'reply in first thread' });
    await rig.chat.sendMessage({ conversationId: first.conversationId, message: '続き' });
    eq(
      'recency follows activity, not creation order',
      rig.conversations.getMostRecentConversation()?.id,
      first.conversationId
    );

    // An explicitly titled thread is never retitled by later messages.
    rig.conversations.setTitle(second.id, '手動タイトル');
    provider.script({ kind: 'text', text: 'ok' });
    await rig.chat.sendMessage({ conversationId: second.id, message: '別の話題です' });
    eq('explicit titles are not overwritten', rig.conversations.getConversation(second.id)?.title, '手動タイトル');

    // Recency must hold when operations land inside the same millisecond, which
    // is exactly where the timestamp-only ordering used to pick the wrong thread.
    const burst = Array.from({ length: 12 }, () => rig.conversations.createConversation(null));
    eq(
      'rapid creation still yields the last-created as most recent',
      rig.conversations.getMostRecentConversation()?.id,
      burst[burst.length - 1].id
    );
    for (const conversation of burst) {
      rig.conversations.addMessage(conversation.id, 'user', 'burst');
    }
    eq(
      'rapid activity still yields the last-touched as most recent',
      rig.conversations.getMostRecentConversation()?.id,
      burst[burst.length - 1].id
    );
    rig.conversations.addMessage(burst[0].id, 'user', 'touched again');
    eq(
      'touching an older thread promotes it even within the same millisecond',
      rig.conversations.getMostRecentConversation()?.id,
      burst[0].id
    );
    eq(
      'listing order matches recency exactly',
      rig.conversations.listConversations(3).map((c) => c.id)[0],
      burst[0].id
    );
    for (const conversation of burst) rig.conversations.deleteConversation(conversation.id);

    await expectThrows(
      'unknown conversationId is rejected, not silently recreated',
      () => rig.chat.sendMessage({ conversationId: 'nope', message: 'hi' }),
      (err) => err instanceof ConversationNotFoundError
    );

    // ---------------------------------------------------------------------
    section('Exactly-once persistence and the no-duplicate contract');

    provider.script({ kind: 'text', text: 'reply A' });
    const convo = await rig.chat.sendMessage({ message: 'ユーザー発言1' });
    eq('one user + one assistant message persisted', countMessages(rig, convo.conversationId), 2);
    eq('user message persisted exactly once', countMessages(rig, convo.conversationId, 'user'), 1);
    eq('assistant message persisted exactly once', countMessages(rig, convo.conversationId, 'assistant'), 1);

    const callsBefore = provider.calls.length;
    provider.script({ kind: 'text', text: 'reply B' });
    await rig.chat.sendMessage({ conversationId: convo.conversationId, message: 'ユーザー発言2' });

    const lastCall = provider.calls[provider.calls.length - 1];
    const userTurns = lastCall.filter((t) => t.role === 'user').map((t) => t.content);
    eq('provider saw each user turn exactly once', userTurns, ['ユーザー発言1', 'ユーザー発言2']);
    eq('history carried the prior assistant turn', lastCall.filter((t) => t.role === 'assistant').length, 1);
    check('provider was actually invoked', provider.calls.length === callsBefore + 1);

    const ordered = rig.conversations.listMessages(convo.conversationId).map((m) => `${m.role}:${m.content}`);
    eq('messages are stored in turn order', ordered, [
      'user:ユーザー発言1',
      'assistant:reply A',
      'user:ユーザー発言2',
      'assistant:reply B',
    ]);

    // ---------------------------------------------------------------------
    section('Restart durability');

    rig = restart(rig, dbPath, provider);
    eq('messages survive a backend restart', countMessages(rig, convo.conversationId), 4);
    eq(
      'most recent conversation is restorable after restart',
      rig.conversations.getMostRecentConversation()?.id,
      convo.conversationId
    );

    provider.script({ kind: 'text', text: 'reply after restart' });
    await rig.chat.sendMessage({ conversationId: convo.conversationId, message: '再起動後の発言' });
    eq('conversation continues after restart', countMessages(rig, convo.conversationId), 6);

    // ---------------------------------------------------------------------
    section('Risky-tool approval invariant');

    readToolRuns = 0;
    writeToolRuns = 0;

    provider.script({ kind: 'tool', name: 'read_probe' }, { kind: 'text', text: 'read done' });
    const readRun = await rig.chat.sendMessage({ message: 'READツールを使って' });
    eq('READ tool auto-executes', readRun.status, 'completed');
    eq('READ tool actually ran', readToolRuns, 1);

    provider.script({ kind: 'tool', name: 'write_probe', args: { value: 'x' } });
    const approvalRun = await rig.chat.sendMessage({ message: 'WRITEツールを使って' });
    eq('WRITE tool pauses for approval despite skipApproval:true', approvalRun.status, 'requires_approval');
    eq('WRITE tool did NOT execute before approval', writeToolRuns, 0);
    eq('no tools reported as executed', approvalRun.executedTools?.length, 0);
    eq('user turn persisted before the approval pause', countMessages(rig, approvalRun.conversationId, 'user'), 1);
    eq('no assistant message persisted while pending', countMessages(rig, approvalRun.conversationId, 'assistant'), 0);

    // ---------------------------------------------------------------------
    section('Approval durability and exactly-once continuation');

    const pendingSessionId = approvalRun.sessionId;
    const approvalConversationId = approvalRun.conversationId;

    rig = restart(rig, dbPath, provider);
    const survived = rig.approvals.getPendingBySessionId(pendingSessionId);
    check('pending approval survives restart', survived !== null);
    eq('pending approval remembers its conversation', survived?.conversationId, approvalConversationId);
    eq('pending approval is globally discoverable', rig.approvals.listPending().length, 1);
    check(
      'pending approval is discoverable from its conversation',
      rig.chat.pendingApprovalFor(approvalConversationId) !== null
    );

    provider.script({ kind: 'text', text: '書き込み完了しました' });
    const approved = await rig.chat.resolveApproval(pendingSessionId, true);
    eq('approved run completes', approved.status, 'completed');
    eq('approved tool executed exactly once', writeToolRuns, 1);
    eq('continuation persisted exactly once', countMessages(rig, approvalConversationId, 'assistant'), 1);
    eq('user turn still stored exactly once', countMessages(rig, approvalConversationId, 'user'), 1);
    eq('approval is no longer pending', rig.approvals.listPending().length, 0);

    await expectThrows(
      'replayed approval fails safely instead of re-executing',
      () => rig.chat.resolveApproval(pendingSessionId, true),
      (err) => err instanceof StaleApprovalError
    );
    eq('replayed approval did not run the tool again', writeToolRuns, 1);
    eq('replayed approval did not persist a second reply', countMessages(rig, approvalConversationId, 'assistant'), 1);

    await expectThrows(
      'unknown sessionId fails safely',
      () => rig.chat.resolveApproval('no-such-session', true),
      (err) => err instanceof StaleApprovalError
    );

    // ---------------------------------------------------------------------
    section('Rejection path');

    writeToolRuns = 0;
    provider.script({ kind: 'tool', name: 'write_probe', args: { value: 'y' } });
    const rejectRun = await rig.chat.sendMessage({ message: '危険な操作をして' });
    eq('rejection flow reaches approval', rejectRun.status, 'requires_approval');

    provider.script({ kind: 'text', text: '実行を中止しました' });
    const rejected = await rig.chat.resolveApproval(rejectRun.sessionId, false);
    eq('rejected run completes', rejected.status, 'completed');
    eq('rejected tool never executed', writeToolRuns, 0);
    eq('rejection continuation persisted exactly once', countMessages(rig, rejectRun.conversationId, 'assistant'), 1);

    await expectThrows(
      'replayed rejection fails safely',
      () => rig.chat.resolveApproval(rejectRun.sessionId, false),
      (err) => err instanceof StaleApprovalError
    );
    eq('replayed rejection did not persist a second reply', countMessages(rig, rejectRun.conversationId, 'assistant'), 1);

    // ---------------------------------------------------------------------
    section('Errors stay out of semantic history');

    const errorConv = rig.conversations.createConversation('error thread');

    // A persistent provider failure must still surface. 400 is not retryable,
    // so this also proves a client error is not pointlessly repeated.
    const permanent: any = new Error('Provider API Error: invalid request');
    permanent.status = 400;
    provider.failAlways(permanent);
    const callsBeforeFailure = provider.calls.length;

    await expectThrows(
      'provider failure propagates to the caller',
      () => rig.chat.sendMessage({ conversationId: errorConv.id, message: '失敗する発言' }),
      (err) => /invalid request/.test(err.message)
    );
    eq('a non-retryable provider error is attempted only once', provider.calls.length - callsBeforeFailure, 1);
    provider.failAlways(null);

    eq('user turn is preserved through the failure', countMessages(rig, errorConv.id, 'user'), 1);
    eq('no assistant message was written for the failure', countMessages(rig, errorConv.id, 'assistant'), 0);
    const errorLogs = rig.activity.list({ conversationId: errorConv.id, level: 'error' });
    eq('failure is recorded in the activity log', errorLogs.length, 1);
    eq('failure is logged under the right event', errorLogs[0].event, 'chat.provider_error');

    const stored = rig.conversations.listMessages(errorConv.id).map((m) => m.content);
    check('no error text leaked into conversation messages', !stored.some((c) => c.includes('503')));

    // Retry after a failure works and does not duplicate the earlier user turn.
    provider.script({ kind: 'text', text: '復帰しました' });
    await rig.chat.sendMessage({ conversationId: errorConv.id, message: '再送' });
    const errorHistory = provider.calls[provider.calls.length - 1];
    check(
      'retry history contains the earlier user turn and no error text',
      errorHistory.some((t) => t.content === '失敗する発言') &&
        !errorHistory.some((t) => String(t.content).includes('503'))
    );

    // A transient provider failure now self-heals rather than reaching the user.
    // This is the behaviour the timeout/retry layer exists to provide: fewer
    // avoidable errors surfaced, without changing what gets persisted.
    const transientConv = rig.conversations.createConversation('transient thread');
    const transient: any = new Error('Provider API Error: 503 service unavailable');
    transient.status = 503;
    provider.failWith(transient);
    provider.script({ kind: 'text', text: '再試行で成功しました' });
    const healed = await rig.chat.sendMessage({ conversationId: transientConv.id, message: '一時的に失敗する発言' });
    eq('a transient provider failure recovers without surfacing', healed.status, 'completed');
    eq('the recovered reply is persisted exactly once', countMessages(rig, transientConv.id, 'assistant'), 1);
    eq('the user turn is still stored exactly once', countMessages(rig, transientConv.id, 'user'), 1);
    eq('no error was logged for a recovered call', rig.activity.list({ conversationId: transientConv.id, level: 'error' }).length, 0);

    // A tool that throws is surfaced as a tool result, not as a crash.
    provider.script({ kind: 'tool', name: 'failing_probe' }, { kind: 'text', text: 'ツールが失敗しました' });
    const toolFailure = await rig.chat.sendMessage({ conversationId: errorConv.id, message: '失敗するツール' });
    eq('tool failure still completes the run', toolFailure.status, 'completed');
    check(
      'tool error is reported in executedTools',
      Boolean(toolFailure.executedTools?.[0]?.result?.error)
    );

    // ---------------------------------------------------------------------
    section('Empty and malformed input');

    await expectThrows(
      'empty message is rejected',
      () => rig.chat.sendMessage({ message: '   ' }),
      (err) => /空にできません/.test(err.message)
    );
    await expectThrows('missing sessionId is rejected', () => rig.chat.resolveApproval('', true));

    // ---------------------------------------------------------------------
    section('Integrity after the full run');

    eq('integrity_check passes', rig.db.pragma('integrity_check', { simple: true }), 'ok');
    check('activity log captured events', rig.activity.list({ limit: 500 }).length > 0);
  } finally {
    try {
      rig.db.close();
    } catch {
      /* ignore */
    }
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Reliable State: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('All Reliable State runtime tests passed.');
}

main().catch((err) => {
  console.error('\nTest harness crashed:', err);
  process.exit(1);
});
