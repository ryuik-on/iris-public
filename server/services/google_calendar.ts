import { OAuthStore, StoredTokens } from './oauth_store.js';
import { CalendarEvent, CalendarReading, CalendarUnavailableError } from './calendar.js';

/**
 * The calendar, read through Google's ordinary REST API.
 *
 * This exists because the two sources that came before it each fail in a way
 * that is invisible from the outside.
 *
 * EventKit is fast and local, but macOS attributes its permission to whichever
 * process is *responsible* for the request rather than to the binary making
 * it. Under launchd — the way IRIS actually runs — that attribution refuses,
 * and no amount of code changes it.
 *
 * The FDP cache works, because something else already did the asking. But a
 * file cannot tell you whether it is current, and this one sat seven days
 * stale while the dashboard rendered from it every morning. Reading it is
 * reading a claim about the past dressed as the present.
 *
 * The REST API has neither problem: it needs no local permission and it
 * answers with what is true now. It is also the path that works — Google's
 * Calendar *MCP* server refuses every `tools/call` with "The caller does not
 * have permission" for the same credential that this returns 200 for.
 *
 * What it costs is a token to look after, which is the rest of this file.
 */

/**
 * The window starts at the beginning of today, not at this moment.
 *
 * Asking from `now` quietly drops everything earlier today, so a schedule
 * opened in the afternoon reports the morning as though it never happened.
 * Which events are still ahead is a question for whoever is answering it —
 * `upcomingEvents` does that for "what is next" — and a source that has
 * already discarded them cannot be asked.
 */
function startOfToday(now: number): Date {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d;
}

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/calendar/v3';

/** Refresh this far ahead of expiry rather than after a 401. */
const REFRESH_MARGIN_MS = 5 * 60_000;

export interface GoogleCalendarOptions {
  store: OAuthStore;
  clientId: string;
  clientSecret?: string;
  serverId?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  onEvent?: (event: { type: string; detail?: Record<string, any> }) => void;
}

export interface GoogleCalendarReading extends CalendarReading {
  source: 'google';
  /** When this was read. A live source can say so; a cache cannot. */
  readAt: string;
}

/** 終日の予定の終わりは翌日（排他）。同じ日だと長さゼロで拒まれる。 */
function nextDay(date: string): string {
  const at = new Date(`${date}T00:00:00`);
  at.setDate(at.getDate() + 1);
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
}

/**
 * 終わりが無い予定に、送るときだけ置く長さ。
 *
 * **一時間に根拠は無い。**だから下書きには入れず、確認を通ったあとの
 * 送信時にだけ足す。人が見た画面には「終了時刻は書かれていません」と
 * 出ていて、そのうえで登録を選んでいる。
 */
