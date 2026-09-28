import assert from 'node:assert/strict';
import { CONFIG } from '../server/config.js';
import { GeminiProvider } from '../server/providers/gemini.js';
import { AnthropicProvider } from '../server/providers/anthropic.js';
import { OpenAIProvider } from '../server/providers/openai.js';
import { ProviderRouter } from '../server/core/provider_router.js';
import { createDevelopmentTools } from '../server/tools/development.js';
import { RiskLevel, ToolTrust, type Tool } from '../server/core/types.js';

// Only declarations reach the model; this test never executes a tool.
const tools: Tool[] = [
  ...createDevelopmentTools(null as never).filter(t => t.name === 'create_development_task'),
  {
    name: 'read_analysis_material', description: '依頼された分析用の資料を読み取ります。',
    riskLevel: RiskLevel.READ, trust: ToolTrust.TRUSTED_CORE,
    schema: { type: 'object', properties: {} },
    async execute() { throw new Error('Test tools must not execute'); },
  },
];

async function main() {
  assert.equal(tools[0].riskLevel, RiskLevel.WRITE);
  assert.match(CONFIG.systemInstruction, /登録済みを着手済み/);
  if (!process.argv.includes('--live')) {
    console.log('PASS: approval retained. Use --live for model intent checks (API usage).');
    return;
  }
  const base = `http://127.0.0.1:${CONFIG.port}`;
  async function read(path: string) {
    const response = await fetch(base + path, { signal: AbortSignal.timeout(5000) });
    assert.ok(response.ok, `Cannot read ${path}`);
    return response.json();
  }
  const routing = await read('/api/providers/routing');
  assert.equal(routing.routing, true, 'Live IRIS routing must be enabled');
  const entries = routing.providers.map((entry: { key: string; vendor: string; model: string }) => {
    const provider = entry.vendor === 'gemini' ? new GeminiProvider(undefined, entry.model)
      : entry.vendor === 'anthropic' ? new AnthropicProvider(undefined, entry.model)
      : entry.vendor === 'openai' ? new OpenAIProvider(undefined, entry.model)
      : null;
    assert.ok(provider, `Unsupported provider: ${entry.vendor}`);
    return { key: entry.key, provider };
  });
  let paidAllowed = false;
  const provider = new ProviderRouter(entries, {
    quotaResetTimeZone: routing.quotaResetTimeZone,
    paidAllowed: () => paidAllowed,
    freeKeys: (process.env.IRIS_FREE_PROVIDERS || 'gemini').split(',').map(s => s.trim()),
    onEvent: event => {
      if (event.type === 'router.failover') console.log(`FAILOVER: ${event.from} -> ${event.to} (${event.kind})`);
      if (event.type === 'router.served') console.log(`SERVED: ${event.key} / ${event.model}`);
    },
  });
  async function checkBudget() {
    const budget = await read('/api/budget');
    assert.ok(Array.isArray(budget.windows), 'Budget status unavailable');
    paidAllowed = budget.windows.length > 0 && budget.windows.every((w: { remainingUsd: number }) => Number.isFinite(w.remainingUsd) && w.remainingUsd > 0);
  }
  const cases = [
    { name: 'analysis reads material instead of registering', input: '資料を読んで、パイロットデータの比較分析を進めて。', expected: 'read_analysis_material' },
    { name: 'explicit registration remains available', input: '「比較分析」を開発タスクとして登録して。目的は群間比較、完了条件は比較表の作成。今は分析を開始しないで。', expected: 'create_development_task' },
  ];
  for (const c of cases) {
    await checkBudget();
    const response = await provider.generateResponse([{ role: 'user', content: c.input }], tools, CONFIG.systemInstruction, AbortSignal.timeout(60000));
    const names = response.toolCalls?.map(t => t.name) ?? [];
    assert.ok(names.includes(c.expected), `${c.name}: got ${names.join(', ') || 'text only'}`);
    assert.ok(names.every(n => n === c.expected), `${c.name}: unexpected additional tool`);
    console.log(`PASS: ${c.name}`);
  }
  await checkBudget();
  const response = await provider.generateResponse([{ role: 'user', content: '架空の集計です。A群は10人中8人、B群は10人中5人が完了しました。完了率と差を比較して。登録や継続実行は不要です。' }], tools, CONFIG.systemInstruction, AbortSignal.timeout(60000));
  assert.equal(response.toolCalls?.length ?? 0, 0);
  assert.match(response.content, /80/);
  assert.match(response.content, /50/);
  assert.match(response.content, /30/);
  console.log('PASS: supplied data produces an analysis without registration');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
