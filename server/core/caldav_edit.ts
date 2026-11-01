/**
 * 繰り返しの予定の「その回だけ」を直す（iCloud / CalDAV）。
 *
 * 毎週の予定は一つのファイルで、**元の定義**（RRULE）と、**回ごとの例外**（RECURRENCE-ID）が
 * 同じファイルに入っている。元の定義を直すと全部の回が変わるので、**その回の例外を足す**。
 * 既にその回の例外があれば、その時刻を直す。ほかの行は、一字も変えない。
 *
 * 利用者「今週、コスモのシフトが変わっていて、日曜は 15:30〜17:30 に訂正して」（2026-10-08）。
 * 同じファイルの過去の例外（2026-06-21 の 15:30〜17:30 など）が、この形で入っている。
 */

/** 応答に混ざる `<![CDATA[ … ]]>` を外す。 */
export function stripCdata(s: string): string {
  return s.replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '');
}

function unfold(ics: string): string[] {
  return ics.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
}

function fold(line: string): string {
  // 75 バイトで折る（RFC 5545）。日本語は文字単位で、バイトを超えない所で切る。
  const out: string[] = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch, 'utf8');
    if (bytes + b > (out.length === 0 ? 75 : 74)) { out.push(cur); cur = ch; bytes = b; } else { cur += ch; bytes += b; }
  }
  out.push(cur);
  return out.map((l, i) => (i === 0 ? l : ` ${l}`)).join('\r\n');
}

export interface OccurrenceEdit {
  /** 元の回の開始（例外の目印）。`20261011T153000`。 */
  recurrenceId: string;
  /** 新しい開始・終了。`20261011T153000` の形。 */
  start: string;
  end: string;
  timeZone: string;
  now?: Date;
}

export type EditResult = { ok: true; ics: string; replaced: boolean } | { ok: false; reason: string };

export function editOccurrence(raw: string, edit: OccurrenceEdit): EditResult {
  const lines = unfold(stripCdata(raw)).filter((l) => l !== '');
  const begin = lines.indexOf('BEGIN:VCALENDAR');
  const endIdx = lines.lastIndexOf('END:VCALENDAR');
  if (begin < 0 || endIdx < 0) return { ok: false, reason: '予定のファイルとして読めませんでした。' };

  // VEVENT ごとに切る。
  const events: string[][] = [];
  const head: string[] = [];
  let cur: string[] | null = null;
  for (let i = begin; i <= endIdx; i++) {
    const l = lines[i];
    if (l === 'BEGIN:VEVENT') { cur = [l]; continue; }
    if (l === 'END:VEVENT' && cur) { cur.push(l); events.push(cur); cur = null; continue; }
    if (cur) cur.push(l); else if (l !== 'END:VCALENDAR') head.push(l);
  }
  const master = events.find((e) => e.some((l) => l.startsWith('RRULE')) && !e.some((l) => l.startsWith('RECURRENCE-ID')));
  if (!master) return { ok: false, reason: '繰り返しの元の定義が見つかりません。この予定は繰り返しではない可能性があります。' };

  const uid = master.find((l) => l.startsWith('UID:'));
  const summary = master.find((l) => l.startsWith('SUMMARY'));
  if (!uid) return { ok: false, reason: 'UID が見つかりません。' };

  const rid = (l: string) => /^RECURRENCE-ID[;:]/.test(l) && l.replace(/^[^:]*:/, '') === edit.recurrenceId;
  const when = (name: string, v: string) => `${name};TZID=${edit.timeZone}:${v}`;
  const stamp = (edit.now ?? new Date()).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

  const existing = events.findIndex((e) => e.some(rid));
  let replaced = false;
  if (existing >= 0) {
    replaced = true;
    events[existing] = events[existing].map((l) =>
      /^DTSTART[;:]/.test(l) ? when('DTSTART', edit.start)
      : /^DTEND[;:]/.test(l) ? when('DTEND', edit.end)
      : /^DTSTAMP/.test(l) ? `DTSTAMP:${stamp}`
      : /^LAST-MODIFIED/.test(l) ? `LAST-MODIFIED:${stamp}`
      : l);
  } else {
    events.push([
      'BEGIN:VEVENT',
      when('DTEND', edit.end),
      `DTSTAMP:${stamp}`,
      when('DTSTART', edit.start),
      `LAST-MODIFIED:${stamp}`,
      when('RECURRENCE-ID', edit.recurrenceId),
      ...(summary ? [summary] : []),
      uid,
      'END:VEVENT',
    ]);
  }

  const all = [...head.slice(0, 1), ...head.slice(1), ...events.flat(), 'END:VCALENDAR'];
  return { ok: true, ics: all.map(fold).join('\r\n') + '\r\n', replaced };
}

