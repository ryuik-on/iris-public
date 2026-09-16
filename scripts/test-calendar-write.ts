/**
 * カレンダーへの書き込みの試験。
 *
 * 中心は三つ。**送る形が Google の言う形になっていること**、**時間帯を
 * 落とさないこと**、そして**断られたときに何を直せばいいか言うこと。**
 *
 * 読み取りと違って、ここは間違えると相手の側に物が残る。試したら消す、が
 * できないので、**送る前に形を確かめる**しかない。
 */

import { GoogleCalendarClient } from '../server/services/google_calendar.js';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail?: any) {
  if (ok) { passed++; console.log('  ✓ ' + name); }
  else { failed++; failures.push(name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); console.log('  ✗ ' + name); }
}
function section(name: string) { console.log('\n▸ ' + name); }

/** 送られた要求を覚えておく偽の fetch。 */
function harness(reply: { status?: number; body?: any } = {}) {
  const sent: Array<{ url: string; method: string; body: any; headers: any }> = [];
  const store = {
    getTokens: () => ({ access_token: 'tok', expires_at: Date.now() + 3_600_000 }),
    saveTokens: () => {},
    status: () => ({ hasToken: true }),
  } as any;
  const fetchImpl = (async (url: any, init: any = {}) => {
    sent.push({
      url: String(url),
      method: init.method ?? 'GET',
      body: init.body ? JSON.parse(init.body) : null,
      headers: init.headers ?? {},
    });
    const status = reply.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => reply.body ?? { id: 'evt1', htmlLink: 'https://cal/evt1' },
    };
  }) as any;
  const client = new GoogleCalendarClient({ store, clientId: 'c', fetchImpl } as any);
  return { client, sent };
}

