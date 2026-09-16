import Database from 'better-sqlite3';
import { markLocalOnly } from '../core/privacy.js';
import { randomUUID } from 'crypto';
import { ParsedTransaction, monthOf, expiryFor } from '../core/finance_csv.js';
import { reconcile } from '../core/finance_reconcile.js';

/**
 * Money, stored under two different rules at once.
 *
 * The user decided on 2026-08-20: individual transactions never leave the
 * machine and expire after 13 months; monthly totals by category may go into
 * a prompt and are kept. That is not a preference about tidiness — a line item
 * says where a person was and when, and a category total does not.
 *
 * The split is enforced here rather than trusted to callers. `recall`-style
 * boundaries that depend on every future call site remembering them are
 * boundaries that have already been crossed somewhere, and this store has two
 * shapes of read for exactly that reason: `aggregates()` returns what may be
 * shared, `transactions()` returns what may not, and only the second is
 * spelled in a way that makes a caller state what it is doing.
 */

export interface StoredTransaction {
  id: string;
  importId: string;
  account: string;
  occurredOn: string;
  amount: number;
  description: string;
  category: string | null;
  kind: TransactionKind;
  status: TransactionStatus;
  source: string;
  expiresAt: string;
}

export type TransactionKind = 'spending' | 'income' | 'transfer';
export type TransactionStatus = 'confirmed' | 'pending' | 'superseded';

export interface MonthlyTotal {
  month: string;
  kind: TransactionKind;
  status: TransactionStatus;
  category: string;
  total: number;
  count: number;
}

export interface TransferRule {
  id: string;
  description: string;
  account: string | null;
  note: string | null;
  createdAt: string;
}

export interface ImportResult {
  importId: string;
  inserted: number;
  duplicates: number;
  months: string[];
}

export class FinanceStore {
  constructor(private db: Database.Database) {}

