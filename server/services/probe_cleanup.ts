import { readdirSync, readFileSync, statSync, unlinkSync } from 'fs';
import { join } from 'path';

/**
 * Removes the transcripts IRIS wrote by asking itself a question.
 *
 * The allowance figure can only be refreshed by making a real Claude Code
 * session run, because the status line is the only thing that writes the
 * payload. Every refresh is therefore a session, and every session leaves a
 * transcript: 238 of them across four days, filling the application's own
 * session list with entries nobody opened.
 *
 * Lengthening the interval reduced the rate and does not clear the pile, and a
 * pile that only grows is a pile that eventually gets deleted in a hurry by
 * somebody with a wildcard. So it is swept here, narrowly.
 *
 * Narrow means three conditions together, and all three are required because
 * this deletes files. The transcript's first user turn has to be one of the
 * exact prompts IRIS uses; it has to have a single user turn, because a probe
 * that somehow became a conversation is a conversation; and it has to be older
 * than the keep window, so that anything still being written is left alone.
 *
 * Nothing else is touched. A transcript that cannot be read is skipped rather
 * than removed — an unreadable file is not evidence that it is one of ours.
 */

/**
 * これより大きい転記は、開かずに飛ばす。
 *
 * `isProbeTranscript` は**一人ターンが一つだけ**のものしか通さない。つまり
 * 大きい転記は定義上ありえない —— それでも中身を読むために全部を開いていた。
 *
 * 実測 2026-09-28、`~/.claude/projects` は 1034 本・3.98 GB（最大 309 MB）。
 * そのうち一人ターンが一つだけのものは 162 本で、**最大 295 KB**。
 * 1 MB で切ると読む量は 3.98 GB → 70 MB になり、本物の候補に対して 3.4 倍の
 * 余裕が残る。
 *
 * これが起動時の 21.5 秒だった（見張りが `probes.sweep.boot` として記録）。
 */
const TOO_BIG_TO_BE_A_PROBE = 1_000_000;

export interface SweepResult {
  removed: number;
  bytes: number;
  /** Files that matched but could not be deleted, with the reason. */
  failures: Array<{ path: string; reason: string }>;
}

export function sweepProbeTranscripts(
  home: string,
  prompts: Set<string>,
  keepMs = 24 * 60 * 60_000,
  now = () => Date.now()
): SweepResult {
  const root = join(home, '.claude', 'projects');
  const result: SweepResult = { removed: 0, bytes: 0, failures: [] };

  let projects: string[];
  try {
    projects = readdirSync(root);
  } catch {
    return result;
  }

  for (const project of projects) {
    let files: string[];
    try {
      files = readdirSync(join(root, project));
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const path = join(root, project, file);
      try {
        const info = statSync(path);
        if (now() - info.mtimeMs < keepMs) continue;
        // 大きすぎるものは開かない。開かなければ判定もしないので、**消さない。**
        if (info.size > TOO_BIG_TO_BE_A_PROBE) continue;
        if (!isProbeTranscript(readFileSync(path, 'utf-8'), prompts)) continue;
        const size = info.size;
        unlinkSync(path);
        result.removed++;
        result.bytes += size;
      } catch (err: any) {
        // Only a file that matched can fail here; an unreadable one was
        // already skipped by the read above throwing before the match.
        result.failures.push({ path, reason: err?.message ?? String(err) });
      }
    }
  }
  return result;
}

/**
 * Whether a transcript is one of IRIS's own probes.
 *
 * Reads the user turns and requires exactly one, matching a known prompt. A
 * second user turn means somebody typed into it, and whatever it was for then,
 * it is not this function's to delete.
 */
export function isProbeTranscript(text: string, prompts: Set<string>): boolean {
  let seen = 0;
  let matched = false;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let record: any;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record?.type !== 'user') continue;
    const content = record?.message?.content;
    if (typeof content !== 'string') return false;
    seen++;
    if (seen > 1) return false;
    matched = prompts.has(content.trim());
  }
  return seen === 1 && matched;
}
