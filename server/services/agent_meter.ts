import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { estimateCost, TokenUsage, EMPTY_USAGE, addUsage } from '../core/usage.js';

/**
 * What a spawned coding agent has spent, read from its own transcript.
 *
 * IRIS's `BudgetService` cannot see this. It reads `run.usage` from calls IRIS
 * itself made, and a spawned agent is a separate process authenticating as
 * itself — every token it burns is invisible from inside. Without something
 * here, an unattended run has a time limit and no cost limit at all.
 *
 * The transcript is the only visibility available, and it is a private
 * implementation detail: Claude Code writes one JSONL per session under
 * `~/.claude/projects/<slugified cwd>/<session id>.jsonl`, one object per
 * message, with `message.usage` carrying the token counts. Nothing about that
 * is a contract. It will change.
 *
 * So this reports "could not read" as a first-class answer rather than zero.
 * A meter that returns 0 when it is broken is worse than no meter: it reads as
 * a cheap run and the ceiling never fires. The caller stops the run when this
 * goes quiet, which is the whole reason the distinction exists — the same
 * shape as the health check that spent thirty-one hours reporting fine because
 * a dead dependency left no error behind.
 *
 * Both cache TTLs are read separately. A 1-hour write bills at twice base
 * input and a 5-minute one at 1.25x, and this is exactly the workload where
 * the difference accumulates.
 *
 * Usage is counted once per message, not once per line.
 *
 * The transcript writes one record per content block, and every record of the
 * same message carries the same `message.usage` — because usage is a property
 * of the message, not of the block. Summing lines therefore multiplies the
 * whole bill by however many blocks each reply happened to have.
 *
 * This was measured rather than reasoned about. A run on 2026-08-20 priced at
 * $4.798 by line and reported $2.168 itself; 80 records carried usage and
 * only 39 message ids were distinct. Deduplicating gives $2.168 — the same
 * figure, to the cent.
 *
 * The ratio looked like a pricing error and was not one. Adjusting a rate
 * until the numbers agreed would have produced a table that was wrong in a new
 * way and right for this one run.
 */

export interface MeterReading {
  /** Null when the transcript could not be read. Never 0 as a stand-in. */
  usd: number | null;
  usage: TokenUsage | null;
  model: string | null;
  messages: number;
  /** Which file was read, for when the answer looks wrong. */
  transcript: string | null;
  reason: string | null;
}

const UNREADABLE = (reason: string): MeterReading => ({
  usd: null,
  usage: null,
  model: null,
  messages: 0,
  transcript: null,
  reason,
});

/**
 * Claude Code's directory name for a working directory.
 *
 * Every path separator and dot becomes a dash. Derived rather than guessed
 * once and hardcoded, so a repository somewhere new still resolves.
 */
export function projectDirFor(cwd: string): string {
  /**
   * Separators, dots and spaces all become dashes.
   *
   * Spaces were missing from the first version, which was invisible until a
   * worktree lived under `Library/Application Support` — the meter looked for
   * `…-Application Support-IRIS-…` and the directory was
   * `…-Application-Support-IRIS-…`, so it reported "no transcript yet" for the
   * whole run. Three minutes later the unmeterable guard would have killed a
   * healthy agent, which is the fail-safe firing for the wrong reason.
   */
  return cwd.replace(/[/. ]/g, '-');
}

export function transcriptRoot(home: string): string {
  return join(home, '.claude', 'projects');
}

/**
 * The newest transcript for a working directory, started at or after `since`.
 *
 * Time-bounded because a repository usually has older sessions in the same
 * directory, and charging a run for a conversation that happened last week
 * would stop it almost immediately for reasons nobody could reconstruct.
 */
export function findTranscript(home: string, cwd: string, sinceMs: number): string | null {
  const dir = join(transcriptRoot(home), projectDirFor(cwd));
  if (!existsSync(dir)) return null;

  let newest: { path: string; mtimeMs: number } | null = null;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.jsonl')) continue;
    const path = join(dir, name);
    try {
      const stat = statSync(path);
      // A file last touched before the run began cannot be this run's.
      if (stat.mtimeMs < sinceMs) continue;
      if (!newest || stat.mtimeMs > newest.mtimeMs) newest = { path, mtimeMs: stat.mtimeMs };
    } catch {
      /* a file that vanished between listing and stat is simply not it */
    }
  }
  return newest?.path ?? null;
}

