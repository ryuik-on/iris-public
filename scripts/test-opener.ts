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
import { openerFor, bundleOpener, planOpeners, OPENED_BY_IRIS_NOTE } from '../server/core/opener.js';
import { ContextEngine } from '../server/core/context_engine.js';
import { ProactiveService } from '../server/core/proactive_service.js';
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

  // 返事をした会話に IRIS がもう一言足したら、その一言は返事待ち。
  conversations.addMessage(c.id, 'assistant', '続きです');
  store.record({
    key: 'later', conversationId: c.id, ruleId: 'watch.deadline-pressing', suggestionId: 'y',
    createdAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const rows = store.recent();
  eq('足した一言は、返事待ちに戻る', rows[0].key === 'later' && rows[0].replied, false);
  eq('前の一言は、返事済みのまま', rows.find((r) => r.key === o.key)?.replied, true);

  // 既読：開いたら外れる。会話は残る。
  const fresh = conversations.createConversation('別の知らせ');
  conversations.addMessage(fresh.id, 'assistant', '別の一言');
  store.record({ key: 'other', conversationId: fresh.id, ruleId: 'watch.deadline-pressing', suggestionId: 'z', createdAt: new Date(Date.now() + 120_000).toISOString() });
  eq('a new notice starts unread', store.recent().find((r) => r.key === 'other')?.read, false);
  eq('marking one read touches only that conversation', store.markRead(fresh.id), 1);
  eq('and it reads as read', store.recent().find((r) => r.key === 'other')?.read, true);
  eq('marking it again changes nothing', store.markRead(fresh.id), 0);
  eq('another conversation was left unread', store.recent().find((r) => r.key === 'later')?.read, false);
  eq('mark-all reads the rest', store.markAllRead() >= 1 && store.recent().every((r) => r.read), true);
  eq('read is separate from replied', store.recent().find((r) => r.key === 'other')?.replied, false);

  conversations.deleteConversation(c.id);
  eq('会話を消したら一覧からは消える', store.recent().filter((r) => r.key !== 'other').length, 0);
  eq('でも鍵は残る（消したのは「要らない」という返事）', store.has(o.key), true);
}

section('同じ規則の返事待ちは一本');
{
  // index.ts の speakFirst と同じ手順を、控えと会話の店で回す。
  const db = openDatabase(':memory:', { wal: false });
  const conversations = new SqliteConversationStore(db);
  const store = new ProactiveOpenerStore(db);
  const days = (n: number) => [{
    kind: 'deadline.pressing', value: [`T005 論文リスト（あと${n}日）`],
    source: 'iris.watch', confidence: 1, calibrated: true, ageMs: 0,
  }];
  const cycle = (s: ProactiveSuggestion[], when: Date) => {
    const plan = planOpeners(s, store, when);
    for (const r of plan.refreshed) {
      conversations.addMessage(r.conversationId, 'assistant', r.opener.text);
      store.refresh(r.previousKey, { key: r.opener.key, suggestionId: r.suggestion.id, createdAt: when.toISOString() });
    }
    if (plan.bundle) {
      const c = conversations.createConversation(plan.bundle.title);
      conversations.addMessage(c.id, 'assistant', plan.bundle.text);
      for (const f of plan.fresh) store.record({ key: f.opener.key, conversationId: c.id, ruleId: f.suggestion.ruleId, suggestionId: f.suggestion.id, createdAt: when.toISOString() });
    }
    return plan;
  };
  const waitingRows = (ruleId: string) => store.recent(100).filter((o) => o.ruleId === ruleId && !o.replied);
  const conversationsOf = (ruleId: string) => new Set(waitingRows(ruleId).map((o) => o.conversationId)).size;

  const d1 = new Date(2026, 9, 1, 9, 0);
  const first = cycle([suggestion({ id: 'a:1', because: days(3) })], d1);
  eq('一回目は新しく開く', first.fresh.length, 1);

  const again = cycle([suggestion({ id: 'a:2', because: days(3) })], new Date(2026, 9, 1, 15, 0));
  eq('同じ規則・同じ根拠・同じ日なら、二度目は何もしない', again.repeated.length, 1);
  eq('会話は一本のまま', conversations.listConversations().length, 1);

  const sameDay = cycle([suggestion({ id: 'a:3', because: days(2) })], new Date(2026, 9, 1, 18, 0));
  eq('根拠が変わっても、開いて 24 時間以内なら待つ', sameDay.held.length, 1);
  eq('まだ一本', conversations.listConversations().length, 1);

  for (const [n, day] of [[2, 2], [1, 3], [0, 4]] as const) {
    const p = cycle([suggestion({ id: `a:d${day}`, because: days(n) })], new Date(2026, 9, day, 10, 0));
    eq(`${day} 日目（あと${n}日）は、前の会話に書き足す`, p.refreshed.length === 1 && p.fresh.length === 0, true);
  }
  eq('返事をしないまま日数が進んでも、会話は一本', conversations.listConversations().length, 1);
  eq('その規則の返事待ちの控えは一件', waitingRows('watch.deadline-pressing').length, 1);
  eq('返事待ちの会話も一本', conversationsOf('watch.deadline-pressing'), 1);
  const [only] = store.recent();
  eq('書き足したものは、もう一度未読になる', only.read, false);
  const messages = conversations.listMessages(only.conversationId);
  eq('最新の根拠が会話の最後にある', messages.at(-1)?.content.includes('あと0日'), true);
  eq('付け替えた鍵を覚えている（同じ日・同じ根拠はもう言わない）', cycle([suggestion({ id: 'a:x', because: days(0) })], new Date(2026, 9, 4, 20, 0)).repeated.length, 1);

  // 返事をもらえば、次は新しく話してよい。
  conversations.addMessage(only.conversationId, 'user', 'やります');
  const after = cycle([suggestion({ id: 'a:y', because: days(5) })], new Date(2026, 9, 6, 9, 0));
  eq('返事があった規則は、次に新しく開く', after.fresh.length, 1);
  eq('それでも返事待ちは一本', waitingRows('watch.deadline-pressing').length, 1);

  // 消された会話には書き足さない（消したのは「要らない」という返事）。
  const waiting = store.waitingFor('watch.deadline-pressing')!;
  conversations.deleteConversation(waiting.conversationId);
  eq('消された会話は返事待ちに数えない', store.waitingFor('watch.deadline-pressing'), undefined);
}

section('同じ巡回で出たものは一本にまとめる');
{
  const db = openDatabase(':memory:', { wal: false });
  const conversations = new SqliteConversationStore(db);
  const store = new ProactiveOpenerStore(db);
  const fired = [
    suggestion({ id: 'watch.deadline-pressing:1' }),
    suggestion({ id: 'watch.grant-dead:2', ruleId: 'watch.grant-dead', suggestion: 'カレンダーの認可が切れています。', because: [{ kind: 'grant.dead', value: 'Google カレンダー', source: 'iris.watch', confidence: 1, calibrated: true, ageMs: 0 }] }),
    suggestion({ id: 'watch.lectures-divergent:3', ruleId: 'watch.lectures-divergent', suggestion: '講義日程表とカレンダーが食い違っています。見ますか。', because: [{ kind: 'lectures.divergent', value: 76, source: 'iris.watch', confidence: 1, calibrated: true, ageMs: 0 }] }),
  ];
  const plan = planOpeners(fired, store, at);
  eq('三件とも新しい', plan.fresh.length, 3);
  const b = plan.bundle!;
  eq('一本の最初の一言に件数', b.text.startsWith('気になることが 3 件あります。'), true);
  eq('項目を順に並べる', ['1. 期限が迫って', '2. カレンダーの認可', '3. 講義日程表'].every((h) => b.text.includes(h)), true);
  eq('根拠の行も項目の下に', b.text.includes('   - T011 GCI ベーシック（遅延・13日超過）') && b.text.includes('   - Google カレンダー'), true);
  eq('問いは最後に一つ', b.text.trim().endsWith('そう言ってください。'), true);
  eq('数は行にしない', b.text.includes('76'), false);
  eq('題は一行に収まる', b.title.length <= 24, true);
  eq('一件ならいつもの一言', bundleOpener([fired[0]], at).text, openerFor(fired[0], at).text);

  // speakFirst と同じく、会話は一本、控えは規則ごとにその会話へ。
  const c = conversations.createConversation(b.title);
  conversations.addMessage(c.id, 'assistant', b.text);
  for (const f of plan.fresh) store.record({ key: f.opener.key, conversationId: c.id, ruleId: f.suggestion.ruleId, suggestionId: f.suggestion.id, createdAt: at.toISOString() });
  eq('会話は一本', conversations.listConversations().length, 1);
  eq('三つの規則の控えが同じ会話を指す', new Set(store.recent().map((o) => o.conversationId)).size, 1);
  const twice = planOpeners(fired, store, new Date(at.getTime() + 60_000));
  eq('同じ巡回をもう一度回しても、何も開かない', twice.repeated.length === 3 && twice.bundle === null, true);
}

section('見回りは発火したものをまとめて渡す');
{
  const context = new ContextEngine();
  context.registerSource({ id: 'test', label: 'テスト', calibration: 'calibrated' });
  for (const kind of ['a.kind', 'b.kind', 'c.kind']) context.registerKind({ kind, description: kind, validForMs: 3_600_000 });
  const seen: string[][] = [];
  const service = new ProactiveService(context, { onCycle: (f) => seen.push(f.map((s) => s.ruleId)) });
  context.observe({ kind: 'a.kind', value: true, source: 'test', confidence: 1 });
  context.observe({ kind: 'b.kind', value: true, source: 'test', confidence: 1 });
  service.addRule({ id: 'rule.a', description: '', conditions: [{ kind: 'a.kind', minConfidence: 0 }], suggestion: 'A です。', cooldownMs: 60_000 });
  service.addRule({ id: 'rule.b', description: '', conditions: [{ kind: 'b.kind', minConfidence: 0 }], suggestion: 'B です。', cooldownMs: 60_000 });
  service.addRule({ id: 'rule.c', description: '', conditions: [{ kind: 'c.kind', minConfidence: 0 }], suggestion: 'C です。', cooldownMs: 60_000 });
  service.evaluate();
  eq('一度の見回りで一回、発火した二件を一緒に', seen, [['rule.a', 'rule.b']]);
  service.evaluate();
  eq('何も発火しない見回りでは呼ばない', seen.length, 1);
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
