/**
 * 停止の見張り。
 *
 * 確かめるのは、**見つけたことを誰のせいにするか**。名乗った仕事に付けること、
 * 名乗っていない停止を「無かった」にしないこと、そして入れ子では内側に付くこと
 * —— 止めているのは細かい方だから。
 *
 * Run: npm run test:loop-watch
 */
import { LoopWatch } from '../server/core/loop_watch.js';

let passed = 0, failed = 0;
const failures: string[] = [];
function section(n: string) { console.log(`\n▸ ${n}`); }
function eq(n: string, a: any, b: any) {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (ok) { passed++; console.log(`  ✓ ${n}`); }
  else { failed++; failures.push(`${n}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`); console.log(`  ✗ ${n}`); }
}

/** 時計を手で進める。実時間を待つ試験は、遅い機械で落ちる。 */
function clocked() {
  let at = Date.parse('2026-09-28T10:00:00.000Z');
  const watch = new LoopWatch(200, 300, 50, () => at);
  return { watch, advance: (ms: number) => { at += ms; } };
}

section('遅れていなければ何も残さない');
{
  const { watch, advance } = clocked();
  watch.start();
  for (let i = 0; i < 5; i++) { advance(205); watch.tick(); }
  eq('普通の揺れは停止ではない', watch.recent().length, 0);
}

section('遅れた分だけを長さとして残す');
{
  const { watch, advance } = clocked();
  watch.start();
  advance(4000);
  watch.tick();
  const [stall] = watch.recent();
  eq('間隔ぶんは引く（200ms は遅れではない）', stall.ms, 3800);
  eq('止まりはじめた時刻を残す（気づいた時刻ではない）', stall.at, '2026-09-28T10:00:00.200Z');
}

section('名乗った仕事のせいにする');
{
  const { watch, advance } = clocked();
  watch.start();
  const end = watch.begin('watch.divergence');
  advance(4000);
  watch.tick();
  end();
  eq('走っていた仕事の名前が付く', watch.recent()[0]?.during, 'watch.divergence');
}
{
  const { watch, advance } = clocked();
  watch.start();
  watch.during('usage.sweep', () => { advance(4000); watch.tick(); });
  eq('同期の仕事も名乗れる', watch.recent()[0]?.during, 'usage.sweep');
  eq('終わったら名乗りを下ろす', watch.current(), []);
}
{
  const { watch, advance } = clocked();
  watch.start();
  const outer = watch.begin('watch');
  const inner = watch.begin('watch.ledger');
  advance(4000);
  watch.tick();
  inner();
  outer();
  eq('入れ子では内側が名乗る', watch.recent()[0]?.during, 'watch.ledger');
}
{
  const { watch, advance } = clocked();
  watch.start();
  const end = watch.begin('a');
  end();
  end(); // 二度呼んでも、他の名乗りを消さない
  const other = watch.begin('b');
  advance(4000);
  watch.tick();
  other();
  eq('終わりを二度呼んでも壊れない', watch.recent()[0]?.during, 'b');
}

section('名乗らない停止を「無かった」にしない');
{
  const { watch, advance } = clocked();
  watch.start();
  advance(4000);
  watch.tick();
  eq('名前の無い停止も残る', watch.recent().length, 1);
  eq('名前は null（不明であって、無事ではない）', watch.recent()[0]?.during, null);
  eq('まとめにも出る', watch.summary().map((s) => s.during), [null]);
}

section('一度の大きい停止と、繰り返す小さい停止を区別する');
{
  const { watch, advance } = clocked();
  watch.start();
  watch.during('rare', () => { advance(4200); watch.tick(); });
  for (let i = 0; i < 6; i++) {
    watch.during('often', () => { advance(600); watch.tick(); });
  }
  const summary = watch.summary();
  eq('最悪の順に並ぶ', summary.map((s) => s.during), ['rare', 'often']);
  eq('回数が出る', summary.find((s) => s.during === 'often')?.count, 6);
  eq('合計も出る（一度の4秒と毎分の0.4秒は違う問題）', summary.find((s) => s.during === 'often')?.totalMs, 2400);
}

section('覚えておく件数には上限がある');
{
  const watch = new LoopWatch(200, 300, 3, (() => { let at = 0; return () => (at += 4000); })());
  watch.start();
  for (let i = 0; i < 10; i++) watch.tick();
  eq('古いものから捨てる', watch.recent().length, 3);
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`Loop watch: ${passed} passed, ${failed} failed`);
if (failed) { console.log('\nFailures:'); for (const f of failures) console.log('  - ' + f); process.exit(1); }
console.log('All loop watch tests passed.');
