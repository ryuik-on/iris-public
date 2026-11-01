/**
 * 自己開発の「直す→検査→承認」。ここは判断と手順だけで、git や npm の実行は呼び元が渡す
 * （`SelfFixDeps`）。そうしておけば、検査と承認の規則を、本物の作業ツリーに触らずにテストできる。
 *
 * 守ること（利用者の決め、2026-10-01）：気づく→直す→検査→**承認だけ人**。
 *   - 直すのは別ブランチの作業場。あなたの作業中のコードには触らない。
 *   - 型チェックと全テストとビルドは、IRIS が自分で走らせる。通らなければ承認の画面に出さない。
 *   - **自分を監督するコード**（拒否リスト、承認の仕組み、検査と自己開発の輪そのもの）に
 *     触れた変更は、承認の画面で警告し、保護領域を理解したという印を添えないと入らない。
 *   - 承認なしでは、何も本番に入らない。
 */

import type { Finding } from '../services/self_findings_sqlite.js';
import path from 'node:path';

/** 触れたら警告するパス。正規表現で、リポジトリ直下からの相対パスに当てる。 */
export const PROTECTED: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /^server\/tools\/|^server\/native\/|^server\/config\.ts$|^server\/core\/types\.ts$/, why: '道具の危険度、ファイル操作、実行の制限' },
  { pattern: /^server\/services\/(safe_write|oauth_|google_oauth|mcp_client)[^/]*\.ts$|^scripts\/iris-mcp\.ts$/, why: '認証情報、外部の道具、保存先の境界' },
  { pattern: /^src\/(App\.tsx|api\.ts)$|^menubar\/Ask\.swift$/, why: '承認と画面の認証' },
  { pattern: /^menubar\/(IrisMenuBar\.swift|main\.swift|install\.sh)$|^\.gitignore$/, why: '起動時の認証と、秘密を検査の候補に含めない設定' },
  { pattern: /^server\/index\.ts$/, why: '認証・自動化・取り込みを強制するサーバーの入口' },
  { pattern: /^server\/core\/(access|origin_guard|budget_service|provider_caps|sandbox|http_security|owner_access)[^/]*\.ts$/, why: '認証、隔離、通信、予算の境界' },
  { pattern: /^server\/services\/(access_token|local_http|verification)[^/]*\.ts$|^menubar\/IrisHTTP\.swift$/, why: '端末の認証と隔離された検査' },
  { pattern: /^scripts\/(iris-service|install-launchd|open-iris)[^/]*\.(sh|swift)$|^package-lock\.json$/, why: '起動処理と固定された依存関係' },
  { pattern: /^server\/tools\/workspace\.ts$/, why: 'ファイルの読み書きの拒否リスト（IRIS が自分の鍵や設定を読み書きできない境界）' },
  { pattern: /^server\/tools\/registry\.ts$/, why: '道具の実行の入り口' },
  { pattern: /^server\/core\/orchestrator\.ts$/, why: '承認が必要な操作を止める本体' },
  { pattern: /^server\/core\/(approval|permissions|local_permissions)[^/]*\.ts$/, why: '承認と権限' },
  { pattern: /^server\/core\/repeat_guard\.ts$|^scripts\/repeat-guard\.ts$/, why: '記録された失敗を命令の手前で止める仕組み' },
  { pattern: /^server\/core\/agent_runner\.ts$|^server\/services\/agent_process\.ts$/, why: '委任の上限と、実行を止める安全装置' },
  { pattern: /^server\/core\/self_[^/]*\.ts$|^server\/services\/self_[^/]*\.ts$/, why: '自己開発の輪そのもの（検査・承認・候補の控え）' },
  { pattern: /^server\/core\/(privacy|local_only)[^/]*\.ts$/, why: '家計などの外に出さない情報の扱い' },
  { pattern: /^\.env(\..*)?$|^\.claude\/|^CLAUDE\.md$|^AGENTS\.md$/, why: '設定と、エージェントへの指示' },
  { pattern: /^package\.json$/, why: '依存と、テストの定義（検査そのものを弱められる）' },
];

