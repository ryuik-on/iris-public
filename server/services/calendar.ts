import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { readFileSync, statSync, existsSync, unlinkSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';

/**
 * Local calendar events, read through the Swift helper's EventKit path.
 *
 * Replaces a 60–75 second AppleScript walk with a 10ms predicate query. The
 * old approach had no way to ask for a date range, so every question read
 * every event and discarded most of them.
 *
 * The permission story is the interesting part, and it is not about code.
 * macOS attributes a calendar request to the *responsible* process, not to
 * the binary making it. Run from a terminal, that is the terminal — and a
 * terminal that already holds a write-only decision hands the helper a
 * write-only answer, with no prompt and no way to widen it from here.
 * Launched by launchd, the helper is its own responsible process and its own
 * grant applies. Measured both ways; the difference is total.
 */

export interface CalendarEvent {
  title: string;
  start: string | null;
  end: string | null;
  allDay: boolean;
  calendar: string;
  location?: string;
}

export interface CalendarReading {
  events: CalendarEvent[];
  days: number;
  elapsedMs: number;
  /**
   * How many calendars this process can see.
   *
   * Reported alongside the events because zero events and zero calendars look
   * identical and mean opposite things — the second is a permission problem
   * wearing the costume of a quiet fortnight.
   */
  calendarsVisible: number;
  calendarNames: string[];
}

export class CalendarUnavailableError extends Error {
  constructor(public readonly code: string, message: string, public readonly hint?: string) {
    super(message);
    this.name = 'CalendarUnavailableError';
  }
}

/**
 * The cache the Founder Development Program dashboard already maintains.
 *
 * Reading it sidesteps the permission problem entirely: something else has
 * already done the asking, and this is a file. The catch is that a file has
 * no idea whether it is current — and this particular one sat seven days
 * stale while the dashboard rendered from it every morning without saying so.
 *
 * So freshness is reported as loudly as the contents. A week-old calendar
 * presented as today's is worse than no calendar, because nothing about it
 * looks wrong.
 */
export const FDP_CALENDAR_CACHE = join(
  homedir(),
  'Documents/Founder-Development-Program/.cache/calendar.json'
);

export interface CachedCalendar extends CalendarReading {
  source: 'cache';
  /** When the cache was written, as the writer recorded it. */
  syncedAt: string | null;
  ageMs: number;
  /** True once the cache is old enough that it should not be presented as now. */
  stale: boolean;
  /**
   * Set when the last sync attempt failed but the previous events were kept.
   *
   * Age alone does not distinguish "nothing has run" from "it runs every hour
   * and fails every hour". Both show as a growing number, and only the second
   * means something is broken and waiting will not fix it.
   */
  lastError?: string | null;
  lastAttemptAt?: string | null;
}

/** Beyond this, "today's schedule" is a claim the file cannot support. */
export const CACHE_STALE_AFTER_MS = 12 * 60 * 60 * 1000;

export function readCalendarCache(
  path = FDP_CALENDAR_CACHE,
  now = Date.now()
): CachedCalendar {
  if (!existsSync(path)) {
    throw new CalendarUnavailableError(
      'cache_missing',
      `カレンダーキャッシュがありません: ${path}`,
      'FDP の calendar_sync.py を実行してください（Calendar.app が起動している必要があります）。'
    );
  }

  const raw = JSON.parse(readFileSync(path, 'utf8'));

  // A failed sync writes its failure into this file, in place of the events.
  //
  // The writer replaces the cache whether or not the fetch succeeded, and the
  // failure payload carries `ok: false`, an `error`, and a `synced_at` of the
  // moment it gave up. Read as a bag of events that is simply empty, it
  // becomes the worst possible reading: a calendar with nothing in it that
  // correctly claims to be seconds old. Every staleness check passes, because
  // nothing here is stale — the data is gone, not old.
  //
  // So the flag is honoured before the events are. An empty fortnight and a
  // sync that could not run are different facts, and only one of them means
  // the schedule is clear.
  if (raw && !Array.isArray(raw) && raw.ok === false) {
    throw new CalendarUnavailableError(
      'cache_failed',
      `カレンダー同期が失敗した記録が残っています: ${String(raw.error ?? '理由不明')}`,
      'Calendar.app が起動している状態で calendar_sync.py を実行してください。' +
        'このファイルには予定が入っていないため、0件として読むことはできません。'
    );
  }

  const entries: any[] = Array.isArray(raw) ? raw : (raw?.events ?? []);
  // Prefer the writer's own timestamp; fall back to the file's mtime, which
  // is a weaker claim but still better than pretending not to know.
  const syncedAt: string | null = typeof raw?.synced_at === 'string' ? raw.synced_at : null;
  const writtenMs = syncedAt ? Date.parse(syncedAt) : statSync(path).mtimeMs;
  const ageMs = Math.max(0, now - (Number.isFinite(writtenMs) ? writtenMs : now));

  const events: CalendarEvent[] = entries.map((e) => ({
    title: String(e.summary ?? e.title ?? '(無題)'),
    // The cache stores local date and time separately; kept as written rather
    // than converted, since inventing a timezone would be inventing precision.
    start: e.date ? `${e.date}${e.time ? `T${e.time}` : ''}` : null,
    end: null,
    allDay: Boolean(e.allday ?? e.allDay),
    calendar: String(e.calendar ?? ''),
  }));

  return {
    source: 'cache',
    events,
    days: Number(raw?.days ?? 0),
    elapsedMs: 0,
    // A cache cannot say which calendars were visible when it was written, so
    // it does not claim to.
    calendarsVisible: new Set(events.map((e) => e.calendar).filter(Boolean)).size,
    calendarNames: [...new Set(events.map((e) => e.calendar).filter(Boolean))].sort(),
    syncedAt,
    ageMs,
    stale: ageMs > CACHE_STALE_AFTER_MS,
    ...(typeof raw?.last_error === 'string' ? { lastError: raw.last_error } : {}),
    ...(typeof raw?.last_attempt_at === 'string' ? { lastAttemptAt: raw.last_attempt_at } : {}),
  };
}

/**
 * Why a better source was not used.
 *
 * Attached to the reading rather than logged and forgotten. Falling back is
 * the right behaviour — an answer from a stale cache beats no answer — but a
 * fallback nobody is told about is how the dashboard rendered a week-old
 * calendar every morning without anything looking wrong. In particular, a
 * refresh token that has expired needs a person to consent again, and that
 * will not happen if the only symptom is that the answer quietly got older.
 */
export interface SourceFallback {
  from: string;
  code: string;
  message: string;
  hint?: string;
}

/** What one source contributed to a combined reading. */
export interface SourceContribution {
  source: string;
  events: number;
  /** Events only this source had. The number that says whether it is needed. */
  unique: number;
  calendars: string[];
  /** For a file: how old it was. Absent for a live source. */
  ageMs?: number;
  stale?: boolean;
  /** Set when the file's writer recorded that its last attempt failed. */
  lastError?: string | null;
}

/** Anything `readBest` can return, with the fallback note it may carry. */
export type BestCalendarReading = (
  | CachedCalendar
  | (CalendarReading & { source: 'eventkit' })
  | (CalendarReading & { source: 'google'; readAt: string })
  | (CalendarReading & { source: 'icloud'; readAt: string })
  | (CalendarReading & { source: 'merged' })
) & {
  fellBackFrom?: SourceFallback[];
  /** Present when more than one source answered. */
  contributions?: SourceContribution[];
};

/**
 * Identity for merging, and the reason it is title + start rather than an id.
 *
 * The sources have no identifier in common. Google returns its own event ids;
 * the FDP cache, written from AppleScript, carries none at all. What both
 * record is what the thing is called and when it begins, and two events with
 * the same title at the same minute are the same appointment for every
 * practical purpose here. The cost of being wrong is one duplicate line, which
 * is visible; the cost of not merging is a missing appointment, which is not.
 */
function eventIdentity(e: CalendarEvent): string {
  const start = (e.start ?? '').slice(0, 16);
  return `${e.title.trim()}\0${start}`;
}

/**
 * A source read over the network, supplied rather than constructed.
 *
 * Both Google and iCloud fit this: what the service needs from either is
 * whether it has credentials and what it can see, and keeping construction
 * outside means the token store and the CalDAV password each stay in one
 * place.
 */
export interface LiveCalendarSource {
  configured(): boolean;
  read(days: number): Promise<CalendarReading & { source: string }>;
}

export class CalendarService {
  constructor(
    private binaryPath: () => string,
    /**
     * Network sources, in the order their names should appear.
     *
     * A list rather than one source, because the measurement that produced
     * this design was precisely that no single source sees everything.
     */
    private liveSources: Array<{ name: string; source: LiveCalendarSource }> = [],
    /**
     * Where the local cache lives.
     *
     * A parameter rather than the module constant it defaults to, because
     * reaching for a fixed path inside the method made the merge untestable:
     * whether two sources answered depended on whether this particular
     * machine happened to have a cache, so the same test passed here and
     * would have failed on a fresh checkout. A test that cannot decide how
     * many sources exist is not testing the merge.
     */
    private cachePath: string = FDP_CALENDAR_CACHE
  ) {}

  /**
   * Every event any source can see, merged.
   *
   * This was a preference order before, Google first, and that was wrong in a
   * way worth writing down. Google answers with what is true now and needs no
   * local permission, which made it the obvious first choice — but what it can
   * answer about is only what Google knows. Measured on 2026-08-19: the FDP
   * cache held 16 events across three calendars, Google held 12 across one.
   * The four it could not see lived in 自宅 and 職場, which exist in
   * Calendar.app and not in the Google account. One of them was an appointment
   * two days out, while the daily focus was confidently reporting the next
   * event as the exam five days out.
   *
   * That is the same shape of error as everything else this file guards
   * against. A source answering is not a source answering completely, in
   * exactly the way that a connection succeeding is not a credential working
   * and a fresh timestamp is not data being present.
   *
   * So all of them are read and the results are combined. Each source's
   * contribution is reported, including how many events only it had — because
   * a source contributing nothing unique can be dropped, and a source
   * contributing four cannot, and neither fact is visible from the total.
   *
   * Failure is per-source and never fatal on its own: a reading is returned as
   * long as one source answered, with the others' failures attached.
   */
  async readBest(
    days = 14,
    options: {
      /**
       * Skip the local cache.
       *
       * For the one caller that writes the cache. Without it the cache is an
       * input to the reading that becomes the cache — every stale event
       * re-reads itself into the next write and never ages out, so the file
       * would preserve its own contents forever while looking freshly synced.
       */
      excludeCache?: boolean;
    } = {}
  ): Promise<BestCalendarReading> {
    const fellBackFrom: SourceFallback[] = [];

    const note = (from: string, err: unknown) => {
      const e = err as CalendarUnavailableError;
      fellBackFrom.push({
        from,
        code: e?.code ?? 'unknown',
        message: e?.message ?? String(err),
        ...(e?.hint ? { hint: e.hint } : {}),
      });
    };

    const readings: Array<{ source: string; reading: CalendarReading; ageMs?: number; stale?: boolean }> = [];

    // Read together rather than in turn: they do not depend on each other,
    // and a slow one should not delay the rest.
    const liveResults = await Promise.all(
      this.liveSources
        .filter(({ source }) => source.configured())
        .map(async ({ name, source }) => {
          try {
            return { name, reading: await source.read(days) };
          } catch (err) {
            return { name, error: err };
          }
        })
    );
    for (const result of liveResults) {
      if ('error' in result) note(result.name, result.error);
      else readings.push({ source: result.name, reading: result.reading });
    }

    if (!options.excludeCache) {
      try {
        const cached = readCalendarCache(this.cachePath);
        readings.push({ source: 'cache', reading: cached, ageMs: cached.ageMs, stale: cached.stale });
      } catch (err) {
        note('cache', err);
      }
    }

    // Only when neither of the others produced anything. EventKit is refused
    // under launchd, so asking it routinely would cost a subprocess and a
    // timeout for nothing.
    if (readings.length === 0) {
      try {
        readings.push({ source: 'eventkit', reading: await this.read(days) });
      } catch (err) {
        note('eventkit', err);
      }
    }

    if (readings.length === 0) {
      const first = fellBackFrom[0];
      const raised = new CalendarUnavailableError(
        first?.code ?? 'no_source',
        first?.message ?? 'どのカレンダーソースも応答しませんでした。',
        first?.hint
      ) as CalendarUnavailableError & { fellBackFrom?: SourceFallback[] };
      raised.fellBackFrom = fellBackFrom;
      throw raised;
    }

    // One source: return it as itself, so `syncedAt`/`stale`/`readAt` survive
    // rather than being flattened into a merged shape that has neither.
    if (readings.length === 1) {
      const only = readings[0];
      const single =
        only.source === 'cache'
          ? (only.reading as CachedCalendar)
          : { ...only.reading, source: only.source as 'google' | 'icloud' | 'eventkit' };
      return fellBackFrom.length ? ({ ...single, fellBackFrom } as BestCalendarReading) : (single as BestCalendarReading);
    }

    const seen = new Set<string>();
    const events: CalendarEvent[] = [];
    const contributions: SourceContribution[] = [];

    /**
     * 生きた源がその日に持っている題名。**控えが同じものを足さないため。**
     *
     * 同一判定は「題名＋開始時刻」なので、**予定の時刻が変わると、控えの
     * 古い写しが別の予定として通る。**2026-09-08、日程表に合わせて
     * 病理学Ⅱ31-32 を 09:40 から 08:30 へ直したら、翌日にその授業が二つ
     * 並んだ —— 直した方（08:30）と、控えに残っていた方（09:40）。
     *
     * 控えは**生きた源が答えないときに穴を埋めるもの**で、答えているものに
     * 重ねるためのものではない。同じ日に同じ題名があるなら、生きた方が新しい。
     *
     * 日で見て時刻を見ないのは、**時刻こそが食い違う場所**だから。時刻まで
     * 見ると、いま直したいものだけがすり抜ける。
     */
    /*
     * 生きた源が読んでいるカレンダーについては、控えを使わない。
     *
     * 控えは**答えられなかったものを埋めるため**にある。いま読めている
     * カレンダーの写しを足すのは、埋めるのではなく古い版を混ぜること。
     *
     * 実測 2026-09-08: 控えの file は9月1日から更新されておらず（7.6日）、
     * **消した予定がその中に残って、消したのに画面に出続けた。**
     *
     * カレンダーの名前で見る。「生きた源が全部答えたら控えは使わない」に
     * すると広すぎて、**どの源も読んでいないカレンダーの予定が消える** ——
     * 試験がその形を押さえている（google だけが生きている構成で、控えにしか
     * ない「職場」の面談が見えなくなる）。控えが要るのはまさにそこ。
     */
    const liveCalendars = new Set<string>();
    for (const { source, reading } of readings) {
      if (source === 'cache') continue;
      for (const name of reading.calendarNames ?? []) liveCalendars.add(name);
      for (const event of reading.events) if (event.calendar) liveCalendars.add(event.calendar);
    }

    const liveTitlesByDay = new Set<string>();
    for (const { source, reading } of readings) {
      if (source === 'cache') continue;
      for (const event of reading.events) {
        const day = String(event.start ?? '').slice(0, 10);
        if (day) liveTitlesByDay.add(`${day} ${(event.title ?? '').replace(/[\s　]+/g, '')}`);
      }
    }

    for (const { source, reading, ageMs, stale } of readings) {
      let unique = 0;
      for (const event of reading.events) {
        if (source === 'cache' && event.calendar && liveCalendars.has(event.calendar)) continue;
        if (source === 'cache') {
          const day = String(event.start ?? '').slice(0, 10);
          const key = `${day} ${(event.title ?? '').replace(/[\s　]+/g, '')}`;
          // 生きた源が同じ日に同じ題名を持っているなら、控えの写しは出さない。
          if (day && liveTitlesByDay.has(key)) continue;
        }
        const id = eventIdentity(event);
        if (seen.has(id)) continue;
        seen.add(id);
        events.push(event);
        unique++;
      }
      contributions.push({
        source,
        events: reading.events.length,
        unique,
        calendars: reading.calendarNames,
        ...(ageMs !== undefined ? { ageMs } : {}),
        ...(stale !== undefined ? { stale } : {}),
        ...((reading as CachedCalendar).lastError
          ? { lastError: (reading as CachedCalendar).lastError }
          : {}),
      });
    }

    events.sort((a, b) => (a.start ?? '').localeCompare(b.start ?? ''));
    const calendarNames = [...new Set(readings.flatMap((r) => r.reading.calendarNames))].sort();

    return {
      source: 'merged',
      events,
      days,
      elapsedMs: readings.reduce((sum, r) => sum + (r.reading.elapsedMs || 0), 0),
      calendarsVisible: calendarNames.length,
      calendarNames,
      contributions,
      ...(fellBackFrom.length ? { fellBackFrom } : {}),
    };
  }

  /**
   * TCC は**起動した側**を責任者にする。
   *
   * 2026-09-07、測って分かった。カレンダーの許可の記録は起動元ごとに付いて
   * いて、`/bin/bash` が「追加のみ」、`com.anthropic.claude-code` が
   * 「追加のみ」、そして **launchd から起動した node には記録が無い**
   * （`notDetermined`）。ヘルパーの束（`local.iris.speech`）にフルアクセスを
   * 与えても、**束が責任者でなければ使われない。**
   *
   * `open` で起動すると LaunchServices が束を責任者にするので、束の許可が
   * 効く。実測で 95〜216ms、`LSUIElement` なので Dock にも出ない。
   *
   * 最初は直に叩く。速いし、開発者の shell に許可があればそれで通る。
   * 断られたときだけ `open` に落とし、**落ちたことは覚えておく** ——
   * launchd の下では毎回断られるので、覚えないと毎回二度手間になる。
   */
  private needsAppLaunch = false;

  async read(days = 14, timeoutMs = 60_000): Promise<CalendarReading> {
    if (!this.needsAppLaunch) {
      try {
        return await this.readBySpawn(days, timeoutMs);
      } catch (err) {
        const code = (err as CalendarUnavailableError)?.code ?? '';
        // 許可の話でなければ、そのまま投げる。落とす先は許可の問題にだけ。
        if (code !== 'calendar_denied' && code !== 'calendar_prompt_unanswered') throw err;
        this.needsAppLaunch = true;
      }
    }
    return this.readByAppLaunch(days, timeoutMs);
  }

  /**
   * 束をアプリとして起動し、書き出させたものを読む。
   *
   * `open` は起動したら戻ってしまうので `-W` で終わりを待つ。`--out` に
   * 書かせるのは、**`open` 経由では標準出力が繋がらない**から —— 直に叩く
   * ときと同じ形の行が、ファイルに並ぶ。
   */
  private async readByAppLaunch(days: number, timeoutMs: number): Promise<CalendarReading> {
    const binary = this.binaryPath();
    /*
     * 束の場所を、実行ファイルの位置から遡って求める。
     * `.../IrisSpeech.app/Contents/MacOS/IrisSpeech` の三つ上。
     */
    const marker = '.app/Contents/MacOS/';
    const at = binary.indexOf(marker);
    if (at < 0) {
      throw new CalendarUnavailableError(
        'calendar_denied',
        'カレンダーを読む許可がなく、束としても起動できません。',
        'ヘルパーが .app の中にありません。`swift/iris-speech` を組み直してください。'
      );
    }
    const app = binary.slice(0, at + 4);
    const out = join(tmpdir(), `iris-calendar-${randomUUID().slice(0, 8)}.jsonl`);

    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn('/usr/bin/open', ['-W', '-a', app, '--args', 'calendar', '--days', String(days), '--out', out], {
          stdio: ['ignore', 'ignore', 'pipe'],
          cwd: tmpdir(),
        });
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new CalendarUnavailableError('timeout', `カレンダーの読み取りが ${timeoutMs}ms を超えました。`));
        }, timeoutMs);
        let stderr = '';
        child.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });
        child.on('error', (err) => { clearTimeout(timer); reject(err); });
        child.on('close', (code) => {
          clearTimeout(timer);
          if (code !== 0) reject(new CalendarUnavailableError('exit', stderr.trim() || `open exit ${code}`));
          else resolve();
        });
      });

      let text: string;
      try {
        text = readFileSync(out, 'utf8');
      } catch {
        /*
         * 起動はしたが何も書かれていない。**「予定が0件」とは言わない。**
         * 束が落ちたのか、許可がまだ無いのか、こちらには区別が付かない。
         */
        throw new CalendarUnavailableError(
          'no_result',
          'ヘルパーを起動しましたが、読み取り結果が書き出されませんでした。'
        );
      }
      return this.parseHelperOutput(text);
    } finally {
      try { unlinkSync(out); } catch { /* 残っても害は無い */ }
    }
  }

  /** ヘルパーが出す行（直でも `--out` でも同じ形）を読む。 */
  private parseHelperOutput(text: string): CalendarReading {
    const events: any[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { events.push(JSON.parse(line)); } catch { /* 一行の崩れは致命ではない */ }
    }
    const failure = events.find((e) => e.event === 'error');
    if (failure) throw new CalendarUnavailableError(failure.code, failure.message, failure.hint);
    const reading = events.find((e) => e.event === 'calendar');
    if (!reading) {
      throw new CalendarUnavailableError('no_result', 'カレンダーの読み取り結果が返りませんでした。');
    }
    return {
      events: (reading.events ?? []).map((e: any) => ({
        title: e.title,
        start: e.start ?? null,
        end: e.end ?? null,
        allDay: Boolean(e.allDay),
        calendar: e.calendar ?? '',
        location: e.location,
      })),
      days: reading.days,
      elapsedMs: reading.elapsedMs,
      calendarsVisible: reading.calendarsVisible ?? 0,
      calendarNames: reading.calendarNames ?? [],
    } as CalendarReading;
  }

  private readBySpawn(days = 14, timeoutMs = 60_000): Promise<CalendarReading> {
    return new Promise((resolve, reject) => {
      let binary: string;
      try {
        binary = this.binaryPath();
      } catch (err) {
        reject(err);
        return;
      }

      // Never the repository: a child inheriting a working directory inside a
      // TCC-guarded folder hangs in dyld before main.
      const child = spawn(binary, ['calendar', '--days', String(days)], {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: tmpdir(),
      });

      let pending = '';
      const events: any[] = [];
      let stderr = '';

      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new CalendarUnavailableError('timeout', `カレンダーの読み取りが ${timeoutMs}ms を超えました。`));
      }, timeoutMs);

      child.stdout.on('data', (chunk: Buffer) => {
        pending += chunk.toString('utf8');
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            events.push(JSON.parse(line));
          } catch {
            /* the exit code carries the failure; a stray line is not fatal */
          }
        }
      });
      child.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });

      child.on('error', (err) => { clearTimeout(timer); reject(err); });
      child.on('close', (code) => {
        clearTimeout(timer);
        const failure = events.find((e) => e.event === 'error');
        if (failure) {
          reject(new CalendarUnavailableError(failure.code, failure.message, failure.hint));
          return;
        }
        if (code !== 0) {
          reject(new CalendarUnavailableError('exit', stderr.trim() || `exit ${code}`));
          return;
        }
        const reading = events.find((e) => e.event === 'calendar');
        if (!reading) {
          reject(new CalendarUnavailableError('no_result', 'カレンダーの読み取り結果が返りませんでした。'));
          return;
        }
        resolve({
          events: (reading.events ?? []).map((e: any) => ({
            title: e.title,
            start: e.start ?? null,
            end: e.end ?? null,
            allDay: Boolean(e.allDay),
            calendar: e.calendar ?? '',
            location: e.location,
          })),
          days: reading.days,
          elapsedMs: reading.elapsedMs,
          calendarsVisible: reading.calendarsVisible ?? 0,
          calendarNames: reading.calendarNames ?? [],
        });
      });
    });
  }
}

