/**
 * Deleting IRIS's own probe transcripts, and nothing else.
 *
 * The allowance figure can only be refreshed by making a real Claude Code
 * session run, so every refresh leaves a transcript — 238 across four days.
 * Sweeping them is reasonable; sweeping one character too wide is deleting a
 * person's conversation, so the assertions here are mostly about what must
 * survive.
 *
 * Run: npx tsx scripts/test-probe-cleanup.ts
 */
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { sweepProbeTranscripts, isProbeTranscript } from '../server/services/probe_cleanup.js';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function section(name: string) { console.log(`\n▸ ${name}`); }
function eq(name: string, actual: any, expected: any) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(`${name}: ${JSON.stringify(actual)} ≠ ${JSON.stringify(expected)}`); console.log(`  ✗ ${name}`); }
}

const PROBE = 'IRIS usage probe';
const PROMPTS = new Set([PROBE, '1']);
const user = (text: string) => JSON.stringify({ type: 'user', message: { content: text } });
const assistant = () => JSON.stringify({ type: 'assistant', message: { content: 'OK' } });

function home(files: Record<string, { body: string; ageHours: number }>): string {
  const dir = mkdtempSync(join(tmpdir(), 'iris-sweep-'));
  const project = join(dir, '.claude', 'projects', 'demo');
  mkdirSync(project, { recursive: true });
  for (const [name, spec] of Object.entries(files)) {
    const path = join(project, name);
    writeFileSync(path, spec.body, 'utf-8');
    const at = new Date(Date.now() - spec.ageHours * 60 * 60_000);
    utimesSync(path, at, at);
  }
  return dir;
}

function main() {
  section('What gets swept');
  {
    const dir = home({
      'probe.jsonl': { body: [user(PROBE), assistant()].join('\n'), ageHours: 48 },
      'legacy.jsonl': { body: [user('1'), assistant()].join('\n'), ageHours: 48 },
    });
    const result = sweepProbeTranscripts(dir, PROMPTS);
    eq('both probes go', result.removed, 2);
    eq('and nothing failed', result.failures.length, 0);
  }

  section('What must survive');
  {
    const dir = home({
      // A real conversation, whatever its age.
      'work.jsonl': { body: [user('神経生理の問題を作って'), assistant()].join('\n'), ageHours: 200 },
      // A probe that somebody typed into afterwards is a conversation now.
      'used.jsonl': { body: [user(PROBE), assistant(), user('ついでに教えて')].join('\n'), ageHours: 200 },
      // Still inside the keep window: something may still be writing it.
      'fresh.jsonl': { body: [user(PROBE), assistant()].join('\n'), ageHours: 1 },
      // Not a transcript at all.
      'notes.txt': { body: user(PROBE), ageHours: 200 },
    });
    const result = sweepProbeTranscripts(dir, PROMPTS);
    eq('nothing is removed', result.removed, 0);
    const project = join(dir, '.claude', 'projects', 'demo');
    for (const name of ['work.jsonl', 'used.jsonl', 'fresh.jsonl', 'notes.txt']) {
      eq(`${name} is still there`, existsSync(join(project, name)), true);
    }
  }

  section('Recognising one');
  {
    eq('a single matching turn', isProbeTranscript([user(PROBE), assistant()].join('\n'), PROMPTS), true);
    eq('a second turn disqualifies it', isProbeTranscript([user(PROBE), user(PROBE)].join('\n'), PROMPTS), false);
    eq('a different prompt does not match', isProbeTranscript(user('こんにちは'), PROMPTS), false);
    eq('no user turn at all is not a probe', isProbeTranscript(assistant(), PROMPTS), false);
    // Structured content is what a real conversation with an image looks like.
    eq(
      'non-text content is never a probe',
      isProbeTranscript(JSON.stringify({ type: 'user', message: { content: [{ type: 'image' }] } }), PROMPTS),
      false
    );
    eq('unparseable lines are ignored, not matched', isProbeTranscript('{oops\n' + user(PROBE), PROMPTS), true);
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`Probe cleanup: ${passed} passed, ${failed} failed`);
  if (failed) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('All probe cleanup tests passed.');
}

main();
