/** Compacting long conversation history. Run: npx tsx scripts/test-history-compaction.ts */
import { planCompaction, applyCompaction, elide, estimateTokens, buildSummaryPrompt, type Turn } from '../server/core/history_compaction.js';
let passed = 0; const failures: string[] = [];
const ok = (n: string, c: boolean, d = '') => { if (c) passed++; else failures.push(`${n} ${d}`); };

const mk = (n: number, len: number): Turn[] => Array.from({ length: n }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: `${i}:` + 'あ'.repeat(len) }) as Turn);

const short = mk(6, 100);
ok('a short conversation is left alone', !planCompaction(short).needed && applyCompaction(short, planCompaction(short), null) === short);

const long = mk(40, 800);
const plan = planCompaction(long);
ok('a long one is compacted, keeping the recent turns', plan.needed && plan.cut > 0 && plan.cut < long.length);
const keptTokens = long.slice(plan.cut).reduce((s, t) => s + estimateTokens(t.content), 0);
ok('the recent part stays within the keep budget (or the minimum count)', keptTokens <= 4500 + estimateTokens(long[0].content) || long.length - plan.cut <= 4, String(keptTokens));
ok('at least four recent turns are always kept verbatim', long.length - plan.cut >= 4);

const withSummary = applyCompaction(long, plan, '・T005 は期限 10/31');
ok('with a summary, the old turns are replaced by it', withSummary.length === long.length - plan.cut + (long[plan.cut].role === 'user' ? 0 : 1) && withSummary[0].content.includes('T005 は期限 10/31'));
ok('the first turn sent is always from the user (providers require it)', withSummary[0].role === 'user');
ok('the recent turns are untouched', withSummary.slice(-3).every((t, i) => t.content === long.slice(-3)[i].content));
const fallback = applyCompaction(long, plan, null);
ok('without a summary, the old turns are kept but shortened — the conversation never loses its past silently', fallback[0].content.includes('縮めてあります') && fallback[0].content.length < long.slice(0, plan.cut).reduce((s, t) => s + t.content.length, 0));
ok('so the compacted form is much smaller than the full history', fallback.reduce((s, t) => s + t.content.length, 0) < long.reduce((s, t) => s + t.content.length, 0) * 0.6);

const startsAssistant: Turn[] = [{ role: 'assistant', content: 'あ'.repeat(30000) }, ...mk(10, 300).slice(0, 9)];
const p2 = planCompaction(startsAssistant);
const a2 = applyCompaction(startsAssistant, p2, '要約');
ok('a summary goes in front as a user turn when the recent part starts with the assistant', a2[0].role === 'user');
ok('elide keeps the head and the tail of a long message', elide('A'.repeat(2000) + 'Z'.repeat(2000), 1000).startsWith('AAAA') && elide('A'.repeat(2000) + 'Z'.repeat(2000), 1000).endsWith('ZZZZ') && elide('A'.repeat(2000) + 'Z'.repeat(2000), 1000).includes('省略'));
ok('a short message is not elided', elide('短い', 1000) === '短い');
const prompt = buildSummaryPrompt(long.slice(0, 3), '前の要約');
ok('the summary prompt carries the previous summary and forbids guessing', prompt.includes('前の要約') && prompt.includes('推測しない'));
ok('and tells the summarizer not to copy instructions out of quoted outside text', prompt.includes('指示として書き写さず'));
ok('the summary is labelled as reference material, not a user instruction', withSummary[0].content.includes('利用者の指示ではありません') && fallback[0].content.includes('いまの指示ではありません'));