// ─────────────────────────────────────────────────────────────────────────────
// 予定を探す・直す・消す（繰り返しの「その回」も、単発も）
// ─────────────────────────────────────────────────────────────────────────────

export interface IcsInstance {
  uid: string;
  /** 繰り返しの回の目印（元の開始）。単発なら null。 */
  recurrenceId: string | null;
  title: string;
  /** `YYYY-MM-DDTHH:mm`（現地）。終日は `YYYY-MM-DD`。 */
  start: string;
  end: string | null;
  location: string | null;
  allDay: boolean;
}

const unescapeText = (v: string) => v.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');

/** `20261011T153000`（TZID 付き・Z なし）や `20261011` を、`2026-10-11T15:30` に。UTC の `Z` は、そのまま現地に直さない（呼び手が展開済みの現地値を渡す前提）。 */
function localStamp(v: string): { text: string; allDay: boolean; utc: boolean } {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(v.trim());
  if (!m) return { text: v, allDay: false, utc: false };
  if (m[4] === undefined) return { text: `${m[1]}-${m[2]}-${m[3]}`, allDay: true, utc: false };
  return { text: `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}`, allDay: false, utc: m[7] === 'Z' };
}

/** `20261011T063000Z`（UTC）を、現地の `20261011T153000` に。もとから現地のものは、そのまま。 */
function ridLocal(v: string, timeZone: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(v.trim());
  if (!m) return v.trim();
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
  const parts = new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(d);
  return parts.replace(/[-: ]/g, '').replace(/^(\d{8})(\d{6})$/, '$1T$2');
}

/** 展開済みの（または元の）iCalendar から、各回を取り出す。取り消し（CANCELLED）は除く。 */
export function parseInstances(ics: string, timeZone = 'Asia/Tokyo'): IcsInstance[] {
  const out: IcsInstance[] = [];
  for (const block of unfold(stripCdata(ics)).join('\n').split('BEGIN:VEVENT').slice(1)) {
    const body = block.split('END:VEVENT')[0].split('\n');
    const get = (name: string) => body.find((l) => new RegExp(`^${name}[;:]`).test(l));
    const val = (l?: string) => (l ? l.replace(/^[^:]*:/, '') : '');
    if (/CANCELLED/i.test(val(get('STATUS')))) continue;
    const uid = val(get('UID'));
    const ds = get('DTSTART');
    if (!uid || !ds) continue;
    const start = localStamp(val(ds));
    const de = get('DTEND');
    const toLocal = (l: string, st: { text: string; utc: boolean }) => {
      if (!st.utc) return st.text;
      // UTC は、指定の時間帯の現地時刻に直す。
      const d = new Date(`${st.text}:00Z`);
      const parts = new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(d);
      return parts.replace(' ', 'T');
    };
    const end = de ? localStamp(val(de)) : null;
    const rid = get('RECURRENCE-ID');
    out.push({
      uid,
      recurrenceId: rid ? ridLocal(val(rid), timeZone) : null,
      title: unescapeText(val(get('SUMMARY'))) || '(無題)',
      start: toLocal(ds, start),
      end: end ? toLocal(de!, end) : null,
      location: val(get('LOCATION')) ? unescapeText(val(get('LOCATION'))) : null,
      allDay: start.allDay,
    });
  }
  return out;
}

/** 題の照合は、全角・半角、空白、ローマ数字の違いを同じとみなす。 */
const fold2 = (t: string) => t.normalize('NFKC').replace(/[\s　]+/g, '');

