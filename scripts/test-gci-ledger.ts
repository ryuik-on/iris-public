import { parseGciLedger, readGciLedger } from '../server/core/gci_ledger.js';
let passed = 0, failed = 0;
const eq = (n: string, a: unknown, b: unknown) => { const ok = JSON.stringify(a) === JSON.stringify(b); ok ? passed++ : failed++; console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ` (got ${JSON.stringify(a)})`}`); };
console.log('▸ 論点表を数える');
{
  const csv = '"course","session","topic","status","evidence"\n"GCI","1","変数","確認済み","x"\n"GCI","2","集合","要再確認","^を誤答, 再出題"\n"GCI","5","前処理","学習中",""\n"GCI","6","重回帰","未着手",""\n';
  const g = parseGciLedger(csv);
  eq('論点数', g.topics, 4);
  eq('確認済み', g.confirmed, 1);
  eq('進捗率は確認済み÷論点数', g.progress, 0.25);
  eq('引用符の中のコンマで割れない', g.review, 1);
}
{
  const g = parseGciLedger('"topic","status"\n"a","確認済み"\n"b","謎の値"\n');
  eq('知らない status は unknown', g.unknown, 1);
  eq('unknown も分母に残る', g.progress, 0.5);
}
{
  eq('status 列が無ければ数えない', parseGciLedger('"a","b"\n"1","2"\n').progress, null);
  eq('空なら null', parseGciLedger('').progress, null);
}
console.log('▸ 実物');
{
  try {
    const g = readGciLedger(process.env.HOME + '/Documents/Codex/2026-07-28/medrecall/docs/gci-programming-progress-ledger.csv');
    console.log(`  実物: ${g.topics} 論点 / 確認済み ${g.confirmed} / 進捗 ${g.progress}`);
    eq('実物が読める', g.topics > 0, true);
  } catch (e: any) { console.log('  (実物なし:', e.message.slice(0, 40), ')'); }
}
console.log(`\nGCI ledger: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