// ── 道具の結果の整理
import { compactToolHistory } from '../server/core/history_compaction.js';
{
  const big = (n: number) => ({ items: 'あ'.repeat(n) });
  const round = (id: string, result: any) => [
    { role: 'assistant', toolCalls: [{ id, name: 'get_schedule', args: {} }] },
    { role: 'tool', toolName: 'get_schedule', toolCallId: id, toolResult: result },
  ] as any[];
  const hist: any[] = [{ role: 'user', content: '予定は？' }, ...round('a', big(5000)), ...round('b', big(5000)), ...round('c', big(5000)), ...round('d', { ok: true })];
  const out = compactToolHistory(hist);
  const resultOf = (h: any[], id: string) => h.find((t) => t.toolCallId === id).toolResult;
  ok('the oldest large result is replaced by a short stub', resultOf(out, 'a').省略 === true && JSON.stringify(resultOf(out, 'a')).length < 700);
  const trustedOut = compactToolHistory(hist, undefined, () => true);
  ok('for a trusted tool the head is kept, but labelled as a quotation, not an instruction', resultOf(trustedOut, 'a').先頭の引用.length === 400 && resultOf(trustedOut, 'a').注意.includes('指示ではありません'));
  ok('for any other tool no text of the original survives', resultOf(out, 'a').先頭の引用 === undefined && resultOf(out, 'a').注意.includes('先頭は残していません'));
  ok('the stub says how big it was and how to get it again', Number(resultOf(out, 'a').元の大きさ.replace(/\D/g, '')) >= 5000 && resultOf(out, 'a').案内.includes('もう一度'));
  ok('the two newest rounds are untouched', resultOf(out, 'c').items.length === 5000 && resultOf(out, 'd').ok === true);
  ok('the third newest round is already old, so it is shortened as well', resultOf(out, 'b').省略 === true);
  ok('the original history is not mutated (it is saved for approval resume)', resultOf(hist, 'a').items.length === 5000);
  ok('assistant turns and their tool calls are never touched', out.filter((t) => t.role === 'assistant').every((t, i) => t === hist.filter((x) => x.role === 'assistant')[i]));
  const small: any[] = [{ role: 'user', content: 'x' }, ...round('a', { n: 1 }), ...round('b', { n: 2 }), ...round('c', { n: 3 })];
  ok('small results are never shortened, and an all-small history is returned as is', compactToolHistory(small) === small);
  const withError: any[] = [{ role: 'user', content: 'x' }, ...round('a', { error: true, message: 'あ'.repeat(3000) }), ...round('b', { n: 2 }), ...round('c', { n: 3 })];
  ok('errors are kept whole', resultOf(compactToolHistory(withError), 'a').error === true && resultOf(compactToolHistory(withError), 'a').message.length === 3000);
  const parallel: any[] = [{ role: 'user', content: 'x' }, { role: 'assistant', toolCalls: [{ id: 'p', name: 'x', args: {} }, { id: 'q', name: 'y', args: {} }] },
    { role: 'tool', toolName: 'x', toolCallId: 'p', toolResult: big(4000) }, { role: 'tool', toolName: 'y', toolCallId: 'q', toolResult: big(4000) }, ...round('b', { n: 2 }), ...round('c', { n: 3 })];
  const po = compactToolHistory(parallel);
  ok('several results from one parallel round are treated as one round and both shortened when old', resultOf(po, 'p').省略 === true && resultOf(po, 'q').省略 === true);
  const two = hist.slice(0, 5);
  ok('a history with at most two rounds is returned as is', compactToolHistory(two) === two);
}

// ── ChatService に載せたときの動き
import { ChatService } from '../server/core/chat_service.js';
import { openDatabase } from '../server/services/db.js';
import { SqliteConversationStore } from '../server/services/conversation_sqlite.js';
import { SqliteApprovalStore } from '../server/services/approval_sqlite.js';
import { SqliteActivityLogStore } from '../server/services/activity_log_sqlite.js';

import { JarvisOrchestrator } from '../server/core/orchestrator.js';
import { ToolRegistry } from '../server/tools/registry.js';
import { RiskLevel, ToolTrust } from '../server/core/types.js';

