/**
 * Which sessions are actually stuck, and which merely finished.
 *
 * On 2026-08-26 the band reported nine Codex sessions as unresponsive, one of
 * them for eleven hours. Every one of the nine ended with a `task_complete`
 * event — eight on the literal last line. They had all finished cleanly.
 * Nothing was stuck; the completion was written down and IRIS was reading a
 * different line.
 *
 * A false "not responding" is expensive in a way silence is not: it is the
 * one line on the band that asks a person to go and look, and nine of them
 * asking for nothing teaches them to stop looking.
 *
 * Run: npx tsx scripts/test-sessions.ts
 */
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { readSessions } from '../server/services/sessions.js';
import { PROBE_PROMPT } from '../server/services/allowance_refresh.js';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function section(name: string) { console.log(`\n▸ ${name}`); }
function eq(name: string, actual: any, expected: any) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(`${name}: ${JSON.stringify(actual)} ≠ ${JSON.stringify(expected)}`); console.log(`  ✗ ${name}`); }
}

const line = (type: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ timestamp: '2026-08-25T10:00:00.000Z', type: 'event_msg', payload: { type, ...extra } });

/** A home holding one Codex rollout with the given payload types, in order. */
function homeWithRollout(id: string, kinds: Array<string | [string, Record<string, unknown>]>): string {
  const home = mkdtempSync(join(tmpdir(), 'iris-sessions-'));
  const dir = join(home, '.codex', 'sessions', '2026', '08', '25');
  mkdirSync(dir, { recursive: true });
  const body = [
    JSON.stringify({ type: 'session_meta', payload: { cwd: '/Users/x/work/demo' } }),
    line('user_message', { message: 'これをやってください' }),
    ...kinds.map((k) => (typeof k === 'string' ? line(k) : line(k[0], k[1]))),
  ].join('\n');
  const path = join(dir, `rollout-${id}-0000.jsonl`);
  writeFileSync(path, body, 'utf-8');
  /**
   * Aged deliberately. Idleness is measured from the file's own time, so a
   * fixture written a moment ago is "working" whatever it contains — which
   * would have let both halves of this pass for the wrong reason.
   */
  const anHourAgo = new Date(Date.now() - 60 * 60_000);
  utimesSync(path, anHourAgo, anHourAgo);
  return home;
}

function doingOf(home: string): string | undefined {
  return readSessions(home, 48, Date.now()).sessions[0]?.doing;
}

function main() {
  section('A finished turn is finished, however long ago');
  {
    /**
     * The exact shape of the 2026-08-26 failure: a tool call, then the
     * assistant's closing message, then the completion event. The reader knew
     * only `agent_message`, so it kept the tool call as the last thing said.
     */
    const home = homeWithRollout('2026-08-25T19-10-23', [
      'function_call',
      ['message', { role: 'assistant' }],
      'token_count',
      'task_complete',
    ]);
    eq('the completion event is read', doingOf(home), 'waiting');
  }

  section('Either marker alone is enough');
  {
    eq(
      'the closing message on its own',
      doingOf(homeWithRollout('2026-08-25T19-10-24', ['function_call', ['message', { role: 'assistant' }]])),
      'waiting'
    );
    eq(
      'the completion event on its own',
      doingOf(homeWithRollout('2026-08-25T19-10-25', ['function_call', 'task_complete'])),
      'waiting'
    );
    // The name Codex used before, still in use elsewhere.
    eq(
      'and the old name still counts',
      doingOf(homeWithRollout('2026-08-25T19-10-26', ['function_call', 'agent_message'])),
      'waiting'
    );
  }

  section('A run that stopped mid-task is still reported');
  {
    /**
     * The one of the eleven that was real: no completion anywhere, ending on
     * a tool call. Removing the false positives must not remove this, or the
     * line stops meaning anything at all.
     */
    eq(
      'a tool call with nothing after it',
      doingOf(homeWithRollout('2026-08-26T01-15-59', ['reasoning', 'custom_tool_call'])),
      'stalled'
    );
    // A user who asked and has not been answered is also not finished.
    eq(
      'and a question left hanging',
      doingOf(homeWithRollout('2026-08-26T01-16-00', [['user_message', { message: 'まだですか' }]])),
      'stalled'
    );
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`Sessions: ${passed} passed, ${failed} failed`);
  section('IRIS 自身の空実行は、人のセッションとして出さない');
  /*
   * 二つとも実データで壊れていた分岐。
   *
   * Claude 側は照合が `titleFrom`（60文字で切る）を通した値を見ていたので、
   * プロンプトが説明を含む長文になった日から一度も一致していなかった。
   * Codex 側は照合そのものが無く、さらに**同じ発言が二つの形で記録される**
   * ため、記録の数を数えると一度きりの対話が「二回」になっていた。
   *
   * 結果、三十分ごとの空実行が 46 件、盤に「終了した作業」として並んだ。
   */
  {
    const home = mkdtempSync(join(tmpdir(), 'iris-probe-'));
    const dir = join(home, '.codex', 'sessions', '2026', '08', '25');
    mkdirSync(dir, { recursive: true });
    const aged = (path: string) => {
      const hourAgo = new Date(Date.now() - 60 * 60_000);
      utimesSync(path, hourAgo, hourAgo);
    };

    // Codex は同じプロンプトを二つの形で書く。これで「発言は一度」。
    const twice = join(dir, 'rollout-probe-0000.jsonl');
    writeFileSync(twice, [
      JSON.stringify({ type: 'session_meta', payload: { cwd: '/Users/x/work/demo' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: PROBE_PROMPT } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text: PROBE_PROMPT }] } }),
    ].join('\n'), 'utf-8');
    aged(twice);
    eq('二つの形で記録された空実行は出さない', readSessions(home, 48, Date.now()).sessions.length, 0);

    // 人が二度話していれば、それは空実行ではない。誤って消してはいけない。
    const real = join(dir, 'rollout-real-0000.jsonl');
    writeFileSync(real, [
      JSON.stringify({ type: 'session_meta', payload: { cwd: '/Users/x/work/demo' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: PROBE_PROMPT } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text: PROBE_PROMPT }] } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'やっぱり調べてほしいことがある' } }),
    ].join('\n'), 'utf-8');
    aged(real);
    const kept = readSessions(home, 48, Date.now()).sessions;
    eq('人が続けて話していれば残す', kept.length, 1);
  }

  {
    // Claude 側。プロンプトは60文字より長い — 切ってから比べると当たらない。
    const home = mkdtempSync(join(tmpdir(), 'iris-probe-c-'));
    const dir = join(home, '.claude', 'projects', 'demo');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, '11111111-2222-3333-4444-555555555555.jsonl');
    writeFileSync(path, [
      JSON.stringify({ type: 'user', message: { role: 'user', content: PROBE_PROMPT }, timestamp: new Date().toISOString() }),
    ].join('\n'), 'utf-8');
    const hourAgo = new Date(Date.now() - 60 * 60_000);
    utimesSync(path, hourAgo, hourAgo);
    eq('60文字より長い空実行のプロンプトも当たる', readSessions(home, 48, Date.now()).sessions.length, 0);
    eq('プロンプトは実際に60文字を超えている', PROBE_PROMPT.length > 60, true);
  }

  if (failed) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('All session tests passed.');
}

main();
