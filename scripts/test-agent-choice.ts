/**
 * Which agent gets the work when nobody said.
 *
 * The assertions worth having are about the cases where routing is wrong in a
 * way nobody notices: sending network work to an agent that has no network,
 * and treating an unreadable allowance as an empty one.
 *
 * Run: npx tsx scripts/test-agent-choice.ts
 */
import { chooseAgent, SPENT_PERCENT } from '../server/core/agent_choice.js';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function section(name: string) { console.log(`\n▸ ${name}`); }
function eq(name: string, actual: any, expected: any) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(`${name}: ${JSON.stringify(actual)} ≠ ${JSON.stringify(expected)}`); console.log(`  ✗ ${name}`); }
}

const pick = (needsNetwork: boolean, claude: number | null, codex: number | null) =>
  chooseAgent({ needsNetwork, headroom: { claudeWeekPercent: claude, codexWeekPercent: codex } });

section('The network is not negotiable, unattended');
{
  // Codex would win on every other count here and still must not be chosen
  // when nobody is watching: its sandbox refuses the socket, so the work
  // cannot be done at all.
  eq('even with all the headroom in the world', pick(true, 99, 0).agent, 'claude');
  eq('and it says why', pick(true, 99, 0).because.includes('ネットワーク'), true);

  /**
   * But it is a setting, not a property. On a supervised run the socket is
   * granted, so Codex is eligible again and the allowance decides — which is
   * the whole point: the old branch returned Claude before looking at the
   * allowance at all, and sent every network task to the agent least able to
   * finish one.
   */
  const watched = chooseAgent({
    needsNetwork: true,
    attended: true,
    headroom: { claudeWeekPercent: 96, codexWeekPercent: 20 },
  });
  eq('a watched run may use the sandboxed agent', watched.agent, 'codex');
}

section('When both weeks are spent, the one on another plan');
{
  const spentBoth = (agyAvailable: boolean) =>
    chooseAgent({
      needsNetwork: false,
      agyAvailable,
      headroom: { claudeWeekPercent: 97, codexWeekPercent: 95 },
    });
  eq('the third agent takes it', spentBoth(true).agent, 'agy');
  // The reason has to name what actually ruled each one out. An earlier
  // version called Codex "spent" when it was merely unattended, which would
  // send someone looking at an allowance that was never the problem.
  eq('and says what ruled each one out', spentBoth(true).because.includes('97% 使用済み'), true);
  eq('naming both weeks', spentBoth(true).because.includes('95% 使用済み'), true);
  eq(
    'and never calls a blocked agent spent',
    chooseAgent({
      needsNetwork: true,
      agyAvailable: true,
      headroom: { claudeWeekPercent: 96, codexWeekPercent: 20 },
    }).because.includes('外に出られず'),
    true
  );
  /*
   * 何が塞がっているのかまで言う。
   *
   * 「外に出られず」とだけ書いていた。実測 2026-09-07、砂場が閉じるのは
   * **模型が生成したシェル命令の口だけ**で、模型自身の `web.run` はそこを
   * 通らずに取ってくる。理由の文は記録に残り、次のセッションはそれを事実
   * として読むので、**塞がっていないものを塞がっていると書かない。**
   */
  eq(
    'and says it is the shell that is blocked, not the agent',
    chooseAgent({
      needsNetwork: true,
      agyAvailable: true,
      headroom: { claudeWeekPercent: 96, codexWeekPercent: 20 },
    }).because.includes('シェルから外に出られず'),
    true
  );
  /**
   * It needs the Antigravity application to be up. Routing to it while that is
   * closed dispatches a run that cannot begin — it fails immediately with
   * ANTIGRAVITY_LS_ADDRESS is not set — so an unavailable third agent must not
   * be chosen just because the other two are tired.
   */
  eq('but not when it cannot run', spentBoth(false).agent, 'claude');

  // One spent week is not both. Below the threshold the old comparison stands.
  eq(
    'one spent week still goes to the other',
    chooseAgent({
      needsNetwork: false,
      agyAvailable: true,
      headroom: { claudeWeekPercent: 96, codexWeekPercent: 20 },
    }).agent,
    'codex'
  );

  /**
   * Network work with the Claude week gone. Codex is out because nobody is
   * watching, and Claude cannot finish — which used to be the only answer.
   */
  eq(
    'and network work has somewhere to go',
    chooseAgent({
      needsNetwork: true,
      agyAvailable: true,
      headroom: { claudeWeekPercent: 96, codexWeekPercent: 20 },
    }).agent,
    'agy'
  );

  // A judgement, not a measurement — pinned so changing it is a decision.
  eq('the threshold is stated', SPENT_PERCENT, 90);
  eq(
    'an unreadable week is not a spent one',
    chooseAgent({
      needsNetwork: false,
      agyAvailable: true,
      headroom: { claudeWeekPercent: null, codexWeekPercent: null },
    }).agent,
    'claude'
  );
}

section('Otherwise, whoever has more of their week left');
{
  eq('claude nearly spent', pick(false, 87, 16).agent, 'codex');
  eq('codex nearly spent', pick(false, 16, 87).agent, 'claude');
  eq('and the figures are quoted', pick(false, 87, 16).because.includes('87'), true);
}

section('A small difference is not a difference');
{
  /**
   * Without a margin the choice flips on every dispatch as the two drift past
   * each other, which makes the record of who ran what unreadable — and the
   * difference it is reacting to is smaller than one run.
   */
  eq('five points apart', pick(false, 40, 35).agent, 'claude');
  eq('ten points apart is still not enough', pick(false, 40, 30).agent, 'claude');
  eq('eleven is', pick(false, 41, 30).agent, 'codex');
}

section('Unknown is not zero');
{
  /**
   * The failure this is here to prevent: a missing reading is treated as an
   * empty week, and every dispatch goes to whichever vendor happens to have
   * stopped reporting.
   */
  // 85 rather than 90: the threshold is 90 inclusive, and a fixture sitting
  // exactly on it would be testing the spent rule as well as this one.
  eq('codex unreadable', pick(false, 85, null).agent, 'claude');
  eq('claude unreadable', pick(false, null, 85).agent, 'codex');

  /**
   * And unknown beats spent. Two branches used to hand the work to whichever
   * figure was readable without asking whether it had a week left, in mirror
   * image. On 2026-08-26 that was live: Codex at 100% with two and a half
   * hours to its reset, Claude unreadable, and every dispatch would have gone
   * to the exhausted one.
   */
  eq('a spent codex loses to an unreadable claude', pick(false, null, 100).agent, 'claude');
  eq('and a spent claude loses to an unreadable codex', pick(false, 100, null).agent, 'codex');
  eq(
    'the reason names the spent one',
    pick(false, null, 100).because.includes('100% 消費'),
    true
  );
  // Both spent and nothing else available: someone still has to take it.
  eq('two spent weeks still resolve', pick(false, 97, 95).agent, 'claude');
  eq('neither readable', pick(false, null, null).agent, 'claude');
  eq('and that is said out loud', pick(false, null, null).because.includes('読めない'), true);
}

section('Every choice carries its reason');
for (const [n, c] of [['network', pick(true, 1, 1)], ['spread', pick(false, 90, 10)], ['level', pick(false, 50, 50)]] as const) {
  eq(`${n} is explained`, c.because.length > 0, true);
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`Agent choice: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('All agent choice tests passed.');
