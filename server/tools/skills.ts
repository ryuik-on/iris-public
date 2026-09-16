import { Tool, RiskLevel, ToolTrust } from '../core/types.js';
import { SkillAdvisorService } from '../services/skill_advisor.js';

/** Read-only skill discovery. It never installs a skill. */
export function createSkillTools(advisor: SkillAdvisorService): Tool[] {
  return [{
    name: 'recommend_skills',
    description:
      'この Mac の既知のリポジトリと作業内容に合う公開スキルを調査し、導入優先度・根拠・懸念点を返します。スキルのインストールは行いません。候補を探す、導入優先度を調べる、使えるスキルがあるか確認する依頼で使います。',
    riskLevel: RiskLevel.READ,
    trust: ToolTrust.TRUSTED_CORE,
    schema: {
      type: 'object',
      properties: { refresh: { type: 'boolean', description: 'true ならキャッシュを無視して再調査します。' } },
    },
    async execute(args: any) {
      const report = await advisor.recommend(Boolean(args?.refresh));
      return {
        generatedAt: report.generatedAt,
        projects: report.projects,
        highPriority: report.candidates.filter((c) => c.priority === 'high'),
        otherCandidates: report.candidates.filter((c) => c.priority !== 'high').slice(0, 10),
        note: report.note,
        ...(report.error ? { error: report.error } : {}),
      };
    },
  }];
}
