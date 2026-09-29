/**
 * 聞こえたものが IRIS 自身の声か。
 *
 * 確かめたいのは二つで、**取り違えの重さが逆向き**なのが要点。
 * 自分の声を人の声と読むと、IRIS が自分に答えはじめて輪になる。
 * 人の声を自分の声と読むと、**割り込みが死ぬ** —— 被せて話しかけたのに無視される。
 * どちらも黙って起きるので、両方を押さえる。
 *
 * Run: npm run test:own-voice
 */
import { isOwnVoice } from '../server/core/own_voice.js';

let passed = 0, failed = 0;
const failures: string[] = [];
function section(n: string) { console.log(`\n▸ ${n}`); }
function eq(n: string, a: any, b: any) {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (ok) { passed++; console.log(`  ✓ ${n}`); }
  else { failed++; failures.push(`${n}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`); console.log(`  ✗ ${n}`); }
}

const T = 1_000_000;
const saying = (text: string, startedAt = T) => ({ text, original: text, startedAt });

section('黙っているときは、何を聞いても人の声');
{
  eq('読み上げていない', isOwnVoice('IRIS 今日の予定は', null, T).own, false);
  eq('理由も言う', isOwnVoice('IRIS 今日の予定は', null, T).reason, 'not_speaking');
  eq('文が空なら判断しない', isOwnVoice('IRIS', saying(''), T).reason, 'not_speaking');
}

section('読み上げている文が返ってきたら、自分の声');
{
  const speaking = saying('今日は19時から職場です。');
  eq('そのまま返ってきた', isOwnVoice('今日は19時から職場です', speaking, T + 500).own, true);
  eq('途中から拾われた', isOwnVoice('19時から職場です', speaking, T + 500).own, true);
  eq('途中で切れた', isOwnVoice('今日は19時から', speaking, T + 300).own, true);
  eq('理由は自己エコー', isOwnVoice('今日は19時から', speaking, T + 300).reason, 'self_echo');
}
{
  // 記号と空白は声にも認識にも安定して残らないので、比べる前に落とす。
  const speaking = saying('今日は、19時から職場です！');
  eq('記号の違いは同じものと見る', isOwnVoice('今日は19時から職場です', speaking, T + 400).own, true);
}
{
  /*
   * **名前を含む文を自分で読み上げたとき**が、この関数のある理由。名前が
   * あるので「呼ばれた」ことになり、放っておくと IRIS が自分に答える。
   */
  const speaking = saying('IRIS は今日の予定を三件持っています。');
  eq('自分の名前を読み上げた分も自分の声', isOwnVoice('IRISは今日の予定を三件持っています', speaking, T + 600).own, true);
}

section('被せて話した人の声は、殺さない');
{
  const speaking = saying('今日は19時から職場です。');
  eq('別のことを言っている', isOwnVoice('IRIS ちょっと待って', speaking, T + 400).own, false);
  eq('理由は人の声', isOwnVoice('IRIS ちょっと待って', speaking, T + 400).reason, 'someone_else');
}
{
  // 短すぎる一致では自分の声と決めない。「はい」は誰でも言う。
  const speaking = saying('はい、承知しました。');
  eq('短い相槌の一致は根拠にしない', isOwnVoice('はい', speaking, T + 100).own, false);
}

section('鳴り終わってからも、しばらくは自分の声が届く');
{
  const speaking = saying('今日は19時から職場です。');
  eq('直後に確定した分は自分の声', isOwnVoice('今日は19時から職場です', speaking, T + 1200).own, true);
}
{
  /*
   * 鳴りはじめより**前**に聞こえたものは、自分の声ではありえない。確定が
   * 遅れて届くので、届いた時刻ではなく聞こえた時刻で見る。
   */
  const speaking = saying('今日は19時から職場です。', T + 5000);
  eq('鳴る前に聞こえたものは人の声', isOwnVoice('今日は19時から職場です', speaking, T).own, false);
}

section('読み上げ前の文と比べる');
{
  /*
   * 認識は標準的な表記で返す。読み仮名を当てたあとの文字列と比べると、
   * **正しく読めたことを別物と読む。**
   */
  const speaking = { text: 'さんじゅうもんです', original: '30問です', startedAt: T };
  eq('元の文と比べる', isOwnVoice('30問です', speaking, T + 200).own, true);
}
{
  // 丸ごと一致でも、短すぎれば決めない。
  const speaking = { text: 'はい', original: 'はい', startedAt: T };
  eq('「はい」だけの一致では決めない', isOwnVoice('はい', speaking, T + 100).own, false);
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`Own voice: ${passed} passed, ${failed} failed`);
if (failed) { console.log('\nFailures:'); for (const f of failures) console.log('  - ' + f); process.exit(1); }
console.log('All own voice tests passed.');
