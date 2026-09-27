/**
 * Tests for IRIS's own MCP server.
 *
 * Two things are worth testing and one is not.
 *
 * Not worth testing: that a GET is forwarded. The store's rules are tested
 * where they live, and duplicating them here would mean two places to change.
 *
 * Worth testing: the places where this boundary decides something the HTTP API
 * does not. There are three — a measurement with no evidence is refused
 * instead of demoted, a recall never asks for local-only memories, and an
 * unreachable socket falls back to the written copy for reads and says plainly
 * that writes are lost. Each exists because of a specific failure, and a
 * regression in any of them is silent.
 *
 * Run: npm run test:iris-mcp
 */
import { IRIS_TOOLS, callIrisTool, IrisIo, IrisResponse } from '../server/core/mcp_server.js';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail?: string) {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
function section(t: string) { console.log(`\n▸ ${t}`); }

interface Call { method: string; path: string; body?: any }

/** An IRIS that records what it was asked and answers from a table. */
function fakeIris(
  answers: Record<string, IrisResponse | (() => IrisResponse)>,
  opts: { offline?: { json: any; path: string } | null; unreachable?: boolean; now?: number } = {}
): { io: IrisIo; calls: Call[] } {
  const calls: Call[] = [];
  const io: IrisIo = {
    async request(method, path, body) {
      calls.push({ method, path, body });
      if (opts.unreachable) throw new Error('connect ECONNREFUSED 127.0.0.1:3002');
      const key = `${method} ${path.split('?')[0]}`;
      const answer = answers[key];
      if (!answer) throw new Error(`test has no answer for ${key}`);
      return typeof answer === 'function' ? answer() : answer;
    },
    async offlineBriefing() {
      return opts.offline ?? null;
    },
    now: () => opts.now ?? Date.parse('2026-09-27T12:00:00Z'),
  };
  return { io, calls };
}

const BRIEFING = {
  generatedAt: '2026-09-27T11:30:00Z',
  decisions: [{ title: 'ある決定', decided: 'こうする', grounds: ['測った'] }],
  facts: [{ kind: 'environment', content: 'このマシンに Face ID はない', provenance: 'measured', source: 'claude' }],
  repositories: [],
  allowance: { claudeWeekUsedPercent: 12, codexWeekUsedPercent: null },
  writeBack: {},
};

async function main() {
  // -----------------------------------------------------------------------
  section('A measurement with nothing to point at is refused, not sent');

  {
    const { io, calls } = fakeIris({});
    const res = await callIrisTool(
      'remember',
      { content: 'Gemini の最初の出力は29.7秒後', kind: 'tool_behaviour', provenance: 'measured', source: 'claude' },
      io
    );
    check('refused', res.isError);
    check('nothing was written', calls.length === 0, `${calls.length} 回呼ばれた`);
    check('says what is missing', res.text.includes('evidence'));
    check('offers both ways forward', res.text.includes('inferred'));
  }

  {
    // Whitespace is not evidence. An empty string in the array would otherwise
    // satisfy the check while pointing at nothing.
    const { io, calls } = fakeIris({});
    const res = await callIrisTool(
      'remember',
      { content: 'x', kind: 'finding', provenance: 'measured', source: 'claude', evidence: ['  ', ''] },
      io
    );
    check('blank evidence does not count', res.isError && calls.length === 0);
  }

  {
    const { io, calls } = fakeIris({
      'POST /api/memory': { status: 201, json: { memory: { provenance: 'measured', confidence: 0.9 }, reason: '記録します。' } },
    });
    const res = await callIrisTool(
      'remember',
      {
        content: 'Gemini の最初の出力は29.7秒後',
        kind: 'tool_behaviour',
        provenance: 'measured',
        source: 'claude',
        evidence: ['gemini -p を実測（2026-08-23）'],
      },
      io
    );
    check('with evidence it goes through', !res.isError && calls.length === 1);
    check('the evidence is forwarded', calls[0].body.evidence.length === 1);
  }

  {
    // An `inferred` write carries no such requirement: the caller is not
    // claiming to have measured anything.
    const { io, calls } = fakeIris({
      'POST /api/memory': { status: 201, json: { memory: { provenance: 'inferred', confidence: 0.7 } } },
    });
    const res = await callIrisTool('remember', { content: 'x', kind: 'finding', provenance: 'inferred', source: 'claude' }, io);
    check('inferred needs no evidence', !res.isError && calls.length === 1);
  }

  // -----------------------------------------------------------------------
  section('A demotion that happens anyway is said out loud');

  {
    const { io } = fakeIris({
      'POST /api/memory': {
        status: 201,
        json: {
          memory: { provenance: 'inferred', confidence: 0.7 },
          reason: '計測と申告されましたが根拠がないため、推論として記録します。',
          demoted: { asked: 'measured', storedAs: 'inferred' },
        },
      },
    });
    const res = await callIrisTool(
      'remember',
      { content: 'x', kind: 'finding', provenance: 'measured', source: 'claude', evidence: ['なにか'] },
      io
    );
    check('the result is not silent about it', res.text.includes('measured') && res.text.includes('inferred'));
    check('and it is marked as a difference from what was asked', res.text.includes('申告と違う'));
  }

  {
    const { io } = fakeIris({ 'POST /api/memory': { status: 400, json: { reason: '内容がありません。' } } });
    const res = await callIrisTool('remember', { content: '', kind: 'finding', provenance: 'user', source: 'x' }, io);
    check("a refusal relays the store's own wording", res.isError && res.text.includes('内容がありません'));
  }

  // -----------------------------------------------------------------------
  section('Recall never asks for local-only memories');

  {
    const { io, calls } = fakeIris({ 'GET /api/memory': { status: 200, json: { memories: [] } } });
    await callIrisTool('recall', { kind: 'environment' }, io);
    check('shareable=true is not optional', calls[0].path.includes('shareable=true'));
  }

  {
    // The tool has no parameter that could turn it off, which is the actual
    // guarantee — a caller cannot ask for local-only text by accident.
    const recall = IRIS_TOOLS.find((t) => t.name === 'recall')!;
    check('and there is no way to ask for it', !JSON.stringify(recall.inputSchema).includes('shareable'));
  }

  {
    const { io } = fakeIris({
      'GET /api/memory': {
        status: 200,
        json: { memories: [{ kind: 'finding', content: 'なにか', provenance: 'external', source: 'とあるページ', confidence: 0.5 }] },
      },
    });
    const res = await callIrisTool('recall', {}, io);
    check('provenance is on the line, not in a footnote', res.text.includes('[external/finding]'));
  }

  // -----------------------------------------------------------------------
  section('A blocked socket is not IRIS being down');

  {
    const { io } = fakeIris({}, { unreachable: true, offline: { json: BRIEFING, path: '/Users/x/.iris/briefing.json' } });
    const res = await callIrisTool('briefing', {}, io);
    check('the written copy is read', !res.isError && res.text.includes('Face ID'));
    check('and its age is stated', res.text.includes('30分前'), res.text.slice(0, 200));
    check('and the caller is told it cannot write back', res.text.includes('書き戻し'));
  }

  {
    const { io } = fakeIris({}, { unreachable: true, offline: null });
    const res = await callIrisTool('briefing', {}, io);
    check('with no copy either, it still does not claim IRIS is down', res.isError && res.text.includes('決めつけない'));
  }

  {
    const { io } = fakeIris({}, { unreachable: true });
    const res = await callIrisTool('remember', { content: 'x', kind: 'finding', provenance: 'user', source: 'x' }, io);
    check('a lost write says the fact must go to the user', res.isError && res.text.includes('利用者に伝えて'));
  }

  // -----------------------------------------------------------------------
  section('Reads that a session is told to make');

  {
    const { io } = fakeIris({ 'GET /api/briefing': { status: 200, json: BRIEFING } });
    const res = await callIrisTool('briefing', { limit: 5 }, io);
    check('the briefing separates decisions from facts', res.text.includes('決まっていること') && res.text.includes('測って分かっている事実'));
    check('and repeats that the allowance is what was used', res.text.includes('残量ではない'));
  }

  {
    // null is "could not read", and the one thing it must never render as is 0.
    const { io } = fakeIris({ 'GET /api/usage/cli': { status: 200, json: { claude: { weekUsedPercent: 12 }, codex: { usedPercent: null } } } });
    const res = await callIrisTool('allowance', {}, io);
    check('null reads as unread', res.text.includes('読めなかった'));
    check('and not as zero', !/Codex 週: 0%/.test(res.text));
  }

  {
    const { io, calls } = fakeIris({ 'GET /api/decisions': { status: 200, json: { decisions: [{ id: 'd1', title: 'あれ', decided: 'こう', decidedBy: 'user', grounds: ['g'] }] } } });
    const res = await callIrisTool('decisions', { unweighed: true }, io);
    check('unweighed is passed through', calls[0].path.includes('unweighed=true'));
    check('the id is shown, so it can be revised later', res.text.includes('d1'));
    check('no alternatives is stated, not omitted', res.text.includes('代替案なし'));
  }

  {
    const { io } = fakeIris({ 'POST /api/decisions': { status: 201, json: { decision: { id: 'd2' }, reason: '記録します。', revised: 'd1' } } });
    const res = await callIrisTool('decide', { title: 't', decided: 'd', decidedBy: 'user', grounds: ['g'], revises: 'd1' }, io);
    check('a supersession is reported', !res.isError && res.text.includes('d1'));
    check('and the old record is said to remain', res.text.includes('古い記録は残ります'));
  }

  {
    const { io } = fakeIris({ 'POST /api/decisions': { status: 400, json: { reason: '根拠が空です。根拠のない決定は決定ではなく好みです。' } } });
    const res = await callIrisTool('decide', { title: 't', decided: 'd', decidedBy: 'user', grounds: [] }, io);
    check('grounds are enforced by the store, and its reason is relayed', res.isError && res.text.includes('好み'));
  }

  // -----------------------------------------------------------------------
  section('The tool list is usable by a model that has never seen IRIS');

  {
    check('every tool describes itself', IRIS_TOOLS.every((t) => t.description.length > 40));
    check('writes are marked as writes', IRIS_TOOLS.filter((t) => !t.readOnly).map((t) => t.name).join(',') === 'remember,decide');
    check('every schema is an object schema', IRIS_TOOLS.every((t) => t.inputSchema.type === 'object'));
    const remember = IRIS_TOOLS.find((t) => t.name === 'remember')!;
    check('remember asks for a source', (remember.inputSchema.required ?? []).includes('source'));
    check(
      'and its description carries the evidence rule',
      remember.description.includes('evidence') && remember.description.includes('断る')
    );
    const names = IRIS_TOOLS.map((t) => t.name);
    check('names are unique', new Set(names).size === names.length);
  }

  {
    const res = await callIrisTool('no_such_tool', {}, fakeIris({}).io);
    check('an unknown tool is an error, not a silent empty answer', res.isError);
  }

  console.log(`\n${failed === 0 ? '✓' : '✗'} ${passed} passed, ${failed} failed`);
  if (failed) { console.log(failures.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
}

main().catch((err) => { console.error(err); process.exit(1); });
