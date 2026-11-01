import {
  ExternalSourceError, FetchLike, clampInt, decodeEntities, fetchJson, fetchText, plainText,
} from './external_http.js';

/**
 * General web search, through whichever provider is configured.
 *
 * Tavily (`TAVILY_API_KEY`) and Brave (`BRAVE_SEARCH_API_KEY`) have APIs made
 * for this. DuckDuckGo needs no key and is the fallback, read from its HTML
 * endpoint — not an API, so it can change or answer with a bot check; when the
 * page holds no results and does not say there were none, that is reported as
 * a failure rather than as an empty search.
 *
 * `WEB_SEARCH_PROVIDER` picks one explicitly. Otherwise the first provider
 * with a key wins, then DuckDuckGo.
 */

export type WebSearchProvider = 'tavily' | 'brave' | 'duckduckgo';
export const WEB_SEARCH_PROVIDERS: WebSearchProvider[] = ['tavily', 'brave', 'duckduckgo'];
export const WEB_SEARCH_MAX_RESULTS = 20;
const SNIPPET_LIMIT = 500;

export interface WebSearchHit {
  title: string;
  url: string;
  snippet: string;
  published?: string;
}

export interface WebSearchResult {
  provider: WebSearchProvider;
  query: string;
  /** Tavily's own summary, when it gives one. */
  answer?: string;
  results: WebSearchHit[];
}

export interface WebSearchOptions {
  maxResults?: number;
  /** Restrict to recent pages. Not every provider supports every value. */
  recency?: 'day' | 'week' | 'month' | 'year';
}

export interface WebSearchConfig {
  provider?: string;
  tavilyApiKey?: string;
  braveApiKey?: string;
  fetch?: FetchLike;
}

export function chooseProvider(config: WebSearchConfig): WebSearchProvider {
  const wanted = config.provider?.trim().toLowerCase();
  if (wanted) {
    if (!WEB_SEARCH_PROVIDERS.includes(wanted as WebSearchProvider)) {
      throw new ExternalSourceError('Web 検索', `WEB_SEARCH_PROVIDER が不明です: ${wanted}（${WEB_SEARCH_PROVIDERS.join(' / ')}）`);
    }
    return wanted as WebSearchProvider;
  }
  if (config.tavilyApiKey) return 'tavily';
  if (config.braveApiKey) return 'brave';
  return 'duckduckgo';
}

export function webSearchConfigFromEnv(env: NodeJS.ProcessEnv = process.env): WebSearchConfig {
  return {
    provider: env.WEB_SEARCH_PROVIDER || undefined,
    tavilyApiKey: env.TAVILY_API_KEY || undefined,
    braveApiKey: env.BRAVE_SEARCH_API_KEY || undefined,
  };
}

function snippet(text: string): string {
  const clean = plainText(text);
  return clean.length > SNIPPET_LIMIT ? `${clean.slice(0, SNIPPET_LIMIT)}…` : clean;
}

export class WebSearchClient {
  private readonly fetchImpl: FetchLike;

  constructor(private readonly config: WebSearchConfig = {}) {
    this.fetchImpl = config.fetch ?? ((url, init) => fetch(url, init));
  }

  get provider(): WebSearchProvider {
    return chooseProvider(this.config);
  }

  async search(query: string, options: WebSearchOptions = {}, signal?: AbortSignal): Promise<WebSearchResult> {
    const term = String(query ?? '').trim();
    if (!term) throw new ExternalSourceError('Web 検索', '検索語が空です。');
    const max = clampInt(options.maxResults, 5, 1, WEB_SEARCH_MAX_RESULTS);
    const provider = this.provider;

    switch (provider) {
      case 'tavily': return this.tavily(term, max, options, signal);
      case 'brave': return this.brave(term, max, options, signal);
      case 'duckduckgo': return this.duckduckgo(term, max, options, signal);
    }
  }

