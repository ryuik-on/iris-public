/** Per-provider daily caps. Run: npx tsx scripts/test-provider-caps.ts */
import { parseCaps, spentToday, isCapped } from '../server/core/provider_caps.js';
let passed = 0; const failures: string[] = [];
const ok = (n: string, c: boolean) => { if (c) passed++; else failures.push(n); };

const now = new Date(2026, 9, 8, 15, 0);
const today = new Date(2026, 9, 8, 9, 0).toISOString();
const yesterday = new Date(2026, 9, 7, 22, 0).toISOString();
const records = [
  { model: 'gpt-6.1-sol', usd: 0.6, at: today },
  { model: 'gpt-5.6-terra', usd: 0.5, at: today },
  { model: 'gpt-6.1-sol', usd: 1.95, at: yesterday },
  { model: 'gemini-3.6-flash', usd: 0.3, at: today },
  { model: 'claude-sonnet-5', usd: 0.2, at: today },
];
ok('only today counts, and only that provider\'s models', Math.abs(spentToday('openai', records, now) - 1.1) < 1e-9);
ok('gemini and anthropic are counted separately', Math.abs(spentToday('gemini', records, now) - 0.3) < 1e-9 && Math.abs(spentToday('anthropic', records, now) - 0.2) < 1e-9);
ok('an unknown provider key spends nothing', spentToday('nobody', records, now) === 0);
ok('OpenAI defaults to a one-dollar day', parseCaps({}).openai === 1);
ok('the setting overrides it', parseCaps({ IRIS_OPENAI_DAILY_USD: '2.5' }).openai === 2.5);
ok('zero turns OpenAI off for the day', isCapped('openai', parseCaps({ IRIS_OPENAI_DAILY_USD: '0' }), [], now));
ok('past the cap is capped, under it is not', isCapped('openai', { openai: 1 }, records, now) && !isCapped('openai', { openai: 2 }, records, now));
ok('a provider with no cap is never capped', !isCapped('gemini', { openai: 1 }, records, now));
ok('a new day starts clean', !isCapped('openai', { openai: 1 }, records, new Date(2026, 9, 9, 8, 0)));
console.log(`Provider caps: ${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log(failures.join('\n')); process.exit(1); }
console.log('All provider cap tests passed.');
