import {
  SqliteFutureFeatureStore,
  FutureFeature,
  FutureFeatureInput,
  FeatureStatus,
  FeatureNotFoundError,
  ImmutableFeatureError,
  NON_ACTIONABLE_STATUSES,
  IMMUTABLE_STATUSES,
} from '../services/future_features_sqlite.js';
import { SqliteActivityLogStore } from '../services/activity_log_sqlite.js';
import { DevelopmentService } from './development_service.js';
import { FUTURE_FEATURE_SEED } from '../data/future_features_seed.js';

export class NonActionableFeatureError extends Error {
  constructor(public readonly key: string, public readonly status: FeatureStatus) {
    super(
      `"${key}" は ${status} です。作業タスクには変換できません。` +
        (status === 'EXPLICIT_DECISION_REQUIRED'
          ? 'まずユーザーが明示的に採用を決定してください。'
          : 'これは安全境界の記録であり、実装対象ではありません。')
    );
    this.name = 'NonActionableFeatureError';
  }
}

/**
 * The register of what IRIS intends, defers, and refuses.
 *
 * Its reason for existing is that this knowledge previously lived only in chat
 * history and in the user's memory (§30). It answers "what is deferred, and
 * why" without anyone re-reading a handoff.
 *
 * It is also a safety surface: PROHIBITED and OUT_OF_SCOPE entries cannot be
 * moved or turned into work through this service. Implementing ordinary
 * autonomy features must never quietly dissolve a boundary (§27).
 */
export class FutureFeatureService {
  constructor(
    private store: SqliteFutureFeatureStore,
    private activity: SqliteActivityLogStore,
    private development?: DevelopmentService
  ) {}

  /** Idempotent. Safe to run on every boot. */
  seedFromHandoffs(): { inserted: number; updated: number; skipped: number } {
    const result = this.store.seed(FUTURE_FEATURE_SEED);
    if (result.inserted > 0) {
      this.activity.info('register.seeded', {
        message: `${result.inserted} 件の将来機能を登録`,
        detail: result,
      });
    }
    return result;
  }

  get(key: string): FutureFeature {
    const feature = this.store.getByKey(key);
    if (!feature) throw new FeatureNotFoundError(key);
    return feature;
  }

  list(options: { status?: FeatureStatus; domain?: string; priority?: any } = {}) {
    return this.store.list(options);
  }

  search(query: string) {
    return this.store.search(query);
  }

  counts() {
    return this.store.counts();
  }

  /** Everything that records a hard boundary, for a single honest answer. */
  boundaries(): FutureFeature[] {
    return this.store
      .list()
      .filter((f) => NON_ACTIONABLE_STATUSES.includes(f.status))
      .sort((a, b) => a.status.localeCompare(b.status) || a.title.localeCompare(b.title));
  }

  create(input: FutureFeatureInput): FutureFeature {
    const feature = this.store.create(input);
    this.activity.info('register.entry_created', {
      message: feature.title,
      detail: { key: feature.key, status: feature.status },
    });
    return feature;
  }

  update(key: string, patch: Partial<FutureFeatureInput>): FutureFeature {
    const before = this.get(key);
    const feature = this.store.update(key, patch);
    if (patch.status && patch.status !== before.status) {
      this.activity.info('register.status_changed', {
        message: `${feature.title}: ${before.status} → ${feature.status}`,
        detail: { key, from: before.status, to: feature.status, reason: feature.reason },
      });
    }
    return feature;
  }

  markReviewed(key: string, note?: string): FutureFeature {
    const feature = this.store.markReviewed(key, note);
    this.activity.info('register.reviewed', { message: feature.title, detail: { key } });
    return feature;
  }

  /**
   * Entries whose review is overdue (§31).
   *
   * The point is to stop good ideas being forgotten without letting the backlog
   * grow forever — so this surfaces things to reconsider, and never implements
   * anything on its own.
   */
  dueForReview(maxAgeDays = 90, now = Date.now()) {
    return this.store.dueForReview(maxAgeDays, now);
  }

  /**
   * Deferred work whose reason for waiting may have expired.
   *
   * A deferral does not go stale because time passed — it goes stale when the
   * thing it was waiting for happens. Almost every DEFERRED entry here names
   * its dependencies, so that moment is checkable rather than a matter of
   * someone remembering: when everything it waited on is COMPLETED, the
   * resume condition is at least plausibly met.
   *
   * Reported separately from the merely old, because the two call for
   * different actions. "Its blocker is gone" is a prompt to start; "nobody
   * has looked at this in a year" is a prompt to ask whether it still makes
   * sense at all.
   */
  unblockedDeferrals(): Array<{
    key: string;
    title: string;
    resumeCondition: string | null;
    dependencies: string[];
  }> {
    const all = this.store.list({});
    const status = new Map(all.map((f) => [f.key, f.status]));

    return all
      .filter((f) => f.status === 'DEFERRED' || f.status === 'BLOCKED')
      // An entry with no dependencies waits on something this register cannot
      // see, so its state here says nothing either way.
      .filter((f) => f.dependencies.length > 0)
      .filter((f) => f.dependencies.every((d) => status.get(d) === 'COMPLETED'))
      .map((f) => ({
        key: f.key,
        title: f.title,
        resumeCondition: f.resumeCondition,
        dependencies: f.dependencies,
      }));
  }

  /**
   * Turns a register entry into an actual development task.
   *
   * This is the one place the register touches active work, so it is where the
   * boundary is enforced: a prohibited, out-of-scope, rejected, or
   * decision-pending entry is refused outright.
   */
  async promoteToTask(key: string, options: { successCriteria?: string[] } = {}) {
    if (!this.development) throw new Error('DevelopmentService が設定されていません。');

    const feature = this.get(key);
    if (NON_ACTIONABLE_STATUSES.includes(feature.status)) {
      this.activity.warn('register.promotion_refused', {
        message: feature.title,
        detail: { key, status: feature.status },
      });
      throw new NonActionableFeatureError(key, feature.status);
    }

    const successCriteria =
      options.successCriteria && options.successCriteria.length > 0
        ? options.successCriteria
        : buildDefaultCriteria(feature);

    const task = await this.development.createTask({
      title: feature.title,
      goal: feature.reason,
      successCriteria,
      constraints: [
        ...(feature.risk ? [`リスク: ${feature.risk}`] : []),
        `出典: ${feature.source}`,
      ],
      decisions: feature.resumeCondition ? [`再開条件: ${feature.resumeCondition}`] : [],
    });

    this.store.update(key, { status: 'CURRENT' });
    this.activity.info('register.promoted', {
      message: feature.title,
      detail: { key, taskId: task.id },
    });

    return { feature: this.get(key), task };
  }
}

/**
 * A promoted entry still needs a definition of done. Repository reality is
 * always part of it: anything only ever *reported* as implemented must be
 * re-checked before it is trusted (§32).
 */
function buildDefaultCriteria(feature: FutureFeature): string[] {
  const criteria: string[] = [];

  if (feature.reality === 'REPORTED_BUT_NOT_FOUND') {
    criteria.push('リポジトリ実態を再確認し、既存コードの有無を判定する');
  }
  criteria.push(`${feature.title} が実装され、TypeScript とビルドが通る`);
  criteria.push('ランタイムテストが通る');
  if (feature.risk) criteria.push(`記録されたリスクに対処する: ${feature.risk}`);
  if (feature.resumeCondition) criteria.push(`再開条件を満たしていることを確認: ${feature.resumeCondition}`);

  return criteria;
}

export { FeatureNotFoundError, ImmutableFeatureError, IMMUTABLE_STATUSES, NON_ACTIONABLE_STATUSES };
