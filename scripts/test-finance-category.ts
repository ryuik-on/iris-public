/**
 * 支出の分類の試験。
 *
 * 中心は「当たること」ではなく、**当たっていないものが当たった顔をしない
 * こと。**分類は後から見ると、それが規則で入ったのか当てずっぽうで入ったのか
 * 見分けがつかない — 数字だけが残る。だから知らない店は `null` で置き、
 * 「その他」には入れない。
 */

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { categorise, fold } from '../server/core/finance_category.js';
import { openDatabase } from '../server/services/db.js';
import { FinanceStore } from '../server/services/finance_sqlite.js';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail?: any) {
  if (ok) { passed++; console.log('  ✓ ' + name); }
  else { failed++; failures.push(name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); console.log('  ✗ ' + name); }
}
function section(name: string) { console.log('\n▸ ' + name); }

section('カードの潰れた片仮名でも当たる');
{
  /*
   * 明細は「フアミリ－マ－ト」で届く — 小書きが大書きになり、長音が `－` に
   * なる。規則を明細の綴りで書くと、綴りが変わった日に黙って外れる。
   * 潰し方を両側に掛けるので、規則は普通の日本語で書ける。
   */
  check('フアミリ－マ－ト → 食費', categorise('フアミリ－マ－ト') === '食費');
  check('アツプルドツトコム → サブスク', categorise('アツプルドツトコム') === 'サブスク');
  check('グ－グル　プレイ　アツプ → サブスク', categorise('グ－グル　プレイ　アツプ') === 'サブスク');
  check('ホツトペツパ－ビユ－テイ－ → 美容', categorise('ホツトペツパ－ビユ－テイ－') === '美容');
  check('スタ－バツクス　コ－ヒ－ → 食費', categorise('スタ－バツクス　コ－ヒ－　ジヤパン') === '食費');
  check('平仮名で書いた規則も当たる（スキヤ）', categorise('スキヤ') === '食費');
  check('潰しは冪等', fold(fold('フアミリ－マ－ト')) === fold('フアミリ－マ－ト'));
}

section('分からないものは分けない');
{
  check('店名が届いていなければ null', categorise('(利用先不明)') === null);
  check('空文字は null', categorise('') === null);
  /*
   * 知らない店を「その他」に入れると、**調べた上でどれでもない**ものと
   * **調べていない**ものが同じ箱に入る。後から見て区別できない。
   */
  check('知らない店は「その他」ではなく null', categorise('カブシキガイシヤ　ナントカ') === null);
  check('海外利用分は店名ではないので null', categorise('JCBクレジットご利用分（海外利用分）') === null);
}

section('順番が意味を持つ');
{
  /*
   * 上から順に当てるので、具体的なものが先。「コーヒー」は食費だが、
   * 「ホットペッパービューティー」より後に置かないと美容が食費に落ちる
   * ような取り違えが起きうる — 順番は規則の一部。
   */
  check('美容が食費より先に当たる', categorise('ホツトペツパ－ビユ－テイ－') === '美容');
  check('通信がサブスクより先に当たる', categorise('ＵＱ　ｍｏｂｉｌｅ　ご利用料金') === '通信');
}

section('規則を変えたら過去の行も変わる');
{
  /*
   * 分類は行の中身ではなく規則の側にある。取り込み済みの行だけ古い答えの
   * まま残ると、同じ店が月によって別の箱に入り、**その食い違いは画面からは
   * 分類の失敗に見えない** — 数字が合わないだけになる。
   */
  const dir = mkdtempSync(join(tmpdir(), 'iris-cat-'));
  const db = openDatabase(join(dir, 'f.db'));
  const store = new FinanceStore(db);
  store.import({
    fileName: 't', format: 'test', account: 'card', skipped: 0,
    transactions: [
      { occurredOn: '2026-08-01', amount: -500, description: 'フアミリ－マ－ト' },
      { occurredOn: '2026-08-02', amount: -300, description: 'ナゾノミセ' },
    ] as any,
  });
  check('取り込み時点では未分類', (db.prepare('select count(*) n from finance_transactions where category is null').get() as any).n === 2);

  const first = store.recategorise(categorise);
  check('掛け直すと分かるものだけ入る', first.changed === 1, first);
  check('分からない方は null のまま', (db.prepare("select category from finance_transactions where description='ナゾノミセ'").get() as any).category === null);

  check('もう一度掛けても何も動かない', store.recategorise(categorise).changed === 0);

  // 規則から外したら、箱からも消えること。外した判断が生き残らない。
  const back = store.recategorise(() => null);
  check('規則から外すと null に戻る', back.changed === 1, back);
  db.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log('\n' + '─'.repeat(60));
console.log(`Finance category: ${passed} passed, ${failed} failed`);
if (failed) { console.log('\nFailures:'); for (const f of failures) console.log('  - ' + f); process.exit(1); }
console.log('All finance category tests passed.');
