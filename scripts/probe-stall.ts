/**
 * サーバが止まる瞬間を、外から測る。
 *
 * 一定の間隔で最も軽い口を叩き、**約束した時刻からどれだけ遅れて返ったか**を
 * 記録する。遅れは往復ではなく、向こうのイベントループが塞がっていた時間に
 * 近い —— こちらの `setTimeout` は正確で、経路は同じ機械の 127.0.0.1 なので。
 *
 * 遅れた瞬間の前後で、サーバのログに何が出ていたかを突き合わせられるように
 * **時刻をそのまま残す。**「最大4.0秒」だけでは原因に届かない。
 *
 * Run: npx tsx scripts/probe-stall.ts [秒数] [間隔ms]
 */
const BASE = process.env.IRIS_BASE ?? 'http://127.0.0.1:3002';
const SECONDS = Number(process.argv[2] ?? 120);
const EVERY_MS = Number(process.argv[3] ?? 100);

interface Sample {
  at: string;
  /** 約束した時刻からの遅れ（ms）。 */
  late: number;
  /** 往復（ms）。 */
  took: number;
  status: number | string;
}

async function main() {
  const started = Date.now();
  const samples: Sample[] = [];
  let tick = 0;

  while (Date.now() - started < SECONDS * 1000) {
    tick++;
    const due = started + tick * EVERY_MS;
    const wait = due - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const before = Date.now();
    let status: number | string;
    try {
      const res = await fetch(`${BASE}/api/usage/cli`, { signal: AbortSignal.timeout(30_000) });
      await res.arrayBuffer();
      status = res.status;
    } catch (err) {
      status = err instanceof Error ? err.message : String(err);
    }
    const done = Date.now();
    samples.push({
      at: new Date(before).toISOString(),
      late: done - due,
      took: done - before,
      status,
    });
  }

  const byLate = [...samples].sort((a, b) => b.late - a.late);
  const lates = samples.map((s) => s.late).sort((a, b) => a - b);
  const at = (q: number) => lates[Math.min(lates.length - 1, Math.floor(lates.length * q))];

  console.log(`${samples.length} 回、${EVERY_MS}ms ごと、${SECONDS} 秒`);
  console.log(`遅れ: 中央 ${at(0.5)}ms / 95% ${at(0.95)}ms / 99% ${at(0.99)}ms / 最大 ${byLate[0]?.late}ms`);
  console.log('\n遅れた上位10:');
  for (const s of byLate.slice(0, 10)) {
    console.log(`  ${s.at}  遅れ ${String(s.late).padStart(6)}ms  往復 ${String(s.took).padStart(6)}ms  ${s.status}`);
  }
  // 塊で止まっているのか、単発なのか。原因の当たりが変わる。
  const runs: Array<{ from: string; count: number; worst: number }> = [];
  for (const s of samples) {
    if (s.late < 500) continue;
    const last = runs[runs.length - 1];
    const previous = samples[samples.indexOf(s) - 1];
    if (last && previous && previous.late >= 500) {
      last.count++;
      last.worst = Math.max(last.worst, s.late);
    } else {
      runs.push({ from: s.at, count: 1, worst: s.late });
    }
  }
  console.log(`\n500ms 以上の遅れが続いた区間: ${runs.length}`);
  for (const r of runs) console.log(`  ${r.from} から ${r.count} 回、最大 ${r.worst}ms`);
}

main();
