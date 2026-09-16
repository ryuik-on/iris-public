import type { AgentKind } from './agent_runner.js';

/**
 * Which agent gets the work, when nobody said.
 *
 * Two benchmarks were run before writing this, and what they did not find is
 * the reason it is shaped this way. On a well-specified task Codex produced
 * a passing result for a sixty-ninth of the indicative cost in half the time,
 * and the only defect its tests missed was one the specification had not
 * asked about. On an open design question both agents examined two
 * alternatives, wrote down why they rejected one, and independently noticed a
 * constraint the specification had missed. The prediction going in was that
 * judgement work would separate them. It did not.
 *
 * So this does not claim a speciality for either. Claiming one on two
 * measurements would be dressing a hunch as a finding, and it would sit in
 * the routing table long after anyone remembered how thin the evidence was.
 *
 * What is left is one hard constraint and one live quantity.
 *
 * The constraint: Codex's commands cannot reach the network as IRIS runs it.
 * Measured 2026-08-22 — curl HTTP 000, ping 100% loss, DNS refused at the
 * socket. It is a setting rather than a property, and IRIS does not open it,
 * so for work that needs the network it is a property.
 *
 * The quantity: how much of each subscription's week is left. That is the
 * thing that actually runs out, it is different for each vendor, and it moves
 * hourly — which makes it the one input here that is worth reading fresh
 * rather than deciding once.
 */

export interface Headroom {
  /** Percent of the week already used, or null when not known. */
  claudeWeekPercent: number | null;
  codexWeekPercent: number | null;
}

/**
 * The point at which a week counts as spent.
 *
 * A judgement, not a measurement, and said so. Below it the metered agents are
 * compared with each other as before; at or above it they are all close enough
 * to unusable that an agent on an entirely different subscription is worth
 * more than whichever of them is marginally less spent. On 2026-08-23 the
 * Claude week stood at 96% and the Codex week at 62%, which is exactly the
 * situation this exists for.
 */
export const SPENT_PERCENT = 90;

export interface Choice {
  agent: AgentKind;
  /** Said in the reply, so a dispatch never routes for a reason nobody sees. */
  because: string;
}

