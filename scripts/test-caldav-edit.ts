/** Editing one occurrence of a repeating iCloud event. Run: npx tsx scripts/test-caldav-edit.ts */
import { editOccurrence, stripCdata, parseInstances, pickInstance, editEvent, deleteEvent, sameOrigin } from '../server/core/caldav_edit.js';
let passed = 0; const failures: string[] = [];
const ok = (n: string, c: boolean, d = '') => { if (c) passed++; else failures.push(`${n} ${d}`); };

const series = [
  'BEGIN:VCALENDAR', 'CALSCALE:GREGORIAN', 'VERSION:2.0',
  'BEGIN:VEVENT', 'DTEND;TZID=Asia/Tokyo:20241124T203000', 'DTSTAMP:20260809T070759Z', 'DTSTART;TZID=Asia/Tokyo:20241124T153000',
  'EXDATE;TZID=Asia/Tokyo:20250323T153000', 'LAST-MODIFIED:20260809T070759Z', 'RRULE:FREQ=WEEKLY', 'SUMMARY:コスモ', 'UID:ABD5704A', 'END:VEVENT',
  'BEGIN:VEVENT', 'DTEND;TZID=Asia/Tokyo:20260621T173000', 'DTSTAMP:20260809T070759Z', 'DTSTART;TZID=Asia/Tokyo:20260621T153000',
  'RECURRENCE-ID;TZID=Asia/Tokyo:20260621T153000', 'SUMMARY:コスモ', 'UID:ABD5704A', 'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n') + '\r\n';
const edit = { recurrenceId: '20261011T153000', start: '20261011T153000', end: '20261011T173000', timeZone: 'Asia/Tokyo', now: new Date('2026-10-08T09:00:00Z') };

const r = editOccurrence('<![CDATA[' + series + ']]>', edit);
ok('a CDATA wrapper is accepted', r.ok);
if (r.ok) {
  const t = r.ics.replace(/\r\n/g, '\n');
  ok('the series definition is untouched', t.includes('RRULE:FREQ=WEEKLY') && t.includes('DTEND;TZID=Asia/Tokyo:20241124T203000') && t.includes('EXDATE;TZID=Asia/Tokyo:20250323T153000'));
  ok('the existing exception is untouched', t.includes('RECURRENCE-ID;TZID=Asia/Tokyo:20260621T153000') && t.includes('DTEND;TZID=Asia/Tokyo:20260621T173000'));
  ok('a new exception is added for that one occurrence, same UID', t.includes('RECURRENCE-ID;TZID=Asia/Tokyo:20261011T153000') && t.includes('DTEND;TZID=Asia/Tokyo:20261011T173000') && (t.match(/UID:ABD5704A/g) ?? []).length === 3);
  ok('three events now, one calendar', (t.match(/BEGIN:VEVENT/g) ?? []).length === 3 && (t.match(/BEGIN:VCALENDAR/g) ?? []).length === 1 && t.trimEnd().endsWith('END:VCALENDAR'));
  ok('it was a new exception, not a replacement', r.replaced === false);
  ok('line endings are CRLF', /\r\n/.test(r.ics) && !/[^\r]\n/.test(r.ics));
  const again = editOccurrence(r.ics, { ...edit, end: '20261011T180000' });
  ok('editing the same occurrence again replaces its exception rather than adding another', again.ok && again.replaced && (again.ics.match(/BEGIN:VEVENT/g) ?? []).length === 3 && again.ics.includes('20261011T180000'));
}
ok('a file with no repeating series is refused (not silently rewritten)', !editOccurrence('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x\r\nDTSTART:20261011T153000\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n', edit).ok);
ok('garbage is refused', !editOccurrence('hello', edit).ok);
ok('stripCdata leaves plain text alone', stripCdata('BEGIN:VCALENDAR') === 'BEGIN:VCALENDAR');
const long = editOccurrence(series.replace('SUMMARY:コスモ\r\nUID:ABD5704A\r\nEND:VEVENT\r\nBEGIN:VEVENT', 'SUMMARY:' + 'あ'.repeat(60) + '\r\nUID:ABD5704A\r\nEND:VEVENT\r\nBEGIN:VEVENT'), edit);
ok('long Japanese lines are folded within 75 bytes', long.ok && long.ics.split('\r\n').every((l) => Buffer.byteLength(l, 'utf8') <= 75));
// ── 回ごとに読む・絞る・直す・消す
const expanded = [
  'BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:SER', 'SUMMARY:コスモ', 'DTSTART:20261011T063000Z', 'DTEND:20261011T113000Z', 'RECURRENCE-ID:20261011T063000Z', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:ONE', 'SUMMARY:病理学I各論試験（再）', 'DTSTART;TZID=Asia/Tokyo:20261029T083000', 'DTEND;TZID=Asia/Tokyo:20261029T093000', 'LOCATION:教育棟', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:TWO', 'SUMMARY:病理学I各論試験', 'DTSTART;TZID=Asia/Tokyo:20261029T083000', 'DTEND;TZID=Asia/Tokyo:20261029T104000', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:CAN', 'SUMMARY:取り消し', 'STATUS:CANCELLED', 'DTSTART:20261011T000000Z', 'END:VEVENT', 'END:VCALENDAR',
].join('\r\n');
const inst = parseInstances(expanded, 'Asia/Tokyo');
ok('UTC times become local, and the occurrence mark becomes the local slot start', inst[0].start === '2026-10-11T15:30' && inst[0].end === '2026-10-11T20:30' && inst[0].recurrenceId === '20261011T153000', JSON.stringify(inst[0]));
ok('a plain event keeps its local time, location and no recurrence mark', inst[1].start === '2026-10-29T08:30' && inst[1].location === '教育棟' && inst[1].recurrenceId === null);
ok('cancelled events are not instances', !inst.some((i) => i.uid === 'CAN'));
ok('the longer title picks its own event, the shorter picks the exact one', pickInstance(inst, '2026-10-29', '病理学Ⅰ各論試験（再）')?.uid === 'ONE' && pickInstance(inst, '2026-10-29', '病理学I各論試験')?.uid === 'TWO');
ok('a vague title is not guessed', pickInstance(inst, '2026-10-29', '病理学') === null);
ok('another day finds nothing', pickInstance(inst, '2026-10-30', 'コスモ') === null);

