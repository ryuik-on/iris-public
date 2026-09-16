import { existsSync, readdirSync, statSync, openSync, readSync, closeSync } from 'fs';
import { join } from 'path';
import { TokenUsage, EMPTY_USAGE, addUsage, estimateCost } from '../core/usage.js';

/**
 * What the coding assistants on this machine have used, read from their own
 * files.
 *
 * IRIS pays for its own model calls and can price them exactly. Claude Code and
 * Codex are flat-rate subscriptions billed to a person, not to an API key, so
 * the interesting number there is not money — it is how much of an allowance
 * is left. Those are different units and this keeps them apart; putting a
 * percentage next to a dollar figure invites reading one as the other.
 *
 * The two assistants leave very different amounts behind, and the difference
 * decides what can honestly be shown:
 *
 * Codex writes its rate limits into every session rollout — used percent, the
 * window in minutes, and when it resets. That is the real figure from the
 * server, so it can be reported as such.
 *
 * Claude Code writes token counts and nothing about limits. Searching every
 * transcript for `used_percent` or `resets_at` returns hits only inside
 * conversation text; as a structured field it does not exist. So there is no
 * weekly figure to show and this does not invent one. Tokens are reported and
 * the allowance is reported as unknown, which is the honest shape.
 *
 * Both of these read private files that are not a contract. Anything
 * unreadable is reported as unreadable rather than as zero — a meter that
 * reads zero when it is broken looks like a quiet week.
 */

export interface CodexWindow {
  usedPercent: number;
  windowMinutes: number;
  resetsAtMs: number | null;
}

export interface CodexLimit {
  planType: string | null;
  usedPercent: number;
  /** Length of the window this percentage is measured over. */
  windowMinutes: number;
  /** When the window rolls over, in epoch milliseconds. */
  resetsAtMs: number | null;
  /**
   * When Codex wrote this, in epoch milliseconds.
   *
   * The figure is only as current as the last time Codex ran. Reported so the
   * reader can say how old it is instead of presenting last week's percentage
   * as today's.
   */
  recordedAtMs: number | null;
  source: string;
  /** 同じ記録に入っている短い方の窓。週と混同しないよう、別の欄に置く。 */
  session: CodexWindow | null;
  /**
   * この記録を書いた実行系。`session_meta.originator`。
   *
   * **同じ場所に別々の契約の記録が混ざる**ので、どれが書いたかを持ち歩く。
   * 実測 2026-09-07: `Codex Desktop`（CLI 0.151.0-alpha.7.2）は plan_type=plus
   * で5時間と週の両方を書き、`codex_exec`（CLI 0.153.4）は plan_type=prolite で
   * 週だけを書く。混ざったまま「最新の読み」を勝たせると、レールの数字が
   * 数分おきに別の契約のものへ入れ替わる。同じ日に、週が 68% と 2% の間で
   * 行き来していた。
   */
  originator: string | null;
  /** どの計器か。`rate_limits.limit_id`。口座ぜんたいの枠は `codex`。 */
  limitId: string | null;
}

export interface ClaudeTokens {
  usage: TokenUsage;
  sessions: number;
  messages: number;
  /** Priced where a model is known; a subscription does not bill this way. */
  indicativeUsd: number;
  /** Always null. Claude Code does not record an allowance anywhere local. */
  usedPercent: null;
  sinceMs: number;
}

export interface CliUsage {
  codex: CodexLimit | null;
  codexReason: string | null;
  claude: ClaudeTokens | null;
  claudeReason: string | null;
  checkedAt: string;
}

/** Bytes of a rollout to read from the end when looking for the last limits. */
const TAIL_BYTES = 512 * 1024;

/** How long a reading stands before a refresh is started behind it. */
const REFRESH_MS = 5 * 60_000;

/**
 * The last `rate_limits` in a chunk of Codex rollout JSONL.
 *
 * Pure, and separated from the reading so it can be tested against a fixture
 * rather than against whatever happens to be on the machine.
 *
 * Scanned from the end: a rollout carries one of these per turn and only the
 * last is current. The first line of a tail is usually a fragment, which is
 * why an unparseable line is skipped rather than treated as the end.
 */
