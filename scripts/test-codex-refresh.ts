/**
 * Codex の空実行を、走らせるべきときにだけ走らせる。
 *
 * **枠を使う操作**なので、確かめるのは「走った」ことより「走らせなかった」
 * ことの方。5時間の窓が生きているのに走らせたら、それは読みのためではなく
 * 何もしないために枠を使ったことになる。
 *
 * Run: npx tsx scripts/test-codex-refresh.ts
 */
import { needsProbe, refreshCodexAllowance, forgetCodexProbeHistory } from '../server/services/codex_refresh.js';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function section(name: string) { console.log(`\n▸ ${name}`); }
function eq(name: string, actual: any, expected: any) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(`${name}: ${JSON.stringify(actual)} ≠ ${JSON.stringify(expected)}`); console.log(`  ✗ ${name}`); }
}

const hour = 3_600_000;
const limit = (resets: number) => ({
  usedPercent: 16,
  windowMinutes: 10080,
  resetsAtMs: Date.now() + 6 * 24 * hour,
  recordedAtMs: Date.now(),
  source: 'test',
  session: { usedPercent: 54, windowMinutes: 300, resetsAtMs: resets },
}) as any;

function main() {
  section('走らせるかどうか');
  eq('窓が生きていれば走らせない', needsProbe(limit(Date.now() + hour)), false);
  eq('窓が過ぎていれば走らせる', needsProbe(limit(Date.now() - hour)), true);
  eq('読みが無ければ走らせる', needsProbe(null), true);
  eq('5時間の記録が無ければ走らせる', needsProbe({ ...limit(0), session: null }), true);

  section('実際に起動するか');
  let launched: string[] | null = null;
  const fake = () => {
    const handlers: Record<string, () => void> = {};
    return { on: (e: string, f: () => void) => { handlers[e] = f; }, kill: () => {} } as any;
  };
  const live = refreshCodexAllowance(limit(Date.now() + hour), (c, a) => { launched = a; return fake(); });
  eq('生きている窓では起動しない', live.started, false);
  eq('起動していない', launched, null);

  const stale = refreshCodexAllowance(limit(Date.now() - hour), (c, a) => { launched = a; return fake(); });
  eq('過ぎた窓では起動する', stale.started, true);
  eq('exec を一往復で使う', launched?.[0], 'exec');
  eq('逐次出力を付ける', launched?.includes('--json'), true);

  section('二重に走らせない');
  const again = refreshCodexAllowance(limit(Date.now() - hour), () => fake());
  eq('走っているあいだは断る', again.started, false);

  section('立て続けには走らせない');
  /*
   * 実際に1分で25本走った日がある。空実行は数秒で終わるので `running` の
   * 見張りを素通りし、しかも枠を書かないので**次はもっと読めなくなる。**
   * 「同時に走らない」だけでは足りない。
   */
  forgetCodexProbeHistory();
  // すぐ終わる空実行。**「同時に走らない」の見張りを素通りする**のが要点
  // なので、exit はその場で返す。実物も数秒で終わる。
  const quick = () => ({ kill() {}, on(ev: string, fn: () => void) { if (ev === 'exit') fn(); } }) as any;
  const t0 = 1_000_000;
  const first = refreshCodexAllowance(null, () => quick(), t0);
  eq('一本目は走る', first.started, true);
  const soon = refreshCodexAllowance(null, () => quick(), t0 + 60_000);
  eq('1分後は断る', soon.started, false);
  eq('理由に待ち時間が入る', /あと \d+ 分/.test(soon.reason ?? ''), true);
  const later = refreshCodexAllowance(null, () => quick(), t0 + 16 * 60_000);
  eq('16分後なら走る', later.started, true);
  forgetCodexProbeHistory();

  console.log('\n' + '─'.repeat(60));
  console.log(`Codex refresh: ${passed} passed, ${failed} failed`);
  if (failed) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('All Codex refresh tests passed.');
}

main();
