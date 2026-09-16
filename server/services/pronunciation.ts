import Database from 'better-sqlite3';

/**
 * Reading corrections applied before text reaches a voice.
 *
 * Heard in practice: Chirp 3 HD read 平滑筋 as へいかつ*すじ* rather than
 * へいかつ*きん*. That is not a defect in one vendor's model — Japanese
 * compounds have readings that depend on the domain, and 筋 is すじ in ordinary
 * speech and きん in anatomy. Every engine will get some of these wrong, and a
 * different engine will get a different set wrong.
 *
 * So the fix belongs above all of them. Substituting kana for the term is
 * engine-independent, needs no SSML support (Chirp 3 HD's is limited), and is
 * the one mechanism that survives changing providers.
 *
 * Only what is spoken changes. The text on screen and in the conversation is
 * untouched — a transcript that reads へいかつきん instead of 平滑筋 would have
 * traded one wrong output for another.
 */

export interface Pronunciation {
  term: string;
  reading: string;
  note: string | null;
  source: 'seed' | 'user';
}

/**
 * The shipped list.
 *
 * Deliberately short, and limited to readings worth being confident about.
 * A dictionary that guesses is worse than none: a wrong entry is applied
 * silently and consistently, which is exactly how a mistake stops being
 * noticed. Anything uncertain belongs in a user entry, added by someone who
 * heard the problem.
 */
export const SEED_PRONUNCIATIONS: Array<{ term: string; reading: string; note: string }> = [
  // Heard wrong on 2026-08-19: read as へいかつすじ.
  { term: '平滑筋', reading: 'へいかつきん', note: '筋 は解剖用語では「きん」。「すじ」と読まれた実績あり。' },
  { term: '骨格筋', reading: 'こっかくきん', note: '同上。' },
  { term: '心筋', reading: 'しんきん', note: '同上。' },
  { term: '横紋筋', reading: 'おうもんきん', note: '同上。' },
  // 弛 is ち in 弛張 but し here; a common misreading even among people.
  { term: '弛緩', reading: 'しかん', note: '「ちかん」と読まれやすい。' },
  { term: '手指', reading: 'しゅし', note: '医療文脈では「しゅし」。「てゆび」と読まれやすい。' },
  { term: '振戦', reading: 'しんせん', note: '' },
  { term: '喘息', reading: 'ぜんそく', note: '' },
  { term: '受容体', reading: 'じゅようたい', note: '' },
  { term: '頻脈', reading: 'ひんみゃく', note: '' },
  { term: '徐脈', reading: 'じょみゃく', note: '' },
  { term: '内服', reading: 'ないふく', note: '' },
  { term: '頓服', reading: 'とんぷく', note: '' },
];

export class PronunciationStore {
  constructor(private db: Database.Database) {}

  /** Idempotent, and never overwrites a correction someone made by ear. */
  seed(): { inserted: number } {
    const now = new Date().toISOString();
    const insert = this.db.prepare(
      `INSERT INTO pronunciations (term, reading, note, source, created_at, updated_at)
       VALUES (?, ?, ?, 'seed', ?, ?)
       ON CONFLICT(term) DO NOTHING`
    );
    let inserted = 0;
    for (const entry of SEED_PRONUNCIATIONS) {
      inserted += insert.run(entry.term, entry.reading, entry.note || null, now, now).changes;
    }
    return { inserted };
  }

  list(): Pronunciation[] {
    return this.db
      .prepare(`SELECT term, reading, note, source FROM pronunciations ORDER BY length(term) DESC, term`)
      .all() as Pronunciation[];
  }

  /**
   * Adds or corrects an entry. Marked `user`, which outranks the shipped list
   * — they heard it and we did not.
   */
  set(term: string, reading: string, note?: string | null): Pronunciation {
    const trimmedTerm = term?.trim();
    const trimmedReading = reading?.trim();
    if (!trimmedTerm) throw new Error('term は必須です。');
    if (!trimmedReading) throw new Error('reading は必須です。');
    // A reading identical to the term would substitute nothing and look like
    // it had been fixed.
    if (trimmedTerm === trimmedReading) {
      throw new Error('reading が term と同じです。読み（かな）を指定してください。');
    }

    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO pronunciations (term, reading, note, source, created_at, updated_at)
         VALUES (?, ?, ?, 'user', ?, ?)
         ON CONFLICT(term) DO UPDATE SET
           reading = excluded.reading,
           note = excluded.note,
           source = 'user',
           updated_at = excluded.updated_at`
      )
      .run(trimmedTerm, trimmedReading, note ?? null, now, now);

    return this.db
      .prepare(`SELECT term, reading, note, source FROM pronunciations WHERE term = ?`)
      .get(trimmedTerm) as Pronunciation;
  }

  remove(term: string): boolean {
    return this.db.prepare(`DELETE FROM pronunciations WHERE term = ?`).run(term).changes > 0;
  }
}

export interface AppliedPronunciation {
  term: string;
  reading: string;
  count: number;
}

/**
 * Rewrites text for speech.
 *
 * Longest term first, so 平滑筋 is matched whole rather than having 平滑 or 筋
 * replaced inside it — the shorter entry would otherwise produce a compound
 * nobody can read.
 */
export function applyPronunciations(
  text: string,
  dictionary: Array<{ term: string; reading: string }>
): { text: string; applied: AppliedPronunciation[] } {
  if (!text) return { text, applied: [] };

  const ordered = [...dictionary].sort((a, b) => b.term.length - a.term.length);
  const applied: AppliedPronunciation[] = [];
  let out = text;

  for (const { term, reading } of ordered) {
    if (!term) continue;
    // Already-substituted kana must not be matched again by a shorter entry,
    // so each pass works on the result of the last and counts what it changed.
    const parts = out.split(term);
    const count = parts.length - 1;
    if (count === 0) continue;
    out = parts.join(reading);
    applied.push({ term, reading, count });
  }

  return { text: out, applied };
}
