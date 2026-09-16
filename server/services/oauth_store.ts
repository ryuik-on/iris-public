import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';

/**
 * OAuth credentials for external tool servers.
 *
 * These are bearer tokens for the user's mail, calendar and files — the most
 * sensitive thing this system holds by a wide margin. Three rules follow from
 * that, and they are the reason this is its own module rather than a couple of
 * queries inline:
 *
 *   Nothing returns a token over HTTP. The status endpoint reports whether one
 *   exists and when it expires, which is what a person actually needs to know.
 *
 *   Nothing writes one to a log. Not at debug level, not in an error path.
 *
 *   A flow's PKCE verifier and CSRF state live only until the flow completes,
 *   and a callback whose state is unknown is rejected rather than tolerated —
 *   an unsolicited callback is either a bug or an attack and neither deserves
 *   a token.
 */

export interface StoredTokens {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
}

export interface TokenStatus {
  serverId: string;
  hasToken: boolean;
  hasRefreshToken: boolean;
  expiresAt: string | null;
  expired: boolean;
  scope: string | null;
  updatedAt: string | null;
}

export class OAuthStore {
  constructor(private db: Database.Database) {}

  saveTokens(serverId: string, tokens: StoredTokens) {
    const now = new Date().toISOString();
    const expiresAt = tokens.expires_in
      ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
      : null;

    this.db
      .prepare(
        `INSERT INTO oauth_tokens (server_id, tokens_json, expires_at, scope, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(server_id) DO UPDATE SET
           tokens_json = excluded.tokens_json,
           expires_at = excluded.expires_at,
           scope = excluded.scope,
           updated_at = excluded.updated_at`
      )
      .run(serverId, JSON.stringify(tokens), expiresAt, tokens.scope ?? null, now, now);
  }

  /** For the client only. Never for a response body. */
  getTokens(serverId: string): StoredTokens | undefined {
    const row = this.db
      .prepare(`SELECT tokens_json FROM oauth_tokens WHERE server_id = ?`)
      .get(serverId) as any;
    if (!row) return undefined;
    try {
      return JSON.parse(row.tokens_json);
    } catch {
      return undefined;
    }
  }

  /**
   * What a person can be told: that a credential exists, and until when.
   *
   * Deliberately not the token, and deliberately not a prefix of it either —
   * a "safe" fragment of a bearer token is still part of a bearer token.
   */
  status(serverId: string): TokenStatus {
    const row = this.db
      .prepare(`SELECT tokens_json, expires_at, scope, updated_at FROM oauth_tokens WHERE server_id = ?`)
      .get(serverId) as any;

    if (!row) {
      return {
        serverId,
        hasToken: false,
        hasRefreshToken: false,
        expiresAt: null,
        expired: false,
        scope: null,
        updatedAt: null,
      };
    }

    let refresh = false;
    try {
      refresh = Boolean(JSON.parse(row.tokens_json)?.refresh_token);
    } catch {
      /* an unreadable row still counts as present, and says nothing more */
    }

    return {
      serverId,
      hasToken: true,
      hasRefreshToken: refresh,
      expiresAt: row.expires_at ?? null,
      expired: row.expires_at ? Date.parse(row.expires_at) <= Date.now() : false,
      scope: row.scope ?? null,
      updatedAt: row.updated_at ?? null,
    };
  }

  allStatuses(): TokenStatus[] {
    const rows = this.db.prepare(`SELECT server_id FROM oauth_tokens ORDER BY server_id`).all() as any[];
    return rows.map((r) => this.status(r.server_id));
  }

  revoke(serverId: string): boolean {
    return this.db.prepare(`DELETE FROM oauth_tokens WHERE server_id = ?`).run(serverId).changes > 0;
  }

  // ---- one authorization attempt ----

  /**
   * Opens a flow and returns its state parameter.
   *
   * The state is what ties a callback back to a request this server actually
   * made. Anything arriving without a matching row is unsolicited.
   */
  beginFlow(serverId: string, codeVerifier: string): string {
    const state = randomBytes(24).toString('base64url');
    this.db
      .prepare(
        `INSERT INTO oauth_flows (state, server_id, code_verifier, created_at) VALUES (?, ?, ?, ?)`
      )
      .run(state, serverId, codeVerifier, new Date().toISOString());
    // Anything still open after an hour is abandoned. Left alone they
    // accumulate as a list of one-use secrets nobody will ever use.
    this.pruneFlows();
    return state;
  }

  /**
   * Attaches the PKCE verifier to a flow already issued.
   *
   * Updated in place rather than replaced. The first version deleted the row
   * and began a new one, which rotated the state *after* the authorization URL
   * had been built with the old value — so every callback arrived with a state
   * the store had just thrown away, and the CSRF check rejected it. The check
   * was right; the flow bookkeeping was wrong.
   */
  setFlowVerifier(state: string, codeVerifier: string): boolean {
    return (
      this.db
        .prepare(`UPDATE oauth_flows SET code_verifier = ? WHERE state = ?`)
        .run(codeVerifier, state).changes > 0
    );
  }

  /** Consumes a flow. One use only: a replayed callback finds nothing. */
  claimFlow(state: string, maxAgeMs = 60 * 60_000): { serverId: string; codeVerifier: string } | null {
    const row = this.db.prepare(`SELECT * FROM oauth_flows WHERE state = ?`).get(state) as any;
    if (!row) return null;
    this.db.prepare(`DELETE FROM oauth_flows WHERE state = ?`).run(state);
    if (Date.now() - Date.parse(row.created_at) > maxAgeMs) return null;
    return { serverId: row.server_id, codeVerifier: row.code_verifier };
  }

  pruneFlows(maxAgeMs = 60 * 60_000): number {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    return this.db.prepare(`DELETE FROM oauth_flows WHERE created_at < ?`).run(cutoff).changes;
  }

  openFlowCount(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM oauth_flows`).get() as any).n;
  }
}
