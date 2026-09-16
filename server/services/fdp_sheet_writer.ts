/**
 * Writes back to the spreadsheet, one field at a time.
 *
 * IRIS holds the ledger now. The sheet is downstream of it — but the sheet is
 * not idle: the daily digest reads it, two iPhone calendar subscriptions are
 * served from it, and `today.py` and `dashboard.py` read it. Those readers do
 * not know the ledger moved, and a store that stopped being updated does not
 * announce itself; it just quietly serves last week's answer every morning.
 *
 * So writes are mirrored until those readers are moved. One direction only:
 * IRIS to sheet, never back. Nothing here reads the sheet's values, so there is
 * no case where the two disagree and a rule is needed to pick a winner.
 *
 * A failed mirror is recorded rather than retried into a corner. The write
 * itself already succeeded in the store; what is lost is only the sheet being
 * current, and `/api/fdp/tasks` reports how many writes have not landed so the
 * staleness is visible instead of assumed absent.
 */

export interface SheetWriteResult {
  ok: boolean;
  error?: string;
  skipped?: string[];
}

export class FdpSheetWriter {
  constructor(
    private webAppUrl: string,
    private secret: string,
    private fetchImpl: typeof fetch = fetch,
    private timeoutMs = 20_000
  ) {}

  /**
   * Apps Script answers a POST with a 302 to a one-time URL that must be
   * fetched with GET. `fetch` does that conversion itself for a 302 after a
   * POST, which is why this can be a single call where the shell helper needed
   * two — `curl -X POST -L` forces POST on the second hop and breaks.
   */
  async update(
    taskId: string,
    updates: Record<string, string | number | null>
  ): Promise<SheetWriteResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.webAppUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          secret: this.secret,
          sheet: '課題台帳',
          id: taskId,
          // 自動判定 is a formula column and the script drops it. Nothing here
          // sends it; saying so out loud because sending it would blank the
          // ARRAYFORMULA for every row below.
          updates,
        }),
      });
      if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
      const body: any = await response.json().catch(() => null);
      if (!body) return { ok: false, error: '応答を解釈できませんでした。' };
      if (body.ok === false) return { ok: false, error: body.error ?? '不明なエラー' };
      const skipped = Object.keys(body.skipped ?? {});
      return { ok: true, ...(skipped.length > 0 ? { skipped } : {}) };
    } catch (err: any) {
      return { ok: false, error: err?.name === 'AbortError' ? 'タイムアウト' : (err?.message ?? String(err)) };
    } finally {
      clearTimeout(timer);
    }
  }
}
