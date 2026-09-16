import { Tool, RiskLevel, ToolTrust } from '../core/types.js';
import { FutureFeatureService } from '../core/future_features_service.js';

/**
 * Register tools.
 *
 * These are what let the user ask, in ordinary conversation, "what's deferred
 * and why?" or "is that allowed?" and get an answer grounded in stored state
 * rather than in whatever happens to be in the current context window.
 *
 * Note the asymmetry: reading the register is free, adding an entry is a WRITE,
 * and there is deliberately no tool for lifting a prohibition. Removing a
 * boundary is not something IRIS offers.
 */
export function createRegisterTools(register: FutureFeatureService): Tool[] {
  return [
    {
      name: 'list_future_features',
      description:
        '将来機能レジスタを一覧します。何が計画中・保留中・禁止かを、その理由とともに返します。',
      riskLevel: RiskLevel.READ,
      trust: ToolTrust.TRUSTED_CORE,
      schema: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: [
              'CURRENT', 'NEXT', 'PLANNED', 'DEFERRED', 'EXPERIMENTAL',
              'REAL_WORLD_VERIFICATION_REQUIRED', 'BLOCKED', 'PROHIBITED',
              'OUT_OF_SCOPE', 'EXPLICIT_DECISION_REQUIRED', 'REJECTED', 'COMPLETED',
            ],
          },
          domain: { type: 'string', description: '例: finance, google_workspace, safety_boundary' },
        },
      },
      async execute(args: any) {
        const features = register.list({ status: args?.status, domain: args?.domain });
        return {
          count: features.length,
          counts: register.counts(),
          features: features.map((f) => ({
            key: f.key,
            title: f.title,
            domain: f.domain,
            status: f.status,
            verification: f.verification,
            reality: f.reality,
            priority: f.priority,
            reason: f.reason,
            resumeCondition: f.resumeCondition,
          })),
        };
      },
    },

    {
      name: 'get_future_feature',
      description:
        '特定の将来機能の詳細を返します。なぜその状態なのか、再開条件は何か、依存関係と根拠を含みます。',
      riskLevel: RiskLevel.READ,
      trust: ToolTrust.TRUSTED_CORE,
      schema: {
        type: 'object',
        properties: { key: { type: 'string', description: '例: receipt_ocr, google_calendar' } },
        required: ['key'],
      },
      async execute(args: any) {
        return register.get(args.key);
      },
    },

    {
      name: 'search_future_features',
      description: '将来機能レジスタをキーワードで検索します。',
      riskLevel: RiskLevel.READ,
      trust: ToolTrust.TRUSTED_CORE,
      schema: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
      async execute(args: any) {
        const features = register.search(args.query);
        return {
          count: features.length,
          features: features.map((f) => ({
            key: f.key,
            title: f.title,
            status: f.status,
            reason: f.reason,
          })),
        };
      },
    },

    {
      name: 'list_safety_boundaries',
      description:
        'IRIS が禁止されていること・対象外としていること・ユーザーの明示判断が必要なことを一覧します。何かが許可されているか判断する前に確認してください。',
      riskLevel: RiskLevel.READ,
      trust: ToolTrust.TRUSTED_CORE,
      schema: { type: 'object', properties: {} },
      async execute() {
        const boundaries = register.boundaries();
        return {
          count: boundaries.length,
          note: 'これらは IRIS 側からは変更できません。変更にはユーザーの明示的な判断が必要です。',
          boundaries: boundaries.map((f) => ({
            key: f.key,
            title: f.title,
            status: f.status,
            reason: f.reason,
            resumeCondition: f.resumeCondition,
          })),
        };
      },
    },

    {
      name: 'list_features_due_for_review',
      description:
        '見直し期限を過ぎた将来機能を返します。再開条件が成立したかを確認するためのもので、自動実装はしません。',
      riskLevel: RiskLevel.READ,
      trust: ToolTrust.TRUSTED_CORE,
      schema: {
        type: 'object',
        properties: {
          maxAgeDays: { type: 'number', description: '既定は90日。' },
        },
      },
      async execute(args: any) {
        const due = register.dueForReview(args?.maxAgeDays ?? 90);
        return {
          count: due.length,
          features: due.map((f) => ({
            key: f.key,
            title: f.title,
            status: f.status,
            reason: f.reason,
            resumeCondition: f.resumeCondition,
            lastReviewedAt: f.lastReviewedAt,
          })),
        };
      },
    },

    {
      name: 'add_future_feature',
      description:
        '将来機能をレジスタに追加します。今は実装しないが忘れたくないアイデアを記録するために使います。',
      riskLevel: RiskLevel.WRITE,
      trust: ToolTrust.TRUSTED_CORE,
      schema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: '安定した識別子（snake_case）。' },
          title: { type: 'string' },
          domain: { type: 'string' },
          status: {
            type: 'string',
            enum: ['PLANNED', 'DEFERRED', 'EXPERIMENTAL', 'BLOCKED', 'NEXT'],
            description: '境界（PROHIBITED 等）はここからは設定できません。',
          },
          reason: { type: 'string', description: 'なぜこの状態なのか。必須。' },
          resumeCondition: { type: 'string', description: '再検討すべき条件。' },
          priority: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3', 'P4', 'NONE'] },
        },
        required: ['key', 'title', 'domain', 'status', 'reason'],
      },
      async execute(args: any) {
        const feature = register.create({
          key: args.key,
          title: args.title,
          domain: args.domain,
          status: args.status,
          reason: args.reason,
          resumeCondition: args.resumeCondition ?? null,
          priority: args.priority ?? 'NONE',
          source: '会話中に記録',
        });
        return { key: feature.key, title: feature.title, status: feature.status };
      },
    },

    {
      name: 'mark_feature_reviewed',
      description: '将来機能を「見直し済み」として記録します。状態は変更しません。',
      riskLevel: RiskLevel.WRITE,
      trust: ToolTrust.TRUSTED_CORE,
      schema: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          note: { type: 'string', description: '見直しの結論。' },
        },
        required: ['key'],
      },
      async execute(args: any) {
        const feature = register.markReviewed(args.key, args.note);
        return { key: feature.key, lastReviewedAt: feature.lastReviewedAt, status: feature.status };
      },
    },
  ];
}
