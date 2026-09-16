/**
 * Proactive suggestion tests, and the boundary underneath them.
 *
 * Two separable things are checked here.
 *
 * The first is when IRIS is allowed to speak first. Every gate exists because
 * of a specific way an ambient assistant becomes wrong or unbearable: firing
 * on a sensor that has said nothing, firing on a stale reading, firing on an
 * uncalibrated guess, firing while two sensors contradict each other, and
 * firing again thirty seconds later.
 *
 * The second matters more. A run started from an inference must not be able to
 * reach an irreversible tool — not "with approval", at all. That is enforced
 * in the orchestrator rather than in a rule, because a rule is configuration
 * and configuration is the thing that gets edited at 2am.
 *
 * Run: npm run test:proactive
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { ContextEngine } from '../server/core/context_engine.js';
import { ProactiveService, renderContextForPrompt } from '../server/core/proactive_service.js';
import { JarvisOrchestrator } from '../server/core/orchestrator.js';
import { ToolRegistry } from '../server/tools/registry.js';
import { SqliteApprovalStore } from '../server/services/approval_sqlite.js';
import { openDatabase } from '../server/services/db.js';
import { RiskLevel, ToolTrust, Tool } from '../server/core/types.js';
import { AIProvider, AIProviderResponse } from '../server/providers/base.js';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail?: string) {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
function eq(name: string, actual: any, expected: any) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, ok, ok ? undefined : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function section(t: string) { console.log(`\n▸ ${t}`); }

const T0 = Date.parse('2026-08-19T09:00:00.000Z');

function setup() {
  let now = T0;
  const context = new ContextEngine({ now: () => now });
  context.registerSource({ id: 'speech', label: '音声', calibration: 'uncalibrated' });
  context.registerSource({ id: 'calendar', label: 'カレンダー', calibration: 'calibrated' });
  context.registerSource({ id: 'csi', label: 'CSI', calibration: 'uncalibrated' });
  context.registerKind({ kind: 'presence.occupied', description: '在室', validForMs: 600_000, halfLifeMs: 300_000 });
  context.registerKind({ kind: 'calendar.next_event', description: '次の予定', validForMs: 3_600_000 });
  const proactive = new ProactiveService(context, { now: () => now });
  return { context, proactive, advance: (ms: number) => { now += ms; } };
}

const AT_DESK = {
  id: 'greet_at_desk',
  description: '在席していそうなら声をかける',
  conditions: [{ kind: 'presence.occupied', equals: true, minConfidence: 0.5 }],
  suggestion: '作業を始めますか？',
  prompt: '今日のタスクを整理して',
  cooldownMs: 600_000,
};

// ---------------------------------------------------------------------------

function testSuggestions() {
  section('Silence never triggers anything');

  {
    const { proactive } = setup();
    proactive.addRule(AT_DESK);
    const [result] = proactive.evaluate();

    // Nothing has reported presence. That is not "nobody is here" — and a rule
    // that treats it as such will greet an empty room.
    check('a rule does not fire on an unobserved field', !result.fired);
    eq('and says which field was missing', result.blockedBy, 'unknown');
    eq('naming it', result.blockedOn, 'presence.occupied');
    eq('nothing is queued', proactive.listPending().length, 0);
  }

  section('A weak or stale guess is not enough');

  {
    const { context, proactive } = setup();
    proactive.addRule(AT_DESK);
    context.observe({ source: 'csi', kind: 'presence.occupied', value: true, confidence: 0.94 });

    // The source claimed 0.94; uncalibrated, it is worth 0.6.
    const [result] = proactive.evaluate();
    check('the capped confidence is what is measured', result.fired);

    const { context: c2, proactive: p2 } = setup();
    p2.addRule({ ...AT_DESK, conditions: [{ kind: 'presence.occupied', equals: true, minConfidence: 0.8 }] });
    c2.observe({ source: 'csi', kind: 'presence.occupied', value: true, confidence: 0.94 });
    const [strict] = p2.evaluate();
    check('a claim under the threshold does not fire', !strict.fired);
    eq('blocked on confidence', strict.blockedBy, 'confidence');
  }

  {
    const { context, proactive, advance } = setup();
    proactive.addRule({ ...AT_DESK, conditions: [{ kind: 'presence.occupied', equals: true, minConfidence: 0.5 }] });
    context.observe({ source: 'speech', kind: 'presence.occupied', value: true, confidence: 0.6 });

    advance(300_000); // one half-life: 0.6 -> 0.3
    const [result] = proactive.evaluate();
    check('a claim that has decayed below the threshold stops firing', !result.fired);
    eq('for the right reason', result.blockedBy, 'confidence');
  }

  {
    const { context, proactive, advance } = setup();
    proactive.addRule({
      ...AT_DESK,
      conditions: [{ kind: 'presence.occupied', equals: true, minConfidence: 0.1, maxAgeMs: 60_000 }],
    });
    context.observe({ source: 'speech', kind: 'presence.occupied', value: true, confidence: 0.6 });
    advance(120_000);
    const [result] = proactive.evaluate();
    check('an old reading does not trigger a present-tense suggestion', !result.fired);
    eq('blocked on staleness', result.blockedBy, 'stale');
  }

  section('An unmeasured sensor cannot justify an interruption on its own');

  {
    const { context, proactive } = setup();
    proactive.addRule({
      ...AT_DESK,
      conditions: [{ kind: 'presence.occupied', equals: true, minConfidence: 0.5, requireCalibrated: true }],
    });
    context.observe({ source: 'csi', kind: 'presence.occupied', value: true, confidence: 1 });

    const [result] = proactive.evaluate();
    check('a rule that demands calibration refuses an uncalibrated source', !result.fired);
    eq('and says so', result.blockedBy, 'uncalibrated');
  }

  section('While sensors disagree, there is nothing to be proactive about');

  {
    const { context, proactive } = setup();
    proactive.addRule(AT_DESK);
    context.observe({ source: 'speech', kind: 'presence.occupied', value: true, confidence: 0.6 });
    context.observe({ source: 'csi', kind: 'presence.occupied', value: false, confidence: 0.5 });

    const [result] = proactive.evaluate();
    // The winning claim clears the threshold on its own. It still must not
    // fire: if the system cannot tell what is happening, acting on the louder
    // half of a contradiction is worse than staying quiet.
    check('a contradicted field does not fire even when the winner is confident', !result.fired);
    eq('blocked on disagreement', result.blockedBy, 'disagreement');
  }

  section('An assistant, not a nag');

  {
    const { context, proactive, advance } = setup();
    proactive.addRule(AT_DESK);
    context.observe({ source: 'speech', kind: 'presence.occupied', value: true, confidence: 0.6 });

    check('it fires once', proactive.evaluate()[0].fired);
    const second = proactive.evaluate()[0];
    check('and not again immediately', !second.fired);
    eq('because of the cooldown', second.blockedBy, 'cooldown');
    eq('so only one suggestion is queued', proactive.listPending().length, 1);

    advance(600_001);
    context.observe({ source: 'speech', kind: 'presence.occupied', value: true, confidence: 0.6 });
    check('after the cooldown it may speak again', proactive.evaluate()[0].fired);
  }

  {
    const { context, proactive } = setup();
    proactive.addRule({ ...AT_DESK, cooldownMs: 0 });
    context.observe({ source: 'speech', kind: 'presence.occupied', value: true, confidence: 0.6 });
    for (let i = 0; i < 100; i++) proactive.evaluate();
    check('a queue nobody reads stays bounded', proactive.listPending().length <= 20);
  }

  section('A suggestion carries its reasons, and is only ever a proposal');

  {
    const { context, proactive } = setup();
    proactive.addRule(AT_DESK);
    context.observe({
      source: 'speech',
      kind: 'presence.occupied',
      value: true,
      confidence: 0.6,
      evidence: '確定した発話',
    });
    proactive.evaluate();

    const [suggestion] = proactive.listPending();
    eq('the suggestion is text for a person', suggestion.suggestion, '作業を始めますか？');
    eq('it names the observations behind it', suggestion.because.length, 1);
    eq('with the source', suggestion.because[0].source, 'speech');
    eq('and the confidence actually used', suggestion.because[0].confidence, 0.6);
    check('and whether that source is trustworthy as a number', suggestion.because[0].calibrated === false);

    // Accepting hands back a turn to run. It does not run it: the caller
    // decides, and the caller must mark the run as inferred.
    const accepted = proactive.accept(suggestion.id);
    eq('accepting returns the turn, not a result', accepted.prompt, '今日のタスクを整理して');
    eq('and takes it off the queue', proactive.listPending().length, 0);

    let threw = false;
    try { proactive.accept(suggestion.id); } catch { threw = true; }
    check('the same suggestion cannot be accepted twice', threw);
  }

  {
    const { context, proactive } = setup();
    proactive.addRule(AT_DESK);
    context.observe({ source: 'speech', kind: 'presence.occupied', value: true, confidence: 0.6 });
    proactive.evaluate();
    const [suggestion] = proactive.listPending();
    check('dismissing works', proactive.dismiss(suggestion.id));
    eq('and clears it', proactive.listPending().length, 0);
    check('dismissing something gone is not an error', !proactive.dismiss(suggestion.id));
  }

  {
    const { proactive } = setup();
    let threw = false;
    // A rule with no conditions fires on nothing in particular, which is just
    // an interruption on a timer.
    try { proactive.addRule({ ...AT_DESK, conditions: [] }); } catch { threw = true; }
    check('a rule with no conditions is refused', threw);
  }

  section('What the model is told about the situation');

  {
    const { context, advance } = setup();
    context.observe({ source: 'speech', kind: 'presence.occupied', value: true, confidence: 0.9 });
    advance(90_000);
    const rendered = renderContextForPrompt(context.current());

    check('it is labelled as an estimate, not a fact', /事実ではありません/.test(rendered));
    check('each line carries its age', /分前|秒前/.test(rendered));
    check('and its confidence band', /確度 (high|medium|low)/.test(rendered));
    check('an uncalibrated source is marked', /未較正/.test(rendered));

    // A model told only what is known will assume the rest. What is unknown
    // has to be said out loud.
    check('what is not known is stated', /未観測/.test(rendered));
    check('and explicitly distinguished from a negative', /否定ではありません/.test(rendered));
    eq('nothing at all renders to nothing', renderContextForPrompt({
      at: '', fields: {}, unknown: [], sources: [],
    }), '');
  }

  {
    const { context } = setup();
    context.observe({ source: 'speech', kind: 'presence.occupied', value: true, confidence: 0.6 });
    context.observe({ source: 'csi', kind: 'presence.occupied', value: false, confidence: 0.5 });
    const rendered = renderContextForPrompt(context.current());
    // The model should hesitate for the same reason a person would.
    check('a contradiction is shown to the model too', /別の観測源/.test(rendered));
  }
}

// ---------------------------------------------------------------------------

async function testBoundary() {
  section('An inferred run cannot reach an irreversible tool');

  const dir = mkdtempSync(join(tmpdir(), 'iris-proactive-'));
  const db = openDatabase(join(dir, 'p.db'));
  const approvals = new SqliteApprovalStore(db);

  try {
    const called: string[] = [];
    const registry = new ToolRegistry();
    const tools: Tool[] = [
      { name: 'read_thing', description: 'r', riskLevel: RiskLevel.READ, trust: ToolTrust.TRUSTED_CORE,
        schema: { type: 'object', properties: {} }, async execute() { called.push('read_thing'); return { ok: true }; } },
      { name: 'write_thing', description: 'w', riskLevel: RiskLevel.WRITE, trust: ToolTrust.TRUSTED_CORE,
        schema: { type: 'object', properties: {} }, async execute() { called.push('write_thing'); return { ok: true }; } },
      { name: 'send_email', description: 'e', riskLevel: RiskLevel.EXTERNAL_ACTION, trust: ToolTrust.TRUSTED_CORE,
        schema: { type: 'object', properties: {} }, async execute() { called.push('send_email'); return { ok: true }; } },
      { name: 'delete_all', description: 'd', riskLevel: RiskLevel.DESTRUCTIVE, trust: ToolTrust.TRUSTED_CORE,
        schema: { type: 'object', properties: {} }, async execute() { called.push('delete_all'); return { ok: true }; } },
    ];
    for (const t of tools) registry.register(t);

    /** Records what it was offered, and calls whatever it is told to. */
    function provider(script: string[][]): AIProvider & { offered: string[][] } {
      let turn = 0;
      const offered: string[][] = [];
      return {
        id: 'fake', vendor: 'fake', name: 'fake', currentModel: 'fake-1', offered,
        setModel() {},
        async generateResponse(_m, availableTools): Promise<AIProviderResponse> {
          offered.push(availableTools.map((t: any) => t.name));
          const names = script[turn++] ?? [];
          if (names.length === 0) return { content: 'done' };
          return {
            content: '',
            toolCalls: names.map((name, i) => ({ id: `c${turn}_${i}`, name, args: {} })),
          };
        },
      };
    }

    {
      const p = provider([['send_email'], []]);
      const orchestrator = new JarvisOrchestrator(p, registry, approvals, 6);
      const result = await orchestrator.process({ userMessage: 'x', history: [], origin: 'inferred' });

      check('an irreversible tool is not even offered', !p.offered[0].includes('send_email'));
      check('nor a destructive one', !p.offered[0].includes('delete_all'));
      check('while safe tools remain available', p.offered[0].includes('read_thing') && p.offered[0].includes('write_thing'));

      // The refusal is the guarantee; not offering it is only a courtesy.
      // A model that names it anyway must still be stopped.
      eq('naming it anyway does not execute it', called.includes('send_email'), false);
      eq('the run continues rather than dying', result.status, 'completed');
      const refusal = result.executedTools.find((t: any) => t.name === 'send_email');
      check('and the model is told why', /推定にもとづく/.test(refusal?.result?.message ?? ''));
    }

    {
      called.length = 0;
      const p = provider([['delete_all'], []]);
      const orchestrator = new JarvisOrchestrator(p, registry, approvals, 6);
      await orchestrator.process({ userMessage: 'x', history: [], origin: 'inferred' });
      eq('a destructive tool is refused the same way', called.includes('delete_all'), false);
    }

    {
      // The same tool, from a person, behaves exactly as before: gated by
      // approval, not forbidden. Restricting the user was never the point.
      called.length = 0;
      const p = provider([['send_email'], []]);
      const orchestrator = new JarvisOrchestrator(p, registry, approvals, 6);
      const result = await orchestrator.process({ userMessage: 'x', history: [], origin: 'user' });
      eq('a user-started run still reaches approval', result.status, 'requires_approval');
      eq('for the tool they asked for', result.pendingApproval?.toolName, 'send_email');
      check('and it is offered in the first place', p.offered[0].includes('send_email'));
    }

    {
      // The hole this closes: an inferred run stops at a WRITE approval, the
      // user allows that one write, and the resumed run forgets it was ever a
      // guess. The origin is persisted for exactly this.
      called.length = 0;
      const p = provider([['write_thing'], ['send_email'], []]);
      const orchestrator = new JarvisOrchestrator(p, registry, approvals, 6);
      const paused = await orchestrator.process({ userMessage: 'x', history: [], origin: 'inferred' });
      eq('an inferred run can still stop for a write', paused.status, 'requires_approval');

      const stored = approvals.getPendingBySessionId(paused.sessionId!);
      eq('and the origin is stored with it', stored?.origin, 'inferred');

      const resumed = await orchestrator.resume(paused.sessionId!, true);
      eq('the approved write runs', called.includes('write_thing'), true);
      eq('the resumed run is still an inference', called.includes('send_email'), false);
      eq('and completes', resumed.status, 'completed');
    }

    {
      // Default origin is a person. Nothing that existed before this change
      // silently became restricted.
      called.length = 0;
      const p = provider([['read_thing'], []]);
      const orchestrator = new JarvisOrchestrator(p, registry, approvals, 6);
      await orchestrator.process({ userMessage: 'x', history: [] });
      eq('an unmarked run behaves as user-started', called.includes('read_thing'), true);
    }
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  testSuggestions();
  await testBoundary();

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Proactive & origin boundary: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('All proactive tests passed.');
}

main().catch((err) => { console.error('\nTest harness crashed:', err); process.exit(1); });
