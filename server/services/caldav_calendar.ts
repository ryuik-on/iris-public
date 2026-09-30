import { randomUUID } from 'crypto';
import { CalendarEvent, CalendarReading, CalendarUnavailableError } from './calendar.js';

/**
 * iCloud calendars, read over CalDAV.
 *
 * The reason this exists is a measurement rather than a preference. On
 * 2026-08-19 the Google source returned 12 events and the local cache 16; the
 * four it could not see lived in iCloud calendars named 自宅 and 職場, and one
 * of them was an appointment two days out that the daily focus was talking
 * over. Reading the cache covers them, but only for as long as something keeps
 * the cache current — and that something is an AppleScript that fails whenever
 * Calendar.app is not running, which is most of the time.
 *
 * Every other way of closing that gap moves something. Migrating the calendars
 * to Google changes where events are created on the phone. Publishing them
 * produces an unlisted URL that anyone holding it can read, which is a poor
 * trade for a calendar containing client meetings. CalDAV moves nothing: the
 * calendars stay in iCloud, the phone keeps working the way it did, and IRIS
 * reads them directly.
 *
 * Deliberately no new dependency. CalDAV responses are machine-generated XML
 * and only a few elements are needed, and recurrence is expanded by the server
 * so none of the RRULE arithmetic — the part of iCalendar that is genuinely
 * hard — has to live here.
 *
 * Read-only throughout. Nothing here issues PUT or DELETE.
 */

const ICLOUD_ROOT = 'https://caldav.icloud.com';

export interface CaldavOptions {
  appleId: string;
  /** An app-specific password. The account password will not work. */
  appPassword: string;
  root?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  onEvent?: (event: { type: string; detail?: Record<string, any> }) => void;
}

export interface CaldavReading extends CalendarReading {
  source: 'icloud';
  readAt: string;
  /** True when the server expanded recurrences; false when it refused to. */
  expanded: boolean;
}

interface CalendarCollection {
  url: string;
  name: string;
}

// ---------------------------------------------------------------------------
// XML, read narrowly

/**
 * The text of every element with this local name.
 *
 * Local name only, because the namespace prefix is the server's choice — iCloud
 * has used both `D:` and `d:` for the DAV namespace across responses, and
 * matching a prefix would work until the day it silently stopped.
 */
function elements(xml: string, local: string): string[] {
  const re = new RegExp(
    `<(?:[A-Za-z0-9_.-]+:)?${local}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z0-9_.-]+:)?${local}>`,
    'gi'
  );
  const found: string[] = [];
  for (const m of xml.matchAll(re)) found.push(m[1]);
  return found;
}

/** Whether an element appears at all, including as a self-closing tag. */
function hasElement(xml: string, local: string): boolean {
  return new RegExp(`<(?:[A-Za-z0-9_.-]+:)?${local}(?:\\s[^>]*)?(?:/>|>)`, 'i').test(xml);
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

// ---------------------------------------------------------------------------
// iCalendar, read narrowly

/**
 * Turns an iCalendar timestamp into the same shape the other sources use.
 *
 * Identity for merging is the title plus the first sixteen characters of the
 * start, so this has to agree with Google's `2026-08-24T08:30:00+09:00` and
 * the cache's `2026-08-24T13:00` about the wall-clock time. Everything is
 * therefore rendered in the machine's own zone.
 *
 * A date without a time stays a date. An all-day event does not happen at
 * midnight, and giving it a time would be inventing precision that then has to
 * be argued with elsewhere.
 */
function icsTimeToLocal(value: string, params: Record<string, string>): { start: string | null; allDay: boolean } {
  const raw = value.trim();

  if (params.VALUE === 'DATE' || /^\d{8}$/.test(raw)) {
    const m = raw.match(/^(\d{4})(\d{2})(\d{2})$/);
    return m ? { start: `${m[1]}-${m[2]}-${m[3]}`, allDay: true } : { start: null, allDay: true };
  }

  const m = raw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!m) return { start: null, allDay: false };

  const [, y, mo, d, h, mi, s, z] = m;
  const parts = { y: +y, mo: +mo, d: +d, h: +h, mi: +mi, s: +s };

  let instant: Date;
  if (z === 'Z') {
    instant = new Date(Date.UTC(parts.y, parts.mo - 1, parts.d, parts.h, parts.mi, parts.s));
  } else if (params.TZID) {
    instant = zonedToInstant(parts, params.TZID);
  } else {
    // Floating: whatever the clock says wherever it is read, which is here.
    instant = new Date(parts.y, parts.mo - 1, parts.d, parts.h, parts.mi, parts.s);
  }

  return { start: toLocalIso(instant), allDay: false };
}

