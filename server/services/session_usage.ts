import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join } from 'path';

import { MODEL_PRICES, PRICING_LAST_VERIFIED } from '../core/usage.js';

/**
 * Where the week actually went, across every session on this machine.
 *
 * The allowance API returns one number — 90% of the week used — and nothing
 * that says which of six projects spent it. The transcripts do: every
 * assistant message carries its own token counts, and they are grouped by the
 * directory the session ran in.
 *
 * Two things this deliberately does not pretend.
 *
 * A token is not a point. The relation between tokens and a percentage of the
 * weekly allowance is not published, and it plainly is not linear across
 * models — an Opus token and a Haiku token cannot cost the same share of the
 * same week. So the weighting uses list prices as a proxy, which is a
 * defensible guess and still a guess. Everything derived from it is reported
 * as an estimate and labelled.
 *
 * And a cached token is not a fresh one. Cache reads are a tenth of the price
 * of input and there are two orders of magnitude more of them — 13.9 billion
 * against 25 million of output last week — so a sum over raw token counts is
 * dominated entirely by the cheapest thing in it. Summing them was the first
 * thing tried and it ranked the projects by how often they re-read a file.
 */

export interface ProjectUsage {
  project: string;
  /** Raw counts, which are measured rather than derived. */
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  inputTokens: number;
  messages: number;
  /**
   * Weighted by list price, in dollars.
   *
   * Not a bill — the account is a subscription and none of this is charged.
   * It is here as the least-bad way to compare an hour of Opus against an
   * hour of Haiku, which raw tokens cannot do.
   */
  weightedUsd: number;
  /** That weight as a share of the whole window. */
  sharePercent: number;
}

export interface SessionUsageRead {
  since: string;
  projects: ProjectUsage[];
  /** Files that could not be read, counted rather than skipped silently. */
  unreadable: number;
  pricingLastVerified: string;
}

/** Cache writes cost more than fresh input; cache reads cost a fraction of it. */
const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_FALLBACK = 0.1;

function priceOf(model: string | null | undefined) {
  if (!model) return null;
  if (MODEL_PRICES[model]) return MODEL_PRICES[model];
  // Claude Code reports dated ids like `claude-haiku-4-5-20251001`; the table
  // is keyed without the date. Matching on prefix keeps a model priced rather
  // than silently free, which is the direction that gets noticed.
  const key = Object.keys(MODEL_PRICES).find((k) => model.startsWith(k));
  return key ? MODEL_PRICES[key] : null;
}

function projectOf(slug: string): string {
  const cleaned = slug.replace(/^-Users-[^-]+-/, '');
  const parts = cleaned.split('-').filter((p) => p && !/^\d+$/.test(p));
  return parts[parts.length - 1] ?? cleaned;
}

/**
 * Reads every Claude Code transcript touched inside the window.
 *
 * Files are filtered by modification time before being opened, because the
 * whole history is several hundred files and only the recent ones can contain
 * recent messages. Each message is still checked against the window by its own
 * timestamp — a file touched today can be mostly last month.
 */
export function readSessionUsage(home: string, days = 7, now = () => Date.now()): SessionUsageRead {
  const root = join(home, '.claude', 'projects');
  const sinceMs = now() - days * 86_400_000;
  const since = new Date(sinceMs).toISOString();
  if (!existsSync(root)) {
    return { since, projects: [], unreadable: 0, pricingLastVerified: PRICING_LAST_VERIFIED };
  }

  const totals = new Map<string, ProjectUsage>();
  let unreadable = 0;

  for (const slug of readdirSync(root)) {
    const dir = join(root, slug);
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      unreadable++;
      continue;
    }

    for (const file of files) {
      const path = join(dir, file);
      try {
        if (statSync(path).mtimeMs < sinceMs) continue;
      } catch {
        unreadable++;
        continue;
      }

      let text: string;
      try {
        text = readFileSync(path, 'utf-8');
      } catch {
        unreadable++;
        continue;
      }

      const project = projectOf(slug);
      const row =
        totals.get(project) ??
        {
          project,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          inputTokens: 0,
          messages: 0,
          weightedUsd: 0,
          sharePercent: 0,
        };

      for (const line of text.split('\n')) {
        if (!line || !line.includes('"usage"')) continue;
        let record: any;
        try {
          record = JSON.parse(line);
        } catch {
          continue;
        }
        const usage = record?.message?.usage;
        const at = Date.parse(record?.timestamp ?? '');
        if (!usage || !Number.isFinite(at) || at < sinceMs) continue;

        const output = usage.output_tokens ?? 0;
        const input = usage.input_tokens ?? 0;
        const write = usage.cache_creation_input_tokens ?? 0;
        const read = usage.cache_read_input_tokens ?? 0;

        row.messages++;
        row.outputTokens += output;
        row.inputTokens += input;
        row.cacheCreationTokens += write;
        row.cacheReadTokens += read;

        const price = priceOf(record?.message?.model);
        if (price) {
          const readRate = price.cacheReadPerMillion ?? price.inputPerMillion * CACHE_READ_FALLBACK;
          row.weightedUsd +=
            (input * price.inputPerMillion +
              write * price.inputPerMillion * CACHE_WRITE_MULTIPLIER +
              read * readRate +
              output * price.outputPerMillion) /
            1_000_000;
        }
      }

      totals.set(project, row);
    }
  }

  const projects = [...totals.values()].filter((p) => p.messages > 0);
  const whole = projects.reduce((sum, p) => sum + p.weightedUsd, 0);
  for (const p of projects) {
    p.weightedUsd = Math.round(p.weightedUsd * 100) / 100;
    p.sharePercent = whole > 0 ? Math.round((p.weightedUsd / whole) * 1000) / 10 : 0;
  }
  projects.sort((a, b) => b.weightedUsd - a.weightedUsd);

  return { since, projects, unreadable, pricingLastVerified: PRICING_LAST_VERIFIED };
}
