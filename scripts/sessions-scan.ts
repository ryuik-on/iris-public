/**
 * セッション一覧の走査を、別プロセスで。
 *
 * `readSessions` は同期で、直近12時間の記録（65本・499 MB、うち一本 165 MB —
 * 実測 2026-09-15）を毎回読む。サーバの中で走らせると十数秒凍り、その間は
 * カレンダーもパネルも応答しない。**凍らせないために、ここで走る。**
 *
 * 引数：<home> <hours>。結果は JSON を一行で標準出力へ。
 */
import { readSessions } from '../server/services/sessions.js';

const home = process.argv[2] || process.env.HOME || '';
const hours = Number(process.argv[3]) || 12;
process.stdout.write(JSON.stringify(readSessions(home, hours)));