/**
 * The instant at which the given wall-clock reading occurs in `tz`.
 *
 * Guess an instant, ask what it reads as in the target zone, and correct by
 * how far that reading is from the one wanted. Two passes: the first lands on
 * the right instant for every fixed offset, and the second settles the hour
 * either side of a DST change, where the first answer can fall in the fold.
 *
 * The correction is measured against the *target*, not against the previous
 * guess. Measured against the guess it is the offset every time, so the first
 * pass lands correctly and the second pass shifts off by that offset again —
 * 11:00 in Tokyo came out as 02:00, which is a plausible enough time to
 * survive a glance at the output.
 */
function zonedToInstant(
  p: { y: number; mo: number; d: number; h: number; mi: number; s: number },
  tz: string
): Date {
  const target = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  let guess = target;
  for (let pass = 0; pass < 2; pass++) {
    const read = readInZone(new Date(guess), tz);
    if (read === null) return new Date(target);
    const drift = read - target;
    if (drift === 0) break;
    guess -= drift;
  }
  return new Date(guess);
}

/** What the given instant reads as in `tz`, as a UTC-shaped number. */
function readInZone(at: Date, tz: string): number | null {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const got: Record<string, number> = {};
    for (const part of fmt.formatToParts(at)) {
      if (part.type !== 'literal') got[part.type] = Number(part.value);
    }
    // `24` for midnight is a documented quirk of some implementations.
    const hour = got.hour === 24 ? 0 : got.hour;
    return Date.UTC(got.year, got.month - 1, got.day, hour, got.minute, got.second);
  } catch {
    // An unknown TZID is not worth failing the whole read over.
    return null;
  }
}

function toLocalIso(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

/** Splits a property line into name, parameters and value. */
function parseLine(line: string): { name: string; params: Record<string, string>; value: string } | null {
  const colon = line.indexOf(':');
  if (colon < 0) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const [name, ...rest] = head.split(';');
  const params: Record<string, string> = {};
  for (const p of rest) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: name.toUpperCase(), params, value };
}

function unescapeText(s: string): string {
  return s.replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
}

/**
 * The events in one iCalendar document.
 *
 * Folded lines are joined first: iCalendar wraps at 75 octets and continues
 * with a leading space, so a title long enough to wrap arrives in pieces and
 * looks like a malformed property until it is put back together.
 */
export function parseVEvents(ics: string, calendarName: string): CalendarEvent[] {
  const unfolded = ics.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');
  const events: CalendarEvent[] = [];

  for (const block of unfolded.split(/BEGIN:VEVENT/i).slice(1)) {
    const body = block.split(/END:VEVENT/i)[0];
    let title = '(無題)';
    let start: string | null = null;
    let end: string | null = null;
    let allDay = false;
    let location: string | undefined;
    let cancelled = false;

    for (const line of body.split(/\r?\n/)) {
      const parsed = parseLine(line.trim());
      if (!parsed) continue;
      const { name, params, value } = parsed;

      if (name === 'SUMMARY') title = unescapeText(value) || '(無題)';
      else if (name === 'LOCATION') location = unescapeText(value) || undefined;
      else if (name === 'STATUS') cancelled = value.trim().toUpperCase() === 'CANCELLED';
      else if (name === 'DTSTART') {
        const t = icsTimeToLocal(value, params);
        start = t.start;
        allDay = t.allDay;
      } else if (name === 'DTEND') {
        end = icsTimeToLocal(value, params).start;
      }
    }

    if (cancelled || !start) continue;
    events.push({ title, start, end, allDay, calendar: calendarName, ...(location ? { location } : {}) });
  }

  return events;
}