export function parseCodexLimit(text: string, source = '', originator: string | null = null): CodexLimit | null {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line || !line.includes('rate_limits')) continue;
    let record: any;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const limits = record?.payload?.rate_limits ?? record?.rate_limits;
    if (!limits) continue;

    /*
     * 名前の付いた計器は、口座の枠ではない。
     *
     * 実測 2026-09-07: 同じロールアウトに `limit_id: "codex_bengalfox"` /
     * `limit_name: "GPT-5.3-Codex-Spark"` という**特定の模型だけの枠**が
     * 混ざる。形は口座の枠と同じ（5時間＋週）で、値は 0% ——ほとんど使って
     * いない模型なので当然だが、**そのまま出すと「Codex は 0%」になる。**
     *
     * 2026-08-27 に別のセッションから「Codex は普通に動いているのに IRIS が
     * 0% と言う」と報告があったのは、おそらくこれ。形では見分けられない
     * ——見分けるのは `limit_name` が付いているかどうか。
     *
     * `limit_id` ではなく `limit_name` で弾くのは、**名前の一覧をこちらが
     * 持たずに済む**から。新しい模型が増えても、名前が付いていれば同じ扱いに
     * なる。口座ぜんたいの枠には名前が無い（25193件すべて null）。
     */
    if (typeof limits.limit_name === 'string' && limits.limit_name.trim()) continue;

    /**
     * The weekly window, chosen by its length rather than by its position.
     *
     * Codex reports two: `primary` and `secondary`. Which one is the week is
     * not fixed. Measured 2026-08-28:
     *
     *   primary   used  4%  window   300 minutes  (five hours)
     *   secondary used 16%  window 10080 minutes  (a week)
     *
     * This read `primary` and called it the week. So the figure IRIS has been
     * showing as 「今週」, routing delegations on, and refusing unattended runs
     * against was the five-hour meter — which resets five times a day. That is
     * the whole of the mystery behind a Codex figure that read 100% in the
     * afternoon and 6% in the evening, and behind two separate reports of it
     * sitting at 0%.
     *
     * Picked as the window nearest a week rather than as `secondary`, because
     * the same reasoning that made `primary` wrong would make `secondary`
     * wrong the day they swap. A payload with no weekly window at all is
     * reported as no reading — the five-hour figure is not a worse answer to
     * the weekly question, it is an answer to a different one.
     */
    const WEEK_MINUTES = 7 * 24 * 60;
    const windows = [limits.primary, limits.secondary].filter(
      (w: any) => w && typeof w.used_percent === 'number' && typeof w.window_minutes === 'number'
    );
    const weekly = windows
      .slice()
      .sort(
        (a: any, b: any) =>
          Math.abs(a.window_minutes - WEEK_MINUTES) - Math.abs(b.window_minutes - WEEK_MINUTES)
      )[0];
    // Half a week is the nearest thing to a boundary that is not arbitrary:
    // the two windows Codex reports differ by a factor of thirty.
    if (!weekly || Math.abs(weekly.window_minutes - WEEK_MINUTES) > WEEK_MINUTES / 2) continue;

    /**
     * The shorter window too, kept beside the weekly one.
     *
     * Not to be confused with it — the confusion is what this file spent a day
     * on — but a person looking at a rail wants both: the week says whether
     * there is room this week, the five hours say whether there is room now.
     * Chosen as the window furthest from a week, which is the same rule read
     * the other way round.
     */
    const session = windows
      .slice()
      .sort(
        (a: any, b: any) =>
          Math.abs(b.window_minutes - WEEK_MINUTES) - Math.abs(a.window_minutes - WEEK_MINUTES)
      )[0];

    const stamp = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN;
    return {
      planType: typeof limits.plan_type === 'string' ? limits.plan_type : null,
      usedPercent: weekly.used_percent,
      windowMinutes: weekly.window_minutes,
      // Epoch seconds in the file; milliseconds everywhere in this codebase.
      resetsAtMs: typeof weekly.resets_at === 'number' ? weekly.resets_at * 1000 : null,
      recordedAtMs: Number.isNaN(stamp) ? null : stamp,
      source,
      originator,
      limitId: typeof limits.limit_id === 'string' ? limits.limit_id : null,
      session:
        session && session !== weekly
          ? {
              usedPercent: session.used_percent,
              windowMinutes: session.window_minutes,
              resetsAtMs: typeof session.resets_at === 'number' ? session.resets_at * 1000 : null,
            }
          : null,
    };
  }
  return null;
}

