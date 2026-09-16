/**
 * 検算: does the reproduced 自動判定 agree with the sheet's own column?
 *
 * This is the gate. The sheet's ARRAYFORMULA must not be switched off until
 * this reports zero mismatches, because that column is the only detector for
 * a task going quiet — reproduce it wrong and the way to notice goes with it.
 *
 * Reads only. Run: npm run fdp:check
 */
import 'dotenv/config';
import { FdpSheets } from '../server/services/fdp_sheets.js';
import { verdictFor, settingsFromRows, DEFAULT_SETTINGS, asOurWord } from '../server/core/fdp_verdict.js';

async function main() {
  const id = process.env.IRIS_FDP_SHEET_ID;
  if (!id) { console.error('IRIS_FDP_SHEET_ID がありません。'); process.exit(2); }

  const sheets = new FdpSheets(id);
  const ledger = await sheets.fetchTab('課題台帳', '課題名');
  if (!ledger.ok) { console.error(`課題台帳を読めませんでした: ${ledger.error}`); process.exit(2); }

  const config = await sheets.fetchTab('設定', '設定項目');
  const settings = config.ok ? settingsFromRows(config.rows) : DEFAULT_SETTINGS;
  if (!config.ok) console.log(`設定タブを読めなかったので既定値で検算します（${config.error}）`);
  console.log(`閾値: 更新停止 ${settings.stalledAfterDays}日 / 期限間近 ${settings.dueSoonDays}日前\n`);

  const today = new Date();
  let mismatches = 0;
  let blank = 0;
  let total = 0;
  /** 実データで実際に突き合わせられた判定。出なかったものは確かめていない。 */
  const exercised = new Set<string>();

  for (const row of ledger.rows) {
    const id = (row['ID'] ?? '').trim();
    if (id) total++;
    if (!id) continue;
    const sheetSays = (row['自動判定'] ?? '').trim();
    const weSay = verdictFor(row, today, settings);

    // A blank cell is not a disagreement — the formula has not reached that
    // row. Counted separately so it cannot be read as agreement either.
    if (sheetSays === '') {
      blank++;
      console.log(`  ? ${id}  シート空欄 / 再現 ${weSay}`);
      continue;
    }
    // シートの言葉をこちらの言葉に直してから比べる。`期限超過` は `遅延`。
    if (asOurWord(sheetSays) === weSay) {
      exercised.add(weSay);
      console.log(`  ✓ ${id}  ${weSay}`);
    } else {
      mismatches++;
      console.log(`  ✗ ${id}  シート「${sheetSays}」 / 再現「${weSay}」` +
        `  状態=${row['状態'] ?? ''} 開始=${row['開始予定日'] ?? ''} 期限=${row['期限'] ?? ''} 最終更新=${row['最終更新日'] ?? ''}`);
    }
  }

  console.log(`\n不一致 ${mismatches}件 / 空欄 ${blank}件`);

  /**
   * 全部空欄なら、それは壊れたのではなく**止めたあと**。
   *
   * シートの数式を消すと `自動判定` は全行空になる。何も変えないと、この
   * 突き合わせは毎回「空欄10件」を並べて、**故障と区別が付かない。**
   * 比べる相手がいなくなったことは、そう言えばいい。
   */
  if (blank > 0 && blank === total && mismatches === 0) {
    console.log('\nシートの 自動判定 は空です。数式は止まっています。');
    console.log('突き合わせる相手はもういません。判定は IRIS だけが持っています。');
    console.log('この確認はもう役目を終えました。');
    return;
  }
  if (mismatches > 0) {
    console.log('シート側の数式を止めてはいけません。再現が合っていません。');
    process.exit(1);
  }

  /**
   * 全行一致は、**出た判定についてしか**何も言わない。
   *
   * 「切り替えの前提を満たしています」とだけ書いていたが、実データに
   * 一度も現れていない判定は、この突き合わせで**一度も比べられていない。**
   * `遅延` は期限を過ぎた課題が無いので、まさにそれ — にもかかわらず
   * 一致件数だけを見て「前提を満たした」と読めてしまう。
   *
   * **数式を止めるのは戻しにくい操作**で、止めたあとは比べる相手がいない。
   * 確かめていないものは、確かめていないと言う。
   */
  /**
   * 比べられる判定と、比べようがない判定を分ける。
   *
   * `保留` はシートが知らない状態なので、**出ていないのではなく比べる相手が
   * いない。**同じ「未確認」に混ぜると、埋めようのないものを待ち続けることに
   * なる。`遅延` は比べられるのに出ていなかっただけで、
   * `verify-fdp-overdue` が期限を一時的に動かして突き合わせる。
   */
  const comparable = ['完了', '遅延', '順調', '更新停止'];
  const missing = comparable.filter((v) => !exercised.has(v));
  console.log(`\n実データで突き合わせた判定: ${[...exercised].join('・') || 'なし'}`);
  console.log('保留: シートが知らない状態なので、突き合わせる相手がいません。');
  if (missing.length > 0) {
    console.log(`**実データに出ていない判定: ${missing.join('・')}**`);
    console.log('`npx tsx scripts/verify-fdp-overdue.ts` で期限を一時的に動かして確かめられます。');
    console.log('全行一致しましたが、切り替えの前提としては足りていません。');
    return;
  }
  console.log('比べられる判定はすべて実データで一致。切り替えの前提を満たしています。');
}

main();
