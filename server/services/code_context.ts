import fs from 'fs/promises';
import { existsSync, realpathSync } from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { isDeniedPath } from '../tools/workspace.js';

const run = promisify(execFile);

/**
 * Read-only code context for review.
 *
 * An independent reviewer told us it could not judge correctness because it
 * was handed a task description and no code. Fixing that means reading IRIS's
 * own source, which sits deliberately outside the tool workspace — so this is
 * a second, narrower access path rather than a widening of the first.
 *
 * Its properties, in order of importance:
 *
 *   1. **Read-only.** There is no write path in this module, so it cannot
 *      become one by accident.
 *   2. **Not a tool.** It is never registered in the ToolRegistry, so the model
 *      cannot call it. IRIS assembles this context itself when building a
 *      review; the model's own capability surface is unchanged.
 *   3. **Same denylist as the workspace.** This content is sent to an external
 *      model, so shipping a .env here would be a worse leak than reading one
 *      locally. The rules are shared with the workspace rather than restated.
 *   4. **Confined to the repository root**, with symlink escapes rejected.
 *   5. **Budgeted**, because review costs money per token and a large diff
 *      would silently make one review cost more than a day of chat.
 *      Truncation is always reported, never silent.
 */

export const MAX_FILE_BYTES = 24 * 1024;
export const MAX_TOTAL_BYTES = 80 * 1024;
const GIT_TIMEOUT_MS = 5000;

export class CodeContextError extends Error {
  constructor(message: string, public readonly reason: string) {
    super(message);
    this.name = 'CodeContextError';
  }
}

export interface CodeFile {
  path: string;
  content: string;
  bytes: number;
  truncated: boolean;
}

export interface OmittedFile {
  path: string;
  reason:
    | 'denied'
    | 'outside_repository'
    | 'missing'
    | 'binary'
    | 'budget'
    | 'directory'
    | 'unreadable';
}

export interface CodeContext {
  available: boolean;
  root?: string;
  files: CodeFile[];
  /** Everything left out, and why — a silent omission would mislead the reviewer. */
  omitted: OmittedFile[];
  diff?: string;
  diffTruncated?: boolean;
  /** Why the diff is absent, when it is. Silence here previously read as "no changes". */
  diffError?: string;
  /** New files, which `git diff HEAD` does not show at all. */
  untracked: string[];
  totalBytes: number;
  budgetExceeded: boolean;
  error?: string;
}

/**
 * Reads the requested files plus the working-tree diff, for review.
 *
 * `paths` are repository-relative and come from the task's own relevantFiles,
 * not from the model.
 */
export async function collectCodeContext(
  repoCwd: string,
  paths: string[],
  options: { includeDiff?: boolean; maxTotalBytes?: number } = {}
): Promise<CodeContext> {
  const budget = options.maxTotalBytes ?? MAX_TOTAL_BYTES;

  let root: string;
  try {
    const { stdout } = await run('git', ['rev-parse', '--show-toplevel'], {
      cwd: repoCwd,
      timeout: GIT_TIMEOUT_MS,
    });
    root = realpathSync(stdout.trim());
  } catch (err: any) {
    return {
      available: false,
      files: [],
      omitted: [],
      untracked: [],
      totalBytes: 0,
      budgetExceeded: false,
      error: `リポジトリを特定できませんでした: ${err?.message ?? err}`,
    };
  }

  const files: CodeFile[] = [];
  const omitted: OmittedFile[] = [];
  let totalBytes = 0;
  let budgetExceeded = false;

  for (const requested of paths) {
    if (totalBytes >= budget) {
      omitted.push({ path: requested, reason: 'budget' });
      budgetExceeded = true;
      continue;
    }

    let resolved: string;
    try {
      resolved = resolveWithinRepo(root, requested);
    } catch (err: any) {
      omitted.push({
        path: requested,
        reason: err?.reason === 'denied' ? 'denied' : 'outside_repository',
      });
      continue;
    }

    if (!existsSync(resolved)) {
      omitted.push({ path: requested, reason: 'missing' });
      continue;
    }

    try {
      const stat = await fs.stat(resolved);
      if (stat.isDirectory()) {
        omitted.push({ path: requested, reason: 'directory' });
        continue;
      }
      if (!stat.isFile()) {
        omitted.push({ path: requested, reason: 'unreadable' });
        continue;
      }

      const remaining = Math.max(0, budget - totalBytes);
      const cap = Math.min(MAX_FILE_BYTES, remaining);
      const handle = await fs.open(resolved, 'r');
      try {
        const buffer = Buffer.alloc(Math.min(stat.size, cap));
        // bytesRead matters: a short read leaves the rest of the buffer as
        // zeroes, which the binary check below would then read as NUL bytes and
        // reject a perfectly good text file.
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        const read = buffer.subarray(0, bytesRead);

        if (read.includes(0)) {
          omitted.push({ path: requested, reason: 'binary' });
          continue;
        }

        const truncated = stat.size > bytesRead;
        if (truncated) budgetExceeded = true;

        files.push({
          path: path.relative(root, resolved),
          // Trailing replacement characters come from cutting mid-sequence.
          content: read.toString('utf8').replace(/\uFFFD+$/, ''),
          bytes: bytesRead,
          truncated,
        });
        totalBytes += bytesRead;
      } finally {
        await handle.close();
      }
    } catch {
      omitted.push({ path: requested, reason: 'unreadable' });
    }
  }

  let diff: string | undefined;
  let diffTruncated = false;
  let diffError: string | undefined;
  let untracked: string[] = [];
  if (options.includeDiff !== false) {
    const remaining = Math.max(0, budget - totalBytes);
    const collected = await readDiff(root, remaining);
    diff = collected.diff;
    diffTruncated = collected.truncated;
    diffError = collected.error;
    untracked = collected.untracked;
    if (collected.truncated) budgetExceeded = true;
    totalBytes += collected.diff ? Buffer.byteLength(collected.diff, 'utf8') : 0;
  }

  return {
    available: true,
    root,
    files,
    omitted,
    diff,
    diffTruncated,
    diffError,
    untracked,
    totalBytes,
    budgetExceeded,
  };
}

