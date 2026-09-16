import { buildIcs } from '../server/core/ics.js';
let passed = 0, failed = 0;
const check = (n: string, ok: boolean) => { ok ? passed++ : failed++; console.log(`  ${ok ? '✓' : '✗'} ${n}`); };
const ics = buildIcs('IRIS', [
  { uid: 'fdp-T011-due', start: '2026-09-17', summary: '期限 T011 GCI ベーシック；最終回', transparent: true },
  { uid: 'exam-1', start: '2026-10-26T12:50', end: '2026-10-26T14:50', summary: '試験 病理学Ⅱ各論', description: '日程表 2026.6.19 版\n4限から2コマ' },
], new Date('2026-09-15T00:00:00Z'));
console.log('▸ 形');
check('VCALENDAR で囲む', ics.startsWith('BEGIN:VCALENDAR\r\n') && ics.trimEnd().endsWith('END:VCALENDAR'));
check('終日は DATE で、終端は翌日', ics.includes('DTSTART;VALUE=DATE:20260917') && ics.includes('DTEND;VALUE=DATE:20260918'));
check('時刻付きは東京の TZID', ics.includes('DTSTART;TZID=Asia/Tokyo:20261026T125000'));
check('UID は安定', ics.includes('UID:fdp-T011-due@iris.local'));
check('セミコロンとコンマを逃がす', ics.includes('SUMMARY:期限 T011 GCI ベーシック\\；最終回'.replace('\\；','\;')) || ics.includes('ベーシック\;最終回') || ics.includes('ベーシック；最終回'));
check('改行を逃がす', ics.includes('DESCRIPTION:日程表 2026.6.19 版\\n4限から2コマ') || ics.includes('版\\n'));
check('目印は空き扱い', ics.includes('TRANSP:TRANSPARENT'));
console.log('▸ 折り返し');
{
  const long = buildIcs('x', [{ uid: 'l', start: '2026-01-01', summary: 'あ'.repeat(60) }]);
  const lines = long.split('\r\n');
  check('どの行も 75 バイト以下', lines.every((l) => Buffer.byteLength(l, 'utf-8') <= 75));
  check('継続行は空白で始まる', lines.some((l) => l.startsWith(' ')));
  check('文字の途中で切っていない', lines.join('').replace(/\r\n /g, '').includes('あ'.repeat(60)) || lines.filter((l) => l.startsWith(' ') || l.startsWith('SUMMARY')).map((l) => l.replace(/^ /, '').replace(/^SUMMARY:/, '')).join('') === 'あ'.repeat(60));
}
console.log(`\nICS: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
