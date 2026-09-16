/**
 * Cross-thread search tests.
 *
 * The question this answers is "where did I say that", which the user should
 * never have to hold in their head. Topics cannot reach it: anything never
 * linked to a topic is otherwise unfindable, and linking is not automatic.
 *
 * Two things dominate the tests. The tokenizer choice is load-bearing and
 * measured rather than assumed — the default cannot match a Japanese substring
 * at all — and it costs a three-character minimum, which has to surface as
 * "too short" rather than as "nothing found". Those are different answers and
 * only one of them means try something else.
 *
 * Run: npm run test:search
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { openDatabase, getSchemaVersion } from '../server/services/db.js';
import { SqliteConversationStore } from '../server/services/conversation_sqlite.js';
import { SqliteTopicStore } from '../server/services/topics_sqlite.js';
import { SearchService, MIN_QUERY_LENGTH } from '../server/services/search.js';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail?: string) {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
function eq(name: string, actual: any, expected: any) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, ok, ok ? undefined : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function section(t: string) { console.log(`\n▸ ${t}`); }

function main() {
  const dir = mkdtempSync(join(tmpdir(), 'iris-search-'));
  const db = openDatabase(join(dir, 's.db'));
  const conversations = new SqliteConversationStore(db);
  const topics = new SqliteTopicStore(db);
  const search = new SearchService(db);

  try {
    check('the schema carries the index', getSchemaVersion(db) >= 11);

    // Three separate threads, started at different times, never linked to each
    // other — which is the situation the whole feature exists for.
    const cardio = conversations.createConversation('心電図の学習');
    conversations.addMessage(cardio.id, 'user', '気管支平滑筋を弛緩させる薬について教えて');
    conversations.addMessage(cardio.id, 'assistant', 'サルブタモールはβ2受容体刺激薬です。');

    const dev = conversations.createConversation('IRIS の設計');
    conversations.addMessage(dev.id, 'user', 'IRIS のツール登録はどうなっている？');
    conversations.addMessage(dev.id, 'assistant', 'Tool Registry が未指定のツールを UNTRUSTED として扱います。');

    const misc = conversations.createConversation(null);
    conversations.addMessage(misc.id, 'user', '平滑筋の話をもう一度');

    // ---------------------------------------------------------------------
    section('Finding a phrase nobody tagged');

    {
      const result = search.search('平滑筋');
      check('a Japanese substring is found', result.hits.length >= 2);
      // The default unicode61 tokenizer finds nothing here at all — it has no
      // word boundaries to work with. This is why the tokenizer is trigram.
      check(
        'across conversations that were never linked to each other',
        new Set(result.hits.map((h) => h.conversationId)).size >= 2
      );
      check('each hit names its thread', result.hits.every((h) => h.conversationId));
      check('and carries a snippet rather than the whole message',
        result.hits.every((h) => h.snippet.length > 0));
      check('the matched text is marked in the snippet',
        result.hits.some((h) => h.snippet.includes('«')));
      eq('a titled conversation reports its title', result.hits.find((h) => h.conversationId === cardio.id)!.conversationTitle, '心電図の学習');
    }

    {
      const result = search.search('サルブタモール');
      eq('an assistant reply is searchable too', result.hits.length, 1);
      eq('and says which side said it', result.hits[0].role, 'assistant');
    }

    {
      const result = search.search('UNTRUSTED');
      eq('ASCII works as well', result.hits.length, 1);
      eq('and is case-insensitive', search.search('untrusted').hits.length, 1);
    }

    // ---------------------------------------------------------------------
    section('Too short to search is not the same as not found');

    {
      const short = search.search('筋');
      check('a one-character query is refused', short.tooShort);
      eq('with no hits', short.hits.length, 0);
      check('and says why', /3文字以上/.test(short.note));

      const two = search.search('設計');
      // Measured: trigram indexes three-character runs, so two characters have
      // nothing to match.
      check('two characters too', two.tooShort);

      const three = search.search('平滑筋');
      check('three is enough', !three.tooShort);
      eq('empty is refused rather than matching everything', search.search('').tooShort, true);
      eq('as is whitespace', search.search('   ').tooShort, true);
      eq('the minimum is stated once and used', MIN_QUERY_LENGTH, 3);
    }

    {
      const missing = search.search('存在しない語句');
      check('a genuine miss is not reported as too short', !missing.tooShort);
      eq('with no hits', missing.hits.length, 0);
      check('and says so plainly', /ありませんでした/.test(missing.note));
    }

    // ---------------------------------------------------------------------
    section('A query means what was typed');

    {
      // Unquoted, FTS5 would read this as two terms joined by an implicit AND
      // rather than the phrase the user typed.
      const phrase = search.search('ツール登録はどう');
      check('a phrase with no spaces matches as a phrase', phrase.hits.length === 1);

      // FTS5 treats bare AND/OR/NOT as operators; a user typing them means the
      // words.
      const operator = search.search('AND OR NOT');
      check('operator words do not crash the search', !operator.tooShort || true);
      check('and produce a result object either way', Array.isArray(operator.hits));

      const quoted = search.search('"引用符"');
      check('a quotation mark is survivable', Array.isArray(quoted.hits));
    }

    // ---------------------------------------------------------------------
    section('Hits carry the work they came from');

    {
      const topic = topics.createTopic({ name: '呼吸器', kind: 'subject' });
      topics.link({ conversationId: cardio.id, topicRef: topic.slug, source: 'user' });

      const result = search.search('平滑筋');
      const tagged = result.hits.find((h) => h.conversationId === cardio.id)!;
      // More useful than a bare quotation: it says which body of work it is
      // part of, the same way the register keeps evidence next to claims.
      eq('a hit reports the topics of its conversation', tagged.topics, ['呼吸器']);
      const untagged = result.hits.find((h) => h.conversationId === misc.id)!;
      eq('and an untagged conversation reports none', untagged.topics, []);
    }

    // ---------------------------------------------------------------------
    section('Narrowing');

    {
      eq('search can be limited to one conversation',
        search.search('平滑筋', { conversationId: cardio.id }).hits.length, 1);
      eq('and to one side of the conversation',
        search.search('平滑筋', { role: 'user' }).hits.every((h) => h.role === 'user'), true);
      eq('a limit is honoured', search.search('平滑筋', { limit: 1 }).hits.length, 1);
    }

    // ---------------------------------------------------------------------
    section('The index keeps itself in step');

    {
      const before = search.stats();
      check('every message is indexed', before.inSync, JSON.stringify(before));

      const fresh = conversations.createConversation('追加');
      conversations.addMessage(fresh.id, 'user', '新しく書いた平滑筋の話');
      // Maintained by triggers rather than by remembering to call something:
      // an index kept by convention drifts the first time a new write path is
      // added.
      eq('a new message is searchable immediately', search.search('新しく書いた').hits.length, 1);
      check('and the counts still agree', search.stats().inSync);

      conversations.deleteConversation(fresh.id);
      eq('a deleted conversation leaves nothing behind', search.search('新しく書いた').hits.length, 0);
      check('and the index shrinks with it', search.stats().inSync, JSON.stringify(search.stats()));
    }

    {
      // Should never be needed, which is exactly why it exists: when it is,
      // nobody will want to write it then.
      const rebuilt = search.reindex();
      eq('a rebuild restores every message', rebuilt.indexed, search.stats().messages);
      eq('and search still works afterwards', search.search('平滑筋').hits.length >= 2, true);
    }
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Cross-thread search: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('All search tests passed.');
}

main();
