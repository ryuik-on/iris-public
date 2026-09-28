/**
 * CLI の使用量の掃き直しを、別プロセスで。
 *
 * `CliUsageService.read()` は「待たせない」つもりで掃き直しを `setTimeout(0)` に
 * 預けていた。**待たないのは頼んだ人だけで、他の全員は待つ。**同じ一本の輪で
 * 走るので、掃いている数秒はサーバ全体が止まる。
 *
 * 実測 2026-09-28。外から 100ms ごとに叩いて、180秒のうち **最大 1.7秒の遅れが
 * 二度**。遅れた回の往復そのものが遅れの全部で、後続はその後ろに並んだだけ
 * だった —— 塞いでいたのは掃き直しで、通信ではない。
 *
 * 読む量は 7 日ぶんの転記 197 本・4.7 GB。うち一本は**このセッションが書いている
 * 108 MB** で、書き足されるので mtime と大きさの記憶が効かない。それが毎回の
 * 1.7秒。空の記憶から読むと 5〜7秒。
 *
 * `scripts/sessions-scan.ts` と同じ形。**走る場所を変えるだけで、数え方は
 * 変えない** —— 読み手もサーバと同じものを渡す。
 *
 * 記憶はディスクに残す。別プロセスは毎回空から始まるので、残さないと
 * 「1.7秒の凍結」を「7秒ぶんの CPU」に取り替えただけになる。
 *
 * 引数：<home> [windowHours]。結果は JSON を一行で標準出力へ。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CliUsageService, type TranscriptMemo } from '../server/services/cli_usage.js';
import { readTranscript } from '../server/services/agent_meter.js';

const home = process.argv[2] || process.env.HOME || '';
const hours = Number(process.argv[3]) || 7 * 24;
const MEMO = join(home, '.iris', 'cli-usage-memo.json');

function loadMemo(): TranscriptMemo {
  try {
    return new Map(JSON.parse(readFileSync(MEMO, 'utf8')));
  } catch {
    // 無い・壊れているなら空から。**読めなかったことは、読み直せば済む。**
    return new Map();
  }
}

function saveMemo(entries: Array<[string, unknown]>): void {
  try {
    mkdirSync(dirname(MEMO), { recursive: true });
    writeFileSync(MEMO, JSON.stringify(entries));
  } catch {
    // 残せなくても数えた結果は返す。次が遅くなるだけ。
  }
}

const memo = loadMemo();
/*
 * サーバ側と同じ読み手を渡す。**数え方が二つあると、片方だけ直した日にずれる。**
 */
const service = new CliUsageService(
  home,
  (path) => {
    const reading = readTranscript(path);
    return { usage: reading.usage, model: reading.model, messages: reading.messages };
  },
  hours * 60 * 60 * 1000,
  // 自分で掃くのがこのプロセスの仕事なので、頼む先は渡さない。
  undefined,
  memo
);
const value = service.sweepNow();
saveMemo(service.memoEntries());
process.stdout.write(JSON.stringify(value));
