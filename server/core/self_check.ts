/**
 * 自己開発の「実機検査」。動いている IRIS 自身に、使う場所と同じ口から触って確かめる。
 *
 * 今日あなたが直させた不具合の多くは、**テストが通ったあとに、実際に使う場所で壊れて
 * いた**（レールが Chrome のタブで動かない、起動直後に連携が壊れたと出る、古い
 * 「76 件」を言い続ける）。単体テストはその種類の失敗を見ない。ここは、動いている
 * サーバーに HTTP で触る検査を、定期的に走らせる。
 *
 * 検査は**読むだけ**で、何も書き換えない（預かりものの往復だけは、誰かの預かりが
 * 無いときに限って確かめる）。落ちた検査は、自己開発の候補になる。
 */

import type { FindingInput } from './self_detect.js';

export interface CheckContext {
  get: (path: string) => Promise<any>;
  post: (path: string, body: unknown) => Promise<any>;
  now: () => Date;
  /** 時間のかかる、または外のサービスに触る検査（一日一回）。 */
  deep: boolean;
  /** 外のサービスの読み取りを直接試す（PubMed など）。 */
  probes?: Array<{ name: string; run: () => Promise<string> }>;
}

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
  ms: number;
}

type Check = { name: string; deepOnly?: boolean; run: (ctx: CheckContext) => Promise<string | null> };

async function timed(ctx: CheckContext, path: string, maxMs: number): Promise<any> {
  const started = Date.now();
  const value = await ctx.get(path);
  const took = Date.now() - started;
  if (took > maxMs) throw new Error(`${path} の応答が ${took} ms かかりました（${maxMs} ms まで）。`);
  return value;
}

