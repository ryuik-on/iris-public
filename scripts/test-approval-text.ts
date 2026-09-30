/**
 * 承認画面の、人が読む文。
 *
 * 「人間が読む用の文章じゃない」（利用者、2026-09-30）—— 本文に模型向けの
 * 道具説明が出ていた。確かめるのは、**本文に取扱説明の語が出ないこと**と、
 * **知らない道具にそれらしい説明を作らないこと。**
 *
 * Run: npx tsx scripts/test-approval-text.ts
 */
import { describeApproval } from '../server/core/approval_text.js';

let passed = 0, failed = 0;
const failures: string[] = [];
function eq(n: string, a: any, b: any) {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (ok) { passed++; console.log(`  ✓ ${n}`); }
  else { failed++; failures.push(`${n}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`); console.log(`  ✗ ${n}`); }
}

const remember = describeApproval('remember', {
  kind: 'preference', content: '朝の予定は 8:30 からの講義を先に言う', provenance: 'user',
  source: '2026-09-30 の会話で本人が言った', privacy: 'local_only', retention: 'durable',
});
eq('問いの形', remember.heading, '覚えておきますか？');
eq('中身を括って見せる', remember.summary.includes('「朝の予定は 8:30 からの講義を先に言う」'), true);
eq('取扱説明の語が本文に出ない', /provenance|measured|evidence|local_only/.test(remember.summary), false);
eq('出所を人の言葉で', remember.facts.find((f) => f.label === 'どこから')?.value, 'あなたが言ったこと');
eq('見せる範囲を人の言葉で', remember.facts.find((f) => f.label === '見せる範囲')?.value.startsWith('この機械の中だけ'), true);
eq('事実にも取扱説明の語が出ない', remember.facts.some((f) => /local_only|provenance|durable/.test(f.value)), false);

const sparse = describeApproval('remember', { content: 'x', provenance: 'inferred', source: '' });
eq('空の事実は出さない', sparse.facts.map((f) => f.label), ['どこから']);

const long = describeApproval('remember', { content: 'あ'.repeat(300), provenance: 'user', source: 's' });
eq('長い中身は縮める', long.summary.length < 200, true);

const unknown = describeApproval('mystery_tool', { a: 1 });
eq('知らない道具には説明を作らない', unknown.summary.includes('技術情報'), true);
eq('知らない道具は事実も出さない', unknown.facts.length, 0);

console.log(`\nApproval text: ${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log('  - ' + f); process.exit(1); }
