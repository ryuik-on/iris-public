import { OAuthStore } from './oauth_store.js';
import { EmailMessage } from '../core/finance_email.js';

/**
 * Card notifications, read through Gmail's ordinary REST API.
 *
 * Plain OAuth rather than the MCP flow the calendar uses. That is not a
 * preference: the MCP path exists because Google publishes an MCP server for
 * Calendar, and every `tools/call` against it returns "The caller does not
 * have permission" for a credential the REST API answers 200 for — verified
 * again on 2026-08-20. The REST API is the path that works, and it is also
 * the only one available here.
 *
 * The scope is `gmail.readonly` and nothing else. IRIS has no business
 * sending mail, and a scope that allows it would be a standing capability
 * granted for a feature that reads.
 *
 * Nothing here decides what a message means. It fetches, and
 * `finance_email.ts` refuses anything it does not have a template for — the
 * rule the register set for this feature is that an unrecognised message
 * produces nothing rather than a guess.
 */

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const REFRESH_MARGIN_MS = 5 * 60_000;

export class GmailUnavailableError extends Error {
  constructor(public readonly code: string, message: string, public readonly hint?: string) {
    super(message);
    this.name = 'GmailUnavailableError';
  }
}

export interface GmailOptions {
  store: OAuthStore;
  clientId: string;
  clientSecret?: string;
  serverId?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  onEvent?: (event: { type: string; detail?: Record<string, any> }) => void;
}

export class GmailClient {
  private readonly serverId: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private options: GmailOptions) {
    this.serverId = options.serverId ?? 'gmail';
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** Whether there is a credential to try at all. */
  configured(): boolean {
    return Boolean(this.options.clientId) && this.options.store.status(this.serverId).hasToken;
  }

  private async withTimeout<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 20_000);
    try {
      return await run(controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * A usable access token, refreshed ahead of expiry.
   *
   * Ahead rather than in response to a 401, for the reason the calendar client
   * gives: a 401 arrives in the middle of answering a question, and threading
   * the retry through every call site is more places to get it wrong.
   */
  private async accessToken(): Promise<string> {
    const tokens = this.options.store.getTokens(this.serverId);
    if (!tokens?.access_token) {
      throw new GmailUnavailableError(
        'not_authorized',
        'Gmail の認可がありません。',
        'POST /api/google/oauth/start に {"service":"gmail"} で認可を開始してください。'
      );
    }

    const status = this.options.store.status(this.serverId);
    const expiresAt = status.expiresAt ? Date.parse(status.expiresAt) : null;
    if (expiresAt === null || expiresAt - Date.now() >= REFRESH_MARGIN_MS) return tokens.access_token;

    if (!tokens.refresh_token) {
      throw new GmailUnavailableError(
        'no_refresh_token',
        'アクセストークンが期限切れで、更新トークンがありません。',
        '再認可が必要です。access_type=offline と prompt=consent が付いているか確認してください。'
      );
    }
    return this.refresh(tokens.refresh_token);
  }

  private async refresh(refreshToken: string): Promise<string> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: this.options.clientId,
      ...(this.options.clientSecret ? { client_secret: this.options.clientSecret } : {}),
    });

    const response = await this.withTimeout((signal) =>
      this.fetchImpl(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        signal,
      })
    );
    if (!response.ok) {
      // Invalidated rather than kept: a refresh token the server rejects is
      // not going to start working, and keeping it makes `configured()` lie.
      this.options.store.revoke(this.serverId);
      this.options.onEvent?.({
        type: 'gmail.refresh_failed',
        detail: { status: response.status },
      });
      throw new GmailUnavailableError('refresh_failed', `更新に失敗しました (${response.status})。`);
    }

    const refreshed = (await response.json()) as any;
    this.options.store.saveTokens(this.serverId, {
      ...refreshed,
      refresh_token: refreshed.refresh_token ?? refreshToken,
    });
    this.options.onEvent?.({ type: 'gmail.refreshed', detail: { server: this.serverId } });
    return refreshed.access_token;
  }

  private async get(path: string): Promise<any> {
    const token = await this.accessToken();
    const response = await this.withTimeout((signal) =>
      this.fetchImpl(`${API}${path}`, {
        headers: { authorization: `Bearer ${token}` },
        signal,
      })
    );
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      /**
       * Enough of the body to keep the remedy in it.
       *
       * Truncated at 200 characters, Google's "the API is not enabled" reply
       * lost the console URL that fixes it — an error that cuts off its own
       *答え costs more than the bytes it saved.
       */
      throw new GmailUnavailableError('request_failed', `Gmail API ${response.status}: ${body.slice(0, 1200)}`);
    }
    return response.json();
  }

  /**
   * Messages matching a Gmail search, newest first.
   *
   * The query is built by the caller from the senders it has templates for.
   * Fetching everything and filtering here would mean pulling the whole inbox
   * across the network to throw most of it away, and it would put mail IRIS
   * has no business reading into this process.
   */
  async search(query: string, limit = 500): Promise<SearchResult> {
    /**
     * Paged until Gmail runs out, or until the cap.
     *
     * A single page was the first shape and it silently returned a partial
     * answer: a 60-day import stopped at fifty messages and reported two
     * purchases for July against forty-two for August — which reads as a quiet
     * month rather than a truncated fetch. Raising the page size only moves
     * the number at which it happens.
     *
     * `truncated` still exists, because a cap that can be hit must say when it
     * was. It is a guard against an unbounded fetch, not a limit anyone should
     * be relying on.
     */
    const ids: string[] = [];
    let pageToken: string | undefined;
    let truncated = false;

    do {
      const page = await this.get(
        `/messages?q=${encodeURIComponent(query)}&maxResults=200` +
          (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '')
      );
      for (const m of page.messages ?? []) {
        if (ids.length >= limit) { truncated = true; break; }
        ids.push(m.id);
      }
      pageToken = ids.length >= limit ? undefined : page.nextPageToken;
      if (page.nextPageToken && ids.length >= limit) truncated = true;
    } while (pageToken);

    const messages: EmailMessage[] = [];
    for (const id of ids) {
      const full = await this.get(`/messages/${id}?format=full`);
      const headers: Array<{ name: string; value: string }> = full.payload?.headers ?? [];
      const header = (name: string) =>
        headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';

      messages.push({
        id,
        from: header('from'),
        subject: header('subject'),
        body: extractPlainText(full.payload),
        receivedAt: full.internalDate
          ? new Date(Number(full.internalDate)).toISOString()
          : undefined,
      });
    }
    return { messages, truncated };
  }
}

export interface SearchResult {
  messages: EmailMessage[];
  /** True when Gmail had more matches than were fetched. */
  truncated: boolean;
}

/**
 * The plain-text part of a message.
 *
 * Preferred over HTML deliberately. These issuers send both, and the text part
 * is the one whose line breaks the templates were written against — parsing
 * the HTML would mean stripping tags and hoping the result lines up, which is
 * the kind of hoping that puts a wrong number in a spending total.
 */
export function extractPlainText(payload: any): string {
  if (!payload) return '';

  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }
  for (const part of payload.parts ?? []) {
    const text = extractPlainText(part);
    if (text) return text;
  }
  // Only if there is no text part at all. Returning the HTML unparsed is
  // better than returning nothing: the template will fail to match it and the
  // message will be reported as unreadable, which is the correct outcome.
  if (payload.body?.data) return decodeBase64Url(payload.body.data);
  return '';
}

export function decodeBase64Url(data: string): string {
  const normalized = data.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalized, 'base64').toString('utf-8');
}
