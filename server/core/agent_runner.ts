/**
 * Launching a coding agent that nobody is watching.
 *
 * The register held this at EXPLICIT_DECISION_REQUIRED with a recorded
 * conclusion that it should not be built, and the user overrode that on
 * 2026-08-20 after the trade was laid out. What they asked for is the version
 * the earlier design explicitly refused: unattended, with approval relaxed, so
 * work continues while they are asleep. That decision is theirs; this file is
 * about making the parts that can be bounded actually bounded.
 *
 * What is genuinely different from launching by hand — and it is one thing.
 * The user already runs coding agents with these permissions every day, and
 * those runs are unsupervised too. What changes is that nobody is at the
 * keyboard when it starts, so every constraint that used to be "the human will
 * notice" has to become a rule that holds on its own.
 *
 * Four of those, and each exists because the alternative has no floor:
 *
 *   The repository list is exact paths, never patterns. A prefix match on
 *   `~/Documents` is a different permission from four named directories, and
 *   the difference only shows up on the night something walks somewhere
 *   nobody listed.
 *
 *   The command is one shape. The caller supplies a handoff id and nothing
 *   else; argv is assembled here. A tool that accepts a command string is
 *   arbitrary command execution wearing a narrower name, and no amount of
 *   validation on the string changes that.
 *
 *   The environment is built, not inherited. IRIS's process holds Anthropic,
 *   Google and OpenAI keys and an iCloud app password. A plain spawn hands all
 *   of them to the child, which then has every credential IRIS has — and it
 *   would work perfectly, which is why it would never be noticed.
 *
 *   Spend is metered from the child's own transcript, and failure to meter
 *   stops the run. The child bills separately and IRIS's budget service cannot
 *   see it; reading the transcript is the only visibility there is. It depends
 *   on a private file format, so it will break eventually, and when it does
 *   the choice is between a run with no ceiling and no run. On 2026-08-20 a
 *   health check reported everything fine for thirty-one hours because a
 *   dependency that stopped answering left no error behind. Not twice.
 */

export interface AgentPolicy {
  /** Absolute, fully-resolved paths. Exact matches only — no patterns, ever. */
  allowedRepos: string[];
  maxRunMs: number;
  /** USD, measured from the child's own transcript. */
  maxUsdPerRun: number;
  maxConcurrent: number;
  /** Commit on the working branch. Separate from push, which is not the same act. */
  allowCommit: boolean;
  /**
   * Pushing is outbound and irreversible in a way committing is not, so it is
   * never part of an unattended run — the user asked for it only on explicit
   * instruction, which by definition is not unattended.
   */
  allowPushUnattended: boolean;
  /** Work happens on `${branchPrefix}${runId}`, never on an existing branch. */
  branchPrefix: string;
}

export const DEFAULT_POLICY: AgentPolicy = {
  allowedRepos: [],
  maxRunMs: 120 * 60_000,
  maxUsdPerRun: 5,
  maxConcurrent: 1,
  allowCommit: true,
  allowPushUnattended: false,
  branchPrefix: 'agent/',
};

export type RefusalCode =
  | 'repo_not_allowed'
  | 'repo_not_absolute'
  | 'busy'
  | 'dirty_tree'
  | 'no_handoff'
  | 'policy_empty';

export interface Refusal {
  code: RefusalCode;
  message: string;
}

export interface LaunchRequest {
  /** The handoff document to work from. The only thing a caller supplies. */
  handoffId: string;
  /** Resolved absolute path. Resolution happens before this, not inside it. */
  repo: string;
  /** Whether the working tree is clean, as observed by the caller. */
  clean: boolean;
  /** How many runs are already going. */
  running: number;
}

/**
 * Whether a launch may proceed.
 *
 * Returns the reason rather than a boolean. A refusal nobody can read produces
 * a support question at 3am, and the whole point of this path is that nobody
 * is awake.
 */
export function checkLaunch(request: LaunchRequest, policy: AgentPolicy): Refusal | null {
  if (policy.allowedRepos.length === 0) {
    // An empty allowlist means "nothing was authorised", which is the correct
    // reading. Treating it as "no restriction" is how a default becomes a
    // permission nobody granted.
    return {
      code: 'policy_empty',
      message: '許可リポジトリが未設定です。何も許可されていない状態として拒否します。',
    };
  }
  if (!request.handoffId?.trim()) {
    return { code: 'no_handoff', message: '引き継ぎ書のIDがありません。' };
  }
  if (!request.repo.startsWith('/')) {
    return { code: 'repo_not_absolute', message: `絶対パスではありません: ${request.repo}` };
  }
  if (!isAllowedRepo(request.repo, policy)) {
    return {
      code: 'repo_not_allowed',
      message: `許可リストにありません: ${request.repo}`,
    };
  }
  if (request.running >= policy.maxConcurrent) {
    return {
      code: 'busy',
      message: `既に ${request.running} 本が実行中です（上限 ${policy.maxConcurrent}）。`,
    };
  }
  if (!request.clean) {
    // Refused rather than stashed. A stash created while nobody is watching is
    // work that has been moved somewhere the person who wrote it will not look.
    return {
      code: 'dirty_tree',
      message: '作業ツリーに未コミットの変更があります。混ざるため実行しません。',
    };
  }
  return null;
}