export function classifyDiff(files: string[]): { protectedHits: Array<{ file: string; why: string }>; files: string[] } {
  const hits: Array<{ file: string; why: string }> = [];
  for (const file of files) {
    const hit = PROTECTED.find((p) => p.pattern.test(file));
    if (hit) hits.push({ file, why: hit.why });
  }
  return { protectedHits: hits, files };
}

export function buildFixGoal(finding: Finding, previousNotes: string[] = []): { goal: string; constraints: string[]; successCriteria: string[] } {
  const sourceLabel = { complaint: '利用者の不満', selfcheck: '実機検査の失敗', error: '繰り返すエラー・停止', overview: '全体の見直し' }[finding.source];
  const goal = [
    `IRIS が自分について気づいた問題を直してください。種類: ${sourceLabel}。`,
    '',
    `■ 気づいたこと: ${finding.title}`,
    finding.detail,
    finding.evidence.length ? `\n■ 根拠（拾った記録）\n${finding.evidence.map((e) => `- ${e}`).join('\n')}` : '',
    `\n（${finding.occurrences} 回見ています）`,
    previousNotes.length ? `\n■ 前回までの試みで分かったこと\n${previousNotes.map((n) => `- ${n}`).join('\n')}` : '',
    '',
    '■ 進め方',
    '1. まず、本当に直すべきことか、再現して確かめてください。誤検出（普通の記録、一時的な状態、利用者の別の依頼）だと分かったら、コードを変えず、その理由を最後に書いて終わってください。',
    '2. 直すなら、原因に届く最小の変更にしてください。ついでの整理や、無関係な変更は入れない。',
    '3. 直した内容を確かめるテスト（`scripts/test-*.ts`）を足すか直してください。**テストの無い変更は承認の画面に出ません。**',
    '4. 検査は終了後に IRIS が隔離された環境で実行します: `node_modules/.bin/tsc --noEmit`、`npm test`、`npm run build`。合否は終了コードで判断します。この実行からコマンドを呼ばないでください。',
    '5. コミットも終了後に IRIS が行います。最後に「何が原因で、何を変えて、どのテストを書いたか」を書いてください。',
  ].filter((l) => l !== '').join('\n');
  return {
    goal,
    constraints: [
      '別ブランチの作業場だけで作業する（メインの作業ツリーに触らない）',
      '自分を監督するコード（拒否リスト・承認・権限・委任の上限・記録された失敗の止め・自己開発の輪・.env・package.json のテスト定義）は、本当に必要なときだけ変え、必要な理由を最後に書く',
      'ネットワークは使わない',
      'テストを弱める・飛ばす・消すことで通さない',
    ],
    successCriteria: [
      '問題が再現し、直ったことをテストで確かめた（誤検出なら、その根拠を書いて終了）',
      '`node_modules/.bin/tsc --noEmit` が終了コード 0',
      '`npm test` が終了コード 0',
      '`npm run build` が終了コード 0',
    ],
  };
}

/**
 * 検査や取り込みの子プロセスに渡す環境変数。**必要な最小限だけ。**
 *
 * サーバーの環境には `.env` の設定と API キーが入っている。検査はエージェントが書いた
 * コードのテストを走らせるので、そのまま渡すと、キーが他人の書いたコードに渡り、さらに
 * `IRIS_SPEECH_BINARY` のような設定が入った環境でだけテストが落ちる。
 */
