import { execFile } from 'child_process';
import { promisify } from 'util';

const run = promisify(execFile);

/**
 * Read-only git inspection for canonical handoffs.
 *
 * Every command here is a fixed argument list executed without a shell, and no
 * caller-supplied value is ever interpolated into one. This is deliberately not
 * a general command-execution capability: that remains an explicit, separate
 * decision, and nothing in this file should grow into one.
 */

export interface RepositoryState {
  available: boolean;
  root?: string;
  branch?: string;
  headCommit?: string;
  headSubject?: string;
  dirty?: boolean;
  changedFiles?: string[];
  recentCommits?: Array<{ hash: string; subject: string }>;
  error?: string;
}

const TIMEOUT_MS = 5000;

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd, timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 });
  return stdout.trim();
}

/**
 * Porcelain status must not be trimmed as a whole: its status field is two
 * columns wide and an unstaged change begins with a space, so trimming the
 * combined output shifts the FIRST filename by one character and yields
 * things like "ackage.json". An agent handed that wastes a round trip.
 */
async function gitRaw(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd, timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 });
  return stdout;
}

export function parsePorcelainPath(line: string): string {
  // Format: XY<space>path, or "XY old -> new" for a rename.
  const path = line.slice(2).trim();
  const renameIndex = path.indexOf(' -> ');
  return renameIndex >= 0 ? path.slice(renameIndex + 4) : path;
}

export async function readRepositoryState(cwd: string = process.cwd()): Promise<RepositoryState> {
  try {
    const root = await git(cwd, ['rev-parse', '--show-toplevel']);
    const [branch, headCommit, headSubject, status, log] = await Promise.all([
      git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
      git(cwd, ['rev-parse', '--short', 'HEAD']),
      git(cwd, ['log', '-1', '--pretty=%s']),
      gitRaw(cwd, ['status', '--porcelain']),
      git(cwd, ['log', '-5', '--pretty=%h\t%s']),
    ]);

    const changedFiles = status
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map(parsePorcelainPath)
      .slice(0, 50);

    const recentCommits = log
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [hash, ...rest] = line.split('\t');
        return { hash, subject: rest.join('\t') };
      });

    return {
      available: true,
      root,
      branch,
      headCommit,
      headSubject,
      dirty: changedFiles.length > 0,
      changedFiles,
      recentCommits,
    };
  } catch (err: any) {
    // A missing repo or absent git is not an error worth failing a handoff over;
    // the handoff simply records that repository state was unavailable.
    return { available: false, error: err?.message || String(err) };
  }
}
