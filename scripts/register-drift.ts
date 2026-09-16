/**
 * Reports where the live register disagrees with the seed.
 *
 * This exists because the drift is structural, not accidental. Seeding
 * deliberately refuses to move a `status` that has already been changed — a
 * code default must not overwrite a human decision — which is correct, and
 * which also means every status correction written into the seed silently
 * fails to reach a database that already has the row. Twice now the register
 * has claimed work was pending that had been finished hours earlier, and both
 * times it was found by a person reading a table.
 *
 * So the drift is surfaced rather than prevented: the seed is the intent, the
 * database is the record, and a gap between them is a fact worth seeing
 * rather than a bug to paper over. Some gaps are legitimate — a status moved
 * through the API on purpose — which is exactly why this reports instead of
 * reconciling.
 *
 *   npm run register:drift          # report
 *   npm run register:drift -- --fix # apply the seed's status to the database
 */
import Database from 'better-sqlite3';
import { join } from 'path';
import { FUTURE_FEATURE_SEED } from '../server/data/future_features_seed.js';

const DB_PATH = process.env.IRIS_DB_PATH || join(import.meta.dirname, '..', 'jarvis_memory.db');
const FIX = process.argv.includes('--fix');

interface Drift {
  key: string;
  field: 'status' | 'verification' | 'reality';
  live: string;
  seed: string;
}

function main() {
  const db = new Database(DB_PATH, { readonly: !FIX });
  try {
    const rows = db.prepare('SELECT key, status, verification, reality FROM future_features').all() as any[];
    const live = new Map(rows.map((r) => [r.key, r]));

    const drift: Drift[] = [];
    const missing: string[] = [];

    for (const seed of FUTURE_FEATURE_SEED) {
      const row = live.get(seed.key);
      if (!row) {
        missing.push(seed.key);
        continue;
      }
      const compare = (field: Drift['field'], seedValue?: string) => {
        if (seedValue && seedValue !== row[field]) {
          drift.push({ key: seed.key, field, live: row[field], seed: seedValue });
        }
      };
      compare('status', seed.status);
      compare('verification', seed.verification);
      compare('reality', seed.reality);
    }

    // Rows with no seed entry: created through the API and never written back
    // to source. Not drift, but the register cannot be rebuilt without them.
    const seedKeys = new Set(FUTURE_FEATURE_SEED.map((f) => f.key));
    const unseeded = rows.filter((r) => !seedKeys.has(r.key)).map((r) => r.key);

    console.log(`seed ${FUTURE_FEATURE_SEED.length} 件 / DB ${rows.length} 件\n`);

    if (drift.length === 0 && missing.length === 0 && unseeded.length === 0) {
      console.log('乖離なし。レジスタはソースと一致しています。');
      return;
    }

    if (drift.length > 0) {
      console.log(`▸ 乖離 ${drift.length} 件（DB の値 ← seed の値）`);
      for (const d of drift) {
        console.log(`  ${d.key.padEnd(34)} ${d.field.padEnd(13)} ${d.live}  ←  ${d.seed}`);
      }
      console.log();
    }

    if (missing.length > 0) {
      console.log(`▸ seed にあって DB にない ${missing.length} 件（起動時のシードで入ります）`);
      for (const k of missing) console.log(`  ${k}`);
      console.log();
    }

    if (unseeded.length > 0) {
      // The register is supposed to be reproducible from the repository. A row
      // that exists only here has the same problem as the reports it replaced.
      console.log(`▸ DB にあって seed にない ${unseeded.length} 件（ソースから再現できません）`);
      for (const k of unseeded) console.log(`  ${k}`);
      console.log();
    }

    if (!FIX) {
      console.log('--fix を付けると seed の値を DB に反映します。');
      console.log('意図してAPIで変えた項目まで戻すので、上の一覧を確認してから実行してください。');
      // Non-zero so this can gate a release without anyone remembering to read
      // the output.
      process.exitCode = drift.length > 0 ? 1 : 0;
      return;
    }

    const update = db.prepare('UPDATE future_features SET status = ?, verification = ?, reality = ? WHERE key = ?');
    let applied = 0;
    for (const seed of FUTURE_FEATURE_SEED) {
      const row = live.get(seed.key);
      if (!row) continue;
      const next = {
        status: seed.status ?? row.status,
        verification: seed.verification ?? row.verification,
        reality: seed.reality ?? row.reality,
      };
      if (next.status === row.status && next.verification === row.verification && next.reality === row.reality) continue;
      update.run(next.status, next.verification, next.reality, seed.key);
      applied++;
    }
    console.log(`${applied} 件を seed の値に揃えました。`);
  } finally {
    db.close();
  }
}

main();
