/**
 * Checks the register's claims against the repository.
 *
 * `register:drift` compares the register to its own seed — the register
 * against itself. That caught real problems and missed an obvious one:
 * project_topic_foundation sat at NOT_IMPLEMENTED all day while the code it
 * describes was written, tested and committed, because the seed said
 * NOT_IMPLEMENTED too. Two copies of the same wrong answer agree perfectly.
 *
 * So this one asks the repository instead. Two questions, both mechanical:
 *
 *   An entry claiming VERIFIED_PRESENT should have evidence, and the files it
 *   names should exist. Evidence pointing at a deleted file is the exact shape
 *   of the stale implementation reports this register was built to replace.
 *
 *   An entry claiming NOT_IMPLEMENTED should not have a file sitting where its
 *   name suggests. That check is a heuristic and says so — it produces
 *   suspicions to look at, not verdicts.
 *
 *   npm run register:verify
 */
import Database from 'better-sqlite3';
import { existsSync } from 'fs';
import { join } from 'path';

const ROOT = join(import.meta.dirname, '..');
const DB_PATH = process.env.IRIS_DB_PATH || join(ROOT, 'jarvis_memory.db');

/** Evidence lines are prose; only the ones naming a path can be checked. */
function pathsIn(evidence: string): string[] {
  const matches = evidence.match(/~?[\w./-]+\.(ts|tsx|swift|sh|json|md|sql|py)\b/g) ?? [];
  return matches.filter((p) => p.includes('/') || p.startsWith('scripts') || p.startsWith('server'));
}

/**
 * Resolves an evidence path.
 *
 * Not everything IRIS depends on lives in IRIS. The Founder Development
 * Program dashboard is real, runs every morning, and sits in another
 * directory entirely — and the first version of this check reported it as a
 * broken claim, which is the one failure mode that makes a verifier worse
 * than nothing: a false positive teaches the reader to skip the report.
 */
function resolveEvidence(path: string): string {
  if (path.startsWith('~/')) return join(process.env.HOME ?? '', path.slice(2));
  if (path.startsWith('/')) return path;
  return join(ROOT, path);
}

function main() {
  const db = new Database(DB_PATH, { readonly: true });
  try {
    const rows = db
      .prepare(`SELECT key, title, status, reality, evidence_json FROM future_features`)
      .all() as any[];

    const missingEvidence: string[] = [];
    const brokenPaths: Array<{ key: string; path: string }> = [];
    const suspicious: Array<{ key: string; found: string }> = [];

    for (const row of rows) {
      let evidence: string[] = [];
      try {
        const parsed = JSON.parse(row.evidence_json ?? '[]');
        if (Array.isArray(parsed)) evidence = parsed;
      } catch {
        /* a corrupt evidence list is itself a finding, handled below */
      }

      if (row.reality === 'VERIFIED_PRESENT') {
        if (evidence.length === 0) {
          // "It exists, trust me" is the claim this register exists to stop
          // anyone from making.
          missingEvidence.push(row.key);
          continue;
        }
        for (const line of evidence) {
          for (const path of pathsIn(line)) {
            if (!existsSync(resolveEvidence(path))) brokenPaths.push({ key: row.key, path });
          }
        }
      }

      if (row.reality === 'NOT_IMPLEMENTED') {
        // Heuristic: a register key usually echoes the file that implements it.
        const stem = row.key.replace(/_/g, '');
        const candidates = [
          `server/core/${row.key}.ts`,
          `server/services/${row.key}.ts`,
          `server/tools/${row.key}.ts`,
          `scripts/test-${row.key.replace(/_/g, '-')}.ts`,
        ];
        const found = candidates.find((c) => existsSync(join(ROOT, c)));
        if (found) suspicious.push({ key: row.key, found });
        void stem;
      }
    }

    console.log(`=== レジスタとリポジトリの照合 ===\n${rows.length} 件を確認\n`);

    let problems = 0;

    if (missingEvidence.length > 0) {
      problems += missingEvidence.length;
      console.log(`▸ 「実在する」と主張しているが根拠がない — ${missingEvidence.length} 件`);
      for (const k of missingEvidence) console.log(`  ${k}`);
      console.log();
    }

    if (brokenPaths.length > 0) {
      problems += brokenPaths.length;
      console.log(`▸ 根拠として挙げたファイルが存在しない — ${brokenPaths.length} 件`);
      for (const b of brokenPaths) console.log(`  ${b.key.padEnd(32)} ${b.path}`);
      console.log();
    }

    if (suspicious.length > 0) {
      console.log(`▸ 「未実装」だがそれらしいファイルがある — ${suspicious.length} 件（推測です）`);
      for (const s of suspicious) console.log(`  ${s.key.padEnd(32)} ${s.found}`);
      console.log();
    }

    if (problems === 0 && suspicious.length === 0) {
      console.log('レジスタの主張はリポジトリと矛盾していません。');
      return;
    }

    // Suspicions are not failures: the heuristic guesses at filenames and will
    // be wrong. Only contradicted claims gate anything.
    process.exitCode = problems > 0 ? 1 : 0;
  } finally {
    db.close();
  }
}

main();