/**
 * Exact match against fully-resolved paths.
 *
 * Deliberately not a prefix test. `/Users/x/Documents/iris` starting with an
 * allowed `/Users/x/Documents/ir` is the kind of thing that is obviously wrong
 * when written down and invisible at runtime.
 */
export function isAllowedRepo(repo: string, policy: AgentPolicy): boolean {
  const normalized = stripTrailingSlash(repo);
  return policy.allowedRepos.some((allowed) => stripTrailingSlash(allowed) === normalized);
}

function stripTrailingSlash(p: string): string {
  return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
}

/**
 * The environment the child gets: built from nothing, never inherited.
 *
 * `PATH` and `HOME` are here because a process without them cannot find a
 * binary or a config directory. Everything else is absent by construction — so
 * a credential added to IRIS's environment next month does not silently become
 * something the agent also holds.
 */
export function childEnvironment(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: parent.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: parent.HOME ?? '',
    LANG: parent.LANG ?? 'ja_JP.UTF-8',
    TERM: 'dumb',
    /**
     * `USER` and `LOGNAME`, together.
     *
     * The agent authenticates as itself from its own stored credentials; IRIS
     * never hands over the key it uses. But the first version stripped so much
     * that the agent could not reach its own login either — it exited in three
     * seconds with "Not logged in · Please run /login", and because the child's
     * output was discarded, the reason was nowhere.
     *
     * Measured on 2026-08-20: HOME and PATH alone fail, and so does either of
     * these on its own. Both are needed, which is consistent with the
     * credential living in the macOS Keychain and the lookup wanting a user
     * identity. Nothing else is added — a variable is here because removing it
     * was shown to break the run, not because it seemed harmless.
     */
    USER: parent.USER ?? '',
    LOGNAME: parent.LOGNAME ?? parent.USER ?? '',

    /**
     * The ban on pushing, moved from a string match to the transport layer.
     *
     * `DENIED_TOOLS` holds `Bash(git push*)`, which is a pattern applied to a
     * command line — and a command line has many spellings. `git -c x=y push`,
     * a push inside a script, an alias, a here-doc: each is the same act and
     * none of them match. The pattern is a fence around one spelling.
     *
     * Git itself will refuse a transport that is not on this list, whoever
     * invokes it and however it is written. Measured on 2026-08-21 against a
     * real https remote: unrestricted, git reaches GitHub and reports
     * "Repository not found"; with this set, it stops at "fatal: transport
     * 'https' not allowed" without opening a connection.
     *
     * `file` stays allowed because the worktree talks to its own parent
     * repository over it — removing that breaks the commit the agent is
     * required to make. Nothing reachable over `file` leaves this machine.
     *
     * This also covers the second agent. Codex has no `--disallowedTools`, so
     * a flag-based ban could not have been expressed there at all.
     */
    GIT_ALLOW_PROTOCOL: 'file',

    /** No credential prompt on a run nobody is watching; fail instead of hang. */
    GIT_TERMINAL_PROMPT: '0',

    /**
     * A private scratch directory, because without one git takes a shared one.
     *
     * Every git command in the delegated run of 2026-08-22 printed
     * `confstr() failed with code 5: couldn't get path of DARWIN_USER_TEMP_DIR;
     * using /tmp instead` — twice per invocation, in a transcript that is read
     * to find out what went wrong. The same command run with TMPDIR present
     * prints nothing.
     *
     * The fallback is the part that matters, not the noise. `/tmp` is shared
     * between everything on the machine; the per-user directory macOS hands
     * out is not. An index.lock or a temporary object written to a shared
     * directory by an unattended run is a collision waiting for the night two
     * things run at once.
     */
    TMPDIR: parent.TMPDIR ?? '/tmp',
  };
  return env;
}

/** Every credential-shaped variable that must never reach the child. */
export function leakedCredentials(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env).filter((k) =>
    /API_KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL/i.test(k)
  );
}

/**
 * Tool patterns the agent may never use in an unattended run.
 *
 * Pushing is outbound and cannot be undone by deleting a branch, so it is
 * denied at the CLI rather than left to the agent's judgement. The user asked
 * for push on explicit instruction only, and an unattended run is by
 * definition not that.
 */
export const DENIED_TOOLS = ['Bash(git push*)', 'Bash(gh *)'];

