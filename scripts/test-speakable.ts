/**
 * 届きはじめた返事を、声に出してよい単位へ切る。
 *
 * 確かめるのは二つ。**早く喋り出せること**と、**切ってはいけないところで
 * 切らないこと。**二つめが効かないと、速さのために文が壊れる —— 人は文の
 * 切れ目では待てるが、文の途中では待てない。
 *
 * Run: npm run test:speakable
 */
import { Speakable } from '../server/core/speakable.js';

let passed = 0, failed = 0;
const failures: string[] = [];
function section(n: string) { console.log(`\n▸ ${n}`); }
function eq(n: string, a: any, b: any) {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (ok) { passed++; console.log(`  ✓ ${n}`); }
  else { failed++; failures.push(`${n}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`); console.log(`  ✗ ${n}`); }
}

/** 一文字ずつ届く、最悪の刻み方で流す。 */
function trickle(s: Speakable, text: string): string[] {
  const out: string[] = [];
  for (const ch of text) out.push(...s.push(ch));
  return out;
}

section('文が揃った時点で喋り出す');
{
  const s = new Speakable();
  const spoken = trickle(s, '今日は19時から職場です。そのあと予定はありません。');
  eq('一文目は、二文目を待たずに出る', spoken[0], '今日は19時から職場です。');
  // 二文目は下限（18字）に足りないので、**捨てずに手元へ**。返事の終わりに出る。
  eq('短い二文目は手元に残る', s.held, 'そのあと予定はありません。');
  eq('終わりに flush が出す', s.flush(), ['そのあと予定はありません。']);
}
{
  const s = new Speakable();
  const spoken = trickle(s, 'はい。');
  eq('最初の一片は短くてよい（沈黙を削るのが目的）', spoken, ['はい。']);
}
{
  const s = new Speakable();
  eq('文の途中では出さない', trickle(s, '今日は19時から'), []);
  eq('手元には残っている', s.held, '今日は19時から');
  eq('句点が来たら出る', s.push('職場です。'), ['今日は19時から職場です。']);
}

section('切ってはいけないところで切らない');
{
  const s = new Speakable();
  eq('小数点は文の終わりではない', trickle(s, '合計は3.5キロです。'), ['合計は3.5キロです。']);
}
{
  const s = new Speakable();
  eq('番地の点も切れ目ではない', trickle(s, 'サーバは127.0.0.1で動いています。'), ['サーバは127.0.0.1で動いています。']);
}
{
  const s = new Speakable();
  const spoken = trickle(s, '資料は https://example.com/a.b.c にあります。');
  eq('URL の中では切らない', spoken, ['資料は https://example.com/a.b.c にあります。']);
}
{
  const s = new Speakable();
  const spoken = trickle(s, '手順です。\n```\nnpm test\n```\n以上です。');
  eq('コード塊の中では切らない', spoken.some((p) => p.includes('npm test') && p.includes('```')), true);
  eq('塊の前は先に出る', spoken[0], '手順です。');
}
{
  // 英文のピリオドは、次が空白か終端のときだけ文の終わり。
  const s = new Speakable();
  eq('v1.2 は切れ目ではない', trickle(s, 'バージョンはv1.2です。'), ['バージョンはv1.2です。']);
}

section('句点が来ないまま長くなったら、読点で切る');
{
  const s = new Speakable({ maxChars: 30 });
  const long = '今日は朝から病理学の実習があって、そのあと昼をはさんで循環器の講義が入っていて、夜は職場です。';
  const spoken = trickle(s, long);
  eq('待ちすぎずに切れる', spoken.length >= 2, true);
  eq('切れ目は読点の直後', spoken[0].endsWith('、'), true);
  eq('全部つなぐと元に戻る', spoken.join('') + s.held, long);
}
{
  const s = new Speakable({ maxChars: 30 });
  // 短い読点では切らない —— 途切れて聞こえる。
  const spoken = trickle(s, 'はい、そうです。');
  eq('短ければ読点では切らない', spoken, ['はい、そうです。']);
}

section('言い残さない');
{
  const s = new Speakable();
  trickle(s, '終わりの句点が無い返事');
  eq('flush で残りが出る', s.flush(), ['終わりの句点が無い返事']);
  eq('二度目は空', s.flush(), []);
}
{
  const s = new Speakable();
  trickle(s, '一文目です。');
  eq('残りが無ければ flush は空', s.flush(), []);
}

section('作り直しは、まだ喋っていない分だけ捨てられる');
{
  const s = new Speakable();
  trickle(s, '途中まで');
  s.reset();
  eq('手元の分は消える', s.held, '');
  eq('まだ何も喋っていない', s.pieces, 0);
}
{
  /*
   * **既に声に出した分は取り消せない。**`pieces` が 0 でなければ、聞いた人は
   * 前の答えの一部を聞いている。捨てられるのは手元の分だけ、という事実を
   * 呼ぶ側が読めるようにしておく。
   */
  const s = new Speakable();
  trickle(s, '前の答えです。途中まで');
  eq('一片は既に出ている', s.pieces, 1);
  s.reset();
  eq('捨てられるのは手元の分だけ', s.held, '');
  eq('出した数は戻らない', s.pieces, 1);
}

section('空白と空の delta');
{
  const s = new Speakable();
  eq('空の delta は何も出さない', s.push(''), []);
  eq('空白だけでも出さない', s.push('   '), []);
  eq('句点だけなら、前後の空白を落として出す', s.push(' はい。 '), ['はい。']);
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`Speakable: ${passed} passed, ${failed} failed`);
if (failed) { console.log('\nFailures:'); for (const f of failures) console.log('  - ' + f); process.exit(1); }
console.log('All speakable tests passed.');
