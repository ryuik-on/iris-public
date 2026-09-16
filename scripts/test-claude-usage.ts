/**
 * The Claude allowance reading, and the two days it was wrong.
 *
 * The status line hands over a snapshot and nothing rewrites it afterwards, so
 * a figure sits in the file until some Claude Code session runs again. On
 * 2026-08-25 the payload was from 08-23 23:59, its week had reset at 21:00,
 * and IRIS spent two days telling every session Claude was 100% spent while
 * the real figure was 1%. Nothing looked broken: the number was present,
 * plausible, and served without complaint.
 *
 * There were no tests over this reader at all, which is how it lasted.
 *
 * Run: npx tsx scripts/test-claude-usage.ts
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { readClaudeUsage, describesCurrentWindow } from '../server/services/claude_usage.js';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function section(name: string) { console.log(`\n▸ ${name}`); }
function eq(name: string, actual: any, expected: any) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(`${name}: ${JSON.stringify(actual)} ≠ ${JSON.stringify(expected)}`); console.log(`  ✗ ${name}`); }
}

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

/** A home directory holding one status-line payload. */
function homeWith(payload: any): string {
  const home = mkdtempSync(join(tmpdir(), 'iris-usage-'));
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', 'iris-usage.json'), JSON.stringify(payload), 'utf-8');
  return home;
}

function main() {
  const now = Date.parse('2026-08-25T12:08:00Z');

  section('A reading whose window has already reset');
  {
    /**
     * The exact shape of the 2026-08-25 failure: captured two days ago, the
     * week it describes ended in between, and the figure was 100.
     */
    const home = homeWith({
      _capturedAt: '2026-08-23T14:59:00Z',
      rate_limits: {
        seven_day: { used_percentage: 100, resets_at: Date.parse('2026-08-25T12:00:00Z') / 1000 },
        five_hour: { used_percentage: 88, resets_at: Date.parse('2026-08-23T18:00:00Z') / 1000 },
      },
    });
    const read = readClaudeUsage(home, () => now);
    eq('the spent week is not reported', read.week, null);
    eq('nor the spent five hours', read.session, null);
    // Silence would be the same failure in a different coat: something has to
    // say why there is no figure, or a caller reads it as "no limits".
    eq('and it says the record is from before', read.reason?.includes('前の期間'), true);
    // The age is still reported. It is the evidence, not the thing being hidden.
    eq('the age is still carried', read.ageMinutes, Math.round((now - Date.parse('2026-08-23T14:59:00Z')) / 60_000));
  }

  section('A reading from inside the window stands');
  {
    const home = homeWith({
      _capturedAt: '2026-08-25T12:00:00Z',
      rate_limits: {
        seven_day: { used_percentage: 1, resets_at: Date.parse('2026-08-30T12:00:00Z') / 1000 },
        five_hour: { used_percentage: 11, resets_at: Date.parse('2026-08-25T16:00:00Z') / 1000 },
      },
    });
    const read = readClaudeUsage(home, () => now);
    eq('the week is reported', read.week?.usedPercent, 1);
    eq('and the five hours too', read.session?.usedPercent, 11);
    eq('with nothing to explain', read.reason, null);
  }

  section('Unverifiable is not the same as wrong');
  {
    /**
     * Without a reset time there is nothing to compare against. Refusing the
     * reading would report "no data" for a figure that may be perfectly
     * current — which is the opposite mistake and just as silent.
     */
    const home = homeWith({
      _capturedAt: '2026-08-23T14:59:00Z',
      rate_limits: { seven_day: { used_percentage: 42 } },
    });
    eq('a reading with no reset time stands', readClaudeUsage(home, () => now).week?.usedPercent, 42);
  }

  section('The boundaries');
  {
    const resets = Date.parse('2026-08-30T12:00:00Z');
    const band = { usedPercent: 50, resetsAtMs: resets };
    eq('the moment of reset is already over', describesCurrentWindow(band, resets - DAY, 7 * DAY, resets), false);
    eq('a second before it is not', describesCurrentWindow(band, resets - DAY, 7 * DAY, resets - 1000), true);
    eq('captured exactly at the window start counts', describesCurrentWindow(band, resets - 7 * DAY, 7 * DAY, resets - 1000), true);
    eq('captured a moment earlier does not', describesCurrentWindow(band, resets - 7 * DAY - 1, 7 * DAY, resets - 1000), false);
    eq('no band is not a stale band', describesCurrentWindow(null, 0, 7 * DAY, resets), true);
  }

  section('Nothing to read');
  {
    const home = mkdtempSync(join(tmpdir(), 'iris-usage-empty-'));
    const read = readClaudeUsage(home, () => now);
    eq('a missing file says so', read.week, null);
    eq('and explains itself', read.reason?.includes('ステータス行'), true);
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`Claude usage: ${passed} passed, ${failed} failed`);
  if (failed) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('All Claude usage tests passed.');
}

main();
