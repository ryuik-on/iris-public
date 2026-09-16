/**
 * HTTP smoke test against a running IRIS backend.
 *
 * Unlike scripts/test-reliable-state.ts (in-process, scripted provider), this
 * exercises the live server end to end, including the real AI provider. It
 * therefore costs a real API call.
 *
 * Run: npm run smoke        (defaults to http://localhost:3002)
 *      IRIS_URL=... npm run smoke
 */
const BASE = process.env.IRIS_URL || `http://localhost:${process.env.PORT || 3002}`;

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function api(path: string, init?: RequestInit) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function main() {
  console.log(`IRIS HTTP smoke test → ${BASE}\n`);

  console.log('▸ Health');
  const health = await api('/api/health');
  check('health responds 200', health.status === 200, `status ${health.status}`);
  check('status is healthy', health.body?.status === 'healthy', JSON.stringify(health.body));
  check('database is ok', health.body?.database === 'ok');
  check(
    'schema is at expected version',
    health.body?.schemaVersion === health.body?.expectedSchemaVersion,
    `${health.body?.schemaVersion} vs ${health.body?.expectedSchemaVersion}`
  );

  console.log('\n▸ Settings');
  const settings = await api('/api/settings');
  check('settings responds 200', settings.status === 200);
  check('a provider is active', settings.body?.activeProvider && settings.body.activeProvider !== 'none');
  console.log(`    provider: ${settings.body?.activeProvider} / ${settings.body?.activeModel}`);
  console.log(`    registered tools: ${settings.body?.registeredTools?.length ?? 0}`);

  console.log('\n▸ Validation');
  const emptyMessage = await api('/api/chat', { method: 'POST', body: JSON.stringify({ message: '  ' }) });
  check('empty message is rejected with 400', emptyMessage.status === 400, `status ${emptyMessage.status}`);

  const badConversation = await api('/api/chat', {
    method: 'POST',
    body: JSON.stringify({ message: 'hi', conversationId: 'definitely-not-a-real-id' }),
  });
  check('unknown conversationId is rejected with 404', badConversation.status === 404, `status ${badConversation.status}`);

  const staleApproval = await api('/api/chat/approve', {
    method: 'POST',
    body: JSON.stringify({ sessionId: 'no-such-session', approved: true }),
  });
  check('stale approval is rejected with 409', staleApproval.status === 409, `status ${staleApproval.status}`);

  console.log('\n▸ Real conversation round trip');
  const created = await api('/api/conversations', { method: 'POST' });
  check('conversation created', created.status === 201);
  const conversationId = created.body?.conversation?.id;
  check('conversation has an id', typeof conversationId === 'string');

  const marker = `smoke-${Date.now()}`;
  const chat = await api('/api/chat', {
    method: 'POST',
    body: JSON.stringify({ conversationId, message: `接続テストです。「${marker}」とだけ返答してください。` }),
  });
  check('chat responds 200', chat.status === 200, JSON.stringify(chat.body).slice(0, 200));
  check('chat completed', chat.body?.status === 'completed');
  check('a reply was produced', typeof chat.body?.reply === 'string' && chat.body.reply.length > 0);
  console.log(`    reply: ${String(chat.body?.reply).slice(0, 120)}`);
  check('exactly two messages were persisted', chat.body?.persisted?.length === 2, `${chat.body?.persisted?.length}`);
  check('conversation title was generated', Boolean(chat.body?.title));

  console.log('\n▸ Persistence readback');
  const fetched = await api(`/api/conversations/${conversationId}`);
  check('conversation is fetchable', fetched.status === 200);
  const messages = fetched.body?.messages ?? [];
  check('two messages stored', messages.length === 2, `${messages.length}`);
  check('first is the user turn', messages[0]?.role === 'user');
  check('user turn stored exactly once', messages.filter((m: any) => m.role === 'user').length === 1);
  check('assistant turn stored exactly once', messages.filter((m: any) => m.role === 'assistant').length === 1);

  const recent = await api('/api/conversations/recent');
  check('recent conversation is the one just used', recent.body?.conversation?.id === conversationId);

  const list = await api('/api/conversations');
  check('conversation appears in the list', list.body?.conversations?.some((c: any) => c.id === conversationId));

  console.log('\n▸ Approvals and activity');
  const approvals = await api('/api/approvals/pending');
  check('pending approvals endpoint responds', approvals.status === 200);
  console.log(`    pending approvals: ${approvals.body?.pendingApprovals?.length ?? 0}`);

  const activity = await api(`/api/activity?conversationId=${conversationId}`);
  check('activity endpoint responds', activity.status === 200);

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Smoke: ${passed} passed, ${failed} failed`);
  console.log(`Test conversation left in place: ${conversationId}`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('\nSmoke test failed to run:', err?.message || err);
  console.error(`Is the backend running on ${BASE}?`);
  process.exit(1);
});
