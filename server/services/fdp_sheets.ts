/**
 * Reads the Founder Development Program's source-of-truth spreadsheet.
 *
 * Via gviz CSV export rather than the Sheets API, which is what the existing
 * dashboard does and which needs no credentials at all — so this works today
 * rather than after an OAuth consent screen.
 *
 * Read-only. Nothing here writes to a source; the spreadsheet is the canon and
 * IRIS is a reader of it.
 */

export interface SheetRow {
  [column: string]: string;
}

export interface SheetResult {
  tab: string;
  rows: SheetRow[];
  /** False when the tab could not be read — distinct from an empty tab. */
  ok: boolean;
  error?: string;
}

const GVIZ = 'https://docs.google.com/spreadsheets/d';

export class FdpSheets {
  constructor(
    private sheetId: string,
    private fetchImpl: typeof fetch = fetch,
    private timeoutMs = 15_000
  ) {}

  /**
   * Fetches one tab.
   *
   * `requireColumn` is not optional in spirit. gviz answers a request for a
   * tab that does not exist by returning the *first* tab, with a 200 and no
   * indication anything is wrong — so a typo silently yields a different
   * sheet's contents, correctly parsed, and every judgement built on it is
   * about the wrong data. The guard is a column that only the intended tab
   * has. Carried over verbatim from the existing dashboard, which documents
   * having been caught by it.
   */
  async fetchTab(tab: string, requireColumn: string): Promise<SheetResult> {
    const url =
      `${GVIZ}/${encodeURIComponent(this.sheetId)}/gviz/tq` +
      `?tqx=out:csv&sheet=${encodeURIComponent(tab)}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, { signal: controller.signal });
      if (!response.ok) {
        return { tab, rows: [], ok: false, error: `HTTP ${response.status}` };
      }
      const rows = parseCsv(await response.text());
      if (rows.length > 0 && !(requireColumn in rows[0])) {
        return {
          tab,
          rows: [],
          ok: false,
          error:
            `「${tab}」タブに列「${requireColumn}」がありません。` +
            'gviz は存在しないタブ名に対して最初のタブを返すため、別タブを掴んでいる可能性があります。',
        };
      }
      return { tab, rows, ok: true };
    } catch (err: any) {
      return { tab, rows: [], ok: false, error: err?.message ?? String(err) };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Parses the CSV gviz returns.
 *
 * Hand-rolled rather than pulled in, because the shape is narrow and known:
 * a header row, quoted fields, doubled quotes for literals. What it does need
 * to handle is a newline inside a quoted cell — notes fields have them, and
 * splitting on newlines first would tear a row in half.
 */
export function parseCsv(text: string): SheetRow[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.trim());
  return rows
    .slice(1)
    // A trailing blank line would otherwise become a row of empty strings.
    .filter((cells) => cells.some((c) => c.trim() !== ''))
    .map((cells) => {
      const record: SheetRow = {};
      header.forEach((name, index) => {
        record[name] = (cells[index] ?? '').trim();
      });
      return record;
    });
}
