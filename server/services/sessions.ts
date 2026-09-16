import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { PROBE_PROMPT } from './allowance_refresh.js';
import { CODEX_PROBE_PROMPT } from './codex_refresh.js';

/**
 * Prompts that mean "this was IRIS asking itself a question".
 *
 * `1` is the prompt the refresh used before it was given a name, and those
 * transcripts are still on disk and still being reported as abandoned
 * sessions. Listing it is not a guess: a session whose only turn is the
 * single character `1` is one of mine.
 */
const PROBE_TITLES = new Set([
  PROBE_PROMPT,
  '1',
  /**
   * What the probe used to say, before it had to explain itself.
   *
   * The prompt changed on 2026-08-26 and the transcripts it already wrote did
   * not. Dropping this line would make two days of IRIS's own probes start
   * reporting themselves as abandoned sessions — the same mistake as `1`
   * above, made again by tidying.
   */
  'IRIS usage probe',
  /**
   * Codex の空実行。**こちらには照合そのものが無かった。**
   *
   * Claude 側だけ弾いていたので、三十分ごとの Codex の空実行が 46 件、
   * 人のセッションとして並んでいた。片方だけ塞いだ穴は、塞いだつもりに
   * なるぶん、塞いでいないより悪い。
   */
  CODEX_PROBE_PROMPT,
]);
import { join } from 'path';

/**
 * Every coding session on this machine, and how long since it last moved.
 *
 * The dashboard could say where the *ledger* stood and nothing about the work
 * actually happening — which is several Claude Code and Codex sessions running
 * at once, in different repositories, some of them waiting on a person who has
 * forgotten they are waiting. Seeing that meant opening each one.
 *
 * Progress as a percentage is not available and is not invented here. What a
 * session exposes is when it last wrote something, and that turns out to be
 * the thing worth showing: a session that has not moved in twenty minutes is
 * either finished or stuck, and both are worth noticing. The elapsed time is
 * the reading, not a stand-in for one.
 *
 * Both transcript formats are private implementation details of tools that did
 * not agree to keep them stable. So every field is optional in practice and a
 * session that cannot be read is reported as unreadable rather than skipped —
 * a list that quietly omits what it could not parse looks like a quieter day.
 */

/**
 * What a session is actually doing, which is not the same as how long it has
 * been quiet.
 *
 * Elapsed time alone conflates three different situations — a session that
 * just answered and is waiting for a reply, one that is mid-task, and one that
 * stopped somewhere it should not have. They want different things from a
 * person, and a single "90 minutes" number tells you which one it is exactly
 * never.
 *
 * The transcript does say. The last record with a role in it is either the
 * assistant finishing its turn — in which case it is waiting — or a tool
 * result or a request, in which case it was working when it last wrote. That,
 * crossed with silence, separates working from stuck.
 */
export type Doing =
  /** Wrote something within the last few minutes and was mid-task. */
  | 'working'
  /** Finished its turn. Nothing will happen until a person says something. */
  | 'waiting'
  /** Was mid-task and has written nothing since. Worth going to look at. */
  | 'stalled'
  /** The transcript could not be read well enough to say. */
  | 'unknown';