async function main() {
  section('送る形');
  {
    const { client, sent } = harness();
    const out = await client.createEvent({
      calendarId: 'a@b.com', title: 'ガウス',
      start: '2026-09-08T15:00', end: '2026-09-08T16:00',
      allDay: false, location: '職場', timeZone: 'Asia/Tokyo',
    });
    const req = sent[0];
    check('POST で送る', req.method === 'POST', req.method);
    check('カレンダーIDが URL に入る', req.url.includes(encodeURIComponent('a@b.com')), req.url);
    check('題名', req.body.summary === 'ガウス');
    check('始まりは秒まで付ける', req.body.start.dateTime === '2026-09-08T15:00:00', req.body.start);
    check('終わり', req.body.end.dateTime === '2026-09-08T16:00:00', req.body.end);
    check('場所', req.body.location === '職場');
    check('作られた予定の id を返す', out.id === 'evt1');
    check('開くための link を返す', out.htmlLink === 'https://cal/evt1');
  }

  section('時間帯を落とさない');
  {
    /*
     * 省くとカレンダーの既定の帯で解釈されるので、**同じ文字列が別の時刻に
     * なる。**打った人は自分の時計で打っているので、ずれても「そう書いた」
     * ようにしか見えない。読み取りには時間帯の扱いが一つも無かったので、
     * 書き込みで初めて要る。
     */
    const { client, sent } = harness();
    await client.createEvent({
      calendarId: 'x', title: 't', start: '2026-09-08T15:00', end: null,
      allDay: false, timeZone: 'Asia/Tokyo',
    });
    check('始まりに時間帯が付く', sent[0].body.start.timeZone === 'Asia/Tokyo', sent[0].body.start);
    check('終わりにも付く', sent[0].body.end.timeZone === 'Asia/Tokyo', sent[0].body.end);
  }

  section('終わりが無いとき');
  {
    /*
     * 下書きの段では埋めない。**確認の画面には「終了時刻は書かれていません」
     * と出したい**から —— 一時間と埋めた下書きを見せると、推測が入力と同じ顔
     * になる。埋めるのは、人が確認を通したあと、送るためだけ。
     */
    const { client, sent } = harness();
    await client.createEvent({
      calendarId: 'x', title: 't', start: '2026-09-08T15:00', end: null,
      allDay: false, timeZone: 'Asia/Tokyo',
    });
    check('送るときだけ一時間置く', sent[0].body.end.dateTime === '2026-09-08T16:00:00', sent[0].body.end);
  }
  {
    // 日をまたぐ。23:30 に一時間足して 24:30 と書かないこと。
    const { client, sent } = harness();
    await client.createEvent({
      calendarId: 'x', title: 't', start: '2026-09-08T23:30', end: null,
      allDay: false, timeZone: 'Asia/Tokyo',
    });
    check('日をまたぐ', sent[0].body.end.dateTime === '2026-09-09T00:30:00', sent[0].body.end);
  }

  section('終日');
  {
    /*
     * Google の終日は `end` が**翌日**（排他）。同じ日を渡すと長さゼロで
     * 拒まれる —— 送ってみるまで分からない類の決まりなので、試験で留める。
     */
    const { client, sent } = harness();
    await client.createEvent({
      calendarId: 'x', title: '出張', start: '2026-09-12', end: null,
      allDay: true, timeZone: 'Asia/Tokyo',
    });
    check('date で送る', sent[0].body.start.date === '2026-09-12', sent[0].body.start);
    check('時間帯は付けない', sent[0].body.start.timeZone === undefined, sent[0].body.start);
    check('終わりは翌日', sent[0].body.end.date === '2026-09-13', sent[0].body.end);
  }
  {
    // 月末をまたぐ。9/30 の翌日は 10/1。
    const { client, sent } = harness();
    await client.createEvent({
      calendarId: 'x', title: 't', start: '2026-09-30', end: null, allDay: true, timeZone: 'Asia/Tokyo',
    });
    check('月末をまたぐ', sent[0].body.end.date === '2026-10-01', sent[0].body.end);
  }

  section('断られたときに、何を直せばいいか言う');
  {
    /*
     * 読み取りだけの権限で書こうとするとここへ来る。読み取り側の文言は
     * 「スコープが足りないか、API が無効か」で、**どちらを直すのか分からない。**
     * 書き込みの 403 はほぼ一つの理由なので、そう言う。
     */
    const { client } = harness({ status: 403, body: { error: { message: 'Insufficient Permission' } } });
    let caught: any = null;
    try {
      await client.createEvent({
        calendarId: 'x', title: 't', start: '2026-09-08T15:00', end: null,
        allDay: false, timeZone: 'Asia/Tokyo',
      });
    } catch (e) { caught = e; }
    check('投げる', caught !== null);
    check('書き込みだと分かる文', /書き込み/.test(caught?.message ?? ''), caught?.message);
    check('相手の言い分も残す', /Insufficient Permission/.test(caught?.message ?? ''), caught?.message);
    check('再認可を名指しする', /認可をやり直/.test(caught?.hint ?? ''), caught?.hint);
  }

  section('書ける相手だけ選ばせる');
  {
    /*
     * `calendarList` は読めるものを全部返す —— 祝日も、共有された誰かの
     * 予定も。そこへ書こうとすれば 403 だが、**選ばせてから断るのは一往復
     * 遅い。**
     */
    const { client } = harness({
      body: {
        items: [
          { id: 'me@x', summary: '個人', accessRole: 'owner', primary: true },
          { id: 'work@x', summary: '職場', accessRole: 'writer' },
          { id: 'hol@x', summary: '日本の祝日', accessRole: 'reader' },
          { id: 'shared@x', summary: '誰かの予定', accessRole: 'freeBusyReader' },
        ],
      },
    });
    const list = await client.listWritableCalendars();
    check('書けるものだけ', list.length === 2, list.map((c) => c.name));
    check('祝日は出さない', !list.some((c) => c.name === '日本の祝日'));
    check('既定の印が付く', list.find((c) => c.id === 'me@x')?.primary === true, list);
    check('既定はこちらで決めない', list.filter((c) => c.primary).length === 1, list);
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`Calendar write: ${passed} passed, ${failed} failed`);
  if (failed) { console.log('\nFailures:'); for (const f of failures) console.log('  - ' + f); process.exit(1); }
  console.log('All calendar write tests passed.');
}

main();
