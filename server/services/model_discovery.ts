import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { GoogleGenAI } from '@google/genai';

/**
 * Asks each provider which models it actually serves.
 *
 * Today a hardcoded `claude-3-5-sonnet-20241022` sat in the Anthropic provider
 * for months and only failed once a key was supplied — a model id rots
 * silently, and no amount of care in writing one down prevents that. The
 * answer is not a better-maintained list but not maintaining one: ask.
 *
 * This is the discovery half of §23 (Model Lifecycle). Deprecation detection
 * and fallback policy build on it, but knowing what exists comes first.
 *
 * Discovery is best-effort by design. A provider that cannot be reached
 * produces an unavailable result, never a thrown error and never a claim that
 * a model is missing — "I could not check" and "it is not there" are different
 * answers, and conflating them would make a network blip look like a
 * retirement.
 */

export interface DiscoveredModel {
  id: string;
  displayName?: string;
  createdAt?: string;
  /**
   * What the model can be asked to do, when the provider says.
   *
   * Only Gemini reports this, and it is worth keeping because it separates a
   * chat model from an embedding or image model without pattern-matching the
   * name — `gemini-2.5-flash-image` and `gemini-2.5-flash` differ by a suffix
   * and by everything else.
   */
  supportedActions?: string[];
}

export interface ProviderModels {
  provider: string;
  available: boolean;
  models: DiscoveredModel[];
  /** Why discovery failed, when it did. */
  error?: string;
  checkedAt: string;
}

const DISCOVERY_TIMEOUT_MS = 15_000;

export async function discoverAnthropicModels(apiKey: string): Promise<ProviderModels> {
  const checkedAt = new Date().toISOString();
  try {
    const client = new Anthropic({ apiKey, maxRetries: 0, timeout: DISCOVERY_TIMEOUT_MS });
    const models: DiscoveredModel[] = [];
    for await (const model of client.models.list()) {
      models.push({
        id: model.id,
        displayName: (model as any).display_name,
        createdAt: (model as any).created_at,
      });
    }
    return { provider: 'anthropic', available: true, models, checkedAt };
  } catch (err: any) {
    return {
      provider: 'anthropic',
      available: false,
      models: [],
      error: err?.message ?? String(err),
      checkedAt,
    };
  }
}

export async function discoverOpenAIModels(apiKey: string): Promise<ProviderModels> {
  const checkedAt = new Date().toISOString();
  try {
    const client = new OpenAI({ apiKey, maxRetries: 0, timeout: DISCOVERY_TIMEOUT_MS });
    const models: DiscoveredModel[] = [];
    for await (const model of client.models.list()) {
      models.push({
        id: model.id,
        createdAt: model.created ? new Date(model.created * 1000).toISOString() : undefined,
      });
    }
    // OpenAI lists everything including embeddings and audio; newest first is
    // the useful order for a human deciding what to configure.
    models.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
    return { provider: 'openai', available: true, models, checkedAt };
  } catch (err: any) {
    return {
      provider: 'openai',
      available: false,
      models: [],
      error: err?.message ?? String(err),
      checkedAt,
    };
  }
}

/**
 * Gemini's models.
 *
 * Added last and mattering most: Gemini is the provider IRIS actually runs on,
 * and the incident this whole area exists for — a configured model becoming
 * unavailable and needing a fix on the machine — was a Gemini model. Discovery
 * covered Anthropic and OpenAI and not the one that had broken.
 *
 * Ids come back as `models/gemini-2.5-flash`; the prefix is stripped because
 * that is not what goes in `GEMINI_MODEL`, and comparing the two forms would
 * report every configured model as missing.
 */
