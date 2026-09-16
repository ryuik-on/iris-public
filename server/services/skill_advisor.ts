import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const execFileAsync = promisify(execFile);

export interface SkillCandidate {
  id: string;
  name: string;
  source: string;
  installs?: number;
  url?: string;
  repo?: {
    owner?: string;
    owner_type?: string;
    known_vendor?: boolean;
    archived?: boolean;
    license?: string | null;
    days_since_push?: number;
    stars?: number;
  };
  skill_path?: string;
  bundled_files?: string[];
  ships_executables?: boolean;
  body?: {
    bytes?: number;
    description?: string;
    description_bytes?: number;
    states_trigger?: boolean;
    risk_flags?: string[];
  };
  error?: string;
  projects: string[];
  score: number;
  priority: 'high' | 'medium' | 'low' | 'reject';
  reasons: string[];
  concerns: string[];
}

export interface SkillRecommendationReport {
  generatedAt: string;
  projects: string[];
  queries: string[];
  candidates: SkillCandidate[];
  note: string;
  error?: string;
}

interface AdvisorOptions {
  cwd: string;
  scriptPath?: string;
  cachePath?: string;
  now?: () => number;
  run?: (project: string, query: string) => Promise<string>;
  cacheTtlMs?: number;
}

const DEFAULT_QUERIES = [
  'software engineering developer productivity',
  'general coding agent workflow',
  'testing security code review automation',
  'documentation ux writing developer productivity',
  'research writing planning productivity',
  'pdf documents presentations spreadsheets browser accessibility',
  'agent orchestration multi-agent workflow',
  'web development typescript nextjs supabase',
];

/**
 * Finds skills without installing them. The audit script is deliberately
 * reused rather than reimplementing the registry and GitHub checks here.
 * Results are cached locally because a refresh spends network time and must
 * never happen implicitly during an ordinary chat turn.
 */
export class SkillAdvisorService {
  private readonly options: Required<Pick<AdvisorOptions, 'cwd' | 'cacheTtlMs'>> & AdvisorOptions;
  private inFlight: Promise<SkillRecommendationReport> | null = null;

  constructor(options: AdvisorOptions) {
    this.options = { cacheTtlMs: 24 * 60 * 60_000, now: Date.now, ...options };
  }