/**
 * The commands an unattended agent may run.
 *
 * `acceptEdits` covers editing files and nothing else — a claim to the
 * contrary was made when this was chosen, and the first live run corrected it:
 * the agent wrote sixty-three good lines and then reported that 「あらゆる
 * スクリプト実行が requires approval で拒否されました」. It could not run
 * `bash -n`, could not run the tests, and could not commit. Its work survived
 * only as uncommitted changes in a worktree, which is one `git worktree
 * remove` from gone.
 *
 * Listed individually rather than as `Bash(git *)`. The wildcard would cover
 * `git push`, and relying on the deny list to win that argument is relying on
 * a precedence rule instead of on not granting the thing.
 *
 * Running the tests is on the list deliberately: an agent that cannot check
 * its own work reports 「未確認」 at best, and at worst reports success it did
 * not verify.
 */
export const ALLOWED_TOOLS = [
  'Edit',
  'Write',
  'Read',
  'Glob',
  'Grep',
  'Bash(git add:*)',
  'Bash(git commit:*)',
  'Bash(git status:*)',
  'Bash(git diff:*)',
  'Bash(git log:*)',
  'Bash(npm test)',
  'Bash(npm run test:*)',
  'Bash(npx tsc:*)',
  'Bash(bash -n:*)',
  /**
   * Building and typechecking, which the handoffs have been asking for and
   * this list did not permit.
   *
   * A handoff written on 2026-08-22 required `npm run build` to pass. Codex
   * ran it, because Codex's confinement is a sandbox and not a list of
   * commands; Claude could not have, and would have had to report the
   * requirement unmet — the same instruction behaving differently depending on
   * which vendor the router happened to pick, for a reason nobody would have
   * looked for.
   *
   * `npm run test:*` does not cover these. It matches `test:speech`, not
   * `typecheck` and not `build`.
   *
   * Named exactly rather than as `npm run *`. The wildcard would include
   * `dev`, which starts a watcher that never exits and would spend the run's
   * whole time limit doing nothing.
   */
  'Bash(npm run build)',
  'Bash(npm run typecheck)',
  'Bash(npm run verify)',
  'Bash(npm run smoke)',
  /** Read-only git, for an agent working out where it is. */
  'Bash(git rev-parse:*)',
  'Bash(git show:*)',
];

/**
 * The command, assembled here.
 *
 * A first version of this invented a `--handoff` flag, which does not exist —
 * caught by reading `claude --help` rather than by a passing test, since a
 * wrong argv typechecks perfectly. The real shape is print mode with an
 * explicit permission mode.
 *
 * `acceptEdits` rather than `bypassPermissions`: file edits proceed without a
 * prompt, and anything more dangerous stops. Unattended, stopping means
 * waiting until the time limit — a night that made no progress, which is the
 * cheaper failure. The tool's own help says `bypassPermissions` is
 * "Recommended only for sandboxes with no internet access", and this machine
 * is neither.
 *
 * The prompt is the handoff document's text, read here from an id. A caller
 * that could pass a path could pass any path, and the argument would stop
 * being an id.
 */
/**
 * What the agent is told beyond the handoff.
 *
 * Committing has to be asked for. The second live run wrote good code, ran
 * `bash -n`, and stopped — the handoff described the change and said nothing
 * about recording it, so the work existed only as uncommitted edits in a
 * worktree, one `git worktree remove` from gone.
 *
 * Kept short and appended rather than folded into the handoff: the handoff is
 * about the task, and this is about the fact that nobody is watching.
 */
export const UNATTENDED_INSTRUCTIONS = [
  '',
  '---',
  '',
  '## この実行について',
  '',
  'あなたは無人で実行されています。利用者は見ていません。',
  '',
  '- 作業が終わったら、**必ず変更をコミットしてください**（`git add` と `git commit`）。',
  '  コミットしなければ、この作業ツリーごと失われます。',
  '- `git push` は禁止されています。実行しないでください。',
  '- 検証できたことと、できなかったことを分けて報告してください。',
  '  実行できなかったコマンドがあれば、それを名指しで書いてください。',
  '- 確認していないことを完了として報告しないでください。',
].join('\n');

/**
 * Which coding agent runs the work.
 *
 * Two, because a second opinion on an implementation is worth more than a
 * faster first one, and because a single vendor's outage or rate limit
 * currently stops all unattended work. They are not interchangeable: the
 * confinement each one offers is built differently, and the differences are
 * recorded on `AGENTS` rather than smoothed over.
 */
export type AgentKind = 'claude' | 'codex' | 'agy';

/**
 * What the argv needs to know beyond the prompt.
 *
 * An object rather than three positional parameters: they are all optional,
 * only some agents use each, and a call site that passes the wrong one
 * positionally typechecks perfectly.
 */
export interface ArgvContext {
  /** The repository's common git directory, for agents confined to a worktree. */
  gitDir?: string;
  /** Whether the agent's commands may open sockets. See `attendedNetwork`. */
  network?: boolean;
  /** Where the work happens. Some agents ignore the process's cwd entirely. */
  workdir?: string;
  /**
   * Which model, for agents that expose a choice. Unset takes the binding's
   * default; an unknown name is the agent's error to report, not IRIS's to
   * guess at.
   */
  model?: string;
}

