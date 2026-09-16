import { Tool, RiskLevel, ToolTrust } from '../core/types.js';
import { FinanceStore } from '../services/finance_sqlite.js';

/**
 * 家計について答えるための道具。**集計だけ。**
 *
 * この機能はもともと二つに分けて作ってある — 月ごとの集計と、一件ずつの
 * 取引。後者には `privacy: 'local_only'` の印が付き、模型にも人にも渡さないと
 * 決めてある。**分けた意味は、渡してよい側を実際に渡せること**なのに、
 * これまで渡す口が無かった。ここがその口。
 *
 * 個別の取引は**この道具からは絶対に出ない。**「何を買ったか」は答えられず、
 * 「いくら使ったか」だけ答えられる。それは制限ではなく、この機能の形。
 *
 * 未確定であることを毎回言う。いまの行はすべてカードの通知メールから
 * 取ったもので、明細と突き合わせていない。合計を確定した額として答えると、
 * 後で明細が来たときに「増えた」ように見える — 実際には最初から分かって
 * いなかっただけ。**分かっていないことを、分かっている顔で答えない。**
 */
export function createFinanceTools(finance: FinanceStore): Tool[] {
  return [
    {
      name: 'get_spending_summary',
      description:
        '家計の月ごとの支出合計を読みます。「今月いくら使った」「先月と比べて」' +
        'などに答えるときに使います。' +
        '**個別の取引（何をどこで買ったか）は返りません。**' +
        '集計だけを扱う道具で、明細は設計上この道具から出ません。',
      riskLevel: RiskLevel.READ,
      trust: ToolTrust.TRUSTED_CORE,
      schema: {
        type: 'object',
        properties: {
          from: { type: 'string', description: '開始月。`2026-06` の形。省略可。' },
          to: { type: 'string', description: '終了月。`2026-08` の形。省略可。' },
        },
      },
      async execute(args: any) {
        let rows;
        try {
          rows = finance.aggregates({ from: args?.from, to: args?.to });
        } catch (err: any) {
          return {
            error: true,
            readable: false,
            message: err?.message ?? String(err),
            guidance:
              '家計の台帳を読めませんでした。「支出はありません」とは答えないでください。' +
              '読めなかったことを伝えてください。',
          };
        }

        if (rows.length === 0) {
          return {
            readable: true,
            months: [],
            guidance:
              'その期間に取り込まれた記録がありません。**使っていない**のではなく、' +
              '**取り込まれていない**という意味です。そう伝えてください。',
          };
        }

        /*
         * 支出だけを足す。口座間の移動を混ぜると、カードの引き落としが
         * 購入と二重に数えられる。
         */
        const byMonth = new Map<
          string,
          { total: number; count: number; pending: number; categories: Map<string, number> }
        >();
        for (const row of rows) {
          if (row.kind !== 'spending') continue;
          const at =
            byMonth.get(row.month) ?? { total: 0, count: 0, pending: 0, categories: new Map<string, number>() };
          at.total += row.total;
          at.count += row.count;
          if (row.status === 'pending') at.pending += row.count;
          /*
           * 箱の名前は集計の一部なので渡してよい。渡せないのは一件ずつの
           * 取引の方。**「食費に3万」は集計、「どこで何を」は取引。**
           */
          const name = row.category || '未分類';
          at.categories.set(name, (at.categories.get(name) ?? 0) + Math.abs(row.total));
          byMonth.set(row.month, at);
        }

        const months = [...byMonth.entries()]
          .sort((a, b) => b[0].localeCompare(a[0]))
          .map(([month, at]) => ({
            month,
            spentYen: Math.abs(at.total),
            count: at.count,
            unconfirmed: at.pending,
            byCategory: Object.fromEntries(
              [...at.categories].sort((a, b) => b[1] - a[1])
            ),
            unclassifiedYen: at.categories.get('未分類') ?? 0,
          }));

        const anyPending = months.some((m) => m.unconfirmed > 0);
        const last = finance.imports(1)[0] ?? null;
        const staleDays = last
          ? Math.floor((Date.now() - Date.parse(last.importedAt)) / 86_400_000)
          : null;

        return {
          readable: true,
          months,
          lastImportedAt: last?.importedAt ?? null,
          daysSinceLastImport: staleDays,
          detailAvailable: false,
          guidance:
            [
              '金額は円。個別の取引は含みません — この道具は集計しか扱わないので、' +
                '「何を買ったか」を聞かれたら、答えられないことと理由を伝えてください。',
              anyPending
                ? '`unconfirmed` の件数は、カードの通知メールから取っただけで明細と' +
                  '突き合わせていないものです。**確定した額として答えないでください。**'
                : null,
              months.some((m) => m.unclassifiedYen > 0)
                ? '`未分類` は「その他」ではありません。**店名が届いていないか、' +
                  '分類の規則に無い店**という意味です。その額を他の箱に按分したり、' +
                  '「その他の支出」と言い換えたりしないでください。' +
                  '割合を答えるときは、未分類がどれだけあるかも一緒に伝えてください。'
                : null,
              staleDays !== null && staleDays >= 3
                ? `最後の取り込みは ${staleDays}日前です。それ以降の買い物は入っていません。` +
                  '合計を今日までの額として答えないでください。'
                : null,
            ]
              .filter(Boolean)
              .join(' '),
        };
      },
    },
  ];
}
