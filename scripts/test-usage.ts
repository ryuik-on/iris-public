/**
 * Usage and cost-estimation tests.
 *
 * The point of this layer is to replace guessing with measurement, so the
 * assertions that matter are the honest-reporting ones: an unknown model must
 * be reported as unpriced rather than as $0, and cached input must not be
 * billed at the full input rate.
 *
 * Run: npm run test:usage
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  estimateCost,
  addUsage,
  formatCost,
  MODEL_PRICES,
  PRICING_LAST_VERIFIED,
  EMPTY_USAGE,
  TokenUsage,
} from '../server/core/usage.js';
import { openDatabase } from '../server/services/db.js';
import { SqliteApprovalStore } from '../server/services/approval_sqlite.js';
import { JarvisOrchestrator, OrchestratorEvent } from '../server/core/orchestrator.js';
import { ToolRegistry } from '../server/tools/registry.js';
import { AIProvider, AIProviderResponse } from '../server/providers/base.js';
import { RiskLevel, Tool, ConversationTurn } from '../server/core/types.js';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    failures.push(name + (detail ? ` — ${detail}` : ''));
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function eq(name: string, actual: any, expected: any) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, ok, ok ? undefined : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function section(title: string) {
  console.log(`\n▸ ${title}`);
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'iris-usage-'));

  try {
    // ---------------------------------------------------------------------
    section('Cost estimation');

    // 1M input + 1M output on Opus 5 is exactly $5 + $25.
    const opus = estimateCost('claude-opus-5', { inputTokens: 1_000_000, outputTokens: 1_000_000 });
    eq('opus-5 prices 1M+1M at $30', opus.usd, 30);
    check('the estimate is marked priced', opus.priced);
    eq('the estimate carries its verification date', opus.pricingLastVerified, PRICING_LAST_VERIFIED);

    const sonnet = estimateCost('claude-sonnet-5', { inputTokens: 1_000_000, outputTokens: 1_000_000 });
    eq('sonnet-5 prices 1M+1M at $18', sonnet.usd, 18);
    check('sonnet is cheaper than opus for identical usage', sonnet.usd < opus.usd);

    const haiku = estimateCost('claude-haiku-4-5', { inputTokens: 1_000_000, outputTokens: 1_000_000 });
    check('haiku is cheaper still', haiku.usd < sonnet.usd);

    // GPT-5.6 tiers, verified against published rates rather than guessed.
    const sol = estimateCost('gpt-5.6-sol', { inputTokens: 1_000_000, outputTokens: 1_000_000 });
    const terra = estimateCost('gpt-5.6-terra', { inputTokens: 1_000_000, outputTokens: 1_000_000 });
    const luna = estimateCost('gpt-5.6-luna', { inputTokens: 1_000_000, outputTokens: 1_000_000 });
    eq('sol prices 1M+1M at $35', sol.usd, 35);
    eq('terra prices 1M+1M at $14', terra.usd, 14);
    eq('luna prices 1M+1M at $1.4', luna.usd, 1.4);
    check('the tiers are ordered sol > terra > luna', sol.usd > terra.usd && terra.usd > luna.usd);
    check('every GPT-5.6 tier is priced, not unknown', [sol, terra, luna].every((e) => e.priced));

    // Anthropic reports the three input buckets separately: `input_tokens` is
    // the uncached remainder, not the total. Treating cached tokens as a subset
    // of input_tokens would double-count them.
    const cached = estimateCost('claude-opus-5', {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
    });
    const uncached = estimateCost('claude-opus-5', { inputTokens: 1_000_000, outputTokens: 0 });
    check('a fully cached prompt costs less than an uncached one', cached.usd < uncached.usd, `${cached.usd} vs ${uncached.usd}`);
    eq('cached reads are billed at the cache rate', cached.usd, 0.5);
    check('caching is a 10x saving on the cached portion', uncached.usd / cached.usd === 10);

    // Half cached, half fresh — the two buckets are priced independently.
    const partial = estimateCost('claude-opus-5', {
      inputTokens: 500_000,
      outputTokens: 0,
      cacheReadTokens: 500_000,
    });
    eq('a partly cached prompt prices each bucket separately', partial.usd, 2.75);

    // Writing the entry costs more than plain input — the first request of a
    // conversation pays a premium, which is why caching needs reuse to pay off.
    const write = estimateCost('claude-opus-5', {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 1_000_000,
    });
    eq('a cache write is billed at 1.25x input', write.usd, 6.25);
    check('a cache write costs more than plain input', write.usd > uncached.usd);
    check(
      'one write plus one read still beats two uncached requests',
      write.usd + cached.usd < uncached.usd * 2,
      `${write.usd + cached.usd} vs ${uncached.usd * 2}`
    );

    // ---------------------------------------------------------------------
    section('Honest reporting of unknowns');

    const unknown = estimateCost('some-model-released-next-year', {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    check('an unknown model is NOT reported as priced', !unknown.priced);
    eq('an unknown model estimates zero rather than a wrong number', unknown.usd, 0);
    check('formatting says unknown rather than $0.00', /不明/.test(formatCost(unknown)));

    check('a priced zero still formats as $0.00', formatCost(estimateCost('gemini-3.6-flash', EMPTY_USAGE)) === '$0.00');
    check(
      'sub-cent costs keep enough precision to be visible',
      /^\$0\.\d{4}$/.test(formatCost(estimateCost('claude-opus-5', { inputTokens: 100, outputTokens: 100 }))),
      formatCost(estimateCost('claude-opus-5', { inputTokens: 100, outputTokens: 100 }))
    );

    check(
      'every priced model has both rates',
      Object.values(MODEL_PRICES).every((p) => typeof p.inputPerMillion === 'number' && typeof p.outputPerMillion === 'number')
    );
    check('the price table states when it was verified', /^\d{4}-\d{2}-\d{2}$/.test(PRICING_LAST_VERIFIED));

    // ---------------------------------------------------------------------
    section('Accumulation');

    const a: TokenUsage = { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10 };
    const b: TokenUsage = { inputTokens: 200, outputTokens: 25, thinkingTokens: 5 };
    const sum = addUsage(a, b);
    eq('input accumulates', sum.inputTokens, 300);
    eq('output accumulates', sum.outputTokens, 75);
    eq('cache reads accumulate across a missing field', sum.cacheReadTokens, 10);
    eq('thinking tokens accumulate across a missing field', sum.thinkingTokens, 5);

    // ---------------------------------------------------------------------
    section('Orchestrator reports usage for the whole run');

    const db = openDatabase(join(dir, 'u.db'));
    const approvals = new SqliteApprovalStore(db);
    const events: OrchestratorEvent[] = [];

    let call = 0;
    const provider: AIProvider = {
      id: 'metered',
      name: 'Metered Provider',
      currentModel: 'claude-sonnet-5',
      setModel() {},
      async generateResponse(): Promise<AIProviderResponse> {
        call++;
        // First call asks for a tool, second answers — two provider calls in one run.
        if (call === 1) {
          return {
            content: '',
            toolCalls: [{ id: 'c1', name: 'probe', args: {} }],
            usage: { inputTokens: 1000, outputTokens: 200 },
          };
        }
        return { content: 'done', usage: { inputTokens: 1500, outputTokens: 300 } };
      },
    };

    const registry = new ToolRegistry();
    const probe: Tool = {
      name: 'probe',
      description: 'read probe',
      riskLevel: RiskLevel.READ,
      schema: { type: 'object', properties: {} },
      async execute() { return { ok: true }; },
    };
    registry.register(probe);

    const orchestrator = new JarvisOrchestrator(provider, registry, approvals, 6, (e) => events.push(e));
    const result = await orchestrator.process({ userMessage: 'hi', history: [] });
    eq('the run completes', result.status, 'completed');

    const usageEvents = events.filter((e) => e.type === 'run.usage') as any[];
    eq('exactly one usage event per run', usageEvents.length, 1);
    const reported = usageEvents[0];
    eq('usage sums across every provider call in the run', reported.usage.inputTokens, 2500);
    eq('output sums too', reported.usage.outputTokens, 500);
    eq('the number of provider calls is reported', reported.calls, 2);
    eq('the model is named', reported.model, 'claude-sonnet-5');
    check('a cost is estimated', reported.usd > 0);
    check('the cost is marked priced', reported.priced);

    // A run that never reaches the provider must not report usage.
    const silentEvents: OrchestratorEvent[] = [];
    const failing: AIProvider = {
      id: 'failing', name: 'f', currentModel: 'claude-sonnet-5', setModel() {},
      async generateResponse(): Promise<AIProviderResponse> {
        const e: any = new Error('400 bad request');
        e.status = 400;
        throw e;
      },
    };
    const failed2 = new JarvisOrchestrator(failing, new ToolRegistry(), approvals, 6, (e) => silentEvents.push(e));
    try {
      await failed2.process({ userMessage: 'hi', history: [] });
    } catch {
      /* expected */
    }
    check(
      'a run that produced no usage still reports its attempt count honestly',
      silentEvents.filter((e) => e.type === 'run.usage').every((e: any) => e.usage.inputTokens === 0)
    );

    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // -----------------------------------------------------------------------
  section('Cache writes are two prices, not one');

  {
    // 5 minutes is 1.25x base input; an hour is 2x. One field cannot carry
    // both, and folding them together costs the expensive one at the cheap
    // rate — which is an undercount inside the number the spending limits
    // enforce, so it fails in the direction that spends money.
    const fiveMin = estimateCost('claude-opus-5', {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 1_000_000,
    });
    eq('a 5-minute write is 1.25x input', fiveMin.usd, 6.25);

    const oneHour = estimateCost('claude-opus-5', {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreation1hTokens: 1_000_000,
    });
    eq('a 1-hour write is 2x input', oneHour.usd, 10);
    check('and costs more than the 5-minute one', oneHour.usd > fiveMin.usd);

    const both = estimateCost('claude-opus-5', {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 1_000_000,
      cacheCreation1hTokens: 1_000_000,
    });
    eq('both are counted', both.usd, 16.25);

    // The real numbers from the session that exposed this, on 2026-08-20.
    const measured = estimateCost('claude-opus-5', {
      inputTokens: 1_053,
      outputTokens: 571_514,
      cacheReadTokens: 120_898_203,
      cacheCreation1hTokens: 771_533,
    });
    check('the observed session prices to about $82', Math.abs(measured.usd - 82.46) < 0.5,
      `got ${measured.usd}`);
    // What the old single-field version produced for the same session.
    const asFiveMinute = estimateCost('claude-opus-5', {
      inputTokens: 1_053,
      outputTokens: 571_514,
      cacheReadTokens: 120_898_203,
      cacheCreationTokens: 771_533,
    });
    check('and the old treatment understated it', asFiveMinute.usd < measured.usd);
    check('by about $2.90', Math.abs((measured.usd - asFiveMinute.usd) - 2.9) < 0.1);
  }

  {
    // Summing must not lose the distinction either.
    const total = addUsage(
      { inputTokens: 1, outputTokens: 1, cacheCreation1hTokens: 100 },
      { inputTokens: 1, outputTokens: 1, cacheCreation1hTokens: 200 }
    );
    eq('adding keeps the 1-hour bucket', total.cacheCreation1hTokens, 300);
    eq('and does not fold it into the 5-minute one', total.cacheCreationTokens, 0);
  }

  section('Gemini is priced as a bill, not as free');

  {
    // The free tier stops at 20 requests a day and then fails over, so a table
    // of zeroes describes twenty calls and misreports every one after them.
    const flash = MODEL_PRICES['gemini-3.6-flash'];
    eq('input is not free', flash.inputPerMillion > 0, true);
    eq('output is not free', flash.outputPerMillion > 0, true);

    // Measured 2026-08-20: 4103 in, 17 output, 587 thinking. Google bills
    // thinking at the output rate, so the turn is 604 output tokens.
    const turn = estimateCost('gemini-3.6-flash', {
      inputTokens: 4103,
      outputTokens: 604,
    });
    eq('a voice turn is priced', turn.priced, true);
    eq(
      'at input plus the whole of output',
      Math.round(turn.usd * 1_000_000),
      Math.round(((4103 / 1_000_000) * 0.75 + (604 / 1_000_000) * 3.75) * 1_000_000)
    );

    // The 17-token reading is what the provider reported before thinking was
    // folded in. It must not be what anyone is billed for.
    const understated = estimateCost('gemini-3.6-flash', {
      inputTokens: 4103,
      outputTokens: 17,
    });
    eq('and not at the output count alone', understated.usd < turn.usd, true);
  }

  section('An announced price change applies itself');

  {
    // Gemini 3.6 Flash doubles on 2027-01-01. A table that only carries a
    // last-verified date reports the old number confidently until a person
    // happens to re-read the pricing page.
    const flash = MODEL_PRICES['gemini-3.6-flash'];
    eq('the change is written down', flash.scheduled?.length, 1);
    eq('with its date', flash.scheduled?.[0].from, '2027-01-01');
    eq('and the new input rate', flash.scheduled?.[0].inputPerMillion, 1.5);
    eq('and the new output rate', flash.scheduled?.[0].outputPerMillion, 7.5);
    eq('which is twice the current input', flash.scheduled?.[0].inputPerMillion, flash.inputPerMillion * 2);
    eq('and twice the current output', flash.scheduled?.[0].outputPerMillion, flash.outputPerMillion * 2);
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Usage & cost: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('All usage tests passed.');
}

main().catch((err) => {
  console.error('\nTest harness crashed:', err);
  process.exit(1);
});
