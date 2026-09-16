import { execFile } from 'child_process';

/**
 * Pushes this repository, so that a dead disk is not the end of the work.
 *
 * The remote was created on 2026-08-22 and immediately raised the question it
 * was meant to answer: a remote only holds what someone remembered to push,
 * so a machine that dies at four in the afternoon loses the afternoon. This
 * pushes on a timer instead.
 *
 * What it does not do is decide anything. It sends commits that already
 * exist; the review point is the commit, not the push. That distinction is
 * what makes automating this safe — and it is also why the working tree being
 * dirty is not checked. Uncommitted work is not backed up here and never was.
 *
 * The agent push ban is untouched. Delegated coding agents run with
 * `GIT_ALLOW_PROTOCOL=file`, which stops them at the transport layer whatever
 * they type; this runs in the server's own environment, in the main worktree.
 */

export interface RepoBackupState {
  branch: string | null;
  /** Commits on this branch that the remote does not have. */
  unpushed: number | null;
  lastPushAt: string | null;
  lastAttemptAt: string | null;
  /**
   * Why the last attempt failed, if it did.
   *
   * The whole point of the field. A backup that stops working stops writing
   * anything, and silence reads exactly like success — which is the failure
   * this project is named after.
   */
  lastError: string | null;
  /** True while a push is in flight, so a slow network does not stack them. */
  running: boolean;
}

const state: RepoBackupState = {
  branch: null,
  unpushed: null,
  lastPushAt: null,
  lastAttemptAt: null,
  lastError: null,
  running: false,
};

function git(cwd: string, args: string[], timeoutMs = 60_000): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: timeoutMs, maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
      resolve({ ok: !error, out: (stdout + stderr).trim() });
    });
  });
}

export function repoBackupState(): RepoBackupState {
  return { ...state };
}

/**
 * 最後に押した時刻を、git 自身から読む。
 *
 * 上の `state` はこのプロセスの記憶なので、**再起動で消える。**消えると
 * `lastPushAt` が `null` に戻り、画面には「一度も押していない」と区別の
 * 付かない形で出る —— 実際には数分前に押していても。**沈黙が成功と同じ顔を
 * する**という、この仕組みが名指しで避けているはずの形。
 *
 * 事実はディスクにある。遠隔追跡 ref の reflog に `update by push` として
 * 残っていて（実測 2026-09-08: `7260369 … @{2026-09-08 05:12:53 +0900}:
 * update by push`）、プロセスより長く生きる。**記憶より、こちらを先に見る。**
 *
 * 読めなければ `null` を返す。**「読めない」を「押していない」に化かさない**
 * ために、呼ぶ側は記憶の方と突き合わせる。
 */
export async function lastPushFromReflog(cwd: string, branch: string): Promise<string | null> {
  const log = await git(cwd, [
    'reflog', 'show', '--date=iso-strict', `refs/remotes/origin/${branch}`,
  ]);
  if (!log.ok || !log.out) return null;
  for (const line of log.out.split('\n')) {
    if (!line.includes('update by push')) continue;
    const at = /@\{([^}]+)\}/.exec(line);
    if (!at) continue;
    const ms = Date.parse(at[1]);
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  return null;
}

/**
 * 画面に出す一式。**記憶とディスクを突き合わせる。**
 *
 * `lastPushAt` は新しい方を採る。このプロセスが押していればそれが最新だが、
 * 再起動直後や、別の窓から押したときはディスクの方が新しい。
 */
export async function repoBackupReading(cwd: string): Promise<RepoBackupState> {
  const held = repoBackupState();
  const branch = held.branch ?? (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).out;
  if (!branch || branch === 'HEAD') return held;
  const onDisk = await lastPushFromReflog(cwd, branch);
  if (!onDisk) return { ...held, branch };
  const held0 = held.lastPushAt ? Date.parse(held.lastPushAt) : 0;
  return {
    ...held,
    branch,
    lastPushAt: Date.parse(onDisk) > held0 ? onDisk : held.lastPushAt,
  };
}

/**
 * Counts what is unpushed, and pushes it if there is any.
 *
 * Reading the count first costs one local command and means an idle
 * repository never touches the network. It is also the number worth showing:
 * "how much would be lost right now" is the question a backup answers.
 */
export async function backUpRepository(cwd: string, now = () => Date.now()): Promise<RepoBackupState> {
  if (state.running) return repoBackupState();
  state.running = true;
  // Snapshotted after the work, not during it: every `return` inside the try
  // below ran before `finally` cleared the flag, so a finished push reported
  // itself as still running.
  state.lastAttemptAt = new Date(now()).toISOString();

  try {
    await attempt(cwd, now);
  } finally {
    state.running = false;
  }
  return repoBackupState();
}

async function attempt(cwd: string, now: () => number): Promise<void> {
  {
    const branch = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (!branch.ok || !branch.out || branch.out === 'HEAD') {
      state.lastError = 'ブランチを特定できません（detached HEAD かもしれません）。';
      return;
    }
    state.branch = branch.out;

    const remote = await git(cwd, ['remote']);
    if (!remote.ok || !remote.out) {
      state.lastError = 'リモートが設定されていません。';
      state.unpushed = null;
      return;
    }

    /**
     * Counted against the remote-tracking ref, not the remote itself.
     *
     * `git fetch` on every tick would be a network round trip to learn
     * something that only changes when this machine pushes. The ref is stale
     * only if somebody else pushed, and then the push below fails loudly
     * rather than quietly doing nothing.
     */
    const ahead = await git(cwd, ['rev-list', '--count', `origin/${state.branch}..HEAD`]);
    const count = ahead.ok ? Number(ahead.out) : NaN;
    // A branch the remote has never seen has no such ref; that is not zero.
    state.unpushed = Number.isFinite(count) ? count : null;

    if (state.unpushed === 0) {
      state.lastError = null;
      return;
    }

    const push = await git(cwd, ['push', '-u', 'origin', state.branch], 120_000);
    if (push.ok) {
      state.lastPushAt = new Date(now()).toISOString();
      state.lastError = null;
      state.unpushed = 0;
    } else {
      // Kept verbatim. A push fails for reasons that matter — no credentials,
      // a rejected non-fast-forward, no network — and they want different
      // things done about them.
      state.lastError = push.out.split('\n').slice(-3).join(' ').slice(0, 300) || 'push に失敗しました。';
    }
  }
}

/**
 * Every fifteen minutes.
 *
 * Slow enough that an idle repository costs nothing, and short enough that
 * the worst case — a disk dying with unpushed work — is a quarter of an hour
 * rather than a day. The first run is immediate, because the interesting case
 * is a machine that has just been turned back on.
 */
export function startRepoBackup(cwd: string, minutes = 15): NodeJS.Timeout {
  void backUpRepository(cwd);
  const timer = setInterval(() => void backUpRepository(cwd), minutes * 60_000);
  timer.unref?.();
  return timer;
}
