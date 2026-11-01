/**
 * The one way the research tools reach the network.
 *
 * Every source (PubMed, jRCT, ClinicalTrials.gov, the web search providers)
 * goes through here so that a failure reads the same whichever source it came
 * from: the source is named, the HTTP status travels as `status` — which is
 * what `defaultIsRetryable` looks at, so a 429 or a 503 is retried once by the
 * registry and a 400 is not — and the body is cut short enough to put in a
 * message.
 *
 * `fetch` is injected rather than reached for, so the tests can hand in the
 * bytes a service returns without the network.
 */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class ExternalSourceError extends Error {
  constructor(
    readonly source: string,
    message: string,
    readonly status?: number
  ) {
    super(`${source}: ${message}`);
    this.name = 'ExternalSourceError';
  }
}

/** Sent with every request. NCBI asks callers to identify themselves. */
export const USER_AGENT = 'IRIS/1.0 (personal assistant; research tools)';
export const MAX_EXTERNAL_RESPONSE_BYTES = 4 * 1024 * 1024;

async function boundedText(response: Response, source: string): Promise<string> {
  const oversized = () => new ExternalSourceError(source, '応答が上限（4MB）を超えたため読み取りを止めました。');
  if (Number(response.headers.get('content-length')) > MAX_EXTERNAL_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw oversized();
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0, text = '';
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_EXTERNAL_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw oversized();
      }
      text += decoder.decode(part.value, { stream: true });
    }
    return text + decoder.decode();
  } finally { reader.releaseLock(); }
}

export async function fetchText(
  fetchImpl: FetchLike,
  source: string,
  url: string,
  init: RequestInit = {},
  signal?: AbortSignal
): Promise<string> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      ...init,
      headers: { 'User-Agent': USER_AGENT, ...(init.headers as Record<string, string> | undefined) },
      signal,
    });
  } catch (err: any) {
    if (signal?.aborted) throw err;
    // "fetch failed" is kept in the message: it is one of the phrases the
    // retry policy recognises as transient.
    throw new ExternalSourceError(source, `接続できませんでした (${err?.cause?.code || err?.message || 'fetch failed'})`);
  }

  const body = await boundedText(response, source);
  if (!response.ok) {
    const excerpt = body.replace(/\s+/g, ' ').trim().slice(0, 200);
    throw new ExternalSourceError(
      source,
      `HTTP ${response.status}${excerpt ? ` — ${excerpt}` : ''}`,
      response.status
    );
  }
  return body;
}

export async function fetchJson<T = any>(
  fetchImpl: FetchLike,
  source: string,
  url: string,
  init: RequestInit = {},
  signal?: AbortSignal
): Promise<T> {
  const text = await fetchText(fetchImpl, source, url, init, signal);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ExternalSourceError(source, `JSON として読めない応答でした: ${text.slice(0, 120)}`);
  }
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : whole;
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? whole;
  });
}

/** Markup removed, entities decoded, whitespace collapsed. */
export function plainText(markup: string): string {
  return decodeEntities(markup.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

export function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}
