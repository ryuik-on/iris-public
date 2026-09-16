import Database from 'better-sqlite3';

/**
 * The task ledger, held here rather than in the spreadsheet.
 *
 * The move was decided on one question: who updates it. A ledger a person
 * edits by hand can live in a sheet; one that sessions write to cannot, because
 * every session would need the Apps Script path and a Google authorisation that
 * expires weekly on this machine, to reach a store slower and less available
 * than the database already open next to it.
 *
 * Two things this keeps that the sheet could not:
 *
 *   Who wrote. 最終更新日 records that a task was touched and never by whom,
 *   which stops being good enough the moment something other than the person
 *   is writing.
 *
 *   What the row was before. Every field change is appended to
 *   `fdp_task_writes`, so a task that turns out to have been wrong can be
 *   traced rather than guessed at.
 */

export interface LedgerTask {
  id: string;
  title: string;
  field: string | null;
  priority: string | null;
  startDate: string | null;
  dueDate: string | null;
  status: string | null;
  progress: number | null;
  estimatedHours: number | null;
  actualHours: number | null;
  lastUpdated: string | null;
  doneCriteria: string | null;
  nextAction: string | null;
  osakaLink: string | null;
  bucket: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
}

/** Sheet column -> table column. The sheet's own headers, in one place. */
const COLUMNS: Array<{ sheet: string; column: string; numeric?: boolean }> = [
  { sheet: '課題名', column: 'title' },
  { sheet: '分野', column: 'field' },
  { sheet: '優先度', column: 'priority' },
  { sheet: '開始予定日', column: 'start_date' },
  { sheet: '期限', column: 'due_date' },
  { sheet: '状態', column: 'status' },
  { sheet: '進捗率', column: 'progress', numeric: true },
  { sheet: '想定時間(h)', column: 'estimated_hours', numeric: true },
  { sheet: '実績時間(h)', column: 'actual_hours', numeric: true },
  { sheet: '最終更新日', column: 'last_updated' },
  { sheet: '完了条件／成果物', column: 'done_criteria' },
  { sheet: '次の行動', column: 'next_action' },
  { sheet: '大阪大学実習への接続', column: 'osaka_link' },
  { sheet: '管理区分', column: 'bucket' },
];

/** Fields a caller may write, and the sheet column each mirrors back to. */
export const WRITABLE: Record<string, { column: string; sheet: string; numeric?: boolean }> = {
  status: { column: 'status', sheet: '状態' },
  progress: { column: 'progress', sheet: '進捗率', numeric: true },
  nextAction: { column: 'next_action', sheet: '次の行動' },
  actualHours: { column: 'actual_hours', sheet: '実績時間(h)', numeric: true },
  dueDate: { column: 'due_date', sheet: '期限' },
  startDate: { column: 'start_date', sheet: '開始予定日' },
};

