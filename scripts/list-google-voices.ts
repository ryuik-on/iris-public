import 'dotenv/config';
import { GoogleTtsEngine } from '../server/services/tts.js';

async function main() {
  const g = new GoogleTtsEngine({ enabled: true, playerPath: () => '/bin/true' });
  const voices = await g.listVoices('ja-JP');
  const chirp = voices.filter((v) => v.quality === 'chirp3-hd');
  const byGender: Record<string, string[]> = {};
  for (const v of chirp) {
    const g2 = v.gender || 'unknown';
    (byGender[g2] ??= []).push(v.name.replace('ja-JP-Chirp3-HD-', ''));
  }
  console.log(`Chirp 3 HD (ja-JP): ${chirp.length}種 / 全${voices.length}種`);
  for (const [gender, names] of Object.entries(byGender)) {
    console.log(`  ${gender.padEnd(8)} ${names.length}種: ${names.join(', ')}`);
  }
}
main().catch((e) => { console.error(e.message); process.exit(1); });