  async recommend(force = false): Promise<SkillRecommendationReport> {
    if (!force) {
      const cached = this.readCache();
      if (
        cached &&
        cached.queries.join('|') === DEFAULT_QUERIES.join('|') &&
        this.options.now!() - Date.parse(cached.generatedAt) < this.options.cacheTtlMs
      ) return cached;
    }
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.refresh().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async refresh(): Promise<SkillRecommendationReport> {
    const projects = this.projects();
    const queries = DEFAULT_QUERIES;
    const outputs = await Promise.allSettled(
      projects.flatMap((project) => queries.map((query) => this.run(project, query)))
    );
    const candidates = new Map<string, SkillCandidate>();
    const errors: string[] = [];

    for (const result of outputs) {
      if (result.status === 'rejected') { errors.push(String(result.reason)); continue; }
      let parsed: any;
      try { parsed = JSON.parse(result.value.stdout); } catch { errors.push('スキル監査のJSONを解釈できませんでした。'); continue; }
      for (const raw of parsed.candidates ?? []) {
        const scored = scoreCandidate(raw, parsed.project?.languages ?? [], parsed.project?.deps ?? [], result.value.project);
        const old = candidates.get(scored.id);
        if (old) {
          old.projects = [...new Set([...old.projects, ...scored.projects])];
          old.score = Math.max(old.score, scored.score);
          old.reasons = [...new Set([...old.reasons, ...scored.reasons])];
          old.concerns = [...new Set([...old.concerns, ...scored.concerns])];
          if (priorityRank(scored.priority) > priorityRank(old.priority)) old.priority = scored.priority;
        } else {
          candidates.set(scored.id, scored);
        }
      }
    }

    const report: SkillRecommendationReport = {
      generatedAt: new Date(this.options.now!()).toISOString(),
      projects,
      queries,
      candidates: [...candidates.values()].sort((a, b) => b.score - a.score),
      note: '候補の調査結果です。導入や実行は行っていません。危険フラグ、既存スキルとの重複、実際の適用範囲を確認してから導入してください。',
      ...(errors.length ? { error: errors.slice(0, 3).join(' / ') } : {}),
    };
    this.writeCache(report);
    return report;
  }

  private async run(project: string, query: string): Promise<{ project: string; stdout: string }> {
    if (this.options.run) return { project, stdout: await this.options.run(project, query) };
    const script = this.options.scriptPath || path.join(os.homedir(), '.agents/skills/skill-audit/scripts/gather.py');
    const result = await execFileAsync('python3', [script, query, '--limit', '12', '--project', project], {
      timeout: 90_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { project, stdout: result.stdout };
  }

  private projects(): string[] {
    const configured = (process.env.IRIS_SKILL_PROJECTS || '').split(path.delimiter).filter(Boolean);
    const briefingPath = path.join(os.homedir(), '.iris/briefing.json');
    let fromBriefing: string[] = [];
    try { fromBriefing = JSON.parse(fs.readFileSync(briefingPath, 'utf8')).repositories ?? []; } catch { /* optional */ }
    return [...new Set([this.options.cwd, ...configured, ...fromBriefing].filter((p) => fs.existsSync(p)))].slice(0, 6);
  }

  private readCache(): SkillRecommendationReport | null {
    if (!this.options.cachePath) return null;
    try { return JSON.parse(fs.readFileSync(this.options.cachePath, 'utf8')); } catch { return null; }
  }

  private writeCache(report: SkillRecommendationReport): void {
    if (!this.options.cachePath) return;
    try {
      fs.mkdirSync(path.dirname(this.options.cachePath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(this.options.cachePath, JSON.stringify(report, null, 2), { mode: 0o600 });
    } catch { /* a cache is helpful, never a reason to fail the feature */ }
  }
}

function scoreCandidate(raw: any, languages: string[], deps: string[], project: string): SkillCandidate {
  const reasons: string[] = [];
  const concerns: string[] = [];
  let score = 0;
  const repo = raw.repo ?? {};
  const body = raw.body ?? {};
  if (raw.error) concerns.push(raw.error);
  if (repo.archived) { concerns.push('リポジトリがアーカイブ済み'); score -= 20; }
  if (repo.known_vendor || repo.owner_type === 'Organization') { score += 3; reasons.push('公開元が組織または既知ベンダー'); }
  if (repo.days_since_push !== undefined && repo.days_since_push <= 180) { score += 2; reasons.push('最近も更新されている'); }
  if (!body.risk_flags?.length) { score += 2; reasons.push('監査で危険フラグなし'); }
  else concerns.push(`危険フラグ要確認: ${body.risk_flags.join(', ')}`);
  if (!raw.ships_executables) { score += 1; reasons.push('実行ファイルを含まない'); }
  if (body.states_trigger && (body.description_bytes ?? 0) >= 100) { score += 2; reasons.push('発火条件が明確'); }
  else concerns.push('発火条件または説明が弱い');
  const fit = [...languages, ...deps].some((x) => String(raw.name).toLowerCase().includes(String(x).toLowerCase()));
  if (fit) { score += 2; reasons.push('現在の技術スタック名と一致'); }
  if (body.bytes > 20_000 && !(raw.bundled_files?.length)) concerns.push('本文が大きく、補助資料なし');
  let priority: SkillCandidate['priority'] = 'low';
  if (raw.error || repo.archived || body.risk_flags?.some((x: string) => /pipe.*shell|download.*shell/i.test(x))) priority = 'reject';
  else if (score >= 9 && concerns.length <= 1) priority = 'high';
  else if (score >= 6) priority = 'medium';
  return { ...raw, projects: project ? [project] : [], score, priority, reasons, concerns };
}

function priorityRank(priority: SkillCandidate['priority']): number {
  return ({ reject: 0, low: 1, medium: 2, high: 3 } as const)[priority];
}