const single = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:ONE', 'SUMMARY:面談', 'DTSTART;TZID=Asia/Tokyo:20261019T100000', 'DTEND;TZID=Asia/Tokyo:20261019T110000', 'LOCATION:旧', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n') + '\r\n';
const target = { recurrenceId: null, current: { start: '2026-10-19T10:00', end: '2026-10-19T11:00', title: '面談', location: '旧' } };
const e1 = editEvent(single, target, { end: '2026-10-19T11:30', title: '面談 田中さん' });
ok('a single event is changed in place, only the named fields', e1.ok && e1.ics.includes('DTEND;TZID=Asia/Tokyo:20261019T113000') && e1.ics.includes('SUMMARY:面談 田中さん') && e1.ics.includes('DTSTART;TZID=Asia/Tokyo:20261019T100000') && e1.ics.includes('LOCATION:旧') && (e1.ics.match(/BEGIN:VEVENT/g) ?? []).length === 1);
const e2 = editEvent(series, { recurrenceId: '20261011T153000', current: { start: '2026-10-11T15:30', end: '2026-10-11T20:30', title: 'コスモ', location: null } }, { end: '2026-10-11T17:30', title: 'コスモ（短縮）' });
ok('one occurrence of a series gets an exception carrying the new title and time', e2.ok && e2.ics.includes('RECURRENCE-ID;TZID=Asia/Tokyo:20261011T153000') && e2.ics.includes('SUMMARY:コスモ（短縮）') && e2.ics.includes('DTEND;TZID=Asia/Tokyo:20261011T173000') && e2.ics.includes('RRULE:FREQ=WEEKLY'));
ok('a single-event edit on a series file is refused', !editEvent(series, { recurrenceId: null, current: target.current }, { end: '2026-10-11T17:30' }).ok);

const d1 = deleteEvent(single, { recurrenceId: null });
ok('deleting a single event means deleting the file', d1.ok && d1.kind === 'resource');
const d2 = deleteEvent(series, { recurrenceId: '20261011T153000' });
ok('deleting one occurrence adds an exclusion date and leaves the series', d2.ok && d2.kind === 'occurrence' && d2.ics.includes('EXDATE;TZID=Asia/Tokyo:20261011T153000') && d2.ics.includes('RRULE:FREQ=WEEKLY'));
const d3 = deleteEvent(series, { recurrenceId: '20260621T153000' });
ok('deleting an occurrence that had an exception also removes the exception', d3.ok && d3.kind === 'occurrence' && !d3.ics.includes('RECURRENCE-ID;TZID=Asia/Tokyo:20260621T153000') && d3.ics.includes('EXDATE;TZID=Asia/Tokyo:20260621T153000'));
ok('deleting a single from a series file is refused (never the whole series by accident)', !deleteEvent(series, { recurrenceId: null }).ok);

ok('the same iCloud host is the same origin', sameOrigin('https://p156-caldav.icloud.com/1/calendars/x/a.ics', 'https://p156-caldav.icloud.com/1/calendars/x/'));
ok('another host is not', !sameOrigin('https://evil.example.com/a.ics', 'https://p156-caldav.icloud.com/1/calendars/x/'));
ok('another iCloud host is not either', !sameOrigin('https://p99-caldav.icloud.com/a.ics', 'https://p156-caldav.icloud.com/1/'));
ok('plain http is refused even for the same host', !sameOrigin('http://p156-caldav.icloud.com/a.ics', 'http://p156-caldav.icloud.com/'));
ok('garbage is refused', !sameOrigin('not a url', 'https://p156-caldav.icloud.com/'));

console.log(`CalDAV edit: ${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log(failures.join('\n')); process.exit(1); }
console.log('All CalDAV edit tests passed.');
