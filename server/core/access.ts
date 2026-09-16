/**
 * Who may talk to IRIS over the network.
 *
 * The server has always listened on every interface — that is what makes a
 * phone on the same Wi-Fi able to reach it, and it is also what put the whole
 * assistant in front of everyone else on that network: the calendar, the
 * memories, every conversation, and an approval dialog they could press
 * themselves. On a home network that is a shrug. On a café or campus network
 * it is the whole machine.
 *
 * The rule is one sentence: a request from the machine itself is trusted, and
 * a request from anywhere else has to carry the token.
 *
 * Loopback is trusted because reaching it already requires being on the
 * computer, which is a stronger check than any password this could ask for.
 * That also means nothing about using IRIS on the Mac changes — the browser
 * there, the speech helper, the scripts, all of them keep working exactly as
 * they did, which is the only reason this can be turned on without a
 * migration.
 *
 * With no token configured, remote requests are refused rather than allowed.
 * A protection that disables itself when its configuration is missing is worse
 * than none, because it looks like protection. The refusal says what to do.
 */

export type AccessVerdict =
  | { allow: true; reason: null }
  | { allow: false; reason: string; code: 'unconfigured' | 'missing' | 'wrong' };

/**
 * Whether an address is this machine.
 *
 * Node reports IPv4 loopback as `::ffff:127.0.0.1` when the socket is IPv6,
 * which is the form that actually arrives in practice and the one an obvious
 * `=== '127.0.0.1'` check misses. Anything unparseable is not loopback: an
 * address that cannot be read is not evidence of being local.
 */
export function isLoopback(address: string | undefined | null): boolean {
  if (!address) return false;
  const plain = address.startsWith('::ffff:') ? address.slice(7) : address;
  if (plain === '::1' || plain === 'localhost') return true;
  // The whole 127.0.0.0/8 block, not just .0.0.1.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(plain);
}

/**
 * Constant-time comparison, so a wrong token cannot be improved by timing.
 *
 * Length is compared first and leaks, which is unavoidable and uninteresting:
 * the token's length is fixed and public. What must not leak is how much of a
 * guess was right.
 */
function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function decideAccess(input: {
  remoteAddress: string | undefined | null;
  presented: string | null;
  expected: string | null;
}): AccessVerdict {
  if (isLoopback(input.remoteAddress)) return { allow: true, reason: null };

  if (!input.expected) {
    return {
      allow: false,
      code: 'unconfigured',
      reason:
        'このマシンの外からの接続は拒否されています。アクセストークンが設定されていません。',
    };
  }
  if (!input.presented) {
    return {
      allow: false,
      code: 'missing',
      reason: 'アクセストークンが必要です。',
    };
  }
  if (!sameSecret(input.presented, input.expected)) {
    return { allow: false, code: 'wrong', reason: 'アクセストークンが一致しません。' };
  }
  return { allow: true, reason: null };
}

/** The name of the cookie the server sets once a device has identified itself. */
export const COOKIE_NAME = 'iris_access';

/**
 * The token a request is presenting: a header, or the cookie the server set.
 *
 * Deliberately not from the query string. A credential in a URL is a
 * credential in the browser history, in every server log that records paths,
 * and in whatever the address bar is shared into.
 *
 * The cookie is here because `localStorage` on a phone is not the durable
 * thing it looks like. Safari evicts script-written storage on its own
 * schedule, a web app added to the Home Screen keeps a container separate
 * from the browser that created it, and the two IP addresses this server has
 * answered on — the LAN one and the Tailscale one — are separate origins with
 * separate storage besides. Any of those produces the same symptom: the token
 * is asked for again, and the person who typed it has no way to tell which of
 * the four happened.
 *
 * A cookie the *server* sets is carried by the browser without any script
 * having to remember it, and it is not readable by script at all. It does not
 * replace the header — the first request from a new device still has to
 * present one — it removes the need to present one twice.
 */
export function presentedToken(headers: Record<string, any>): string | null {
  const auth = headers['authorization'] ?? headers['Authorization'];
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    const value = auth.slice(7).trim();
    if (value.length > 0) return value;
  }
  const direct = headers['x-iris-token'];
  if (typeof direct === 'string' && direct.trim().length > 0) return direct.trim();

  const cookie = headers['cookie'] ?? headers['Cookie'];
  if (typeof cookie === 'string') {
    for (const part of cookie.split(';')) {
      const [name, ...rest] = part.trim().split('=');
      if (name === COOKIE_NAME) {
        const value = decodeURIComponent(rest.join('=')).trim();
        if (value.length > 0) return value;
      }
    }
  }
  return null;
}