// ---------------------------------------------------------------------------


/**
 * `.ics` の一行に入れられない字を逃がす。
 *
 * `,` と `;` は値の区切り、`\` は逃がし文字、改行は行の終わり。**逃がさずに
 * 入れると、そこから先が別の項目として読まれる** —— 題名に読点を打っただけで
 * 予定が壊れる、という壊れ方をする。
 */
function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/**
 * 75 オクテットで折る。
 *
 * RFC 5545 の決まりで、続きの行は空白一つで始める。**日本語は一字が三
 * オクテット**なので、文字数で折ると規格を超える。字の途中で切ると壊れるので、
 * 字の切れ目で数えながら折る。
 */
function foldIcsLine(line: string): string {
  const bytes = (s: string) => new TextEncoder().encode(s).length;
  if (bytes(line) <= 75) return line;
  const out: string[] = [];
  let current = '';
  let limit = 75;
  for (const ch of line) {
    if (bytes(current + ch) > limit) {
      out.push(current);
      current = ' ';
      limit = 74; // 続きの行は先頭の空白を勘定に入れる
    }
    current += ch;
  }
  if (current.trim()) out.push(current);
  return out.join('\r\n');
}

/** `2026-09-08T15:00` → `20260908T150000`、`2026-09-08` → `20260908`。 */
function icsStamp(value: string, allDay: boolean): string {
  return allDay ? value.replace(/-/g, '') : `${value.replace(/[-:]/g, '')}00`;
}

function buildIcs(input: {
  uid: string;
  title: string;
  start: string;
  end: string | null;
  allDay: boolean;
  location?: string | null;
  timeZone: string;
  now: Date;
}): string {
  /*
   * 終わりが無いときの一時間は、**送るときにだけ**足す。Google 側と同じ理由 ——
   * 下書きには入れない。終日の終わりは翌日（排他）で、同じ日だと長さゼロ。
   */
  const endValue = input.allDay
    ? (input.end ?? icsNextDay(input.start))
    : (input.end ?? icsPlusHour(input.start));

  const stamp = input.now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const when = (name: string, value: string) =>
    input.allDay
      ? `${name};VALUE=DATE:${icsStamp(value, true)}`
      : `${name};TZID=${input.timeZone}:${icsStamp(value, false)}`;

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//IRIS//calendar//JP',
    'BEGIN:VEVENT',
    `UID:${input.uid}`,
    `DTSTAMP:${stamp}`,
    when('DTSTART', input.start),
    when('DTEND', endValue),
    `SUMMARY:${escapeIcsText(input.title)}`,
    ...(input.location ? [`LOCATION:${escapeIcsText(input.location)}`] : []),
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  // 行の終わりは CRLF。LF だけだと受け取らない実装がある。
  return lines.map(foldIcsLine).join('\r\n') + '\r\n';
}

function icsNextDay(date: string): string {
  const at = new Date(`${date}T00:00:00`);
  at.setDate(at.getDate() + 1);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}`;
}

function icsPlusHour(value: string): string {
  const at = new Date(`${value}:00`);
  at.setHours(at.getHours() + 1);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}T${p(at.getHours())}:${p(at.getMinutes())}`;
}

export const __icsForTests = { buildIcs, escapeIcsText, foldIcsLine };

