/**
 * Self-development, the fixing stage: what is protected, what verification demands, what approval refuses.
 * Git and npm are faked; nothing here touches a real working tree.
 *
 * Run: npx tsx scripts/test-self-fix.ts
 */
import { classifyDiff, buildFixGoal, verifyBranch, mergeApproved, cleanEnv, taskStatusForFinding, type Exec } from '../server/core/self_fix.js';
import type { Finding } from '../server/services/self_findings_sqlite.js';

let passed = 0;
const failures: string[] = [];
const ok = (name: string, cond: boolean, detail = '') => { if (cond) passed++; else failures.push(`${name} ${detail}`); };

const finding = (over: Partial<Finding> = {}): Finding => ({
  id: 'f1', dedupeKey: 'k', source: 'complaint', title: 'レーンが動かない', detail: 'd', evidence: ['「レーンが動かない」'],
  status: 'awaiting_approval', attempts: 1, occurrences: 3, firstSeen: '', lastSeen: '', taskId: null, runId: null, branch: 'agent/x',
  verification: { ok: true, protectedHits: [], repo: '/repo', baseSha: 'a'.repeat(40), headSha: 'd' .repeat(40) }, note: null, updatedAt: '', ...over,
});

// ── the environment handed to a verification child process
const env = cleanEnv({ HOME: '/Users/x', ANTHROPIC_API_KEY: 'sk-secret', OPENAI_API_KEY: 'sk-other', IRIS_SPEECH_BINARY: '/opt/helper', IRIS_FDP_WEBAPP_SECRET: 's', GEMINI_API_KEY: 'g', TMPDIR: '/tmp/x', LANG: 'ja_JP.UTF-8', PATH: '/should/not/leak' } as NodeJS.ProcessEnv, '/usr/local/bin');
ok('no API key reaches a verification process', !Object.keys(env).some((k) => /KEY|SECRET|TOKEN/i.test(k)) && !Object.values(env).some((v) => /sk-|^g$/.test(v)));
ok('and no IRIS_* setting, which made a test fail only inside the server', !Object.keys(env).some((k) => k.startsWith('IRIS_')));
ok('it keeps what a build needs', env.HOME === '/Users/x' && env.TMPDIR === '/tmp/x' && env.CI === '1' && env.PATH.startsWith('/usr/local/bin:'));
ok('the server\'s own PATH is not inherited', !env.PATH.includes('/should/not/leak'));

// ── protected paths
const c = classifyDiff(['server/index.ts', 'server/tools/workspace.ts', 'server/core/self_fix.ts', 'scripts/test-x.ts', 'package.json', '.env', 'src/App.tsx', 'src/NebulaCore.tsx', 'server/core/repeat_guard.ts']);
ok('the deny list, the self-dev loop, package.json, .env and the repeat guard are protected', c.protectedHits.map((h) => h.file).sort().join() === '.env,package.json,server/core/repeat_guard.ts,server/core/self_fix.ts,server/index.ts,server/tools/workspace.ts,src/App.tsx', c.protectedHits.map((h) => h.file).join());
ok('ordinary files are not', !c.protectedHits.some((h) => h.file === 'src/NebulaCore.tsx'));
ok('each hit says why', c.protectedHits.every((h) => h.why.length > 0));

// ── the goal given to the agent
const g = buildFixGoal(finding(), ['前回は再現できなかった']);
ok('the goal carries the evidence and the occurrence count', g.goal.includes('「レーンが動かない」') && g.goal.includes('3 回'));
ok('it tells the agent to confirm the problem first and allows a no-change finish', g.goal.includes('誤検出') && g.goal.includes('再現して確かめて'));
ok('it demands a test and exit-code checks', g.goal.includes('テストの無い変更は承認の画面に出ません') && g.goal.includes('終了コード'));
ok('previous attempts are carried', g.goal.includes('前回は再現できなかった'));
ok('constraints forbid weakening tests and using the network', g.constraints.some((x) => x.includes('テストを弱める')) && g.constraints.some((x) => x.includes('ネットワーク')));