  /**
   * Records an import.
   *
   * Aggregates are recomputed from what is actually stored rather than added
   * incrementally, so a re-imported file cannot double a month's total — the
   * unique index drops the duplicate rows, and a running sum would not notice.
   */
  import(
    input: {
      fileName: string;
      format: string;
      account: string;
      transactions: ParsedTransaction[];
      skipped: number;
      /** `pending` for a notification, `confirmed` for a statement. */
      status?: TransactionStatus;
      source?: string;
      /** 箱に入れられないものは `null`。**推測で入れない。** */
      categorize?: (t: ParsedTransaction) => string | null;
    },
    now = new Date(),
    retentionMonths = 13
  ): ImportResult {
    const importId = randomUUID().slice(0, 8);
    const importedAt = now.toISOString();
    const expiresAt = expiryFor(now, retentionMonths);

    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO finance_transactions
         (id, import_id, account, occurred_on, amount, description, category, imported_at, expires_at, occurrence, kind, status, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    let inserted = 0;
    const months = new Set<string>();

    /**
     * Position among otherwise-identical rows in this file.
     *
     * Identity cannot be (date, amount, description) alone: two coffees at the
     * same shop on the same day for the same price are two purchases, and
     * deduping on those fields drops the second one silently. Counting
     * occurrences within the file means a re-import matches row for row, while
     * a genuine repeat gets its own slot — and a later export covering a
     * longer period adds only what is actually new.
     */
    const seen = new Map<string, number>();

    const tx = this.db.transaction(() => {
      for (const t of input.transactions) {
        const category = input.categorize ? input.categorize(t) : null;
        const key = `${t.occurredOn}\u0000${t.amount}\u0000${t.description}`;
        const occurrence = seen.get(key) ?? 0;
        seen.set(key, occurrence + 1);
        const result = insert.run(
          randomUUID().slice(0, 12),
          importId,
          input.account,
          t.occurredOn,
          t.amount,
          t.description,
          category,
          importedAt,
          expiresAt,
          occurrence,
          this.kindFor(t.description, input.account, t.amount),
          input.status ?? 'confirmed',
          input.source ?? 'csv'
        );
        if (result.changes > 0) inserted++;
        months.add(monthOf(t.occurredOn));
      }
      this.db
        .prepare(
          `INSERT INTO finance_imports (id, file_name, format, rows, skipped, imported_at, note)
           VALUES (?, ?, ?, ?, ?, ?, NULL)`
        )
        .run(importId, input.fileName, input.format, input.transactions.length, input.skipped, importedAt);
    });
    tx();

    for (const month of months) this.recomputeMonth(month, now);

    return { importId, inserted, duplicates: input.transactions.length - inserted, months: [...months].sort() };
  }

  /**
   * What a transaction is, which is not decided by its sign alone.
   *
   * A card bill leaving the bank looks exactly like spending — same sign,
   * same shape — and counting it as such doubles the month when the card's
   * own statement is imported too. So a description that matches a rule the
   * user wrote is a transfer, and nothing else is.
   *
   * Exact match, never a pattern. A rule like /カード/ would also catch a
   * purchase at a shop with カード in its name, and the money would vanish
   * from the total rather than merely being misfiled. Unmatched stays
   * spending, so a missing rule overstates the total — the direction that
   * gets noticed.
   */
  kindFor(description: string, account: string, amount: number): TransactionKind {
    const rule = this.db
      .prepare(
        `SELECT id FROM finance_transfer_rules
          WHERE description = ? AND (account IS NULL OR account = ?) LIMIT 1`
      )
      .get(description, account);
    if (rule) return 'transfer';
    return amount >= 0 ? 'income' : 'spending';
  }

  addTransferRule(input: { description: string; account?: string | null; note?: string | null }, now = new Date()): { rule: TransferRule | null; reason: string } {
    const description = input.description?.trim();
    if (!description) return { rule: null, reason: '摘要が空です。' };

    const rule: TransferRule = {
      id: randomUUID().slice(0, 8),
      description,
      account: input.account?.trim() || null,
      note: input.note?.trim() || null,
      createdAt: now.toISOString(),
    };
    try {
      this.db
        .prepare(
          `INSERT INTO finance_transfer_rules (id, description, account, note, created_at) VALUES (?, ?, ?, ?, ?)`
        )
        .run(rule.id, rule.description, rule.account, rule.note, rule.createdAt);
    } catch {
      return { rule: null, reason: '同じ摘要の規則が既にあります。' };
    }
    return { rule, reason: '記録しました。既存の取引にも適用します。' };
  }

  transferRules(): TransferRule[] {
    const rows = this.db.prepare(`SELECT * FROM finance_transfer_rules ORDER BY created_at DESC`).all() as any[];
    return rows.map((r) => ({
      id: r.id,
      description: r.description,
      account: r.account,
      note: r.note,
      createdAt: r.created_at,
    }));
  }

  removeTransferRule(id: string): boolean {
    return this.db.prepare(`DELETE FROM finance_transfer_rules WHERE id = ?`).run(id).changes > 0;
  }

  /**
   * Applies the current rules to everything already stored.
   *
   * A rule added after an import must fix the months it was added because of,
   * or the correction only applies to money not yet spent — which is the one
   * period nobody is asking about.
   */
  reclassify(now = new Date()): { changed: number; months: string[] } {
    const rows = this.db
      .prepare(`SELECT id, account, description, amount, kind, substr(occurred_on, 1, 7) AS month FROM finance_transactions`)
      .all() as Array<{ id: string; account: string; description: string; amount: number; kind: TransactionKind; month: string }>;

    const update = this.db.prepare(`UPDATE finance_transactions SET kind = ? WHERE id = ?`);
    const months = new Set<string>();
    let changed = 0;

    const tx = this.db.transaction(() => {
      for (const row of rows) {
        const kind = this.kindFor(row.description, row.account, row.amount);
        if (kind !== row.kind) {
          update.run(kind, row.id);
          months.add(row.month);
          changed++;
        }
      }
    });
    tx();

    for (const month of months) this.recomputeMonth(month, now);
    return { changed, months: [...months].sort() };
  }

  /**
   * 取り込み済みの行を分け直す。
   *
   * 規則を足したときに、**過去の行だけ古い規則のまま**という状態を作らない
   * ため。分類は行の中身ではなく規則の側にあるので、規則が変われば答えも
   * 変わるべきで、変わらない方が事故になる。
   *
   * `null` に戻すこともする。規則から店を外したのに箱に残り続けると、
   * **外したはずの判断が生き続ける。**
   */
  recategorise(categorise: (description: string) => string | null, now = new Date()): { changed: number; months: string[] } {
    const rows = this.db
      .prepare(`SELECT id, description, category, substr(occurred_on, 1, 7) AS month FROM finance_transactions`)
      .all() as Array<{ id: string; description: string; category: string | null; month: string }>;

    const update = this.db.prepare(`UPDATE finance_transactions SET category = ? WHERE id = ?`);
    const months = new Set<string>();
    let changed = 0;

    const tx = this.db.transaction(() => {
      for (const row of rows) {
        const category = categorise(row.description);
        if (category !== row.category) {
          update.run(category, row.id);
          months.add(row.month);
          changed++;
        }
      }
    });
    tx();

    for (const month of months) this.recomputeMonth(month, now);
    return { changed, months: [...months].sort() };
  }

  /**
   * Rebuilds one month's totals from the line items.
   *
   * Kept even after the line items expire: the aggregate is the thing that
   * outlives them, so it is written as its own row rather than derived on
   * demand from data that will be gone.
   */
  recomputeMonth(month: string, now = new Date()): void {
    const rows = this.db
      .prepare(
        `SELECT kind, status, COALESCE(category, '未分類') AS category, SUM(amount) AS total, COUNT(*) AS count
           FROM finance_transactions
          WHERE occurred_on LIKE ? AND status != 'superseded'
          GROUP BY kind, status, COALESCE(category, '未分類')`
      )
      .all(`${month}-%`) as Array<{ kind: TransactionKind; status: TransactionStatus; category: string; total: number; count: number }>;

    const insert = this.db.prepare(
      `INSERT INTO finance_monthly (month, kind, status, category, total, count, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const at = now.toISOString();

    // Replaced, not upserted.
    //
    // An upsert only touches categories that still have rows, so a category
    // whose last transaction was removed keeps its old total forever — and an
    // undone import leaves a month reporting spending that exists nowhere.
    // Caught by a test on 2026-08-20 that removed an import and then asked the
    // month what it thought.
    const replace = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM finance_monthly WHERE month = ?`).run(month);
      for (const row of rows) insert.run(month, row.kind, row.status, row.category, row.total, row.count, at);
    });
    replace();
  }

  /**
   * Retires pending rows that a statement has now confirmed.
   *
   * The pending row is kept and marked, not deleted: "when did IRIS first know
   * about this" is a question the running total depends on being able to
   * answer, and a deleted row answers nothing.
   *
   * Ambiguous cases are left pending on purpose. Two identical amounts a day
   * apart are indistinguishable from here, and picking one would erase a
   * purchase silently — the register's `finance_reconciliation` says to
   * measure against real data rather than tune against invented examples, so
   * this reports what it could not decide instead of deciding it.
   */
  reconcilePending(options: { windowDays?: number } = {}, now = new Date()) {
    const rows = this.db
      .prepare(
        `SELECT id, account, occurred_on, amount, description, status, substr(occurred_on, 1, 7) AS month
           FROM finance_transactions WHERE status IN ('pending', 'confirmed')`
      )
      .all() as Array<{ id: string; account: string; occurred_on: string; amount: number; description: string; status: TransactionStatus; month: string }>;

    const asCandidate = (r: (typeof rows)[number]) => ({
      id: r.id,
      account: r.account,
      occurredOn: r.occurred_on,
      amount: r.amount,
      description: r.description,
    });

    const result = reconcile(
      rows.filter((r) => r.status === 'pending').map(asCandidate),
      rows.filter((r) => r.status === 'confirmed').map(asCandidate),
      options
    );

    const byId = new Map(rows.map((r) => [r.id, r]));
    const months = new Set<string>();
    const update = this.db.prepare(
      `UPDATE finance_transactions SET status = 'superseded', superseded_by = ? WHERE id = ?`
    );
    const tx = this.db.transaction(() => {
      for (const pair of result.matched) {
        update.run(pair.confirmed, pair.pending);
        const month = byId.get(pair.pending)?.month;
        if (month) months.add(month);
      }
    });
    tx();

    for (const month of months) this.recomputeMonth(month, now);
    return { ...result, months: [...months].sort() };
  }

  /**
   * Monthly totals. This is the half that may be shared.
   *
   * Survives the expiry of the line items it was computed from, which is the
   * point of storing it separately.
   */
  aggregates(options: { from?: string; to?: string } = {}): MonthlyTotal[] {
    const from = options.from ?? '0000-00';
    const to = options.to ?? '9999-99';
    return this.db
      .prepare(
        `SELECT month, kind, status, category, total, count FROM finance_monthly
          WHERE month >= ? AND month <= ? ORDER BY month DESC, kind ASC, category ASC`
      )
      .all(from, to) as MonthlyTotal[];
  }

  /**
   * Individual transactions. This half must not leave the machine.
   *
   * Named for what it returns rather than something neutral like `list`, so a
   * call site that ships it to a provider reads wrong at a glance.
   */
  transactionsLocalOnly(options: { month?: string; limit?: number } = {}): StoredTransaction[] {
    const rows = this.db
      .prepare(
        `SELECT id, import_id, account, occurred_on, amount, description, category, kind, status, source, expires_at
           FROM finance_transactions
          WHERE (? IS NULL OR occurred_on LIKE ?)
          ORDER BY occurred_on DESC LIMIT ?`
      )
      .all(
        options.month ?? null,
        options.month ? `${options.month}-%` : '%',
        Math.min(options.limit ?? 200, 1000)
      ) as any[];
    /**
     * Every row carries its own classification.
     *
     * The marker used to live on the wrapper the HTTP layer put around this
     * array, which means the first caller to return the array on its own loses
     * it — and the guard that reads it would then see nothing to object to.
     * Stamped here, it travels with the value wherever the value goes.
     */
    return markLocalOnly(
      rows.map((r) => ({
        id: r.id,
        importId: r.import_id,
        account: r.account,
        occurredOn: r.occurred_on,
        amount: r.amount,
        description: r.description,
        category: r.category,
        kind: r.kind,
        status: r.status,
        source: r.source,
        expiresAt: r.expires_at,
      }))
    ) as StoredTransaction[];
  }

  /**
   * Deletes line items past their expiry. Aggregates are untouched.
   *
   * The promise is 13 months of line items, not 13 months of knowing nothing
   * afterwards — so this is what makes both halves of that true.
   */
  prune(now = new Date()): { deleted: number } {
    const result = this.db
      .prepare(`DELETE FROM finance_transactions WHERE expires_at <= ?`)
      .run(now.toISOString());
    return { deleted: result.changes };
  }

  /** Undoes one import whole, for a file that turned out to be wrong. */
  removeImport(importId: string, now = new Date()): { deleted: number } {
    const months = (
      this.db
        .prepare(`SELECT DISTINCT substr(occurred_on, 1, 7) AS month FROM finance_transactions WHERE import_id = ?`)
        .all(importId) as Array<{ month: string }>
    ).map((r) => r.month);

    const deleted = this.db.prepare(`DELETE FROM finance_transactions WHERE import_id = ?`).run(importId).changes;
    this.db.prepare(`DELETE FROM finance_imports WHERE id = ?`).run(importId);
    for (const month of months) this.recomputeMonth(month, now);
    return { deleted };
  }

  imports(limit = 20): Array<{ id: string; fileName: string; format: string; rows: number; skipped: number; importedAt: string }> {
    const rows = this.db
      .prepare(`SELECT * FROM finance_imports ORDER BY imported_at DESC LIMIT ?`)
      .all(Math.max(1, limit)) as any[];
    return rows.map((r) => ({
      id: r.id,
      fileName: r.file_name,
      format: r.format,
      rows: r.rows,
      skipped: r.skipped,
      importedAt: r.imported_at,
    }));
  }
}
