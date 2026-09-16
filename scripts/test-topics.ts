/**
 * Topic tests.
 *
 * The point of topics is that they span threads — a conversation list cannot
 * answer "show me everything about this work" when the work is scattered
 * across six threads started weeks apart (decision 8.3). So the assertions
 * here are mostly about the cross-thread view, and about provenance: a string
 * match and a person saying so must never be stored as the same claim.
 *
 * Run: npm run test:topics
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { openDatabase } from '../server/services/db.js';
import { SqliteConversationStore } from '../server/services/conversation_sqlite.js';
import { SqliteActivityLogStore } from '../server/services/activity_log_sqlite.js';
import { SqliteTopicStore, suggestTopics, toSlug, TopicNotFoundError } from '../server/services/topics_sqlite.js';
import { TopicService } from '../server/core/topic_service.js';
import { createTopicTools } from '../server/tools/topics.js';
import { RiskLevel } from '../server/core/types.js';

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
    check(name, matcher ? matcher(err) : true, `unexpected: ${err?.name}: ${err?.message}`);
  }
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'iris-topics-'));
  const db = openDatabase(join(dir, 't.db'));
  const conversations = new SqliteConversationStore(db);
  const activity = new SqliteActivityLogStore(db);
  const store = new SqliteTopicStore(db);
  const topics = new TopicService(store, conversations, activity);

  try {
    // ---------------------------------------------------------------------
    section('Topics exist independently of any thread');

    const cardiology = topics.createTopic({
      name: '循環器',
      kind: 'subject',
      aliases: ['心臓', 'cardiology', '刺激伝導系'],
      description: '循環器の学習',
    });
    const iris = topics.createTopic({ name: 'IRIS開発', kind: 'project', aliases: ['IRIS'] });

    check('a topic gets a slug', cardiology.slug.length > 0);
    eq('slugs are derived deterministically', toSlug('IRIS開発'), iris.slug);
    eq('aliases are kept', cardiology.aliases.length, 3);
    eq('a new topic is active', cardiology.status, 'active');

    await expectThrows(
      'a duplicate name is refused rather than silently forking the topic',
      () => topics.createTopic({ name: '循環器' }),
      (err) => /既に存在/.test(err.message)
    );
    await expectThrows('an unknown topic is reported', () => topics.getTopic('nope'), (e) => e instanceof TopicNotFoundError);
    await expectThrows('a nameless topic is refused', () => topics.createTopic({ name: '  ' }));

    // ---------------------------------------------------------------------
    section('One conversation, several topics; one topic, several threads');

    const c1 = conversations.createConversation('心電図の読み方');
    const c2 = conversations.createConversation('IRIS のツール設計');
    const c3 = conversations.createConversation('医療AIのアイデア');

    topics.link({ conversationId: c1.id, topicRef: cardiology.slug, source: 'user' });
    topics.link({ conversationId: c2.id, topicRef: iris.slug, source: 'user' });
    // A conversation genuinely about two things is linked to both (§8.13).
    topics.link({ conversationId: c3.id, topicRef: cardiology.slug, source: 'model' });
    topics.link({ conversationId: c3.id, topicRef: iris.slug, source: 'model' });

    eq('a conversation can belong to several topics', topics.topicsForConversation(c3.id).length, 2);

    const detail = topics.getTopic(cardiology.slug);
    eq('a topic gathers threads that were never linked to each other', detail.conversations.length, 2);
    check(
      'and they are genuinely separate conversations',
      new Set(detail.conversations.map((c) => c.conversationId)).size === 2
    );

    const listed = topics.listTopics();
    eq('listing counts conversations per topic', listed.find((t) => t.slug === cardiology.slug)?.conversationCount, 2);

    // ---------------------------------------------------------------------
    section('Provenance: a guess and a fact are not the same claim');

    const heuristic = topics.link({
      conversationId: c1.id,
      topicRef: iris.slug,
      source: 'heuristic',
      confidence: 0.4,
      evidence: '「IRIS」に一致',
    });
    eq('a heuristic link records its source', heuristic.source, 'heuristic');
    check('and does not claim certainty', heuristic.confidence < 0.5);
    eq('the evidence is kept', heuristic.evidence, '「IRIS」に一致');

    const userLink = topics.topicsForConversation(c1.id).find((t) => t.slug === cardiology.slug)!.link;
    eq('a person saying so is recorded as certain', userLink.confidence, 1);
    eq('and attributed to the user', userLink.source, 'user');

    // A person confirming a guess should upgrade it, not be rejected as a dup.
    const upgraded = topics.link({ conversationId: c1.id, topicRef: iris.slug, source: 'user' });
    eq('a person confirming a guess upgrades the link', upgraded.source, 'user');
    eq('and raises its confidence', upgraded.confidence, 1);

    // The reverse must not happen, or every later turn would erase a correction.
    topics.link({ conversationId: c1.id, topicRef: iris.slug, source: 'heuristic', confidence: 0.4 });
    const afterHeuristic = topics.topicsForConversation(c1.id).find((t) => t.slug === iris.slug)!.link;
    eq('a later guess does not downgrade a human decision', afterHeuristic.source, 'user');
    eq('nor lower its confidence', afterHeuristic.confidence, 1);

    // ---------------------------------------------------------------------
    section('Suggestion is free, deterministic, and never stated as fact');

    const all = store.listTopics();
    const hits = suggestTopics('今日は心臓の刺激伝導系について整理したい', all);
    check('a topic is recognised by an alias', hits.some((h) => h.topic.slug === cardiology.slug));
    check('suggestions never claim certainty', hits.every((h) => h.confidence <= 0.6));
    check('each suggestion carries its evidence', hits.every((h) => h.evidence.length > 0));

    eq('unrelated text suggests nothing', suggestTopics('今日の天気はどうですか', all).length, 0);

    const archived = topics.createTopic({ name: '旧プロジェクト', aliases: ['心臓'] });
    topics.updateTopic(archived.slug, { status: 'archived' });
    const afterArchive = suggestTopics('心臓について', store.listTopics());
    check(
      'an archived topic stops being suggested',
      !afterArchive.some((h) => h.topic.slug === archived.slug)
    );

    // ---------------------------------------------------------------------
    section('Automatic association');

    const c4 = conversations.createConversation(null);
    const created = topics.autoAssociate(c4.id, 'IRIS のツール設計を続けたい');
    check('a mentioned topic is linked automatically', created.length >= 1);
    check('automatically created links are marked heuristic', created.every((l) => l.source === 'heuristic'));
    check('and stay below certainty', created.every((l) => l.confidence < 0.7));

    eq('text mentioning nothing links nothing', topics.autoAssociate(c4.id, 'こんにちは').length, 0);
    eq('empty text is a no-op', topics.autoAssociate(c4.id, '   ').length, 0);

    // Running again must not undo a correction made in between.
    topics.link({ conversationId: c4.id, topicRef: iris.slug, source: 'user' });
    topics.autoAssociate(c4.id, 'IRIS の話');
    eq(
      'auto-association never overwrites a human decision',
      topics.topicsForConversation(c4.id).find((t) => t.slug === iris.slug)!.link.source,
      'user'
    );

    // ---------------------------------------------------------------------
    section('Deletion is explicit, and scoped');

    const conversationsBefore = conversations.listConversations().length;
    topics.deleteTopic(archived.slug);
    check('the topic is gone', store.getBySlug(archived.slug) === null);
    eq('deleting a topic does not delete conversations', conversations.listConversations().length, conversationsBefore);

    // A deleted conversation takes its links with it, not the topic.
    conversations.deleteConversation(c3.id);
    eq(
      'deleting a conversation removes only its links',
      topics.getTopic(cardiology.slug).conversations.length,
      1
    );
    check('the topic itself survives', store.getBySlug(cardiology.slug) !== null);

    // ---------------------------------------------------------------------
    section('Tools');

    const tools = new Map(createTopicTools(topics).map((t) => [t.name, t]));
    eq('listing topics is READ', tools.get('list_topics')!.riskLevel, RiskLevel.READ);
    eq('suggesting is READ', tools.get('suggest_topics_for_text')!.riskLevel, RiskLevel.READ);
    eq('creating a topic requires approval', tools.get('create_topic')!.riskLevel, RiskLevel.WRITE);
    eq('linking requires approval', tools.get('link_conversation_to_topic')!.riskLevel, RiskLevel.WRITE);

    const viaTool: any = await tools.get('get_topic')!.execute({ topic: cardiology.slug });
    check('the tool exposes how each link was made', viaTool.conversations.every((c: any) => c.linkedBy));
    check('and its confidence', viaTool.conversations.every((c: any) => typeof c.confidence === 'number'));

    const suggested: any = await tools.get('suggest_topics_for_text')!.execute({ text: 'IRIS の設計' });
    check('the suggestion tool states these are not certain', /確定ではありません/.test(suggested.note));

    const linked: any = await tools.get('link_conversation_to_topic')!.execute({
      conversationId: c2.id,
      topic: cardiology.slug,
      reason: '医療AIの文脈で言及',
    });
    eq('a model-made link is attributed to the model', linked.source, 'model');
    check('with confidence between a guess and a fact', linked.confidence > 0.5 && linked.confidence < 1);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Topics: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('All topic tests passed.');
}

main().catch((err) => {
  console.error('\nTest harness crashed:', err);
  process.exit(1);
});
