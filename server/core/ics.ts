/**
 * iCalendar を組む。IRIS が知っていて、暦には無いものを購読で見せるため。
 *
 * 配信は読み専用。**この暦を通して何かを書き戻すことは無い。**書くのは
 * いつもどおり台帳と Sheet で、ここはその写し。
 */
export interface IcsEvent {
  /** 安定した識別子。同じ予定が毎回別物に見えないために。 */
  uid: string;
  /** `YYYY-MM-DD`（終日）または `YYYY-MM-DDTHH:MM`（ローカル）。 */
  start: string;
  /** 時刻付きのときだけ。終日は翌日が終端。 */
  end?: string;
  summary: string;
  description?: string;
  /** 空き時間扱いにするか。目印は空き、拘束は塞ぐ。 */
  transparent?: boolean;
}

export function buildIcs(name: string, events: IcsEvent[], now = new Date()): string {
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//IRIS//calendar//JA',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${text(name)}`,
    'X-WR-TIMEZONE:Asia/Tokyo',
    // 購読側の取り直しの目安。Apple は概ね守る。
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
  ];
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  for (const e of events) {
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${e.uid}@iris.local`);
    lines.push(`DTSTAMP:${stamp}`);
    if (/^\d{4}-\d{2}-\d{2}$/.test(e.start)) {
      lines.push(`DTSTART;VALUE=DATE:${e.start.replace(/-/g, '')}`);
      lines.push(`DTEND;VALUE=DATE:${nextDay(e.start).replace(/-/g, '')}`);
    } else {
      lines.push(`DTSTART;TZID=Asia/Tokyo:${local(e.start)}`);
      lines.push(`DTEND;TZID=Asia/Tokyo:${local(e.end ?? e.start)}`);
    }
    lines.push(`SUMMARY:${text(e.summary)}`);
    if (e.description) lines.push(`DESCRIPTION:${text(e.description)}`);
    if (e.transparent) lines.push('TRANSP:TRANSPARENT');
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

/** RFC 5545 の文字の逃がし。 */
function text(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** `2026-09-15T08:30` → `20260915T083000` */
function local(s: string): string {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) throw new Error(`時刻の形が違います: ${s}`);
  return `${m[1]}${m[2]}${m[3]}T${m[4]}${m[5]}00`;
}

function nextDay(ymd: string): string {
  const [y, mo, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, mo - 1, d + 1));
  return t.toISOString().slice(0, 10);
}

/** 75 オクテットで折る。日本語は 3 バイトなので、文字数ではなくバイトで数える。 */
function fold(line: string): string {
  const bytes = Buffer.from(line, 'utf-8');
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let cur = '';
  let curBytes = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch, 'utf-8');
    const limit = out.length === 0 ? 75 : 74; // 継続行は先頭の空白で 1 バイト使う
    if (curBytes + b > limit) { out.push(cur); cur = ''; curBytes = 0; }
    cur += ch; curBytes += b;
  }
  if (cur) out.push(cur);
  return out.map((l, i) => (i === 0 ? l : ' ' + l)).join('\r\n');
}
