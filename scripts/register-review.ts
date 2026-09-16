/**
 * The periodic look at what was put off.
 *
 * Deferring something is a decision with an expiry date nobody writes down.
 * Two different things make a deferral stale, and they are reported apart
 * because they call for opposite responses:
 *
 *   Its blocker is gone — everything it was waiting on is now COMPLETED, so
 *   the reason it was deferred no longer holds. That is a prompt to start.
 *
 *   Nobody has looked at it — time has passed with no review. That is a
 *   prompt to ask whether it still makes sense at all, which is usually the
 *   more valuable question and always the less comfortable one.
 *
 *   npm run register:review
 */
import 'dotenv/config';
import Database from 'better-sqlite3';
import { join } from 'path';
import { SqliteFutureFeatureStore } from '../server/services/future_features_sqlite.js';
import { FutureFeatureService } from '../server/core/future_features_service.js';
import { SqliteActivityLogStore } from '../server/services/activity_log_sqlite.js';

const DB_PATH = process.env.IRIS_DB_PATH || join(import.meta.dirname, '..', 'jarvis_memory.db');
const MAX_AGE_DAYS = Number(process.env.IRIS_REVIEW_MAX_AGE_DAYS ?? 90);

function main() {
  const db = new Database(DB_PATH, { readonly: true });
  try {
    const register = new FutureFeatureService(
      new SqliteFutureFeatureStore(db),
      new SqliteActivityLogStore(db)
    );

    const unblocked = register.unblockedDeferrals();
    const stale = register.dueForReview(MAX_AGE_DAYS);

    console.log('=== 保留の見直し ===\n');

    if (unblocked.length === 0) {
      console.log('▸ 待っていたものが片付いた項目: なし\n');
    } else {
      console.log(`▸ 待っていたものが片付いた項目 — ${unblocked.length} 件（着手できます）\n`);
      for (const f of unblocked) {
        console.log(`  ${f.key}`);
        console.log(`    ${f.title}`);
        console.log(`    依存はすべて完了: ${f.dependencies.join(', ')}`);
        if (f.resumeCondition) console.log(`    再開条件: ${f.resumeCondition}`);
        console.log();
      }
    }

    if (stale.length === 0) {
      console.log(`▸ ${MAX_AGE_DAYS}日以上見直されていない項目: なし`);
    } else {
      console.log(`▸ ${MAX_AGE_DAYS}日以上見直されていない項目 — ${stale.length} 件`);
      // The useful question here is rarely "shall we start it" but "is this
      // still something we want at all".
      console.log('  （着手すべきかではなく、まだ必要かを問うための一覧です）\n');
      for (const f of stale.slice(0, 20)) {
        console.log(`  ${f.status.padEnd(12)} ${f.key.padEnd(32)} ${f.lastReviewedAt ?? '未レビュー'}`);
      }
      if (stale.length > 20) console.log(`  … ほか ${stale.length - 20} 件`);
    }

    console.log('\n見直したら記録してください:');
    console.log('  curl -X POST localhost:3002/api/register/<key>/reviewed \\');
    console.log("    -H 'content-type: application/json' -d '{\"note\":\"まだ必要\"}'");
  } finally {
    db.close();
  }
}

main();
