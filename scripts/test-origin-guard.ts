import { isForeignOrigin, isUntrustedLoopbackHost } from '../server/core/origin_guard.js';

let passed = 0;
const failures: string[] = [];
const eq = (name: string, a: unknown, b: unknown) => { if (JSON.stringify(a) === JSON.stringify(b)) passed++; else failures.push(`${name}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };

eq('Origin が無ければ対象外（HUD・curl）', isForeignOrigin(undefined, '127.0.0.1:3002'), false);
eq('同じサイトは通す', isForeignOrigin('http://127.0.0.1:3002', '127.0.0.1:3002'), false);
eq('スマホが機械の IP で開いたページも通す', isForeignOrigin('http://192.168.1.5:3002', '192.168.1.5:3002'), false);
eq('別のサイトは止める', isForeignOrigin('https://evil.example', '127.0.0.1:3002'), true);
eq('同じ機械の別のポートのページも止める', isForeignOrigin('http://127.0.0.1:8080', '127.0.0.1:3002'), true);
eq('Origin: null は止める', isForeignOrigin('null', '127.0.0.1:3002'), true);
eq('読めない Origin は止める', isForeignOrigin('not a url', '127.0.0.1:3002'), true);
eq('許可の一覧にあれば通す', isForeignOrigin('http://localhost:5173', '127.0.0.1:3002', ['http://localhost:5173']), false);
eq('大文字小文字は区別しない', isForeignOrigin('http://LOCALHOST:3002', 'localhost:3002'), false);

// Host（DNS リバインディング）
eq('同じ機械から、127.0.0.1 の名前は通す', isUntrustedLoopbackHost('127.0.0.1:3002', true, 3002), false);
eq('localhost も通す', isUntrustedLoopbackHost('localhost:3002', true, 3002), false);
eq('[::1] も通す', isUntrustedLoopbackHost('[::1]:3002', true, 3002), false);
eq('攻撃者の名前（127.0.0.1 に向けたもの）は止める', isUntrustedLoopbackHost('evil.example:3002', true, 3002), true);
eq('Host が無ければ止める', isUntrustedLoopbackHost(undefined, true, 3002), true);
eq('ポートが違えば止める', isUntrustedLoopbackHost('127.0.0.1:8080', true, 3002), true);
eq('別の機器からは対象外（合言葉が要る）', isUntrustedLoopbackHost('192.168.1.5:3002', false, 3002), false);
eq('許可の一覧にあれば通す', isUntrustedLoopbackHost('iris.local:3002', true, 3002, ['iris.local:3002']), false);

console.log(`Origin guard: ${passed} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
console.log('All origin guard tests passed.');
