import { planRecovery } from '../server/core/recover_verifying.js';

let passed = 0;
const failures: string[] = [];
const eq = (name: string, a: unknown, b: unknown) => { if (JSON.stringify(a) === JSON.stringify(b)) passed++; else failures.push(`${name}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };

const f = (id: string, dedupeKey: string, status: string, runId: string | null = null) => ({ id, dedupeKey, status, runId });

eq('「確認中」の委任した開発は、実行番号でやり直す', planRecovery([f('a', 'dev-run:63f432f1', 'verifying')]), [{ kind: 'dev-run', findingId: 'a', runId: '63f432f1' }]);
eq('「確認中」の自己開発は、持っている実行番号でやり直す', planRecovery([f('b', 'selfcheck:x', 'verifying', 'r1')]), [{ kind: 'self-fix', findingId: 'b', runId: 'r1' }]);
eq('確認中でないものは触らない', planRecovery([f('c', 'dev-run:1', 'awaiting_approval'), f('d', 'dev-run:2', 'merged'), f('e', 'x', 'fixing', 'r')]), []);
eq('実行番号が分からない自己開発は、何もしない', planRecovery([f('g', 'selfcheck:y', 'verifying', null)]), []);
eq('複数あれば、順に並べる', planRecovery([f('a', 'dev-run:1', 'verifying'), f('b', 'k', 'verifying', 'r2')]).map((r) => r.kind), ['dev-run', 'self-fix']);

console.log(`Recover verifying: ${passed} passed, ${failures.length} failed`);
if (failures.length) { for (const x of failures) console.log(`  - ${x}`); process.exit(1); }
console.log('All recover verifying tests passed.');
