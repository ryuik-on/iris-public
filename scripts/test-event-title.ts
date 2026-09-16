/**
 * 予定の題名の切り詰め。
 *
 * The assertions worth having are about what must survive. Roman numerals
 * separate 病理学Ⅱ from 病理学Ⅰ, which are different subjects — dropping them
 * would merge two things the reader keeps apart — and a title carrying no
 * filing has to come back untouched.
 *
 * Run: npx tsx scripts/test-event-title.ts
 */
import { subject } from '../server/services/event_title.js';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function section(name: string) { console.log(`\n▸ ${name}`); }
function eq(name: string, actual: any, expected: any) {
  const ok = actual === expected;
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(`${name}: ${JSON.stringify(actual)} ≠ ${JSON.stringify(expected)}`); console.log(`  ✗ ${name}`); }
}

function main() {
  section('整理番号は落とす');
  {
    // この機械の実物。
    eq('講義の範囲', subject('病理学Ⅱ25-26'), '病理学Ⅱ');
    eq('別の範囲', subject('薬理学25-27'), '薬理学');
    eq('括弧書き', subject('微生物・免疫学試験（後半）'), '微生物・免疫学試験');
    // 先に clip で切られて閉じ括弧が無くなっている場合。
    eq('閉じていない括弧', subject('微生物・免疫学試験 (後半'), '微生物・免疫学試験');
    eq('半角の数字', subject('解剖学 3'), '解剖学');
  }

  section('残さなければならないもの');
  {
    // Ⅱ と Ⅰ は別の科目。落とすと利用者が区別しているものが混ざる。
    eq('ローマ数字は残る', subject('病理学Ⅱ23-24'), '病理学Ⅱ');
    eq('もう一方も', subject('病理学Ⅰ21-22'), '病理学Ⅰ');
    eq('整理番号の無い題名', subject('神経科学本試験'), '神経科学本試験');
    eq('場所の名前', subject('ガウス'), 'ガウス');
    eq('全角空白を含む題名', subject('メアライズ　出勤'), 'メアライズ　出勤');
    // 数字が末尾でなければ整理番号ではない。
    eq('年度は落とさない', subject('2026年度 総合演習'), '2026年度 総合演習');
    // 全部消すのは短縮ではない。
    eq('数字だけの題名', subject('12'), '12');
    eq('括弧だけの題名', subject('（再）'), '（再）');
    eq('空は空のまま', subject(''), '');
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`Event title: ${passed} passed, ${failed} failed`);
  if (failed) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('All event title tests passed.');
}

main();
