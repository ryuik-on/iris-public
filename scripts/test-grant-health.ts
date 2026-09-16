/**
 * 認可の生死を測る側のテスト。
 *
 * 中心は一つ: **測れなかったことを「切れている」と言わない。** Google が落ちて
 * いるのと Google が断ったのは、呼び出しが失敗したかどうかだけ見ると同じ形を
 * している。前者を後者として報告すると、要らない再認可に人を送り、そのうち
 * 警告そのものが信用されなくなる。
 */

import { GrantHealthService, grantWarning } from '../server/services/grant_health.js';

let failed = 0;
function check(name: string, ok: boolean, detail?: any) {
  if (ok) console.log('  ✓ ' + name);
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); }
}

const NOW = Date.parse('2026-09-02T12:00:00Z');

function store(over: any = {}) {
  const status = {
    serverId: 'gmail', hasToken: true, hasRefreshToken: true,
    expiresAt: '2026-09-02T13:00:00Z', expired: false,
    scope: 'https://www.googleapis.com/auth/gmail.readonly',
    updatedAt: '2026-08-19T19:26:48.064Z',
    ...over,
  };
  return {
    status: () => status,
    allStatuses: () => [status],
    getTokens: () => (over.noTokens ? undefined : { access_token: 'a', refresh_token: 'r' }),
  } as any;
}

function service(fetchImpl: any, storeOver: any = {}) {
  return new GrantHealthService({
    store: store(storeOver), clientId: 'cid', clientSecret: 'cs',
    fetchImpl, now: () => NOW,
  });
}

const ok = async () => new Response('{"access_token":"x"}', { status: 200 });
const revoked = async () =>
  new Response('{"error":"invalid_grant","error_description":"Token has been expired or revoked."}', { status: 400 });
const serverError = async () => new Response('upstream is unwell', { status: 503 });
const offline = async () => { throw new Error('getaddrinfo ENOTFOUND oauth2.googleapis.com'); };
const otherBadRequest = async () =>
  new Response('{"error":"invalid_client"}', { status: 400 });

async function main() {
  console.log('\n認可の生死\n');

  const alive = await service(ok).check('gmail');
  check('更新できたら alive', alive.liveness === 'alive', alive);
  check('測った時刻が入る', Boolean(alive.checkedAt), alive);

  const dead = await service(revoked).check('gmail');
  check('invalid_grant は dead', dead.liveness === 'dead', dead);
  check('人の言葉で理由が出る', dead.reason.includes('再認可'), dead.reason);

  // ここが本題。
  const down = await service(serverError).check('gmail');
  check('Google が 503 なら unknown（dead ではない）', down.liveness === 'unknown', down);
  check('測れていないので checkedAt は null', down.checkedAt === null, down);

  const net = await service(offline).check('gmail');
  check('ネットワーク断も unknown', net.liveness === 'unknown', net);

  // 400 なら何でも失効、にしない。
  const misconfigured = await service(otherBadRequest).check('gmail');
  check('400 でも invalid_grant でなければ unknown', misconfigured.liveness === 'unknown', misconfigured);

  // unknown を握り込むと、復旧しても切れたままに見える。
  let calls = 0;
  const flaky = async () => { calls++; return calls === 1 ? new Response('x', { status: 503 }) : new Response('{"access_token":"x"}', { status: 200 }); };
  const svc = service(flaky);
  const first = await svc.check('gmail');
  const second = await svc.check('gmail');
  check('unknown はキャッシュしない', first.liveness === 'unknown' && second.liveness === 'alive', { first: first.liveness, second: second.liveness });

  // alive は保持する。毎回 Google を叩く必要はない。
  let hits = 0;
  const counted = async () => { hits++; return new Response('{"access_token":"x"}', { status: 200 }); };
  const svc2 = service(counted);
  await svc2.check('gmail'); await svc2.check('gmail');
  check('alive は保持され、二度目は叩かない', hits === 1, { hits });

  // 記録から分かることは記録で答える。
  const noRefresh = await service(ok, { hasRefreshToken: false, expired: true }).check('gmail');
  check('更新トークンが無く期限切れなら dead', noRefresh.liveness === 'dead', noRefresh);
  const noToken = await service(ok, { hasToken: false, hasRefreshToken: false }).check('gmail');
  check('そもそも認可が無ければ dead', noToken.liveness === 'dead', noToken);

  // 出す一行。
  check('全部生きていれば何も言わない', grantWarning([alive]) === null);
  check('切れていれば名前を挙げる', (grantWarning([dead]) ?? '').includes('gmail'), grantWarning([dead]));
  check('unknown は警告にしない', grantWarning([down]) === null, grantWarning([down]));

  console.log(failed === 0 ? '\nすべて通りました\n' : `\n${failed}件 失敗\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
