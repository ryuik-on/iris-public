import type Database from 'better-sqlite3';

/**
 * 委任した実行の台帳。
 *
 * `AgentProcessService` の `Map` はプロセスと一緒に消える。これは残る。
 * **走らせた事実と、どう終わったかを、再起動のあとでも数えられるように。**
 *
 * ここを足した理由は二つあって、どちらも 2026-09-08 に測った。
 *
 * **一。再起動をまたぐ監督が無かった。**独立レビューの指摘。走っていた実行は
 * IRIS を起こし直した時点で行方が分からなくなる。
 *
 * **二。`/api/telemetry/models` が空だった。**あれは `agent_runs` を読むが、
 * その表は開発タスクと独立レビューだけが書く。**本当の委任は一行も無い。**
 * 8行あって全部 8月18日の2時間ぶん、それ以降は空のまま —— なのに委任は
 * 動き続けていた。「試行が足りない」と出ていたのは、**足りないのではなく
 * 数えていなかった。**
 */

export interface DelegatedRunRow {
  id: string;
  agent: string;
  model: string | null;
  repo: string | null;
  branch: string | null;
  handoffId: string | null;
  startedAt: string;
  endedAt: string | null;
  state: 'running' | 'stopped';
  stopReason: string | null;
  exitCode: number | null;
  usd: number | null;
}

export class DelegatedRunStore {
  constructor(private db: Database.Database) {}

  start(row: Omit<DelegatedRunRow, 'endedAt' | 'state' | 'stopReason' | 'exitCode' | 'usd'>): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO delegated_runs
           (id, agent, model, repo, branch, handoff_id, started_at, ended_at, state, stop_reason, exit_code, usd)
         VALUES (@id, @agent, @model, @repo, @branch, @handoffId, @startedAt, NULL, 'running', NULL, NULL, NULL)`
      )
      .run(row);
  }

  /**
   * 終わりを書く。**始まりの行が無ければ何もしない。**
   *
   * 始まりを書き損ねた実行の終わりだけを残すと、`state` が 'stopped' の行が
   * 始まりの時刻を持たずに並ぶ。数えるときに、走った時間が測れないものが
   * 混ざる方が、行が一つ足りないより悪い。
   */
  finish(id: string, input: { stopReason: string | null; exitCode: number | null; usd: number | null; endedAt: string }): void {
    this.db
      .prepare(
        `UPDATE delegated_runs
            SET state = 'stopped', stop_reason = @stopReason, exit_code = @exitCode,
                usd = @usd, ended_at = @endedAt
          WHERE id = @id`
      )
      .run({ id, ...input });
  }

  /**
   * 走ったままになっている行。**再起動の直後に呼ぶ。**
   *
   * プロセスは死んでいるのに 'running' で残っているものは、監督が切れた
   * 実行。**「動いている」と「動いていたが分からなくなった」を混ぜない**
   * ために、状態を書き換えず、そのまま返して呼び手に決めさせる。
   */
  stillRunning(): DelegatedRunRow[] {
    return this.db
      .prepare(`SELECT * FROM delegated_runs WHERE state = 'running' ORDER BY started_at`)
      .all()
      .map(shape);
  }

  since(iso: string): DelegatedRunRow[] {
    return this.db
      .prepare(`SELECT * FROM delegated_runs WHERE started_at >= ? ORDER BY started_at`)
      .all(iso)
      .map(shape);
  }
}

function shape(row: any): DelegatedRunRow {
  return {
    id: row.id,
    agent: row.agent,
    model: row.model ?? null,
    repo: row.repo ?? null,
    branch: row.branch ?? null,
    handoffId: row.handoff_id ?? null,
    startedAt: row.started_at,
    endedAt: row.ended_at ?? null,
    state: row.state === 'running' ? 'running' : 'stopped',
    stopReason: row.stop_reason ?? null,
    exitCode: typeof row.exit_code === 'number' ? row.exit_code : null,
    usd: typeof row.usd === 'number' ? row.usd : null,
  };
}
