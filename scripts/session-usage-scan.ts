/**
 * 使用量の内訳（プロジェクト別）の走査を、別プロセスで。
 *
 * `GET /api/allowance/breakdown` は `readSessionUsage` を**毎回、同期で、
 * キャッシュ無しで**呼んでいた。読むのは 7 日ぶんの転記 197 本・4.7 GB。
 * 実測 2026-09-28: 一回の要求で **10.2秒** サーバ全体が止まった。
 *
 * `scripts/sessions-scan.ts` と `scripts/cli-usage-scan.ts` と同じ形。
 * **走る場所を変えるだけで、数え方は変えない。**
 *
 * 引数：<home> [days]。結果は JSON を一行で標準出力へ。
 */
import { readSessionUsage } from '../server/services/session_usage.js';

const home = process.argv[2] || process.env.HOME || '';
const days = Number(process.argv[3]) || 7;
process.stdout.write(JSON.stringify(readSessionUsage(home, days)));
