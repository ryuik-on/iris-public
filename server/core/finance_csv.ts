/**
 * Reading a bank's CSV without guessing what its columns mean.
 *
 * Japanese financial institutions do not agree on anything here: column
 * names, column order, the encoding (Shift_JIS is still common), whether a
 * withdrawal is a negative number or its own column, whether the date is
 * `2026/08/20` or `20260820` or `令和8年8月20日`. A parser that sniffs its way
 * through that will succeed on the file it was written against and silently
 * mis-read the next one — and the failure mode is money in the wrong month or
 * the wrong sign, which looks like a spending pattern rather than a bug.
 *
 * So nothing is inferred. A format is described explicitly, files are matched
 * against known descriptors by their header row, and a file that matches none
 * is refused with its header quoted back. Refusing is cheap; a silently
 * mis-parsed year of spending is not.
 *
 * The descriptors here are deliberately few. Adding one is a small, checkable
 * piece of work done against a real file from that institution — which is the
 * only way to know what its columns actually mean.
 */

export interface ColumnMap {
  date: string;
  description: string;
  /** A single signed column, when the institution uses one. */
  amount?: string;
  /** Separate columns, when it uses those. Withdrawal is stored negative. */
  withdrawal?: string;
  deposit?: string;
}

export interface CsvFormat {
  id: string;
  label: string;
  /** Every one of these must be present in the header for the format to match. */
  requiredHeaders: string[];
  columns: ColumnMap;
  /** How the date column is written. */
  dateStyle: 'slash' | 'dash' | 'compact';
  /**
   * What a positive number in the amount column means.
   *
   * `signed` — the file already carries the sign, so a purchase is negative.
   * `expense_positive` — the column is "amount spent", written positive. Card
   *   statements do this: ご利用金額 30000 is thirty thousand yen leaving.
   *
   * Stated per format rather than inferred. Taking a card statement as signed
   * turns every purchase into income — the totals stay plausible, the sign is
   * wrong everywhere, and it reads as a very good month. Found on 2026-08-20
   * by importing a real-shaped file, with every unit test green: the card test
   * checked the description and never looked at the sign.
   */
  amountSign?: 'signed' | 'expense_positive';
  encoding: 'utf-8' | 'shift_jis' | 'euc-jp';
}

/**
 * Known formats.
 *
 * Generic ones only, and named as such. A descriptor claiming to be "MUFG" on
 * the strength of a guess would be worse than one that admits it is a shape
 * rather than an institution.
 */
export const FORMATS: CsvFormat[] = [
  {
    id: 'generic_jp_bank',
    label: '日本の銀行（日付・お引出し・お預入れ）',
    requiredHeaders: ['日付', 'お引出し', 'お預入れ'],
    columns: { date: '日付', description: '摘要', withdrawal: 'お引出し', deposit: 'お預入れ' },
    dateStyle: 'slash',
    encoding: 'shift_jis',
  },
  {
    id: 'generic_jp_card',
    label: '日本のクレジットカード（ご利用日・ご利用金額）',
    requiredHeaders: ['ご利用日', 'ご利用金額'],
    columns: { date: 'ご利用日', description: 'ご利用先', amount: 'ご利用金額' },
    dateStyle: 'slash',
    amountSign: 'expense_positive',
    encoding: 'shift_jis',
  },
  {
    id: 'generic_utf8_signed',
    label: '汎用（date, description, amount / UTF-8）',
    requiredHeaders: ['date', 'description', 'amount'],
    columns: { date: 'date', description: 'description', amount: 'amount' },
    dateStyle: 'dash',
    encoding: 'utf-8',
  },
];

export interface ParsedTransaction {
  occurredOn: string;
  /** Negative for money leaving. Minor units. */
  amount: number;
  description: string;
}

export interface ParseResult {
  ok: boolean;
  format?: CsvFormat;
  transactions: ParsedTransaction[];
  /** Rows that could not be read, with the reason and the line number. */
  skipped: Array<{ line: number; reason: string }>;
  reason?: string;
}

/** Splits one CSV line, honouring quotes. Descriptions contain commas. */
export function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cell += '"'; i++; }
        else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { cells.push(cell); cell = ''; }
    else cell += ch;
  }
  cells.push(cell);
  return cells.map((c) => c.trim());
}

/** Decodes bytes with the format's encoding. */
export function decode(bytes: Uint8Array, encoding: CsvFormat['encoding']): string {
  return new TextDecoder(encoding).decode(bytes).replace(/^﻿/, '');
}