  private async tavily(query: string, max: number, options: WebSearchOptions, signal?: AbortSignal): Promise<WebSearchResult> {
    const key = this.config.tavilyApiKey;
    if (!key) throw new ExternalSourceError('Tavily', 'TAVILY_API_KEY が設定されていません。');
    const body: Record<string, unknown> = { query, max_results: max, search_depth: 'basic', include_answer: true };
    if (options.recency) body.time_range = options.recency;
    const data = await fetchJson(this.fetchImpl, 'Tavily', 'https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    }, signal);
    if (!Array.isArray(data?.results)) throw new ExternalSourceError('Tavily', '応答に results がありません。');
    return {
      provider: 'tavily',
      query,
      answer: typeof data.answer === 'string' && data.answer ? data.answer : undefined,
      results: data.results.slice(0, max).map((r: any) => ({
        title: plainText(String(r?.title ?? '')),
        url: String(r?.url ?? ''),
        snippet: snippet(String(r?.content ?? '')),
        published: r?.published_date || undefined,
      })),
    };
  }

  private async brave(query: string, max: number, options: WebSearchOptions, signal?: AbortSignal): Promise<WebSearchResult> {
    const key = this.config.braveApiKey;
    if (!key) throw new ExternalSourceError('Brave Search', 'BRAVE_SEARCH_API_KEY が設定されていません。');
    const params = new URLSearchParams({ q: query, count: String(max) });
    const freshness = { day: 'pd', week: 'pw', month: 'pm', year: 'py' } as const;
    if (options.recency) params.set('freshness', freshness[options.recency]);
    const data = await fetchJson(this.fetchImpl, 'Brave Search', `https://api.search.brave.com/res/v1/web/search?${params}`, {
      headers: { Accept: 'application/json', 'X-Subscription-Token': key },
    }, signal);
    // A query with no web results comes back without `web` at all.
    const results: any[] = data?.web?.results ?? [];
    return {
      provider: 'brave',
      query,
      results: results.slice(0, max).map((r) => ({
        title: plainText(String(r?.title ?? '')),
        url: String(r?.url ?? ''),
        snippet: snippet(String(r?.description ?? '')),
        published: r?.page_age || r?.age || undefined,
      })),
    };
  }

  private async duckduckgo(query: string, max: number, options: WebSearchOptions, signal?: AbortSignal): Promise<WebSearchResult> {
    const params = new URLSearchParams({ q: query });
    const recency = { day: 'd', week: 'w', month: 'm', year: 'y' } as const;
    if (options.recency) params.set('df', recency[options.recency]);
    const html = await fetchText(this.fetchImpl, 'DuckDuckGo', `https://html.duckduckgo.com/html/?${params}`, {
      headers: { Accept: 'text/html' },
    }, signal);
    const results = parseDuckDuckGo(html).slice(0, max);
    if (!results.length && !/No results|結果が見つかりません|no-results/i.test(html)) {
      throw new ExternalSourceError(
        'DuckDuckGo',
        '結果のページを読み取れませんでした（ボット確認の画面か、構成の変更の可能性）。「該当なし」とは扱わないでください。' +
          'TAVILY_API_KEY か BRAVE_SEARCH_API_KEY を設定すると API 経由で検索できます。'
      );
    }
    return { provider: 'duckduckgo', query, results };
  }
}

/** Result links on html.duckduckgo.com, with its redirect unwrapped and ads skipped. */
export function parseDuckDuckGo(html: string): WebSearchHit[] {
  const out: WebSearchHit[] = [];
  const blocks = html.split(/<div[^>]+class="[^"]*\bresult\b[^"]*"/i).slice(1);
  for (const block of blocks) {
    if (/result--ad\b/.test(block.slice(0, 200)) || /y\.js\?ad_/.test(block)) continue;
    const link = block.match(/<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
      ?? block.match(/<a[^>]+href="([^"]+)"[^>]*class="[^"]*result__a[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    const url = unwrapDuckDuckGo(decodeEntities(link[1]));
    if (!url) continue;
    const snip = block.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|td)>/i);
    out.push({ title: plainText(link[2]), url, snippet: snippet(snip?.[1] ?? '') });
  }
  return out;
}

function unwrapDuckDuckGo(href: string): string | null {
  const absolute = href.startsWith('//') ? `https:${href}` : href;
  try {
    const u = new URL(absolute, 'https://duckduckgo.com');
    const target = u.searchParams.get('uddg');
    if (target) return target;
    return /^https?:$/.test(u.protocol) && !/duckduckgo\.com$/.test(u.hostname) ? u.toString() : null;
  } catch {
    return null;
  }
}
