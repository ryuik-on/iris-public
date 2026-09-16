/**
 * Reads one sentence through every configured engine, under the same
 * conditions, and measures what can be measured.
 *
 * The split matters. Time-to-first-audio, total duration, whether the engine
 * streams, and whether it can be cut off mid-sentence are facts, and this
 * script reports them. Naturalness, intonation, phrasing and whether a drug
 * name is pronounced correctly are not facts this program has any access to —
 * those are for the person listening, so the output ends with a scoring sheet
 * rather than a verdict.
 *
 * The default passage is chosen for the hard parts of the intended use: a
 * Greek-letter receptor subtype, a drug name in katakana, and clinical terms
 * that a general-purpose voice tends to run together.
 *
 *   npm run tts:compare
 *   npm run tts:compare -- --text "..."      # your own passage
 *   npm run tts:compare -- --engine openai   # just one
 */
import 'dotenv/config';
import { join } from 'path';
import { existsSync } from 'fs';
import {
  DeviceTtsEngine, OpenAiTtsEngine, ElevenLabsTtsEngine, GoogleTtsEngine,
  TtsEngine, SpokenResult,
} from '../server/services/tts.js';
import { applyPronunciations, SEED_PRONUNCIATIONS } from '../server/services/pronunciation.js';

const ROOT = join(import.meta.dirname, '..');

const PASSAGE =
  process.argv.includes('--text')
    ? process.argv[process.argv.indexOf('--text') + 1]
    : 'アドレナリンβ2受容体刺激薬であるサルブタモールは、気管支平滑筋を弛緩させ、' +
      '気管支喘息の発作を改善する。ただし、頻脈や手指振戦に注意する。';

const only = process.argv.includes('--engine')
  ? process.argv[process.argv.indexOf('--engine') + 1]
  : null;

/**
 * Several voices from one engine, for the second round of choosing.
 *
 * The first round picks an engine; this one picks a voice inside it, which is
 * a different question and the one with thirty candidates behind it.
 */
const voiceList = process.argv.includes('--voices')
  ? process.argv[process.argv.indexOf('--voices') + 1].split(',').map((v) => v.trim())
  : null;

/**
 * Delivery direction, for engines that accept it.
 *
 * The lever for the complaint that is not about words. Reading the right
 * syllables and reading them like a person are different problems, and a
 * dictionary cannot touch the second.
 */
const instructions = process.argv.includes('--instructions')
  ? process.argv[process.argv.indexOf('--instructions') + 1]
  : undefined;

