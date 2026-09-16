import type Database from 'better-sqlite3';

/**
 * 利用者が画面から決めた設定の置き場。
 *
 * **環境変数は既定であって、決定ではない。**`.env` は起動時の出発点で、
 * ここに値があればそちらが勝つ。無ければ環境変数、それも無ければ組み込みの
 * 既定 —— 三段になるが、**どの段から来た値かを言えるようにしてある**
 * （`source`）。画面に「既定のまま」と「自分で選んだ」の区別が出ないと、
 * 変えたつもりで変わっていない状態に気づけない。
 */
export class PreferenceStore {
  constructor(private db: Database.Database) {}

  get(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM preferences WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  set(key: string, value: string, now = new Date()): void {
    this.db
      .prepare(
        `INSERT INTO preferences (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(key, value, now.toISOString());
  }

  /** 選んだものを取り消して、既定へ戻す。**空文字を入れて「無い」を表さない。** */
  clear(key: string): void {
    this.db.prepare('DELETE FROM preferences WHERE key = ?').run(key);
  }
}
