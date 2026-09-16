/**
 * Speech bridge tests.
 *
 * The microphone path is verified by running the real helper (see the
 * `--live` section at the end). What is tested here is everything that only
 * happens when something goes wrong — a helper that dies, one that refuses to
 * exit, a line split across a pipe boundary, a buffer that would otherwise
 * grow for eight hours. Those are unreachable from a working microphone, and
 * they are where an always-on listener actually fails.
 *
 * Two invariants matter more than the rest:
 *   - volatile text is never stored
 *   - a configuration fault does not become a restart loop
 *
 * Run: npm run test:speech
 */
import { join } from 'path';
import { SpeechBridge, SpeechHelperMissingError, protectedLocationWarning } from '../server/services/speech_bridge.js';

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

const ROOT = join(import.meta.dirname, '..');
const FIXTURE = join(ROOT, 'scripts/fixtures/fake-speech-helper.mjs');

function bridge(mode: string, extra: Record<string, any> = {}) {
  const events: Array<{ type: string; detail?: any }> = [];
  const b = new SpeechBridge({
    binaryPath: process.execPath,
    onEvent: (e) => events.push(e),
    spawnFn: ((_bin: string, args: string[], opts: any) => {
      const { spawn } = require('child_process');
      return spawn(process.execPath, [FIXTURE, ...args], {
        ...opts,
        env: { ...process.env, SPEECH_FIXTURE: mode },
      });
    }) as any,
    ...extra,
  });
  return { b, events };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await wait(10);
  }
  return false;
}