/** Sums a transcript's usage and prices it with IRIS's own table. */
export function readTranscript(path: string): MeterReading {
  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch (err: any) {
    return UNREADABLE(`転記を読めません: ${err?.message ?? err}`);
  }

  let usage: TokenUsage = { ...EMPTY_USAGE };
  let model: string | null = null;
  let messages = 0;
  let sawUsage = false;
  /** Message ids already counted. See the note above about blocks. */
  const counted = new Set<string>();

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let record: any;
    try {
      record = JSON.parse(trimmed);
    } catch {
      // A partially-written last line is normal while the child is running.
      continue;
    }
    const message = record?.message;
    if (!message || typeof message !== 'object') continue;
    const u = message.usage;
    if (!u || typeof u !== 'object') continue;

    sawUsage = true;
    if (typeof message.model === 'string') model = message.model;

    // One message, one charge — however many blocks it was written as. A
    // record without an id cannot be deduplicated, so it is counted, which
    // errs toward over- rather than under-reporting.
    const id = typeof message.id === 'string' ? message.id : null;
    if (id) {
      if (counted.has(id)) continue;
      counted.add(id);
    }
    messages++;

    const creation = u.cache_creation;
    usage = addUsage(usage, {
      inputTokens: num(u.input_tokens),
      outputTokens: num(u.output_tokens),
      cacheReadTokens: num(u.cache_read_input_tokens),
      // When the breakdown is present it is authoritative; the flat field is
      // the sum of both and would price the hour-long writes too cheaply.
      cacheCreationTokens: creation ? num(creation.ephemeral_5m_input_tokens) : num(u.cache_creation_input_tokens),
      cacheCreation1hTokens: creation ? num(creation.ephemeral_1h_input_tokens) : 0,
    });
  }

  if (!sawUsage) {
    // The file exists and says nothing about tokens. Reported as unreadable
    // rather than as zero: the run may be spending right now.
    return { ...UNREADABLE('転記に使用量の記録がありません。'), transcript: path };
  }
  if (!model) {
    return { ...UNREADABLE('転記にモデル名がありません。価格を当てられません。'), transcript: path };
  }

  const estimate = estimateCost(model, usage);
  if (!estimate.priced) {
    // Guessing a price for an unknown model would put a number on the ceiling
    // that means nothing.
    return { ...UNREADABLE(`価格表に無いモデルです: ${model}`), transcript: path };
  }

  return { usd: estimate.usd, usage, model, messages, transcript: path, reason: null };
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/* ────────────────────────────────────────────────────────────────────────── */

/**
 * The same reading, for Codex.
 *
 * Codex keeps its own rollout under `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`
 * and records a `token_count` event carrying a running total, so this needs
 * neither the per-message deduplication the Claude reader does nor a guess
 * about which records double-count. It needs three other things instead, each
 * of which was measured across the 13,381 `token_count` records on this
 * machine on 2026-08-21 rather than assumed.
 *
 * **`total_tokens` is not usable.** It disagrees with `input + output` in 909
 * records, and the disagreement is not a rounding artefact: one record carries
 * every component as zero and a total of 92,552. That is a counter surviving a
 * context reset its components did not. The components are internally
 * consistent, so the price is built from them and the total is ignored.
 *
 * **Reasoning is already inside output.** In all 13,381 records
 * `reasoning_output_tokens <= output_tokens`, with no exceptions — the
 * opposite of Gemini, which reports thinking outside `candidatesTokenCount`
 * and cost this project a 35× under-count. Adding it here would double-charge
 * the most expensive tokens in the run.
 *
 * **`input_tokens` includes the cached part.** Anthropic reports cache reads
 * outside `input_tokens` and `estimateCost` is written to match, so passing
 * Codex's number through unchanged would bill the cached tokens twice: once at
 * the full input rate and once at the cache rate. The cached count is
 * subtracted before pricing.
 *
 * The running total can also reset mid-session, so this accumulates positive
 * deltas rather than reading the last record. A reset contributes zero instead
 * of a negative, and nothing already counted is lost.
 */
