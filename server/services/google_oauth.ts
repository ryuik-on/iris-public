import { createHash, randomBytes } from 'crypto';
import { OAuthStore } from './oauth_store.js';

/**
 * Plain Google OAuth, for the services that have no MCP server.
 *
 * The existing flow goes through the MCP SDK's `auth()`, which does discovery
 * against an MCP server URL. Gmail has no such server here, and inventing a
 * URL to satisfy a code path would be a guess in the one place where a guess
 * costs a credential.
 *
 * This is the ordinary authorization-code flow with PKCE, which is what the
 * MCP one wraps anyway. Three things it keeps from what the MCP path learned
 * the hard way on 2026-08-20:
 *
 *   `access_type=offline` and `prompt=consent`, or Google returns no refresh
 *   token and the grant lasts an hour. A flow that day came back without one
 *   and nobody noticed until it expired.
 *
 *   The verifier is stored with the state, in the database, and read back at
 *   the callback. The MCP provider held it in memory, so a restart between
 *   consent and callback lost an exchange the database could have completed.
 *
 *   Read-only scopes only. Anything that can send belongs behind the approval
 *   boundary, not behind a consent screen clicked once.
 */

const AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';

/** Read-only, per service. Widening one is a decision, not a configuration. */
export const GOOGLE_SERVICE_SCOPES: Record<string, string[]> = {
  gmail: ['https://www.googleapis.com/auth/gmail.readonly'],
};

export interface GoogleOAuthOptions {
  store: OAuthStore;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
  onEvent?: (event: { type: string; detail?: Record<string, any> }) => void;
}

export interface StartResult {
  authorizationUrl: string;
  state: string;
}

export class GoogleOAuth {
  constructor(private options: GoogleOAuthOptions) {}

  /** The URL a person opens, and the flow row that will complete it. */
  start(service: string): StartResult {
    const scopes = GOOGLE_SERVICE_SCOPES[service];
    if (!scopes || scopes.length === 0) {
      throw new Error(`${service} に対する要求スコープが定義されていません。`);
    }

    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');

    // Written before the URL is handed over, so the callback can complete even
    // if this process restarts in between. `beginFlow` mints the state and
    // stores the verifier with it in one step.
    const state = this.options.store.beginFlow(service, verifier);

    const url = new URL(AUTHORIZE);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.options.clientId);
    url.searchParams.set('redirect_uri', this.options.redirectUri);
    url.searchParams.set('scope', scopes.join(' '));
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    // Without both of these Google returns no refresh token and the grant is
    // good for an hour.
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');

    this.options.onEvent?.({ type: 'google_oauth.started', detail: { service } });
    return { authorizationUrl: url.toString(), state };
  }

  /** Exchanges the code for tokens, using the verifier stored with the state. */
  async complete(state: string, code: string): Promise<{ service: string; hasRefreshToken: boolean }> {
    const flow = this.options.store.claimFlow(state);
    if (!flow) {
      throw new Error('この認可要求は当サーバが発行したものではないか、期限切れです。');
    }
    return this.completeWithFlow(flow, code);
  }

  /**
   * The same exchange, for a flow the caller has already claimed.
   *
   * Exists because one callback endpoint serves both this and the MCP path,
   * and a flow can only be claimed once — whichever route reads the state has
   * to be the one that consumes it.
   */
  async completeWithFlow(
    flow: { serverId: string; codeVerifier: string },
    code: string
  ): Promise<{ service: string; hasRefreshToken: boolean }> {

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: this.options.clientId,
      redirect_uri: this.options.redirectUri,
      code_verifier: flow.codeVerifier,
      ...(this.options.clientSecret ? { client_secret: this.options.clientSecret } : {}),
    });

    const fetchImpl = this.options.fetchImpl ?? fetch;
    const response = await fetchImpl(TOKEN, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      // Reported as the server sent it. On 2026-08-20 an exchange failure was
      // masked by a retry and the real cause — a duplicated client secret in
      // .env — only surfaced once the masking was removed.
      throw new Error(`トークン交換に失敗しました (${response.status}): ${text.slice(0, 300)}`);
    }

    const tokens = (await response.json()) as any;
    this.options.store.saveTokens(flow.serverId, tokens);
    this.options.onEvent?.({
      type: 'google_oauth.completed',
      detail: { service: flow.serverId, hasRefreshToken: Boolean(tokens.refresh_token) },
    });
    return { service: flow.serverId, hasRefreshToken: Boolean(tokens.refresh_token) };
  }
}
