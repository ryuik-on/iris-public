/** A problem is shown only once it has lasted. Run: npx tsx scripts/test-problem-hold.ts */
import { ProblemHold } from '../server/core/problem_hold.js';
let passed = 0; const failures: string[] = [];
const ok = (n: string, c: boolean) => { if (c) passed++; else failures.push(n); };
let t = 0;
const h = new ProblemHold(180_000, () => t);
const cal = { id: 'google_calendar' };
ok('a problem seen for the first time is not shown', h.filter([cal]).length === 0);
t = 120_000;
ok('nor after two minutes', h.filter([cal]).length === 0);
t = 181_000;
ok('shown once it has lasted three minutes', h.filter([cal]).length === 1);
t = 200_000;
h.filter([]);
t = 210_000;
ok('a problem that went away and came back starts counting again', h.filter([cal]).length === 0);
t = 400_000;
ok('and shows again if it lasts', h.filter([cal, { id: 'icloud' }]).length === 1);
h.clear();
ok('clearing forgets what was seen', h.filter([cal]).length === 0);
console.log(`Problem hold: ${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log(failures.join('\n')); process.exit(1); }
console.log('All problem hold tests passed.');