export class CaldavCalendarClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly root: string;
  /** Discovered once; the account's calendar list does not change per request. */
  private calendars: CalendarCollection[] | null = null;

  constructor(private options: CaldavOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 25_000;
    this.root = options.root ?? ICLOUD_ROOT;
  }

  configured(): boolean {
    return Boolean(this.options.appleId && this.options.appPassword);
  }

  private authorization(): string {
    const raw = `${this.options.appleId}:${this.options.appPassword}`;
    return `Basic ${Buffer.from(raw, 'utf8').toString('base64')}`;
  }

  /**
   * 認証を付けていい行き先か。
   *
   * `request` は渡された URL に**無条件で Basic 認証を載せていた。**そして
   * 書き込みの口（`POST /api/calendar/events`）は、入れ先を呼び手から
   * 受け取った文字列（`calendarId`）をそのまま URL として使う。つまり
   * **カレンダーの選択が、Apple ID と App 用パスワードの持ち出し口**に
   * なっていた（astra のレビュー、2026-09-08。こちらでも経路を確認）。
   *
   * 誰でも叩けるわけではない —— 口はループバックにしか出ていない。だが
   * 「届く相手は全員本人」という前提の上に資格情報を置くのは、前提が一つ
   * 崩れたときに失うものが大きすぎる。**ここは前提を要らなくできる場所。**
   *
   * 見るのは host だけ。iCloud の暦の家は口座ごとに別のホスト
   * （`p156-caldav.icloud.com` など）へ散るので、`ICLOUD_ROOT` との完全一致
   * では足りない。`icloud.com` の下であることと、**https であること**を見る。
   */
  private allowedTarget(url: string): boolean {
    try {
      const at = new URL(url);
      if (at.protocol !== 'https:') return false;
      return at.hostname === 'icloud.com' || at.hostname.endsWith('.icloud.com');
    } catch {
      return false;
    }
  }

  private async request(
    method: string,
    url: string,
    body: string,
    headers: Record<string, string> = {}
  ): Promise<string> {
    if (!this.allowedTarget(url)) {
      throw new CalendarUnavailableError(
        'caldav_target_refused',
        'iCloud 以外へは書きません。',
        `入れ先として ${url} が渡されました。iCloud の資格情報は iCloud にしか渡しません。`
      );
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method,
        headers: {
          authorization: this.authorization(),
          'content-type': 'application/xml; charset=utf-8',
          ...headers,
        },
        body,
        signal: controller.signal,
      });

      if (response.status === 401) {
        throw new CalendarUnavailableError(
          'caldav_unauthorized',
          'iCloud の認証に失敗しました。',
          'App用パスワードを使っているか確認してください。Apple ID のパスワードでは通りません。' +
            '（appleid.apple.com → サインインとセキュリティ → App用パスワード）'
        );
      }
      if (!response.ok && response.status !== 207) {
        throw new CalendarUnavailableError(
          `caldav_http_${response.status}`,
          `iCloud CalDAV が ${method} に HTTP ${response.status} を返しました。`
        );
      }
      return await response.text();
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 書き込める相手。
   *
   * iCloud は自分のカレンダーを全部返す。購読しているもの（祝日など）は
   * PROPFIND の段で `calendar` の resourcetype を持たないので、既に
   * `discover` が落としている —— **ここで改めて絞る材料が無い**ので、
   * 見つかったものをそのまま渡す。Google 側と違って `accessRole` に当たる
   * ものが無く、**「書けるはず」までしか言えない。**断られたら断られたと
   * 出す方が、勝手に隠すよりいい。
   */
  async listWritableCalendars(): Promise<Array<{ id: string; name: string }>> {
    const collections = await this.discover();
    return collections.map((c) => ({ id: c.url, name: c.name }));
  }

  /**
   * 予定を一件作る。**呼ばれたら書く。**
   *
   * CalDAV は「予定を作る口」ではなく「ファイルを置く口」で、置く先の名前は
   * こちらが決める。`If-None-Match: *` を付けるのは、**同じ名前が既にあったら
   * 上書きせずに断らせる**ため。名前は毎回作った UUID なのでまず衝突しないが、
   * 衝突したときに黙って他人の予定を消す道は残さない。
   */
  async createEvent(input: {
    calendarUrl: string;
    title: string;
    /** `2026-09-08T15:00`、終日なら `2026-09-08`。 */
    start: string;
    end: string | null;
    allDay: boolean;
    location?: string | null;
    timeZone: string;
    now?: Date;
  }): Promise<{ id: string; url: string }> {
    const uid = `iris-${randomUUID()}`;
    const url = new URL(`${uid}.ics`, input.calendarUrl.endsWith('/') ? input.calendarUrl : `${input.calendarUrl}/`).toString();
    const body = buildIcs({ ...input, uid, now: input.now ?? new Date() });

    await this.request('PUT', url, body, {
      'content-type': 'text/calendar; charset=utf-8',
      'if-none-match': '*',
    });
    this.options.onEvent?.({ type: 'caldav.event_created', detail: { calendar: input.calendarUrl, uid } });
    return { id: uid, url };
  }

  /** Resolves an href from a response against the URL it came from. */
  private resolve(href: string, base: string): string {
    return new URL(decodeEntities(href.trim()), base).toString();
  }

  /**
   * Finds the account's calendars.
   *
   * Three hops, and the middle one is the reason this is not a single request:
   * iCloud answers the well-known URL from one host and then hands back a
   * calendar home on a different, per-account one (`p##-caldav.icloud.com`).
   * Resolving every href against the response it arrived in is what makes that
   * work; assuming the first host holds is what makes it fail for one account
   * in twenty.
   */
  private async discover(): Promise<CalendarCollection[]> {
    if (this.calendars) return this.calendars;

    const principalXml = await this.request(
      'PROPFIND',
      `${this.root}/`,
      `<?xml version="1.0" encoding="utf-8"?>
       <d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>`,
      { depth: '0' }
    );
    const principalHref = elements(elements(principalXml, 'current-user-principal').join(''), 'href')[0];
    if (!principalHref) {
      throw new CalendarUnavailableError('caldav_no_principal', 'iCloud のプリンシパルを特定できませんでした。');
    }
    const principalUrl = this.resolve(principalHref, `${this.root}/`);

    const homeXml = await this.request(
      'PROPFIND',
      principalUrl,
      `<?xml version="1.0" encoding="utf-8"?>
       <d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
         <d:prop><c:calendar-home-set/></d:prop>
       </d:propfind>`,
      { depth: '0' }
    );
    const homeHref = elements(elements(homeXml, 'calendar-home-set').join(''), 'href')[0];
    if (!homeHref) {
      throw new CalendarUnavailableError('caldav_no_home', 'iCloud のカレンダーホームを特定できませんでした。');
    }
    const homeUrl = this.resolve(homeHref, principalUrl);

    const listXml = await this.request(
      'PROPFIND',
      homeUrl,
      `<?xml version="1.0" encoding="utf-8"?>
       <d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
         <d:prop>
           <d:resourcetype/>
           <d:displayname/>
           <c:supported-calendar-component-set/>
         </d:prop>
       </d:propfind>`,
      { depth: '1' }
    );

    const collections: CalendarCollection[] = [];
    for (const response of elements(listXml, 'response')) {
      // A calendar home contains more than calendars — inbox, outbox, notes —
      // and some calendars hold only reminders. Both are filtered here rather
      // than being asked for events and returning none.
      if (!hasElement(response, 'calendar')) continue;
      if (hasElement(response, 'supported-calendar-component-set')) {
        const set = elements(response, 'supported-calendar-component-set').join('');
        // Either quote character, because which one an attribute uses is the
        // server's choice and nothing requires it to keep choosing the same
        // one. iCloud writes `name='VEVENT'`, and a check for `name="VEVENT"`
        // silently classified every calendar in the account as holding no
        // events — which reads exactly like an empty calendar.
        if (set && !/\bname\s*=\s*['"]VEVENT['"]/i.test(set)) continue;
      }
      const href = elements(response, 'href')[0];
      if (!href) continue;
      const name = decodeEntities(elements(response, 'displayname')[0] ?? '').trim();
      collections.push({ url: this.resolve(href, homeUrl), name: name || '(名称なし)' });
    }

    this.calendars = collections;
    this.options.onEvent?.({
      type: 'caldav.discovered',
      detail: { calendars: collections.length, names: collections.map((c) => c.name) },
    });
    return collections;
  }

  /** `YYYYMMDDTHHMMSSZ`, which is the only time format a CalDAV filter takes. */
  private static stamp(at: Date): string {
    return at.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  }

  private async queryCalendar(
    calendar: CalendarCollection,
    start: Date,
    end: Date,
    expand: boolean
  ): Promise<string> {
    const range = `<c:time-range start="${CaldavCalendarClient.stamp(start)}" end="${CaldavCalendarClient.stamp(end)}"/>`;
    // Expanding server-side turns a recurrence rule into the occurrences that
    // actually fall in the window. Without it a weekly lecture arrives once,
    // dated wherever the series was defined, and every question about this
    // week is answered from a series definition rather than a schedule.
    const data = expand
      ? `<c:calendar-data><c:expand start="${CaldavCalendarClient.stamp(start)}" end="${CaldavCalendarClient.stamp(end)}"/></c:calendar-data>`
      : `<c:calendar-data/>`;

    return this.request(
      'REPORT',
      calendar.url,
      `<?xml version="1.0" encoding="utf-8"?>
       <c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
         <d:prop><d:getetag/>${data}</d:prop>
         <c:filter>
           <c:comp-filter name="VCALENDAR">
             <c:comp-filter name="VEVENT">${range}</c:comp-filter>
           </c:comp-filter>
         </c:filter>
       </c:calendar-query>`,
      { depth: '1' }
    );
  }

  async read(days = 14, fromDay?: Date): Promise<CaldavReading> {
    if (!this.configured()) {
      throw new CalendarUnavailableError(
        'caldav_not_configured',
        'iCloud の認証情報が設定されていません。',
        'ICLOUD_APPLE_ID と ICLOUD_APP_PASSWORD を .env に設定してください。'
      );
    }

    const started = Date.now();
    // Beginning of today rather than this moment, so an afternoon reading
    // still contains the morning. See google_calendar.ts for the reasoning;
    // both sources have to agree or the merge produces a half-day.
    const from = new Date(fromDay ? fromDay.getTime() : started);
    from.setHours(0, 0, 0, 0);
    // 始まりを渡されたら丸 `days` 日。Google 側と同じ窓にしないと、合わせた
    // ときに片方だけ最後の日が欠ける。
    const to = fromDay
      ? new Date(from.getFullYear(), from.getMonth(), from.getDate() + days)
      : new Date(started + days * 86_400_000);

    const calendars = await this.discover();
    const events: CalendarEvent[] = [];
    let expanded = true;

    for (const calendar of calendars) {
      let xml: string;
      try {
        xml = await this.queryCalendar(calendar, from, to, expanded);
      } catch (err) {
        if (!expanded) throw err;
        // Not every server implements expand. Losing recurrence expansion is
        // worth reporting but not worth losing the calendar over — and saying
        // which happened is the difference between "no repeating events this
        // week" and "repeating events were not expanded".
        expanded = false;
        this.options.onEvent?.({
          type: 'caldav.expand_unsupported',
          detail: { calendar: calendar.name },
        });
        xml = await this.queryCalendar(calendar, from, to, false);
      }

      for (const data of elements(xml, 'calendar-data')) {
        events.push(...parseVEvents(decodeEntities(data), calendar.name));
      }
    }

    events.sort((a, b) => (a.start ?? '').localeCompare(b.start ?? ''));

    return {
      source: 'icloud',
      events,
      days,
      elapsedMs: Date.now() - started,
      // Zero events and zero calendars look identical and mean opposite
      // things; the second is a credential problem wearing the costume of a
      // quiet fortnight.
      calendarsVisible: calendars.length,
      calendarNames: calendars.map((c) => c.name).sort(),
      readAt: new Date(started).toISOString(),
      expanded,
    };
  }
}