/**
 * ある日の、題が合う予定を一件に絞る。**絞れなければ null（選ばない）。**
 * 題が一致するものを先に、それでも決まらなければ開始時刻（HH:mm）で絞る。
 */
export function pickInstance(instances: IcsInstance[], date: string, title: string, time?: string | null): IcsInstance | null {
  const want = fold2(title);
  let hits = instances.filter((i) => !i.allDay && i.start.slice(0, 10) === date && (fold2(i.title).includes(want) || want.includes(fold2(i.title))));
  if (hits.length > 1) {
    const exact = hits.filter((i) => fold2(i.title) === want);
    if (exact.length === 1) hits = exact;
  }
  if (hits.length > 1 && time) {
    const at = hits.filter((i) => i.start.slice(11, 16) === time);
    if (at.length === 1) hits = at;
  }
  return hits.length === 1 ? hits[0] : null;
}

export interface Changes { title?: string | null; location?: string | null; start?: string | null; end?: string | null }

const stampOf = (iso: string) => `${iso.replace(/[-:]/g, '').slice(0, 8)}T${iso.replace(/[-:]/g, '').slice(9, 13)}00`;
const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

function splitEvents(raw: string): { head: string[]; events: string[][] } | null {
  const lines = unfold(stripCdata(raw)).filter((l) => l !== '');
  const begin = lines.indexOf('BEGIN:VCALENDAR');
  const endIdx = lines.lastIndexOf('END:VCALENDAR');
  if (begin < 0 || endIdx < 0) return null;
  const head: string[] = [];
  const events: string[][] = [];
  let cur: string[] | null = null;
  for (let i = begin; i < endIdx; i++) {
    const l = lines[i];
    if (l === 'BEGIN:VEVENT') { cur = [l]; continue; }
    if (l === 'END:VEVENT' && cur) { cur.push(l); events.push(cur); cur = null; continue; }
    if (cur) cur.push(l); else head.push(l);
  }
  return { head, events };
}
const join = (head: string[], events: string[][]) => [...head, ...events.flat(), 'END:VCALENDAR'].map(fold).join('\r\n') + '\r\n';

function applyChanges(ev: string[], c: Changes, tz: string, stamp: string): string[] {
  const dropKeys = [c.title ? 'SUMMARY' : '', c.location !== undefined && c.location !== null ? 'LOCATION' : '', c.start ? 'DTSTART' : '', c.end ? 'DTEND' : '', c.end ? 'DURATION' : '', 'DTSTAMP', 'LAST-MODIFIED'].filter(Boolean);
  const kept = ev.filter((l) => !dropKeys.some((k) => new RegExp(`^${k}[;:]`).test(l)));
  const add: string[] = [`DTSTAMP:${stamp}`, `LAST-MODIFIED:${stamp}`];
  if (c.title) add.push(`SUMMARY:${esc(c.title)}`);
  if (c.location !== undefined && c.location !== null && c.location !== '') add.push(`LOCATION:${esc(c.location)}`);
  if (c.start) add.push(`DTSTART;TZID=${tz}:${stampOf(c.start)}`);
  if (c.end) add.push(`DTEND;TZID=${tz}:${stampOf(c.end)}`);
  const at = kept.length - 1; // END:VEVENT の前に足す
  return [...kept.slice(0, at), ...add, kept[at]];
}

export interface EditTarget {
  /** 繰り返しの回なら、その回の目印（`20261011T153000`）。単発なら null。 */
  recurrenceId: string | null;
  /** その回の、いまの開始・終了（`YYYY-MM-DDTHH:mm`）。例外を作るときの土台。 */
  current: { start: string; end: string | null; title: string; location: string | null };
}

