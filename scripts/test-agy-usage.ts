/**
 * Antigravity の残量を、使用量に直して読む。
 *
 * 契約側は **残っている割合** で答える。この機械の目盛りはどれも **使った
 * 割合** で揃えてある。向きが違うものが一つ混じると、手つかずの契約が満杯に
 * 見える — 8月に Codex の窓を取り違えて起きた事故の、向きだけ逆の形。
 * だからここで確かめるのは、ほとんどが「1 は 0%」であることそのもの。
 *
 * Run: npx tsx scripts/test-agy-usage.ts
 */
import { parseQuotaSummary, findEndpoint, AgyUsageService } from '../server/services/agy_usage.js';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function section(name: string) { console.log(`\n▸ ${name}`); }
function eq(name: string, actual: any, expected: any) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(`${name}: ${JSON.stringify(actual)} ≠ ${JSON.stringify(expected)}`); console.log(`  ✗ ${name}`); }
}

/** 2026-08-31 に実機から返ってきたもの。 */
const REAL = {
  response: {
    groups: [
      {
        displayName: 'Gemini Models',
        description: 'Models within this group: Gemini Flash, Gemini Pro',
        buckets: [
          { bucketId: 'gemini-weekly', displayName: 'Weekly Limit Remaining', window: 'weekly', remainingFraction: 1, resetTime: '2026-09-07T12:57:44Z' },
          { bucketId: 'gemini-5h', displayName: 'Five Hour Limit Remaining', window: '5h', remainingFraction: 1, resetTime: '2026-08-31T17:57:44Z' },
        ],
      },
      {
        displayName: 'Claude and GPT models',
        buckets: [
          { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 1, resetTime: '2026-09-07T12:57:44Z' },
          { bucketId: '3p-5h', window: '5h', remainingFraction: 1, resetTime: '2026-08-31T17:57:44Z' },
        ],
      },
    ],
  },
};

async function main() {
  section('残量を使用量に直す');
  const real = parseQuotaSummary(REAL)!;
  eq('手つかず（残り 1）は 0% 使用', real.gemini.week!.usedPercent, 0);
  eq('5時間の窓も同じ', real.gemini.session!.usedPercent, 0);
  eq('リセット時刻が付く', real.gemini.week!.resetsAtMs, Date.parse('2026-09-07T12:57:44Z'));
  eq('Claude/GPT の群も別に読む', real.thirdParty.week!.usedPercent, 0);

  section('向きを取り違えない');
  const half = JSON.parse(JSON.stringify(REAL));
  half.response.groups[0].buckets[0].remainingFraction = 0.25;
  eq('残り 25% は 75% 使用', parseQuotaSummary(half)!.gemini.week!.usedPercent, 75);
  half.response.groups[0].buckets[0].remainingFraction = 0;
  eq('残り 0 は 100% 使用', parseQuotaSummary(half)!.gemini.week!.usedPercent, 100);

  section('窓は名前で選ぶ。順番でも id でもなく');
  const swapped = JSON.parse(JSON.stringify(REAL));
  swapped.response.groups[0].buckets.reverse();
  swapped.response.groups[0].buckets[1].remainingFraction = 0.4;
  const s = parseQuotaSummary(swapped)!;
  eq('並びが逆でも週は週', s.gemini.week!.usedPercent, 60);
  eq('5時間はそのまま', s.gemini.session!.usedPercent, 0);

  section('読めなかったものは 0% にしない');
  eq('群ごと無いなら null', parseQuotaSummary({ response: { groups: [] } }), null);
  eq('形が違えば null', parseQuotaSummary({ error: 'unauthenticated' }), null);
  const missing = JSON.parse(JSON.stringify(REAL));
  missing.response.groups[0].buckets[0].remainingFraction = null;
  eq('数字が無い窓は null', parseQuotaSummary(missing)!.gemini.week, null);
  eq('もう片方は残る', parseQuotaSummary(missing)!.gemini.session!.usedPercent, 0);

  section('居場所を探す');
  const ps = () =>
    ' 1234 /Applications/Antigravity.app/…/language_server --csrf_token cd125d61-c81a-4e74-b60d-d004ad0c373a --other\n' +
    ' 9999 /usr/bin/grep language_server\n';
  const ports = (pid: number) =>
    `COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\nlanguage ${pid} k 12u IPv4 0x1 0t0 TCP 127.0.0.1:51190 (LISTEN)\n`;
  // `ps` と `lsof` は待たずに走らせる（同期の子プロセスはサーバの輪を止める）。
  eq('港と合鍵', await findEndpoint(ps, ports), { port: 51190, token: 'cd125d61-c81a-4e74-b60d-d004ad0c373a' });
  eq('動いていなければ null', await findEndpoint(() => 'nothing here\n', ports), null);
  eq('合鍵が無ければ null', await findEndpoint(() => ' 1 language_server --no-token\n', ports), null);
  eq('聴いていなければ null', await findEndpoint(ps, () => 'COMMAND\n'), null);
  // 返すのが約束でも同じに動く。
  eq('約束を返す読み手でも同じ', await findEndpoint(async () => ps(), async (pid) => ports(pid)), { port: 51190, token: 'cd125d61-c81a-4e74-b60d-d004ad0c373a' });

  section('閉じているあいだは、最後の値を歳とともに');
  {
    const quota = parseQuotaSummary(REAL)!;
    let open = true;
    const service = new AgyUsageService(
      () => (open ? { port: 1, token: 't' } : null),
      async () => quota
    );
    const t0 = 1_800_000_000_000;
    await (service as any).sweep(t0);
    eq('開いていれば、そのまま', service.read(t0).stale, undefined);

    open = false;
    await (service as any).sweep(t0 + 60 * 60_000);
    const held = service.read(t0 + 60 * 60_000);
    eq('閉じても値は残る', held.quota?.gemini.week?.usedPercent, 0);
    eq('古いと言う', held.stale, true);
    eq('何分前かも言う', held.ageMinutes, 60);
    eq('理由も添える', typeof held.reason, 'string');

    await (service as any).sweep(t0 + 7 * 60 * 60_000);
    const gone = service.read(t0 + 7 * 60 * 60_000);
    eq('六時間を過ぎたら捨てる', gone.quota, null);
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`Antigravity usage: ${passed} passed, ${failed} failed`);
  if (failed) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('All Antigravity usage tests passed.');
}

main();
