/**
 * Context Engine tests.
 *
 * The failure this layer exists to prevent is a confident wrong answer. Every
 * section below is a way that happens:
 *
 *   - silence read as a negative ("nobody has reported presence" → "empty")
 *   - a stale reading presented as a current one
 *   - an uncalibrated number believed as a probability
 *   - two sensors disagreeing, and only one being shown
 *
 * Run: npm run test:context
 */
import {
  ContextEngine,
  UnknownSourceError,
  UnknownKindError,
} from '../server/core/context_engine.js';

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

function makeEngine() {
  let now = T0;
  const engine = new ContextEngine({ now: () => now });

  engine.registerSource({ id: 'speech', label: 'オンデバイス音声', calibration: 'calibrated' });
  engine.registerSource({ id: 'csi', label: 'Wi-Fi CSI', calibration: 'uncalibrated' });
  engine.registerSource({ id: 'device', label: '端末状態', calibration: 'calibrated' });
  engine.registerSource({ id: 'calendar', label: 'カレンダー', calibration: 'calibrated' });

  engine.registerKind({
    kind: 'presence.occupied',
    description: '在室',
    validForMs: 10 * 60_000,
    halfLifeMs: 5 * 60_000,
  });
  engine.registerKind({
    kind: 'location.zone',
    description: '居場所',
    validForMs: 30 * 60_000,
    halfLifeMs: 10 * 60_000,
  });
  engine.registerKind({
    kind: 'user.stated_goal',
    description: '本人が述べた目的',
    validForMs: 24 * 60 * 60_000,
  });
  // 減衰なし。同点のときに新旧どちらが勝つかを、この種で確かめる。
  engine.registerKind({
    kind: 'calendar.next_event',
    description: '次の予定',
    validForMs: 6 * 60 * 60_000,
  });

  return { engine, advance: (ms: number) => { now += ms; }, at: () => now };
}

