/**
 * 待機中の委任。
 *
 * 断られた委任は「予定」の顔のまま置き去りで、試し直すたびにタスクが増えた
 * （2026-09-30、同じ依頼が三件）。確かめるのは、**待ち始めた時刻が試し直しで
 * 動かないこと**（いつから待っているかが待機の要点）、**解けたものが一覧から
 * 消えること**、**待てば解ける理由だけが待機になること。**
 *
 * Run: npx tsx scripts/test-agent-waits.ts
 */
import { openDatabase } from '../server/services/db.js';
import { AgentWaitStore, WAITABLE } from '../server/services/agent_waits_sqlite.js';

let passed = 0, failed = 0;
const failures: string[] = [];
function eq(n: string, a: any, b: any) {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (ok) { passed++; console.log(`  ✓ ${n}`); }
  else { failed++; failures.push(`${n}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`); console.log(`  ✗ ${n}`); }
}

const db = openDatabase(':memory:', { wal: false });
const store = new AgentWaitStore(db);
const t0 = new Date('2026-09-30T06:43:00Z');
const t1 = new Date('2026-09-30T07:00:00Z');
const t2 = new Date('2026-09-30T07:10:00Z');

store.wait({ taskId: 'A', repo: '/r', agent: 'claude', reasonCode: 'dirty_tree', reason: '未コミットの変更' }, t0);
eq('待ち始める', store.open().map((w) => w.taskId), ['A']);
const again = store.wait({ taskId: 'A', repo: '/r', agent: 'claude', reasonCode: 'dirty_tree', reason: '未コミットの変更' }, t1);
eq('試し直しても、いつから待っているかは動かない', again.since, t0.toISOString());
eq('何度確かめたかは増える', again.attempts, 2);

store.touch('A', 'busy', '実行中が上限', t2);
const touched = store.get('A')!;
eq('理由は新しいものに', touched.reasonCode, 'busy');
eq('確かめた時刻も', touched.checkedAt, t2.toISOString());

store.wait({ taskId: 'B', repo: '/r', agent: 'codex', reasonCode: 'busy', reason: 'x' }, t1);
eq('先に待ち始めたものから', store.open().map((w) => w.taskId), ['A', 'B']);

store.resolve('A', 'run-1', t2);
eq('始まったものは一覧から消える', store.open().map((w) => w.taskId), ['B']);
eq('どの実行で始まったかは残る', store.get('A')!.runId, 'run-1');

store.wait({ taskId: 'A', repo: '/r', agent: 'claude', reasonCode: 'dirty_tree', reason: 'y' }, t2);
eq('解けたあとにまた待つなら、待ち始めは新しく', store.get('A')!.since, t2.toISOString());

eq('未コミットの変更は待てば解ける', WAITABLE.has('dirty_tree'), true);
eq('同時実行の上限も', WAITABLE.has('busy'), true);
eq('許可リストに無いのは待っても解けない', WAITABLE.has('repo_not_allowed'), false);

console.log(`\nAgent waits: ${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log('  - ' + f); process.exit(1); }
