/**
 * Unattended agent launch tests.
 *
 * The register held this feature at EXPLICIT_DECISION_REQUIRED with a recorded
 * conclusion that it should not be built. The user overrode that on 2026-08-20
 * and asked for the unattended version specifically. That is their decision;
 * what these tests cover is the part that is not a matter of judgement — that
 * the bounds actually bound.
 *
 * Three of them would each be a quiet disaster:
 *
 * The allowlist must be exact. A prefix test looks identical in every passing
 * test and lets `/Users/x/Documents/iris-backup` through when
 * `/Users/x/Documents/iris` was authorised.
 *
 * The child must not inherit credentials. IRIS's process holds four providers'
 * keys and an iCloud app password. A spawn that passes them through works
 * perfectly, which is exactly why nobody would notice.
 *
 * An unreadable meter must stop the run. The meter reads a private file format
 * that will change; when it does, the choice is a run with no ceiling or no
 * run. On 2026-08-20 a health check reported fine for thirty-one hours because
 * a dead dependency left no error behind, and this is the same shape.
 *
 * Run: npm run test:agent-runner
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  AgentPolicy,
  DEFAULT_POLICY,
  checkLaunch,
  isAllowedRepo,
  childEnvironment,
  leakedCredentials,
  buildArgv,
  attendedNetwork,
  asAgentKind,
  AGENTS,
  modelForRole,
  looksLikeQuotaExhaustion,
  worktreeSetup,
  worktreeCleanup,
  DENIED_TOOLS,
  ALLOWED_TOOLS,
  UNATTENDED_INSTRUCTIONS,
  branchFor,
  shouldStop,
  describeStop,
  METER_GRACE_MS,
  SLEEP_GAP_MS,
} from '../server/core/agent_runner.js';
import { projectDirFor, findTranscript, readTranscript } from '../server/services/agent_meter.js';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail?: string) {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
function eq(name: string, actual: any, expected: any) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, ok, ok ? undefined : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function section(t: string) { console.log(`\n▸ ${t}`); }

const dir = mkdtempSync(join(tmpdir(), 'iris-agent-'));

const POLICY: AgentPolicy = {
  ...DEFAULT_POLICY,
  allowedRepos: [
    '/Users/example/Downloads/iris',
    '/Users/example/Documents/Codex/2026-07-28/medrecall',
    '/Users/example/Documents/GitHub/med-ai-company-bible',
    '/Users/example/Documents/Codex/2026-07-27/med-ai-builder-lab-repository-manager',
  ],
};

const OK = { handoffId: 'h-1', repo: POLICY.allowedRepos[0], clean: true, running: 0 };

function main() {
  // -----------------------------------------------------------------------
  section('The allowlist is exact, not a prefix');

  {
    check('an allowed repository passes', isAllowedRepo(POLICY.allowedRepos[0], POLICY));
    check('a trailing slash is the same repository', isAllowedRepo(POLICY.allowedRepos[0] + '/', POLICY));

    // The failure a prefix test cannot see.
    check('a sibling with a longer name is refused', !isAllowedRepo('/Users/example/Downloads/iris-backup', POLICY));
    check('a child directory is refused', !isAllowedRepo('/Users/example/Downloads/iris/server', POLICY));
    check('a parent directory is refused', !isAllowedRepo('/Users/example/Downloads', POLICY));
    check('an unrelated repository is refused', !isAllowedRepo('/Users/example/Documents/ryu-ikon-room', POLICY));
    // Traversal that resolves inside the allowlist should have been resolved
    // before it got here; unresolved, it is not a match.
    check('an unresolved traversal is refused', !isAllowedRepo('/Users/example/Downloads/iris/../iris', POLICY));
  }

  {
    eq('a refusal names the repository', checkLaunch({ ...OK, repo: '/tmp/elsewhere' }, POLICY)?.code, 'repo_not_allowed');
    eq('a relative path is refused', checkLaunch({ ...OK, repo: 'iris' }, POLICY)?.code, 'repo_not_absolute');
  }

  {
    // An empty allowlist means nothing was authorised. Reading it as "no
    // restriction" is how a default becomes a permission nobody granted.
    const empty = { ...POLICY, allowedRepos: [] };
    eq('an empty allowlist refuses everything', checkLaunch(OK, empty)?.code, 'policy_empty');
  }

  // -----------------------------------------------------------------------
  section('What else stops a launch');

  {
    eq('no handoff id', checkLaunch({ ...OK, handoffId: '' }, POLICY)?.code, 'no_handoff');
    eq('already running', checkLaunch({ ...OK, running: 1 }, POLICY)?.code, 'busy');
    // Refused rather than stashed: a stash made while nobody is watching moves
    // someone's work somewhere they will not look for it.
    eq('a dirty working tree', checkLaunch({ ...OK, clean: false }, POLICY)?.code, 'dirty_tree');
    eq('and a clean request is allowed', checkLaunch(OK, POLICY), null);
  }

  // -----------------------------------------------------------------------
  section('The child gets no credentials');

  {
    // IRIS's real environment shape, as of 2026-08-20.
    const parent = {
      PATH: '/usr/bin:/bin',
      HOME: '/Users/example',
      ANTHROPIC_API_KEY: 'sk-ant-secret',
      GEMINI_API_KEY: 'gem-secret',
      OPENAI_API_KEY: 'sk-secret',
      GOOGLE_CLIENT_SECRET: 'GOCSPX-secret',
      ICLOUD_APP_PASSWORD: 'abcd-efgh-ijkl-mnop',
      IRIS_MCP_SERVERS: '[{"id":"calendar"}]',
    };

    const child = childEnvironment({ ...parent, USER: 'user', LOGNAME: 'user' });
    eq('nothing credential-shaped survives', leakedCredentials(child), []);
    check('the parent did have credentials to leak', leakedCredentials(parent).length === 5);

    check('PATH is carried', child.PATH === '/usr/bin:/bin');
    check('HOME is carried', child.HOME === '/Users/example');

    // Stripped too far the first time: the agent could not reach its own login
    // and exited in three seconds with "Not logged in". Measured on
    // 2026-08-20 — HOME and PATH alone fail, and so does either of these
    // alone; both are needed.
    eq('USER is carried', child.USER, 'user');
    eq('LOGNAME is carried', child.LOGNAME, 'user');

    // Built rather than filtered: a credential added next month is absent by
    // construction instead of needing a new rule.
    const withNewSecret = childEnvironment({ ...parent, SOME_FUTURE_API_KEY: 'x' });
    check('a variable nobody anticipated is also absent', withNewSecret.SOME_FUTURE_API_KEY === undefined);
    /**
     * The exact key set, so the environment cannot grow without someone
     * deciding it should. It has grown twice, both times deliberately.
     *
     * `GIT_ALLOW_PROTOCOL` moves the ban on pushing from a pattern matched
     * against a command line to git's own transport check, which holds however
     * the command is spelled and for an agent whose flags cannot express the
     * ban at all.
     *
     * `TMPDIR` because without it git falls back to `/tmp`, which is shared
     * with everything else on the machine — and says so twice per invocation
     * in the transcript that gets read when something has gone wrong.
     */
    eq('and the shape does not grow', Object.keys(child).sort(), [
      'GIT_ALLOW_PROTOCOL',
      'GIT_TERMINAL_PROMPT',
      'HOME',
      'LANG',
      'LOGNAME',
      'PATH',
      'TERM',
      'TMPDIR',
      'USER',
    ]);
    eq('only local transports are allowed', child.GIT_ALLOW_PROTOCOL, 'file');
    eq('and nothing waits on a credential prompt', child.GIT_TERMINAL_PROMPT, '0');
    eq(
      'scratch space is the private one',
      childEnvironment({ ...parent, TMPDIR: '/var/folders/m1/x/T/' }).TMPDIR,
      '/var/folders/m1/x/T/'
    );
    // Present even when the parent has none, so the fallback is chosen here
    // rather than left to whatever each tool decides on its own.
    eq('and there is one even when the parent had none', childEnvironment({}).TMPDIR, '/tmp');
  }

  // -----------------------------------------------------------------------
  section('The third agent');

  {
    // Measured 2026-08-23: told to edit a file in the directory it was
    // launched from, agy listed three unrelated repositories and asked which
    // was meant. With --add-dir it edited and committed in 28.8s.
    const argv = buildArgv('やること', 'agy', { workdir: '/w', gitDir: '/g' });
    check('the working directory is named, not assumed', argv.includes('--add-dir') && argv.includes('/w'));
    /**
     * And the parent's git directory is NOT passed, though Codex needs it.
     * It is `<repo>/.git`, so passing it hands over the person's checkout —
     * which on 2026-08-23 is where a run committed instead of into its
     * worktree, walking straight around the reason worktrees are used here.
     */
    check('the parent repository is not handed over', !argv.includes('/g'));

    /**
     * Gemini unless told otherwise. Left to itself this CLI answers as Claude
     * Sonnet 4.6, which costs nothing from the Claude week but sends a second
     * opinion back to the same family as the first — and is not what the
     * subscription was bought for.
     */
    eq('the default is the subscription being spent', AGENTS.agy.defaultModel, 'gemini-3.1-pro-high');
    check('and it reaches the argv', argv.join(' ').includes('--model gemini-3.1-pro-high'));
    check(
      'a named model wins',
      buildArgv('やること', 'agy', { model: 'claude-opus-4-6-thinking' })
        .join(' ')
        .includes('--model claude-opus-4-6-thinking')
    );
    /*
     * codex は `--model` ではなく `-m`。**綴りが違うだけの別物として扱う。**
     *
     * ここは前まで「codex は模型の旗を取らない」を確かめていた。取るように
     * なったのは `--ignore-user-config` を足したからで、config.toml の
     * `model` が消えるぶんを埋めている。**旗が無いことではなく、正しい旗が
     * 一つだけ在ることを確かめる。**
     */
    const codexArgv = buildArgv('p', 'codex', { model: 'x' });
    check('codex takes -m, not --model', !codexArgv.includes('--model'));
    check('and the named model arrives', codexArgv.join(' ').includes('-m x'));
    check('claude is untouched', !buildArgv('p', 'claude', { model: 'x' }).includes('-m'));

    /**
     * One subscription, several weights. Sending every job to one model wastes
     * the plan in both directions, and the ceiling here cannot be read — so
     * not reaching it is the only lever there is.
     */
    eq('a review goes to the heaviest, and a different family', modelForRole('agy', 'review'), 'claude-opus-4-6-thinking');
    eq('a verification goes to the fastest', modelForRole('agy', 'verify'), 'gemini-3.7-flash-high');
    eq('implementation takes the default', modelForRole('agy', 'implement'), undefined);
    eq('and the other agents have no such choice', modelForRole('claude', 'review'), undefined);

    /**
     * A refusal is the only reading of this plan's allowance there is, so it
     * has to be told apart from an ordinary failure — hitting the ceiling
     * twice a month and twice a day argue for different things.
     */
    check('a spent plan is recognised', looksLikeQuotaExhaustion('You have exhausted your daily quota on this model.'));
    check('and so is the other wording', looksLikeQuotaExhaustion('RESOURCE_EXHAUSTED: quota exceeded'));
    check('and an HTTP 429', looksLikeQuotaExhaustion('request failed with status 429'));
    // Narrow on purpose: reading an ordinary failure as a spent plan would
    // argue for paying for a larger one that was never needed.
    check('an ordinary failure is not', !looksLikeQuotaExhaustion('TypeError: cannot read property of undefined'));
    check('nor is a compile error', !looksLikeQuotaExhaustion('error TS2304: Cannot find name AGENTS'));
    check('nor is nothing at all', !looksLikeQuotaExhaustion(''));
    check('edits and commands proceed without a prompt', argv.join(' ').includes('--mode accept-edits'));
    check('the prompt carries the unattended instructions', argv.some((a) => a.includes('必ず変更をコミット')));

    // Absent and broken are different failures, and only the second one stops
    // a run. Getting this backwards would either disable the ceiling for the
    // metered agents or make the unmetered one impossible to finish.
    eq('the third agent files no cost', AGENTS.agy.costMeter, 'none');
    eq('the other two do', AGENTS.claude.costMeter, 'transcript');
    const silent = { startedAtMs: 0, nowMs: METER_GRACE_MS + 1, usd: null, meterSilentMs: METER_GRACE_MS + 1 };
    eq('a broken meter stops the run', shouldStop(silent, DEFAULT_POLICY), 'unmeterable');
    eq('an absent one does not', shouldStop({ ...silent, costMetered: false }, DEFAULT_POLICY), null);
    eq('but the time limit still applies', shouldStop(
      { ...silent, costMetered: false, nowMs: DEFAULT_POLICY.maxRunMs + 1 }, DEFAULT_POLICY), 'time_limit');

    // Every unknown value used to become Claude, which was harmless with two
    // agents and a silent misroute with three.
    eq('an unknown agent is still Claude', asAgentKind('nonsense'), 'claude');
    eq('but a known one is itself', asAgentKind('agy'), 'agy');
  }

  // -----------------------------------------------------------------------
  section('A network, only where someone is watching');

  {
    /**
     * The sandbox does not separate listening from reaching out — measured
     * 2026-08-23, one flag, both capabilities. So this is checked at the
     * decision rather than at the argv: the argv only carries what was
     * already decided.
     */
    check('an unattended run cannot ask for one', attendedNetwork({ requested: true, unattended: true }) === false);
    check('a watched run gets what it asked for', attendedNetwork({ requested: true }) === true);
    check('and nothing arrives by default', attendedNetwork({}) === false);
    check('silence is not a request', attendedNetwork({ unattended: false }) === false);

    const closed = buildArgv('p', 'codex', { gitDir: '/g' });
    const open = buildArgv('p', 'codex', { gitDir: '/g', network: true });
    check('the flag is absent unless granted', !closed.join(' ').includes('network_access'));
    check('and present when it is', open.includes('sandbox_workspace_write.network_access=true'));
    // Claude's commands already run with the machine's network; the flag has
    // nothing to switch there and must not appear in its argv.
    check('the other agent is untouched', !buildArgv('p', 'claude', { network: true }).join(' ').includes('network_access'));

    /*
     * 画面操作の橋を、実行のたびに閉じる。
     *
     * 実測 2026-09-07: 無人と同じ設定の `codex exec` から
     * `mcp__cua_repl.js`（computer-use）が呼べた。`-c mcp_servers={}` でも、
     * plugin を名指しで落としても残り、`--ignore-user-config` だけが
     * `TARGET_LOOKUP_FAILED: []` にした。**旗が一つ落ちると橋が開く**ので、
     * 試験で押さえておく。
     */
    check('the user config is not loaded', closed.includes('--ignore-user-config'));
    /*
     * その旗は config.toml の `model` も捨てる。埋めていないと、委任だけが
     * CLI の既定の模型で走る —— **画面には何も出ない差**になる。
     */
    check('and the model is named to replace what it dropped', closed.includes('-m'));
  }

  // -----------------------------------------------------------------------
  section('One command shape');

  {
    // A first version invented `--handoff`, which does not exist. A wrong argv
    // typechecks perfectly, so this is pinned against what `claude --help`
    // actually lists.
    const argv = buildArgv('引き継ぎ書の本文');
    eq('print mode', argv[0], '-p');
    // The handoff, plus what the agent is told about running unattended.
    // Committing has to be asked for: the second live run wrote good code and
    // stopped, because the handoff described the change and never mentioned
    // recording it.
    check('the handoff is the second element', argv[1].startsWith('引き継ぎ書の本文'));
    check('followed by the unattended instructions', argv[1].includes(UNATTENDED_INSTRUCTIONS));
    check('which ask for a commit', argv[1].includes('必ず変更をコミット'));
    check('and say push is forbidden', argv[1].includes('git push` は禁止'));
    check('and to separate verified from unverified', argv[1].includes('確認していないことを完了として報告しない'));
    check('the permission mode is explicit', argv.includes('--permission-mode'));
    eq('and is acceptEdits, not a bypass', argv[argv.indexOf('--permission-mode') + 1], 'acceptEdits');
    check('never the bypass mode', !argv.includes('bypassPermissions'));
    check('nor the dangerous flag', !argv.includes('--dangerously-skip-permissions'));

    // `acceptEdits` covers editing and nothing else. The first live run wrote
    // good code and could not run `bash -n`, the tests, or `git commit` — its
    // work survived only as uncommitted changes in a worktree.
    check('committing is allowed', argv.includes('Bash(git commit:*)'));
    check('and staging', argv.includes('Bash(git add:*)'));
    check('and running the tests', argv.includes('Bash(npm test)'));

    // Listed individually, never as a wildcard over git. `Bash(git *)` would
    // cover push, and letting the deny list win that argument is relying on a
    // precedence rule instead of on not granting it.
    check('no blanket git permission', !ALLOWED_TOOLS.some((t) => t === 'Bash(git *)' || t === 'Bash(git*)'));
    check('nothing allowed mentions push', !ALLOWED_TOOLS.some((t) => t.includes('push')));
    check('nor the GitHub CLI', !ALLOWED_TOOLS.some((t) => t.includes('gh ')));

    /**
     * The handoffs ask for these, so the agent has to be able to run them.
     *
     * A handoff on 2026-08-22 required `npm run build` to pass. Codex ran it,
     * because its confinement is a sandbox rather than a list; Claude had no
     * permission for it and would have had to report the requirement unmet —
     * the same instruction behaving differently by vendor. `npm run test:*`
     * does not cover them: it matches `test:speech`, not `typecheck`.
     */
    for (const command of ['Bash(npm run build)', 'Bash(npm run typecheck)']) {
      check(`the agent can run ${command}`, ALLOWED_TOOLS.includes(command));
    }
    // `npm run *` would include `dev`, a watcher that never exits and would
    // spend the whole time limit doing nothing.
    check('but not every script', !ALLOWED_TOOLS.some((t) => t === 'Bash(npm run *)' || t === 'Bash(npm run:*)'));

    // Push is denied at the CLI rather than left to the agent's judgement:
    // deleting a branch undoes a commit, and nothing undoes a push.
    check('push is denied', argv.includes('Bash(git push*)'));
    check('and so is the GitHub CLI', argv.includes('Bash(gh *)'));
    eq('every denied pattern is passed', DENIED_TOOLS.every((t) => argv.includes(t)), true);

    // argv is a list, so no element is ever parsed by a shell — but a prompt
    // containing shell syntax is normal English and must survive intact.
    const withShell = buildArgv('rm -rf / ; echo "done" && true | cat');
    check('a prompt with shell syntax stays one argument', withShell[1].startsWith('rm -rf / ; echo "done" && true | cat'));
    eq('and does not add elements', withShell.length, argv.length);
  }

  {
    // A worktree, not a checkout. The first version ran `git checkout -b` in
    // the repository and moved the *user's* branch — a test run on 2026-08-20
    // left them standing on `agent/f26299d9`, silently. Unattended, that
    // happens at 3am.
    const setup = worktreeSetup('/tmp/wt/run-9', 'agent/run-9');
    eq('a worktree is added', setup, [['git', 'worktree', 'add', '-b', 'agent/run-9', '/tmp/wt/run-9', 'HEAD']]);
    check('and no checkout is performed', !JSON.stringify(setup).includes('"checkout"'));
    // The directory is outside the repository, so it cannot be confused with
    // the one a person is editing.
    check('the path is not inside the repo', !setup[0].includes(POLICY.allowedRepos[0]));

    eq('and it can be removed afterwards', worktreeCleanup('/tmp/wt/run-9'), [['git', 'worktree', 'remove', '--force', '/tmp/wt/run-9']]);
  }

  {
    eq('a branch is derived from the run id', branchFor('run-9', POLICY), 'agent/run-9');
    // A ref name that needs quoting will eventually be used unquoted.
    eq('and unusual characters are flattened', branchFor('run 9;rm -rf /', POLICY), 'agent/run-9-rm--rf--');
    check('the result is a legal ref', /^[A-Za-z0-9._/-]+$/.test(branchFor('run 9;rm -rf /', POLICY)));
  }

  // -----------------------------------------------------------------------
  section('An unreadable meter stops the run');

  {
    const start = 1_000_000;
    // The case the whole meter exists for. A run with no ceiling looks exactly
    // like a quiet, well-behaved one.
    eq(
      'a silent meter is tolerated briefly',
      shouldStop({ startedAtMs: start, nowMs: start + 60_000, usd: null, meterSilentMs: 60_000 }, POLICY),
      null
    );
    eq(
      'and then stops the run',
      shouldStop({ startedAtMs: start, nowMs: start + METER_GRACE_MS, usd: null, meterSilentMs: METER_GRACE_MS }, POLICY),
      'unmeterable'
    );
    check('and says why in a way that can be acted on', describeStop('unmeterable', POLICY).includes('上限が効かない'));
  }

  {
    const start = 1_000_000;
    eq('under the ceiling keeps going', shouldStop({ startedAtMs: start, nowMs: start + 1000, usd: 4.99, meterSilentMs: 0 }, POLICY), null);
    eq('at the ceiling stops', shouldStop({ startedAtMs: start, nowMs: start + 1000, usd: 5, meterSilentMs: 0 }, POLICY), 'cost_limit');
    eq('over the ceiling stops', shouldStop({ startedAtMs: start, nowMs: start + 1000, usd: 12, meterSilentMs: 0 }, POLICY), 'cost_limit');

    // Time is the backstop, and it wins even when the run is cheap.
    eq(
      'the time limit applies regardless of spend',
      shouldStop({ startedAtMs: start, nowMs: start + POLICY.maxRunMs, usd: 0.01, meterSilentMs: 0 }, POLICY),
      'time_limit'
    );
  }

  // -----------------------------------------------------------------------
  section('A sleeping machine is not a long run');

  {
    const start = 1_000_000;
    // The user keeps this Mac awake for a fixed window and then lets it sleep,
    // so this is the ordinary case. Sleep does not stop the clock: every check
    // below is a wall-clock difference, and waking up pushes all of them past
    // their limits at once. A ten-minute run would be recorded as having
    // exhausted a two-hour limit — a stop reason that is simply untrue.
    const afterSleep = shouldStop(
      {
        startedAtMs: start,
        nowMs: start + 3 * 60 * 60_000,
        usd: 0.5,
        meterSilentMs: 3 * 60 * 60_000,
        largestGapMs: 2 * 60 * 60_000,
        sleptMs: 2 * 60 * 60_000,
      },
      POLICY
    );
    eq('a sleep is named as a sleep', afterSleep, 'machine_slept');
    check('and not as the time limit', afterSleep !== 'time_limit');
    check('nor as a dead meter', afterSleep !== 'unmeterable');
    check('the message says the limit was not reached', describeStop('machine_slept', POLICY).includes('時間上限には達していません'));
    check('and that resuming is not possible', describeStop('machine_slept', POLICY).includes('予約し直して'));
  }

  {
    const start = 1_000_000;
    // Time the machine was not running does not count against the budget. A
    // short suspend in the middle of a run should cost the run nothing.
    eq(
      'slept time is excluded from the elapsed budget',
      shouldStop(
        {
          startedAtMs: start,
          nowMs: start + POLICY.maxRunMs + 10 * 60_000,
          usd: 0.5,
          meterSilentMs: 0,
          largestGapMs: 0,
          sleptMs: 20 * 60_000,
        },
        POLICY
      ),
      null
    );
    // But real working time still ends the run.
    eq(
      'and working time still reaches the limit',
      shouldStop(
        {
          startedAtMs: start,
          nowMs: start + POLICY.maxRunMs + 20 * 60_000,
          usd: 0.5,
          meterSilentMs: 0,
          largestGapMs: 0,
          sleptMs: 10 * 60_000,
        },
        POLICY
      ),
      'time_limit'
    );
  }

  {
    const start = 1_000_000;
    // A gap smaller than the threshold is ordinary scheduling jitter, not a
    // sleep, and must not stop a healthy run.
    eq(
      'a small gap is not a sleep',
      shouldStop(
        { startedAtMs: start, nowMs: start + 60_000, usd: 0.5, meterSilentMs: 0, largestGapMs: SLEEP_GAP_MS - 1, sleptMs: 0 },
        POLICY
      ),
      null
    );
    check('and the threshold is well above the poll interval', SLEEP_GAP_MS > 60_000);
  }

  // -----------------------------------------------------------------------
  section('Reading a real transcript');

  {
    const home = join(dir, 'home');
    const cwd = '/Users/example/Downloads/iris';
    const projectDir = join(home, '.claude', 'projects', projectDirFor(cwd));
    mkdirSync(projectDir, { recursive: true });

    eq('the project directory name is derived', projectDirFor(cwd), '-Users-example-Downloads-iris');
    // Spaces too. Missing them was invisible until a worktree lived under
    // `Library/Application Support`, where the meter then found nothing for a
    // whole run and the unmeterable guard would have killed a healthy agent.
    eq(
      'and spaces become dashes as well',
      projectDirFor('/Users/example/Library/Application Support/IRIS/worktrees/ad528d58'),
      '-Users-example-Library-Application-Support-IRIS-worktrees-ad528d58'
    );

    // The shape Claude Code actually writes, including the TTL breakdown.
    const lines = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
      JSON.stringify({
        type: 'assistant',
        message: {
          model: 'claude-opus-5',
          usage: {
            input_tokens: 1_000,
            output_tokens: 10_000,
            cache_read_input_tokens: 1_000_000,
            cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 100_000 },
          },
        },
      }),
      // A half-written final line is normal while the child is running.
      '{"type":"assistant","message":{"mod',
    ];
    const path = join(projectDir, 'session-a.jsonl');
    writeFileSync(path, lines.join('\n'));

    const reading = readTranscript(path);
    check('a partial last line does not break the read', reading.usd !== null);
    eq('messages with usage are counted', reading.messages, 1);
    eq('the model is picked up', reading.model, 'claude-opus-5');
    // 1000*5 + 10000*25 + 1000000*0.5 + 100000*5*2, all per million.
    eq('and priced with the 1-hour cache rate', reading.usd, 1.755);

    // The same tokens at the 5-minute rate would be cheaper, which is the
    // whole reason the breakdown is read.
    const flat = join(projectDir, 'session-b.jsonl');
    writeFileSync(flat, JSON.stringify({
      type: 'assistant',
      message: { model: 'claude-opus-5', usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 100_000 } },
    }));
    const flatReading = readTranscript(flat);
    check('a transcript without the breakdown still reads', flatReading.usd !== null);
    check('at the cheaper 5-minute rate', flatReading.usd! < 1);
  }

  {
    // One message, one charge — however many content blocks it was written as.
    //
    // The transcript writes a record per block and every record of the same
    // message repeats the same `message.usage`, because usage belongs to the
    // message. Summing lines multiplied the bill by the block count: a run on
    // 2026-08-20 priced at $4.798 by line and reported $2.168 itself, with 80
    // usage records across 39 message ids. The ratio looked like a pricing
    // error and was not one.
    const home = join(dir, 'home_blocks');
    const cwd = '/Users/example/Downloads/iris';
    const projectDir = join(home, '.claude', 'projects', projectDirFor(cwd));
    mkdirSync(projectDir, { recursive: true });

    const usage = {
      input_tokens: 0,
      output_tokens: 1_000,
      cache_read_input_tokens: 1_000_000,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
    };
    const path = join(projectDir, 'blocks.jsonl');
    writeFileSync(
      path,
      [
        // One reply, written as three blocks: text, tool_use, text.
        JSON.stringify({ type: 'assistant', message: { id: 'msg_1', model: 'claude-opus-5', usage } }),
        JSON.stringify({ type: 'assistant', message: { id: 'msg_1', model: 'claude-opus-5', usage } }),
        JSON.stringify({ type: 'assistant', message: { id: 'msg_1', model: 'claude-opus-5', usage } }),
      ].join('\n')
    );

    const reading = readTranscript(path);
    eq('three records of one message count once', reading.messages, 1);
    // 1,000 output at $25/M plus 1,000,000 cache reads at $0.5/M.
    eq('and are priced once', reading.usd, 0.525);

    // A second, genuinely different message adds to it.
    writeFileSync(
      path,
      [
        JSON.stringify({ type: 'assistant', message: { id: 'msg_1', model: 'claude-opus-5', usage } }),
        JSON.stringify({ type: 'assistant', message: { id: 'msg_1', model: 'claude-opus-5', usage } }),
        JSON.stringify({ type: 'assistant', message: { id: 'msg_2', model: 'claude-opus-5', usage } }),
      ].join('\n')
    );
    const two = readTranscript(path);
    eq('two distinct messages count twice', two.messages, 2);
    eq('and price twice', two.usd, 1.05);

    // A record with no id cannot be deduplicated, so it is counted — erring
    // toward over- rather than under-reporting.
    writeFileSync(
      path,
      [
        JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5', usage } }),
        JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5', usage } }),
      ].join('\n')
    );
    eq('records without an id are all counted', readTranscript(path).messages, 2);
  }

  {
    const home = join(dir, 'home2');
    const cwd = '/Users/example/Downloads/iris';
    const projectDir = join(home, '.claude', 'projects', projectDirFor(cwd));
    mkdirSync(projectDir, { recursive: true });

    // A transcript with no usage at all: reported as unreadable, never as zero.
    const empty = join(projectDir, 'empty.jsonl');
    writeFileSync(empty, JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }));
    const reading = readTranscript(empty);
    eq('a transcript with no usage reads as unknown', reading.usd, null);
    check('rather than as free', reading.usd !== 0);
    check('and says what was wrong', (reading.reason ?? '').includes('使用量'));

    // A model nobody has priced. Guessing would put a meaningless number on
    // the ceiling.
    const unknown = join(projectDir, 'unknown.jsonl');
    writeFileSync(unknown, JSON.stringify({
      type: 'assistant',
      message: { model: 'claude-from-the-future', usage: { input_tokens: 1, output_tokens: 1 } },
    }));
    eq('an unpriced model reads as unknown', readTranscript(unknown).usd, null);

    eq('a missing file reads as unknown', readTranscript(join(projectDir, 'nope.jsonl')).usd, null);
  }

  {
    const home = join(dir, 'home3');
    const cwd = '/Users/example/Downloads/iris';
    const projectDir = join(home, '.claude', 'projects', projectDirFor(cwd));
    mkdirSync(projectDir, { recursive: true });

    const old = join(projectDir, 'old.jsonl');
    const fresh = join(projectDir, 'fresh.jsonl');
    writeFileSync(old, '{}');
    writeFileSync(fresh, '{}');

    const runStart = Date.now();
    // A session from last week in the same directory. Charging this run for it
    // would stop the run immediately for reasons nobody could reconstruct.
    const weekAgo = (runStart - 7 * 24 * 3600 * 1000) / 1000;
    utimesSync(old, weekAgo, weekAgo);

    const found = findTranscript(home, cwd, runStart - 1000);
    eq('the run picks up its own transcript', found, fresh);
    check('and not the one from before it started', found !== old);

    eq('nothing to find is null', findTranscript(home, '/nowhere/at/all', runStart), null);
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Agent runner: ${passed} passed, ${failed} failed`);
  rmSync(dir, { recursive: true, force: true });
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('All agent runner tests passed.');
}

main();