export interface Session {
  id: string;
  /** `claude` or `codex`. */
  kind: 'claude' | 'codex';
  /** The repository or directory it is working in, as a short name. */
  place: string;
  /**
   * 作業しているディレクトリの絶対パス。記録の各行が持つ `cwd` の最後のもの。
   *
   * `place` は `slug` から機械的に作った短い名で、**衝突する**（名前に `-` を
   * 含む資料入れは切り分けられない）。課題の作業場所と突き合わせるには
   * 本物の道が要る（2026-09-11、課題とセッションの紐付け）。読めなければ null。
   */
  cwd: string | null;
  /** What it was first asked to do. The nearest thing to a title. */
  title: string | null;
  /** Last time anything was written to it. */
  lastAt: string;
  /** Minutes since then. */
  idleMinutes: number;
  /**
   * How long the turn in flight has been going, for a session that is working.
   *
   * `idleMinutes` is zero while an agent is mid-answer, which is exactly when
   * a person wants to know how long they have been waiting — so it says
   * nothing at the one moment it matters. This is measured from the last
   * thing the user said, which is when the wait started from their side.
   */
  busyMinutes: number | null;
  doing: Doing;
  turns: number;
  /**
   * Background work this session started that still looks alive.
   *
   * Inferred, and worth saying so. A launch is recorded — `async_launched`
   * with a description — and a completion is not, so "still running" cannot be
   * read anywhere; what can be read is whether the task's output file has been
   * written to recently. Recent writes mean something is producing output.
   * Silence means finished, or stuck, and this cannot tell them apart.
   */
  background: number;
  /**
   * Claude が自分に付けている名前。`iris-70` のような。
   *
   * これまで出していたのは `place` — 作業しているディレクトリ名で、この機械
   * では大半が `iris` になる。**「iris が返答待ち」が三つ並ぶと、どれのことか
   * 分からない。**名前は Claude Code が起動ごとに付けていて、セッション同士が
   * 呼び合うときにも使っている。同じものを出せば、画面とやりとりが一致する。
   */
  name: string | null;
  /**
   * 人が読める作業名。Claude 自身の画面に出ているのと同じもの。
   *
   * `name` とは別。あちらはディレクトリから作った識別子で、こちらは
   * 「部室予約UI mark7 引き継ぎ」のような、何をしているかを言う名前。
   * **無いことがある。そのときは `null`** — 作らない。
   */
  work: string | null;
  /** 最後に頼まれたこと。いま何をしているかに、いちばん近い観測。 */
  doingNow: string | null;
  /**
   * その道具に「これを開け」と言うための id。**丸ごとの UUID。**
   *
   * `id` は画面に出すために8文字へ切ってあり、**再開には使えない**
   * — Codex に至っては切り出しているのが UUID ですらなく、記録の時刻だった
   * （`rollout-2026-09-01T20-16-16-<uuid>.jsonl` の前半）。
   */
  resume: string | null;
  /**
   * その処理がまだ生きているか。
   *
   * `~/.claude/sessions/<pid>.json` が残っていて、そのプロセスが実在すること。
   * 記録だけ残って窓が閉じているものは、**終わったもの**であって待っている
   * ものではない。
   */
  live: boolean;
}

/**
 * 走っている Claude の索引。
 *
 * `~/.claude/sessions/<pid>.json` に `sessionId` と `name` が入っている。
 * これは Claude Code の私的な置き場で、契約ではない — 読めなければ名前が
 * 出ないだけで、**読めなかったことを「名無し」として確定させない。**
 */
export function liveClaudeSessions(
  home: string,
  alive: (pid: number) => boolean = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
): Map<string, { name: string | null; live: boolean }> {
  const found = new Map<string, { name: string | null; live: boolean }>();
  const dir = join(home, '.claude', 'sessions');
  if (!existsSync(dir)) return found;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    try {
      const record = JSON.parse(readFileSync(join(dir, entry), 'utf-8'));
      const id: unknown = record?.sessionId;
      if (typeof id !== 'string') continue;
      const pid = Number(record?.pid);
      const live = Number.isFinite(pid) ? alive(pid) : false;
      const name = typeof record?.name === 'string' ? record.name : null;
      // 同じ sessionId で複数あれば、生きている方を採る。
      const held = found.get(id.slice(0, 8));
      if (held?.live && !live) continue;
      found.set(id.slice(0, 8), { name, live });
    } catch {
      continue;
    }
  }
  return found;
}

export interface SessionsRead {
  sessions: Session[];
  /** Files that exist and could not be understood. Never silently dropped. */
  unreadable: number;
}

/**
 * Background tasks belonging to one session that have written recently.
 *
 * Claude Code puts each backgrounded command's output under a directory named
 * for the session. A file touched in the last few minutes is a task still
 * producing something; one that has been quiet is done or wedged, and nothing
 * here distinguishes those — the transcript records the launch and never the
 * end.
 *
 * Five minutes rather than one: a task can be waiting on something slow
 * without writing, and calling that finished would undercount exactly the runs
 * worth noticing.
 */
