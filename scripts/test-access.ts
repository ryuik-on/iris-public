/**
 * Who may talk to IRIS over the network.
 *
 * The assertions that matter are the refusals. A gate that opens when it is
 * confused is not a gate, and the two ways this one could be confused are an
 * address it cannot parse and a token nobody configured — both of which have
 * an obvious wrong answer that looks like working software.
 *
 * Run: npx tsx scripts/test-access.ts
 */
import { isLoopback, decideAccess, presentedToken } from '../server/core/access.js';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function section(name: string) {
  console.log(`\n▸ ${name}`);
}

function eq(name: string, actual: any, expected: any) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    failures.push(`${name}: ${JSON.stringify(actual)} ≠ ${JSON.stringify(expected)}`);
    console.log(`  ✗ ${name}: ${JSON.stringify(actual)} ≠ ${JSON.stringify(expected)}`);
  }
}

function main() {
  section('What counts as this machine');

  {
    eq('IPv4 loopback', isLoopback('127.0.0.1'), true);
    eq('IPv6 loopback', isLoopback('::1'), true);

    // The form that actually arrives: an IPv6 socket reports IPv4 peers this
    // way, and a check written as === '127.0.0.1' misses every real request.
    eq('IPv4 mapped into IPv6', isLoopback('::ffff:127.0.0.1'), true);

    // The whole /8, not just the one address people type.
    eq('elsewhere in 127/8', isLoopback('127.0.1.5'), true);

    eq('a LAN address is not local', isLoopback('192.168.0.4'), false);
    eq('a hotspot address is not local', isLoopback('172.20.10.2'), false);

    // 127 has to be the first octet, not any octet.
    eq('not local merely for containing 127', isLoopback('10.0.0.127'), false);
    eq('nor a hostname that starts with it', isLoopback('127.example.com'), false);

    // An address that cannot be read is not evidence of being local.
    eq('undefined is not local', isLoopback(undefined), false);
    eq('empty is not local', isLoopback(''), false);
  }

  section('This machine needs no token');

  {
    eq(
      'loopback is allowed with nothing configured at all',
      decideAccess({ remoteAddress: '::1', presented: null, expected: null }).allow,
      true
    );
    eq(
      'and is not asked even when a token exists',
      decideAccess({ remoteAddress: '127.0.0.1', presented: null, expected: 'secret' }).allow,
      true
    );
  }

  section('Everywhere else has to carry it');

  {
    const remote = '192.168.0.9';
    eq(
      'the right token is let in',
      decideAccess({ remoteAddress: remote, presented: 'secret', expected: 'secret' }).allow,
      true
    );

    const missing = decideAccess({ remoteAddress: remote, presented: null, expected: 'secret' });
    eq('no token is refused', missing.allow, false);
    eq('and says which kind of refusal', (missing as any).code, 'missing');

    const wrong = decideAccess({ remoteAddress: remote, presented: 'guess', expected: 'secret' });
    eq('a wrong token is refused', wrong.allow, false);
    eq('and says so distinctly', (wrong as any).code, 'wrong');

    // Same length, one character different — the case a naive comparison that
    // returns early would leak the position of.
    eq(
      'a near miss is still a miss',
      decideAccess({ remoteAddress: remote, presented: 'secreu', expected: 'secret' }).allow,
      false
    );

    // A prefix must not pass.
    eq(
      'a prefix of the token is not the token',
      decideAccess({ remoteAddress: remote, presented: 'sec', expected: 'secret' }).allow,
      false
    );
  }

  section('An unconfigured gate closes');

  {
    /**
     * The important one. With no token set, the tempting behaviour is to let
     * everything through so nothing appears broken — and that is a protection
     * that turns itself off exactly when it was never turned on. It refuses,
     * and says that is why.
     */
    const verdict = decideAccess({ remoteAddress: '192.168.0.9', presented: null, expected: null });
    eq('refused', verdict.allow, false);
    eq('for being unconfigured', (verdict as any).code, 'unconfigured');

    eq(
      'and presenting something does not help',
      decideAccess({ remoteAddress: '192.168.0.9', presented: 'anything', expected: null }).allow,
      false
    );

    // An empty string is not a token either — a blank env var must not open it.
    eq(
      'an empty configured token is no token',
      decideAccess({ remoteAddress: '192.168.0.9', presented: '', expected: '' }).allow,
      false
    );
  }

  section('Where the token is read from');

  {
    eq('a bearer header', presentedToken({ authorization: 'Bearer abc' }), 'abc');
    eq('capitalised the other way', presentedToken({ Authorization: 'Bearer abc' }), 'abc');
    eq('a direct header', presentedToken({ 'x-iris-token': 'abc' }), 'abc');
    eq('nothing at all', presentedToken({}), null);
    eq('an empty bearer is nothing', presentedToken({ authorization: 'Bearer ' }), null);
    eq('another scheme is nothing', presentedToken({ authorization: 'Basic abc' }), null);
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Network access: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('All network access tests passed.');
}

main();
