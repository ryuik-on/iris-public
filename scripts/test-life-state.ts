/**
 * Life State tests.
 *
 * The decision this layer records is a negative one: it holds nothing. So the
 * tests are mostly about what must survive being passed through it, and what
 * must not get out.
 *
 * Three properties earn most of the file.
 *
 * `unknown` has to survive. The Context Engine names unobserved kinds
 * explicitly so that silence cannot read as a negative, and a composition
 * layer that returns only what is known would undo that in one line — while
 * looking, in every test that checks the known fields, entirely correct.
 *
 * `local_only` must not get out. This is a new place where memories are
 * gathered into something a model reads, which is exactly the call site
 * memory.ts warns about. It is checked twice: once against the real store, and
 * once against a store that ignores the request, because a boundary that holds
 * only when its input behaves is not a boundary.
 *
 * Per-field confidence must not be averaged. The Context Engine refuses to
 * hand back one number for a 200ms presence reading and a 40-minute-old
 * calendar entry; a layer above it could quietly reintroduce exactly that.
 *
 * Run: npm run test:life-state
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { openDatabase } from '../server/services/db.js';
import { MemoryStore } from '../server/services/memory_sqlite.js';
import { ContextEngine } from '../server/core/context_engine.js';
import { Memory } from '../server/core/memory.js';
import {
  LifeStateService,
  MemoryReader,
  renderLifeState,
  describeAge,
} from '../server/core/life_state.js';

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

const dir = mkdtempSync(join(tmpdir(), 'iris-life-'));

/** A clock the test moves by hand, so age and decay are observed rather than waited for. */
function clock(startMs: number) {
  let t = startMs;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

const T0 = Date.parse('2026-08-20T09:00:00+09:00');

function engineWithKinds(now: () => number): ContextEngine {
  const context = new ContextEngine({ now });
  context.registerSource({ id: 'calendar', label: 'カレンダー', calibration: 'calibrated' });
  context.registerSource({ id: 'speech', label: 'オンデバイス音声', calibration: 'uncalibrated' });
  context.registerSource({ id: 'sensor', label: '試験用センサ', calibration: 'uncalibrated' });
  context.registerKind({ kind: 'calendar.next_event', description: '次の予定', validForMs: 6 * 60 * 60_000 });
  context.registerKind({
    kind: 'presence.occupied',
    description: '人がいるか',
    validForMs: 10 * 60_000,
    halfLifeMs: 5 * 60_000,
  });
  context.registerKind({ kind: 'speech.last_utterance', description: '直近の確定発話', validForMs: 15 * 60_000 });
  return context;
}

/** A store that answers whatever it likes, for testing the layer rather than the store. */
function fakeMemories(rows: Memory[]): MemoryReader {
  return { recall: () => rows };
}

function memory(over: Partial<Memory>): Memory {
  return {
    id: over.id ?? 'm1',
    kind: over.kind ?? 'preference',
    content: over.content ?? 'テスト',
    provenance: over.provenance ?? 'user',
    source: over.source ?? '本人の発言',
    confidence: over.confidence ?? 1,
    retention: over.retention ?? 'durable',
    expiresAt: over.expiresAt ?? null,
    privacy: over.privacy ?? 'shareable',
    evidence: over.evidence ?? [],
    createdAt: over.createdAt ?? new Date(T0).toISOString(),
    supersededBy: over.supersededBy ?? null,
    topicRef: over.topicRef ?? null,
  } as Memory;
}

function main() {
  // -----------------------------------------------------------------------
  section('Nothing observed is not the same as nothing to say');

  {
    const c = clock(T0);
    const context = engineWithKinds(c.now);
    const life = new LifeStateService({ context, memories: fakeMemories([]), now: c.now });
    const state = life.current();

    eq('nothing is currently believed', state.present.length, 0);
    check('and that is stated rather than left to be inferred', state.quiet === true);
    // The whole point. An empty `present` with an empty `unknown` would say
    // "all quiet"; an empty `present` with three named kinds says "nothing has
    // reported", which is a different fact.
    eq('every registered kind is named as unknown', state.unknown.sort(), [
      'calendar.next_event',
      'presence.occupied',
      'speech.last_utterance',
    ]);
    check('the clock still answers', state.clock.epochMs === T0);
  }

  // -----------------------------------------------------------------------
  section('Known and unknown are reported together');

  {
    const c = clock(T0);
    const context = engineWithKinds(c.now);
    context.observe({
      source: 'calendar',
      kind: 'calendar.next_event',
      value: { title: 'そよかぜ書店', start: '2026-08-20T19:30:00+09:00', calendar: '職場' },
      confidence: 1,
      evidence: 'merged / 23件中の先頭',
    });
    const life = new LifeStateService({ context, memories: fakeMemories([]), now: c.now });
    const state = life.current();

    eq('the observed field comes back', state.present.map((f) => f.kind), ['calendar.next_event']);
    // A layer that returned only the known field would pass every assertion
    // above this one.
    eq('and the unobserved kinds are still named', state.unknown.sort(), [
      'presence.occupied',
      'speech.last_utterance',
    ]);
    check('quiet is false once anything is observed', state.quiet === false);
  }

  // -----------------------------------------------------------------------
  section('Each field keeps its own freshness and confidence');

  {
    const c = clock(T0);
    const context = engineWithKinds(c.now);
    context.observe({
      source: 'calendar',
      kind: 'calendar.next_event',
      value: { title: 'そよかぜ書店', start: '2026-08-20T19:30:00+09:00' },
      confidence: 1,
    });
    // Six minutes later: presence is fresh, the calendar entry is not.
    c.advance(6 * 60_000);
    context.observe({ source: 'speech', kind: 'presence.occupied', value: true, confidence: 0.8 });

    const life = new LifeStateService({ context, memories: fakeMemories([]), now: c.now });
    const state = life.current();

    const cal = state.present.find((f) => f.kind === 'calendar.next_event')!;
    const presence = state.present.find((f) => f.kind === 'presence.occupied')!;

    check('the older field carries the larger age', cal.ageMs > presence.ageMs);
    eq('the calendar entry is 6 minutes old', cal.ageMs, 6 * 60_000);
    eq('the presence reading is current', presence.ageMs, 0);
    // Two ages and two confidences, not one of each. Collapsing them is the
    // failure the Context Engine's header describes.
    check('their confidences differ', cal.confidence !== presence.confidence);
    check('the uncalibrated source is capped below what it reported', presence.confidence < 0.8);
    check('and is labelled as uncalibrated', presence.calibrated === false);
    check('the calibrated one is not capped', cal.confidence === 1);

    eq('strongest claim first', state.present[0].kind, 'calendar.next_event');
  }

  // -----------------------------------------------------------------------
  section('Confidence falls with age and never rises');

  {
    const c = clock(T0);
    const context = engineWithKinds(c.now);
    context.observe({ source: 'speech', kind: 'presence.occupied', value: true, confidence: 1 });
    const life = new LifeStateService({ context, memories: fakeMemories([]), now: c.now });

    const fresh = life.current().present.find((f) => f.kind === 'presence.occupied')!;
    c.advance(5 * 60_000); // one half-life
    const aged = life.current().present.find((f) => f.kind === 'presence.occupied')!;

    check('an older reading is a weaker claim', aged.confidence < fresh.confidence);
    check('and says so', aged.decayed === true);

    // Past the validity window it is not low-confidence, it is gone — and the
    // kind returns to being named as unknown rather than reported as false.
    c.advance(10 * 60_000);
    const expired = life.current();
    eq('an expired reading leaves the present', expired.present.length, 0);
    check('and returns to unknown, not to false', expired.unknown.includes('presence.occupied'));
  }

  // -----------------------------------------------------------------------
  section('Disagreement is surfaced, not resolved');

  {
    const c = clock(T0);
    const context = engineWithKinds(c.now);
    context.observe({ source: 'speech', kind: 'presence.occupied', value: true, confidence: 0.9 });
    context.observe({ source: 'sensor', kind: 'presence.occupied', value: false, confidence: 0.5 });

    const life = new LifeStateService({ context, memories: fakeMemories([]), now: c.now });
    const field = life.current().present.find((f) => f.kind === 'presence.occupied')!;

    eq('the strongest claim wins', field.value, true);
    check('the dissenting source is still reported', (field.disagreement ?? []).length === 1);
    eq('with what it actually claimed', field.disagreement![0].value, false);
  }

  // -----------------------------------------------------------------------
  section('What must not leave the machine does not');

  {
    const db = openDatabase(join(dir, 'm.db'));
    const store = new MemoryStore(db);

    store.remember({
      kind: 'preference',
      content: 'Enceladus を選んだ',
      provenance: 'user',
      source: '聴き比べでの本人の選択',
    });
    store.remember({
      kind: 'finance',
      content: '口座残高は 1,234,567 円',
      provenance: 'user',
      source: '本人の申告',
      privacy: 'local_only',
    });

    const c = clock(T0);
    const life = new LifeStateService({ context: engineWithKinds(c.now), memories: store, now: c.now });
    const state = life.current();

    const contents = state.standing.map((m) => m.content);
    check('the shareable memory is carried', contents.includes('Enceladus を選んだ'));
    check('the local_only memory is not', !contents.some((t) => t.includes('1,234,567')));
    eq('and its absence is counted', state.withheld, 1);

    // The rendered form is the one that would reach a prompt. The number may
    // appear nowhere in it.
    const text = renderLifeState(state);
    check('nor does it appear in the rendered text', !text.includes('1,234,567'));
    check('but the fact that something was withheld does', text.includes('1 件'));

    db.close();
  }

  {
    // A store that ignores shareableOnly. The layer must not depend on its
    // input behaving — that is the difference between a boundary and a habit.
    const c = clock(T0);
    const leaky = fakeMemories([
      memory({ id: 'a', content: '共有してよい事実' }),
      memory({ id: 'b', content: '秘密の残高', privacy: 'local_only' }),
    ]);
    const life = new LifeStateService({ context: engineWithKinds(c.now), memories: leaky, now: c.now });
    const state = life.current();

    eq('a store that ignores the request still cannot leak', state.standing.map((m) => m.content), ['共有してよい事実']);
    check('and the withheld count notices', state.withheld >= 1);
    check('the rendered text is clean too', !renderLifeState(state).includes('秘密の残高'));
  }

  // -----------------------------------------------------------------------
  section('This layer holds nothing');

  {
    const db = openDatabase(join(dir, 'n.db'));
    const store = new MemoryStore(db);
    store.remember({ kind: 'preference', content: '記録済み', provenance: 'user', source: '本人' });

    const before = store.recall({ includeStale: true, limit: 100 }).length;

    const c = clock(T0);
    const context = engineWithKinds(c.now);
    context.observe({ source: 'speech', kind: 'presence.occupied', value: true, confidence: 0.9 });
    const life = new LifeStateService({ context, memories: store, now: c.now });

    life.current();
    life.current();
    life.current();

    eq('reading the present writes no memory', store.recall({ includeStale: true, limit: 100 }).length, before);
    eq('and records no observation', context.history('presence.occupied', 50).length, 1);

    // Nothing is cached, so a changed clock cannot be served a stale answer.
    const first = life.current().clock.epochMs;
    c.advance(60_000);
    const second = life.current().clock.epochMs;
    eq('a second call reflects the new time', second - first, 60_000);

    db.close();
  }

  // -----------------------------------------------------------------------
  section('The rendered form is honest about what it does not know');

  {
    const c = clock(T0);
    const context = engineWithKinds(c.now);
    context.observe({
      source: 'calendar',
      kind: 'calendar.next_event',
      value: { title: 'そよかぜ書店', start: '2026-08-20T19:30:00+09:00', calendar: '職場' },
      confidence: 1,
    });
    c.advance(42 * 60_000);
    context.observe({ source: 'speech', kind: 'presence.occupied', value: true, confidence: 0.9 });

    const life = new LifeStateService({
      context,
      memories: fakeMemories([memory({ content: '神経科学の本試験は8月24日' })]),
      now: c.now,
    });
    const text = renderLifeState(life.current());

    check('the event reads as a title, not as JSON', text.includes('そよかぜ書店') && !text.includes('{"title"'));
    check('the calendar it came from is kept', text.includes('職場'));
    check('age is spelled out', text.includes('42分前'));
    check('an uncalibrated source is marked in the line', text.includes('未校正'));
    check('the unknown kind is named', text.includes('speech.last_utterance'));
    // The sentence that keeps a reader from treating silence as a denial.
    check('and unknown is explained as not-a-denial', text.includes('「いいえ」ではありません'));
    check('standing facts carry their provenance', text.includes('本人の発言'));
  }

  {
    const c = clock(T0);
    const life = new LifeStateService({
      context: engineWithKinds(c.now),
      memories: fakeMemories([]),
      now: c.now,
    });
    const text = renderLifeState(life.current());
    check('an empty present says so in words', text.includes('現在観測されているものはありません'));
  }

  // -----------------------------------------------------------------------
  section('The clock');

  {
    const c = clock(T0);
    const life = new LifeStateService({
      context: engineWithKinds(c.now),
      memories: fakeMemories([]),
      now: c.now,
      timeZone: 'Asia/Tokyo',
    });
    const state = life.current();
    eq('the requested zone is used', state.clock.timeZone, 'Asia/Tokyo');
    eq('the weekday is resolved in it', state.clock.weekday, '木曜日');
    check('and the localized string is populated', state.clock.localized.includes('2026'));
  }

  {
    // A bad zone must not take the present with it. The time is still known;
    // only the formatting was wrong.
    const c = clock(T0);
    const life = new LifeStateService({
      context: engineWithKinds(c.now),
      memories: fakeMemories([]),
      now: c.now,
      timeZone: 'Mars/Olympus_Mons',
    });
    let state: ReturnType<LifeStateService['current']> | null = null;
    let threw = false;
    try { state = life.current(); } catch { threw = true; }
    check('an unusable timezone does not throw', threw === false);
    check('it falls back rather than reporting the bad zone', state!.clock.timeZone !== 'Mars/Olympus_Mons');
    check('and the instant is still correct', state!.clock.epochMs === T0);
  }

  // -----------------------------------------------------------------------
  section('Age as something a reader weighs');

  {
    eq('seconds', describeAge(5_000), '5秒前');
    eq('just under a minute', describeAge(59_000), '59秒前');
    eq('minutes', describeAge(42 * 60_000), '42分前');
    eq('just under an hour', describeAge(59 * 60_000), '59分前');
    eq('hours', describeAge(3 * 60 * 60_000), '3時間前');
    eq('days', describeAge(50 * 60 * 60_000), '2日前');
    // A reading from the future is a clock problem, and saying "-3分前" would
    // present it as a fresh one.
    eq('a future timestamp is named, not rendered as an age', describeAge(-1000), '未来の時刻');
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Life state: ${passed} passed, ${failed} failed`);
  rmSync(dir, { recursive: true, force: true });
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('All life state tests passed.');
}

main();