function backgroundFor(sessionId: string, project: string, now: number): number {
  const root = join('/private/tmp', `claude-${process.getuid?.() ?? 501}`, project, sessionId, 'tasks');
  if (!existsSync(root)) return 0;
  try {
    return readdirSync(root).filter((name) => {
      if (!name.endsWith('.output')) return false;
      try {
        return now - statSync(join(root, name)).mtimeMs < 5 * 60_000;
      } catch {
        return false;
      }
    }).length;
  } catch {
    return 0;
  }
}

/** `-Users-example-Documents-Codex-2026-07-28-medrecall` → `medrecall`. */
function placeFromSlug(slug: string): string {
  const cleaned = slug.replace(/^-Users-[^-]+-/, '');
  const parts = cleaned.split('-').filter((p) => p && !/^\d+$/.test(p));
  return parts[parts.length - 1] ?? cleaned;
}

/** The first thing a person actually asked for, ignoring machinery. */
function titleFrom(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith('<') || trimmed.startsWith('Caveat:')) return null;
  return trimmed.slice(0, 60);
}

function readClaude(home: string, sinceMs: number, now: number): SessionsRead {
  const index = liveClaudeSessions(home);
  const root = join(home, '.claude', 'projects');
  if (!existsSync(root)) return { sessions: [], unreadable: 0 };

  const sessions: Session[] = [];
  let unreadable = 0;

  for (const slug of readdirSync(root)) {
    const dir = join(root, slug);
    // Worktrees are the agent's own scratch copies, not sessions a person is
    // running. Counting them would double every dispatched run.
    /**
     * Agent worktrees are not sessions anybody is watching.
     *
     * `--claude-worktrees-` is Claude Code's own; `-IRIS-worktrees-` is the
     * one this server creates for delegated runs. Both hold a session that is
     * an agent doing a job, and both are already reported by
     * `/api/agent/runs` with a task attached to them.
     *
     * Left in, the band said "9cb2683c が 7分 反応していません" — a run id, which
     * names nothing a person recognises, about work that had a name and an
     * owner somewhere else on the same screen. `placeFromSlug` takes the last
     * path component, and for a worktree that component is the run id.
     */
    if (slug.includes('--claude-worktrees-') || slug.includes('-IRIS-worktrees-')) continue;
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }

    for (const name of files) {
      const path = join(dir, name);
      let stat;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      if (stat.mtimeMs < sinceMs) continue;
      const idle = Math.max(0, Math.round((now - stat.mtimeMs) / 60000));

      let title: string | null = null;
      let turns = 0;
      /**
       * The last record that had a speaker. Metadata lines — titles, modes,
       * attachments — are written after the fact and would otherwise be read
       * as the session's final act.
       */
      let lastSpoke: { role: string; ended: boolean } | null = null;
      /**
       * 人が読める作業名と、いま何を頼まれているか。
       *
       * `name`（`iris-fd`）は cwd から機械的に作られたもので、**作業名では
       * ない**（索引の `nameSource` が `derived` と言っている）。転記には
       * 人が付けた `custom-title` と、生成された `ai-title` が入っていて、
       * これが Claude 自身の画面に出ている名前。`last-prompt` は最後に
       * 頼まれたことで、いま何をしているかにいちばん近い。
       *
       * **どれも無ければ何も出さない。**最初のプロンプトで代用すると、
       * パスやコマンドがそのまま画面に出る。
       */
      let customTitle: string | null = null;
      let cwd: string | null = null;
      let aiTitle: string | null = null;
      let lastPrompt: string | null = null;
      let lastAskedAt: number | null = null;
      /** 最初の発言を、切らずに。合図と突き合わせるのはこちら。 */
      let firstSaid: string | null = null;
      try {
        const text = readFileSync(path, 'utf-8');
        for (const line of text.split('\n')) {
          if (!line.trim()) continue;
          let record: any;
          try {
            record = JSON.parse(line);
          } catch {
            continue;
          }
          // 話者のある行だけを見る `continue` より前で拾う。**題名の行には
          // 役割が無い**ので、後ろに置くと一度も届かない。
          if (typeof record?.cwd === 'string' && record.cwd) cwd = record.cwd;
          if (record?.type === 'custom-title' && typeof record.customTitle === 'string') {
            customTitle = record.customTitle;
          }
          if (record?.type === 'ai-title' && typeof record.aiTitle === 'string') {
            aiTitle = record.aiTitle;
          }
          if (record?.type === 'last-prompt' && typeof record.lastPrompt === 'string') {
            lastPrompt = record.lastPrompt;
          }

          const role = record?.message?.role;
          if (role === 'user' || role === 'assistant') {
            const stop = record.message.stop_reason;
            lastSpoke = { role, ended: stop === 'end_turn' || stop === 'stop_sequence' };
          }
          if (role !== 'user') continue;
          // The clock a person is actually watching starts when they ask.
          const asked = Date.parse(record?.timestamp ?? '');
          if (Number.isFinite(asked)) lastAskedAt = asked;
          const content = record.message.content;
          const said =
            typeof content === 'string'
              ? content
              : Array.isArray(content)
                ? content.map((c: any) => c?.text ?? '').join(' ')
                : '';
          const candidate = titleFrom(said);
          if (!candidate) continue;
          turns++;
          if (!title) title = candidate;
          // 切る前の言葉も残す。**合図との照合は、切る前で行う。**
          if (firstSaid === null) firstSaid = said.trim();
        }
      } catch {
        unreadable++;
        continue;
      }

      /**
       * IRIS's own usage probe is not a session anybody is waiting on.
       *
       * The allowance is refreshed by starting a real Claude Code session and
       * killing it once the figure arrives, which leaves a transcript of one
       * turn that never finished — indistinguishable, from here, from a
       * session somebody abandoned. The band reported it as "iris が 27分
       * 反応していません", about itself, which is worse than saying nothing:
       * it is a false alarm that arrives every fifteen minutes.
       */
      /*
       * 照合は**切る前の言葉で**。
       *
       * ここは `titleFrom` を通した値を見ていた — 60文字で切った文字列を、
       * 切っていない合図と比べていたことになる。合図が短かったうちは通って
       * いて、2026-08-26 にプロンプトが説明を含む長文になった日から、
       * **現行の空実行は一度も一致していなかった。**古い `1` と
       * `IRIS usage probe` だけが当たり続けていたので、フィルタは動いている
       * ように見えていた。
       *
       * 症状は盤に出た: 三十分ごとの空実行が「終了した作業」として並び、
       * 消しても消しても戻ってきた。
       */
      if (turns === 1 && (PROBE_TITLES.has(firstSaid ?? '') || PROBE_TITLES.has(title ?? ''))) continue;

      const doing = decide(lastSpoke, idle);
      const id = name.replace('.jsonl', '').slice(0, 8);
      const known = index.get(id);
      sessions.push({
        id,
        name: known?.name ?? null,
        live: known?.live ?? false,
        resume: name.replace('.jsonl', ''),
        work: customTitle ?? aiTitle ?? null,
        doingNow: lastPrompt,
        kind: 'claude',
        place: placeFromSlug(slug),
        cwd,
        title,
        lastAt: new Date(stat.mtimeMs).toISOString(),
        idleMinutes: idle,
        busyMinutes:
          doing === 'working' && lastAskedAt !== null
            ? Math.max(0, Math.round((now - lastAskedAt) / 60_000))
            : null,
        doing,
        turns,
        background: backgroundFor(name.replace('.jsonl', ''), slug, now),
      });
    }
  }

  return { sessions, unreadable };
}

