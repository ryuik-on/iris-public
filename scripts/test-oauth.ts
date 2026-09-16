/**
 * OAuth credential storage tests.
 *
 * These tokens are bearer credentials for the user's mail, calendar and
 * files — the most sensitive thing this system holds by a wide margin. So the
 * tests are mostly about what must *not* happen: a token reaching a response
 * body, a replayed callback being honoured, an unsolicited one being answered
 * with a token exchange.
 *
 * Run: npm run test:oauth
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { openDatabase, getSchemaVersion } from '../server/services/db.js';
import { OAuthStore } from '../server/services/oauth_store.js';
import { IrisOAuthProvider, GOOGLE_MCP_SCOPES } from '../server/services/oauth_provider.js';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail?: string) {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
function eq(name: string, actual: any, expected: any) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, ok, ok ? undefined : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function section(t: string) { console.log(`\n▸ ${t}`); }

const SECRET = 'ya29.SUPER-SECRET-ACCESS-TOKEN';

function main() {
  const dir = mkdtempSync(join(tmpdir(), 'iris-oauth-'));
  const db = openDatabase(join(dir, 'o.db'));
  const store = new OAuthStore(db);

  try {
    check('the schema carries the credential tables', getSchemaVersion(db) >= 12);

    // ---------------------------------------------------------------------
    section('A status never contains the credential');

    {
      store.saveTokens('calendar', {
        access_token: SECRET,
        refresh_token: 'refresh-value',
        expires_in: 3600,
        scope: 'https://www.googleapis.com/auth/calendar.events.readonly',
      });

      const status = store.status('calendar');
      const serialised = JSON.stringify(status);
      // Not even a prefix. A "safe" fragment of a bearer token is still part
      // of a bearer token.
      check('the access token does not appear', !serialised.includes(SECRET));
      check('nor any leading fragment of it', !serialised.includes(SECRET.slice(0, 12)));
      check('nor the refresh token', !serialised.includes('refresh-value'));

      // What a person actually needs to know.
      check('but its existence is reported', status.hasToken);
      check('and whether it can refresh itself', status.hasRefreshToken);
      check('and when it expires', status.expiresAt !== null);
      check('and what it is allowed to do', /calendar\.events\.readonly/.test(status.scope ?? ''));
    }

    {
      const absent = store.status('never-authorized');
      check('an unauthorized server reports no token', !absent.hasToken);
      eq('with no expiry to report', absent.expiresAt, null);
      check('and is not called expired', !absent.expired);
    }

    {
      store.saveTokens('expired', { access_token: 'x', expires_in: -60 });
      check('an elapsed expiry is reported as expired', store.status('expired').expired);
    }

    // ---------------------------------------------------------------------
    section('A callback nobody asked for gets nothing');

    {
      const state = store.beginFlow('calendar', 'verifier-abc');
      check('a flow issues a state', state.length > 20);

      // Anything arriving without a matching row is unsolicited: either a bug
      // or an attack, and neither deserves a token exchange.
      eq('an unknown state claims nothing', store.claimFlow('not-a-real-state'), null);

      const claimed = store.claimFlow(state);
      eq('the issued state resolves to its flow', claimed?.serverId, 'calendar');
      eq('carrying the PKCE verifier', claimed?.codeVerifier, 'verifier-abc');

      // One use only. A replayed callback finds nothing.
      eq('the same state cannot be claimed twice', store.claimFlow(state), null);
    }

    {
      // The bug the CSRF check caught in practice: the verifier was being
      // attached by deleting the flow and starting a new one, which rotated
      // the state after the authorization URL had already been built with the
      // old value. Every callback then arrived with a state the store had just
      // discarded.
      const state = store.beginFlow('calendar', '');
      check('a verifier can be attached to an issued state', store.setFlowVerifier(state, 'pkce-xyz'));
      const claimed = store.claimFlow(state);
      eq('and the state is unchanged', claimed?.serverId, 'calendar');
      eq('while carrying the verifier', claimed?.codeVerifier, 'pkce-xyz');
      check('attaching to an unknown state changes nothing', !store.setFlowVerifier('nope', 'v'));
    }

    {
      const state = store.beginFlow('drive', 'v');
      // An hour-old authorization is not one the user is still waiting on.
      eq('an expired flow is refused', store.claimFlow(state, -1), null);
    }

    {
      const before = store.openFlowCount();
      store.beginFlow('a', 'v');
      store.beginFlow('b', 'v');
      check('open flows are counted', store.openFlowCount() >= before + 2);
      // Left alone they accumulate as a list of one-use secrets nobody will
      // ever use.
      const pruned = store.pruneFlows(-1);
      check('and abandoned ones are cleared', pruned >= 2);
      eq('leaving none behind', store.openFlowCount(), 0);
    }

    // ---------------------------------------------------------------------
    section('Revocation is complete');

    {
      store.saveTokens('gmail', { access_token: SECRET });
      check('a token is stored', store.status('gmail').hasToken);
      check('revoking reports success', store.revoke('gmail'));
      check('and it is gone', !store.status('gmail').hasToken);
      eq('the credential itself is unreadable afterwards', store.getTokens('gmail'), undefined);
      check('revoking again is not an error', !store.revoke('gmail'));
    }

    // ---------------------------------------------------------------------
    section('Only read-only scopes are asked for, with one named exception');

    {
      const all = Object.values(GOOGLE_MCP_SCOPES).flat();
      /*
       * 「すべて読み取り専用」ではなくなった。**例外は一つ、名指しで。**
       *
       * 2026-09-06、レールから予定を登録する機能のために `calendar.events` を
       * 足した。この見張りはそこで鳴った —— **鳴るべきときに鳴った。**
       *
       * 「すべて読み取り専用」に戻せないなら、見張りをやめるのではなく
       * **例外を数え上げる**形にする。名前を書いておけば、次に増えたときに
       * また鳴る。「書けるものがある」を一般の許可にした瞬間に、この見張りは
       * 何も見張らなくなる。
       */
      const ALLOWED_WRITES = ['https://www.googleapis.com/auth/calendar.events'];
      const writes = all.filter((s) => !s.endsWith('.readonly'));
      check(
        'the only non-readonly scope is the one we named',
        writes.every((s) => ALLOWED_WRITES.includes(s)),
        writes.join(' ')
      );
      check('and there is exactly one of them', writes.length === 1, writes.join(' '));
      // Composing is an outbound capability. IRIS's own rules already forbid
      // an inferred run from reaching one; asking for the scope anyway would
      // move that decision behind a consent screen clicked once.
      check('gmail.compose is not requested', !all.some((s) => s.includes('compose')));
      check('nor any send scope', !all.some((s) => s.includes('send')));
    }

    // ---------------------------------------------------------------------
    section('The provider never opens a browser');

    {
      const events: any[] = [];
      const provider = new IrisOAuthProvider({
        serverId: 'calendar',
        clientId: 'client-123',
        clientSecret: 'secret-456',
        redirectUri: 'http://localhost:3002/api/mcp/oauth/callback',
        scopes: GOOGLE_MCP_SCOPES.calendar,
        store,
        onEvent: (e) => events.push(e),
      });

      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth?client_id=x');
      // Mirrors the SDK's order: the URL is built from state(), and the
      // verifier arrives afterwards. The state must survive that.
      const issued = provider.state();
      provider.saveCodeVerifier('verifier-after-url');
      eq('the state does not change when the verifier arrives', provider.state(), issued);
      check('and the flow can still be claimed with it', store.claimFlow(issued)?.codeVerifier === 'verifier-after-url');

      {
        // Without access_type=offline Google returns no refresh token, and the
        // consent screen comes back every hour.
        const offline = new IrisOAuthProvider({
          serverId: 'calendar', clientId: 'c', redirectUri: 'http://localhost:3002/cb',
          scopes: ['s'], store,
          authorizationParams: { access_type: 'offline', prompt: 'consent' },
        });
        const target = new URL('https://accounts.google.com/o/oauth2/v2/auth?scope=s');
        offline.redirectToAuthorization(target);
        const issued = offline.takeAuthorizationUrl()!;
        eq('offline access is requested', issued.searchParams.get('access_type'), 'offline');
        eq('and a fresh grant is forced', issued.searchParams.get('prompt'), 'consent');
        eq('without disturbing the scope', issued.searchParams.get('scope'), 's');

        // A provider with no extras must not acquire any.
        const plain = new URL('https://example.com/auth?scope=s');
        provider.redirectToAuthorization(plain);
        const plainUrl = provider.takeAuthorizationUrl()!;
        check('no parameters are added when none are configured', !plainUrl.searchParams.has('access_type'));
      }

      provider.redirectToAuthorization(url);
      // A resident service that could put a consent screen in front of
      // someone unprompted is worse to own than one that cannot.
      check('the URL is recorded rather than opened', provider.takeAuthorizationUrl()?.href === url.href);
      eq('and is handed over only once', provider.takeAuthorizationUrl(), null);
      check('the requirement is logged without the query string',
        events.some((e) => e.type === 'oauth.authorization_required' && !JSON.stringify(e).includes('client_id')));
    }

    {
      const provider = new IrisOAuthProvider({
        serverId: 'drive',
        clientId: 'client-123',
        redirectUri: 'http://localhost:3002/cb',
        scopes: GOOGLE_MCP_SCOPES.drive,
        store,
      });
      // Without a secret the client is public, and the SDK must not be told
      // to authenticate with one it does not have.
      eq('a public client declares no auth method', provider.clientMetadata.token_endpoint_auth_method, 'none');
      check('and sends no secret', !('client_secret' in provider.clientInformation()));

      let threw = false;
      try { provider.codeVerifier(); } catch { threw = true; }
      check('asking for a verifier before a flow is an error', threw);
    }

    {
      const events: any[] = [];
      const provider = new IrisOAuthProvider({
        serverId: 'sheets', clientId: 'c', redirectUri: 'http://x/cb',
        scopes: GOOGLE_MCP_SCOPES.sheets, store, onEvent: (e) => events.push(e),
      });
      provider.saveTokens({ access_token: SECRET, refresh_token: 'r', scope: 'sheets.readonly' });
      const logged = JSON.stringify(events);
      // Not at debug level, not in an error path, not here.
      check('saving a token logs nothing of the token', !logged.includes(SECRET));
      check('nor of the refresh token', !logged.includes('"r"') || !logged.includes('refresh_token'));
      check('but records that one can refresh', /hasRefreshToken":true/.test(logged));

      provider.invalidateCredentials('tokens');
      check('invalidating removes it', !store.status('sheets').hasToken);
    }
  } finally {
    // ---------------------------------------------------------------------
    section('The verifier outlives a failed exchange');

    {
      // 2026-08-20: a real authorization came back as "PKCE verifier が
      // ありません", which described the retry rather than the failure. auth()
      // invalidates and retries once when an exchange fails, and its
      // invalidation cleared the verifier — so the second attempt could not
      // succeed and its error replaced the one worth reading.
      const provider = new IrisOAuthProvider({
        serverId: 'calendar',
        clientId: 'c',
        redirectUri: 'http://localhost:3002/cb',
        scopes: GOOGLE_MCP_SCOPES.calendar,
        store,
      });

      provider.saveCodeVerifier('verifier-for-this-flow');
      eq('the verifier is available for the exchange', provider.codeVerifier(), 'verifier-for-this-flow');

      // What the SDK does between the failed attempt and the retry.
      provider.invalidateCredentials('all');
      eq(
        'and survives the invalidation that precedes the retry',
        provider.codeVerifier(),
        'verifier-for-this-flow'
      );

      // A verifier belongs to a flow, so only starting another one ends it.
      provider.beginNewFlow();
      let threw = false;
      try { provider.codeVerifier(); } catch { threw = true; }
      check('but a new flow does not inherit it', threw);
    }

    {
      // The durable half. It was written from the moment the URL was built and
      // nothing read it back, so a restart between consent and callback lost
      // an exchange the database could have completed.
      const provider = new IrisOAuthProvider({
        serverId: 'calendar', clientId: 'c', redirectUri: 'http://localhost:3002/cb',
        scopes: GOOGLE_MCP_SCOPES.calendar, store,
      });
      const issued = provider.state();
      provider.saveCodeVerifier('persisted-verifier');

      const claimed = store.claimFlow(issued);
      eq('the flow carries the verifier out of the store', claimed?.codeVerifier, 'persisted-verifier');

      // What the callback now does: a fresh process, restoring from the flow.
      const afterRestart = new IrisOAuthProvider({
        serverId: 'calendar', clientId: 'c', redirectUri: 'http://localhost:3002/cb',
        scopes: GOOGLE_MCP_SCOPES.calendar, store,
      });
      let threwBefore = false;
      try { afterRestart.codeVerifier(); } catch { threwBefore = true; }
      check('a restarted process has nothing in memory', threwBefore);

      afterRestart.saveCodeVerifier(claimed!.codeVerifier);
      eq('and recovers it from the claimed flow', afterRestart.codeVerifier(), 'persisted-verifier');
    }

    db.close();
    rmSync(dir, { recursive: true, force: true });
  }

  // -----------------------------------------------------------------------
  section('What IRIS is willing to ask a person for');

  {
    // The whole scope list, checked as a rule rather than per entry: nothing
    // that can change anything. Google's MCP servers advertise read-write
    // scopes and the SDK will use the advertised set unless told otherwise,
    // so this is the assertion that catches a silent widening.
    const every = Object.values(GOOGLE_MCP_SCOPES).flat();
    /*
     * 書けるスコープは `calendar.events` の一つだけ。**それ以外は読み取り専用。**
     *
     * 予定を一件作るのに、共有相手を変える権限（`.acls`）も、カレンダーごと
     * 消せる全権（`/auth/calendar`）も要らない。下の二つの見張りは、その二つを
     * **足したくなったときに鳴る**ために置いてある。
     */
    const writable = every.filter((s) => !s.endsWith('.readonly'));
    check('only one scope can write', writable.length === 1, writable.join(' '));
    check(
      'and it is event creation, nothing wider',
      writable[0] === 'https://www.googleapis.com/auth/calendar.events',
      writable.join(' ')
    );
    check('none grants sharing control', !every.some((s) => s.includes('.acls')));
    check(
      'none is the unqualified full-access scope',
      !every.some((s) => /\/auth\/(calendar|drive|gmail|spreadsheets)$/.test(s))
    );
    // Composing is outbound, and outbound belongs behind the approval
    // boundary rather than behind a consent screen clicked once.
    check('gmail.compose is absent', !every.some((s) => s.includes('gmail.compose')));

    // Narrow rather than the `calendar.readonly` umbrella: the server lists
    // both of these in scopes_supported, and widening to the umbrella did not
    // fix the failure it was widened for.
    check(
      'calendar does not fall back to the umbrella scope',
      !GOOGLE_MCP_SCOPES.calendar.includes('https://www.googleapis.com/auth/calendar.readonly')
    );
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`OAuth: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('All OAuth tests passed.');
}

main();