/** Every rollout under a Codex sessions tree, newest by modification first. */
function rolloutsByRecency(root: string, limit: number): string[] {
  const found: Array<{ path: string; at: number }> = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 4) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(dir, name);
      let info;
      try {
        info = statSync(full);
      } catch {
        continue;
      }
      if (info.isDirectory()) walk(full, depth + 1);
      else if (name.endsWith('.jsonl')) found.push({ path: full, at: info.mtimeMs });
    }
  };
  walk(root, 0);
  found.sort((a, b) => b.at - a.at);
  return found.slice(0, limit).map((f) => f.path);
}

/** The last `TAIL_BYTES` of a file, as text. */
function readTail(path: string, bytes: number): string {
  const size = statSync(path).size;
  const from = Math.max(0, size - bytes);
  const length = size - from;
  if (length <= 0) return '';
  const buf = Buffer.alloc(length);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buf, 0, length, from);
  } finally {
    closeSync(fd);
  }
  return buf.toString('utf-8');
}

/**
 * 誰が書いたロールアウトか。`session_meta` はファイルの**先頭**にある。
 *
 * 尾しか読んでいないので、そこには無い。頭を少しだけ別に読む —— 数キロバイトで、
 * 40本開いても安い。読めなければ `null` で、**「分からない」を「同じもの」の
 * 代わりに使わない。**
 */
function readOriginator(path: string): string | null {
  try {
    /*
     * 頭を 64KB 読む。8KB では足りなかった。
     *
     * `session_meta` には `base_instructions.text` —— Codex の人格や作法を
     * 書いた長い文章 —— が丸ごと入っており、**一行目だけで数万バイトある。**
     * 8KB では途中で切れて JSON にならず、実測ではどのファイルからも
     * `originator` が取れなかった（切れていることは例外にならないので、
     * 静かに null になる）。
     */
    const size = statSync(path).size;
    const length = Math.min(size, 64 * 1024);
    if (length <= 0) return null;
    const buf = Buffer.alloc(length);
    const fd = openSync(path, 'r');
    try {
      readSync(fd, buf, 0, length, 0);
    } finally {
      closeSync(fd);
    }
    const head = buf.toString('utf-8');
    const first = head.split('\n')[0];
    try {
      const record = JSON.parse(first);
      const meta = record?.payload ?? record;
      if (typeof meta?.originator === 'string') return meta.originator;
    } catch {
      // 一行目が入りきらなかった場合に落ちてくる。下で拾う。
    }
    /*
     * それでも切れているときのために、頭の中から直接探す。
     *
     * **これは表示のための添え物で、判断には使っていない**ので、緩い読み方で
     * 構わない。ここで null を返しても選び方は変わらず、「どの実行系か」が
     * 言えなくなるだけ。
     */
    const found = /"originator"\s*:\s*"([^"]{1,120})"/.exec(head);
    return found ? found[1] : null;
  } catch {
    return null;
  }
}

/**
 * Codex's weekly allowance, from the most recent session that recorded one.
 *
 * A few files are tried rather than only the newest: the latest rollout may be
 * a session that ended before any limits came back, and stopping there would
 * report "no data" while a perfectly good figure sat one file over.
 */
/**
 * Whether a reading belongs to the window it claims to describe.
 *
 * A rollout file keeps every rate-limit line a session ever received, and a
 * long-lived session's file goes on being appended for days — so the last such
 * line in the newest file is not necessarily from the current week. Measured
 * 2026-08-23: the figure served as "this week" was 82%, and the records
 * carrying 82–86% are timestamped 2026-08-22T20:29Z, before the window that
 * began 2026-08-23T03:53Z. Last week's exhaustion was being reported as this
 * week's.
 *
 * It is not a cosmetic error. `SPENT_PERCENT` is 90, so a stale 86 sits one
 * bad reading away from routing every dispatch off an agent that is in fact
 * 41% used — and the unattended budget refuses runs on the same number.
 *
 * The window start is derived rather than assumed: `resets_at` minus
 * `window_minutes` is where this week began, and both travel with the reading.
 * When either is missing there is nothing to check against, and the reading
 * stands — an unverifiable figure is not the same as a wrong one.
 */
