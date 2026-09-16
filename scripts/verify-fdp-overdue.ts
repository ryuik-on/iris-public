/**
 * `遅延` の判定を、実データで一度だけ突き合わせる。
 *
 * `fdp:check` は全行一致すると「切り替えの前提を満たしている」と言うが、
 * **一度も出ていない判定については何も確かめていない。**期限を過ぎた課題が
 * 現在ゼロなので、`遅延` はまさにそれ — シート側の数式を止めれば比べる相手
 * は消えるので、確かめられるのは止める前だけ。
 *
 * やることは一つ。課題の期限を**一時的に**過去へ動かし、シートの数式が何と
 * 言うかを見て、IRIS の再現と突き合わせ、**必ず戻す。**
 *
 * 戻しは `finally` に置く。途中で落ちても戻る場所は一つでなければならない
 * — 台帳は他のセッションも読む。
 *
 * 触るのは `期限` だけ。Apps Script は書き込みで `最終更新日` を打ち直さない
 * ことを確認済みなので、戻せば「33日 未更新」という事実も元のまま残る。
 *
 * Run: npx tsx scripts/verify-fdp-overdue.ts [課題ID]
 */
import 'dotenv/config';
import { FdpSheets } from '../server/services/fdp_sheets.js';
import { FdpSheetWriter } from '../server/services/fdp_sheet_writer.js';
import { verdictFor, settingsFromRows, DEFAULT_SETTINGS, asOurWord } from '../server/core/fdp_verdict.js';

const TARGET = process.argv[2] || 'T007';
/** 十分に過去。境界は単体テストの担当で、ここが見たいのは「数式が遅延と言うか」。 */
const PAST = '2026/01/15';

function rowsById(rows: Record<string, string>[]) {
  const out = new Map<string, Record<string, string>>();
  for (const r of rows) {
    const id = (r['ID'] ?? r['課題ID'] ?? '').trim();
    if (id) out.set(id, r);
  }
  return out;
}

async function main() {
  const sheetId = process.env.IRIS_FDP_SHEET_ID;
  const url = process.env.IRIS_FDP_WEBAPP_URL;
  const secret = process.env.IRIS_FDP_WEBAPP_SECRET;
  if (!sheetId || !url || !secret) {
    console.log('シートの読み書きの設定が足りません。何もしていません。');
    process.exit(1);
  }

  const sheets = new FdpSheets(sheetId);
  const writer = new FdpSheetWriter(url, secret);

  const before = await sheets.fetchTab('課題台帳', '課題名');
  if (!before.ok) {
    console.log(`シートを読めません: ${before.error}。何もしていません。`);
    process.exit(1);
  }
  const original = rowsById(before.rows).get(TARGET);
  if (!original) {
    console.log(`${TARGET} が台帳にありません。何もしていません。`);
    process.exit(1);
  }

  const settings = settingsFromRows(before.rows) ?? DEFAULT_SETTINGS;
  const keep = original['期限'] ?? '';
  console.log(`${TARGET} の期限をひとまず ${PAST} に動かします（元: ${keep || '空'}）`);

  let restored = false;
  try {
    const set = await writer.update(TARGET, { 期限: PAST });
    if (!set.ok) {
      console.log(`書き込めませんでした: ${set.error}。台帳は変えていません。`);
      process.exit(1);
    }

    const after = await sheets.fetchTab('課題台帳', '課題名');
    if (!after.ok) {
      console.log(`読み直せません: ${after.error}`);
      process.exit(1);
    }
    const row = rowsById(after.rows).get(TARGET);
    const sheetSays = (row?.['自動判定'] ?? '').trim();
    const weSay = verdictFor(row ?? {}, new Date(), settings, null);

    console.log(`\n  シート「${sheetSays || '空'}」 / 再現「${weSay}」`);
    if (asOurWord(sheetSays) === '遅延' && weSay === '遅延') {
      console.log(`  ✓ 遅延を実データで突き合わせました（シートの言葉は「${sheetSays}」）。`);
    } else if (asOurWord(sheetSays) !== '遅延') {
      console.log('  ✗ シートが遅延にあたる判定を出しません。書き込みが効いていない可能性があります。');
    } else {
      console.log('  ✗ 食い違いました。**シート側の数式を止めてはいけません。**');
    }
  } finally {
    const back = await writer.update(TARGET, { 期限: keep });
    restored = back.ok;
    console.log(`\n期限を戻しました: ${restored ? `${keep || '空'} ✓` : `失敗（${back.error}）`}`);
    if (!restored) {
      console.log(`**手で戻してください。${TARGET} の期限は ${keep || '空'} でした。**`);
      process.exitCode = 1;
    }
  }
}

main();
