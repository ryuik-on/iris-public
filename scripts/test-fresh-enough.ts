/**
 * 古い答えを即返して、裏で取り直す仕組み。
 *
 * 確かめるのは、**待たせないことと、嘘をつかないこと。**一度も取れていない
 * ときだけ待つ、古さは隠さない、取り直しは一本にまとめる、失敗しても手元の
 * 答えは捨てない。四つとも、忘れると「直したはずの停止が戻る」か「古い値が
 * 新しい顔で出る」。
 *
 * Run: npm run test:fresh-enough
 */
import { FreshEnough } from '../server/core/fresh_enough.js';

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
  let at = 1_000_000;
  return { now: () => at, advance: (ms: number) => { at += ms; } };
}

async function main() {
  // -------------------------------------------------------------------
  section('一度も取れていないときだけ待つ');
  {
    const { now } = clocked();
    let loads = 0;
    const cache = new FreshEnough(30_000, async () => { loads++; return `v${loads}`; }, now);
    eq('最初は手元に何も無い', cache.peek(), null);
    eq('最初の一人は待って受け取る', await cache.get(), 'v1');
    eq('取りに行ったのは一度', loads, 1);
  }
  {
    const { now, advance } = clocked();
    let loads = 0;
    const cache = new FreshEnough(30_000, async () => { loads++; return `v${loads}`; }, now);
    await cache.get();
    advance(10_000);
    eq('新しいうちは取りに行かない', await cache.get(), 'v1');
    eq('取りに行った回数は増えない', loads, 1);
  }

  // -------------------------------------------------------------------
  section('古くなったら、古いものを返してから取り直す');
  {
    const { now, advance } = clocked();
    let loads = 0;
    /** 取りに行った回の解放器。**呼ぶまで終わらない**ので、待つ／待たないが見える。 */
    const pending: Array<() => void> = [];
    const cache = new FreshEnough(
      30_000,
      () => new Promise<string>((resolve) => {
        const n = ++loads;
        pending.push(() => resolve(`v${n}`));
      }),
      now
    );
    const first = cache.get();
    pending.shift()!();
    eq('最初は取れるまで待つ', await first, 'v1');

    advance(40_000);
    const answer = await cache.get();
    eq('古くなったら、待たずに古いものが返る', answer, 'v1');
    eq('裏では取りに行っている', loads, 2);
    pending.shift()!();
    await new Promise((r) => setTimeout(r, 0));
    eq('取れたら差し替わる', await cache.get(), 'v2');
  }
  {
    const { now, advance } = clocked();
    let loads = 0;
    const pending: Array<() => void> = [];
    const cache = new FreshEnough(
      30_000,
      () => new Promise<string>((resolve) => {
        const n = ++loads;
        pending.push(() => resolve(`v${n}`));
      }),
      now
    );
    const first = cache.get();
    pending.shift()!();
    await first;

    advance(40_000);
    // 古い答えを返している間に、十の要求。**走るのは一本。**
    const answers = await Promise.all(Array.from({ length: 10 }, () => cache.get()));
    eq('十人とも古いものを受け取る', new Set(answers).size, 1);
    eq('取り直しは一本にまとめる', loads, 2);
    eq('走っている取り直しは一本だけ', pending.length, 1);
  }

  // -------------------------------------------------------------------
  section('古さを隠さない');
  {
    const { now, advance } = clocked();
    const cache = new FreshEnough(30_000, async () => 'x', now);
    await cache.get();
    advance(12_345);
    eq('いつ取ったかを言える', cache.ageMs(), 12_345);
    eq('手元の答えの時刻も出す', cache.peek()?.at, 1_000_000);
  }

  // -------------------------------------------------------------------
  section('失敗しても手元の答えは捨てない');
  {
    const { now, advance } = clocked();
    let attempt = 0;
    const cache = new FreshEnough(
      30_000,
      async () => { attempt++; if (attempt > 1) throw new Error('取れません'); return 'good'; },
      now
    );
    await cache.get();
    advance(40_000);
    eq('失敗しても前の答えが返る', await cache.get(), 'good');
    await new Promise((r) => setTimeout(r, 0));
    eq('失敗は数える', cache.failureCount(), 1);
    eq('答えはまだある', cache.peek()?.value, 'good');
  }
  {
    const { now } = clocked();
    const cache = new FreshEnough(30_000, async () => { throw new Error('最初から取れません'); }, now);
    let threw = false;
    try { await cache.get(); } catch { threw = true; }
    eq('一度も取れていないなら、失敗は失敗として返す', threw, true);
  }

  // -------------------------------------------------------------------
  section('取り直しを頼める');
  {
    const { now } = clocked();
    let loads = 0;
    const cache = new FreshEnough(30_000, async () => { loads++; return `v${loads}`; }, now);
    await cache.get();
    cache.stale();
    eq('古い印を付けても答えは残る', cache.peek()?.value, 'v1');
    await cache.refresh();
    eq('頼めば待って取り直す', cache.peek()?.value, 'v2');
  }
  {
    const { now } = clocked();
    const cache = new FreshEnough(30_000, async () => 'loaded', now);
    cache.accept('from elsewhere');
    eq('外から入れた答えを使う（別プロセスが取った場合）', await cache.get(), 'from elsewhere');
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Fresh enough: ${passed} passed, ${failed} failed`);
  if (failed) { console.log('\nFailures:'); for (const f of failures) console.log('  - ' + f); process.exit(1); }
  console.log('All fresh-enough tests passed.');
}

main();
