/**
 * The undo record kept before anything is deleted or edited.
 *
 * Run: npx tsx scripts/test-calendar-undo.ts
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { writeUndo } from '../server/core/calendar_undo.js';

let passed = 0;
const failures: string[] = [];
const ok = (name: string, cond: boolean, detail = '') => { if (cond) passed++; else failures.push(`${name} ${detail}`); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'undo-'));
const ev = { id: 'e1', title: '病理学II予備', start: '2026-10-16T16:20:00+09:00', end: '2026-10-16T17:20:00+09:00', location: null };
const file = writeUndo(dir, { kind: 'delete', calendarId: 'g', reason: '日程表に無い', before: [ev], now: new Date('2026-10-03T01:00:00Z') });
const saved = JSON.parse(fs.readFileSync(file, 'utf-8'));
ok('the record has everything needed to put the event back', saved.calendarId === 'g' && saved.events[0].title === '病理学II予備' && saved.events[0].start === ev.start && saved.events[0].end === ev.end);
ok('and says why it was done', saved.reason === '日程表に無い' && saved.kind === 'delete');
ok('the file name says what and when', path.basename(file).startsWith('iris-delete-2026-10-03T01-00-00'));
let refused = false;
try { writeUndo(dir, { kind: 'delete', calendarId: 'g', reason: 'r', before: [], now: new Date() }); } catch { refused = true; }
ok('with nothing to record, it refuses — so nothing can be deleted without a record', refused);
let overwrote = false;
try { writeUndo(dir, { kind: 'delete', calendarId: 'g', reason: 'r', before: [ev], now: new Date('2026-10-03T01:00:00Z') }); } catch { overwrote = true; }
ok('a record is never overwritten', overwrote);
const edit = writeUndo(dir, { kind: 'edit', calendarId: 'g', reason: '終了を直す', before: [ev], after: [{ end: '2026-10-16T17:20' }], now: new Date('2026-10-03T02:00:00Z') });
ok('an edit record keeps both the before and the change', JSON.parse(fs.readFileSync(edit, 'utf-8')).after[0].end === '2026-10-16T17:20');

console.log(`Calendar undo: ${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log(failures.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
console.log('All calendar undo tests passed.');