export function cleanEnv(source: NodeJS.ProcessEnv, nodeBinDir: string): Record<string, string> {
  return {
    PATH: `${nodeBinDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: source.HOME ?? '',
    TMPDIR: source.TMPDIR ?? '/tmp',
    LANG: source.LANG ?? 'ja_JP.UTF-8',
    CI: '1',
  };
}

export interface Exec {
  (command: string, args: string[], options: { cwd: string; timeoutMs: number }): Promise<{ code: number; stdout: string; stderr: string }>;
}

export interface Verification {
  ok: boolean;
  repo: string | null;
  baseSha: string | null;
  headSha: string | null;
  /** 検査の段ごとの結果。落ちたところで止める。 */
  steps: Array<{ name: string; ok: boolean; tail: string }>;
  files: string[];
  commits: string[];
  protectedHits: Array<{ file: string; why: string }>;
  /** 差分にテストが含まれるか。含まれない変更は承認に出さない。 */
  touchesTests: boolean;
  failedAt?: string;
  verifiedAt: string;
}

const tail = (s: string, n = 400) => s.trim().split('\n').slice(-6).join('\n').slice(-n);

/**
 * ブランチを検査する。検査用の作業場（`workdir`）はこちらで作って、終わったら片付ける。
 * 本物の作業ツリーには触らない。
 */
export async function verifyBranch(
  deps: { exec: Exec; now?: () => Date },
  input: { repo: string; branch: string; workdir: string; linkNodeModules: (workdir: string) => void; /** 自己開発は、テストを含まない差分を断る。利用者が頼んだ開発は、含まなくても検査はする。 */ requireTests?: boolean }
): Promise<Verification> {
  const now = deps.now ?? (() => new Date());
  const result: Verification = { ok: false, repo: path.resolve(input.repo), baseSha: null, headSha: null, steps: [], files: [], commits: [], protectedHits: [], touchesTests: false, verifiedAt: now().toISOString() };
  const run = (command: string, args: string[], cwd: string, timeoutMs: number) => deps.exec(command, args, { cwd, timeoutMs });

  const tip = await run('git', ['rev-parse', '--verify', `${input.branch}^{commit}`], input.repo, 30_000);
  const originalTip = tip.stdout.trim();
  if (tip.code !== 0 || !/^[a-f0-9]{40}$/.test(originalTip)) { result.failedAt = 'branch'; return result; }
  const base = await run('git', ['merge-base', 'HEAD', originalTip], input.repo, 30_000);
  if (base.code !== 0) { result.failedAt = 'merge-base'; result.steps.push({ name: 'merge-base', ok: false, tail: tail(base.stderr || base.stdout) }); return result; }
  const baseSha = base.stdout.trim();
  result.baseSha = baseSha;

  const names = await run('git', ['diff', '--name-only', `${baseSha}..${originalTip}`], input.repo, 30_000);
  result.files = names.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  const log = await run('git', ['log', '--format=%h %s', `${baseSha}..${originalTip}`], input.repo, 30_000);
  result.commits = log.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  result.protectedHits = classifyDiff(result.files).protectedHits;
  result.touchesTests = result.files.some((f) => /^scripts\/test-[^/]+\.ts$/.test(f));

  if (result.files.length === 0) { result.failedAt = 'no-changes'; result.steps.push({ name: 'no-changes', ok: false, tail: 'コミットが無い（誤検出と判断したか、何も変えなかった）' }); return result; }
  if (input.requireTests !== false && !result.touchesTests) { result.failedAt = 'no-tests'; result.steps.push({ name: 'no-tests', ok: false, tail: '差分にテスト（scripts/test-*.ts）が含まれていません' }); return result; }

  const added = await run('git', ['worktree', 'add', '--detach', input.workdir, originalTip], input.repo, 60_000);
  if (added.code !== 0) { result.failedAt = 'worktree'; result.steps.push({ name: 'worktree', ok: false, tail: tail(added.stderr || added.stdout) }); return result; }
  try {
    input.linkNodeModules(input.workdir);
    /*
     * 本線が進んでいたら、本線の先頭に付け替えてから検査する。
     *
     * 取り込みは早送りだけ（分岐していれば断る）。ところが本線は検査の間も進むので、
     * 付け替えずに検査すると、検査に通った案が、反映のときに必ず「早送りできません」で
     * 落ちる（2026-10-02、予定の修正案がそうなった）。付け替えたものを検査するので、
     * 検査したものと反映されるものが同じになる。食い違う変更なら、ここで止めて人に回す。
     */
    const head = await run('git', ['rev-parse', 'HEAD'], input.repo, 30_000);
    const headSha = head.stdout.trim();
    let rebasedTo: string | null = null;
    if (head.code === 0 && headSha && headSha !== baseSha) {
      const rb = await run('git', ['rebase', headSha], input.workdir, 120_000);
      if (rb.code !== 0) {
        await run('git', ['rebase', '--abort'], input.workdir, 30_000).catch(() => undefined);
        result.steps.push({ name: 'rebase', ok: false, tail: `本線の変更と食い違って、付け替えられませんでした。${tail(rb.stderr || rb.stdout, 200)}` });
        result.failedAt = 'rebase';
        return result;
      }
      const now2 = await run('git', ['rev-parse', 'HEAD'], input.workdir, 30_000);
      rebasedTo = now2.stdout.trim() || null;
      result.baseSha = headSha;
      result.steps.push({ name: 'rebase', ok: true, tail: `本線（${headSha.slice(0, 7)}）の先頭に付け替えた` });
    }
    const expectedHead = rebasedTo ?? originalTip;
    if (rebasedTo) {
      const files = await run('git', ['diff', '--name-only', `${result.baseSha}..${expectedHead}`], input.repo, 30_000);
      const commits = await run('git', ['log', '--format=%h %s', `${result.baseSha}..${expectedHead}`], input.repo, 30_000);
      if (files.code !== 0 || commits.code !== 0) { result.failedAt = 'diff'; return result; }
      result.files = files.stdout.split('\n').map((x) => x.trim()).filter(Boolean);
      result.commits = commits.stdout.split('\n').map((x) => x.trim()).filter(Boolean);
      result.protectedHits = classifyDiff(result.files).protectedHits;
      result.touchesTests = result.files.some((f) => /^scripts\/test-[^/]+\.ts$/.test(f));
      if (!result.files.length || (input.requireTests !== false && !result.touchesTests)) { result.failedAt = result.files.length ? 'no-tests' : 'no-changes'; return result; }
    }
    for (const [name, command, args, ms] of [
      ['typecheck', 'node_modules/.bin/tsc', ['--noEmit'], 300_000],
      ['tests', 'npm', ['test'], 900_000],
      ['build', 'npm', ['run', 'build'], 300_000],
    ] as const) {
      const r = await run(command, [...args], input.workdir, ms);
      result.steps.push({ name, ok: r.code === 0, tail: tail(r.code === 0 ? r.stdout : (r.stderr + '\n' + r.stdout)) });
      if (r.code !== 0) { result.failedAt = name; return result; }
    }
    const after = await run('git', ['rev-parse', 'HEAD'], input.workdir, 30_000);
    const dirty = await run('git', ['status', '--porcelain', '--untracked-files=no'], input.workdir, 30_000);
    if (after.code !== 0 || after.stdout.trim() !== expectedHead || dirty.code !== 0 || dirty.stdout.trim()) {
      result.failedAt = 'changed-during-verification';
      return result;
    }
    // 付け替えた形を、ブランチにも反映する。早送りで取り込めるのは、これがあるから。
    if (rebasedTo) {
      const moved = await run('git', ['update-ref', `refs/heads/${input.branch}`, rebasedTo, originalTip], input.repo, 30_000);
      if (moved.code !== 0) {
        result.steps.push({ name: 'update-branch', ok: false, tail: tail(moved.stderr || moved.stdout) });
        result.failedAt = 'update-branch';
        return result;
      }
    }
    result.headSha = expectedHead;
    result.ok = true;
    return result;
  } finally {
    await run('git', ['worktree', 'remove', '--force', input.workdir], input.repo, 60_000).catch(() => undefined);
  }
}

export type MergeOutcome =
  | { merged: true; head: string }
  | { merged: false; reason: 'not_awaiting' | 'stale_verification' | 'protected_unconfirmed' | 'dirty_tree' | 'detached' | 'diverged' | 'failed'; message: string };

/** 承認を受けて、メインの作業ツリーに取り込む。早送りだけ（分岐していれば断る）。 */
export async function mergeApproved(
  deps: { exec: Exec },
  input: { repo: string; branch: string; finding: Finding; confirmProtected: boolean }
): Promise<MergeOutcome> {
  const { finding } = input;
  if (finding.status !== 'awaiting_approval' || !finding.verification?.ok) {
    return { merged: false, reason: 'not_awaiting', message: '承認待ちの状態ではありません（検査を通っていません）。' };
  }
  const verified = finding.verification;
  if (verified.repo !== path.resolve(input.repo) || !/^[a-f0-9]{40}$/.test(verified.headSha ?? '') || !/^[a-f0-9]{40}$/.test(verified.baseSha ?? '')) {
    return { merged: false, reason: 'stale_verification', message: '確認したコミットを特定できないため、検査し直します。' };
  }
  if ((finding.verification.protectedHits ?? []).length > 0 && !input.confirmProtected) {
    return { merged: false, reason: 'protected_unconfirmed', message: '自分を監督するコードに触れた変更です。保護領域を理解した印を添えてください。' };
  }
  const run = (args: string[]) => deps.exec('git', args, { cwd: input.repo, timeoutMs: 60_000 });
  const tip = await run(['rev-parse', '--verify', `${input.branch}^{commit}`]);
  if (tip.code !== 0 || tip.stdout.trim() !== verified.headSha) {
    return { merged: false, reason: 'stale_verification', message: '検査後に案が変わったため、検査し直します。' };
  }
  const branch = await run(['symbolic-ref', '--short', 'HEAD']);
  if (branch.code !== 0) return { merged: false, reason: 'detached', message: '作業ツリーがブランチの上にありません。' };
  const currentHead = await run(['rev-parse', 'HEAD']);
  if (currentHead.code !== 0 || ![verified.baseSha, verified.headSha].includes(currentHead.stdout.trim())) {
    return { merged: false, reason: 'diverged', message: '本線が検査時から変わったため、検査し直します。' };
  }
  const dirty = await run(['status', '--porcelain', '--untracked-files=no']);
  if (dirty.stdout.trim()) return { merged: false, reason: 'dirty_tree', message: '作業ツリーに未コミットの変更があります。作業が落ち着いてからもう一度。' };
  const merged = await run(['merge', '--ff-only', verified.headSha]);
  if (merged.code !== 0) {
    return { merged: false, reason: 'diverged', message: `早送りで取り込めません（先に別の変更が入った）。${tail(merged.stderr || merged.stdout, 200)}` };
  }
  const head = await run(['rev-parse', '--short', 'HEAD']);
  return { merged: true, head: head.stdout.trim() };
}

/**
 * 直しのために作った開発タスクが、finding の段に応じてどの状態になるか。
 * タスクは「進行中」で始まり、実行が終わっても自動では動かない。畳まないと、
 * 実機検査（dev_tasks_not_orphaned）が「宙に浮いたタスク」として拾い続ける。
 */
export function taskStatusForFinding(status: Finding['status']): 'in_progress' | 'review' | 'done' | 'abandoned' {
  switch (status) {
    case 'fixing':
    case 'verifying': return 'in_progress';
    case 'awaiting_approval': return 'review';
    case 'merged': return 'done';
    default: return 'abandoned'; // open（次の回は新しいタスク）・dismissed・failed
  }
}
