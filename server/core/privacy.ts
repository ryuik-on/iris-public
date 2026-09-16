/**
 * The boundary that keeps local-only data out of a prompt.
 *
 * `finance_local_boundary` has been policy since the finance work started and
 * enforcement has been a sentence in a JSON response: "個別の取引は端末外に
 * 出しません。プロンプトに含めないでください。" That is a note addressed to
 * whoever reads it, and the thing that must not read it is a model.
 *
 * Today the boundary holds because no tool the model can call returns
 * transactions. That is holding by absence, and it ends the moment someone
 * adds one — silently, because nothing would object.
 *
 * So the check is here, at the point where a tool result crosses into the
 * conversation, rather than at the point where the data is fetched. Same shape
 * as recall_memory, which enforces `shareableOnly` when recalling rather than
 * trusting its callers to ask correctly: the guarantee has to sit where the
 * crossing happens, or it is advice.
 *
 * Data carries its own classification. A wrapper saying `privacy:
 * 'local_only'` around an array is a label on the packaging, and the first
 * tool to return the array without the wrapper loses it. Each row is stamped
 * at the store, so the marker travels with the value.
 */

/** The one value that means "this must not leave the machine". */
export const LOCAL_ONLY = 'local_only';

/**
 * How many values in here are marked local-only.
 *
 * Counted rather than answered yes or no, because the count is what the model
 * is told: "there were 34 of these and you cannot see them" is a fact it can
 * reason about and repeat, and it is the difference between an answer that is
 * shorter than it should be and one that says why.
 */
export function countLocalOnly(value: unknown, depth = 0): number {
  // Deep enough for any tool result, and bounded so a cyclic structure cannot
  // hang the run it is protecting.
  if (depth > 12 || value === null || typeof value !== 'object') return 0;

  if (Array.isArray(value)) {
    let total = 0;
    for (const item of value) total += countLocalOnly(item, depth + 1);
    return total;
  }

  const record = value as Record<string, unknown>;
  if (record.privacy === LOCAL_ONLY) return 1;

  let total = 0;
  for (const key of Object.keys(record)) total += countLocalOnly(record[key], depth + 1);
  return total;
}

export interface Withheld {
  status: 'withheld';
  privacy: typeof LOCAL_ONLY;
  /** How many marked values were removed. */
  withheld: number;
  guidance: string;
}

/**
 * What the model gets instead.
 *
 * Not an error and not silence. An error invites a retry, and silence gets
 * summarised as "no transactions", which is a false statement about the
 * user's money. This says the data exists, that it cannot be seen, and what
 * can be asked for instead.
 */
export function withhold(count: number): Withheld {
  return {
    status: 'withheld',
    privacy: LOCAL_ONLY,
    withheld: count,
    guidance:
      `この結果には端末外に出せない項目が ${count} 件含まれていたため、内容は渡されていません。` +
      '個別の取引・明細はモデルに渡さない方針です（finance_local_boundary）。' +
      '月次の集計を返すツールがあればそちらを使い、無ければ「手元で確認してください」と答えてください。',
  };
}

/**
 * Marks every element of a list as local-only.
 *
 * Applied where the data is read out of storage, so the classification is a
 * property of the value rather than of whoever happened to wrap it.
 */
export function markLocalOnly<T extends Record<string, unknown>>(rows: T[]): Array<T & { privacy: string }> {
  return rows.map((row) => ({ ...row, privacy: LOCAL_ONLY }));
}
