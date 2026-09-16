/**
 * iCloud へ予定を書く試験。
 *
 * CalDAV は「予定を作る口」ではなく「ファイルを置く口」なので、**置く中身が
 * 規格どおりかどうかは、こちらの責任。**相手は受け取ってから壊れる。
 *
 * 中心は `.ics` の組み立て —— 逃がし字、折り返し、終日の終わり。どれも
 * **間違えても 200 が返る**種類の間違いで、気づくのは iPhone で予定を開いた
 * ときになる。
 */

import { CaldavCalendarClient, __icsForTests } from '../server/services/caldav_calendar.js';

const { buildIcs, escapeIcsText, foldIcsLine } = __icsForTests;

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail?: any) {
  if (ok) { passed++; console.log('  ✓ ' + name); }
  else { failed++; failures.push(name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); console.log('  ✗ ' + name); }
}
function section(name: string) { console.log('\n▸ ' + name); }

const NOW = new Date('2026-09-07T04:19:00Z');
const base = {
  uid: 'u1', title: 'ガウス', start: '2026-09-08T15:00', end: '2026-09-08T16:00',
  allDay: false, timeZone: 'Asia/Tokyo', now: NOW,
};
const lines = (ics: string) => ics.split('\r\n');
const find = (ics: string, prefix: string) => lines(ics).find((l) => l.startsWith(prefix)) ?? '';

section('骨組み');
{
  const ics = buildIcs(base);
  check('VCALENDAR で囲む', ics.startsWith('BEGIN:VCALENDAR') && ics.trimEnd().endsWith('END:VCALENDAR'));
  check('VEVENT が入る', ics.includes('BEGIN:VEVENT') && ics.includes('END:VEVENT'));
  check('UID', find(ics, 'UID:') === 'UID:u1');
  check('DTSTAMP は UTC', find(ics, 'DTSTAMP:') === 'DTSTAMP:20260907T041900Z', find(ics, 'DTSTAMP:'));
  /*
   * 行の終わりは CRLF。**LF だけだと受け取らない実装がある**ので、規格どおりに。
   * ここを間違えると「保存はされたのに開けない」になる。
   */
  check('行の終わりは CRLF', ics.includes('\r\n') && !/[^\r]\n/.test(ics));
}

section('時刻あり');
{
  const ics = buildIcs(base);
  check('始まりに時間帯が付く', find(ics, 'DTSTART') === 'DTSTART;TZID=Asia/Tokyo:20260908T150000', find(ics, 'DTSTART'));
  check('終わりにも付く', find(ics, 'DTEND') === 'DTEND;TZID=Asia/Tokyo:20260908T160000', find(ics, 'DTEND'));
  check('秒まで書く', /T\d{6}$/.test(find(ics, 'DTSTART').split(':').pop()!));
}

section('終日');
{
  /*
   * 終日の終わりは**翌日**（排他）。同じ日を書くと長さゼロで、相手によっては
   * 受け取ったうえで表示されない。Google 側と同じ決まりだが、**実装が別なので
   * 試験も別に要る。**
   */
  const ics = buildIcs({ ...base, start: '2026-09-30', end: null, allDay: true });
  check('VALUE=DATE で書く', find(ics, 'DTSTART') === 'DTSTART;VALUE=DATE:20260930', find(ics, 'DTSTART'));
  check('時間帯は付けない', !find(ics, 'DTSTART').includes('TZID'));
  check('終わりは翌日', find(ics, 'DTEND') === 'DTEND;VALUE=DATE:20261001', find(ics, 'DTEND'));
}

section('終わりが無いとき');
{
  const ics = buildIcs({ ...base, end: null });
  check('送るときだけ一時間置く', find(ics, 'DTEND').endsWith(':20260908T160000'), find(ics, 'DTEND'));
  const late = buildIcs({ ...base, start: '2026-09-08T23:30', end: null });
  check('日をまたぐ', find(late, 'DTEND').endsWith(':20260909T003000'), find(late, 'DTEND'));
}