export function withinCurrentWindow(limit: CodexLimit): boolean {
  if (limit.resetsAtMs === null || !limit.windowMinutes || limit.recordedAtMs === null) return true;
  return limit.recordedAtMs >= limit.resetsAtMs - limit.windowMinutes * 60_000;
}

/**
 * How many rollouts to open before giving up.
 *
 * Six was enough when the newest file with a limit was the answer. Now that
 * every candidate is read so the newest *reading* can win, the window has to
 * be wide enough to see past files that were touched without recording one —
 * on 2026-08-27 six of the most recently modified rollouts carried no
 * rate_limits at all.
 */
/*
 * 40件。もとは12件だった。
 *
 * 空実行を飛ばすようにすると、12件では**全部が空実行という日が実際にある**
 * （2026-09-04 は8:25に25本並んだ）。飛ばした先に本物が無ければ、飛ばした
 * 意味が無い。尾を読むだけなので、40件でも安い。
 */
const CODEX_TRIES = 40;

/**
 * IRIS 自身の空実行かどうか。
 *
 * **空実行は枠を書かない。**一往復で終わるので `rate_limits` は null のまま
 * で、それが直近のファイルを埋めると、枠を持っている本物のセッションが
 * 窓の外へ押し出される。
 *
 * 2026-09-04 に実際にそうなった。8:25 に空実行が25本並び、直近12件が全部
 * それになって「上限の記録がありません」。読めないと空実行がまた走る規則
 * なので、**走らせるほど読めなくなる。**自分で悪化する輪だった。
 *
 * 判定は転記の中身で行う。ファイル名や時刻では、人が同じ言葉で始めた
 * セッションと区別が付かない。
 */
function isOwnProbe(text: string): boolean {
  return text.includes(PROBE_MARK);
}

/** 空実行の合図。`codex_refresh.ts` と `allowance_refresh.ts` の両方に共通する頭。 */
const PROBE_MARK = 'これは IRIS の使用量計測のための空実行です';