function main() {
  // -----------------------------------------------------------------------
  section('Silence is not a negative answer');

  {
    const { engine } = makeEngine();
    const snapshot = engine.current();

    // The bug this prevents: a house with no presence sensor reporting looks
    // empty, and something acts on "empty".
    eq('nothing observed means no fields', Object.keys(snapshot.fields).length, 0);
    check('and the unknowns are named, not omitted', snapshot.unknown.includes('presence.occupied'));
    eq('asking directly returns unknown rather than false', engine.field('presence.occupied'), null);
  }

  // -----------------------------------------------------------------------
  section('Freshness belongs to the field, not the snapshot');

  {
    const { engine, advance } = makeEngine();
    engine.observe({ source: 'csi', kind: 'presence.occupied', value: true, confidence: 0.5 });
    advance(40 * 60_000);
    engine.observe({ source: 'device', kind: 'user.stated_goal', value: '執筆', confidence: 1 });

    const snapshot = engine.current();

    // This is the whole reason the snapshot is derived rather than stored:
    // one confidence for the object would have handed these over as equals.
    eq('a reading past its validity is gone, not stale-but-present', snapshot.fields['presence.occupied'], undefined);
    check('and is listed as unknown', snapshot.unknown.includes('presence.occupied'));
    eq('while a fresh field is present', snapshot.fields['user.stated_goal'].value, '執筆');
    eq('carrying its own age', snapshot.fields['user.stated_goal'].ageMs, 0);
  }

  {
    const { engine, advance } = makeEngine();
    engine.observe({ source: 'speech', kind: 'presence.occupied', value: true, confidence: 0.9 });
    advance(200);
    engine.observe({ source: 'csi', kind: 'location.zone', value: 'desk_area', confidence: 0.6 });
    advance(40 * 60_000);
    engine.observe({ source: 'speech', kind: 'presence.occupied', value: true, confidence: 0.9 });

    const snapshot = engine.current();
    eq('the 200ms-old presence reading is current', snapshot.fields['presence.occupied'].ageMs, 0);
    check(
      'and the 40-minute-old location is not carried alongside it',
      snapshot.unknown.includes('location.zone')
    );
  }

  // -----------------------------------------------------------------------
  section('Age lowers confidence, and can never raise it');

  {
    const { engine, advance } = makeEngine();
    engine.observe({ source: 'speech', kind: 'presence.occupied', value: true, confidence: 0.9 });

    const fresh = engine.field('presence.occupied')!;
    eq('a fresh reading keeps what the source said', fresh.confidence, 0.9);
    check('and is not marked decayed', !fresh.decayed);

    advance(5 * 60_000); // one half-life
    const aged = engine.field('presence.occupied')!;
    check('after a half-life the claim is weaker', aged.confidence < fresh.confidence);
    check('by about half', Math.abs(aged.confidence - 0.45) < 0.01, String(aged.confidence));
    check('and says so', aged.decayed);
    eq('while still reporting what the source originally claimed', aged.reportedConfidence, 0.9);
    check('the ordinal band moves with it', aged.band === 'medium');

    // Nothing in this layer may manufacture certainty a sensor did not supply.
    advance(1);
    check('confidence never rises with age', engine.field('presence.occupied')!.confidence <= aged.confidence);
  }

  {
    // Some claims do not weaken. A stated goal is not less true for being
    // said an hour ago; it is only wrong once it is superseded.
    const { engine, advance } = makeEngine();
    engine.observe({ source: 'device', kind: 'user.stated_goal', value: '執筆', confidence: 1 });
    advance(6 * 60 * 60_000);
    const field = engine.field('user.stated_goal')!;
    eq('a claim with no half-life keeps its confidence', field.confidence, 1);
    check('but still reports its age honestly', field.ageMs === 6 * 60 * 60_000);
  }

  // -----------------------------------------------------------------------
  section('An uncalibrated source does not get to sound certain');

  {
    const { engine } = makeEngine();
    // The 0.94 from the roadmap sketch, from a source that has never been
    // measured against reality.
    const observation = engine.observe({
      source: 'csi',
      kind: 'presence.occupied',
      value: true,
      confidence: 0.94,
    });

    check('the claim is capped', observation.effectiveConfidence < 0.94);
    eq('at the uncalibrated ceiling', observation.effectiveConfidence, 0.6);

    const field = engine.field('presence.occupied')!;
    eq('the derived field is capped too', field.confidence, 0.6);
    eq('what the source claimed is still recorded', field.reportedConfidence, 0.94);
    check('and it is labelled uncalibrated', !field.calibrated);
    check('so a consumer can use the band instead of the number', field.band === 'medium');
  }

  {
    const { engine } = makeEngine();
    engine.observe({ source: 'speech', kind: 'presence.occupied', value: true, confidence: 0.94 });
    const field = engine.field('presence.occupied')!;
    eq('a calibrated source is taken at its word', field.confidence, 0.94);
    check('and marked as calibrated', field.calibrated);
  }

  // -----------------------------------------------------------------------
  section('Disagreement is reported, not resolved away');

  {
    const { engine } = makeEngine();
    engine.observe({ source: 'speech', kind: 'presence.occupied', value: true, confidence: 0.9 });
    engine.observe({ source: 'csi', kind: 'presence.occupied', value: false, confidence: 0.6 });

    const field = engine.field('presence.occupied')!;
    eq('the strongest current claim is the answer', field.value, true);
    eq('and it names its source', field.source, 'speech');
    check('the dissenting sensor is surfaced', field.disagreement?.length === 1);
    eq('with what it actually claimed', field.disagreement![0].value, false);

    // A fusion layer that hides a conflict is reporting more certainty than
    // it has. Whoever consumes this needs to be able to hesitate.
    eq('and which sensor said it', field.disagreement![0].source, 'csi');
  }

  {
    const { engine } = makeEngine();
    engine.observe({ source: 'speech', kind: 'presence.occupied', value: true, confidence: 0.9 });
    engine.observe({ source: 'csi', kind: 'presence.occupied', value: true, confidence: 0.6 });
    const field = engine.field('presence.occupied')!;
    check('agreement is not reported as disagreement', field.disagreement === undefined);
  }

  {
    // A sensor repeating itself is not extra evidence.
    const { engine, advance } = makeEngine();
    engine.observe({ source: 'speech', kind: 'presence.occupied', value: true, confidence: 0.9 });
    for (let i = 0; i < 5; i++) {
      advance(100);
      engine.observe({ source: 'csi', kind: 'presence.occupied', value: false, confidence: 0.6 });
    }
    const field = engine.field('presence.occupied')!;
    eq('one entry per dissenting source, not per reading', field.disagreement!.length, 1);
  }

  {
    // 源が言い直したら、それがその源の言い分。古い言い分は異論ではない。
    //
    // 実測 2026-09-11：08:30 の講義が始まり「次の予定」が naruto に変わったのに、
    // 確度が同点で古い観測が勝ち、新しい値に「不一致」が付いていた。
    const { engine, advance } = makeEngine();
    engine.observe({ source: 'calendar', kind: 'calendar.next_event', value: { title: '病理学Ⅱ' }, confidence: 1 });
    advance(30 * 60_000);
    engine.observe({ source: 'calendar', kind: 'calendar.next_event', value: { title: 'naruto' }, confidence: 1 });
    const field = engine.field('calendar.next_event')!;
    eq('the latest claim from a source is its claim', (field.value as any).title, 'naruto');
    check('and its own earlier claim is not reported as dissent', field.disagreement === undefined);
  }

  {
    // 別の源との異論は、引き続き立つ。
    const { engine, advance } = makeEngine();
    engine.observe({ source: 'calendar', kind: 'calendar.next_event', value: { title: 'A' }, confidence: 1 });
    advance(1000);
    engine.observe({ source: 'speech', kind: 'calendar.next_event', value: { title: 'B' }, confidence: 0.9 });
    const field = engine.field('calendar.next_event')!;
    eq('the stronger source wins', (field.value as any).title, 'A');
    eq('and the other source is still surfaced', field.disagreement?.[0].source, 'speech');
  }

  // -----------------------------------------------------------------------
  section('Observations are facts about moments');

  {
    const { engine, advance } = makeEngine();
    engine.observe({ source: 'csi', kind: 'location.zone', value: 'kitchen', confidence: 0.5 });
    advance(60_000);
    engine.observe({ source: 'csi', kind: 'location.zone', value: 'desk_area', confidence: 0.5 });

    eq('the newest observation wins the derived field', engine.field('location.zone')!.value, 'desk_area');

    // "When did this stop being true" is a question the derived view cannot
    // answer, so the record is kept.
    const history = engine.history('location.zone');
    eq('the earlier observation is not overwritten', history.length, 2);
    eq('and stays in observation order', history[0].value, 'kitchen');
  }

  {
    // A source reporting late must not look like the newest thing known.
    const { engine, advance } = makeEngine();
    advance(60_000);
    engine.observe({ source: 'csi', kind: 'location.zone', value: 'desk_area', confidence: 0.5 });
    engine.observe({
      source: 'csi',
      kind: 'location.zone',
      value: 'kitchen',
      confidence: 0.5,
      observedAt: new Date(T0).toISOString(),
    });
    const history = engine.history('location.zone');
    eq('history is ordered by when it happened, not when it arrived', history.map((h) => h.value), ['kitchen', 'desk_area']);
  }

  {
    const { engine } = makeEngine();
    engine.observe({
      source: 'csi',
      kind: 'presence.occupied',
      value: true,
      confidence: 0.5,
      observedAt: new Date(T0 + 60_000).toISOString(),
    });
    // A clock skew is a fault, not a fresher truth.
    eq('an observation from the future is not used', engine.field('presence.occupied'), null);
  }

  // -----------------------------------------------------------------------
  section('Nothing is accepted from a source or kind nobody described');

  {
    const { engine } = makeEngine();
    let err: any;
    try { engine.observe({ source: 'mystery', kind: 'presence.occupied', value: true, confidence: 1 }); }
    catch (e) { err = e; }
    check('an unregistered source is refused', err instanceof UnknownSourceError);

    err = undefined;
    try { engine.observe({ source: 'csi', kind: 'mood.happy', value: true, confidence: 1 }); }
    catch (e) { err = e; }
    // Without a descriptor there is no validity window, so nothing could ever
    // decide when the reading expires.
    check('an undescribed kind is refused', err instanceof UnknownKindError);

    err = undefined;
    try { engine.registerKind({ kind: 'x', description: 'x', validForMs: 0 }); }
    catch (e) { err = e; }
    check('a kind that never expires by accident is refused', err !== undefined);
  }

  {
    const { engine } = makeEngine();
    const observation = engine.observe({ source: 'speech', kind: 'presence.occupied', value: true, confidence: 4 });
    eq('an out-of-range confidence is clamped', observation.confidence, 1);
    const nan = engine.observe({ source: 'speech', kind: 'presence.occupied', value: true, confidence: NaN });
    eq('and a nonsense one becomes zero rather than infinity', nan.confidence, 0);
  }

  // -----------------------------------------------------------------------
  section('Memory is bounded, and can be dropped on request');

  {
    let now = T0;
    const engine = new ContextEngine({ now: () => now, historyLimit: 10 });
    engine.registerSource({ id: 'csi', label: 'CSI', calibration: 'uncalibrated' });
    engine.registerKind({ kind: 'presence.occupied', description: '在室', validForMs: 60_000 });

    for (let i = 0; i < 50; i++) {
      now += 10;
      engine.observe({ source: 'csi', kind: 'presence.occupied', value: i, confidence: 0.5 });
    }
    eq('history is capped', engine.history('presence.occupied', 100).length, 10);
    eq('keeping the most recent', engine.history('presence.occupied').at(-1)!.value, 49);

    // A record of when someone was home is not a neutral thing to hold.
    eq('forgetting reports how much it dropped', engine.forget('presence.occupied'), 10);
    eq('and the field returns to unknown', engine.field('presence.occupied'), null);
  }

  // -----------------------------------------------------------------------
  section('The snapshot says what it is made of');

  {
    const { engine } = makeEngine();
    engine.observe({ source: 'speech', kind: 'presence.occupied', value: true, confidence: 0.9 });
    engine.observe({ source: 'csi', kind: 'location.zone', value: 'desk_area', confidence: 0.9 });

    const snapshot = engine.current();
    const sources = Object.fromEntries(snapshot.sources.map((s) => [s.id, s]));
    check('each source reports whether it is calibrated', sources.speech.calibrated && !sources.csi.calibrated);
    eq('and how much it has contributed', sources.speech.observations, 1);
    check('unknown kinds are still listed', snapshot.unknown.includes('user.stated_goal'));
    check('the capped field shows both numbers', snapshot.fields['location.zone'].confidence === 0.6);
    eq('and what was claimed', snapshot.fields['location.zone'].reportedConfidence, 0.9);
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Context engine: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('All context tests passed.');
}

main();
