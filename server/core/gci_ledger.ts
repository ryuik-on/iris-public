import { readFileSync } from 'node:fs';

/**
 * GCI の論点表を読む。
 *
 * `docs/gci-programming-progress-ledger.csv`（Codex の「GCI 復習」セッションが
 * 2026-09-11 に作った）。一行が一論点で、`status` に 確認済み／要再確認／
 * 学習中／未着手 のどれかが入る。
 *
 * T011 の進捗率は「確認済み ÷ 論点数」と決めた（課題台帳の完了条件に明記）。
 * ここは**その数え方だけ**を持つ。台帳に書くのは呼び出し側。
 *
 * 読めないもの（列が無い、status が知らない値）は数えずに `unknown` に入れ、
 * 進捗率の分母からは外さない —— 分からない論点を「確認済み」にも「未着手」にも
 * しない。
 */
export interface GciLedger {
  topics: number;
  confirmed: number;
  review: number;
  learning: number;
  untouched: number;
  unknown: number;
  /** 確認済み ÷ 論点数。論点が 0 なら null。 */
  progress: number | null;
}

const STATUS: Record<string, keyof Omit<GciLedger, 'topics' | 'progress'>> = {
  確認済み: 'confirmed',
  要再確認: 'review',
  学習中: 'learning',
  未着手: 'untouched',
};

export function parseGciLedger(csv: string): GciLedger {
  const rows = parseCsv(csv);
  const header = rows[0] ?? [];
  const statusAt = header.indexOf('status');
  const out: GciLedger = { topics: 0, confirmed: 0, review: 0, learning: 0, untouched: 0, unknown: 0, progress: null };
  if (statusAt < 0) return out;
  for (const row of rows.slice(1)) {
    if (row.every((c) => c.trim() === '')) continue;
    out.topics++;
    const key = STATUS[(row[statusAt] ?? '').trim()];
    if (key) out[key]++;
    else out.unknown++;
  }
  out.progress = out.topics > 0 ? Math.round((out.confirmed / out.topics) * 100) / 100 : null;
  return out;
}

export function readGciLedger(path: string): GciLedger {
  return parseGciLedger(readFileSync(path, 'utf-8'));
}

/** 引用符と、引用符の中のコンマ・改行に耐える最小の CSV 読み。 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
