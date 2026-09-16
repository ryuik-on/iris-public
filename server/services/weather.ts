import { execFile } from 'child_process';
import { readFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * The weather, by way of a Shortcut.
 *
 * macOS has the forecast and will not hand it over. `~/Library/Weather/
 * weather-data.db` holds it in a private binary — 623 bytes per record, of
 * which two eight-byte doubles decode as timestamps and the rest does not
 * decode at all. Reverse-engineering that would produce a reader that breaks
 * on the next OS update, for one line of text.
 *
 * Shortcuts is the supported route: the same data, through an interface Apple
 * maintains, with location permission handled inside their own system rather
 * than by sending coordinates anywhere. It costs the user one three-step
 * shortcut, and nothing here works until they make it.
 *
 * Which is why an absent shortcut is reported by name rather than treated as
 * "no weather today". A missing forecast and a missing shortcut look identical
 * from the outside and want completely different things done about them.
 */

export interface WeatherRead {
  text: string | null;
  /** Why there is nothing, when there is nothing. Never silence. */
  reason: string | null;
  at: string;
  /**
   * Whether this came from the cache rather than from a run just now.
   *
   * A caller that cannot tell the difference cannot tell a working forecast
   * from one that stopped fifteen minutes ago and is still being handed out.
   */
  cached?: boolean;
  /** True when `text` is the last good reading rather than a current one. */
  stale?: boolean;
  /** How old that reading is. Present only when `stale`. */
  ageMinutes?: number;
}

/**
 * What one attempt did, for the record.
 *
 * The service returned `reason` to its caller and wrote it nowhere, so when
 * the user said the location lookup misses too often there was no way to say
 * how often, at what times, or with which failure. Their report was the only
 * evidence there was. Counting is the first fix, before any change is made to
 * the thing being counted — otherwise the next change is judged by the same
 * feeling it was meant to address.
 */
export interface WeatherOutcome {
  result: 'ok' | 'empty' | 'missing' | 'unreadable' | 'failed' | 'spawn_failed';
  /** How long the shortcut took, in milliseconds. Timeouts show up here. */
  ms: number;
  reason: string | null;
  /** The first characters of what came back, when anything did. */
  sample: string | null;
}

type OutcomeSink = (outcome: WeatherOutcome) => void;

let report: OutcomeSink = () => {};

/** Wired once at startup. Absent, the service behaves exactly as before. */
export function onWeatherOutcome(sink: OutcomeSink): void {
  report = sink;
}

const SHORTCUT = process.env.IRIS_WEATHER_SHORTCUT?.trim() || '天気テキスト';

/**
 * Cached for fifteen minutes.
 *
 * Running a shortcut spawns a process and can wake the location service; the
 * band asks every forty-five seconds and the weather does not change that
 * fast. The cache is what makes this cheap enough to sit on an always-on
 * surface at all.
 */
let cached: WeatherRead | null = null;
let cachedAt = 0;
/**
 * 一時間。十五分から延ばした。
 *
 * 空模様は十五分では変わらないし、**取りに行くたびに Shortcut が走って
 * 画面が動く。**利用者いわく「天気はマジで短くても1時間に一回でいい」
 * — 動いた対価に何も返っていないなら、動かす回数の方が間違っている。
 */
const TTL = 60 * 60_000;

/**
 * A failure is held for a minute, not for a quarter of an hour.
 *
 * The two are cached for opposite reasons. A forecast is kept because it is
 * still true; a failure is kept only to stop a broken thing being hammered
 * every forty-five seconds. Giving them the same lifetime meant one transient
 * miss — the shortcut left open in the editor, which makes `shortcuts run`
 * wait — put 「天気を取得できません」 on the band and kept it there for fifteen
 * minutes after the cause was gone. The band was reporting on a problem that
 * had already been fixed, which is the failure mode this project is about.
 */
const FAIL_TTL = 60_000;

/**
 * Reorders the shortcut's sentence, and only that sentence.
 *
 * The wording lives in a Text action the user wrote by hand, and it reads
 * "26°C 今日の天気は、曇り時々晴れです。" — the temperature stranded in front of
 * a clause about something else, which is where removing the date from the
 * middle of the template left it. The natural order is the one they asked
 * for: 今日の気温は26℃、曇り時々晴れです。
 *
 * Editing the shortcut would be the honest fix and is not available — the
 * Shortcuts app is reachable here by clicking only, and this needs typing.
 * So it is rewritten on the way through, against one exact pattern.
 *
 * Anything that does not match is passed along untouched. A loose rule that
 * half-matched would quietly mangle the sentence the moment they edited it,
 * and a wrong forecast is worse than an awkward one.
 */
export function phrase(text: string): string {
  const match = text.match(/^([-\d.]+)\s*[°℃]C?\s*今日の天気は、(.+?)です。?$/);
  if (!match) return rain(text);
  return rain(`今日の気温は${match[1]}℃、${match[2]}です。`);
}

/**
 * Says it is raining, when it is, as its own sentence.
 *
 * The condition is a summary of the day — "曇り時々晴れ" covers an afternoon —
 * and the thing worth interrupting someone for is whether it is raining on
 * them now. Asked for explicitly and only for rain: no other condition
 * changes what a person does in the next ten minutes.
 *
 * Matched on the condition the shortcut already reports rather than fetching
 * anything else, so it can only ever agree with the line above it.
 */
export function rain(text: string): string {
  if (!/雨/.test(text)) return text;
  if (text.includes('現在雨が降っています')) return text;
  return `${text} 現在雨が降っています。`;
}

/**
 * The last forecast that actually arrived, kept past its own freshness.
 *
 * A miss used to blank the band. But a forecast forty minutes old is still
 * mostly true — the temperature has not moved much and the sky has not
 * usually changed — while an empty line says nothing at all and looks like
 * IRIS has stopped working. Keeping it is only defensible if its age is said
 * out loud, which is why `ageMinutes` travels with it and the caller is
 * expected to show it.
 *
 * Two hours, then it goes. Past that the weather has genuinely moved on, and
 * a stale line would be the failure this project keeps finding: a plausible
 * number sitting where a broken one should be visible.
 */
const STALE_LIMIT = 2 * 60 * 60_000;
let lastGood: WeatherRead | null = null;
let lastGoodAt = 0;

/**
 * Hands back the last good reading when this one has nothing.
 *
 * The reason is kept alongside rather than replaced: the caller still needs to
 * know that the current attempt failed, or a recovering forecast and a stuck
 * one look the same.
 */
function withFallback(value: WeatherRead, now: () => number): WeatherRead {
  if (value.text) return value;
  if (!lastGood?.text) return value;
  const age = now() - lastGoodAt;
  if (age > STALE_LIMIT) return value;
  return {
    ...value,
    text: lastGood.text,
    stale: true,
    ageMinutes: Math.max(1, Math.round(age / 60_000)),
  };
}

export function readWeather(now = () => Date.now()): Promise<WeatherRead> {
  const age = now() - cachedAt;
  if (cached && age < (cached.text ? TTL : FAIL_TTL)) {
    return Promise.resolve(withFallback({ ...cached, cached: true }, now));
  }

  const startedAt = now();
  return new Promise((resolve) => {
    const out = join(tmpdir(), `iris-weather-${process.pid}.txt`);
    const done = (value: WeatherRead, result: WeatherOutcome['result']) => {
      try {
        report({
          result,
          ms: now() - startedAt,
          reason: value.reason,
          sample: value.text ? value.text.slice(0, 40) : null,
        });
      } catch {
        /* a report that could not be written is not a reason to lose the reading */
      }
      cached = value;
      cachedAt = now();
      if (value.text) {
        lastGood = value;
        lastGoodAt = now();
      }
      try {
        unlinkSync(out);
      } catch {
        /* nothing to remove */
      }
      resolve(withFallback(value, now));
    };

    /**
     * Killed after eight seconds.
     *
     * A shortcut that opens a window or waits for something never returns:
     * measured on 2026-08-21, the user's existing 天気 shortcut ran past two
     * minutes and produced no output at all. Without a deadline that becomes a
     * process left behind on every poll.
     *
     * Eight seconds against a measured two. The margin is for a cold start,
     * where the location service has to wake before the forecast exists.
     */
    const child = execFile(
      '/usr/bin/shortcuts',
      ['run', SHORTCUT, '-o', out],
      { timeout: 8000 },
      (error) => {
        if (error) {
          const missing = /couldn.t be found|見つかりません/i.test(String(error.message));
          done(
            {
              text: null,
              reason: missing
                ? `ショートカット「${SHORTCUT}」がありません。`
                : `ショートカット「${SHORTCUT}」が結果を返しませんでした。`,
              at: new Date(now()).toISOString(),
            },
            missing ? 'missing' : 'failed'
          );
          return;
        }
        try {
          /**
           * Whitespace collapsed, and nothing else touched.
           *
           * The text is the user's sentence, written in their own shortcut, and
           * rewriting it here would mean the band says something they did not
           * write. Runs of spaces are the exception: removing a variable from
           * the middle of a template leaves the gap it used to fill, which is
           * an artefact of editing rather than anything anyone typed.
           */
          const text = phrase(readFileSync(out, 'utf-8').replace(/[ \t\u3000]+/g, ' ').trim());
          done(
            text
              ? { text, reason: null, at: new Date(now()).toISOString() }
              : {
                  text: null,
                  reason: `ショートカット「${SHORTCUT}」が空を返しました。`,
                  at: new Date(now()).toISOString(),
                },
            text ? 'ok' : 'empty'
          );
        } catch {
          done(
            {
              text: null,
              reason: `ショートカット「${SHORTCUT}」の出力を読めませんでした。`,
              at: new Date(now()).toISOString(),
            },
            'unreadable'
          );
        }
      }
    );
    /**
     * Closed immediately, and this is the whole reason it works.
     *
     * `shortcuts run` reads its shortcut's input from standard input and will
     * not start until that stream ends. A shell hands it a terminal or
     * /dev/null, so it returns in two seconds; `execFile` hands it a pipe that
     * nobody ever closes, so it waits forever. Measured 2026-08-22: without
     * this line the same command sat for forty-five seconds and was killed,
     * with no output and no error to explain it — the shortcut looked broken
     * and was not.
     */
    child.stdin?.end();

    child.on('error', () => {
      done(
        { text: null, reason: 'shortcuts コマンドを実行できません。', at: new Date(now()).toISOString() },
        'spawn_failed'
      );
    });
  });
}