function num(value: string | undefined): number | null {
  const text = (value ?? '').trim();
  if (text === '') return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function str(value: string | undefined): string | null {
  const text = (value ?? '').trim();
  return text === '' ? null : text;
}

const toTask = (r: any): LedgerTask => ({
  id: r.id,
  title: r.title,
  field: r.field,
  priority: r.priority,
  startDate: r.start_date,
  dueDate: r.due_date,
  status: r.status,
  progress: r.progress,
  estimatedHours: r.estimated_hours,
  actualHours: r.actual_hours,
  lastUpdated: r.last_updated,
  doneCriteria: r.done_criteria,
  nextAction: r.next_action,
  osakaLink: r.osaka_link,
  bucket: r.bucket,
  updatedBy: r.updated_by,
  updatedAt: r.updated_at,
});

/** A task as the verdict rule expects to read it — by the sheet's own headers. */
export function asSheetRow(t: LedgerTask): Record<string, string> {
  return {
    ID: t.id,
    課題名: t.title ?? '',
    分野: t.field ?? '',
    優先度: t.priority ?? '',
    開始予定日: t.startDate ?? '',
    期限: t.dueDate ?? '',
    状態: t.status ?? '',
    進捗率: t.progress === null ? '' : String(t.progress),
    '想定時間(h)': t.estimatedHours === null ? '' : String(t.estimatedHours),
    '実績時間(h)': t.actualHours === null ? '' : String(t.actualHours),
    最終更新日: t.lastUpdated ?? '',
    '完了条件／成果物': t.doneCriteria ?? '',
    次の行動: t.nextAction ?? '',
    大阪大学実習への接続: t.osakaLink ?? '',
    管理区分: t.bucket ?? '',
  };
}

export interface WriteRecord {
  taskId: string;
  field: string;
  sheetColumn: string;
  oldValue: string | null;
  newValue: string | null;
  writtenBy: string;
  writtenAt: string;
  rowId: number;
}

export class FdpLedgerStore {
  constructor(private db: Database.Database) {}

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM fdp_tasks').get() as any).n;
  }

  all(): LedgerTask[] {
    return (this.db.prepare('SELECT * FROM fdp_tasks').all() as any[]).map(toTask);
  }

  get(id: string): LedgerTask | null {
    const row = this.db.prepare('SELECT * FROM fdp_tasks WHERE id = ?').get(id) as any;
    return row ? toTask(row) : null;
  }

  /**
   * Bring rows in from the sheet.
   *
   * Import is a one-way copy and stays that way: it overwrites, so running it
   * after IRIS has become the writer would silently undo whatever IRIS wrote.
   * The endpoint that calls this refuses once the table is populated unless
   * asked twice, and this is why.
   */
  importFromSheet(rows: Record<string, string>[], now = new Date()): { imported: number; skipped: number } {
    let imported = 0;
    let skipped = 0;
    const at = now.toISOString();
    const insert = this.db.prepare(`
      INSERT INTO fdp_tasks (id, title, field, priority, start_date, due_date, status, progress,
        estimated_hours, actual_hours, last_updated, done_criteria, next_action, osaka_link,
        bucket, source_row_json, imported_at, updated_by, updated_at)
      VALUES (@id, @title, @field, @priority, @start_date, @due_date, @status, @progress,
        @estimated_hours, @actual_hours, @last_updated, @done_criteria, @next_action, @osaka_link,
        @bucket, @source_row_json, @imported_at, NULL, NULL)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title, field = excluded.field, priority = excluded.priority,
        start_date = excluded.start_date, due_date = excluded.due_date, status = excluded.status,
        progress = excluded.progress, estimated_hours = excluded.estimated_hours,
        actual_hours = excluded.actual_hours, last_updated = excluded.last_updated,
        done_criteria = excluded.done_criteria, next_action = excluded.next_action,
        osaka_link = excluded.osaka_link, bucket = excluded.bucket,
        source_row_json = excluded.source_row_json, imported_at = excluded.imported_at
    `);

    const tx = this.db.transaction((batch: Record<string, string>[]) => {
      for (const row of batch) {
        const id = (row['ID'] ?? '').trim();
        if (!id) { skipped++; continue; }
        const values: Record<string, any> = {
          id,
          source_row_json: JSON.stringify(row),
          imported_at: at,
        };
        for (const c of COLUMNS) {
          values[c.column] = c.numeric ? num(row[c.sheet]) : str(row[c.sheet]);
        }
        values.title = values.title ?? '(課題名なし)';
        insert.run(values);
        imported++;
      }
    });
    tx(rows);
    return { imported, skipped };
  }

  /**
   * Change one field, and say who did it.
   *
   * 最終更新日 moves on every write, because that is what the stalled rule
   * reads and a change nobody recorded as a change would leave a task looking
   * untouched. `writtenBy` is required for the same reason the hold requires
   * it: three sessions and a person write here.
   */
  update(
    id: string,
    field: string,
    value: string | number | null,
    writtenBy: string,
    now = new Date()
  ): WriteRecord {
    const spec = WRITABLE[field];
    if (!spec) throw new Error(`書き換えできない項目です: ${field}`);
    if (!writtenBy.trim()) throw new Error('書き込んだ主体が必要です。');
    const before = this.db.prepare(`SELECT ${spec.column} AS v FROM fdp_tasks WHERE id = ?`).get(id) as any;
    if (!before) throw new Error(`課題が見つかりません: ${id}`);

    const next = spec.numeric
      ? (value === null || value === '' ? null : Number(value))
      : (value === null ? null : String(value).trim() || null);
    if (spec.numeric && next !== null && !Number.isFinite(next as number)) {
      throw new Error(`数値で指定してください: ${field}`);
    }

    const stamp = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}`;
    const at = now.toISOString();

    const write = this.db.transaction(() => {
      this.db
        .prepare(`UPDATE fdp_tasks SET ${spec.column} = ?, last_updated = ?, updated_by = ?, updated_at = ? WHERE id = ?`)
        .run(next, stamp, writtenBy.trim(), at, id);
      const result = this.db
        .prepare(
          `INSERT INTO fdp_task_writes (task_id, field, old_value, new_value, written_by, written_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(id, field, before.v === null ? null : String(before.v), next === null ? null : String(next), writtenBy.trim(), at);
      return Number(result.lastInsertRowid);
    });
    const rowId = write();

    return {
      taskId: id,
      field,
      sheetColumn: spec.sheet,
      oldValue: before.v === null ? null : String(before.v),
      newValue: next === null ? null : String(next),
      writtenBy: writtenBy.trim(),
      writtenAt: at,
      rowId,
    };
  }

  /** Marks whether a write reached the sheet, and why not when it did not. */
  recordMirror(rowId: number, ok: boolean, error?: string): void {
    this.db
      .prepare('UPDATE fdp_task_writes SET mirrored_to_sheet = ?, mirror_error = ? WHERE id = ?')
      .run(ok ? 1 : 0, ok ? null : (error ?? 'unknown'), rowId);
  }

  /** Writes that never reached the sheet. The sheet's readers are stale by exactly these. */
  unmirrored(): Array<{ taskId: string; field: string; writtenAt: string; error: string | null }> {
    return this.db
      .prepare(
        `SELECT task_id AS taskId, field, written_at AS writtenAt, mirror_error AS error
           FROM fdp_task_writes WHERE mirrored_to_sheet = 0 ORDER BY written_at`
      )
      .all() as any[];
  }

  history(id: string, limit = 50) {
    return this.db
      .prepare(
        `SELECT field, old_value AS oldValue, new_value AS newValue, written_by AS writtenBy,
                written_at AS writtenAt, mirrored_to_sheet AS mirrored, mirror_error AS mirrorError
           FROM fdp_task_writes WHERE task_id = ? ORDER BY written_at DESC LIMIT ?`
      )
      .all(id, limit);
  }
}