/**
 * A caller's string, narrowed to an agent this build knows.
 *
 * One place rather than four `=== 'codex' ? 'codex' : 'claude'` expressions.
 * Each of those silently mapped every unknown value onto Claude, which was
 * correct while there were two agents and became a bug the moment there were
 * three: a request for the third one ran on the first and reported nothing
 * unusual.
 */
/**
 * Which model a role deserves, on the agent that offers a choice.
 *
 * One subscription carries several models of very different weight, and
 * sending every job to the same one wastes the plan in both directions: a
 * mechanical check billed at the deepest model, and a deep read done by the
 * fastest one. Spreading the work across them is what makes the plan last
 * without paying for a larger one — which matters here because the ceiling
 * cannot be read, so the only lever is not reaching it.
 *
 * `review` gets Claude Opus, and not only because it is the heaviest. A review
 * is worth most when it does not share the implementer's blind spots, and on
 * this machine the implementer is usually Claude or Gemini — so the reviewer
 * being a different family from whoever wrote the code is the property being
 * bought. When the implementer is itself Claude, name a Gemini model.
 *
 * `verify` gets Flash: checking that stated criteria hold is reading, not
 * judging, and the fast model does it in a third of the time.
 *
 * Anything the caller names wins over all of this. This is a default for
 * work dispatched without a preference, not a policy about what may run.
 */
export function modelForRole(kind: AgentKind, role?: string): string | undefined {
  if (kind !== 'agy') return undefined;
  if (role === 'review') return 'claude-opus-4-6-thinking';
  if (role === 'verify') return 'gemini-3.7-flash-high';
  return undefined; // the binding's default
}

export function asAgentKind(value: unknown): AgentKind {
  return value === 'codex' || value === 'agy' || value === 'claude' ? value : 'claude';
}

export interface AgentBinding {
  kind: AgentKind;
  /** Recorded on the run, matching the values already in `agent_runs.agent`. */
  label: string;
  /** Overridable per agent, so one can be repointed without touching the other. */
  binaryEnvVar: string;
  defaultBinary: (home: string) => string;
  argv: (prompt: string, ctx: ArgvContext) => string[];
  /**
   * Whether a run's spend can be read while it runs.
   *
   * `transcript` means the agent files one and the ceiling is enforced from
   * it; losing the reading stops the run, because a ceiling that cannot be
   * checked is not a ceiling. `none` means there is nothing to read by
   * construction — a subscription CLI that files no cost anywhere — and the
   * distinction matters: a meter that broke and a meter that never existed
   * must not be treated alike, or the second one silently disables the first
   * one's protection. Where there is no meter, the time limit is the bound.
   */
  costMeter: 'transcript' | 'none';
  /** Used when the caller names none. Absent means the agent decides. */
  defaultModel?: string;
  /**
   * Whether commands the agent runs can reach the network.
   *
   * Codex's seatbelt profile denies it by default — measured 2026-08-22:
   * `curl` returns HTTP 000 and exit 6, `ping` loses every packet, and DNS
   * fails at `bind: Operation not permitted`, so it is the socket that is
   * refused rather than any particular protocol.
   *
   * By default. `-c sandbox_workspace_write.network_access=true` opens it —
   * verified in the same session, HTTP 200. The note this replaces said Codex
   * "cannot" reach the network, which turned a setting into a property and
   * would have put a wrong reason in a routing rule. IRIS does not pass that
   * flag: an unattended agent with outbound network is the opposite of the
   * push ban a few lines below, and opening it is a decision for the person
   * whose machine it is, not a default.
   *
   * Claude Code has no equivalent, so its commands run with the network this
   * machine has.
   *
   * The consequence is not only about safety. An agent with no network cannot
   * `npm install`, so a task whose first step is fetching a dependency has to
   * go to Claude — recorded here rather than discovered by a run that fails
   * halfway with a confusing error.
   */
  networkForCommands: 'denied' | 'available';
}

