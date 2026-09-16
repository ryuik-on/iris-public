/**
 * Is the Google grant still alive?
 *
 * Measured on 2026-09-02: the Gmail refresh token had been dead since roughly
 * 8/26 and nothing had said so. Every other part of this works — the calendar
 * client distinguishes `invalid_grant` from a network fault and says 再認可 in
 * so many words. The gap is that nobody ever asks. A credential is only
 * exercised at the moment something needs it, so a dead one stays silent for
 * as long as the feature goes unused, and then fails in front of a person who
 * was in the middle of something else.
 *
 * The failure is structural rather than accidental. While an OAuth client is
 * External and in Testing, Google issues refresh tokens that expire after
 * seven days, so *every* credential here dies on a timer. Something has to
 * notice on its own.
 *
 * The one rule this module exists to keep: **a check that could not be taken
 * is not a dead credential.** A refusal from Google and an unreachable Google
 * look identical if you only look at whether the call threw, and reporting the
 * second as the first would send a person to re-consent for nothing — and,
 * worse, teach them that the warning does not mean anything.
 */

import type { OAuthStore } from './oauth_store.js';

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

/** Deliberately three-valued. `unknown` is not a soft `dead`. */
export type Liveness = 'alive' | 'dead' | 'unknown';

export interface GrantHealth {
  service: string;
  liveness: Liveness;
  /** In the words a person would use, not the protocol's. */
  reason: string;
  /** When the credential was last granted or refreshed. */
  grantedAt: string | null;
  /** When this answer was measured. Null when it never has been. */
  checkedAt: string | null;
  scope: string | null;
}

interface Cached {
  health: GrantHealth;
  at: number;
}

export interface GrantHealthOptions {
  store: OAuthStore;
  clientId: string;
  clientSecret?: string;
  fetchImpl?: typeof fetch;
  /** How long a measurement stands before it is taken again. */
  retentionMs?: number;
  timeoutMs?: number;
  now?: () => number;
}

export class GrantHealthService {
  private cache = new Map<string, Cached>();

  constructor(private options: GrantHealthOptions) {}

  private get now() {
    return this.options.now ?? Date.now;
  }

  /**
   * Every stored Google grant, with its liveness.
   *
   * Services that were never authorised do not appear. Absent and dead are
   * different facts and only one of them is about a credential.
   */
  async all(): Promise<GrantHealth[]> {
    const statuses = this.options.store.allStatuses();
    return Promise.all(statuses.map((s) => this.check(s.serverId)));
  }

  async check(service: string): Promise<GrantHealth> {
    const retention = this.options.retentionMs ?? 6 * 60 * 60 * 1000;
    const cached = this.cache.get(service);
    if (cached && this.now() - cached.at < retention) return cached.health;

    const status = this.options.store.status(service);
    const base = {
      service,
      grantedAt: status.updatedAt,
      scope: status.scope,
    };

    if (!status.hasToken) {
      return { ...base, liveness: 'dead', reason: '認可がありません。', checkedAt: null };
    }

    /*
     * No refresh token means the credential dies with its access token and
     * cannot come back on its own. That is knowable from the record — there is
     * nothing to ask Google, and asking would only produce an error to
     * misread.
     */
    if (!status.hasRefreshToken) {
      const health: GrantHealth = status.expired
        ? { ...base, liveness: 'dead', reason: '期限切れで、更新トークンがありません。再認可が要ります。', checkedAt: new Date(this.now()).toISOString() }
        : { ...base, liveness: 'alive', reason: '有効ですが更新トークンがないため、期限が来たら切れます。', checkedAt: new Date(this.now()).toISOString() };
      this.cache.set(service, { health, at: this.now() });
      return health;
    }

    const tokens = this.options.store.getTokens(service);
    const refreshToken = tokens?.refresh_token;
    if (!refreshToken) {
      // The status said there was one and the record disagrees. Not a
      // judgement about the credential — a judgement about this reading.
      return { ...base, liveness: 'unknown', reason: '記録を読めませんでした。', checkedAt: null };
    }

    const health = await this.measure(base, refreshToken);
    // Only a measurement that was actually taken is worth standing on. An
    // `unknown` cached for six hours would hide the recovery it is waiting for.
    if (health.liveness !== 'unknown') this.cache.set(service, { health, at: this.now() });
    return health;
  }

  private async measure(
    base: { service: string; grantedAt: string | null; scope: string | null },
    refreshToken: string
  ): Promise<GrantHealth> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 15_000);
    const checkedAt = new Date(this.now()).toISOString();

    try {
      const response = await fetchImpl(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: this.options.clientId,
          ...(this.options.clientSecret ? { client_secret: this.options.clientSecret } : {}),
        }),
        signal: controller.signal,
      });

      if (response.ok) {
        return { ...base, liveness: 'alive', reason: '有効です。', checkedAt };
      }

      /*
       * `invalid_grant` is Google saying the refresh token itself is finished.
       * Any other status is Google having a bad time, which says nothing about
       * the credential.
       */
      const detail = await response.text().catch(() => '');
      if (response.status === 400 && /invalid_grant/.test(detail)) {
        return {
          ...base,
          liveness: 'dead',
          reason: '更新トークンが失効しています。再認可が要ります。',
          checkedAt,
        };
      }
      return {
        ...base,
        liveness: 'unknown',
        reason: `Google が HTTP ${response.status} を返したため、確かめられませんでした。`,
        checkedAt: null,
      };
    } catch (err: any) {
      const why = err?.name === 'AbortError' ? '時間内に応答がありませんでした' : (err?.message ?? String(err));
      return { ...base, liveness: 'unknown', reason: `確かめられませんでした（${why}）。`, checkedAt: null };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Forces the next `check` to measure again. */
  invalidate(service?: string) {
    if (service) this.cache.delete(service);
    else this.cache.clear();
  }
}

/**
 * The one line worth putting in front of a person.
 *
 * Returns null when there is nothing to say — a briefing that reports healthy
 * credentials every time trains people to skip the field that will one day
 * report a broken one.
 */
export function grantWarning(all: GrantHealth[]): string | null {
  const dead = all.filter((g) => g.liveness === 'dead');
  if (dead.length === 0) return null;
  const names = dead.map((g) => g.service).join('・');
  return `${names} の認可が切れています。再認可するまで、その連携は動きません。`;
}
