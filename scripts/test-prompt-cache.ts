/**
 * プロンプトキャッシュが読めること。
 *
 * 2026-09-30 に測ったら、Anthropic への呼び出しは**毎回キャッシュを書き込み、
 * 一度も読めていなかった**（Sonnet 5：書き込み 96.6 万・読み出し 1.4 万、
 * Haiku 4.5：66 万・0）。時刻と「◯秒前に観測」を含む状況の文が、固定の指示と
 * 同じ塊に入っていたので、前置きが毎回一字ずつ違っていた。書き込みは入力の
 * 1.25 倍なので、キャッシュを切っていた方が安かった。
 *
 * 押さえるのは二つ：
 *   1. 区切り（cache_control）は**固定部分にだけ**付き、変わる部分はその後ろ
 *   2. 状況の文は**一回の走りで一度だけ**作られ、道具の往復でも同じものが渡る
 *
 * Run: npx tsx scripts/test-prompt-cache.ts
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AnthropicProvider } from '../server/providers/anthropic.js';
import { flattenSystem } from '../server/providers/base.js';
import type { AIProvider, AIProviderResponse, SystemInput } from '../server/providers/base.js';
import { JarvisOrchestrator } from '../server/core/orchestrator.js';
import { ToolRegistry } from '../server/tools/registry.js';
import { SqliteApprovalStore } from '../server/services/approval_sqlite.js';
import { openDatabase } from '../server/services/db.js';
import { RiskLevel, ToolTrust } from '../server/core/types.js';

let passed = 0, failed = 0;
const failures: string[] = [];
function section(n: string) { console.log(`\n▸ ${n}`); }
function eq(n: string, a: any, b: any) {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (ok) { passed++; console.log(`  ✓ ${n}`); }
  else { failed++; failures.push(`${n}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`); console.log(`  ✗ ${n}`); }
}

async function main() {
  section('Anthropic：区切りは固定部分にだけ');
  {
    const provider = new AnthropicProvider('test-key', 'claude-sonnet-5');
    let sent: any = null;
    (provider as any).client = {
      messages: {
        create: async (params: any) => {
          sent = params;
          return {
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        },
      },
    };
    await provider.generateResponse([{ role: 'user', content: 'こんにちは' }], [],
      { stable: '固定の指示', volatile: '現在時刻 14:03:27' });
    eq('二つの塊に分かれる', sent.system.length, 2);
    eq('一つ目は固定部分', sent.system[0].text, '固定の指示');
    eq('一つ目に区切り', sent.system[0].cache_control, { type: 'ephemeral' });
    eq('二つ目は変わる部分', sent.system[1].text, '現在時刻 14:03:27');
    eq('二つ目には区切りを付けない', sent.system[1].cache_control, undefined);

    await provider.generateResponse([{ role: 'user', content: 'x' }], [], { stable: '固定', volatile: '  ' });
    eq('変わる部分が空なら塊は一つ', sent.system.length, 1);

    await provider.generateResponse([{ role: 'user', content: 'x' }], [], '文字列のまま');
    eq('文字列でも今までどおり動く', sent.system[0].text, '文字列のまま');
  }

  section('他の提供者：固定部分を先に');
  {
    eq('固定部分が先に来る', flattenSystem({ stable: 'A', volatile: 'B' }), 'A\n\nB');
    eq('空の変わる部分は足さない', flattenSystem({ stable: 'A', volatile: '' }), 'A');
  }

  section('状況の文は一回の走りで一度だけ');
  {
    const dir = mkdtempSync(join(tmpdir(), 'iris-cache-'));
    try {
      const db = openDatabase(join(dir, 'a.db'), { wal: false });
      const registry = new ToolRegistry();
      registry.register({
        name: 'read_thing', description: 'r', riskLevel: RiskLevel.READ, trust: ToolTrust.TRUSTED_CORE,
        schema: { type: 'object', properties: {} }, async execute() { return { ok: true }; },
      });
      const systems: SystemInput[] = [];
      let turn = 0;
      const provider: AIProvider = {
        id: 'fake', vendor: 'fake', name: 'fake', currentModel: 'fake-1',
        setModel() {},
        async generateResponse(_m, _t, system): Promise<AIProviderResponse> {
          systems.push(system);
          turn++;
          // 一回目は道具を呼び、二回目で答える —— 道具の往復が一つある走り。
          if (turn === 1) return { content: '', toolCalls: [{ id: 'c1', name: 'read_thing', args: {} }] };
          return { content: 'done' };
        },
      };
      let rendered = 0;
      const situation = () => `観測から ${++rendered} 秒`;
      const orchestrator = new JarvisOrchestrator(provider, registry, new SqliteApprovalStore(db), 6, undefined, situation);
      await orchestrator.process({ userMessage: 'x', history: [] });

      eq('模型は二回呼ばれた', systems.length, 2);
      eq('状況の文は一度だけ作られた', rendered, 1);
      eq('二回とも同じ前置き（キャッシュが読める）', JSON.stringify(systems[0]), JSON.stringify(systems[1]));
      const first = systems[0] as any;
      eq('状況は変わる部分に入る', first.volatile, '観測から 1 秒');
      eq('固定部分に状況は入らない', first.stable.includes('観測から'), false);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Prompt cache: ${passed} passed, ${failed} failed`);
  if (failed) { console.log('\nFailures:'); for (const f of failures) console.log('  - ' + f); process.exit(1); }
  console.log('All prompt cache tests passed.');
}

main().catch((err) => { console.error('Test harness crashed:', err); process.exit(1); });
