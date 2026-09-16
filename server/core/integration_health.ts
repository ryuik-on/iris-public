/**
 * Whether the things IRIS depends on can actually answer.
 *
 * `/api/health` reported `healthy` for the entire 31 hours that every Google
 * path was dead. It was not lying by its own definition — it checked that the
 * orchestrator existed and that the database schema matched, and both were
 * true. Nothing it looked at had anything to do with whether IRIS could do
 * what it was for.
 *
 * The failure it missed is a specific shape, and naming it is most of the
 * design. Google was not erroring. It had been configured, then lost its
 * token, and after that `configured()` returned false — so it was never
 * called, never appeared in the calendar's contributions, and never set a
 * `lastError`. Every mechanism that existed to notice a degraded source keyed
 * on a source that *tried and failed*. This one had quietly stopped trying,
 * and there is no error anywhere in a system that never made a request.
 *
 * So the states here are four, not two, and the distinctions are the point:
 *
 *   not_configured — no credential was ever supplied. A choice, not a fault.
 *                    iCloud on a machine that never had iCloud is fine.
 *   ready          — positive evidence it answered. Not "nothing went wrong":
 *                    something has to have worked.
 *   failing        — configured, and demonstrably cannot answer. This is the
 *                    one that was invisible, and the only one that degrades.
 *   unknown        — configured, and there is no cheap way to tell. Reported
 *                    by name rather than optimistically called ready, for the
 *                    same reason the Context Engine names its unknown fields.
 *
 * Only `failing` degrades. A health check that goes red because something was
 * never set up teaches its reader to ignore it, and an ignored health check is
 * worth less than none — it occupies the place where a real one would go.
 */

export type IntegrationState = 'not_configured' | 'ready' | 'failing' | 'unknown';

export interface IntegrationProbe {
  id: string;
  label: string;
  /** Credentials or settings are present, so this is meant to work. */
  configured: boolean;
  /**
   * Positive evidence that it answered. Null when there is none to be had
   * cheaply — which is not the same as evidence that it did not.
   */
  answered?: boolean | null;
  /** Why it cannot answer. Required to report `failing` at all. */
  reason?: string | null;
  /** What a reader should do about it. */
  guidance?: string | null;
}

export interface IntegrationReport {
  id: string;
  label: string;
  state: IntegrationState;
  reason: string | null;
  guidance: string | null;
}

export interface HealthSummary {
  integrations: IntegrationReport[];
  /** Configured things that cannot answer. Empty is the only good answer. */
  failing: IntegrationReport[];
  /** Configured things whose liveness could not be established. */
  unknown: IntegrationReport[];
  degraded: boolean;
}

/**
 * Classifies one dependency.
 *
 * A probe that claims `failing` without a reason is downgraded to `unknown`.
 * "Something is wrong and I cannot say what" is a different report from "this
 * is broken, here is why", and only the second is worth waking someone for.
 */
export function classify(probe: IntegrationProbe): IntegrationReport {
  const base = { id: probe.id, label: probe.label, guidance: probe.guidance ?? null };

  if (!probe.configured) {
    return { ...base, state: 'not_configured', reason: probe.reason ?? null, guidance: null };
  }
  if (probe.answered === true) {
    return { ...base, state: 'ready', reason: null };
  }
  if (probe.answered === false) {
    const reason = probe.reason?.trim();
    if (!reason) {
      return {
        ...base,
        state: 'unknown',
        reason: '応答できない理由が報告されていません。',
      };
    }
    return { ...base, state: 'failing', reason };
  }
  return { ...base, state: 'unknown', reason: probe.reason ?? '稼働しているか安価に確認できません。' };
}

export function summarize(probes: IntegrationProbe[]): HealthSummary {
  const integrations = probes.map(classify);
  const failing = integrations.filter((i) => i.state === 'failing');
  return {
    integrations,
    failing,
    unknown: integrations.filter((i) => i.state === 'unknown'),
    degraded: failing.length > 0,
  };
}

/**
 * Whether an OAuth credential can still be used.
 *
 * An expired access token is not a fault when a refresh token is held — that
 * is the ordinary state for most of every hour, and treating it as a failure
 * would put the health check into a red/green flicker that nobody reads. What
 * is a fault is holding no token at all, or holding one that has expired with
 * nothing to renew it.
 */
export function credentialUsable(status: {
  hasToken: boolean;
  hasRefreshToken: boolean;
  expired: boolean;
}): { usable: boolean; reason: string | null } {
  if (!status.hasToken) {
    return { usable: false, reason: 'トークンがありません。認可が必要です。' };
  }
  if (status.expired && !status.hasRefreshToken) {
    return {
      usable: false,
      reason: 'アクセストークンが期限切れで、更新するリフレッシュトークンがありません。',
    };
  }
  return { usable: true, reason: null };
}

/**
 * Sources that were expected in a reading and did not appear in it.
 *
 * The exact detection that was missing. A source which errors leaves an error;
 * a source which stopped being configured leaves nothing at all, and an
 * absence has to be looked for deliberately because nothing reports it.
 */
export function missingFrom(expected: string[], contributed: string[]): string[] {
  const present = new Set(contributed);
  return expected.filter((id) => !present.has(id));
}
