/**
 * Persistence tests for situational observations.
 *
 * The property under test is mostly a negative one: that nothing is written
 * down until a person said to write it down, for that kind, with a bound on
 * how long it is kept. A log of when someone was at their desk accumulates
 * into a picture of their days, and it describes housemates and visitors who
 * were never asked — so "off" has to be what every sensor is until someone
 * changes it, and there must be no call that produces an unbounded record.
 *
 * The rest is the ordinary durability question: does a restart lose the
 * present, and does an old reading come back to life if the machine was off
 * for a week (it must not).
 *
 * Run: npm run test:context-persistence
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { openDatabase, getSchemaVersion } from '../server/services/db.js';
import { SqliteContextStore } from '../server/services/context_sqlite.js';
import { ContextEngine } from '../server/core/context_engine.js';

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

const HOUR = 3_600_000;

function makeEngine(store: SqliteContextStore, now: () => number) {
  const engine = new ContextEngine({ now, store });
  engine.registerSource({ id: 'speech', label: '音声', calibration: 'uncalibrated' });
  engine.registerSource({ id: 'csi', label: 'CSI', calibration: 'uncalibrated' });
  engine.registerKind({ kind: 'presence.occupied', description: '在室', validForMs: 10 * 60_000, halfLifeMs: 5 * 60_000 });
  engine.registerKind({ kind: 'speech.last_utterance', description: '発話', validForMs: 15 * 60_000 });
  return engine;
}

function main() {
  const dir = mkdtempSync(join(tmpdir(), 'iris-ctxp-'));
  const db = openDatabase(join(dir, 'c.db'));
  const store = new SqliteContextStore(db);

  try {
    eq('the schema carries the persistence tables', getSchemaVersion(db) >= 9, true);

    // ---------------------------------------------------------------------
    section('Off is what everything is until someone says otherwise');

    {
      let now = Date.parse('2026-08-19T09:00:00.000Z');
      const engine = makeEngine(store, () => now);

      engine.observe({ source: 'speech', kind: 'presence.occupied', value: true, confidence: 0.8 });
      engine.observe({ source: 'speech', kind: 'speech.last_utterance', value: 'こんにちは', confidence: 0.9 });

      eq('an observation of an unenabled kind is not written', store.count(), 0);
      eq('and no policy exists to have permitted it', store.policies().length, 0);
      // It is still usable right now — persistence is about the record, not
      // about whether IRIS can see the present.
      check('while the live reading works as before', engine.field('presence.occupied') !== null);
    }

    // ---------------------------------------------------------------------
    section('Enabling requires bounds, and there is no "forever"');

    {
      let threw = false;
      try { store.enable({ kind: 'presence.occupied', retainMs: 0 }); } catch { threw = true; }
      check('a zero retention is refused', threw);

      threw = false;
      try { store.enable({ kind: 'presence.occupied', retainMs: -1 }); } catch { threw = true; }
      check('a negative one too', threw);

      threw = false;
      try { store.enable({ kind: 'presence.occupied', retainMs: 24 * HOUR, maxRows: 0 }); } catch { threw = true; }
      check('and a zero row cap', threw);

      const policy = store.enable({
        kind: 'presence.occupied',
        retainMs: 24 * HOUR,
        maxRows: 1000,
        note: '在室履歴を1日だけ',
      });
      eq('an enabled kind records who decided', policy.decidedBy, 'user');
      eq('and why', policy.note, '在室履歴を1日だけ');
      check('and when', policy.enabledAt.length > 0);
    }

    // ---------------------------------------------------------------------
    section('Only the enabled kind is kept');

    {
      let now = Date.parse('2026-08-19T09:00:00.000Z');
      const engine = makeEngine(store, () => now);

      engine.observe({ source: 'speech', kind: 'presence.occupied', value: true, confidence: 0.8 });
      engine.observe({ source: 'speech', kind: 'speech.last_utterance', value: '秘密の話', confidence: 0.9 });

      eq('the enabled kind is written', store.count('presence.occupied'), 1);
      // The utterance text is the more sensitive of the two, and it was never
      // enabled. Enabling one kind must not drag its neighbours along.
      eq('the kind nobody enabled is not', store.count('speech.last_utterance'), 0);

      const [row] = store.history('presence.occupied');
      eq('both confidences are kept', [row.confidence, row.effectiveConfidence], [0.8, 0.6]);
      eq('with the source', row.source, 'speech');
    }

    // ---------------------------------------------------------------------
    section('A restart does not make the house look empty');

    {
      const t = Date.parse('2026-08-19T12:00:00.000Z');
      store.forget();

      let now = t;
      const before = makeEngine(store, () => now);
      before.observe({ source: 'speech', kind: 'presence.occupied', value: true, confidence: 0.8 });

      // A minute later, the process restarts.
      now = t + 60_000;
      const after = makeEngine(store, () => now);
      eq('a fresh engine starts knowing nothing', after.field('presence.occupied'), null);

      const restored = after.restore();
      eq('restoring reports what it read', restored, [{ kind: 'presence.occupied', restored: 1 }]);

      const field = after.field('presence.occupied')!;
      eq('the observation is back', field.value, true);
      eq('with its original timestamp, not the restart time', field.ageMs, 60_000);
      check('so it is correctly a minute weaker than when it was made', field.confidence < 0.6);
      check('and marked as decayed', field.decayed);
    }

    {
      // The machine was off for a week. Nothing in that record says anything
      // about now, and restoring it would be inventing a present.
      const t = Date.parse('2026-08-19T12:00:00.000Z');
      store.forget();

      let now = t;
      const before = makeEngine(store, () => now);
      before.observe({ source: 'speech', kind: 'presence.occupied', value: true, confidence: 0.8 });

      now = t + 7 * 24 * HOUR;
      const after = makeEngine(store, () => now);
      after.restore();
      eq('a long shutdown restores nothing usable', after.field('presence.occupied'), null);
      check('and the kind is reported as unknown', after.current().unknown.includes('presence.occupied'));
      // The row is still on disk; it is history, not the present.
      check('though the record itself survives', store.count('presence.occupied') > 0);
    }

    // ---------------------------------------------------------------------
    section('Retention is enforced, by age and by volume');

    {
      store.forget();
      const now = Date.parse('2026-08-19T12:00:00.000Z');
      const engine = makeEngine(store, () => now);

      for (let i = 0; i < 5; i++) {
        engine.observe({
          source: 'speech',
          kind: 'presence.occupied',
          value: true,
          confidence: 0.8,
          observedAt: new Date(now - (i + 1) * 12 * HOUR).toISOString(),
        });
      }
      eq('everything observed is written', store.count('presence.occupied'), 5);

      const pruned = store.prune(now);
      // The policy says 24 hours; three of those readings are older.
      eq('what falls outside the window is removed', store.count('presence.occupied'), 2);
      eq('and the removal is reported', pruned[0].byAge, 3);
    }

    {
      store.forget();
      store.enable({ kind: 'presence.occupied', retainMs: 24 * HOUR, maxRows: 10 });
      const now = Date.parse('2026-08-19T12:00:00.000Z');
      const engine = makeEngine(store, () => now);

      for (let i = 0; i < 40; i++) {
        engine.observe({
          source: 'speech',
          kind: 'presence.occupied',
          value: i,
          confidence: 0.8,
          observedAt: new Date(now - i * 60_000).toISOString(),
        });
      }
      store.prune(now);
      eq('a busy sensor is capped by row count too', store.count('presence.occupied'), 10);
      // Oldest first: what survives a cap should be the recent past.
      eq('keeping the most recent', store.history('presence.occupied').at(-1)!.value, 0);
    }

    // ---------------------------------------------------------------------
    section('Turning it off, and getting the data out');

    {
      store.forget();
      store.enable({ kind: 'presence.occupied', retainMs: 24 * HOUR, maxRows: 1000 });
      const now = Date.parse('2026-08-19T12:00:00.000Z');
      const engine = makeEngine(store, () => now);
      engine.observe({ source: 'speech', kind: 'presence.occupied', value: true, confidence: 0.8 });

      const off = store.disable('presence.occupied');
      check('the policy is removed', off.removedPolicy);
      // Disabling is not a delete: destroying data nobody asked to destroy is
      // its own surprise (8.5). What remains is reported so it is not
      // quietly forgotten about.
      eq('what was gathered stays', off.rowsRemaining, 1);
      eq('and nothing was deleted', off.rowsDeleted, 0);

      const engine2 = makeEngine(store, () => now);
      engine2.observe({ source: 'speech', kind: 'presence.occupied', value: true, confidence: 0.8 });
      eq('nothing new is written once it is off', store.count('presence.occupied'), 1);

      // A disabled sensor whose history sits on disk must stay visible.
      eq('orphaned data is surfaced', store.orphaned(), [{ kind: 'presence.occupied', rows: 1 }]);

      // Data that cannot be taken back out is held on worse terms than agreed.
      const exported = store.exportAll('presence.occupied');
      eq('everything held can be exported', exported.length, 1);
      check('with its provenance intact', exported[0].source === 'speech' && exported[0].observedAt.length > 0);

      const deleted = store.disable('presence.occupied', { deleteExisting: true });
      eq('and deleting is one explicit call', deleted.rowsDeleted, 1);
      eq('leaving nothing', store.count('presence.occupied'), 0);
    }

    // ---------------------------------------------------------------------
    section('What is being kept is answerable at any moment');

    {
      store.forget();
      store.enable({ kind: 'presence.occupied', retainMs: 24 * HOUR, maxRows: 1000, note: '1日だけ' });
      const now = Date.parse('2026-08-19T12:00:00.000Z');
      const engine = makeEngine(store, () => now);
      engine.observe({ source: 'speech', kind: 'presence.occupied', value: true, confidence: 0.8 });
      engine.observe({
        source: 'csi', kind: 'presence.occupied', value: false, confidence: 0.5,
        observedAt: new Date(now - HOUR).toISOString(),
      });

      const [summary] = store.summary();
      eq('the summary names the kind', summary.kind, 'presence.occupied');
      eq('how much is held', summary.rows, 2);
      eq('the retention chosen', summary.retainMs, 24 * HOUR);
      eq('and why it was turned on', summary.note, '1日だけ');
      check('with the span it covers', summary.oldest !== null && summary.newest !== null);
      check('oldest really is older', Date.parse(summary.oldest!) < Date.parse(summary.newest!));
    }

    // ---------------------------------------------------------------------
    section('Storage trouble does not take the present with it');

    {
      const now = Date.parse('2026-08-19T12:00:00.000Z');
      const events: any[] = [];
      const broken = new ContextEngine({
        now: () => now,
        onEvent: (e) => events.push(e),
        store: {
          record() { throw new Error('disk full'); },
          recent() { throw new Error('disk full'); },
          prune() { return []; },
        },
      });
      broken.registerSource({ id: 'speech', label: '音声', calibration: 'uncalibrated' });
      broken.registerKind({ kind: 'presence.occupied', description: '在室', validForMs: 600_000 });

      const observation = broken.observe({ source: 'speech', kind: 'presence.occupied', value: true, confidence: 0.8 });
      check('the observation is still accepted', observation.effectiveConfidence === 0.6);
      // The live reading is the one that matters right now; a write failure
      // must not be able to blind the assistant.
      check('and still readable', broken.field('presence.occupied') !== null);
      check('while the failure is reported', events.some((e) => e.type === 'context.persist_failed'));

      eq('a failing restore is survivable too', broken.restore(), []);
      check('and reported', events.some((e) => e.type === 'context.restore_failed'));
    }
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Context persistence: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('All context persistence tests passed.');
}

main();
