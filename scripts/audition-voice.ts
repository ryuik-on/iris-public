/**
 * Plays the same line in each candidate voice, so the choice is made by ear.
 *
 * "Does this sound like an assistant or like a kiosk" is not a question a
 * specification answers. Usage:
 *
 *   npm run voice:audition                  # on-device candidates
 *   npm run voice:audition -- --cloud       # adds OpenAI voices (text is uploaded)
 *   npm run voice:audition -- --text "..."  # your own line
 */
import 'dotenv/config';
import { join } from 'path';
import { existsSync } from 'fs';
import { DeviceTtsEngine, OpenAiTtsEngine, TtsService } from '../server/services/tts.js';

const ROOT = join(import.meta.dirname, '..');
const LINE =
  process.argv.includes('--text')
    ? process.argv[process.argv.indexOf('--text') + 1]
    : 'おはようございます。現在デスクにいらっしゃるようです。本日の予定は3件、最初の会議は10時からです。';

const useCloud = process.argv.includes('--cloud');

function binary(): string {
  const candidates = [
    join(ROOT, 'swift/iris-speech/.build/release/IrisSpeech'),
    join(ROOT, 'swift/iris-speech/.build/debug/IrisSpeech'),
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error('`npm run build:speech` を先に実行してください。');
  return found;
}

async function main() {
  const device = new DeviceTtsEngine(binary);
  const openai = new OpenAiTtsEngine({ enabled: useCloud });
  const tts = new TtsService([device, openai], { locale: 'ja-JP' });

  console.log(`読み上げる文: ${LINE}\n`);

  const all = await device.listVoices('ja-JP');
  // Eight of the nine are Eloquence, an older engine that all sounds alike.
  // Playing every one is an endurance test rather than a comparison, so the
  // default is a representative spread; --all plays the lot.
  const REPRESENTATIVE = ['Kyoko', 'Reed', 'Rocko'];
  const deviceVoices = process.argv.includes('--all')
    ? all
    : all.filter((v) => REPRESENTATIVE.includes(v.name));
  console.log(`▸ オンデバイス (${deviceVoices.length}/${all.length}種・--all で全部)`);
  if (all.every((v) => v.quality === 'default')) {
    console.log(
      '  ※ すべて default 品質です。enhanced / premium はシステム設定 > アクセシビリティ >\n' +
      '     読み上げコンテンツ > システムの声 > 声を管理 から手動で追加します。\n'
    );
  }

  for (const voice of deviceVoices) {
    process.stdout.write(`  ${voice.quality.padEnd(8)} ${voice.name.padEnd(10)} ... `);
    try {
      const result = await tts.speak(LINE, { engine: 'device', voice: voice.id });
      console.log(`${result.ms}ms`);
    } catch (err: any) {
      console.log(`失敗: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 400));
  }

  if (!useCloud) {
    console.log('\n--cloud を付けるとクラウド音声も比較できます（テキストが OpenAI に送信されます）。');
    return;
  }

  console.log('\n▸ OpenAI TTS — 読み上げテキストがこの端末の外に出ます');
  // A subset: eleven voices of the same sentence is an endurance test, not a
  // comparison. These four span the range worth hearing for this use.
  for (const voice of ['onyx', 'ash', 'sage', 'nova']) {
    process.stdout.write(`  ${voice.padEnd(10)} ... `);
    try {
      const result = await tts.speak(LINE, { engine: 'openai', voice });
      console.log(`${result.ms}ms`);
    } catch (err: any) {
      console.log(`失敗: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 400));
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