export function readCodexLimit(home: string, tries = CODEX_TRIES): { limit: CodexLimit | null; reason: string | null } {
  const root = join(home, '.codex', 'sessions');
  if (!existsSync(root)) return { limit: null, reason: 'Codex のセッション記録が見つかりません。' };

  const files = rolloutsByRecency(root, tries);
  if (files.length === 0) return { limit: null, reason: 'Codex のセッション記録が空です。' };

  /**
   * The newest *reading*, not the newest file.
   *
   * The first version returned the first limit it found while walking files by
   * modification time, which is not the same thing: a long-lived session keeps
   * its rollout open and touches it for other reasons, so a file can be the
   * most recently written while the last rate-limit line inside it is hours
   * old. Several of today's rollouts were touched at 20:00 and carry no
   * rate_limits at all.
   *
   * Reported 2026-08-27 by another session: IRIS said Codex was at 0% while
   * Codex was in fact running normally. A stale or freshly-opened session's
   * reading was winning on file time.
   *
   * So every candidate is read and the one with the newest timestamp wins.
   */
  let stale = 0;
  let skippedProbes = 0;
  let best: CodexLimit | null = null;
  /** 5時間と週の**両方**を書いている読みのうち、いちばん新しいもの。 */
  let complete: CodexLimit | null = null;
  for (const path of files) {
    try {
      const tail = readTail(path, TAIL_BYTES);
      // 自分の空実行は数に入れない。**枠を持たないものが窓を埋めると、
      // 持っているものが見えなくなる。**
      if (isOwnProbe(tail)) {
        skippedProbes++;
        continue;
      }
      const found = parseCodexLimit(tail, path, readOriginator(path));
      if (!found) continue;
      // From a window that has already reset. Skipped rather than shown: a
      // figure from last week is worse than none, because it reads as this
      // week's and nothing about it looks wrong.
      if (!withinCurrentWindow(found)) {
        stale++;
        continue;
      }
      if (!best || (found.recordedAtMs ?? 0) > (best.recordedAtMs ?? 0)) best = found;
      /*
       * 両方の窓を書いている読みは、別に取っておく。
       *
       * **同じ場所に、形の違う記録が混ざる。**実測 2026-09-07: `Codex Desktop`
       * は5時間と週の両方を書き、`codex_exec` は週だけを書く（契約が別で、
       * 片方に5時間の窓が無い）。「最新の読み」だけで決めると、直前に動いた
       * 方の数字が出る —— 同じ日に、週が 68% と 2% の間を7回行き来していた。
       *
       * **空欄より悪い。**5時間が消えるのは目に見えるが、週が別の契約の
       * 2% に化けるのは、正しい数字と見分けが付かない。
       */
      if (found.session && (!complete || (found.recordedAtMs ?? 0) > (complete.recordedAtMs ?? 0))) {
        complete = found;
      }
    } catch {
      // Try the next one; an unreadable file is not an answer.
    }
  }
  /*
   * 揃っている読みを優先する。
   *
   * 契約の名前では選ばない。**名前で選ぶと、契約を変えた日に壊れる** ——
   * `plus` を名指しした実装は、利用者が pro へ移った時点で何も選べなくなる。
   * 「5時間と週の両方を書いているか」は形の話なので、名前が変わっても続く。
   *
   * 揃った読みが一つも無ければ、週だけの読みを返す。そのときは
   * `session` が null になり、レールは5時間を空欄にする —— **無い窓を
   * 空欄で出すのは正しい。**別の記録から借りてきて埋めるのが間違い。
   */
  if (complete) return { limit: complete, reason: null };
  if (best) {
    return {
      limit: best,
      reason: best.session
        ? null
        : `5時間の窓を持つ記録が直近にありません（いまの読みは ${best.originator ?? '不明な実行系'} / ${best.planType ?? '契約不明'}）。`,
    };
  }
  // 何を見て、何を飛ばしたのかまで言う。「記録がありません」だけだと、
  // 記録が無いのか、こちらが見ていないのかが分からない。
  const looked = files.length - skippedProbes;
  const aside = skippedProbes ? `（IRIS 自身の空実行 ${skippedProbes} 件を除く）` : '';
  return {
    limit: null,
    reason: stale
      ? `直近 ${looked} 件${aside}のうち ${stale} 件は前の期間の記録で、今期の上限は見つかりません。`
      : `直近 ${looked} 件${aside}のセッションに上限の記録がありません。`,
  };
}

/**
 * Claude Code's tokens over a window, across every project on the machine.
 *
 * Only transcripts touched inside the window are opened, which is what keeps
 * this from reading a few hundred files on every request. A session that began
 * earlier and is still being written counts in full: the file has no reliable
 * per-message timestamp to slice on, and over-reporting a session that is
 * genuinely active is better than pretending the tokens are not there.
 */