(async () => {
  // ── verification, with a fake exec
  type Script = Record<string, { code: number; stdout?: string; stderr?: string }>;
  function fake(script: Script) {
    const calls: string[] = [];
    const exec: Exec = async (command, args, options) => {
      const key = [command, ...args].join(' ');
      calls.push(key);
      if (key === 'git rev-parse HEAD' && options.cwd === '/tmp/verify') return { code: 0, stdout: (calls.some((x) => x.startsWith('git rebase ') && !x.includes('--abort')) ? 'e' : 'd').repeat(40), stderr: '' };
      for (const [prefix, out] of Object.entries(script)) if (key.startsWith(prefix)) return { code: out.code, stdout: out.stdout ?? '', stderr: out.stderr ?? '' };
      return { code: 0, stdout: '', stderr: '' };
    };
    return { exec, calls };
  }
  const input = { repo: '/repo', branch: 'agent/x', workdir: '/tmp/verify', linkNodeModules: () => {} };
  const good: Script = {
    'git rev-parse --verify': { code: 0, stdout: 'd'.repeat(40) },
    'git merge-base': { code: 0, stdout: 'a'.repeat(40) + '\n' },
    'git rev-parse HEAD': { code: 0, stdout: 'a'.repeat(40) + '\n' },
    'git diff --name-only': { code: 0, stdout: 'server/a.ts\nscripts/test-a.ts\n' },
    'git log': { code: 0, stdout: 'def456 Fix a\n' },
  };

  const pass = fake(good);
  const v1 = await verifyBranch({ exec: pass.exec }, input);
  ok('a change with a test that passes all three steps is verified', v1.ok && v1.steps.map((s) => s.name).join() === 'typecheck,tests,build', JSON.stringify(v1.steps));
  ok('the verification worktree is removed afterwards', pass.calls.some((x) => x.startsWith('git worktree remove')));
  ok('the real working tree is never checked out or merged', !pass.calls.some((x) => /^git (checkout|merge |reset|stash)/.test(x)));

  const noTest = fake({ ...good, 'git diff --name-only': { code: 0, stdout: 'server/a.ts\n' } });
  const v2 = await verifyBranch({ exec: noTest.exec }, input);
  ok('a change without a test is refused before anything runs', !v2.ok && v2.failedAt === 'no-tests' && !noTest.calls.some((x) => x.startsWith('npm')));

  // 利用者が頼んだ開発（requireTests: false）は、テストを含まない差分でも検査する。
  const noTestOk = fake({ ...good, 'git diff --name-only': { code: 0, stdout: 'server/a.ts\n' } });
  const v2b = await verifyBranch({ exec: noTestOk.exec }, { ...input, requireTests: false });
  ok('a requested change without a test is still checked, not refused', v2b.ok && v2b.steps.map((s) => s.name).join() === 'typecheck,tests,build' && !v2b.touchesTests, JSON.stringify(v2b.steps));

  const empty = fake({ ...good, 'git diff --name-only': { code: 0, stdout: '' } });
  const v3 = await verifyBranch({ exec: empty.exec }, input);
  ok('no commits means nothing to approve', !v3.ok && v3.failedAt === 'no-changes');

  const badTests = fake({ ...good, 'npm test': { code: 1, stderr: '2 failed' } });
  const v4 = await verifyBranch({ exec: badTests.exec }, input);
  ok('failing tests stop the verification, and the build never runs', !v4.ok && v4.failedAt === 'tests' && !badTests.calls.some((x) => x.startsWith('npm run build')));
  ok('and the failure tail is kept for the next attempt', v4.steps.at(-1)!.tail.includes('2 failed'));

  const badTypes = fake({ ...good, 'node_modules/.bin/tsc': { code: 2, stdout: 'error TS2322' } });
  const v5 = await verifyBranch({ exec: badTypes.exec }, input);
  ok('a type error stops it before the tests', v5.failedAt === 'typecheck' && !badTypes.calls.some((x) => x === 'npm test'));

  const touched = fake({ ...good, 'git diff --name-only': { code: 0, stdout: 'server/tools/workspace.ts\nscripts/test-a.ts\n' } });
  const v6 = await verifyBranch({ exec: touched.exec }, input);
  ok('a change that touches a protected file still verifies, but says so', v6.ok && v6.protectedHits.length === 1);

  // ── the base moved: rebase first, then verify what will actually be merged
  const moved = fake({ ...good, 'git rev-parse HEAD': { code: 0, stdout: 'f'.repeat(40) + '\n' } });
  const v7 = await verifyBranch({ exec: moved.exec }, input);
  ok('when the branch moved on, the change is rebased onto it first', v7.ok && v7.steps[0].name === 'rebase' && moved.calls.some((x) => x === 'git rebase ' + 'f'.repeat(40)), JSON.stringify(v7.steps.map((x) => x.name)));
  ok('the rebased tip is written back to the branch so a fast-forward works', moved.calls.some((x) => x.startsWith('git update-ref refs/heads/agent/x ')));
  ok('and the rebase happens in the verification worktree, not the real one', moved.calls.indexOf('git rebase ' + 'f'.repeat(40)) > moved.calls.findIndex((x) => x.startsWith('git worktree add')));
  ok('an unrebased, unmoved branch gets no rebase and no ref write', !pass.calls.some((x) => x.startsWith('git rebase') || x.startsWith('git update-ref')));

  const conflict = fake({ ...good, 'git rev-parse HEAD': { code: 0, stdout: 'f'.repeat(40) + '\n' }, ['git rebase ' + 'f'.repeat(40)]: { code: 1, stderr: 'CONFLICT' } });
  const v8 = await verifyBranch({ exec: conflict.exec }, input);
  ok('a change that conflicts with the new base stops at the rebase and is aborted cleanly', !v8.ok && v8.failedAt === 'rebase' && conflict.calls.includes('git rebase --abort') && !conflict.calls.some((x) => x.startsWith('npm')));
  ok('a failed verification never moves the branch', !conflict.calls.some((x) => x.startsWith('git update-ref')));

  const failAfter = fake({ ...good, 'git rev-parse HEAD': { code: 0, stdout: 'f'.repeat(40) + '\n' }, 'npm test': { code: 1, stderr: 'boom' } });
  await verifyBranch({ exec: failAfter.exec }, input);
  ok('tests failing after a rebase leave the branch alone', !failAfter.calls.some((x) => x.startsWith('git update-ref')));

  // ── approval
  const merge = fake({ 'git rev-parse HEAD': {code: 0, stdout: 'a'.repeat(40)}, 'git rev-parse --verify': {code: 0, stdout: 'd'.repeat(40)}, 'git symbolic-ref': { code: 0, stdout: 'feature/x\n' }, 'git status': { code: 0, stdout: '' }, 'git merge --ff-only': { code: 0 }, 'git rev-parse': { code: 0, stdout: 'abc1234\n' } });
  const m1 = await mergeApproved({ exec: merge.exec }, { repo: '/repo', branch: 'agent/x', finding: finding(), confirmProtected: false });
  ok('an approved, verified, clean-tree change fast-forwards', m1.merged && m1.head === 'abc1234');
  ok('only a fast-forward is ever used', merge.calls.some((x) => x === 'git merge --ff-only ' + 'd'.repeat(40)) && !merge.calls.some((x) => /^git merge (?!--ff-only)/.test(x)));

  const m2 = await mergeApproved({ exec: merge.exec }, { repo: '/repo', branch: 'agent/x', finding: finding({ status: 'open' }), confirmProtected: false });
  ok('a finding that is not awaiting approval is not merged', !m2.merged && m2.reason === 'not_awaiting');
  const m3 = await mergeApproved({ exec: merge.exec }, { repo: '/repo', branch: 'agent/x', finding: finding({ verification: { ok: false, protectedHits: [] } }), confirmProtected: false });
  ok('one whose verification failed is not merged', !m3.merged && m3.reason === 'not_awaiting');

  const prot = finding({ verification: { ok: true, repo: '/repo', baseSha: 'a'.repeat(40), headSha: 'd'.repeat(40), protectedHits: [{ file: 'server/tools/workspace.ts', why: 'x' }] } });
  const m4 = await mergeApproved({ exec: merge.exec }, { repo: '/repo', branch: 'agent/x', finding: prot, confirmProtected: false });
  ok('a protected change needs the extra confirmation', !m4.merged && m4.reason === 'protected_unconfirmed');
  const m5 = await mergeApproved({ exec: merge.exec }, { repo: '/repo', branch: 'agent/x', finding: prot, confirmProtected: true });
  ok('and goes in once it is given', m5.merged);

  const dirty = fake({ 'git rev-parse HEAD': {code: 0, stdout: 'a'.repeat(40)}, 'git rev-parse --verify': {code: 0, stdout: 'd'.repeat(40)}, 'git symbolic-ref': { code: 0, stdout: 'feature/x\n' }, 'git status': { code: 0, stdout: ' M server/index.ts\n' } });
  const m6 = await mergeApproved({ exec: dirty.exec }, { repo: '/repo', branch: 'agent/x', finding: finding(), confirmProtected: false });
  ok('a dirty working tree is never merged into', !m6.merged && m6.reason === 'dirty_tree' && !dirty.calls.some((x) => x.startsWith('git merge')));

  const diverged = fake({ 'git rev-parse HEAD': {code: 0, stdout: 'a'.repeat(40)}, 'git rev-parse --verify': {code: 0, stdout: 'd'.repeat(40)}, 'git symbolic-ref': { code: 0, stdout: 'feature/x\n' }, 'git status': { code: 0, stdout: '' }, 'git merge --ff-only': { code: 128, stderr: 'Not possible to fast-forward' } });
  const m7 = await mergeApproved({ exec: diverged.exec }, { repo: '/repo', branch: 'agent/x', finding: finding(), confirmProtected: false });
  ok('a branch that has diverged is refused, not merged some other way', !m7.merged && m7.reason === 'diverged');

  const detached = fake({ 'git rev-parse --verify': {code: 0, stdout: 'd'.repeat(40)}, 'git symbolic-ref': { code: 128 } });
  const m8 = await mergeApproved({ exec: detached.exec }, { repo: '/repo', branch: 'agent/x', finding: finding(), confirmProtected: false });
  ok('a detached HEAD is refused', !m8.merged && m8.reason === 'detached');

  ok('a task whose fix awaits approval is in review', taskStatusForFinding('awaiting_approval') === 'review');
  ok('a task whose fix was rejected, dismissed or failed is closed, not left in progress', (['open', 'dismissed', 'failed'] as const).every((s) => taskStatusForFinding(s) === 'abandoned'));
  ok('a task whose fix is running stays in progress', taskStatusForFinding('fixing') === 'in_progress' && taskStatusForFinding('verifying') === 'in_progress');
  ok('a merged fix is done', taskStatusForFinding('merged') === 'done');

    console.log(`Self fix: ${passed} passed, ${failures.length} failed`);
  if (failures.length) { console.log(failures.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
  console.log('All self fix tests passed.');
})();
