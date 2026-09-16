/**
 * Model lifecycle tests.
 *
 * The premise is that a model id rots. A hardcoded `claude-3-5-sonnet-20241022`
 * sat in this repository for months and only failed once a key was supplied,
 * and a configured Gemini model became unavailable and took a fix on the
 * machine. No amount of care in writing an id down prevents either.
 *
 * So the thing being defended is a distinction rather than a feature: "this
 * model is gone" and "I could not check" must never be the same answer. Storing
 * the second as the first turns every network blip into a retirement, and
 * reporting the first as the second means nobody is told until a request 404s.
 *
 * Run: npm run test:model-lifecycle
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { openDatabase } from '../server/services/db.js';
import {
  checkConfiguredModel, checkConfigured, ModelCheckStore, ProviderModels,
} from '../server/services/model_discovery.js';

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

const dir = mkdtempSync(join(tmpdir(), 'iris-model-'));

function serving(provider: string, ids: string[], extra: Record<string, any> = {}): ProviderModels {
  return {
    provider,
    available: true,
    models: ids.map((id) => ({ id, ...(extra[id] ?? {}) })),
    checkedAt: new Date().toISOString(),
  };
}
function unreachable(provider: string, error = 'ECONNREFUSED'): ProviderModels {
  return { provider, available: false, models: [], error, checkedAt: new Date().toISOString() };
}

function main() {
  // -----------------------------------------------------------------------
  section('Gone and could-not-check are different answers');

  {
    const live = serving('gemini', ['gemini-3.6-flash', 'gemini-2.5-flash']);
    const ok = checkConfiguredModel(live, 'GEMINI_MODEL', 'gemini-3.6-flash', /^gemini-/)!;
    eq('a model that exists is present', ok.present, true);

    const gone = checkConfiguredModel(live, 'GEMINI_MODEL', 'gemini-1.0-pro', /^gemini-/)!;
    eq('a model that does not is absent', gone.present, false);
    check('and the consequence is stated', /404/.test(gone.note));
    check('with something to use instead', Boolean(gone.suggestion));

    // The distinction the whole module exists for.
    const blind = checkConfiguredModel(unreachable('gemini'), 'GEMINI_MODEL', 'gemini-3.6-flash', /^gemini-/)!;
    eq('an unreachable provider yields no verdict', blind.present, undefined);
    check('and says why', /取得できなかった/.test(blind.note));
    check('rather than claiming the model is missing', !/ありません/.test(blind.note));
  }

  {
    // Both previously-found bugs, kept as tests.
    const live = serving('anthropic', ['claude-sonnet-5']);
    eq(
      'a stray space does not retire a live model',
      checkConfiguredModel(live, 'ANTHROPIC_MODEL', ' claude-sonnet-5 ', /^claude-/)!.present,
      true
    );

    // A global regex carries lastIndex between calls, which would make the
    // candidate list depend on the order the checks happened to run in.
    const sticky = /^gemini-/g;
    const first = checkConfiguredModel(serving('gemini', ['gemini-a', 'gemini-b']), 'X', 'nope', sticky)!;
    const second = checkConfiguredModel(serving('gemini', ['gemini-a', 'gemini-b']), 'X', 'nope', sticky)!;
    eq('candidates do not depend on call order', first.suggestion, second.suggestion);
  }

  {
    eq('an unset setting is not checked at all',
       checkConfiguredModel(serving('openai', ['gpt-5']), 'OPENAI_MODEL', undefined, /^gpt/), null);
    eq('nor is an empty one',
       checkConfiguredModel(serving('openai', ['gpt-5']), 'OPENAI_MODEL', '   ', /^gpt/), null);
  }

  // -----------------------------------------------------------------------
  section('A replacement that would fail on first use is not a replacement');

  {
    // Gemini reports what each model can do. An image or embedding model whose
    // name matches the pattern is not a chat model, and suggesting one is
    // suggesting something that 400s the moment it is used.
    const live = serving(
      'gemini',
      ['gemini-2.5-flash-image', 'gemini-2.5-flash', 'gemini-embedding-001'],
      {
        'gemini-2.5-flash-image': { supportedActions: ['predict'] },
        'gemini-2.5-flash': { supportedActions: ['generateContent', 'countTokens'] },
        'gemini-embedding-001': { supportedActions: ['embedContent'] },
      }
    );
    const gone = checkConfiguredModel(live, 'GEMINI_MODEL', 'gemini-1.0-pro', /^gemini-/)!;
    eq('the suggestion is one that can hold a conversation', gone.suggestion, 'gemini-2.5-flash');
    check('and the image model is not offered', !/flash-image/.test(gone.note));

    // A provider that says nothing about capabilities is believed rather than
    // filtered out entirely.
    const quiet = serving('anthropic', ['claude-sonnet-5']);
    eq('a provider that reports no actions still suggests',
       checkConfiguredModel(quiet, 'ANTHROPIC_MODEL', 'claude-old', /^claude-/)!.suggestion,
       'claude-sonnet-5');
  }

  // -----------------------------------------------------------------------
  section('Every configured setting is checked, including Gemini');

  {
    // Gemini was the provider IRIS actually runs on and the one that had
    // broken, and it was the one discovery did not cover.
    const env = {
      ANTHROPIC_MODEL: 'claude-sonnet-5',
      OPENAI_MODEL: 'gpt-5.6-terra',
      GEMINI_MODEL: 'gemini-3.6-flash',
    } as any;
    const checks = checkConfigured(
      [
        serving('anthropic', ['claude-sonnet-5']),
        serving('openai', ['gpt-5.6-terra']),
        serving('gemini', ['gemini-3.6-flash']),
      ],
      env
    );
    const settings = checks.map((c) => c.setting).sort();
    eq('all three providers are covered', settings, ['ANTHROPIC_MODEL', 'GEMINI_MODEL', 'OPENAI_MODEL']);
    check('and all are present', checks.every((c) => c.present === true));

    // Falls back to the review setting when the main one is unset, rather
    // than silently checking nothing.
    const reviewOnly = checkConfigured([serving('openai', ['gpt-5'])], { REVIEW_PRIMARY_MODEL: 'gpt-5' } as any);
    eq('the review model is checked when it is the only one', reviewOnly[0].setting, 'REVIEW_PRIMARY_MODEL');
  }

  // -----------------------------------------------------------------------
  section('What was known, after a restart');

  {
    const db = openDatabase(join(dir, 'checks.db'));
    const store = new ModelCheckStore(db);

    store.record(
      { provider: 'gemini', setting: 'GEMINI_MODEL', configured: 'gemini-3.6-flash', present: true, note: 'ok' },
      '2026-08-19T09:00:00.000Z'
    );
    let [row] = store.list();
    eq('a sighting is stored', row.present, true);
    eq('with when it was seen', row.lastPresentAt, '2026-08-19T09:00:00.000Z');

    // A provider that cannot be reached must not overwrite the sighting.
    store.record(
      { provider: 'gemini', setting: 'GEMINI_MODEL', configured: 'gemini-3.6-flash', note: '取得できなかった' },
      '2026-08-19T10:00:00.000Z'
    );
    [row] = store.list();
    eq('a failed check records no verdict', row.present, undefined);
    eq('but the check time moves', row.checkedAt, '2026-08-19T10:00:00.000Z');
    eq('and the last sighting is kept', row.lastPresentAt, '2026-08-19T09:00:00.000Z');
    eq('so it is not reported as missing', store.missing().length, 0);

    // An actual retirement is a different matter.
    store.record(
      { provider: 'gemini', setting: 'GEMINI_MODEL', configured: 'gemini-3.6-flash', present: false, note: 'なし' },
      '2026-08-19T11:00:00.000Z'
    );
    eq('a retirement is reported', store.missing().length, 1);
    eq('and still remembers when it last worked', store.list()[0].lastPresentAt, '2026-08-19T09:00:00.000Z');

    // Coming back is possible — a provider can restore a model, and a stale
    // "missing" would then be the wrong answer.
    store.record(
      { provider: 'gemini', setting: 'GEMINI_MODEL', configured: 'gemini-3.6-flash', present: true, note: 'ok' },
      '2026-08-19T12:00:00.000Z'
    );
    eq('recovery clears the report', store.missing().length, 0);
    eq('and moves the sighting forward', store.list()[0].lastPresentAt, '2026-08-19T12:00:00.000Z');

    // Changing which model is configured invalidates the sighting.
    //
    // The row is keyed by setting, so without this the previous model's
    // last-working time is reported as the new model's — and "it was fine an
    // hour ago" becomes a statement about something else entirely. Found by
    // configuring a retired id on the running service and reading the row.
    store.record(
      { provider: 'gemini', setting: 'GEMINI_MODEL', configured: 'gemini-9.9-imaginary', present: false, note: 'なし' },
      '2026-08-19T13:00:00.000Z'
    );
    eq('a different model does not inherit the old sighting', store.list()[0].lastPresentAt, null);
    eq('and it is reported missing', store.missing().length, 1);

    // Changing back to something that works starts its own record.
    store.record(
      { provider: 'gemini', setting: 'GEMINI_MODEL', configured: 'gemini-3.6-flash', present: true, note: 'ok' },
      '2026-08-19T14:00:00.000Z'
    );
    eq('a working model records its own sighting', store.list()[0].lastPresentAt, '2026-08-19T14:00:00.000Z');

    // One row per setting, not one per check.
    eq('checks accumulate per setting, not per run', store.list().length, 1);
    store.record({ provider: 'openai', setting: 'OPENAI_MODEL', configured: 'gpt-5', present: true, note: 'ok' });
    eq('a second setting is its own row', store.list().length, 2);

    db.close();
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Model lifecycle: ${passed} passed, ${failed} failed`);
  rmSync(dir, { recursive: true, force: true });
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('All model lifecycle tests passed.');
}

main();