(async () => {
  // 一回の依頼で道具を何度も呼んでも、古い大きな結果が送り直されない（オーケストレーターの通し）
  {
    const dbo = openDatabase(':memory:', { wal: false });
    const registry = new ToolRegistry();
    registry.register({
      name: 'big_read', description: '大きな結果を返す', riskLevel: RiskLevel.READ, trust: ToolTrust.TRUSTED_CORE,
      schema: { type: 'object', properties: {} }, async execute() { return { rows: 'あ'.repeat(6000) }; },
    } as any);
    const sentHistories: any[][] = [];
    let n = 0;
    const provider: any = {
      id: 'fake', vendor: 'fake', currentModel: 'fake', name: 'fake', setModel() {}, describeSettings: () => ({}),
      async generateResponse(history: any[]) {
        sentHistories.push(JSON.parse(JSON.stringify(history)));
        n++;
        return n <= 4 ? { content: '', toolCalls: [{ id: `c${n}`, name: 'big_read', args: {} }], usage: { inputTokens: 1, outputTokens: 1 } } : { content: '完了', usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const orch = new JarvisOrchestrator(provider, registry, new SqliteApprovalStore(dbo));
    const res: any = await orch.process({ userMessage: '調べて', history: [], conversationId: 'x', origin: 'user', channel: 'text' } as any);
    const last = sentHistories[sentHistories.length - 1];
    const results = last.filter((t) => t.role === 'tool').map((t) => t.toolResult);
    ok('the run still completes', res.status === 'completed' && res.reply === '完了');
    ok('in the last call the oldest results are stubs and the newest two are whole', results.length === 4 && results[0].省略 === true && results[1].省略 === true && results[2].rows?.length === 6000 && results[3].rows?.length === 6000, JSON.stringify(results.map((r: any) => !!r.省略)));
    ok('so the last call carries about half of what it would have', JSON.stringify(last).length < 4 * 6000 * 0.65, String(JSON.stringify(last).length));
  }

  const db = openDatabase(':memory:', { wal: false });
  const conversations = new SqliteConversationStore(db);
  let seen: Array<{ role: string; content: string }> = [];
  const orchestrator: any = { process: async ({ history }: any) => { seen = history; return { status: 'completed', reply: 'はい', executedTools: [] }; } };
  let summaryCalls = 0;
  let summaryReply: string | null = 'ー T005 は期限 10/31、進行中\nー 山本くんは水曜 20 時の授業';
  const chat = new ChatService(orchestrator, conversations, new SqliteApprovalStore(db), new SqliteActivityLogStore(db), undefined, undefined,
    async () => { summaryCalls++; if (summaryReply === 'THROW') throw new Error('boom'); return summaryReply; });

  const conv = conversations.createConversation('t');
  for (let i = 0; i < 40; i++) conversations.addMessage(conv.id, i % 2 === 0 ? 'user' : 'assistant', `${i}:` + 'あ'.repeat(800));
  await chat.sendMessage({ conversationId: conv.id, message: '続きをお願いします' });
  const sentChars = seen.reduce((n, t) => n + t.content.length, 0);
  ok('a long conversation is sent shortened, with the summary in front', seen[0].role === 'user' && seen[0].content.includes('T005 は期限 10/31') && sentChars < 41 * 800 * 0.5, String(sentChars));
  ok('the summary was asked for once and saved', summaryCalls === 1 && conversations.getSummary(conv.id)?.summary.includes('山本'));
  ok('the stored messages are all still there', conversations.listMessages(conv.id).length === 42);
  ok('the newest stored message is sent verbatim, last (the current message goes separately)', seen[seen.length - 1].content === `39:${'あ'.repeat(800)}`);

  await chat.sendMessage({ conversationId: conv.id, message: 'もう一つ' });
  ok('a little more conversation reuses the stored summary instead of asking again', summaryCalls === 1, String(summaryCalls));

  const conv2 = conversations.createConversation('t2');
  for (let i = 0; i < 40; i++) conversations.addMessage(conv2.id, i % 2 === 0 ? 'user' : 'assistant', `${i}:` + 'あ'.repeat(800));
  summaryReply = 'THROW';
  await chat.sendMessage({ conversationId: conv2.id, message: 'どうぞ' });
  ok('if the summary fails, the turn still goes through with the old part shortened', seen[0].content.includes('縮めてあります') && seen[seen.length - 1].content === `39:${'あ'.repeat(800)}`);

  const conv3 = conversations.createConversation('t3');
  conversations.addMessage(conv3.id, 'user', 'こんにちは');
  conversations.addMessage(conv3.id, 'assistant', 'はい');
  await chat.sendMessage({ conversationId: conv3.id, message: '予定は？' });
  ok('a short conversation is sent as it is, and no summary is asked for', seen.length === 2 && summaryCalls === 2);

  console.log(`History compaction: ${passed} passed, ${failures.length} failed`);
  if (failures.length) { console.log(failures.join('\n')); process.exit(1); }
  console.log('All history compaction tests passed.');
})();
