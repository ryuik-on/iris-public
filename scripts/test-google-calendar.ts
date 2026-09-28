/**
 * Google Calendar REST source tests.
 *
 * Two things are worth testing here and they are both about honesty rather
 * than about fetching.
 *
 * A token that refreshes must not lose its refresh token. Google does not
 * return one on a refresh, so writing the response straight through drops it,
 * and the failure surfaces an hour later as a re-consent nobody can explain.
 *
 * A source that falls back must say so. Falling back is correct — a stale
 * answer beats no answer — but a silent one is how the dashboard rendered a
 * week-old calendar every morning with nothing looking wrong. An expired
 * refresh token in particular needs a person to act, and they will not if the
 * only symptom is that the answer quietly got older.
 *
 * Run: npm run test:google-calendar
 */
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { openDatabase } from '../server/services/db.js';
import { OAuthStore } from '../server/services/oauth_store.js';
import { GoogleCalendarClient } from '../server/services/google_calendar.js';
import { CalendarService, CalendarUnavailableError } from '../server/services/calendar.js';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail?: string) {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
function eq(name: string, actual: any, expected: any) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, ok, ok ? undefined : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function section(t: string) { console.log(`\n▸ ${t}`); }

const dir = mkdtempSync(join(tmpdir(), 'iris-gcal-'));

function freshStore(): OAuthStore {
  const db = openDatabase(join(dir, `s${Math.floor(process.hrtime()[1])}.db`));
  return new OAuthStore(db);
}

/** A fetch that answers from a script and records what it was asked. */
function stubFetch(
  routes: Array<{ match: RegExp; status?: number; body: any; text?: string }>,
  log: Array<{ url: string; body?: string }> = []
) {
  const impl = (async (input: any, init?: any) => {
    const url = String(input);
    log.push({ url, body: init?.body ? String(init.body) : undefined });
    const route = routes.find((r) => r.match.test(url));
    if (!route) throw new Error(`unrouted: ${url}`);
    const status = route.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => route.body,
      text: async () => route.text ?? JSON.stringify(route.body),
    } as any;
  }) as unknown as typeof fetch;
  return { impl, log };
}

const CALENDAR_LIST = {
  items: [{ id: 'primary', summary: '個人' }, { id: 'work@x', summary: '講義' }],
};

