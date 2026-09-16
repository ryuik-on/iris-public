/**
 * Compares IRIS's daily focus against the dashboard it was ported from.
 *
 * The same selection rules now exist twice — once in the FDP dashboard's
 * Python and once in IRIS's TypeScript — and two implementations of one rule
 * drift. That is not avoidable here: the Python version works, runs every
 * morning, and is not mine to delete. What is avoidable is the drift being
 * invisible.
 *
 * So this runs both and compares the decisions, not the prose. Identifiers
 * only: comparing rendered text would compare presentation, and the two
 * deliberately present differently — the same work row shows as "W003" in one
 * and by its 内容 column in the other while being the same row.
 *
 *   npm run focus:compare
 */
import 'dotenv/config';
import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { promisify } from 'util';

const run = promisify(execFile);

const FDP_DIR = process.env.IRIS_FDP_DIR ?? join(homedir(), 'Documents/Founder-Development-Program');
const IRIS_URL = process.env.IRIS_URL ?? 'http://localhost:3002';

/** Identifiers the dashboard prints in brackets, per area. */
const PATTERNS: Array<{ area: string; label: string; re: RegExp }> = [
  { area: 'study', label: '学習', re: /\[(T\d{3}[A-Za-z]?)\]/ },
  { area: 'os', label: 'MedRecall / OS', re: /\[(TSK-\d{3})\]/ },
  { area: 'work', label: '仕事', re: /\[(W\d{3})\]/ },
];

async function fdpSelections(): Promise<{ ok: boolean; ids: Record<string, string>; error?: string }> {
  const script = join(FDP_DIR, 'today.py');
  if (!existsSync(script)) {
    return { ok: false, ids: {}, error: `today.py が見つかりません: ${script}` };
  }
  try {
    const { stdout } = await run('/usr/bin/python3', [script], { cwd: FDP_DIR, timeout: 120_000 });
    const ids: Record<string, string> = {};
    for (const { area, re } of PATTERNS) {
      // First match only: the dashboard prints the chosen item before the
      // runner-up it labels 次.
      const match = stdout.match(re);
      if (match) ids[area] = match[1];
    }
    return { ok: true, ids };
  } catch (err: any) {
    return { ok: false, ids: {}, error: err?.message ?? String(err) };
  }
}

async function irisSelections(): Promise<{ ok: boolean; ids: Record<string, string>; error?: string }> {
  try {
    const response = await fetch(`${IRIS_URL}/api/focus`, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) return { ok: false, ids: {}, error: `HTTP ${response.status}` };
    const body: any = await response.json();
    const ids: Record<string, string> = {};
    for (const item of body.items ?? []) {
      if (item.id) ids[item.area] = item.id;
    }
    return { ok: true, ids };
  } catch (err: any) {
    return { ok: false, ids: {}, error: err?.message ?? String(err) };
  }
}

async function main() {
  const [fdp, iris] = await Promise.all([fdpSelections(), irisSelections()]);

  console.log('=== 日次フォーカスの一致確認 ===\n');

  if (!fdp.ok) {
    console.log(`FDP 側を実行できません: ${fdp.error}`);
    // Not a divergence. Being unable to compare and disagreeing are different
    // results, and only one of them means something is wrong with the rules.
    process.exitCode = 2;
    return;
  }
  if (!iris.ok) {
    console.log(`IRIS 側に問い合わせできません: ${iris.error}`);
    console.log('常駐サービスが動いているか確認してください（npm run launchd:status）。');
    process.exitCode = 2;
    return;
  }

  let diverged = 0;
  let compared = 0;

  for (const { area, label } of PATTERNS) {
    const a = fdp.ids[area];
    const b = iris.ids[area];
    if (!a && !b) {
      console.log(`  ${label.padEnd(16)} 両方とも該当なし`);
      continue;
    }
    if (!a || !b) {
      // One picked something and the other picked nothing. That is a real
      // disagreement about whether there is anything to do.
      console.log(`  ${label.padEnd(16)} ✗ 片方だけ選出  FDP=${a ?? '-'}  IRIS=${b ?? '-'}`);
      diverged++;
      continue;
    }
    compared++;
    if (a === b) {
      console.log(`  ${label.padEnd(16)} ✓ ${a}`);
    } else {
      console.log(`  ${label.padEnd(16)} ✗ 不一致  FDP=${a}  IRIS=${b}`);
      diverged++;
    }
  }

  console.log();
  if (diverged === 0) {
    console.log(`${compared} 領域で選択が一致しています。`);
    return;
  }
  console.log(`${diverged} 領域で選択が分かれています。`);
  console.log('どちらかの規則が変わったか、片方だけが更新されています。');
  console.log('規則の正本は FDP 側（today.py）です — 先にそちらを読んでから直してください。');
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(err?.message ?? err);
  process.exitCode = 2;
});