/**
 * Working-tree diff, with a fixed argument list and no shell. Deliberately not
 * parameterised by caller-supplied paths — a diff of everything uncommitted is
 * what a reviewer needs, and accepting path arguments here would create an
 * injection surface for no benefit.
 */
async function readDiff(
  root: string,
  budget: number
): Promise<{ diff?: string; truncated: boolean; error?: string; untracked: string[] }> {
  if (budget <= 0) return { truncated: true, untracked: [] };

  // `git diff HEAD` omits untracked files entirely, so a brand new file — the
  // most review-worthy kind — was invisible AND unreported. Listing them keeps
  // the promise that nothing goes missing silently.
  let untracked: string[] = [];
  try {
    const { stdout } = await run('git', ['ls-files', '--others', '--exclude-standard'], {
      cwd: root,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    untracked = stdout.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 100);
  } catch {
    /* listing untracked files is best effort */
  }

  try {
    const { stdout: full } = await run('git', ['diff', 'HEAD'], {
      cwd: root,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (!full.trim()) return { truncated: false, untracked };

    // A diff can carry a secret even when the file itself is excluded, so
    // hunks are filtered by the same rules before anything is sent.
    const safe = filterDiffHunks(full);
    const bytes = Buffer.from(safe, 'utf8');
    if (bytes.length <= budget) return { diff: safe, truncated: false, untracked };
    // Cut on a byte boundary and drop any partial multi-byte sequence.
    return {
      diff: bytes.subarray(0, budget).toString('utf8').replace(/\uFFFD+$/, ''),
      truncated: true,
      untracked,
    };
  } catch (err: any) {
    // Swallowing this made a git failure indistinguishable from "no changes",
    // so a reviewer would conclude there were none.
    return {
      truncated: false,
      untracked,
      error: `差分を取得できませんでした: ${err?.message ?? err}`,
    };
  }
}

/** Drops hunks whose file is denylisted, keeping the rest of the diff usable. */
export function filterDiffHunks(diff: string): string {
  const hunks = diff.split(/^(?=diff --git )/m).filter(Boolean);
  const kept: string[] = [];

  for (const hunk of hunks) {
    const paths = extractHunkPaths(hunk);

    // Fail closed. A header this does not understand — a quoted path, a path
    // containing spaces — previously kept the hunk, so an unparseable name was
    // the one case that leaked. Dropping the body loses review value; leaking a
    // secret is worse.
    if (paths.length === 0) {
      kept.push('[パスを解釈できない差分のため除外されました]\n');
      continue;
    }

    // Both sides are checked: a rename away from a protected file names it on
    // the a/ side only, while its full contents appear as deletions.
    if (paths.some((p) => isDeniedPath(p).denied)) {
      kept.push(`diff --git a/${paths[0]} b/${paths[paths.length - 1]}\n[この差分は機密の可能性があるため除外されました]\n`);
      continue;
    }

    kept.push(hunk);
  }

  return kept.join('');
}

/** Every path a hunk names, from the header and from rename/---/+++ lines. */
function extractHunkPaths(hunk: string): string[] {
  const paths = new Set<string>();

  const header = hunk.match(/^diff --git (?:"?a\/(.+?)"? "?b\/(.+?)"?)\s*$/m);
  if (header) {
    if (header[1]) paths.add(header[1]);
    if (header[2]) paths.add(header[2]);
  }

  for (const re of [/^rename from (.+)$/m, /^rename to (.+)$/m, /^--- "?a\/(.+?)"?$/m, /^\+\+\+ "?b\/(.+?)"?$/m]) {
    const m = hunk.match(re);
    if (m?.[1] && m[1] !== '/dev/null') paths.add(m[1]);
  }

  return [...paths];
}

function resolveWithinRepo(root: string, candidate: string): string {
  if (typeof candidate !== 'string' || !candidate.trim() || candidate.includes('\0')) {
    throw Object.assign(new CodeContextError('不正なパスです。', 'invalid'), { reason: 'invalid' });
  }

  const resolved = path.resolve(root, candidate);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw Object.assign(
      new CodeContextError(`リポジトリ外です: ${candidate}`, 'outside_repository'),
      { reason: 'outside_repository' }
    );
  }

  const denied = isDeniedPath(relative);
  if (denied.denied) {
    throw Object.assign(
      new CodeContextError(`機密の可能性があるため除外: ${candidate}`, 'denied'),
      { reason: 'denied' }
    );
  }

  // The requested path is not enough. A symlink inside the repository —
  // `notes.md -> .env` — passes the denylist on its own name and passes the
  // containment check because its target is also inside the repo, and the
  // read then follows it. Verified: this leaked a real .env before the check
  // below was added. So the resolved path is checked too, against both
  // escaping the repository and the denylist.
  if (existsSync(resolved)) {
    const real = realpathSync(resolved);
    const realRelative = path.relative(root, real);

    if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
      throw Object.assign(
        new CodeContextError(`シンボリックリンクがリポジトリ外を指しています: ${candidate}`, 'outside_repository'),
        { reason: 'outside_repository' }
      );
    }

    if (isDeniedPath(realRelative).denied) {
      throw Object.assign(
        new CodeContextError(`リンク先が機密の可能性があるため除外: ${candidate} -> ${realRelative}`, 'denied'),
        { reason: 'denied' }
      );
    }
  }

  return resolved;
}

/** Renders the context for inclusion in a handoff. */
export function renderCodeContext(context: CodeContext): string {
  if (!context.available) {
    return `（コードを取得できませんでした: ${context.error ?? 'unknown'}）`;
  }

  const lines: string[] = [];

  for (const file of context.files) {
    lines.push(`### \`${file.path}\`${file.truncated ? '（一部のみ）' : ''}`);
    lines.push('');
    lines.push('```' + languageOf(file.path));
    lines.push(file.content);
    lines.push('```');
    lines.push('');
  }

  if (context.diff) {
    lines.push(`### 未コミットの差分${context.diffTruncated ? '（一部のみ）' : ''}`);
    lines.push('');
    lines.push('```diff');
    lines.push(context.diff);
    lines.push('```');
    lines.push('');
  }

  if (context.diffError) {
    lines.push(`> ${context.diffError}（未コミット変更が無いという意味ではありません）`);
    lines.push('');
  }

  if (context.untracked.length > 0) {
    // Untracked files are absent from the diff entirely, so a reviewer would
    // otherwise never learn a new file exists.
    lines.push('### 未追跡ファイル（差分には現れません）');
    lines.push('');
    for (const u of context.untracked) lines.push(`- \`${u}\``);
    lines.push('');
  }

  if (context.omitted.length > 0) {
    // Stated explicitly: a reviewer that does not know something was withheld
    // may conclude it does not exist.
    lines.push('### 除外されたもの');
    lines.push('');
    for (const o of context.omitted) {
      lines.push(`- \`${o.path}\` — ${describeOmission(o.reason)}`);
    }
    lines.push('');
  }

  if (context.budgetExceeded) {
    lines.push('> 注意: サイズ上限により内容が切り詰められています。見えていない部分について結論を出さないでください。');
    lines.push('');
  }

  return lines.join('\n');
}

function describeOmission(reason: OmittedFile['reason']): string {
  switch (reason) {
    case 'denied': return '機密の可能性があるため除外';
    case 'outside_repository': return 'リポジトリ外のため除外';
    case 'missing': return 'ファイルが存在しない';
    case 'binary': return 'バイナリのため除外';
    case 'budget': return 'サイズ上限に達したため除外';
    case 'directory': return 'ディレクトリのため除外';
    default: return '読み取れなかった';
  }
}

function languageOf(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    '.ts': 'typescript', '.tsx': 'tsx', '.js': 'javascript', '.jsx': 'jsx',
    '.json': 'json', '.md': 'markdown', '.sh': 'bash', '.sql': 'sql', '.py': 'python',
  };
  return map[ext] ?? '';
}