section('逃がさないと、そこから先が別の項目として読まれる');
{
  /*
   * `,` と `;` は値の区切り、`\` は逃がし文字、改行は行の終わり。**題名に
   * 読点を打っただけで予定が壊れる**という壊れ方をする。
   */
  check('カンマ', escapeIcsText('a,b') === 'a\\,b', escapeIcsText('a,b'));
  check('セミコロン', escapeIcsText('a;b') === 'a\\;b', escapeIcsText('a;b'));
  check('逃がし文字そのもの', escapeIcsText('a\\b') === 'a\\\\b', escapeIcsText('a\\b'));
  check('改行', escapeIcsText('a\nb') === 'a\\nb', escapeIcsText('a\nb'));
  // 日本語の読点は区切りではないので、逃がさない。逃がすと画面に \ が出る。
  check('日本語の読点はそのまま', escapeIcsText('打合せ、資料') === '打合せ、資料');

  const ics = buildIcs({ ...base, title: '打合せ, 資料', location: '職場; 3F' });
  check('題名に効く', find(ics, 'SUMMARY:') === 'SUMMARY:打合せ\\, 資料', find(ics, 'SUMMARY:'));
  check('場所に効く', find(ics, 'LOCATION:') === 'LOCATION:職場\\; 3F', find(ics, 'LOCATION:'));
  check('場所が無ければ行ごと出さない', !buildIcs(base).includes('LOCATION'));
}

section('折り返しは文字数ではなくオクテットで数える');
{
  /*
   * 規格の上限は 75 **オクテット。日本語は一字が三オクテット**なので、
   * 文字数で折ると規格を超える。字の途中で切ると、その字が壊れる。
   */
  const long = 'あ'.repeat(60);
  const folded = foldIcsLine(`SUMMARY:${long}`);
  const parts = folded.split('\r\n');
  check('折れている', parts.length > 1, parts.length);
  const bytes = (s: string) => new TextEncoder().encode(s).length;
  check('どの行も 75 オクテット以下', parts.every((p) => bytes(p) <= 75), parts.map(bytes));
  check('続きの行は空白で始まる', parts.slice(1).every((p) => p.startsWith(' ')), parts.slice(1).map((p) => p.slice(0, 2)));
  // 畳み直したら元に戻る＝字の途中で切っていない。
  const rejoined = parts.map((p, i) => (i === 0 ? p : p.slice(1))).join('');
  check('畳み直すと元に戻る', rejoined === `SUMMARY:${long}`);
  check('短い行は折らない', foldIcsLine('UID:u1') === 'UID:u1');
}