export async function discoverGeminiModels(apiKey: string): Promise<ProviderModels> {
  const checkedAt = new Date().toISOString();
  try {
    const ai = new GoogleGenAI({ apiKey });
    const models: DiscoveredModel[] = [];
    const pager: any = await ai.models.list();
    for await (const model of pager as AsyncIterable<any>) {
      models.push({
        id: String(model?.name ?? '').replace(/^models\//, ''),
        displayName: model?.displayName,
        supportedActions: Array.isArray(model?.supportedActions) ? model.supportedActions : undefined,
      });
      // Bounded: a paging fault on either side should cost a short list, not
      // a process that never finishes starting up.
      if (models.length >= 500) break;
    }
    return { provider: 'gemini', available: true, models: models.filter((m) => m.id), checkedAt };
  } catch (err: any) {
    return {
      provider: 'gemini',
      available: false,
      models: [],
      error: err?.message ?? String(err),
      checkedAt,
    };
  }
}

export async function discoverAll(env: NodeJS.ProcessEnv = process.env): Promise<ProviderModels[]> {
  const checks: Promise<ProviderModels>[] = [];
  if (env.ANTHROPIC_API_KEY?.trim()) checks.push(discoverAnthropicModels(env.ANTHROPIC_API_KEY.trim()));
  if (env.OPENAI_API_KEY?.trim()) checks.push(discoverOpenAIModels(env.OPENAI_API_KEY.trim()));
  if (env.GEMINI_API_KEY?.trim()) checks.push(discoverGeminiModels(env.GEMINI_API_KEY.trim()));
  return Promise.all(checks);
}

export interface ModelCheck {
  provider: string;
  setting: string;
  configured: string;
  /** Undefined when discovery failed — not knowing is distinct from missing. */
  present?: boolean;
  suggestion?: string;
  note: string;
}

/**
 * Checks a configured model against what the provider actually serves.
 *
 * Returns `present: undefined` when discovery failed, so a caller cannot
 * mistake an unreachable provider for a retired model.
 */
export function checkConfiguredModel(
  discovery: ProviderModels,
  setting: string,
  configured: string | undefined,
  chatModelHint: RegExp
): ModelCheck | null {
  const trimmed = configured?.trim();
  if (!trimmed) return null;
  // The guard trimmed while the comparison did not, so a stray space in an
  // env var reported a live model as missing. Found by cross-provider review.
  configured = trimmed;

  if (!discovery.available) {
    return {
      provider: discovery.provider,
      setting,
      configured,
      note: `モデル一覧を取得できなかったため確認できませんでした: ${discovery.error ?? 'unknown'}`,
    };
  }

  const present = discovery.models.some((m) => m.id === configured);
  if (present) {
    return {
      provider: discovery.provider,
      setting,
      configured,
      present: true,
      note: 'このモデルは現在も提供されています。',
    };
  }

  // Rebuilt without global/sticky flags: those carry lastIndex between calls,
  // which would make the candidate list depend on call order.
  const hint = new RegExp(chatModelHint.source, chatModelHint.flags.replace(/[gy]/g, ''));
  const candidates = discovery.models
    .filter((m) => hint.test(m.id))
    // When the provider says what a model can do, believe it rather than the
    // name. Suggesting an image or embedding model as a replacement for a chat
    // model is a suggestion that fails on first use.
    .filter((m) => !m.supportedActions || m.supportedActions.includes('generateContent'))
    .slice(0, 5);
  return {
    provider: discovery.provider,
    setting,
    configured,
    present: false,
    suggestion: candidates[0]?.id,
    note:
      `${configured} は現在の提供モデル一覧にありません。リクエストは 404 になります。` +
      (candidates.length > 0 ? ` 候補: ${candidates.map((c) => c.id).join(', ')}` : ''),
  };
}

// ---------------------------------------------------------------------------

/**
 * What was known about a configured model, and when.
 *
 * Discovery answers "does this exist right now". This answers "when did we
 * last know it did", which is the question after a restart and the one an
 * in-memory result cannot answer at all.
 */
export interface StoredModelCheck extends ModelCheck {
  checkedAt: string;
  /** The last time it was actually seen, kept across later failures. */
  lastPresentAt: string | null;
}

export class ModelCheckStore {
  constructor(private db: any) {}

  record(check: ModelCheck, checkedAt = new Date().toISOString()): void {
    // `present` stays null when discovery could not run. Storing a failure to
    // check as a failed check would make an unreachable provider look like a
    // retired model, which is the distinction the whole module is built on.
    const present = check.present === undefined ? null : check.present ? 1 : 0;
    this.db
      .prepare(
        `INSERT INTO model_checks (setting, provider, model, present, note, checked_at, last_present_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(setting) DO UPDATE SET
           provider = excluded.provider,
           model = excluded.model,
           present = excluded.present,
           note = excluded.note,
           checked_at = excluded.checked_at,
           /* Moved forward only by an actual sighting, and dropped entirely
              when the configured model changes.
              Carrying it across a change misattributes it: the row would say
              a newly-configured id was last working at a time when a
              different id was. Found by deliberately configuring a retired
              model and reading the row back. */
           last_present_at = CASE
             WHEN excluded.present = 1 THEN excluded.checked_at
             WHEN model_checks.model = excluded.model THEN model_checks.last_present_at
             ELSE NULL END`
      )
      .run(
        check.setting,
        check.provider,
        check.configured,
        present,
        check.note,
        checkedAt,
        present === 1 ? checkedAt : null
      );
  }

  list(): StoredModelCheck[] {
    const rows = this.db
      .prepare(`SELECT * FROM model_checks ORDER BY provider, setting`)
      .all() as any[];
    return rows.map((r) => ({
      provider: r.provider,
      setting: r.setting,
      configured: r.model,
      present: r.present === null ? undefined : r.present === 1,
      note: r.note ?? '',
      checkedAt: r.checked_at,
      lastPresentAt: r.last_present_at ?? null,
    }));
  }

  /** The ones that are known to be gone. Not the ones that could not be checked. */
  missing(): StoredModelCheck[] {
    return this.list().filter((c) => c.present === false);
  }
}

/**
 * Checks every configured model against what its provider serves.
 *
 * Gathered here rather than in the route so the same list is used by the
 * endpoint and by whatever runs on a timer — two lists would drift, and the
 * one that drifts is always the one nobody is looking at.
 */
export function checkConfigured(
  discovery: ProviderModels[],
  env: NodeJS.ProcessEnv = process.env
): ModelCheck[] {
  const checks: (ModelCheck | null)[] = [];
  for (const d of discovery) {
    if (d.provider === 'anthropic') {
      checks.push(checkConfiguredModel(d, 'ANTHROPIC_MODEL', env.ANTHROPIC_MODEL, /^claude-/));
      checks.push(checkConfiguredModel(d, 'ANTHROPIC_REVIEW_MODEL', env.ANTHROPIC_REVIEW_MODEL, /^claude-/));
    } else if (d.provider === 'openai') {
      checks.push(
        checkConfiguredModel(
          d,
          env.OPENAI_MODEL ? 'OPENAI_MODEL' : 'REVIEW_PRIMARY_MODEL',
          env.OPENAI_MODEL || env.REVIEW_PRIMARY_MODEL,
          /^(gpt|o\d)/
        )
      );
    } else if (d.provider === 'gemini') {
      checks.push(checkConfiguredModel(d, 'GEMINI_MODEL', env.GEMINI_MODEL, /^gemini-/));
    }
  }
  return checks.filter(Boolean) as ModelCheck[];
}
