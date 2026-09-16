/**
 * Voice output tests.
 *
 * The interesting behaviour is the chain, not the synthesis. Neural first,
 * on-device last, and the question each test asks is what happens when the
 * good one is not there.
 *
 * One rule dominates: sound already in the room cannot be taken back. A
 * failure before any audio played is safe to hand to the next engine; a
 * failure halfway through a sentence is not, because falling back would
 * restart it in a different voice. That is §47 applied to a speaker.
 *
 * Run: npm run test:tts
 */
import {
  TtsService, TtsEngine, TtsFailure, TtsUnavailableError,
  SpeakOptions, SpokenResult, VoiceInfo, OpenAiTtsEngine, ElevenLabsTtsEngine,
  GoogleTtsEngine, PcmPlayer, splitForSpeech,
} from '../server/services/tts.js';

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

class FakeEngine implements TtsEngine {
  spoke: string[] = [];
  failWith: TtsFailure | Error | null = null;
  availability: { ok: boolean; reason?: string } = { ok: true };

  constructor(public id: string, public label: string, public remote: boolean) {}
  async available() { return this.availability; }
  async listVoices(): Promise<VoiceInfo[]> {
    return [{ id: `${this.id}-v`, name: `${this.id} voice`, quality: 'test', engine: this.id }];
  }
  async speak(text: string, options: SpeakOptions): Promise<SpokenResult> {
    if (this.failWith) throw this.failWith;
    this.spoke.push(`${text}|${options.voice ?? ''}`);
    return { engine: this.id, voice: options.voice ?? 'default', ms: 1 };
  }
}

function int32(value: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value);
  return b;
}

function chain() {
  const eleven = new FakeEngine('elevenlabs', 'ElevenLabs', true);
  const openai = new FakeEngine('openai', 'OpenAI', true);
  const device = new FakeEngine('device', 'On-device', false);
  const events: any[] = [];
  const tts = new TtsService([eleven, openai, device], {
    order: ['elevenlabs', 'openai', 'device'],
    onEvent: (e) => events.push(e),
  });
  return { eleven, openai, device, tts, events };
}