export function readCodexTranscript(path: string): MeterReading {
  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch (err: any) {
    return UNREADABLE(`rollout を読めません: ${err?.message ?? err}`);
  }

  // Previous values per component, for the delta accumulation described above.
  let prevInput = 0;
  let prevCached = 0;
  let prevCacheWrite = 0;
  let prevOutput = 0;

  let input = 0;
  let cached = 0;
  let cacheWrite = 0;
  let output = 0;

  let readings = 0;
  let model: string | null = null;

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let record: any;
    try {
      record = JSON.parse(line);
    } catch {
      // A rollout being written to can end mid-line. Skip it rather than
      // discarding a reading that is otherwise complete.
      continue;
    }

    /**
     * The model is on `turn_context`, and the last one wins.
     *
     * A session can change model mid-run — `codex-auto-review` appears as its
     * own model in these files — and the tokens are dominated by whatever ran
     * longest, which is the one still set at the end.
     */
    if (record?.type === 'turn_context' && typeof record?.payload?.model === 'string') {
      model = record.payload.model;
      continue;
    }

    const payload = record?.payload;
    if (payload?.type !== 'token_count') continue;
    const total = payload?.info?.total_token_usage;
    if (!total || typeof total.input_tokens !== 'number') continue;

    const nowInput = nonNegative(total.input_tokens);
    const nowCached = nonNegative(total.cached_input_tokens);
    // Absent in the older schema variant; 1,939 records here have no such key.
    const nowCacheWrite = nonNegative(total.cache_write_input_tokens);
    const nowOutput = nonNegative(total.output_tokens);

    input += Math.max(0, nowInput - prevInput);
    cached += Math.max(0, nowCached - prevCached);
    cacheWrite += Math.max(0, nowCacheWrite - prevCacheWrite);
    output += Math.max(0, nowOutput - prevOutput);

    prevInput = nowInput;
    prevCached = nowCached;
    prevCacheWrite = nowCacheWrite;
    prevOutput = nowOutput;
    readings++;
  }

  if (readings === 0) {
    return UNREADABLE('rollout に token_count がありません');
  }

  const usage: TokenUsage = {
    ...EMPTY_USAGE,
    // The cached part is subtracted, not passed through. See above.
    inputTokens: Math.max(0, input - cached),
    outputTokens: output,
    cacheReadTokens: cached,
    cacheCreationTokens: cacheWrite,
  };

  if (!model) {
    /**
     * Priced at zero is indistinguishable from a cheap run, so an unknown
     * model is reported as unreadable and the caller stops the run. The token
     * counts were readable and the price was not; only the price governs the
     * ceiling.
     */
    return { ...UNREADABLE('rollout にモデル名がありません'), usage, transcript: path };
  }

  const cost = estimateCost(model, usage);
  if (!cost.priced) {
    return { ...UNREADABLE(`${model} の料金表がありません`), usage, model, transcript: path };
  }

  return {
    usd: cost.usd,
    usage,
    model,
    messages: readings,
    transcript: path,
    reason: null,
  };
}

/**
 * Clamped at zero, unlike the Claude reader's `num`.
 *
 * The delta accumulation keeps a previous value, so a negative reaching it
 * would make the next delta larger than the tokens actually spent.
 */
function nonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Codex's rollout root. Dated directories, so this walks three levels. */
export function codexTranscriptRoot(home: string): string {
  return join(home, '.codex', 'sessions');
}

/**
 * The newest Codex rollout touched at or after `since`.
 *
 * Codex files its sessions by date rather than by working directory, so unlike
 * the Claude reader there is no path to key on and the time bound is the only
 * thing distinguishing this run's rollout from another. That is weaker, and it
 * is why `maxConcurrent` matters more for Codex: two Codex runs started in the
 * same second could read each other's rollout.
 */
export function findCodexTranscript(home: string, sinceMs: number): string | null {
  const root = codexTranscriptRoot(home);
  if (!existsSync(root)) return null;

  interface Found { path: string; mtimeMs: number }
  let newest: Found | null = null;

  const walk = (dir: string, depth: number): void => {
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
        // year / month / day, and no deeper.
        if (depth < 3) walk(path, depth + 1);
        continue;
      }
      if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue;
      if (stat.mtimeMs < sinceMs) continue;
      if (!newest || stat.mtimeMs > newest.mtimeMs) newest = { path, mtimeMs: stat.mtimeMs };
    }
  };

  walk(root, 0);
  // Assigned inside the closure, which control-flow analysis does not follow.
  return (newest as Found | null)?.path ?? null;
}
