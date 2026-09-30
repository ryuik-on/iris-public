/**
 * IRIS が先に話しかける。
 *
 * 確かめたいのは三つ。**答えられる問いで終わること**（「〜があります。」で
 * 止まると、話しかけたことにならない）。**同じ話を二度始めないこと**（規則の
 * 冷却は再起動で消える）。**最初が IRIS の会話を模型に渡せること**（提供者は
 * 最初の発言が利用者であることを求める）。
 *
 * Run: npx tsx scripts/test-opener.ts
 */
import { openerFor, OPENED_BY_IRIS_NOTE } from '../server/core/opener.js';
import { openDatabase } from '../server/services/db.js';
import { ProactiveOpenerStore } from '../server/services/proactive_openers_sqlite.js';
import { SqliteConversationStore } from '../server/services/conversation_sqlite.js';
import { ChatService } from '../server/core/chat_service.js';
import type { ProactiveSuggestion } from '../server/core/proactive_service.js';

let passed = 0, failed = 0;
const failures: string[] = [];
function section(n: string) { console.log(`\n▸ ${n}`); }
function eq(n: string, a: any, b: any) {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (ok) { passed++; console.log(`  ✓ ${n}`); }
  else { failed++; failures.push(`${n}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`); console.log(`  ✗ ${n}`); }
}

const suggestion = (over: Partial<ProactiveSuggestion> = {}): ProactiveSuggestion => ({
  id: 'watch.deadline-pressing:1',
  ruleId: 'watch.deadline-pressing',
  suggestion: '期限が迫っている、または過ぎている課題があります。',
  prompt: null,
  createdAt: '2026-09-30T04:37:50.763Z',
  because: [{
    kind: 'deadline.pressing',
    value: ['T011 GCI ベーシック（遅延・13日超過）', 'T005 論文リスト（期限間近・今日）'],
    source: 'iris.watch', confidence: 1, calibrated: true, ageMs: 0,
  }],
  ...over,
});
const at = new Date(2026, 8, 30, 13, 40);

section('話しかける文');
{
  const o = openerFor(suggestion(), at);
  eq('提案の文から始まる', o.text.startsWith('期限が迫っている'), true);
  eq('根拠の中身を並べる（件数では動けない）', o.text.includes('- T011 GCI ベーシック（遅延・13日超過）'), true);
  eq('二件とも', o.text.includes('- T005 論文リスト（期限間近・今日）'), true);
  eq('答えられる問いで終える', o.text.trim().endsWith('そう言ってください。'), true);
}
{
  // 問いで終わっている提案には、問いを重ねない。
  const o = openerFor(suggestion({
    ruleId: 'watch.lectures-divergent',
    suggestion: '講義日程表とカレンダーが食い違っています。見ますか。',
    because: [{ kind: 'lectures.divergent', value: 76, source: 'iris.watch', confidence: 1, calibrated: true, ageMs: 0 }],
  }), at);
  eq('問いで終わる提案はそのまま', o.text, '講義日程表とカレンダーが食い違っています。見ますか。');
  eq('数は行にしない（計器の読みを会話に混ぜない）', o.text.includes('76'), false);
}
{
  const o = openerFor(suggestion({ ruleId: 'watch.other', suggestion: '何かがあります。', because: [] }), at);
  eq('問いの無い提案には既定の問いを添える', o.text, '何かがあります。\n\nどうしますか。');
}
{
  const o = openerFor(suggestion(), at);
  eq('題は一行に収まる長さ', o.title.length <= 24, true);
}

section('同じ話を二度始めない');
{
  const a = openerFor(suggestion(), at);
  const b = openerFor(suggestion({ id: 'watch.deadline-pressing:1' }), new Date(2026, 8, 30, 22, 0));
  eq('同じ規則・同じ根拠・同じ日なら同じ鍵（再起動で番号が戻っても）', a.key, b.key);
  const c = openerFor(suggestion(), new Date(2026, 9, 1, 8, 0));
  eq('日が変われば別の話', a.key !== c.key, true);
  const d = openerFor(suggestion({
    because: [{ kind: 'deadline.pressing', value: ['T011 GCI ベーシック（遅延・13日超過）'], source: 'iris.watch', confidence: 1, calibrated: true, ageMs: 0 }],
  }), at);
  eq('根拠が変われば別の話', a.key !== d.key, true);
}

section('控え');
{
  const db = openDatabase(':memory:', { wal: false });
  const conversations = new SqliteConversationStore(db);
  const store = new ProactiveOpenerStore(db);
  const o = openerFor(suggestion(), at);
  const c = conversations.createConversation(o.title);
  conversations.addMessage(c.id, 'assistant', o.text);
  store.record({ key: o.key, conversationId: c.id, ruleId: 'watch.deadline-pressing', suggestionId: 'x', createdAt: at.toISOString() });

  eq('記録した鍵を覚えている', store.has(o.key), true);
  const [first] = store.recent();
  eq('返事はまだ無い', first.replied, false);
  eq('IRIS の一言を返す', first.text, o.text);
  eq('題も', first.title, o.title);

  conversations.addMessage(c.id, 'user', 'T005 からやる');
  eq('利用者が答えたら、返事ありになる', store.recent()[0].replied, true);

  conversations.deleteConversation(c.id);
  eq('会話を消したら一覧からは消える', store.recent().length, 0);
  eq('でも鍵は残る（消したのは「要らない」という返事）', store.has(o.key), true);
}

section('模型に渡す履歴');
{
  // chat_service の toTurns は private なので、同じ規則を外から確かめる：
  // 最初が assistant の会話に、注記が一つだけ頭に付く。
  const db = openDatabase(':memory:', { wal: false });
  const conversations = new SqliteConversationStore(db);
  const c = conversations.createConversation('t');
  conversations.addMessage(c.id, 'assistant', '期限が迫っています。');
  const service: any = Object.create(ChatService.prototype);
  const turns = service.toTurns(conversations.listMessages(c.id));
  eq('頭に注記が付く', turns[0], { role: 'user', content: OPENED_BY_IRIS_NOTE });
  eq('IRIS の発言はそのまま次に', turns[1], { role: 'assistant', content: '期限が迫っています。' });
  const plain = conversations.createConversation('u');
  conversations.addMessage(plain.id, 'user', 'こんにちは');
  eq('利用者から始まる会話には何も足さない', service.toTurns(conversations.listMessages(plain.id)).length, 1);
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`Opener: ${passed} passed, ${failed} failed`);
if (failed) { console.log('\nFailures:'); for (const f of failures) console.log('  - ' + f); process.exit(1); }
console.log('All opener tests passed.');