async function main() {
section('置く先と、上書きしないこと');
{
  const sent: Array<{ url: string; method: string; headers: any; body: string }> = [];
  const fetchImpl = (async (url: any, init: any = {}) => {
    sent.push({ url: String(url), method: init.method, headers: init.headers ?? {}, body: String(init.body ?? '') });
    return { ok: true, status: 201, text: async () => '' };
  }) as any;
  const client = new CaldavCalendarClient({
    appleId: 'a@b.com', appPassword: 'x', fetchImpl,
  } as any);

  const out = await client.createEvent({
    calendarUrl: 'https://p01-caldav.icloud.com/123/calendars/home',
    title: 'ガウス', start: '2026-09-08T15:00', end: null,
    allDay: false, timeZone: 'Asia/Tokyo', now: NOW,
  });

  const req = sent[0];
  check('PUT で置く', req.method === 'PUT', req.method);
  check('カレンダーの下に置く', req.url.startsWith('https://p01-caldav.icloud.com/123/calendars/home/'), req.url);
  check('.ics で終わる', req.url.endsWith('.ics'), req.url);
  check('名前は UID と揃える', req.url.endsWith(`${out.id}.ics`), [req.url, out.id]);
  check('中身の型を名乗る', String(req.headers['content-type'] ?? '').startsWith('text/calendar'), req.headers);
  /*
   * `If-None-Match: *` は、**同じ名前が既にあったら上書きせずに断らせる**ため。
   * 名前は毎回作った UUID なのでまず衝突しないが、衝突したときに黙って他人の
   * 予定を消す道は残さない。
   */
  check('あったら上書きせずに断らせる', req.headers['if-none-match'] === '*', req.headers);
  check('末尾の / が二重にならない', !req.url.includes('//calendars'), req.url);
}

section('iCloud 以外へは、資格情報を渡さない');
{
  /*
   * `request` は渡された URL に無条件で Basic 認証を載せていた。そして
   * 書き込みの口は入れ先を呼び手の文字列から作る —— **カレンダーの選択が
   * 資格情報の持ち出し口**になっていた（astra のレビュー、2026-09-08）。
   *
   * 口はループバックにしか出ていないので誰でも叩けるわけではないが、
   * 「届く相手は全員本人」の上に App 用パスワードを置く必要は無い。
   */
  const attempt = async (calendarUrl: string) => {
    const sent: string[] = [];
    const fetchImpl = (async (url: any) => {
      sent.push(String(url));
      return { ok: true, status: 201, text: async () => '' };
    }) as any;
    const client = new CaldavCalendarClient({ appleId: 'a@b.com', appPassword: 'x', fetchImpl } as any);
    let refused: string | null = null;
    try {
      await client.createEvent({
        calendarUrl, title: 't', start: '2026-09-08T15:00', end: null,
        allDay: false, timeZone: 'Asia/Tokyo', now: NOW,
      });
    } catch (err: any) {
      refused = err?.message ?? String(err);
    }
    return { sent, refused };
  };

  const evil = await attempt('https://attacker.example/calendars/x');
  check('他所へは一度も送らない', evil.sent.length === 0, evil.sent);
  check('断った理由を言う', (evil.refused ?? '').includes('iCloud'), evil.refused);

  const plain = await attempt('http://p01-caldav.icloud.com/1/calendars/home');
  check('http は名前が合っていても断る', plain.sent.length === 0, plain.sent);

  // 名前の似た別のドメインを iCloud と読まない。
  const lookalike = await attempt('https://icloud.com.attacker.example/c/home');
  check('似せた名前も断る', lookalike.sent.length === 0, lookalike.sent);

  const real = await attempt('https://p156-caldav.icloud.com/17648406100/calendars/home');
  check('口座ごとのホストは通す', real.sent.length === 1 && real.refused === null, [real.sent, real.refused]);
}

section('カレンダー URL の末尾に / があってもなくても同じ');
{
  const seen: string[] = [];
  const fetchImpl = (async (url: any, init: any = {}) => {
    seen.push(String(url));
    return { ok: true, status: 201, text: async () => '' };
  }) as any;
  const client = new CaldavCalendarClient({ appleId: 'a', appPassword: 'x', fetchImpl } as any);
  const args = { title: 't', start: '2026-09-08T15:00', end: null, allDay: false, timeZone: 'Asia/Tokyo', now: NOW };
  await client.createEvent({ ...args, calendarUrl: 'https://p01-caldav.icloud.com/c/work' });
  await client.createEvent({ ...args, calendarUrl: 'https://p01-caldav.icloud.com/c/work/' });
  const shape = (u: string) => u.replace(/[^/]+\.ics$/, '');
  check('同じ場所に置く', shape(seen[0]) === shape(seen[1]), seen);
  check('その場所が正しい', shape(seen[0]) === 'https://p01-caldav.icloud.com/c/work/', seen[0]);
}

  console.log('\n' + '─'.repeat(60));
  console.log(`CalDAV write: ${passed} passed, ${failed} failed`);
  if (failed) { console.log('\nFailures:'); for (const f of failures) console.log('  - ' + f); process.exit(1); }
  console.log('All CalDAV write tests passed.');
}

main();