/**
 * Which known format a header row belongs to.
 *
 * Returns null rather than a best guess. "Probably a bank statement" is not a
 * basis for deciding which column is money.
 */
export function detectFormat(header: string[], formats: CsvFormat[] = FORMATS): CsvFormat | null {
  return (
    formats.find((f) => f.requiredHeaders.every((h) => header.includes(h))) ?? null
  );
}

/** `2026/8/20`, `2026-08-20`, `20260820` → `2026-08-20`. */
export function parseDate(raw: string, style: CsvFormat['dateStyle']): string | null {
  const value = raw.trim();
  if (!value) return null;

  let y: number, m: number, d: number;
  if (style === 'compact') {
    const match = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
    if (!match) return null;
    [, y, m, d] = match.map(Number) as any;
  } else {
    const separator = style === 'slash' ? '/' : '-';
    const parts = value.split(separator);
    if (parts.length !== 3) return null;
    [y, m, d] = parts.map((p) => Number(p));
  }
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  // Rejected rather than rolled over: 2026-02-30 becoming March is a
  // transaction moved to a month it did not happen in.
  const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const check = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(check.getTime()) || check.getUTCDate() !== d) return null;
  return iso;
}

/** `¥1,234`, `1,234`, `-1234`, `1234円` → 1234. Empty is null, not zero. */
export function parseAmount(raw: string): number | null {
  const value = raw.replace(/[¥,円\s]/g, '').replace(/[０-９．－]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) - 0xfee0)
  );
  if (!value) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  // Yen has no minor units, and a fractional amount means the column was not
  // what it was taken for.
  if (!Number.isInteger(n)) return null;
  return n;
}

export function parseCsv(text: string, formats: CsvFormat[] = FORMATS): ParseResult {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { ok: false, transactions: [], skipped: [], reason: '空のファイルです。' };

  const header = splitCsvLine(lines[0]);
  const format = detectFormat(header, formats);
  if (!format) {
    // The header is quoted back so adding a descriptor is a small, concrete
    // piece of work rather than an investigation.
    return {
      ok: false,
      transactions: [],
      skipped: [],
      reason: `対応していない形式です。見出し: ${header.join(' | ')}`,
    };
  }

  const index = (name: string) => header.indexOf(name);
  const dateAt = index(format.columns.date);
  const descAt = index(format.columns.description);
  const amountAt = format.columns.amount ? index(format.columns.amount) : -1;
  const outAt = format.columns.withdrawal ? index(format.columns.withdrawal) : -1;
  const inAt = format.columns.deposit ? index(format.columns.deposit) : -1;

  const transactions: ParsedTransaction[] = [];
  const skipped: Array<{ line: number; reason: string }> = [];

  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    const occurredOn = parseDate(cells[dateAt] ?? '', format.dateStyle);
    if (!occurredOn) {
      skipped.push({ line: i + 1, reason: `日付を読めません: ${cells[dateAt] ?? ''}` });
      continue;
    }

    let amount: number | null = null;
    if (amountAt >= 0) {
      const raw = parseAmount(cells[amountAt] ?? '');
      if (raw === null) amount = null;
      else if (format.amountSign === 'expense_positive') {
        // A refund is written negative in these files, so the flip has to be
        // a negation rather than "force negative".
        amount = -raw;
      } else amount = raw;
    } else {
      const out = parseAmount(cells[outAt] ?? '');
      const inn = parseAmount(cells[inAt] ?? '');
      if (out !== null && inn !== null) {
        // Both filled is a row this parser does not understand, and guessing
        // which one counts would be inventing a transaction.
        skipped.push({ line: i + 1, reason: '入金と出金の両方に値があります。' });
        continue;
      }
      if (out !== null) amount = -Math.abs(out);
      else if (inn !== null) amount = Math.abs(inn);
    }
    if (amount === null) {
      skipped.push({ line: i + 1, reason: '金額を読めません。' });
      continue;
    }

    const description = (cells[descAt] ?? '').trim();
    transactions.push({ occurredOn, amount, description });
  }

  return { ok: true, format, transactions, skipped };
}

/** `2026-08-20` → `2026-08`. */
export function monthOf(isoDate: string): string {
  return isoDate.slice(0, 7);
}

/**
 * The day a line item stops being kept.
 *
 * Computed at import rather than applied by a sweep that reads a constant,
 * so the retention promise is written into the row and cannot be changed
 * retroactively by editing a setting.
 */
export function expiryFor(importedAt: Date, months = 13): string {
  const expiry = new Date(importedAt);
  expiry.setMonth(expiry.getMonth() + months);
  return expiry.toISOString();
}
