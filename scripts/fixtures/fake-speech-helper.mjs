#!/usr/bin/env node
/**
 * Stand-in for the Swift helper.
 *
 * Lets the bridge's supervision, parsing and buffering be tested without a
 * microphone, a model download, or macOS 26 — the parts most likely to be
 * wrong are the ones that only show up when something goes badly, and those
 * are unreachable from a working microphone.
 *
 * Behaviour is chosen by SPEECH_FIXTURE.
 */
const mode = process.env.SPEECH_FIXTURE || 'normal';
const write = (obj) => process.stdout.write(JSON.stringify({ at: new Date().toISOString(), ...obj }) + '\n');

process.stdin.on('end', () => {
  if (mode === 'ignores_stdin') return; // never exits; the bridge must kill it
  write({ event: 'final', text: '最後の一文' });
  write({ event: 'stopped' });
  process.exit(0);
});
process.stdin.resume();

switch (mode) {
  case 'denied':
    write({ event: 'error', code: 'microphone_denied', message: 'マイク不許可', hint: 'システム設定' });
    process.exit(1);
    break;

  case 'crash':
    write({ event: 'ready', locale: 'ja-JP', sampleRate: 16000 });
    setTimeout(() => process.exit(3), 20);
    break;

  case 'garbage':
    write({ event: 'ready', locale: 'ja-JP', sampleRate: 16000 });
    process.stdout.write('this is not json\n');
    write({ event: 'final', text: '壊れた行のあとも続く' });
    break;

  case 'split': {
    // One JSON object delivered in three writes, to prove reassembly.
    write({ event: 'ready', locale: 'ja-JP', sampleRate: 16000 });
    const line = JSON.stringify({ event: 'final', text: '分割された行' });
    process.stdout.write(line.slice(0, 10));
    setTimeout(() => process.stdout.write(line.slice(10, 25)), 10);
    setTimeout(() => process.stdout.write(line.slice(25) + '\n'), 20);
    break;
  }

  case 'flood':
    write({ event: 'ready', locale: 'ja-JP', sampleRate: 16000 });
    for (let i = 0; i < 50; i++) write({ event: 'final', text: `発話${i}` });
    break;

  case 'probe':
    write({
      event: 'probe',
      transcriberAvailable: true,
      requestedLocale: 'ja-JP',
      resolvedLocale: 'ja-JP',
      assetStatus: 'installed',
      supportedLocales: ['ja-JP', 'en-US'],
      installedLocales: ['ja-JP'],
      microphoneAuthorization: 'authorized',
    });
    process.exit(0);
    break;

  case 'install_fails':
    write({ event: 'error', code: 'install_failed', message: 'ネットワーク断' });
    process.exit(1);
    break;

  case 'ignores_stdin':
    write({ event: 'ready', locale: 'ja-JP', sampleRate: 16000 });
    setInterval(() => {}, 1000);
    break;

  default:
    write({ event: 'ready', locale: 'ja-JP', sampleRate: 16000 });
    write({ event: 'partial', text: 'こん' });
    write({ event: 'partial', text: 'こんにちは' });
    write({ event: 'final', text: 'こんにちは。', start: 0.7, end: 2.4 });
    write({ event: 'partial', text: 'いま' });
}
