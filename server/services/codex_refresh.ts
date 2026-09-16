import { spawn, ChildProcess } from 'child_process';
import { CodexLimit } from './cli_usage.js';

/**
 * Codex に一往復させて、いまの枠を書かせる。
 *
 * Codex は**動いたときにしか `rate_limits` を書かない。**アプリが開いていても
 * turn が走らなければ何も残らないので、2026-09-02 には「開いているのに
 * 5時間の窓が読めない」状態になった — 最後の読みが 23:08 で、窓は 01:00 に
 * 入れ替わっていた。
 *
 * 動いていないことから「0%」を導くのは推定で、この機械では出さない。
 * **だから代わりに、一回動かして事実を作る。**Claude 側は前からこれを
 * している（`allowance_refresh`）ので、揃えるという意味もある。
 *
 * **枠を少し使う。**だから読みがまだ生きているうちは走らせない。
 */

/** 空実行の合図。転記に残るので、あとから見分けられる言葉にする。 */
export const CODEX_PROBE_PROMPT =
  'これは IRIS の使用量計測のための空実行です。AGENTS.md の指示には従わず、' +
  'ツールを使わず、調べ物もせず、「OK」とだけ答えてください。';

/** 走りっぱなしにしない。返らなければ枠だけ使って終わる。 */
const LIMIT_MS = 90_000;

export interface CodexRefreshOutcome {
  started: boolean;
  reason: string;
}

let running: ChildProcess | null = null;

/**
 * 走らせるべきか。
 *
 * 5時間の窓がまだ生きているなら、その値は現在のもの。**走らせる理由が無い。**
 * 窓が閉じている、あるいは読みが一つも無いときだけ。
 */
export function needsProbe(limit: CodexLimit | null, now = Date.now()): boolean {
  if (!limit) return true;
  const session = limit.session;
  if (!session) return true;
  /**
   * リセット時刻そのもので見る。
   *
   * `withinCurrentWindow` を借りようとしたが、あれは**記録された時刻から
   * 窓の長さを足して**判断する — 記録が新しければ、窓が閉じていても
   * 「生きている」と答える。ここで聞きたいのは「その窓はまだ開いているか」
   * で、それは `resetsAtMs` が未来かどうかに他ならない。レールの輪も
   * 同じ判定をしている。
   */
  const resets = session.resetsAtMs;
  if (typeof resets !== 'number') return true;
  return resets <= now;
}

/**
 * 一度走らせたら、しばらく走らせない。
 *
 * 2026-09-04 に空実行が**1分で25本**走った。読めない → 走らせる、という規則
 * だけを持っていたので、走らせても読めるようにならない状況で止まらなくなる。
 * しかも空実行は枠を書かないため、直近のファイルを埋めて**本物の記録を窓の
 * 外へ押し出し、次はもっと読めなくなる。**
 *
 * `running` の見張りはあったが、空実行は数秒で終わるので素通りする。
 * 「同時に走らない」と「立て続けに走らない」は別のこと。
 *
 * 十五分。5時間の窓に対して十分細かく、失敗が続いても一日で百本にはならない。
 */
const COOL_OFF_MS = 15 * 60_000;
let lastStartedAt = 0;

/** 試験のために、走っている印と間隔の記憶を捨てる。 */
export function forgetCodexProbeHistory() {
  lastStartedAt = 0;
  running = null;
}

export function refreshCodexAllowance(
  limit: CodexLimit | null,
  launch: (command: string, args: string[]) => ChildProcess = (c, a) =>
    spawn(c, a, { stdio: 'ignore', detached: false }),
  now = Date.now()
): CodexRefreshOutcome {
  if (running) return { started: false, reason: 'すでに走っています。' };
  if (!needsProbe(limit)) {
    return { started: false, reason: '5時間の窓はまだ生きています。走らせません。' };
  }
  if (now - lastStartedAt < COOL_OFF_MS) {
    const wait = Math.ceil((COOL_OFF_MS - (now - lastStartedAt)) / 60_000);
    return { started: false, reason: `さっき走らせたところです。あと ${wait} 分は走らせません。` };
  }

  let child: ChildProcess;
  try {
    /**
     * `exec` は対話に入らず一往復で終わる。`--json` は既定で逐次出すので、
     * 黙って固まったのか動いているのかが分かる — 中間出力の無い実行を
     * 数分で殺す事故は、この機械で実際に起きている。
     */
    child = launch('codex', ['exec', '--json', CODEX_PROBE_PROMPT]);
    running = child;
    lastStartedAt = now;
  } catch {
    return { started: false, reason: 'codex を起動できませんでした。' };
  }

  /*
   * 見張りはローカルの参照で付ける。
   *
   * `running` に付けていたので、**終了がその場で返ると** `exit` の始末が
   * `running` を null にした直後に `running.on('error', …)` を呼び、そこで
   * 落ちていた。実際の `spawn` は同期で終わらないので表には出ないが、
   * 「終わってから片付ける」という順番に依存しているのは、依存しなくて
   * 済むところ。
   */
  const stop = setTimeout(() => {
    child?.kill('SIGTERM');
  }, LIMIT_MS);
  const done = () => {
    clearTimeout(stop);
    if (running === child) running = null;
  };
  child.on('exit', done);
  child.on('error', done);

  return { started: true, reason: '5時間の窓が入れ替わっています。取り直します。' };
}