async function main() {
  // -----------------------------------------------------------------------
  section('Only finished sentences are kept');

  {
    const { b } = bridge('normal');
    b.start(ROOT);
    await until(() => b.status().pending >= 1);

    eq('a finalized utterance is stored', b.peek().map((t) => t.text), ['こんにちは。']);
    eq('its timing is kept', b.peek()[0].start, 0.7);
    eq('the state reflects that it is listening', b.state, 'listening');

    // "こん" was never a word the user finished saying. Storing it would put
    // text in their mouth that the transcriber itself later corrected.
    eq('the sentence being formed is visible but not stored', b.status().partial, 'いま');
    eq('and only one thing is pending', b.status().pending, 1);

    await b.stop();
    eq('stopping settles to idle', b.state, 'idle');
  }

  // -----------------------------------------------------------------------
  section('Stopping keeps the end of the last sentence');

  {
    const { b } = bridge('normal');
    b.start(ROOT);
    await until(() => b.state === 'listening');
    await b.stop();

    // The helper finalizes through end of input before exiting, so a stop
    // mid-utterance does not truncate what the user was saying.
    check('text finalized during shutdown survives', b.peek().some((t) => t.text === '最後の一文'));
  }

  // -----------------------------------------------------------------------
  section('Reading is destructive, so nothing is acted on twice');

  {
    const { b } = bridge('normal');
    b.start(ROOT);
    await until(() => b.status().pending >= 1);

    const first = b.drain();
    eq('drain hands over what was heard', first.transcripts.length, 1);
    eq('and leaves nothing behind', b.drain().transcripts.length, 0);
    eq('the pending count agrees', b.status().pending, 0);
    await b.stop();
  }

  // -----------------------------------------------------------------------
  section('A pipe does not respect line boundaries');

  {
    const { b } = bridge('split');
    b.start(ROOT);
    const arrived = await until(() => b.status().pending >= 1);
    check('a JSON object split across three writes is reassembled', arrived);
    eq('and parsed intact', b.peek()[0]?.text, '分割された行');
    await b.stop();
  }

  // -----------------------------------------------------------------------
  section('A bad line is not a reason to stop listening');

  {
    const { b, events } = bridge('garbage');
    b.start(ROOT);
    await until(() => b.status().pending >= 1);

    check('the malformed line is reported', events.some((e) => e.type === 'speech.unparseable'));
    eq('and the line after it still arrives', b.peek()[0]?.text, '壊れた行のあとも続く');
    eq('the bridge is still listening', b.state, 'listening');
    await b.stop();
  }

  // -----------------------------------------------------------------------
  section('A crash is retried; a misconfiguration is not');

  {
    const { b, events } = bridge('crash');
    b.start(ROOT);
    const restarted = await until(() => events.some((e) => e.type === 'speech.restarting'));
    check('an unexpected exit schedules a restart', restarted);
    check('with a delay rather than immediately', (events.find((e) => e.type === 'speech.restarting')?.detail?.delayMs ?? 0) > 0);
    await b.stop();
  }

  {
    // Asking for the microphone a second time does not make the user grant
    // it. Retrying turns a quiet, fixable problem into a loud loop.
    const { b, events } = bridge('denied');
    b.start(ROOT);
    const gaveUp = await until(() => b.state === 'unavailable');
    check('a denied microphone stops the bridge', gaveUp);
    check('no restart is attempted', !events.some((e) => e.type === 'speech.restarting'));
    eq('and the reason is kept', b.status().lastError?.code, 'microphone_denied');
    check('with the fix attached', Boolean(b.status().lastError?.hint));
    await b.stop();
  }

  // -----------------------------------------------------------------------
  section('A helper that will not exit is killed');

  {
    const { b, events } = bridge('ignores_stdin');
    b.start(ROOT);
    await until(() => b.state === 'listening');

    // A microphone left open by a process nobody is reading is the worst
    // outcome available, so the grace period ends in SIGKILL.
    const stopped = b.stop();
    const killed = await until(() => events.some((e) => e.type === 'speech.force_killed'), 8000);
    await stopped;
    check('closing stdin is escalated to a kill', killed);
    eq('and the bridge still settles', b.state, 'idle');
  }

  // -----------------------------------------------------------------------
  section('An always-on microphone must not grow without bound');

  {
    const { b } = bridge('flood', { bufferLimit: 10 });
    b.start(ROOT);
    await until(() => b.status().pending >= 10);
    await wait(50);

    eq('the buffer is capped', b.status().pending, 10);
    check('the newest are the ones kept', b.peek(10).at(-1)!.text === '発話49');
    check('and the loss is counted rather than silent', b.status().dropped > 0);

    const drained = b.drain();
    check('drain reports what was lost', drained.dropped > 0);
    eq('and the count resets with it', b.status().dropped, 0);
    await b.stop();
  }

  // -----------------------------------------------------------------------
  section('One-shot commands');

  {
    const { b } = bridge('probe');
    const probe = await b.probe(ROOT);
    eq('probe reports availability', probe.transcriberAvailable, true);
    eq('and the locale it actually resolved to', probe.resolvedLocale, 'ja-JP');
    check('and what is installed', probe.installedLocales.includes('ja-JP'));
  }

  {
    const { b } = bridge('install_fails');
    let message = '';
    try { await b.install(ROOT); } catch (err: any) { message = err.message; }
    check('a failed install surfaces its reason', message.includes('ネットワーク'));
  }

  // -----------------------------------------------------------------------
  section('A missing helper says how to build it');

  {
    const b = new SpeechBridge();
    let err: any;
    try { b.resolveBinary('/nonexistent-root'); } catch (e) { err = e; }
    check('the error names the fix', err instanceof SpeechHelperMissingError && /build:speech/.test(err.message));
    check('and where it looked', /\.build/.test(err.message));
  }

  // -----------------------------------------------------------------------
  section('A guarded folder is a hang, not a permission error');

  {
    // Found the hard way: under launchd the helper never reached main. dyld
    // blocked in getCWD() -> open() resolving a working directory inside
    // ~/Downloads. No error, no crash, no log — just a process that never
    // returned. From a foreground shell it looks completely fine, which is
    // why this has to be checked rather than waited for.
    const home = '/Users/someone';
    for (const dir of ['Downloads', 'Documents', 'Desktop']) {
      const warning = protectedLocationWarning(`${home}/${dir}/iris/IrisSpeech.app/Contents/MacOS/IrisSpeech`, home);
      check(`~/${dir} is flagged`, warning !== null);
      check(`and the warning explains the hang rather than blaming permissions`, /ハング|停止/.test(warning ?? ''));
    }

    eq(
      'a location outside them is not flagged',
      protectedLocationWarning(`${home}/Library/Application Support/IRIS/IrisSpeech.app/Contents/MacOS/IrisSpeech`, home),
      null
    );
    // Prefix matching must not fire on a sibling that merely starts the same.
    eq(
      'a similarly named folder is not mistaken for a guarded one',
      protectedLocationWarning(`${home}/DownloadsArchive/IrisSpeech`, home),
      null
    );
    eq('no home means no claim', protectedLocationWarning('/opt/iris/IrisSpeech', ''), null);
  }

  {
    // Unanswered is not denied: nobody said no, nobody was asked in a way
    // they could see. Both are terminal, because retrying changes neither.
    const { b, events } = bridge('denied');
    b.start(ROOT);
    await until(() => b.state === 'unavailable');
    check('a terminal microphone fault does not retry', !events.some((e) => e.type === 'speech.restarting'));
    await b.stop();
  }

  // -----------------------------------------------------------------------
  // Only with --live: opens the real microphone. Off by default, because a
  // test suite must not turn on a recording indicator.
  if (process.argv.includes('--live')) {
    section('Live: the real helper on the real microphone');
    const b = new SpeechBridge();
    try {
      const probe = await b.probe(ROOT);
      check('the framework reports itself available', probe.transcriberAvailable);
      eq('the configured locale resolves', probe.resolvedLocale, 'ja-JP');
      eq('the model is installed', probe.assetStatus, 'installed');

      b.start(ROOT);
      const ready = await until(() => b.state === 'listening', 15_000);
      check('the microphone opens', ready);
      await wait(2000);
      await b.stop();
      eq('and closes', b.state, 'idle');
    } catch (err: any) {
      check('live probe succeeded', false, err.message);
    }
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Speech bridge: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('All speech tests passed.');
}

main().catch((err) => { console.error('\nTest harness crashed:', err); process.exit(1); });