/**
 * The events still ahead, soonest first.
 *
 * Needed once more than one source is read. Google is asked for a window
 * beginning now and so returns nothing in the past, but the local cache holds
 * whatever was in its window when it was written — including this morning.
 * Merging the two therefore reintroduced past events, and the daily focus
 * announced a 13:00 appointment as "next" at nearly five in the afternoon.
 *
 * An all-day event is treated as running to the end of its day rather than
 * from midnight, because a date carries no time and dropping it at 00:01 would
 * hide a thing that is happening today. A timed event is past once its start
 * has passed; the end is not consulted, since only one source records one.
 */
export function upcomingEvents(events: CalendarEvent[], now = Date.now()): CalendarEvent[] {
  const todayLocal = new Date(now);
  const today =
    `${todayLocal.getFullYear()}-${String(todayLocal.getMonth() + 1).padStart(2, '0')}` +
    `-${String(todayLocal.getDate()).padStart(2, '0')}`;

  return events
    .filter((e) => {
      if (!e.start) return false;
      // Date only: still ahead for the whole of that day.
      if (!e.start.includes('T')) return e.start >= today;
      const at = Date.parse(e.start);
      // A timestamp without an offset is local wall-clock, which Date.parse
      // reads as local — the cache writes them that way on purpose.
      return Number.isFinite(at) ? at >= now : e.start.slice(0, 10) >= today;
    })
    .sort((a, b) => (a.start ?? '').localeCompare(b.start ?? ''));
}