function plusHour(value: string): string {
  const at = new Date(`${value}:00`);
  at.setHours(at.getHours() + 1);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}T${p(at.getHours())}:${p(at.getMinutes())}`;
}

export class GoogleCalendarClient {
  private readonly serverId: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private options: GoogleCalendarOptions) {
    this.serverId = options.serverId ?? 'calendar';
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }

  /** Whether there is a credential to try at all. */
  configured(): boolean {
    return Boolean(this.options.clientId) && this.options.store.status(this.serverId).hasToken;
  }

  /**
   * A usable access token, refreshed if it is about to expire.
   *
   * Refreshed ahead of expiry rather than in response to a 401, because a 401
   * arrives in the middle of answering a question and the retry has to be
   * threaded through every call site. Checking the clock first is one place.
   */
  private async accessToken(): Promise<string> {
    const tokens = this.options.store.getTokens(this.serverId);
    if (!tokens?.access_token) {
      throw new CalendarUnavailableError(
        'not_authorized',
        'Google カレンダーの認可がありません。',
        'POST /api/mcp/oauth/start で認可を開始してください。'
      );
    }

    const status = this.options.store.status(this.serverId);
    const expiresAt = status.expiresAt ? Date.parse(status.expiresAt) : null;
    const expiringSoon = expiresAt !== null && expiresAt - Date.now() < REFRESH_MARGIN_MS;
    if (!expiringSoon) return tokens.access_token;

    if (!tokens.refresh_token) {
      throw new CalendarUnavailableError(
        'no_refresh_token',
        'アクセストークンが期限切れで、更新トークンがありません。',
        '再認可が必要です。認可要求に access_type=offline が付いているか確認してください。'
      );
    }

    return this.refresh(tokens.refresh_token);
  }

  private async refresh(refreshToken: string): Promise<string> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: this.options.clientId,
      ...(this.options.clientSecret ? { client_secret: this.options.clientSecret } : {}),
    });

    const response = await this.withTimeout((signal) =>
      this.fetchImpl(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        signal,
      })
    );

    if (!response.ok) {
      // Distinguished deliberately. An expired refresh token is not a network
      // problem to retry through — it means a person has to consent again, and
      // saying so is the only useful thing to do with it. Google issues
      // refresh tokens that expire after seven days while an OAuth client is
      // External and in Testing, so this is the expected end of every
      // credential here, not an anomaly.
      const detail = await response.text().catch(() => '');
      const expired = response.status === 400 && /invalid_grant/.test(detail);
      this.options.onEvent?.({
        type: 'google_calendar.refresh_failed',
        // The response body of a token endpoint is not somewhere to be casual
        // about; only the classification is recorded.
        detail: { server: this.serverId, status: response.status, expired },
      });
      throw new CalendarUnavailableError(
        expired ? 'refresh_expired' : 'refresh_failed',
        expired
          ? '更新トークンが失効しました。'
          : `トークンの更新に失敗しました (HTTP ${response.status})。`,
        expired
          ? 'OAuth クライアントが「テスト中」の間、更新トークンは7日で失効します。再認可してください。'
          : undefined
      );
    }

    const refreshed = (await response.json()) as StoredTokens;

    // Google does not return the refresh token on a refresh. Writing the
    // response through as-is drops it, and the next expiry becomes a re-consent
    // that nobody can explain — the credential looked fine an hour earlier.
    this.options.store.saveTokens(this.serverId, {
      ...refreshed,
      refresh_token: refreshed.refresh_token ?? refreshToken,
    });
    this.options.onEvent?.({ type: 'google_calendar.refreshed', detail: { server: this.serverId } });

    return refreshed.access_token;
  }

  private withTimeout<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    return run(controller.signal).finally(() => clearTimeout(timer));
  }

  private async get(path: string, params: Record<string, string>): Promise<any> {
    const token = await this.accessToken();
    const url = new URL(`${API}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    const response = await this.withTimeout((signal) =>
      this.fetchImpl(url, { headers: { authorization: `Bearer ${token}` }, signal })
    );

    if (!response.ok) {
      const detail: any = await response.json().catch(() => ({}));
      throw new CalendarUnavailableError(
        `http_${response.status}`,
        `Google カレンダー API がエラーを返しました (HTTP ${response.status})。` +
          (detail?.error?.message ? ` ${detail.error.message}` : ''),
        response.status === 403
          ? 'スコープが足りないか、Calendar API が無効の可能性があります。'
          : undefined
      );
    }
    return response.json();
  }

  /** The calendars this credential can see, by name. */
  async listCalendars(): Promise<string[]> {
    const data = await this.get('/users/me/calendarList', { maxResults: '250' });
    return (data.items ?? [])
      .map((c: any) => String(c.summary ?? c.id ?? ''))
      .filter(Boolean)
      .sort();
  }

  /**
   * Events in the next `days`, across every visible calendar.
   *
   * `singleEvents=true` is not a preference. Without it Google returns the
   * recurrence rule rather than its occurrences, so a weekly lecture appears
   * once — at whatever date the series was defined — and every question about
   * "this week" is answered from a series definition instead of a schedule.
   */
  async read(days = 14, from?: Date): Promise<GoogleCalendarReading> {
    const started = Date.now();
    /*
     * 始まりを渡されたら、その日の 0 時から丸 `days` 日。渡されなければ
     * 今までどおり「今日の 0 時から、いまから `days` 日後まで」。**既定の
     * 窓は変えない** —— 他の呼び出し口はすべてこちらを前提にしている。
     */
    const min = from ? startOfToday(from.getTime()) : startOfToday(started);
    const timeMin = min.toISOString();
    const timeMax = from
      ? new Date(min.getFullYear(), min.getMonth(), min.getDate() + days).toISOString()
      : new Date(started + days * 86_400_000).toISOString();

    const calendars = await this.listCalendarIds();
    const events: CalendarEvent[] = [];

    for (const { id, name } of calendars) {
      let pageToken: string | undefined;
      // Bounded rather than while(true): a paging bug on either side should
      // cost a short answer, not a process that never returns.
      for (let page = 0; page < 10; page++) {
        const data = await this.get(`/calendars/${encodeURIComponent(id)}/events`, {
          timeMin,
          timeMax,
          singleEvents: 'true',
          orderBy: 'startTime',
          maxResults: '250',
          ...(pageToken ? { pageToken } : {}),
        });

        for (const item of data.items ?? []) {
          if (item.status === 'cancelled') continue;
          events.push({
            title: String(item.summary ?? '(無題)'),
            // `date` for all-day, `dateTime` otherwise. Kept as Google wrote
            // them — a dateTime carries its offset, and a date deliberately
            // does not, because an all-day event does not have a time.
            start: item.start?.dateTime ?? item.start?.date ?? null,
            end: item.end?.dateTime ?? item.end?.date ?? null,
            allDay: Boolean(item.start?.date && !item.start?.dateTime),
            calendar: name,
            ...(item.location ? { location: String(item.location) } : {}),
          });
        }

        pageToken = data.nextPageToken;
        if (!pageToken) break;
      }
    }

    events.sort((a, b) => (a.start ?? '').localeCompare(b.start ?? ''));

    return {
      source: 'google',
      events,
      days,
      elapsedMs: Date.now() - started,
      // Zero events and zero calendars look identical and mean opposite
      // things; the second is a permission problem wearing the costume of a
      // quiet fortnight.
      calendarsVisible: calendars.length,
      calendarNames: calendars.map((c) => c.name).sort(),
      readAt: new Date(started).toISOString(),
    };
  }

  /**
   * 書き込める相手だけを返す。
   *
   * `calendarList` は読めるものを全部返す —— 日本の祝日も、共有されている
   * 誰かの予定も。そこへ書こうとすると 403 が返るが、**選ばせてから断るのは
   * 一往復遅い。**`accessRole` が `owner` か `writer` のものだけを渡す。
   *
   * `primary` を印として返すのは、既定をどれにするか画面側が決められるように。
   * **こちらでは決めない** —— どの箱に入れるかは持ち主のもので、今回は
   * 「毎回聞く」と決まっている。
   */
  async listWritableCalendars(): Promise<Array<{ id: string; name: string; primary: boolean }>> {
    const data = await this.get('/users/me/calendarList', { maxResults: '250' });
    return (data.items ?? [])
      .filter((c: any) => c.id && (c.accessRole === 'owner' || c.accessRole === 'writer'))
      .map((c: any) => ({
        id: String(c.id),
        name: String(c.summary ?? c.id),
        primary: c.primary === true,
      }));
  }

  /**
   * 予定を一件作る。**呼ぶ前に承認を通っていること。**
   *
   * ここには承認の判断が無い。あるのは書き込みだけで、**呼ばれたら書く。**
   * 判断を両方に置くと、片方だけ通せば書ける道ができる。
   *
   * `timeZone` を必ず渡す。省くとカレンダーの既定の帯で解釈されるので、
   * **同じ文字列が別の時刻になる。**打った人は自分の時計で打っているので、
   * ずれても「そう書いた」ようにしか見えない。
   */
  async createEvent(input: {
    calendarId: string;
    title: string;
    /** `2026-09-08T15:00`、終日なら `2026-09-08`。 */
    start: string;
    end: string | null;
    allDay: boolean;
    location?: string | null;
    timeZone: string;
  }): Promise<{ id: string; htmlLink: string | null }> {
    const when = (value: string) =>
      input.allDay ? { date: value } : { dateTime: `${value}:00`, timeZone: input.timeZone };

    /*
     * 終わりが無いときは Google が受け取らないので、こちらで置く。
     *
     * **下書きの段では埋めなかったもの**を、ここで初めて埋める。分けてあるのは、
     * 人が確認する画面には「終了時刻は書かれていません」と出したいから ——
     * 一時間と埋めた下書きを見せると、推測が入力と同じ顔になる。**確認を
     * 通ったあとに、送るために埋めるのは別の話。**
     *
     * 終日の予定の `end` は Google では**翌日**（排他）。同じ日を渡すと
     * 長さゼロで拒まれる。
     */
    const endValue = input.allDay
      ? (input.end ?? nextDay(input.start))
      : (input.end ?? plusHour(input.start));

    const body = {
      summary: input.title,
      start: when(input.start),
      end: when(endValue),
      ...(input.location ? { location: input.location } : {}),
    };

    const data = await this.post(
      `/calendars/${encodeURIComponent(input.calendarId)}/events`,
      body
    );
    return { id: String(data.id ?? ''), htmlLink: data.htmlLink ? String(data.htmlLink) : null };
  }

  /**
   * その日、その題名の予定を探す。**書き換える相手を、こちらで決めない。**
   *
   * 併合した読み取りは id を持っていない（源が三つあり、id は源ごとに別）。
   * 書き換えるには id が要るので、**Google に直接聞く。**日付と題名で
   * 一件に絞れなければ `null` を返す —— 二件あるときにどちらかを選ぶのは、
   * こちらのすることではない。
   */
  async findEvent(calendarId: string, date: string, title: string): Promise<{ id: string; start: string | null } | null> {
    const fold = (t: string) => t.replace(/[\s　]+/g, '');
    /*
     * 一日の境目は**地方時**で切る。`Z` を付けると九時間ずれる。
     *
     * `2026-09-10T00:00:00Z` は JST の 09:00。窓は「10日の朝9時から11日の
     * 朝9時まで」になり、**翌日の朝の授業が入ってくる。**実測 2026-09-08:
     * 9/10 の 病理学Ⅱ35-36実習 を探したら、9/11 08:30 の同じ授業も窓に入って
     * 二件になり、「一件に絞れない」として null を返した —— 消したいものが
     * 見つからない、という形で出た。
     *
     * 同じ間違いをこの機械で三度目にやっている（カレンダーの食い違い検知で
     * 二度）。**日付だけの値に `Z` を付けない。**
     */
    const offset = -new Date(`${date}T00:00:00`).getTimezoneOffset();
    const sign = offset >= 0 ? '+' : '-';
    const pad = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, '0');
    const zone = `${sign}${pad(offset / 60)}:${pad(offset % 60)}`;
    const data = await this.get(`/calendars/${encodeURIComponent(calendarId)}/events`, {
      timeMin: `${date}T00:00:00${zone}`,
      timeMax: `${date}T23:59:59${zone}`,
      singleEvents: 'true',
      maxResults: '50',
    });
    const want = fold(title);
    const hits = (data?.items ?? []).filter((e: any) => {
      const has = fold(String(e?.summary ?? ''));
      return has && (has.includes(want) || want.includes(has));
    });
    if (hits.length !== 1) return null;
    return { id: String(hits[0].id), start: hits[0]?.start?.dateTime ?? hits[0]?.start?.date ?? null };
  }

  /**
   * 既存の予定の時刻を書き換える。**作るのとは別の重さ。**
   *
   * 作るのは足すだけで、間違えても消せばいい。書き換えは**元の値が消える。**
   * だから題名も場所も触らない —— 直しに来た理由は時刻なので、時刻だけ送る。
   * PATCH なのはそのため（PUT は送らなかった欄を消す）。
   */
  async updateEventTime(input: {
    calendarId: string;
    eventId: string;
    start: string;
    end: string | null;
    timeZone: string;
  }): Promise<{ id: string }> {
    const when = (value: string) => ({ dateTime: `${value}:00`, timeZone: input.timeZone });
    const body: any = { start: when(input.start) };
    // 終わりを知らないなら送らない。**Google の側の値を残す。**
    if (input.end) body.end = when(input.end);
    const data = await this.patch(
      `/calendars/${encodeURIComponent(input.calendarId)}/events/${encodeURIComponent(input.eventId)}`,
      body
    );
    return { id: String(data?.id ?? input.eventId) };
  }

  /**
   * 予定を消す。**入れたものを取り消すため。**
   *
   * id を渡すのは呼び手で、ここは探さない。**探して消すと、探し方の間違いが
   * そのまま人の予定を消す。**取り消しに使うなら、入れたときに返した id が
   * 手元にある。
   */
  async deleteEvent(calendarId: string, eventId: string): Promise<void> {
    await this.send(
      'DELETE',
      `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      undefined
    );
  }

  private async patch(path: string, body: unknown): Promise<any> {
    return this.send('PATCH', path, body);
  }

  private async post(path: string, body: unknown): Promise<any> {
    return this.send('POST', path, body);
  }

  private async send(method: string, path: string, body: unknown): Promise<any> {
    const token = await this.accessToken();
    const response = await this.withTimeout((signal) =>
      this.fetchImpl(`${API}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal,
      })
    );

    if (!response.ok) {
      const detail: any = await response.json().catch(() => ({}));
      throw new CalendarUnavailableError(
        `http_${response.status}`,
        `Google カレンダーへの書き込みが断られました (HTTP ${response.status})。` +
          (detail?.error?.message ? ` ${detail.error.message}` : ''),
        /*
         * 403 のときは**再認可**を名指しする。
         *
         * 読み取りだけの権限で書こうとしたときにここへ来る。「スコープが
         * 足りないか、API が無効か」では、**どちらを直すのか分からない。**
         * 書き込みが 403 で返るのはほぼ一つの理由なので、そう言う。
         */
        response.status === 403
          ? '書き込みの権限がありません。認可をやり直してください' +
            '（POST /api/mcp/oauth/start に {"server":"calendar"}）。'
          : undefined
      );
    }
    /*
     * 本文の無い応答を、JSON として読まない。
     *
     * DELETE の成功は本文を返さない。204 だけを見ていたが、実際には **200 で
     * 本文が空**が返り、`response.json()` が `Unexpected end of JSON input` で
     * 落ちた。**消す要求はもう送られたあと**なので、13件が実際に消えたうえで
     * 13件とも失敗と報告した —— **やったことと言ったことが食い違う**、
     * いちばん困る形。
     *
     * 読み取り側（`get`）には入れない。あちらは必ず本文があり、試験の作り物の
     * 応答も `json()` しか持っていない。**直す場所を間違えると、直っていない
     * ものが直ったように見える。**
     */
    if (typeof (response as any).text !== 'function') return response.json();
    const raw = String(await (response as any).text());
    if (!raw.trim()) return {};
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  private async listCalendarIds(): Promise<Array<{ id: string; name: string }>> {
    const data = await this.get('/users/me/calendarList', { maxResults: '250' });
    return (data.items ?? [])
      .filter((c: any) => c.id)
      .map((c: any) => ({ id: String(c.id), name: String(c.summary ?? c.id) }));
  }
}