async function main() {
  // -----------------------------------------------------------------------
  section('Nothing is attempted without a credential');

  {
    const store = freshStore();
    const client = new GoogleCalendarClient({ store, clientId: 'cid' });
    check('an unauthorized client reports itself as unconfigured', !client.configured());

    store.saveTokens('calendar', { access_token: 'a', expires_in: 3600 });
    check('a stored token makes it configured', client.configured());

    // Without a client id there is nothing to refresh with, whatever is stored.
    const noClient = new GoogleCalendarClient({ store, clientId: '' });
    check('a missing client id leaves it unconfigured', !noClient.configured());
  }

  // -----------------------------------------------------------------------
  section('Refreshing must not lose the refresh token');

  {
    const store = freshStore();
    // Already expired, so the next read must refresh.
    store.saveTokens('calendar', {
      access_token: 'old', refresh_token: 'the-refresh-token', expires_in: -60,
    });

    const { impl, log } = stubFetch([
      // Google's refresh response, which deliberately carries no refresh_token.
      { match: /oauth2\.googleapis\.com\/token/, body: { access_token: 'new', expires_in: 3600 } },
      { match: /calendarList/, body: CALENDAR_LIST },
      { match: /events/, body: { items: [] } },
    ]);

    const client = new GoogleCalendarClient({ store, clientId: 'cid', clientSecret: 's', fetchImpl: impl });
    await client.read(7);

    const after = store.getTokens('calendar');
    eq('the new access token is stored', after?.access_token, 'new');
    // The one that matters. Writing the response through as-is drops this.
    eq('the refresh token survives a refresh', after?.refresh_token, 'the-refresh-token');
    check('the token endpoint was called', log.some((l) => /oauth2/.test(l.url)));
    check('and the refresh grant was used', log.some((l) => /grant_type=refresh_token/.test(l.body ?? '')));
    check('the new access token is what gets sent', store.status('calendar').hasRefreshToken);
  }

  {
    const store = freshStore();
    store.saveTokens('calendar', { access_token: 'good', refresh_token: 'r', expires_in: 3600 });
    const { impl, log } = stubFetch([
      { match: /oauth2/, body: {} },
      { match: /calendarList/, body: CALENDAR_LIST },
      { match: /events/, body: { items: [] } },
    ]);
    await new GoogleCalendarClient({ store, clientId: 'cid', fetchImpl: impl }).read(7);
    check('a valid token is not refreshed for no reason', !log.some((l) => /oauth2/.test(l.url)));
  }

  // -----------------------------------------------------------------------
  section('An expired refresh token says what has to happen');

  {
    const store = freshStore();
    store.saveTokens('calendar', { access_token: 'old', refresh_token: 'dead', expires_in: -60 });
    const { impl } = stubFetch([
      {
        match: /oauth2/, status: 400,
        body: { error: 'invalid_grant' },
        text: '{"error":"invalid_grant","error_description":"Token has been expired or revoked."}',
      },
    ]);

    let raised: CalendarUnavailableError | null = null;
    try {
      await new GoogleCalendarClient({ store, clientId: 'cid', fetchImpl: impl }).read(7);
    } catch (err) { raised = err as CalendarUnavailableError; }

    check('it fails rather than returning nothing quietly', raised !== null);
    eq('an expired grant is its own code', raised?.code, 'refresh_expired');
    // Not a transient fault to retry through: a person has to consent again.
    check('and the hint says re-authorization is needed', /再認可/.test(raised?.hint ?? ''));
    check('the seven-day testing limit is named', /7日/.test(raised?.hint ?? ''));

    const other = stubFetch([{ match: /oauth2/, status: 503, body: {}, text: 'upstream' }]);
    let transient: CalendarUnavailableError | null = null;
    try {
      const s2 = freshStore();
      s2.saveTokens('calendar', { access_token: 'o', refresh_token: 'r', expires_in: -60 });
      await new GoogleCalendarClient({ store: s2, clientId: 'c', fetchImpl: other.impl }).read(7);
    } catch (err) { transient = err as CalendarUnavailableError; }
    check('a server fault is not reported as an expired grant', transient?.code === 'refresh_failed');
  }

  // -----------------------------------------------------------------------
  section('Recurring events are read as occurrences');

  {
    const store = freshStore();
    store.saveTokens('calendar', { access_token: 'a', expires_in: 3600 });
    const { impl, log } = stubFetch([
      { match: /calendarList/, body: CALENDAR_LIST },
      {
        match: /events/,
        body: {
          items: [
            { summary: '講義', start: { dateTime: '2026-08-20T09:00:00+09:00' }, end: { dateTime: '2026-08-20T10:30:00+09:00' } },
            { summary: '祝日', start: { date: '2026-08-22' }, end: { date: '2026-08-23' } },
            { summary: '取り消された会議', status: 'cancelled', start: { dateTime: '2026-08-21T09:00:00+09:00' } },
          ],
        },
      },
    ]);

    const reading = await new GoogleCalendarClient({ store, clientId: 'c', fetchImpl: impl }).read(14);

    // Without singleEvents Google returns the recurrence rule, so a weekly
    // lecture appears once at whatever date the series was defined.
    check('occurrences are expanded, not the series', log.every((l) => !/events/.test(l.url) || /singleEvents=true/.test(l.url)));
    check('ordering is asked for at the source', log.some((l) => /orderBy=startTime/.test(l.url)));

    eq('cancelled events are dropped', reading.events.filter((e) => e.title === '取り消された会議').length, 0);
    // Two calendars, two events each.
    eq('every visible calendar is read', reading.calendarsVisible, 2);
    eq('and named', reading.calendarNames, ['個人', '講義']);

    const allDay = reading.events.find((e) => e.title === '祝日');
    check('an all-day event is marked as one', allDay?.allDay === true);
    // A date has no time, and giving it one would be inventing precision.
    eq('and keeps a date rather than a timestamp', allDay?.start, '2026-08-22');

    const timed = reading.events.find((e) => e.title === '講義');
    check('a timed event keeps its offset', /\+09:00$/.test(timed?.start ?? ''));
    eq('the source is stated', reading.source, 'google');
    check('and when it was read', Boolean(reading.readAt));
  }

  // -----------------------------------------------------------------------
  section('Falling back is allowed; falling back quietly is not');

  {
    // A cache that is present and readable, so the fallback has somewhere to go.
    const cachePath = join(dir, 'calendar.json');
    writeFileSync(cachePath, JSON.stringify({
      synced_at: new Date().toISOString(),
      days: 14,
      events: [{ summary: 'キャッシュの予定', date: '2026-08-20', calendar: '個人' }],
    }));

    // readCalendarCache reads a fixed path, so the fallback is exercised
    // through a live source that fails rather than by moving the cache.
    const failing = {
      configured: () => true,
      read: async () => {
        throw new CalendarUnavailableError(
          'refresh_expired', '更新トークンが失効しました。', '再認可してください。'
        );
      },
    };

    const service = new CalendarService(() => { throw new Error('no binary'); }, [{ name: 'google', source: failing }]);
    let result: any;
    let threw: any = null;
    try { result = await service.readBest(14); } catch (err) { threw = err; }

    const outcome = result ?? threw;
    // Either path is acceptable — what is not acceptable is arriving without
    // the reason the better source was skipped.
    check('the failure travels with the result', Array.isArray(outcome?.fellBackFrom));
    const note = (outcome?.fellBackFrom ?? [])[0];
    eq('it names the source that failed', note?.from, 'google');
    eq('and why', note?.code, 'refresh_expired');
    check('and what to do about it', /再認可/.test(note?.hint ?? ''));
  }

  {
    // The ordinary case: the live source answers, and nothing is noted.
    const working = {
      configured: () => true,
      read: async () => ({
        source: 'google' as const, events: [], days: 14, elapsedMs: 1,
        calendarsVisible: 1, calendarNames: ['個人'], readAt: new Date().toISOString(),
      }),
    };
    // No cache path, so the live source is the only one that answers.
    const service = new CalendarService(() => { throw new Error('no binary'); }, [{ name: 'google', source: working }], join(dir, 'absent.json'));
    const reading: any = await service.readBest(14);
    eq('a lone source is returned as itself', reading.source, 'google');
    // Not being able to read a cache that was never configured is not a
    // fallback from anything.
    check('and the missing cache is noted rather than hidden', (reading.fellBackFrom ?? []).some((f: any) => f.from === 'cache'));
  }

  {
    // No credential yet: the live source is skipped without being called, and
    // without being recorded as a failure — not having authorized is not the
    // same as something going wrong.
    let called = false;
    const unconfigured = {
      configured: () => false,
      read: async () => { called = true; throw new Error('should not be called'); },
    };
    const service = new CalendarService(() => { throw new Error('no binary'); }, [{ name: 'google', source: unconfigured }]);
    let outcome: any;
    try { outcome = await service.readBest(14); } catch (err) { outcome = err; }
    check('an unconfigured source is not called', !called);
    check(
      'and is not reported as a failure',
      !(outcome?.fellBackFrom ?? []).some((f: any) => f.from === 'google')
    );
  }


  // -----------------------------------------------------------------------
  section('A source answering is not a source answering completely');

  {
    // Measured on 2026-08-19 and the reason this merge exists. The FDP cache
    // held 16 events across three calendars; Google held 12 across one. The
    // four Google could not see lived in 自宅 and 職場, which exist in
    // Calendar.app and not in the Google account — and one was an appointment
    // two days out, while the daily focus reported the next event as the exam
    // five days out.
    const shared = { title: '薬理学37-39', start: '2026-08-24T09:40', end: null, allDay: false, calendar: 'gmail' };
    const googleOnly = { title: '神経科学本試験', start: '2026-08-24T08:30', end: null, allDay: false, calendar: 'gmail' };
    const localOnly = { title: 'けやき台 面談', start: '2026-08-21', end: null, allDay: true, calendar: '職場' };

    const live = {
      configured: () => true,
      read: async () => ({
        source: 'google' as const, events: [googleOnly, shared], days: 14, elapsedMs: 5,
        calendarsVisible: 1, calendarNames: ['gmail'], readAt: new Date().toISOString(),
      }),
    };

    const cachePath = join(dir, 'merge-cache.json');
    writeFileSync(cachePath, JSON.stringify({
      ok: true,
      synced_at: new Date().toISOString(),
      days: 14,
      events: [
        { summary: shared.title, date: '2026-08-24', time: '09:40', calendar: 'gmail', allday: false },
        { summary: localOnly.title, date: '2026-08-21', calendar: '職場', allday: true },
      ],
    }));

    const service = new CalendarService(() => { throw new Error('no binary'); }, [{ name: 'google', source: live }], cachePath);
    const merged: any = await service.readBest(14);

    eq('both sources produce a merged reading', merged.source, 'merged');
    const titles = merged.events.map((e: any) => e.title);
    check('the live source is represented', titles.includes('神経科学本試験'));
    // The one that matters: without the merge this appointment is invisible,
    // and it falls before the event the live source calls next.
    check('and so is the event only the local source has', titles.includes('けやき台 面談'));
    eq('the shared event appears once', titles.filter((t: string) => t === '薬理学37-39').length, 1);
    eq('three events in total, not four', merged.events.length, 3);
    check('and they are in time order', merged.events[0].start <= merged.events[1].start);

    // A source contributing nothing unique could be dropped; one contributing
    // an appointment cannot. Neither is visible from the total.
    const bySource = Object.fromEntries(merged.contributions.map((c: any) => [c.source, c]));
    eq('google contributed two', bySource.google.events, 2);
    eq('both of which were new at the time', bySource.google.unique, 2);
    eq('the cache also held two', bySource.cache.events, 2);
    eq('but only one of them was unique', bySource.cache.unique, 1);
    check('the cache reports its age', typeof bySource.cache.ageMs === 'number');
    check('and whether it is stale', typeof bySource.cache.stale === 'boolean');
    eq('the calendars are unioned', merged.calendarNames, ['gmail', '職場']);
  }

  {
    // Identity is title plus the minute it starts, because the sources share
    // no identifier — Google has its own event ids and the cache has none.
    const at = (calendar: string) => ({
      title: '会議', start: '2026-08-21T10:00:00+09:00', end: null, allDay: false, calendar,
    });
    const live = {
      configured: () => true,
      read: async () => ({
        source: 'google' as const, events: [at('gmail')], days: 14, elapsedMs: 1,
        calendarsVisible: 1, calendarNames: ['gmail'], readAt: new Date().toISOString(),
      }),
    };
    const cachePath = join(dir, 'dup-cache.json');
    writeFileSync(cachePath, JSON.stringify({
      ok: true, synced_at: new Date().toISOString(), days: 14,
      events: [{ summary: '会議', date: '2026-08-21', time: '10:00', calendar: '職場', allday: false }],
    }));

    const merged: any = await new CalendarService(
      () => { throw new Error('no binary'); }, [{ name: 'google', source: live }], cachePath
    ).readBest(14);

    // The same appointment, filed under a different calendar name in each
    // source. Collapsing it is the point; the calendar name is not identity.
    eq('the same appointment under two calendar names collapses', merged.events.length, 1);
    eq('and the second source adds nothing unique',
       merged.contributions.find((c: any) => c.source === 'cache').unique, 0);
  }

  {
    // One source failing must not cost the answer.
    const failing = {
      configured: () => true,
      read: async () => { throw new CalendarUnavailableError('refresh_expired', '失効', '再認可してください。'); },
    };
    const cachePath = join(dir, 'solo-cache.json');
    writeFileSync(cachePath, JSON.stringify({
      ok: true, synced_at: new Date().toISOString(), days: 14,
      events: [{ summary: 'ギター会', date: '2026-08-19', calendar: '自宅', allday: true }],
    }));

    const reading: any = await new CalendarService(
      () => { throw new Error('no binary'); }, [{ name: 'google', source: failing }], cachePath
    ).readBest(14);

    eq('the surviving source answers', reading.events.length, 1);
    eq('as itself rather than as a merge', reading.source, 'cache');
    eq('and the failure travels with it', reading.fellBackFrom[0].code, 'refresh_expired');
  }

  {
    // Every source failing is the only case that raises.
    const failing = {
      configured: () => true,
      read: async () => { throw new CalendarUnavailableError('refresh_expired', '失効'); },
    };
    let raised: any = null;
    try {
      await new CalendarService(
        () => { throw new Error('no binary'); }, [{ name: 'google', source: failing }], join(dir, 'nothing.json')
      ).readBest(14);
    } catch (err) { raised = err; }
    check('no source at all is an error', raised !== null);
    check('and every attempt is listed', (raised?.fellBackFrom ?? []).length >= 2);
  }

  // -----------------------------------------------------------------------
  // 同じ問いを使い回す。**書いたら捨てる。**
  //
  // 一回の `readBest` は網の向こうを叩くので約2秒（実測 2026-09-28、
  // `/api/calendar` 三連続で 2.16 / 2.11 / 2.76 秒）。それを六つの口が別々に
  // 繰り返し呼んでいた。使い回しは効くが、**書いた直後に古い答えを返すと、
  // 入れたものが「無い」と報告される** —— そこが確かめたいところ。
  {
    let reads = 0;
    let at = 1_000_000;
    const counting = {
      configured: () => true,
      read: async () => {
        reads++;
        return {
          source: 'google' as const, events: [], days: 14, elapsedMs: 1,
          calendarsVisible: 1, calendarNames: ['個人'], readAt: new Date(at).toISOString(),
        };
      },
    };
    const service = new CalendarService(
      () => { throw new Error('no binary'); },
      [{ name: 'google', source: counting }],
      join(dir, 'absent.json'),
      30_000,
      () => at
    );
    await service.readBest(14);
    await service.readBest(14);
    await service.readBest(14);
    eq('同じ日数の続けての問いは、一度しか網を叩かない', reads, 1);

    await service.readBest(2);
    eq('日数が違えば別の問い', reads, 2);

    at += 31_000;
    await service.readBest(14);
    eq('30秒を過ぎたら取り直す', reads, 3);
    // 待たずに古いものが返る。**30秒ごとに誰かが待つ役に当たらないため。**
    await new Promise((r) => setTimeout(r, 0));
    at += 31_000;
    const before = reads;
    await service.readBest(14);
    eq('古くなっても、返るのは手元の答え（裏で取り直す）', reads, before + 1);

    /*
     * 書いたあとは、手元の答えを**捨てる**（古いものを返さない）。入れた予定が
     * 「無い」と報告されるのを防ぐのはここ。
     */
    await new Promise((r) => setTimeout(r, 0));
    const beforeForget = reads;
    service.forget();
    await service.readBest(14);
    eq('書いたあと（forget）は取り直して、待って返す', reads, beforeForget + 1);

    // 書く側のための読みは、使い回しを使わないし、使い回しにも入れない。
    // 別の器で確かめる —— 同じ器では、直前の答えがまだ新しくて判別できない。
    let fresh = 0;
    const writerService = new CalendarService(
      () => { throw new Error('no binary'); },
      [{ name: 'google', source: { configured: () => true, read: async () => { fresh++; return {
        source: 'google' as const, events: [], days: 14, elapsedMs: 1,
        calendarsVisible: 1, calendarNames: ['個人'], readAt: new Date(at).toISOString(),
      }; } } }],
      join(dir, 'absent.json'),
      30_000,
      () => at
    );
    await writerService.readBest(14, { excludeCache: true });
    await writerService.readBest(14, { excludeCache: true });
    eq('書く側のための読みは、毎回網を叩く', fresh, 2);
    await writerService.readBest(14);
    eq('その読みは使い回しにも入らない', fresh, 3);
  }
  {
    // 失敗した答えは覚えない。**一度の不通を30秒引き延ばさない。**
    let attempts = 0;
    let at = 2_000_000;
    const flaky = {
      configured: () => true,
      read: async () => {
        attempts++;
        throw new CalendarUnavailableError('unreachable', 'network');
      },
    };
    const service = new CalendarService(
      () => { throw new Error('no binary'); },
      [{ name: 'google', source: flaky }],
      join(dir, 'absent.json'),
      30_000,
      () => at
    );
    for (const _ of [1, 2]) {
      try { await service.readBest(14); } catch { /* 両方とも失敗する */ }
    }
    check('失敗は覚えないので、次の問いはまた試す', attempts === 2, `attempts=${attempts}`);
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Google calendar: ${passed} passed, ${failed} failed`);
  rmSync(dir, { recursive: true, force: true });
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('All Google calendar tests passed.');
}

main().catch((err) => {
  rmSync(dir, { recursive: true, force: true });
  console.error('\nTest harness crashed:', err);
  process.exit(1);
});
