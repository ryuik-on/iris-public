/**
 * One live read against the Google Calendar MCP server.
 *
 * The point is the round trip, not the data: a stored token, a connection, a
 * READ tool, an answer. Everything up to here was verified in isolation —
 * scopes in a URL, a flow row in a table — and none of that proves the
 * credential actually works against the server that issued it.
 *
 *   npx tsx scripts/verify-calendar.ts
 */
import 'dotenv/config';
import path from 'path';
import { openDatabase } from '../server/services/db.js';
import { OAuthStore } from '../server/services/oauth_store.js';
import { IrisOAuthProvider, GOOGLE_MCP_SCOPES } from '../server/services/oauth_provider.js';
import { McpClientService } from '../server/services/mcp_client.js';
import { RiskLevel } from '../server/core/types.js';

const SERVER = 'calendar';

async function main() {
  const db = openDatabase(path.join(process.cwd(), 'jarvis_memory.db'));
  const store = new OAuthStore(db);

  const status = store.status(SERVER);
  if (!status.hasToken) {
    console.log('トークンがありません。先に認可を完了してください。');
    process.exit(1);
  }
  console.log(`スコープ    : ${status.scope}`);
  console.log(`有効期限    : ${status.expiresAt}${status.expired ? ' (期限切れ)' : ''}`);
  // The one that decides whether this survives the hour.
  console.log(`更新トークン: ${status.hasRefreshToken ? 'あり' : 'なし'}`);

  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  if (!clientId) {
    console.log('GOOGLE_CLIENT_ID が未設定です。');
    process.exit(1);
  }

  const provider = new IrisOAuthProvider({
    serverId: SERVER,
    clientId,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET?.trim(),
    redirectUri:
      process.env.IRIS_OAUTH_REDIRECT ?? 'http://localhost:3002/api/mcp/oauth/callback',
    scopes: GOOGLE_MCP_SCOPES[SERVER] ?? [],
    store,
  });

  const mcp = new McpClientService([
    {
      id: SERVER,
      url: 'https://calendarmcp.googleapis.com/mcp/v1',
      authProvider: provider,
      readOnlyTools: ['list_events', 'get_event', 'list_calendars', 'search_events'],
    },
  ]);

  const [connection] = await mcp.connectAll();
  if (!connection.connected) {
    console.log(`\n接続できません: ${connection.error}`);
    process.exit(1);
  }
  console.log(`\n接続 OK — ツール ${connection.toolCount} 件`);

  const tools = mcp.asIrisTools();
  const listCalendars = tools.find((t) => t.name === `mcp__${SERVER}__list_calendars`);
  if (!listCalendars) {
    console.log('list_calendars が見つかりません。');
    await mcp.close();
    process.exit(1);
  }

  // Only a READ tool is called here, and deliberately so. A verification
  // script that writes to prove it can write has changed the thing it was
  // checking.
  if (listCalendars.riskLevel !== RiskLevel.READ) {
    console.log(`list_calendars が READ ではありません (${listCalendars.riskLevel})。中止します。`);
    await mcp.close();
    process.exit(1);
  }

  const result: any = await listCalendars.execute({});

  // MCP reports a failed tool call inside a 200 response, as content with
  // `isError` set. A check that only looks at whether bytes came back will
  // call "The caller does not have permission" a success — which this script
  // did, and which is exactly the kind of green light that is worse than no
  // check at all.
  if (result?.isError) {
    const why = (result?.content ?? [])
      .filter((c: any) => c.type === 'text')
      .map((c: any) => c.text)
      .join(' ');
    console.log(`\nツール呼び出しが失敗しました: ${why}`);
    await mcp.close();
    process.exit(1);
  }

  const text = (result?.content ?? [])
    .filter((c: any) => c.type === 'text')
    .map((c: any) => c.text)
    .join('\n');

  // Names only. The point is that the credential works, and the calendar
  // contents are not this script's business.
  let names: string[] = [];
  try {
    const parsed = JSON.parse(text);
    const items = parsed?.calendars ?? parsed?.items ?? (Array.isArray(parsed) ? parsed : []);
    names = items.map((c: any) => c.summary ?? c.name ?? c.id).filter(Boolean);
  } catch {
    names = [];
  }

  if (names.length > 0) {
    console.log(`カレンダー ${names.length} 件:`);
    for (const n of names) console.log(`  - ${n}`);
  } else {
    console.log(`応答 (${text.length} 文字) を受信しました。`);
  }

  console.log('\n往復を確認しました。');
  await mcp.close();
}

main().catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
