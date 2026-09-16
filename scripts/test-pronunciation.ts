/**
 * Reading dictionary tests.
 *
 * Prompted by a real mispronunciation: Chirp 3 HD read 平滑筋 as へいかつすじ.
 * 筋 is すじ in ordinary speech and きん in anatomy, so this is a property of
 * the language and the domain rather than of one vendor — which is why the
 * correction sits above every engine instead of inside one.
 *
 * The dangerous failure here is not a missing entry but a wrong one. A bad
 * reading is applied silently, consistently, to every sentence, which is
 * exactly how a mistake stops being noticed. So the tests care most about
 * substitution being predictable: longest match first, no compounding, and
 * the displayed text never touched.
 *
 * Run: npm run test:pronunciation
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { openDatabase, getSchemaVersion } from '../server/services/db.js';
import {
  PronunciationStore, applyPronunciations, SEED_PRONUNCIATIONS,
} from '../server/services/pronunciation.js';

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
  const dir = mkdtempSync(join(tmpdir(), 'iris-pron-'));
  const db = openDatabase(join(dir, 'p.db'));
  const store = new PronunciationStore(db);

  try {
    check('the schema carries the dictionary', getSchemaVersion(db) >= 10);

    // ---------------------------------------------------------------------
    section('The mispronunciation that prompted this');

    {
      const result = applyPronunciations('気管支平滑筋を弛緩させる', SEED_PRONUNCIATIONS);
      // Heard on 2026-08-19 as へいかつすじ.
      check('平滑筋 is sent as へいかつきん', result.text.includes('へいかつきん'));
      check('and the kanji no longer reaches the engine', !result.text.includes('平滑筋'));
      // 弛緩 is misread as ちかん even by people.
      check('弛緩 is sent as しかん', result.text.includes('しかん'));
      eq('and both corrections are reported', result.applied.length, 2);
      check('each says how many times it fired', result.applied.every((a) => a.count === 1));
    }

    // ---------------------------------------------------------------------
    section('Longest match first');

    {
      // 筋 alone would turn 平滑筋 into 平滑きん — a compound nobody can read.
      const dict = [
        { term: '平滑筋', reading: 'へいかつきん' },
        { term: '筋', reading: 'きん' },
      ];
      const result = applyPronunciations('平滑筋の収縮', dict);
      eq('the longer term wins', result.text, 'へいかつきんの収縮');
      eq('and the shorter one does not also fire', result.applied.length, 1);
    }

    {
      // Kana produced by one substitution must not be re-matched by another.
      const dict = [
        { term: '手指', reading: 'しゅし' },
        { term: 'しゅし', reading: '主旨' },
      ];
      const result = applyPronunciations('手指の振戦', dict);
      eq('a substitution is not fed back into the dictionary', result.text, 'しゅしの振戦');
    }

    {
      const result = applyPronunciations('平滑筋と平滑筋', SEED_PRONUNCIATIONS);
      eq('every occurrence is corrected', result.text, 'へいかつきんとへいかつきん');
      eq('and counted', result.applied.find((a) => a.term === '平滑筋')!.count, 2);
    }

    // ---------------------------------------------------------------------
    section('Text nobody asked to change is left alone');

    {
      const result = applyPronunciations('今日の天気はどうですか', SEED_PRONUNCIATIONS);
      eq('unmatched text passes through unchanged', result.text, '今日の天気はどうですか');
      eq('with nothing reported', result.applied.length, 0);

      eq('empty text is safe', applyPronunciations('', SEED_PRONUNCIATIONS).text, '');
      eq('an empty dictionary changes nothing', applyPronunciations('平滑筋', []).text, '平滑筋');
    }

    // ---------------------------------------------------------------------
    section('The shipped list, and corrections made by ear');

    {
      const first = store.seed();
      eq('seeding inserts the shipped list', first.inserted, SEED_PRONUNCIATIONS.length);
      const again = store.seed();
      eq('re-seeding inserts nothing', again.inserted, 0);

      const listed = store.list();
      eq('every entry is available', listed.length, SEED_PRONUNCIATIONS.length);
      check('and marked as shipped', listed.every((e) => e.source === 'seed'));
      // Ordered so a consumer that ignores ordering still gets longest-first.
      check(
        'longest terms come first',
        listed[0].term.length >= listed[listed.length - 1].term.length
      );
    }

    {
      const corrected = store.set('平滑筋', 'へいかつきんにく', '実際に聞いて修正');
      eq('a correction overwrites the shipped reading', corrected.reading, 'へいかつきんにく');
      // They heard it and we did not.
      eq('and outranks it', corrected.source, 'user');

      const after = store.seed();
      eq('re-seeding does not undo a correction', after.inserted, 0);
      eq('the correction survives', store.list().find((e) => e.term === '平滑筋')!.reading, 'へいかつきんにく');

      store.set('平滑筋', 'へいかつきん');
      eq('and can be corrected again', store.list().find((e) => e.term === '平滑筋')!.reading, 'へいかつきん');
    }

    {
      let threw = false;
      try { store.set('', 'かな'); } catch { threw = true; }
      check('an empty term is refused', threw);

      threw = false;
      try { store.set('用語', ''); } catch { threw = true; }
      check('an empty reading is refused', threw);

      threw = false;
      // A reading identical to the term substitutes nothing while looking
      // like it had been fixed — the worst kind of silent no-op.
      try { store.set('平滑筋', '平滑筋'); } catch { threw = true; }
      check('a reading identical to the term is refused', threw);
    }

    {
      check('an entry can be removed', store.remove('頓服'));
      check('removing a missing entry is not an error', !store.remove('頓服'));
      check('and it is gone from the list', !store.list().some((e) => e.term === '頓服'));
    }

    // ---------------------------------------------------------------------
    section('Only speech changes');

    {
      const original = '気管支平滑筋を弛緩させる';
      const result = applyPronunciations(original, SEED_PRONUNCIATIONS);
      // A transcript reading へいかつきん instead of 平滑筋 would have traded
      // one wrong output for another.
      eq('the caller\'s string is not mutated', original, '気管支平滑筋を弛緩させる');
      check('while the spoken form differs', result.text !== original);
    }
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Pronunciation: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('All pronunciation tests passed.');
}

main();