export const AGENTS: Record<AgentKind, AgentBinding> = {
  claude: {
    kind: 'claude',
    label: 'claude-code',
    binaryEnvVar: 'IRIS_AGENT_BINARY',
    defaultBinary: (home) => `${home}/.npm-global/bin/claude`,
    networkForCommands: 'available',
    costMeter: 'transcript',
    argv: (prompt) => [
      '-p',
      `${prompt}${UNATTENDED_INSTRUCTIONS}`,
      '--permission-mode',
      'acceptEdits',
      '--output-format',
      'json',
      '--allowedTools',
      ...ALLOWED_TOOLS,
      /**
       * Kept, though `GIT_ALLOW_PROTOCOL` in the child environment now stops
       * the same act at the transport layer.
       *
       * This is a pattern matched against a command line, and a command line
       * has many spellings — it was never the real fence. It stays because two
       * independent mechanisms failing together is less likely than one, and
       * because a refusal that names `git push` is clearer in a transcript
       * than a transport error.
       */
      '--disallowedTools',
      ...DENIED_TOOLS,
    ],
  },

  codex: {
    kind: 'codex',
    label: 'codex-cli',
    binaryEnvVar: 'IRIS_CODEX_BINARY',
    defaultBinary: (home) => `${home}/.local/bin/codex`,
    networkForCommands: 'denied',
    costMeter: 'transcript',
    /**
     * `--ignore-user-config` で `config.toml` の `model` が消えるので、ここで
     * 名指しする。**空にすると CLI の既定へ静かに落ちる。**
     *
     * `IRIS_CODEX_MODEL` を別に見るのは、**委任と API 呼び出しが同じ契約では
     * ないから。**`OPENAI_MODEL` は IRIS が自分で OpenAI の API を叩くときの
     * 模型で、支払いも別。委任は ChatGPT の購読の枠を使う。片方に合わせて
     * もう片方が動くと、**週の枠を減らしたつもりのない変更が枠を減らす。**
     * 指定が無ければ `OPENAI_MODEL` に揃える（これまでの動き）。
     */
    defaultModel: process.env.IRIS_CODEX_MODEL || process.env.OPENAI_MODEL || 'gpt-5.6-terra',
    /**
     * Codex has no `--disallowedTools`, so nothing here corresponds to
     * `DENIED_TOOLS`. Its confinement is the sandbox instead, which is why
     * `GIT_ALLOW_PROTOCOL` had to move into the environment: a flag-based ban
     * on pushing could not have been written for this agent at all.
     *
     * `workspace-write` confines writes to the working directory, and a
     * worktree's git directory lives under the *parent* repository — so the
     * agent could edit files and then not be able to commit them, losing the
     * work when the worktree was removed.
     *
     * A note here said this had been measured on 2026-08-21 and that `git add`
     * and `git commit` both succeeded. That measurement was wrong, and four
     * consecutive delegated runs finished without committing while the note
     * explained why they should have been fine. Measured properly on
     * 2026-08-22, in a real worktree at
     * ~/Library/Application Support/IRIS/worktrees/:
     *
     *   fatal: Unable to create '<repo>/.git/worktrees/<id>/index.lock':
     *          Operation not permitted
     *
     * Making only the worktree's own git directory writable gets one step
     * further and then fails again — "unable to create temporary file" —
     * because objects are written to the *shared* object store. With the whole
     * common git directory added, the commit lands.
     *
     * That directory being writable is not a new power. Committing is writing
     * to it; the agent was always meant to. `git push` is stopped by
     * `GIT_ALLOW_PROTOCOL=file` in the child environment, at the transport
     * layer, which no amount of filesystem access reaches.
     */
    argv: (prompt, { gitDir, network, model }) => [
      'exec',
      '--json',
      /**
       * `~/.codex/config.toml` を読ませない。**画面操作の橋を閉じるため。**
       *
       * 実測 2026-09-07。無人と同じ設定で走らせた `codex exec` から、
       * computer-use の橋（`mcp__cua_repl.js`）が**呼べた** —— `mcp_tool_call
       * server=cua_repl tool=js` が成功し、「Control native apps and browsers
       * on the user's computer」と書かれた案内が返ってくる。誰も見ていない
       * 実行が、この機械の画面を操作できる口を持っていた。
       *
       * 閉じ方はこれしか見つからなかった。効かなかったもの:
       *
       *   -c mcp_servers={}                                   橋は残る
       *   -c plugins."computer-use@openai-bundled".enabled=false   残る
       *   -c plugins."unified-computer-use@…".enabled=false        残る
       *
       * 橋は `mcp_servers` ではなく `plugins` から来ていて、plugin を名指しで
       * 落としても消えない。`--ignore-user-config` を付けると
       * `TARGET_LOOKUP_FAILED: []` になる。
       *
       * **道連れがある。**config.toml を丸ごと捨てるので、`typescript-lsp` /
       * `pyright-lsp` / `security-guidance` の plugin と、`model` の既定も
       * 一緒に消える。前者は実行が自分で `tsc` や `pyright` を叩けば代わりが
       * 利く。後者はここで `-m` を明示して埋める（そのために `model` を
       * 受け取るようにした）。**画面を操作する口には代わりが無く、無人で
       * 開いている理由も無い。**
       *
       * これは `web.run` には効かない。あれは供給側の道具で、模型 API と同じ
       * 経路で出るので、この機械のどの設定でも塞がらない —— `attendedNetwork`
       * に測った結果がある。**取ってくることと、この機械を操作することは
       * 別の重さ**なので、閉じられる方を閉じる。
       */
      '--ignore-user-config',
      // config.toml を捨てた分、模型を明示する。落とすと CLI の既定に戻る。
      ...(model ? ['-m', model] : []),
      '-s',
      'workspace-write',
      ...(gitDir ? ['--add-dir', gitDir] : []),
      /**
       * One switch, two capabilities — and the second one is why this exists.
       *
       * Measured 2026-08-23, same directory, same probe, only this flag
       * differing:
       *
       *   without   listen(127.0.0.1:5599) → EPERM     curl https://… → 000
       *   with      listen(127.0.0.1:5599) → OK        curl https://… → 200
       *
       * So the seatbelt profile does not distinguish "serve a page to
       * yourself" from "reach the internet". An agent asked to check that a
       * screen still holds together at 375px has to start a dev server to see
       * it, and cannot; on 2026-08-22 one reported exactly that — `listen
       * EPERM` — and returned UI work it had built but never looked at.
       *
       * The consequence is a trade rather than a fix, and it is stated here
       * because it cannot be designed away: giving an agent its own dev server
       * gives it the open internet in the same breath.
       *
       * Which is why this is never on by default and never available to an
       * unattended run. See `attendedNetwork`.
       */
      ...(network ? ['-c', 'sandbox_workspace_write.network_access=true'] : []),
      `${prompt}${UNATTENDED_INSTRUCTIONS}`,
    ],
  },

  /**
   * The third door, and the only one on a different company's subscription.
   *
   * `agy` is the Antigravity CLI. It reaches models the other two cannot —
   * `agy models` on 2026-08-23 listed Gemini 3.7 Flash and 3.1 Pro alongside
   * Claude Sonnet 4.6 and Opus 4.6 — and it draws on a subscription that is
   * neither of the weeks the other two spend. When the Claude week is at 96%,
   * as it was the day this was added, that is the difference between a second
   * opinion and no second opinion.
   *
   * Two things about it are not like the others, both measured rather than
   * assumed.
   *
   * It ignores the process's working directory. Told to edit a file in the
   * directory it was launched from, it answered by listing three unrelated
   * repositories and asking which one was meant. With `--add-dir` naming the
   * directory, the same instruction edited the file and committed in 28.8s.
   * So the worktree is passed explicitly, and so is the common git directory,
   * for the same reason Codex needs it.
   *
   * And it files no cost anywhere this can read. Its conversations are
   * protobuf in per-conversation SQLite files with no token counts in them.
   * That is `costMeter: 'none'` — not a broken meter, an absent one — and the
   * bound on these runs is the time limit. See `shouldStop`.
   *
   * It requires the Antigravity application to be running: `agy` starts no
   * language server of its own (measured — the process count does not change
   * across a run), and without the application the same binary fails with
   * `ANTIGRAVITY_LS_ADDRESS is not set`.
   */
  agy: {
    kind: 'agy',
    label: 'antigravity-cli',
    binaryEnvVar: 'IRIS_AGY_BINARY',
    defaultBinary: (home) => `${home}/.local/bin/agy`,
    /**
     * The application it talks to holds the network, and nothing here confines
     * the commands it runs. Recorded as what it is rather than left blank.
     */
    networkForCommands: 'available',
    costMeter: 'none',
    /**
     * The worktree, and nothing else.
     *
     * The first version also passed the common git directory, copying what
     * Codex needs. That directory is `<repo>/.git`, so handing it over hands
     * over the repository the person is working in — and on 2026-08-23 that is
     * exactly what happened: the run committed `AGY_PROBE.md` onto
     * `feature/reliable-state` in the live checkout instead of into its own
     * worktree. The whole reason a worktree exists here is that the person's
     * branch never moves, and this walked around it.
     *
     * Codex needs that directory because its sandbox denies writes outside the
     * working directory and a worktree's git objects live in the parent. This
     * agent has no such sandbox, so it can write them anyway. Measured after
     * the fix: given only the worktree, it committed inside the worktree and
     * the main checkout did not move.
     */
    /**
     * Gemini by default, because that is the subscription being spent.
     *
     * Left to itself this CLI answers as Claude Sonnet 4.6 — measured, it says
     * so when asked. That is a real option and it costs nothing from the
     * Claude week, but it is not what the plan was bought for, and routing a
     * second opinion to the same family as the first defeats the point of
     * having a third agent at all. `gemini-3.1-pro-high` is the strongest
     * Gemini this subscription lists; 3.7 exists only as Flash.
     *
     * Both were checked on 2026-08-23: 3.1 Pro (High) answered in 18.5s,
     * 3.7 Flash (High) in 10.1s, each naming itself correctly.
     */
    defaultModel: 'gemini-3.1-pro-high',
    argv: (prompt, { workdir, model }) => [
      '--print',
      `${prompt}${UNATTENDED_INSTRUCTIONS}`,
      ...(workdir ? ['--add-dir', workdir] : []),
      ...(model ? ['--model', model] : []),
      /** The counterpart of Claude's `acceptEdits` — but this one runs commands. */
      '--mode',
      'accept-edits',
      '--output-format',
      'text',
    ],
  },
};

