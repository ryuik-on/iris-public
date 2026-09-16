/**
 * 家計の道具の試験。
 *
 * 中心は二つ。**明細が出ないこと**と、**分かっていないことを分かっている顔で
 * 答えさせないこと。**
 *
 * 家計はもともと「共有してよい集計」と「ローカル限定の取引」に分けて作って
 * ある。この道具が集計しか返さないのは制限ではなく、その切り分けそのもの。
 * 取引が一件でも漏れたら、分けた意味が消える。
 */

import Database from 'better-sqlite3';
import { FinanceStore } from '../server/services/finance_sqlite.js';
import { createFinanceTools } from '../server/tools/finance.js';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail?: any) {
  if (ok) {
    passed++;
    console.log('  ✓ ' + name);
  } else {
    failed++;
    failures.push(name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : ''));
    console.log('  ✗ ' + name);
  }
}

function section(name: string) {
  console.log('\n▸ ' + name);
}

function store(rows: Array<{ month: string; total: number; count: number; status?: string; kind?: string; category?: string }>) {
  return {
    aggregates: () =>
      rows.map((r) => ({
        month: r.month,
        kind: r.kind ?? 'spending',
        status: r.status ?? 'confirmed',
        category: r.category ?? '未分類',
        total: r.total,
        count: r.count,
      })),
    imports: (_n: number) => [
      { id: 'x', fileName: 'gmail:60d', format: 'gmail', rows: 10, skipped: 0, importedAt: new Date(Date.now() - 20 * 86_400_000).toISOString() },
    ],
  } as unknown as FinanceStore;
}

async function main() {
  section('明細は出ない');
  {
    const tool = createFinanceTools(store([{ month: '2026-08', total: -1000, count: 3 }]))[0];
    const out: any = await tool.execute({});
    check('集計は返る', out.months?.[0]?.spentYen === 1000, out.months);
    check('明細は返らないと明示する', out.detailAvailable === false, out);
    // 返り値のどこにも取引の痕跡を残さない。
    const text = JSON.stringify(out);
    check('取引らしき語が混ざらない', !/description|merchant|occurredOn|利用先/.test(text));
    check('答えられないことを言うよう指示する', /答えられない/.test(out.guidance), out.guidance);
  }

  section('無いことと、取り込んでいないことを分ける');
  {
    const tool = createFinanceTools(store([]))[0];
    const out: any = await tool.execute({});
    check('読めてはいる', out.readable === true, out);
    check('「支出はありません」と言わせない', /取り込まれていない/.test(out.guidance), out.guidance);
  }

  section('確定していないことを黙らない');
  {
    const tool = createFinanceTools(
      store([{ month: '2026-08', total: -5000, count: 4, status: 'pending' }])
    )[0];
    const out: any = await tool.execute({});
    check('未確定の件数を出す', out.months[0].unconfirmed === 4, out.months[0]);
    check('確定額として答えるなと指示する', /確定した額として答えないで/.test(out.guidance), out.guidance);
  }
  {
    const tool = createFinanceTools(
      store([{ month: '2026-08', total: -5000, count: 4, status: 'confirmed' }])
    )[0];
    const out: any = await tool.execute({});
    check('確定していれば、その注意は出さない', !/確定した額として答えないで/.test(out.guidance), out.guidance);
  }

  section('古さを黙らない');
  {
    const tool = createFinanceTools(store([{ month: '2026-08', total: -5000, count: 4 }]))[0];
    const out: any = await tool.execute({});
    check('最後の取り込みからの日数を出す', out.daysSinceLastImport === 20, out.daysSinceLastImport);
    check('今日までの額として答えるなと指示する', /今日までの額として答えないで/.test(out.guidance), out.guidance);
  }

  section('口座間の移動を支出に混ぜない');
  {
    /*
     * カードの引き落としは口座から出ていくが、**購入ではない。**足すと
     * 同じ買い物が二回数えられる。
     */
    const tool = createFinanceTools(
      store([
        { month: '2026-08', total: -5000, count: 4, kind: 'spending' },
        { month: '2026-08', total: -50000, count: 1, kind: 'transfer' },
      ])
    )[0];
    const out: any = await tool.execute({});
    check('支出だけを足す', out.months[0].spentYen === 5000, out.months[0]);
  }

  section('未分類を「その他」に化けさせない');
  {
    /*
     * 未分類は**分けた結果どれでもなかった**ものではなく、**分けられなかった**
     * もの。半分近くがそれなので、「その他」と呼び替えた瞬間に、分かって
     * いない額が分かっている顔をする。
     */
    const tool = createFinanceTools(
      store([
        { month: '2026-08', total: -3000, count: 5, category: '食費' },
        { month: '2026-08', total: -7000, count: 9, category: '未分類' },
      ])
    )[0];
    const out: any = await tool.execute({});
    check('箱ごとの額を返す', out.months[0].byCategory?.食費 === 3000, out.months[0].byCategory);
    check('未分類が一番大きくても畳まない', out.months[0].byCategory?.未分類 === 7000, out.months[0].byCategory);
    check('「その他」と言い換えるなと指示する', /その他.*ではありません/.test(out.guidance), out.guidance);
    check('按分するなと指示する', /按分/.test(out.guidance), out.guidance);
  }
  {
    const tool = createFinanceTools(
      store([{ month: '2026-08', total: -3000, count: 5, category: '食費' }])
    )[0];
    const out: any = await tool.execute({});
    check('未分類が無ければ、その注意は出さない', !/按分/.test(out.guidance), out.guidance);
  }

  section('読めなかったときに、無いと言わせない');
  {
    const broken = {
      aggregates: () => {
        throw new Error('database is locked');
      },
      imports: () => [],
    } as unknown as FinanceStore;
    const tool = createFinanceTools(broken)[0];
    const out: any = await tool.execute({});
    check('読めなかったことを返す', out.readable === false && out.error === true, out);
    check('「支出はありません」と言わせない', /とは答えないで/.test(out.guidance), out.guidance);
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`Finance tool: ${passed} passed, ${failed} failed`);
  if (failed) {
    console.log('\nFailures:');
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
  console.log('All finance tool tests passed.');
}

main();