/** `null` は通った。文字列は、落ちた理由。 */
export const CHECKS: Check[] = [
  {
    name: 'health',
    run: async (ctx) => {
      const h = await timed(ctx, '/api/health', 3000);
      // 起動の直後は連携が準備中。それは壊れではない。
      if (typeof h.uptimeSeconds === 'number' && h.uptimeSeconds < 120) return null;
      if (h.status !== 'healthy') {
        const bad = (h.integrations ?? []).filter((i: any) => i.state !== 'ready').map((i: any) => i.label);
        return `状態が ${h.status}${bad.length ? `（使えない連携: ${bad.join('・')}）` : ''}${(h.configIssues ?? []).length ? `、設定の問題 ${h.configIssues.length} 件` : ''}`;
      }
      return null;
    },
  },
  {
    name: 'rail_data_fast',
    run: async (ctx) => {
      // レールが毎回読む口。どれかが遅いと、その回の表示が消える。
      for (const [p, max] of [['/api/usage/cli', 2000], ['/api/proactive', 2000], ['/api/calendar?days=2', 8000], ['/api/exam/next', 3000]] as const) {
        await timed(ctx, p, max);
      }
      return null;
    },
  },
  {
    name: 'center_snapshot',
    run: async (ctx) => {
      const c = await timed(ctx, '/api/center', 6000);
      for (const key of ['counts', 'today', 'notices', 'runs', 'selfDev']) if (!(key in c)) return `/api/center に ${key} がありません。`;
      if (c.today.couldNotRead?.length) return `今日のまとめに読めなかったものがあります: ${c.today.couldNotRead.slice(0, 2).join(' / ')}`;
      return null;
    },
  },
  {
    name: 'ui_build_served',
    run: async (ctx) => {
      const b = await timed(ctx, '/api/build', 2000);
      return b?.id ? null : '画面の版を返せません（dist/index.html が無い）。';
    },
  },
  {
    name: 'ui_deposit_roundtrip',
    run: async (ctx) => {
      // 誰かの預かりが残っているときは触らない（奪わない）。
      const held = await ctx.get('/api/ui/open?peek=1');
      if (held?.conversationId || held?.view) return null;
      await ctx.post('/api/ui/open', { view: 'center' });
      const back = await ctx.get('/api/ui/open');
      return back?.view === 'center' ? null : `預けた view が返りません（${JSON.stringify(back)}）。`;
    },
  },
  {
    name: 'calendar_readable',
    run: async (ctx) => {
      const s = await timed(ctx, '/api/schedule?days=2', 15_000);
      if (!Array.isArray(s.events)) return '予定の読み取りが配列を返しません。';
      if (s.unavailable?.length || s.missing?.length) return `読めていない源があります: ${JSON.stringify(s.unavailable ?? s.missing).slice(0, 160)}`;
      return null;
    },
  },
  {
    name: 'lecture_divergence',
    run: async (ctx) => {
      const d = await timed(ctx, '/api/lectures/divergence?days=30', 15_000);
      if (d.compared !== true) return `日程表とカレンダーを比べられていません: ${d.reason ?? '理由不明'}`;
      return null;
    },
  },
  {
    name: 'morning_brief_today',
    run: async (ctx) => {
      const now = ctx.now();
      // 7 時を過ぎて 30 分たっても、今日の分が無ければ落ちている。
      if (now.getHours() < 7 || (now.getHours() === 7 && now.getMinutes() < 30)) return null;
      const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      const c = await ctx.get('/api/center');
      const has = (c.notices ?? []).some((n: any) => n.ruleId === 'morning.brief' && String(n.createdAt).slice(0, 10) >= day.slice(0, 10)) || !!c.today?.brief;
      return has ? null : '今日の朝のまとめが作れていません。';
    },
  },
  {
    name: 'dev_tasks_not_orphaned',
    run: async (ctx) => {
      // 進行中のまま、動いている実行も待機も無いタスク（結果が書かれなかった、など）。
      const [tasks, runs, active] = await Promise.all([ctx.get('/api/dev/tasks'), ctx.get('/api/delegated/runs'), ctx.get('/api/dev/runs/active')]);
      const running = new Set<string>(((active?.runs ?? []) as any[]).map((r) => r.taskId));
      const liveRun = new Set<string>(((runs?.runs ?? []) as any[]).filter((r) => r.state === 'running').map((r) => r.handoffId));
      const now = ctx.now().getTime();
      const orphaned = ((tasks?.tasks ?? []) as any[]).filter((t) => {
        if (t.status !== 'in_progress' || t.waiting) return false;
        if (running.has(t.id) || liveRun.has(t.id)) return false;
        const last = ((runs?.runs ?? []) as any[]).filter((r) => r.handoffId === t.id).map((r) => Date.parse(r.endedAt ?? r.startedAt));
        const lastAt = last.length ? Math.max(...last) : Date.parse(t.updatedAt ?? t.createdAt);
        return now - lastAt > 6 * 3_600_000;
      });
      return orphaned.length ? `進行中のまま 6 時間以上動いていないタスク: ${orphaned.slice(0, 3).map((t: any) => t.title).join(' / ')}` : null;
    },
  },
  {
    name: 'external_tools_live',
    deepOnly: true,
    run: async (ctx) => {
      const failed: string[] = [];
      for (const p of ctx.probes ?? []) {
        try { await p.run(); } catch (err: any) { failed.push(`${p.name}: ${String(err?.message ?? err).slice(0, 120)}`); }
      }
      return failed.length ? failed.join(' / ') : null;
    },
  },
];

export async function runChecks(ctx: CheckContext): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  for (const check of CHECKS) {
    if (check.deepOnly && !ctx.deep) continue;
    const started = Date.now();
    try {
      const failure = await check.run(ctx);
      out.push({ name: check.name, ok: failure === null, detail: failure ?? '通った', ms: Date.now() - started });
    } catch (err: any) {
      // 検査が投げた例外も「落ちた」。検査が壊れているのと、対象が壊れているのは、ここでは区別しない。
      out.push({ name: check.name, ok: false, detail: String(err?.message ?? err).slice(0, 240), ms: Date.now() - started });
    }
  }
  return out;
}

/** 落ちた検査を、自己開発の候補にする。 */
export function failuresToFindings(results: CheckResult[]): FindingInput[] {
  return results.filter((r) => !r.ok).map((r) => ({
    dedupeKey: `selfcheck:${r.name}`,
    source: 'selfcheck' as const,
    title: `実機検査「${r.name}」が落ちた`,
    detail: r.detail,
    evidence: [r.detail],
  }));
}