export function binaryFor(kind: AgentKind, env: NodeJS.ProcessEnv, home: string): string {
  const binding = AGENTS[kind];
  return env[binding.binaryEnvVar]?.trim() || binding.defaultBinary(home);
}

/**
 * Defaulted to Claude so every existing caller keeps its behaviour, and so the
 * agent that has produced merged work stays the one chosen by omission.
 */
export function buildArgv(
  prompt: string,
  kind: AgentKind = 'claude',
  ctx: ArgvContext = {}
): string[] {
  const binding = AGENTS[kind];
  return binding.argv(prompt, { ...ctx, model: ctx.model ?? binding.defaultModel });
}

/**
 * Whether this run may have a network, given who is watching.
 *
 * The rule is the user's own, stated on 2026-08-22: 「私の見えないところで
 * 動くものに制限をかけていただけで、今みたいにちゃんと私が監督している場所
 * では制限の必要はありません」. Restrictions are for work that runs while
 * nobody is there. A person who starts a run and watches it is already the
 * control that every rule here is a substitute for.
 *
 * So this is not a policy of its own. It is that sentence, written down where
 * the argv is assembled, so that an unattended run cannot acquire outbound
 * network by any caller passing a flag.
 *
 * ---
 *
 * **これが閉じるのはシェルの口だけ。無人の実行は、それでも外に出られます。**
 *
 * 実測 2026-09-07。`codex exec -s workspace-write` を、この関数が無人実行に
 * 対して落としている `sandbox_workspace_write.network_access=true` **無し**で
 * 走らせ、同じ URL を二つの道で取らせた:
 *
 *   シェルの curl   curl: (6) Could not resolve host: api.github.com（終了 6）
 *   模型の web.run  取得成功。stargazers_count 122123 / pushed_at 09:26:26Z
 *                   （同時刻の実値は 122202 / 15:29:17Z。0.06% 差の、少し
 *                   古い値 —— 作り話ではなく、あちら側の控えを引いている）
 *
 * 砂場は**模型が生成したシェル命令**に掛かるもので、模型自身の道具は通らない。
 * `web.run` は Codex の処理が模型 API と話すのと同じ経路で外へ出るので、
 * **外側から網を切ると実行そのものが死ぬ。**切り離せない。
 *
 * 供給側の栓も効かなかった。`-c tools.web_search=false` は `--strict-config`
 * が受け付ける実在のキーだが（`tools.web_search_request` は unknown で弾かれる）、
 * 付けて走らせても `web.run` は同じ値を返した。**この版（codex-cli 0.147.0）に、
 * 模型の外向きを消す栓は無い。**
 *
 * だから、ここで守れているものを正確に書いておく —— **無人の実行が、機械の
 * 網を使って外と話すことは無い。**手元の別の機械やサービスに触りに行くことは
 * できない。**できるのは、あちら側の web 道具を通じて取ってくること、そして
 * URL に載せて持ち出すこと。**この二つは、この関数では止まらない。
 */
