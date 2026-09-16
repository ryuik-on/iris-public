/**
 * 案内の不備で推論に落ちた記憶を、計測として置き直す。
 *
 * 2026-09-07 に数えたところ、記憶 116 件のうち 88 件が `inferred` だった。
 * 中を見ると、出所に「2026-08-23 実測（agy models を実際に叩いた）」
 * 「simulator/results/…json」と書かれたものが並んでいる —— **測ったものが
 * 推論として残っている。**
 *
 * 原因は `admit()` ではなく、**書き方の案内**だった。ブリーフィングの
 * `writeBack` も CLAUDE.md の例も `evidence` を含まない形を配っており、
 * `admit()` は根拠を指せない `measured` を推論へ落とす。**案内どおりに
 * 書く限り、実測しても必ず格下げされる。**規則の方は正しいので、案内を直し、
 * 既に落ちたものをここで置き直す。
 *
 * ---
 *
 * **置き直す条件は「出所が辿れる形をしていること」だけ。**ファイル名、
 * コマンド、URL。それを `evidence` に移す —— もともと `evidence` に入る
 * べきものが `source` に書かれていた、というのがこの取りこぼしの正体。
 *
 * 「2026-08-23 実測」としか書かれていないものは**動かさない。**実測だと
 * 書いてあることは、実測の根拠にならない。辿れないものを計測に格上げする
 * のは、この仕組みが防いでいる間違いそのもの。
 *
 * **確度は 0.7 のまま。**元の呼び出しが何を申告したかは残っていないので、
 * 0.95 へ上げるのは作り話になる。直すのは種別だけ。
 *
 * 消さずに `superseded_by` で繋ぐ。**間違って残っていたこと自体が記録。**
 */

import path from 'node:path';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { admit } from '../server/core/memory.js';

/** 出所が辿れる形か。ファイル・コマンド・URL のいずれかを名指ししている。 */
const TRACEABLE = /(\/|\.ts\b|\.md\b|\.json\b|\.py\b|\.csv\b|\.txt\b|curl |npx |git |gh |grep|pgrep|https?:\/\/|\bexec\b|--help)/;

const dry = !process.argv.includes('--write');
/*
 * サーバと同じ一冊。`~/.iris/iris.db` ではない —— そちらには memories が無い。
 * サーバは cwd の `jarvis_memory.db` を開いており（server/index.ts:138）、
 * 起動用スクリプトの cwd がこのリポジトリなのでここに在る。
 */
const db = new Database(path.join(process.cwd(), 'jarvis_memory.db'));

const rows = db
  .prepare(`SELECT * FROM memories WHERE provenance = 'inferred' AND superseded_by IS NULL`)
  .all() as any[];

const insert = db.prepare(
  `INSERT INTO memories (id, kind, content, provenance, source, confidence, retention,
     expires_at, privacy, evidence_json, topic_ref, created_at, superseded_by)
   VALUES (@id, @kind, @content, @provenance, @source, @confidence, @retention,
     @expires_at, @privacy, @evidence_json, @topic_ref, @created_at, NULL)`
);
const link = db.prepare(`UPDATE memories SET superseded_by = ? WHERE id = ? AND superseded_by IS NULL`);

let moved = 0;
let left = 0;
const run = db.transaction(() => {
  for (const row of rows) {
    const source: string = row.source ?? '';
    if (!TRACEABLE.test(source)) { left++; continue; }

    // 既に evidence があるなら、格下げの理由は別にある。触らない。
    const existing: string[] = JSON.parse(row.evidence_json || '[]');
    if (existing.length) { left++; continue; }

    const verdict = admit({
      kind: row.kind,
      content: row.content,
      provenance: 'measured',
      source,
      confidence: row.confidence,
      retention: row.retention,
      expiresAt: row.expires_at ?? undefined,
      privacy: row.privacy,
      evidence: [source],
    } as any);

    // 規則を迂回しない。admit が通さないものは置き直さない。
    if (!verdict.admit || verdict.adjusted?.provenance !== 'measured') { left++; continue; }

    const id = randomUUID();
    console.log(`  ${row.created_at.slice(0, 10)}  ${source.slice(0, 70)}`);
    if (!dry) {
      insert.run({
        id,
        kind: row.kind,
        content: row.content,
        provenance: 'measured',
        source,
        confidence: row.confidence,
        retention: row.retention,
        expires_at: row.expires_at,
        privacy: row.privacy,
        evidence_json: JSON.stringify([source]),
        topic_ref: row.topic_ref,
        created_at: row.created_at,
      });
      link.run(id, row.id);
    }
    moved++;
  }
});
run();

console.log('');
console.log(`推論のまま残っていたもの : ${rows.length} 件`);
console.log(`計測へ置き直す           : ${moved} 件`);
console.log(`出所が辿れないので据置き : ${left} 件`);
if (dry) console.log('\n（下見のみ。書き込むには --write）');