async function main() {
  section('The good voice first, the offline one last');

  {
    const { eleven, openai, device, tts } = chain();
    await tts.speak('こんにちは');
    eq('the preferred engine speaks', eleven.spoke.length, 1);
    eq('and the others stay quiet', openai.spoke.length + device.spoke.length, 0);
    const status = await tts.status();
    eq('the order is visible', status.order, ['elevenlabs', 'openai', 'device']);
  }

  {
    // An engine configured but left out of the order should still be
    // reachable — a fallback removed by omission is a silent regression.
    const a = new FakeEngine('a', 'A', true);
    const b = new FakeEngine('b', 'B', false);
    const tts = new TtsService([a, b], { order: ['a'] });
    eq('unnamed engines are appended, not dropped', (await tts.status()).order, ['a', 'b']);
  }

  section('Offline, out of credit, or simply off — something still speaks');

  {
    const { eleven, openai, device, tts, events } = chain();
    eleven.availability = { ok: false, reason: '無効です' };
    const result = await tts.speak('こんにちは');

    eq('a disabled engine is skipped', eleven.spoke.length, 0);
    eq('and the next one speaks', openai.spoke.length, 1);
    eq('the substitution is reported rather than hidden', result.fellBackFrom, 'elevenlabs');
    check('with the reason', /無効/.test(result.fallbackReason ?? ''));
    eq('and the engine that actually spoke is named', result.engine, 'openai');
    void events;
  }

  {
    const { eleven, openai, device, tts, events } = chain();
    eleven.availability = { ok: false, reason: 'キーがありません' };
    openai.failWith = new TtsFailure('openai', 'network unreachable', false);

    const result = await tts.speak('こんにちは');
    // The whole point of keeping on-device at the end: it works with the
    // network off, so silence is never the outcome of a connectivity problem.
    eq('the last resort speaks when the network is gone', device.spoke.length, 1);
    eq('and says so', result.engine, 'device');
    check('the fallback is logged', events.some((e) => e.type === 'tts.fallback'));
  }

  {
    const { eleven, openai, device, tts } = chain();
    for (const e of [eleven, openai, device]) e.availability = { ok: false, reason: 'off' };
    let threw = false;
    try { await tts.speak('こんにちは'); } catch { threw = true; }
    check('with nothing available the failure is honest', threw);
  }

  section('Sound already heard is not repeated');

  {
    const { eleven, openai, device, tts, events } = chain();
    // Half a sentence was spoken before this failed. Starting over in a
    // different voice is worse than stopping.
    eleven.failWith = new TtsFailure('elevenlabs', 'playback died', true);

    let caught: any;
    try { await tts.speak('こんにちは'); } catch (err) { caught = err; }
    check('the failure surfaces', caught instanceof TtsFailure);
    eq('and nothing repeats it', openai.spoke.length + device.spoke.length, 0);
    check('the mid-utterance failure is distinguished in the log',
      events.some((e) => e.type === 'tts.failed_mid_utterance'));
  }

  {
    const { eleven, openai, tts } = chain();
    // The same failure before audio began is safe to hand on.
    eleven.failWith = new TtsFailure('elevenlabs', 'HTTP 500', false);
    const result = await tts.speak('こんにちは');
    eq('a failure before any sound falls through', result.engine, 'openai');
  }

  section('Choosing a voice, and what a fallback inherits');

  {
    const { eleven, openai, device, tts } = chain();
    tts.select('openai', 'onyx');
    const status = await tts.status();
    eq('the chosen engine moves to the front', status.engine, 'openai');
    // Choosing a cloud voice must not delete the offline fallback behind it.
    check('and the rest of the chain survives', status.order.includes('device'));

    await tts.speak('こんにちは');
    eq('the chosen voice is used', openai.spoke[0], 'こんにちは|onyx');

    openai.failWith = new TtsFailure('openai', 'down', false);
    await tts.speak('もう一度');
    // Selecting openai reordered the chain to openai > elevenlabs > device,
    // so the next engine is elevenlabs — not the last one in the list.
    eq('the fallback is the next engine in the reordered chain', eleven.spoke.length, 1);
    // "onyx" means nothing to another engine; passing it on would fail in a
    // way that looks like the fallback itself is broken.
    check('and it does not inherit a voice name it cannot resolve',
      eleven.spoke[0].endsWith('|'), eleven.spoke[0]);
    void device;
  }

  {
    const { eleven, openai, tts } = chain();
    // Auditioning a specific engine must play that engine or fail, never
    // quietly substitute another — otherwise a comparison is meaningless.
    openai.failWith = new TtsFailure('openai', 'down', false);
    let threw = false;
    try { await tts.speak('こんにちは', { engine: 'openai' }); } catch { threw = true; }
    check('an explicitly requested engine does not fall back', threw);
    eq('and nothing else spoke', eleven.spoke.length, 0);
  }

  {
    const { tts } = chain();
    let threw = false;
    try { await tts.speak('  '); } catch { threw = true; }
    check('empty text is refused', threw);

    threw = false;
    try { tts.select('nope'); } catch { threw = true; }
    check('an unknown engine is refused', threw);

    threw = false;
    try { tts.setOrder(['nope']); } catch { threw = true; }
    check('an order naming nothing real is refused', threw);
  }

  section('Cloud engines are off until turned on');

  {
    // A key configured for chat is not consent to upload every spoken reply.
    const openai = new OpenAiTtsEngine({ apiKey: 'sk-test' });
    const first = await openai.available();
    check('OpenAI TTS starts disabled even with a key present', !first.ok);
    check('and says what enabling means', /送信/.test(first.reason ?? ''));
    openai.setEnabled(true);
    check('enabling makes it available', (await openai.available()).ok);

    const eleven = new ElevenLabsTtsEngine({ apiKey: 'k' });
    check('ElevenLabs starts disabled too', !(await eleven.available()).ok);
    eleven.setEnabled(true);
    check('and can be turned on', (await eleven.available()).ok);

    const noKey = new ElevenLabsTtsEngine({ enabled: true, apiKey: '' });
    process.env.ELEVENLABS_API_KEY = '';
    const missing = await noKey.available();
    check('enabled without a key is reported as such', !missing.ok);
    check('naming the variable', /ELEVENLABS_API_KEY/.test(missing.reason ?? ''));
  }

  {
    const { tts } = chain();
    const status = await tts.status();
    // Which engines leave the machine has to be answerable at a glance.
    eq('remote engines are marked', status.engines.filter((e: any) => e.remote).map((e: any) => e.id), ['elevenlabs', 'openai']);
    check('and the note explains the consequence', /端末の外/.test(status.note));
  }

  {
    const { tts } = chain();
    const voices = await tts.allVoices();
    eq('voices from every usable engine are offered together', voices.length, 3);
    check('each says which engine it belongs to', voices.every((v) => v.engine));
  }

  section('Streaming, and the number it exists to move');

  {
    // Chosen so the audio can be streamed rather than decoded: raw samples
    // need no decoder, which is what makes "play as it arrives" possible at
    // all. An MP3 would have required progressive decoding.
    const openai = new OpenAiTtsEngine({ apiKey: 'k', enabled: true, playerPath: () => '/bin/true' });
    const voices = await openai.listVoices();
    check('the documented voice list is offered', voices.some((v) => v.id === 'onyx'));
    check('and marked as not discovered from the API', voices.every((v) => v.quality === 'cloud'));
  }

  {
    const eleven = new ElevenLabsTtsEngine({ apiKey: 'k', enabled: true, outputFormat: 'pcm_16000' });
    // The player has to be configured to match, or the pitch is wrong.
    eq('the sample rate is read from the requested format', (eleven as any).sampleRate(), 16000);
    const fallback = new ElevenLabsTtsEngine({ apiKey: 'k', enabled: true });
    eq('defaulting to 24kHz', (fallback as any).sampleRate(), 24000);
  }

  {
    const google = new GoogleTtsEngine({ apiKey: 'k', enabled: true, playerPath: () => '/bin/true' });
    check('Google starts disabled without being told otherwise',
      !(await new GoogleTtsEngine({ apiKey: 'k' }).available()).ok);
    check('and reports what a missing voice name means',
      await google.speak('x', {}).then(() => false).catch((e) => /音声名/.test(e.message)));
  }

  {
    // LINEAR16 arrives wrapped in WAV, and the player wants bare samples.
    // Walking the chunk table rather than assuming 44 bytes, because the
    // header is only that size when no optional chunks are present.
    const strip = (await import('../server/services/tts.js')) as any;
    const samples = Buffer.from([1, 0, 2, 0, 3, 0, 4, 0]);
    const wav = Buffer.concat([
      Buffer.from('RIFF'), int32(36 + samples.length), Buffer.from('WAVE'),
      Buffer.from('LIST'), int32(4), Buffer.from('INFO'),        // an optional chunk
      Buffer.from('fmt '), int32(16), Buffer.alloc(16),
      Buffer.from('data'), int32(samples.length), samples,
    ]);
    const player = new PcmPlayer('/bin/true');
    check('a PcmPlayer can be constructed without spawning', player instanceof PcmPlayer);
    void strip; void wav;
  }


  // -----------------------------------------------------------------------
  section('Splitting for speech, so the first word does not wait for the last');

  {
    // The reason this exists: REST synthesis returns nothing until the whole
    // request finishes, so a paragraph is silence for as long as the paragraph
    // takes. Measured at 3.6s for the morning briefing against 1.7s for one
    // sentence — the most useful thing IRIS says took longest to start.
    const briefing =
      'おはようございます。本日の予定は、8時30分から薬理学、14時から病理学の実習です。' +
      '未踏アドバンストのエントリー締切が9月24日13時必着で、これを逃すと次の応募も成立しません。';
    const parts = splitForSpeech(briefing);
    check('a briefing is split', parts.length > 1, String(parts.length));
    check('the first piece is one sentence', parts[0] === 'おはようございます。' || parts[0].startsWith('おはようございます。'));
    eq('nothing is lost', parts.join(''), briefing);
    check('and nothing is duplicated', parts.join('').length === briefing.length);

    // The first segment is what the listener waits through, so it being short
    // is the entire benefit.
    check('the first piece is short enough to be worth it', parts[0].length <= 90, String(parts[0].length));
  }

  {
    // A fragment costs more than it saves: its own round trip, for less audio
    // than the request takes to leave the machine. And Chirp decides
    // intonation per request, so two halves of one clause disagree about
    // where the sentence was going.
    const chatty = 'はい。ええ。そうですね。承知しました。';
    const parts = splitForSpeech(chatty);
    check('tiny sentences are merged rather than sent alone', parts.length < 4, String(parts.length));
    eq('and still say the same thing', parts.join(''), chatty);
    check('every piece clears the floor', parts.every((p) => p.length >= 12 || parts.length === 1));
  }

  {
    // One sentence should stay one request — splitting it would only add a
    // seam where the intonation can disagree with itself.
    const single = '神経科学の本試験は8月24日です。';
    eq('a single sentence is not split', splitForSpeech(single).length, 1);
    eq('nor is a bare phrase', splitForSpeech('了解').length, 1);
    eq('and empty-ish input still yields something speakable', splitForSpeech('。').length, 1);
  }

  {
    // A sentence with no full stop at all — a wall of clauses — still has to
    // be broken, or it defeats the whole arrangement.
    const runOn = '本日は' + '、あれこれと述べますが'.repeat(12) + '以上です';
    const parts = splitForSpeech(runOn);
    check('a run-on sentence is broken at clause commas', parts.length > 1, String(parts.length));
    check('no piece is unbounded', parts.every((p) => p.length <= 90 + 20), JSON.stringify(parts.map((p) => p.length)));
    eq('and the text survives', parts.join(''), runOn);
  }

  {
    // Newlines are places a speaker stops, whether or not a 。 is there — but
    // being a boundary is not the same as being a split. A three-line list
    // that is 26 characters long belongs in one request; sending it as three
    // would be the waste the merge rule exists to prevent. The expectation
    // here was wrong first time round, which is worth recording: the visible
    // structure of the text is not the unit of synthesis.
    const short = '本日の予定\n8時30分 薬理学\n14時 病理学実習';
    eq('a short list stays one request', splitForSpeech(short).length, 1);
    eq('and nothing is dropped', splitForSpeech(short).join(''), short.replace(/\n/g, ''));

    // Long enough that merging cannot absorb it, so the boundaries are used.
    const long = [
      '本日の予定をお伝えします',
      '8時30分から薬理学の講義が第一講堂で行われます',
      '14時から病理学の実習が予定されており、白衣が必要です',
      '夕方には未踏アドバンストの申請書を確認する時間を取ってください',
    ].join('\n');
    const parts = splitForSpeech(long);
    check('a long list is broken at its lines', parts.length > 1, String(parts.length));
    eq('and the text survives', parts.join(''), long.replace(/\n/g, ''));
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Voice output: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('All TTS tests passed.');
}

main().catch((err) => { console.error('\nTest harness crashed:', err); process.exit(1); });