export function attendedNetwork(input: { requested?: boolean; unattended?: boolean }): boolean {
  if (input.unattended === true) return false;
  return input.requested === true;
}

/**
 * Git commands run before the agent starts.
 *
 * A worktree, not a checkout. The first version ran `git checkout -b` in the
 * repository itself, which moved the *user's* working branch — on 2026-08-20 a
 * test run left them standing on `agent/f26299d9` instead of the branch they
 * had been on, with nothing to indicate it. Unattended, that happens at 3am
 * and is discovered in the morning.
 *
 * NEXT.md already records the same shape from a previous session: five commits
 * landed on a detached HEAD and 「何も壊れて見えませんでした」. A worktree
 * gives the agent its own directory and its own branch, and the repository the
 * person is using never moves.
 */
export function worktreeSetup(path: string, branch: string): string[][] {
  return [['git', 'worktree', 'add', '-b', branch, path, 'HEAD']];
}

/** Removes the worktree directory, leaving the branch and its commits. */
export function worktreeCleanup(path: string): string[][] {
  return [['git', 'worktree', 'remove', '--force', path]];
}

export function branchFor(runId: string, policy: AgentPolicy): string {
  // Only characters that are unambiguous in a ref name. A run id is generated
  // here, but a name that has to be quoted somewhere downstream will
  // eventually be used unquoted.
  const safe = runId.replace(/[^A-Za-z0-9._-]/g, '-');
  return `${policy.branchPrefix}${safe}`;
}

/**
 * Whether a run ended because the subscription ran out, rather than because
 * the work did.
 *
 * The third agent's allowance cannot be read while it runs — nothing local
 * carries a number, and Google publishes no figure for what a plan allows.
 * Checked on 2026-08-23: the official documentation describes the tiers only
 * as "weekly", "every five hours, high" and "every five hours, highest", and
 * states Ultra as a multiple of a Pro baseline it never gives.
 *
 * So the only honest reading is the refusal itself. This turns "it failed" into
 * "it failed because the plan was spent", which is the one fact an upgrade
 * decision can be argued from: hitting the ceiling twice in a month and
 * hitting it twice a day are different situations, and without this they look
 * identical in the record.
 *
 * Patterns rather than an exact string, because the wording is the vendor's to
 * change. Kept narrow enough that an ordinary error does not read as a ceiling
 * — claiming the plan ran out when it did not would argue for spending money
 * that did not need spending.
 */
