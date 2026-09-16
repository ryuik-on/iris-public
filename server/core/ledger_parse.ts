/**
 * Reading the MED-AI Builder Lab ledger.
 *
 * The ledger is Markdown, and it is somebody else's canonical record — IRIS
 * reads it and never writes it. `Repository_Operations.md` is explicit that
 * the OS Repository's Markdown is "唯一の正" for Projects, Decisions and
 * approved specifications, and that chat and verbal instruction are not
 * settled specification until they reach it. A second copy of that state
 * inside IRIS would be a second authority, so what lives here is a reader and
 * a derived view, both discarded and rebuilt on each read.
 *
 * The parsing is deliberately literal. A tolerant parser that skips rows it
 * cannot understand turns a malformed table into a shorter one, and a shorter
 * task list reads as progress. Rows that do not fit the header are counted and
 * reported rather than dropped in silence.
 */

/** One row, keyed by the column headings above it. */
export type Row = Record<string, string>;

export interface TableRead {
  rows: Row[];
  /** Column headings, in order, as they appeared. */
  columns: string[];
  /**
   * Rows whose cell count did not match the header.
   *
   * Reported rather than skipped. A table that lost a column to a stray pipe
   * still parses into something plausible, and the only signal that it did is
   * this number.
   */
  malformed: number;
}

const EMPTY: TableRead = { rows: [], columns: [], malformed: 0 };

/** True for `| --- | :--- | ---: |` and nothing else. */
function isSeparator(line: string): boolean {
  return /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(line) && line.includes('-');
}

function splitCells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  // A pipe inside a cell is escaped in Markdown; split on the unescaped ones.
  return trimmed
    .split(/(?<!\\)\|/)
    .map((cell) => cell.replace(/\\\|/g, '|').trim());
}

/**
 * The first table under a heading that contains `heading`, or the first table
 * in the document when `heading` is null.
 *
 * Keyed on the heading rather than on position because these documents grow —
 * `Active_Projects.md` gained a "管理対象外" section above its tables, and a
 * parser that took the first table would have started reading the wrong one
 * without changing shape.
 */
export function readTable(markdown: string, heading: string | null): TableRead {
  const lines = markdown.split('\n');

  let start = 0;
  if (heading) {
    const at = lines.findIndex((line) => /^#{1,6}\s/.test(line) && line.includes(heading));
    if (at < 0) return EMPTY;
    start = at + 1;
  }

  for (let i = start; i < lines.length; i++) {
    // Stop at the next heading: a table under a different section is not this
    // section's table, and reading on would silently answer the wrong question.
    if (heading && /^#{1,6}\s/.test(lines[i]) && !lines[i].includes(heading)) break;
    if (!lines[i].trim().startsWith('|')) continue;
    if (i + 1 >= lines.length || !isSeparator(lines[i + 1])) continue;

    const columns = splitCells(lines[i]);
    const rows: Row[] = [];
    let malformed = 0;

    for (let j = i + 2; j < lines.length; j++) {
      const line = lines[j];
      if (!line.trim().startsWith('|')) break;
      const cells = splitCells(line);
      if (cells.length !== columns.length) {
        malformed++;
        continue;
      }
      const row: Row = {};
      columns.forEach((column, k) => {
        row[column] = cells[k];
      });
      rows.push(row);
    }

    return { rows, columns, malformed };
  }

  return EMPTY;
}

/**
 * The text of a Markdown link, or the value unchanged.
 *
 * Ledger cells carry links — `[LAB-001 Recall Lab](../01_Labs/...)` — and the
 * identifier is the visible half.
 */
export function plain(value: string | undefined): string {
  if (!value) return '';
  return value
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`/g, '')
    .replace(/\*\*/g, '')
    .trim();
}

/** The leading `PRJ-001` / `TSK-010` / `DEC-019` style identifier, if there is one. */
export function identifier(value: string | undefined): string | null {
  const match = plain(value).match(/^([A-Z]{2,4}-\d+)/);
  return match ? match[1] : null;
}

export type TaskStatus = 'Todo' | 'In Progress' | 'Blocked' | 'Done' | 'Unknown';

/**
 * The status, matched exactly against the four the ledger defines.
 *
 * `Repository_Operations.md` §6.3 fixes the vocabulary. Anything else is
 * `Unknown` rather than guessed into the nearest one: a status that was
 * mistyped should show as unreadable, not silently become `Done`.
 */
export function taskStatus(value: string | undefined): TaskStatus {
  const text = plain(value);
  if (text === 'Todo' || text === 'In Progress' || text === 'Blocked' || text === 'Done') {
    return text;
  }
  return 'Unknown';
}

export interface Progress {
  total: number;
  done: number;
  blocked: number;
  inProgress: number;
  todo: number;
  /** Rows whose status was not one of the four. Never folded into the others. */
  unknown: number;
}

export function summarise(statuses: TaskStatus[]): Progress {
  const count = (want: TaskStatus) => statuses.filter((s) => s === want).length;
  return {
    total: statuses.length,
    done: count('Done'),
    blocked: count('Blocked'),
    inProgress: count('In Progress'),
    todo: count('Todo'),
    unknown: count('Unknown'),
  };
}