function binary(): string {
  const candidates = [
    join(ROOT, 'swift/iris-speech/.build/release/IrisSpeech'),
    join(ROOT, 'swift/iris-speech/.build/debug/IrisSpeech'),
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error('`npm run build:speech` を先に実行してください。');
  return found;
}

interface Row {
  engine: string;
  voice: string;
  ok: boolean;
  ttfaMs?: number;
  totalMs?: number;
  streamed?: boolean;
  note: string;
}

async function main() {
  const player = () => binary();

  // Every cloud engine is enabled explicitly here, because comparing them is
  // the entire point of running this. That is not the server's default.
  const engines: Array<{ engine: TtsEngine; voice?: string }> = [
    { engine: new GoogleTtsEngine({ enabled: true, playerPath: player }), voice: process.env.IRIS_TTS_GOOGLE_VOICE },
    { engine: new ElevenLabsTtsEngine({ enabled: true, playerPath: player }), voice: process.env.IRIS_TTS_ELEVENLABS_VOICE },
    { engine: new OpenAiTtsEngine({ enabled: true, playerPath: player }), voice: process.env.IRIS_TTS_OPENAI_VOICE ?? 'onyx' },
    { engine: new DeviceTtsEngine(player), voice: process.env.IRIS_TTS_DEVICE_VOICE ?? 'Kyoko' },
  ].filter(({ engine }) => !only || engine.id === only);

  // The comparison speaks what IRIS would speak, corrections included —
  // otherwise it measures a voice on text the assistant never sends.
  const corrected = applyPronunciations(PASSAGE, SEED_PRONUNCIATIONS);
  const SPOKEN = corrected.text;
  console.log(`読み上げる文:\n  ${PASSAGE}`);
  if (corrected.applied.length > 0) {
    console.log(`  読み補正: ${corrected.applied.map((a) => `${a.term}→${a.reading}`).join('、')}`);
  }
  console.log();

  const rows: Row[] = [];

  if (voiceList) {
    const target = engines[0];
    if (!target) {
      console.log('--voices は --engine と併せて使ってください。');
      return;
    }
    const availability = await target.engine.available();
    if (!availability.ok) {
      console.log(`${target.engine.id} 利用不可 — ${availability.reason}`);
      return;
    }
    console.log(`▸ ${target.engine.id}: ${voiceList.length}種を順に再生\n`);
    for (const voice of voiceList) {
      process.stdout.write(`  ${voice.padEnd(30)} `);
      try {
        const result = await target.engine.speak(SPOKEN, { voice, instructions });
        console.log(`初音 ${result.ttfaMs ?? '—'}ms  全体 ${result.ms}ms`);
      } catch (err: any) {
        console.log(`失敗 — ${err.message}`);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    console.log('\n気に入ったものを IRIS_TTS_GOOGLE_VOICE に設定してください。');
    return;
  }

  for (const { engine, voice } of engines) {
    const availability = await engine.available();
    if (!availability.ok) {
      rows.push({ engine: engine.id, voice: voice ?? '—', ok: false, note: availability.reason ?? '利用不可' });
      console.log(`▸ ${engine.id.padEnd(11)} 利用不可 — ${availability.reason}`);
      continue;
    }

    // Discovery before synthesis: a voice name written in a config file is a
    // name that rots, and the list is worth seeing anyway.
    let resolved = voice;
    if (!resolved) {
      try {
        const voices = await engine.listVoices('ja-JP');
        const best = voices.find((v) => /chirp3-hd/i.test(v.quality)) ?? voices[0];
        resolved = best?.id;
        if (voices.length > 0) {
          console.log(`▸ ${engine.id}: ${voices.length}種の音声 — 先頭 ${voices.slice(0, 4).map((v) => v.name).join(', ')}`);
        }
      } catch (err: any) {
        console.log(`▸ ${engine.id}: 音声一覧を取得できません — ${err.message}`);
      }
    }

    process.stdout.write(`▸ ${engine.id.padEnd(11)} ${String(resolved ?? 'default').padEnd(28)} `);
    try {
      const result: SpokenResult = await engine.speak(SPOKEN, { voice: resolved, instructions });
      rows.push({
        engine: engine.id,
        voice: result.voice,
        ok: true,
        ttfaMs: result.ttfaMs,
        totalMs: result.ms,
        streamed: result.streamed,
        note: '',
      });
      console.log(
        `初音 ${result.ttfaMs !== undefined ? `${result.ttfaMs}ms` : '—'}  ` +
        `全体 ${result.ms}ms  ${result.streamed ? 'ストリーミング' : '一括'}`
      );
    } catch (err: any) {
      rows.push({ engine: engine.id, voice: resolved ?? '—', ok: false, note: err.message });
      console.log(`失敗 — ${err.message}`);
    }

    await new Promise((r) => setTimeout(r, 600));
  }

  console.log(`\n${'─'.repeat(72)}`);
  console.log('測定できたもの\n');
  console.log('  エンジン      初音まで    全体      方式');
  for (const row of rows) {
    if (!row.ok) {
      console.log(`  ${row.engine.padEnd(12)} —          —         ${row.note.slice(0, 40)}`);
      continue;
    }
    console.log(
      `  ${row.engine.padEnd(12)} ${String(row.ttfaMs ?? '—').padEnd(11)} ${String(row.totalMs).padEnd(9)} ` +
      `${row.streamed ? 'ストリーミング' : '一括合成'}`
    );
  }

  // Deliberately not scored here. A program cannot hear whether 「β2受容体」
  // was read as a receptor subtype or as three separate tokens.
  console.log(`\n${'─'.repeat(72)}`);
  console.log('聴いて判断するもの — 各エンジンについて\n');
  for (const item of [
    '声質の自然さ',
    '抑揚（文末が不自然に上がらないか）',
    '文の区切り（読点・句点で息が入るか）',
    '医学用語の発音（β2受容体・サルブタモール・手指振戦）',
    '長い説明で疲れないか',
  ]) {
    console.log(`  □ ${item}`);
  }
  console.log('\n途中キャンセル: /api/tts/stop または panel の STOP。');
  console.log('ストリーミングのエンジンは即座に止まります（パイプを閉じるため）。');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
