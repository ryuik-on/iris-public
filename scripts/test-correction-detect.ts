import { looksLikeCorrection } from '../server/core/correction_detect.js';

let passed = 0;
const failures: string[] = [];
const eq = (name: string, a: unknown, b: unknown) => { if (JSON.stringify(a) === JSON.stringify(b)) passed++; else failures.push(`${name}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };

for (const t of ['違う', 'いや、違います', 'それは間違ってる', 'さっきの答え、間違ってるよ', 'そうじゃない', 'おかしいよ', '誤報だった', 'それ合ってない', 'そんなこと言ってない', 'irisがしょっちゅう間違えてる']) {
  eq(`直し: ${t}`, looksLikeCorrection(t), true);
}
for (const t of ['講義日程表とカレンダーの食い違いを確認して', '違いを教えて', '今日の予定は？', '間違いやすい語を教えて', '', 'おかしいと思う点をまとめて、来週の計画に反映する文章を作って。長い依頼で、直しではない。'.repeat(3)]) {
  eq(`直しではない: ${t.slice(0, 20)}`, looksLikeCorrection(t), false);
}

console.log(`Correction detect: ${passed} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
console.log('All correction detect tests passed.');
