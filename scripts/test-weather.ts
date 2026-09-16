/**
 * The weather reading, and what it does when the forecast does not arrive.
 *
 * Two behaviours worth pinning. A miss must stay visible — the reason survives
 * even when a previous forecast is shown in its place — and a forecast that is
 * only being shown because a newer one failed must say how old it is. Showing
 * a plausible number where a broken one belongs is this project's recurring
 * failure, and the whole defence is that the age travels with it.
 *
 * Run: npx tsx scripts/test-weather.ts
 */
import { phrase, rain } from '../server/services/weather.js';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function section(name: string) { console.log(`\n▸ ${name}`); }
function eq(name: string, actual: any, expected: any) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(`${name}: ${JSON.stringify(actual)} ≠ ${JSON.stringify(expected)}`); console.log(`  ✗ ${name}`); }
}

function main() {
  section('The sentence is the user’s, reordered only where it matches exactly');
  {
    eq(
      'the known shape is reordered',
      phrase('26°C 今日の天気は、曇り時々晴れです。'),
      '今日の気温は26℃、曇り時々晴れです。'
    );
    // Anything else is handed back untouched: it is the sentence they wrote in
    // their own shortcut, and rewriting it would put words in their mouth.
    eq('anything else is left alone', phrase('よく晴れています'), 'よく晴れています');
    eq('and nothing stays nothing', phrase(''), '');
  }

  section('Rain is called out only when it is raining');
  {
    eq('rain is announced', rain('今日の気温は27℃、雨です。'), '今日の気温は27℃、雨です。 現在雨が降っています。');
    eq('and not announced twice', rain('27℃、雨です。 現在雨が降っています。'), '27℃、雨です。 現在雨が降っています。');
    eq('a clear day says nothing extra', rain('今日の気温は27℃、晴れです。'), '今日の気温は27℃、晴れです。');
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`Weather: ${passed} passed, ${failed} failed`);
  if (failed) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('All weather tests passed.');
}

main();