export function chooseAgent(input: {
  needsNetwork: boolean;
  headroom: Headroom;
  /**
   * Whether somebody is watching. Codex's **shell commands** can only reach the
   * network on a supervised run — see `attendedNetwork` — so this decides
   * whether it is eligible for work that needs one, rather than whether it is
   * preferred.
   *
   * **「無人の Codex は外に出られない」は成り立ちません。**砂場が閉じるのは
   * 模型が生成したシェル命令の口だけで、模型自身の道具はそこを通りません。
   * 実測 2026-09-07、`codex exec -s workspace-write`（network_access は付けず）:
   *
   *   シェルの curl   → curl: (6) Could not resolve host: api.github.com
   *   模型の web.run  → 取得成功（stargazers_count 122123 を返した。
   *                     同時刻の実値 122202 に対し 0.06% 差の、少し古い値）
   *
   * つまりこの分岐が守っているのは**シェルの口だけ**で、無人の実行から外へ
   * 出る道は残っています。詳しくは `attendedNetwork`。
   */
  attended?: boolean;
  /**
   * Whether the third agent can run at all. It needs the Antigravity
   * application to be up, so this is a fact about the machine right now and
   * cannot be assumed from configuration.
   */
  agyAvailable?: boolean;
}): Choice {
  const { claudeWeekPercent: claude, codexWeekPercent: codex } = input.headroom;
  const agy = input.agyAvailable === true;

  /**
   * Who could do this work at all, before asking who should.
   *
   * The old version answered `needsNetwork` with an unconditional Claude, and
   * two things have made that wrong since. Codex's sandbox denies sockets by
   * default but opens them on a supervised run, so it is only ineligible when
   * nobody is watching; and the third agent has the machine's network
   * outright. More importantly the old branch returned before looking at the
   * allowance at all — so with the Claude week at 96%, as it was the day this
   * was rewritten, every network task was still sent to the agent least able
   * to finish one. Found by a delegated review, not by reading.
   */
  /*
   * 名前のとおりのことはしていない —— 塞いでいるのはシェルの口だけ。
   *
   * それでも振り分けの材料としては残す。**シェルが使えない実行に、シェルで
   * 取ってくる仕事を回さない**のは正しい。ただし「だから安全」という読みには
   * 使えないので、上の `attended` に測った結果を書いてある。
   */
  const shellNetworkBlocksCodex = input.needsNetwork && input.attended !== true;
  const networkBlocksCodex = shellNetworkBlocksCodex;

  /**
   * The third agent when the metered weeks are gone.
   *
   * It has no readable allowance — nothing local carries a number and the
   * vendor publishes none — so it cannot be compared on headroom and never
   * wins a comparison. What it can do is run when the others cannot, because
   * it is paid for separately. That is the whole of its routing rule.
   */
  const spent = (value: number | null) => value !== null && value >= SPENT_PERCENT;
  const claudeUsable = !spent(claude);
  const codexUsable = !networkBlocksCodex && !spent(codex);
  if (agy && !claudeUsable && !codexUsable) {
    /**
     * Said accurately, because two different things put an agent out.
     *
     * A week that is spent and a sandbox that refuses the socket are not the
     * same fact, and the first version of this message called both of them
     * "spent" — reporting Codex at 82% as out of allowance when it was only
     * unattended. A dispatch that states a reason which is not the reason is
     * worse than one that states none: the record then argues for the wrong
     * fix, and someone goes looking at an allowance that was never the problem.
     */
    const why = [
      spent(claude) ? `claude は週 ${describe(claude)} 使用済み` : 'claude は使えず',
      networkBlocksCodex
        // 「外に出られず」と書いていた。塞がっているのはシェルの口だけなので、
        // そう書く。理由の文は記録に残り、次の人はそれを事実として読む。
        ? 'codex は無人実行ではシェルから外に出られず'
        : `codex は週 ${describe(codex)} 使用済み`,
    ].join('、');
    return {
      agent: 'agy',
      because: `${why}。agy は別の契約で動くので、どちらの週も減りません。`,
    };
  }

  if (networkBlocksCodex) {
    if (agy && spent(claude)) {
      return {
        agent: 'agy',
        because:
          `ネットワークが必要で、Claude の週が ${describe(claude)} 消費のため。` +
          'Codex は無人実行ではシェルから外に出られず、agy は別契約で動きます。',
      };
    }
    return {
      agent: 'claude',
      because:
        'ネットワークが必要な作業のため' +
        '（Codex のシェルは無人実行では外に出られません）。',
    };
  }

  /**
   * A spent agent never wins by default.
   *
   * Below this the two are compared, and that comparison assumes both can
   * actually take the work. Two branches broke that assumption in mirror
   * image: when one figure is unreadable the other was handed the job without
   * anyone asking whether it had a week left. On 2026-08-26 that was live —
   * Codex at 100% with two and a half hours to its reset, Claude unreadable,
   * and every dispatch would have gone to the exhausted one.
   *
   * Unknown is not free, but it is also not known to be spent, and a figure
   * nobody can read is a better bet than a figure that says there is nothing
   * there. Where an agent is spent and something else can take the work, the
   * something else takes it.
   */
  if (claudeUsable && !codexUsable) {
    return {
      agent: 'claude',
      because: `codex は週 ${describe(codex)} 消費のため（claude は ${describe(claude)}）。`,
    };
  }
  if (!claudeUsable && codexUsable) {
    return {
      agent: 'codex',
      because: `claude は週 ${describe(claude)} 消費のため（codex は ${describe(codex)}）。`,
    };
  }

  /**
   * Both unknown is not a tie, it is an absence — and the default belongs to
   * the one whose failure modes are understood here. Codex went four runs
   * without committing before that was traced, and it is the newer path.
   */
  if (claude === null && codex === null) {
    return { agent: 'claude', because: '使用量が読めないため、既定の claude に回します。' };
  }
  if (codex === null) return { agent: 'claude', because: 'Codex の使用量が読めないため。' };
  if (claude === null) return { agent: 'codex', because: 'Claude の使用量が読めないため。' };

  /**
   * Compared as fractions of each subscription's own week, which is not the
   * same as comparing amounts — the plans are different sizes and neither
   * publishes what a percent is worth. It is the right comparison anyway:
   * the question is which one is closer to being unusable, and that is what a
   * percentage of your own allowance says.
   *
   * A margin, so a two-point difference does not swing every dispatch. Below
   * it the two are treated as equally free and the older, better-understood
   * path wins.
   */
  const MARGIN = 10;
  if (claude - codex > MARGIN) {
    return {
      agent: 'codex',
      because: `週の使用が Codex の方が少ないため（claude ${claude}% / codex ${codex}% 使用済み）。`,
    };
  }
  if (codex - claude > MARGIN) {
    return {
      agent: 'claude',
      because: `週の使用が Claude の方が少ないため（claude ${claude}% / codex ${codex}% 使用済み）。`,
    };
  }
  return {
    agent: 'claude',
    because: `使用量に大きな差がないため（claude ${claude}% / codex ${codex}% 使用済み）。`,
  };
}

/** A percentage, or the fact that there was not one. Never rendered as zero. */
function describe(value: number | null): string {
  return value === null ? '不明' : `${value}%`;
}