/** 予定を直す。単発は、その場で。繰り返しの一回は、その回の例外として。 */
export function editEvent(raw: string, target: EditTarget, changes: Changes, timeZone = 'Asia/Tokyo', now = new Date()): EditResult {
  const parts = splitEvents(raw);
  if (!parts) return { ok: false, reason: '予定のファイルとして読めませんでした。' };
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  if (target.recurrenceId === null) {
    if (parts.events.length !== 1 || parts.events[0].some((l) => l.startsWith('RRULE'))) {
      return { ok: false, reason: '単発の予定として直せません（繰り返しか、複数の部品を含みます）。' };
    }
    return { ok: true, ics: join(parts.head, [applyChanges(parts.events[0], changes, timeZone, stamp)]), replaced: true };
  }
  const master = parts.events.find((e) => e.some((l) => l.startsWith('RRULE')) && !e.some((l) => l.startsWith('RECURRENCE-ID')));
  if (!master) return { ok: false, reason: '繰り返しの元の定義が見つかりません。' };
  const rid = target.recurrenceId;
  const hasRid = (e: string[]) => e.some((l) => /^RECURRENCE-ID[;:]/.test(l) && l.replace(/^[^:]*:/, '') === rid);
  const idx = parts.events.findIndex(hasRid);
  if (idx >= 0) {
    parts.events[idx] = applyChanges(parts.events[idx], changes, timeZone, stamp);
    return { ok: true, ics: join(parts.head, parts.events), replaced: true };
  }
  const uid = master.find((l) => l.startsWith('UID:'));
  if (!uid) return { ok: false, reason: 'UID が見つかりません。' };
  const c = target.current;
  const override: string[] = [
    'BEGIN:VEVENT',
    `DTSTAMP:${stamp}`, `LAST-MODIFIED:${stamp}`,
    `DTSTART;TZID=${timeZone}:${stampOf(changes.start ?? c.start)}`,
    `DTEND;TZID=${timeZone}:${stampOf(changes.end ?? c.end ?? changes.start ?? c.start)}`,
    `RECURRENCE-ID;TZID=${timeZone}:${rid}`,
    `SUMMARY:${esc(changes.title || c.title)}`,
    ...((changes.location !== undefined && changes.location !== null ? changes.location : c.location) ? [`LOCATION:${esc((changes.location !== undefined && changes.location !== null ? changes.location : c.location) as string)}`] : []),
    uid,
    'END:VEVENT',
  ];
  return { ok: true, ics: join(parts.head, [...parts.events, override]), replaced: false };
}

export type DeleteResult =
  | { ok: true; kind: 'resource' }                       // 単発: ファイルごと消す
  | { ok: true; kind: 'occurrence'; ics: string }        // 繰り返しの一回: 元に除外日を足す
  | { ok: false; reason: string };

/** 予定を消す。単発はファイルごと。繰り返しの一回は、除外日（EXDATE）を足す（毎週の定義は残す）。 */
export function deleteEvent(raw: string, target: { recurrenceId: string | null }, timeZone = 'Asia/Tokyo'): DeleteResult {
  const parts = splitEvents(raw);
  if (!parts) return { ok: false, reason: '予定のファイルとして読めませんでした。' };
  if (target.recurrenceId === null) {
    if (parts.events.length !== 1 || parts.events[0].some((l) => l.startsWith('RRULE'))) {
      return { ok: false, reason: '単発の予定として消せません（繰り返しか、複数の部品を含みます）。' };
    }
    return { ok: true, kind: 'resource' };
  }
  const rid = target.recurrenceId;
  const hasRid = (e: string[]) => e.some((l) => /^RECURRENCE-ID[;:]/.test(l) && l.replace(/^[^:]*:/, '') === rid);
  const events = parts.events.filter((e) => !hasRid(e));
  const mi = events.findIndex((e) => e.some((l) => l.startsWith('RRULE')) && !e.some((l) => l.startsWith('RECURRENCE-ID')));
  if (mi < 0) return { ok: false, reason: '繰り返しの元の定義が見つかりません。' };
  const m = events[mi];
  const ex = `EXDATE;TZID=${timeZone}:${rid}`;
  if (!m.includes(ex)) events[mi] = [...m.slice(0, m.length - 1), ex, m[m.length - 1]];
  return { ok: true, kind: 'occurrence', ics: join(parts.head, events) };
}

/** サーバーが返した場所（href）が、暦と同じ出所（https の同じホスト）か。書き込み・削除の前に確かめる。 */
export function sameOrigin(a: string, b: string): boolean {
  try {
    const x = new URL(a); const y = new URL(b);
    return x.protocol === 'https:' && x.origin === y.origin;
  } catch { return false; }
}