export function looksLikeQuotaExhaustion(text: string): boolean {
  if (!text) return false;
  return [
    /exhausted your (daily |weekly )?quota/i,
    /quota exceeded/i,
    /rate limit (exceeded|reached)/i,
    /RESOURCE_EXHAUSTED/,
    /\b429\b/,
    /usage limit reached/i,
    /上限に達し/,
  ].some((pattern) => pattern.test(text));
}

export type StopReason =
  | 'completed'
  | 'quota_exhausted'
  | 'time_limit'
  | 'cost_limit'
  | 'unmeterable'
  | 'machine_slept'
  | 'stopped_by_user';

export interface RunProgress {
  startedAtMs: number;
  nowMs: number;
  /** From the child's own transcript. Null when it could not be read. */
  usd: number | null;
  /** How long the meter has been unreadable. */
  meterSilentMs: number;
  /**
   * Whether this agent files a cost at all. Absent means metered, so an agent
   * added without stating this is bounded by spend rather than only by time.
   */
  costMetered?: boolean;
  /**
   * The largest single jump in the wall clock between two polls.
   *
   * A machine that sleeps does not stop time. Both the elapsed-time check and
   * the meter-silence check are wall-clock differences, so waking up makes a
   * ten-minute run look like a two-hour one and a live meter look dead — and
   * the run is recorded as having hit its limit, which is a stop reason that
   * is simply untrue. The user keeps this Mac awake for a fixed window before
   * sleeping, so this is the ordinary case rather than an edge one.
   */
  largestGapMs?: number;
  /** Time the machine was not running, excluded from the elapsed budget. */
  sleptMs?: number;
}

/**
 * How long a run may go without a readable meter before it is stopped.
 *
 * Not zero: a transcript does not exist for the first moments of a run, and
 * killing every launch on startup would be its own kind of broken.
 */
export const METER_GRACE_MS = 3 * 60_000;

/**
 * Whether a running agent should be stopped, and why.
 *
 * The unmeterable case is the one worth reading twice. If the transcript
 * cannot be read, the run has no ceiling at all — and the failure looks
 * exactly like a quiet, well-behaved run. It is stopped for that reason alone.
 */
/**
 * A wall-clock jump this large was not work. Poll is on the order of seconds,
 * so five minutes is unambiguous.
 */
export const SLEEP_GAP_MS = 5 * 60_000;

export function shouldStop(progress: RunProgress, policy: AgentPolicy): StopReason | null {
  // Checked first, because everything below it is a wall-clock difference and
  // a sleep makes all of them lie in the same direction.
  if ((progress.largestGapMs ?? 0) >= SLEEP_GAP_MS) return 'machine_slept';

  const working = progress.nowMs - progress.startedAtMs - (progress.sleptMs ?? 0);
  if (working >= policy.maxRunMs) return 'time_limit';
  if (progress.usd === null) {
    /**
     * Absent and broken are different failures.
     *
     * Where the agent files a cost, losing the reading means the ceiling is no
     * longer being checked, and a run continuing under an unchecked ceiling is
     * exactly the thing this stops. Where the agent files no cost at all —
     * a subscription CLI with nothing to read — there was never a ceiling to
     * lose, and stopping on its absence would mean the run could never finish.
     * The bound there is the time limit, already applied above.
     *
     * Defaulting to metered: an agent added later without saying which it is
     * gets the stricter treatment, not the looser one.
     */
    if (progress.costMetered === false) return null;
    return progress.meterSilentMs >= METER_GRACE_MS ? 'unmeterable' : null;
  }
  if (progress.usd >= policy.maxUsdPerRun) return 'cost_limit';
  return null;
}

export function describeStop(reason: StopReason, policy: AgentPolicy): string {
  switch (reason) {
    case 'completed':
      return 'エージェントが自分で終了しました。';
    case 'time_limit':
      return `時間上限 ${Math.round(policy.maxRunMs / 60_000)} 分に達したため停止しました。`;
    case 'cost_limit':
      return `費用上限 $${policy.maxUsdPerRun} に達したため停止しました。`;
    case 'unmeterable':
      return (
        'トークン使用量を読めなくなったため停止しました。' +
        '上限が効かない状態で走らせ続けるより止める方を選びます。'
      );
    case 'machine_slept':
      return (
        'マシンがスリープしたため停止しました。時間上限には達していません。' +
        'スリープ中は接続も切れているため、起こしても続きにはなりません。予約し直してください。'
      );
    case 'quota_exhausted':
      return (
        '契約の利用上限に達したため終了しました。モデルや作業の内容とは関係がありません。' +
        '記録に残しているので、頻度が分かればプランを上げるかどうかを事実から判断できます。'
      );
    case 'stopped_by_user':
      return '利用者の指示で停止しました。';
  }
}