/**
 * Three states from two facts.
 *
 * An assistant that ended its turn is waiting, however long ago that was —
 * time does not change what it is waiting for. Anything else was mid-task when
 * it last wrote, so silence is the question: a few minutes is a tool running,
 * and much more than that is something that stopped.
 */
function decide(last: { role: string; ended: boolean } | null, idleMinutes: number): Doing {
  if (!last) return 'unknown';
  if (last.role === 'assistant' && last.ended) return 'waiting';
  return idleMinutes <= 4 ? 'working' : 'stalled';
}

function readCodex(home: string, sinceMs: number, now: number): SessionsRead {
  const root = join(home, '.codex', 'sessions');
  if (!existsSync(root)) return { sessions: [], unreadable: 0 };

  const sessions: Session[] = [];
  let unreadable = 0;

  const walk = (dir: string, depth: number) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const path = join(dir, name);
      let stat;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        if (depth < 3) walk(path, depth + 1);
        continue;
      }
      if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue;
      if (stat.mtimeMs < sinceMs) continue;

      const idle = Math.max(0, Math.round((now - stat.mtimeMs) / 60000));
      let title: string | null = null;
      let place = 'codex';
      let cwdSeen = '';
      let turns = 0;
      // Codex says the same thing in its own words: an `agent_message` is the
      // assistant having spoken, and a tool call or a user message is not.
      let lastSpoke: { role: string; ended: boolean } | null = null;
      /**
       * 人が読める作業名と、いま何を頼まれているか。
       *
       * `name`（`iris-fd`）は cwd から機械的に作られたもので、**作業名では
       * ない**（索引の `nameSource` が `derived` と言っている）。転記には
       * 人が付けた `custom-title` と、生成された `ai-title` が入っていて、
       * これが Claude 自身の画面に出ている名前。`last-prompt` は最後に
       * 頼まれたことで、いま何をしているかにいちばん近い。
       *
       * **どれも無ければ何も出さない。**最初のプロンプトで代用すると、
       * パスやコマンドがそのまま画面に出る。
       */
      let customTitle: string | null = null;
      let aiTitle: string | null = null;
      let lastPrompt: string | null = null;
      let lastAskedAt: number | null = null;
      /** 最初の発言を、切らずに。合図と突き合わせるのはこちら。 */
      let firstSaid: string | null = null;
      /** 既に数えた発言。記録の重複を発言の重複と取り違えないため。 */
      const saidBefore = new Set<string>();
      try {
        const text = readFileSync(path, 'utf-8');
        for (const line of text.split('\n')) {
          if (!line.trim()) continue;
          let record: any;
          try {
            record = JSON.parse(line);
          } catch {
            continue;
          }
          const cwd = record?.payload?.cwd ?? record?.cwd;
          if (typeof cwd === 'string' && cwd) {
            cwdSeen = cwd;
            place = cwd.split('/').pop() ?? place;
          }
          const kind = record?.payload?.type;
          /**
           * Codex says outright when a turn is over, and this was not reading it.
           *
           * On 2026-08-26 the band reported nine Codex sessions as unresponsive,
           * one of them for eleven hours. Every one of the nine ends with a
           * `task_complete` event, eight of them on the literal last line: they
           * had all finished cleanly. Nothing was stuck. The completion was
           * written down and IRIS was looking at a different line.
           *
           * Two ways it was missed. The end-of-turn marker is an `event_msg`
           * rather than a message, so the message-shaped checks never saw it;
           * and the assistant's closing text arrives as a `message` carrying
           * `role: assistant`, which is not the `agent_message` this knew about.
           * Either one alone would have covered this case, and both are real,
           * so both are read.
           */
          if (kind === 'task_complete') lastSpoke = { role: 'assistant', ended: true };
          else if (kind === 'agent_message') lastSpoke = { role: 'assistant', ended: true };
          else if (kind === 'message' && record?.payload?.role === 'assistant') {
            lastSpoke = { role: 'assistant', ended: true };
          } else if (kind === 'user_message') lastSpoke = { role: 'user', ended: false };
          else if (kind === 'function_call' || kind === 'custom_tool_call') {
            lastSpoke = { role: 'assistant', ended: false };
          }
          /**
           * 記録の形が二つある。
           *
           * 古い方は `type: 'user_message'` に `message` が入っていて、新しい
           * 方は `role: 'user'` に `content: [{text}]` が入る。**古い方しか
           * 見ていなかったので、最近の Codex は題名を一つも持っていなかった**
           * — そして題名の無い行は盤に出さないので、Codex は丸ごと消えていた。
           */
          const asUser =
            kind === 'user_message' ||
            record?.payload?.role === 'user';
          if (!asUser) continue;
          const body = record.payload.message ?? record.payload.content;
          const said = Array.isArray(body)
            ? body.map((part: any) => part?.text ?? '').join(' ')
            : String(body ?? '');
          // 差し込まれた前置き（推奨プラグイン一覧、添付ファイルの目録）は
          // 人が書いたものではない。題名にしない。
          const injected = said.trimStart().startsWith('#');
          const candidate = injected ? null : titleFrom(said);
          if (!candidate) continue;
          /*
           * **同じ発言が二度記録される。**
           *
           * Codex は一つのプロンプトを二つの形で書く — `payload.type` が
           * `user_message` の出来事と、`payload.role` が `user` の項目。
           * 記録の数を数えると、一度しか喋っていない対話が「二回」になる。
           *
           * 「発言が一度だけなら IRIS の空実行」という判定がそれで外れて、
           * 三十分ごとの空実行が 46 件、人のセッションとして並んでいた。
           * 数えるのは記録ではなく、**言われたこと**。
           */
          const body2 = said.trim();
          if (saidBefore.has(body2)) continue;
          saidBefore.add(body2);
          turns++;
          if (!title) title = candidate;
          if (firstSaid === null) firstSaid = body2;
        }
      } catch {
        unreadable++;
        continue;
      }

      // Claude 側と同じ規則。IRIS が自分に投げた空実行は、誰も待っていない。
      if (turns === 1 && PROBE_TITLES.has(firstSaid ?? '')) continue;

      /**
       * Same rule as the Claude reader: a session inside an agent worktree is
       * an agent doing a job, and it is reported by `/api/agent/runs` with the
       * task it belongs to. Here the give-away is the directory rather than
       * the slug, because Codex records its own `cwd`.
       */
      if (cwdSeen.includes('/IRIS/worktrees/')) continue;

      sessions.push({
        id: name.slice(8, 27),
        kind: 'codex',
        place,
        cwd: cwdSeen || null,
        title,
        lastAt: new Date(stat.mtimeMs).toISOString(),
        idleMinutes: idle,
        busyMinutes: null,
        doing: decide(lastSpoke, idle),
        name: null,
        /**
         * Codex には、開いているかを言う索引が無い。
         *
         * Claude は `~/.claude/sessions/<pid>.json` があるので窓が開いて
         * いるか分かるが、Codex は記録しか残さない。**分からないので、
         * 直近に書かれたかで代える。**これは観測ではなく推定。**
         *
         * 30分にしたら Claude より厳しくなりすぎた — あちらは窓が開いて
         * いれば三時間黙っていても出るのに、Codex は52分で消えた。**同じ
         * 一覧に並ぶものが、道具ごとに違う基準で消えるのはおかしい。**
         * 二時間にする。Codex の CLI は終われば消えるので「開いている」と
         * いう状態がそもそも無く、ここが言えるのは「最近まで動いていた」
         * だけ。
         */
        live: idle <= 120,
        // 末尾の36文字が UUID。`codex resume <uuid>` が受け取る形。
        resume: name.replace('.jsonl', '').slice(-36),
        work: null,
        doingNow: null,
        turns,
        // Codex does not use this directory, so there is nothing to look at.
        background: 0,
      });
    }
  };

  walk(root, 0);
  return { sessions, unreadable };
}

/**
 * Sessions touched within `hours`, most recently active first.
 *
 * Bounded because both directories keep everything forever, and a list that
 * includes last month is not a list of what is happening.
 */
export function readSessions(home: string, hours = 12, now = Date.now()): SessionsRead {
  const since = now - hours * 3600_000;
  const claude = readClaude(home, since, now);
  const codex = readCodex(home, since, now);
  return {
    sessions: [...claude.sessions, ...codex.sessions].sort(
      (a, b) => a.idleMinutes - b.idleMinutes
    ),
    unreadable: claude.unreadable + codex.unreadable,
  };
}