export function readClaudeTokens(
  home: string,
  sinceMs: number,
  readTranscript: (path: string) => { usage: TokenUsage | null; model: string | null; messages: number },
  /**
   * Per-file memo, keyed by modification time and size.
   *
   * A cold sweep of a week of transcripts measured 7.7 seconds — they are
   * large and there are dozens. Almost none of them change between sweeps, so
   * re-parsing them is the entire cost. Keyed on mtime and size rather than
   * path alone: a file being appended to is a different file for this purpose,
   * and that is exactly the one that must not be served from memory.
   */
  memo?: Map<string, { key: string; usage: TokenUsage | null; model: string | null; messages: number }>
): { tokens: ClaudeTokens | null; reason: string | null } {
  const root = join(home, '.claude', 'projects');
  if (!existsSync(root)) return { tokens: null, reason: 'Claude Code の転記が見つかりません。' };

  let usage: TokenUsage = { ...EMPTY_USAGE };
  let sessions = 0;
  let messages = 0;
  let usd = 0;
  let opened = 0;

  let projects: string[];
  try {
    projects = readdirSync(root);
  } catch (err: any) {
    return { tokens: null, reason: `転記の一覧を読めません: ${err?.message ?? err}` };
  }

  for (const project of projects) {
    const dir = join(root, project);
    let files: string[];
    try {
      if (!statSync(dir).isDirectory()) continue;
      files = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of files) {
      if (!name.endsWith('.jsonl')) continue;
      const full = join(dir, name);
      try {
        if (statSync(full).mtimeMs < sinceMs) continue;
      } catch {
        continue;
      }
      opened++;
      let reading: { usage: TokenUsage | null; model: string | null; messages: number };
      let key = '';
      try {
        const info = statSync(full);
        key = `${info.mtimeMs}:${info.size}`;
      } catch {
        key = '';
      }
      const remembered = key ? memo?.get(full) : undefined;
      if (remembered && remembered.key === key) {
        reading = remembered;
      } else {
        reading = readTranscript(full);
        if (key) memo?.set(full, { key, ...reading });
      }
      if (!reading.usage) continue;
      sessions++;
      messages += reading.messages;
      usage = addUsage(usage, reading.usage);
      if (reading.model) usd += estimateCost(reading.model, reading.usage).usd;
    }
  }

  if (opened === 0) {
    return { tokens: null, reason: 'この期間に Claude Code の記録がありません。' };
  }

  return {
    tokens: { usage, sessions, messages, indicativeUsd: usd, usedPercent: null, sinceMs },
    reason: null,
  };
}

/**
 * Both readings, cached briefly.
 *
 * These touch the filesystem and the UI polls every couple of seconds. A
 * minute is far shorter than either figure moves and far longer than the poll.
 */
export class CliUsageService {
  private cached: CliUsage | null = null;
  private cachedAt = 0;
  private sweeping = false;
  private memo = new Map<string, { key: string; usage: TokenUsage | null; model: string | null; messages: number }>();

  constructor(
    private home: string,
    private readTranscript: (path: string) => { usage: TokenUsage | null; model: string | null; messages: number },
    private windowMs = 7 * 24 * 60 * 60 * 1000
  ) {
    // Warmed at startup so the first person to ask is not the one who waits.
    setTimeout(() => this.sweep(), 0).unref?.();
  }

  /**
   * Never blocks on the filesystem.
   *
   * A cold sweep took 7.7 seconds, and this sits behind a panel that polls
   * every couple of seconds — a request that waits for it would hang the UI
   * for as long as it takes, once per refresh interval, forever. So a request
   * is answered from what is already known and a refresh is started behind it.
   *
   * The answer therefore may be minutes old, which is why `checkedAt` is part
   * of it rather than an implementation detail: a figure whose age is
   * unstated is a figure being presented as current.
   */
  read(now = Date.now()): CliUsage {
    if (!this.cached || now - this.cachedAt >= REFRESH_MS) {
      setTimeout(() => this.sweep(), 0).unref?.();
    }
    return (
      this.cached ?? {
        codex: null,
        codexReason: 'まだ集計していません。',
        claude: null,
        claudeReason: 'まだ集計していません。',
        checkedAt: new Date(now).toISOString(),
      }
    );
  }

  /**
   * 次に聞かれたときに取り直させる。
   *
   * 掃き直しそのものはここでは待たない — 呼び出し側が `read()` を続けて呼ぶと
   * 古い値が一度返るが、**古いことは `checkedAt` に出る。**待たせるかどうかを
   * 決めるのは呼び出し側で、ここが勝手に数秒止めるべきではない。
   */
  invalidate(): void {
    this.cachedAt = 0;
    this.sweep();
  }

  private sweep(now = Date.now()): void {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const codex = readCodexLimit(this.home);
      const claude = readClaudeTokens(this.home, now - this.windowMs, this.readTranscript, this.memo);
      this.cached = {
        codex: codex.limit,
        codexReason: codex.reason,
        claude: claude.tokens,
        claudeReason: claude.reason,
        checkedAt: new Date(now).toISOString(),
      };
      this.cachedAt = now;
    } catch {
      // A failed sweep leaves the previous answer standing, with its own
      // timestamp, rather than replacing it with nothing.
    } finally {
      this.sweeping = false;
    }
  }
}
