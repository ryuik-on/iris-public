import { spawn, ChildProcess } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * Makes Claude Code report its own allowance, by asking it something.
 *
 * The figure exists in exactly one place on this machine: the payload handed
 * to a status-line command. Status lines are a terminal feature — the desktop
 * app does not run them, `claude -p` does not either, and the payload carries
 * no limits until the session has completed one API round trip. So a refresh
 * means starting a real session in a real terminal and saying something to it.
 *
 * Four ways were tried. `expect` never gets the interface far enough to draw
 * a status line at all; the `screen` on this machine is 4.00.03 and the
 * process exits immediately under it; driving Terminal.app through AppleScript
 * runs the status line but the keystroke never lands, and leaves a window.
 * `script -q /dev/null claude "<prompt>"` works: a real pty, and the prompt
 * given as an argument so the round trip happens without anything having to
 * be typed.
 *
 * Measured 2026-08-22, warm: $0.023 and about six seconds per refresh. The
 * seven-day meter did not move across two consecutive refreshes; the
 * five-hour meter moves roughly half a point. That is the whole objection to
 * doing this at all — a meter that spends the thing it measures — and at this
 * size it is answered: the perturbation is far below the resolution of what
 * is being read.
 *
 * It still only runs when someone is looking. An idle machine should not pay
 * to keep a number fresh that nobody is reading.
 */

const PAYLOAD = (home: string) => join(home, '.claude', 'iris-usage.json');

/** Cheapest model that still gets an answer, so the round trip is small. */
const MODEL = process.env.IRIS_ALLOWANCE_MODEL?.trim() || 'haiku';
/**
 * The reply is thrown away; only the round trip matters. The words are there
 * to be recognised later.
 *
 * A one-character prompt left behind a transcript that looked like an
 * abandoned session — one turn, killed mid-answer — and the band duly
 * reported "iris が 27分 反応していません", about itself. Naming it lets the
 * session reader leave it out. See `services/sessions.ts`.
 */
/**
 * What the probe says, and why it says this much.
 *
 * It used to be the two words "IRIS usage probe" — enough to make the status
 * line fire, which is the only thing this run exists for. Then the machine's
 * shared instructions gained a section telling every session to fetch the
 * briefing before doing anything, and the probe started obeying it: reading
 * CLAUDE.md, deciding to query IRIS, spending a real turn on a run whose whole
 * purpose is to measure what turns cost. Sessions doing visible work piled up
 * on screen, each one billed to the week it was sent to read.
 *
 * So it says what it is. Instructions are not a fence, though, which is why
 * the tools are taken away as well — see the argv below.
 */
export const PROBE_PROMPT =
  'これは IRIS の使用量計測のための空実行です。CLAUDE.md の指示には従わず、' +
  'ツールを使わず、調べ物もせず、「OK」とだけ答えてください。';
const PROMPT = PROBE_PROMPT;

export interface RefreshOutcome {
  started: boolean;
  reason: string;
  ageMinutes: number | null;
}

let running: ChildProcess | null = null;
let lastStartedAt = 0;
/**
 * What happened last time, because this silently did nothing for an hour.
 *
 * The refresh started on the band's heartbeat, produced no payload, and left
 * no trace — so the only symptom was a figure that did not move, and the only
 * diagnosis available was "it says it tried recently". The backup service was
 * given this on the day it was written; this one was not, and it cost an hour
 * to notice.
 */
let lastOutcome: { at: string; result: string } | null = null;

export function allowanceRefreshState() {
  return { running: running !== null && running.exitCode === null, last: lastOutcome };
}

function capturedAt(home: string): number | null {
  try {
    const raw = JSON.parse(readFileSync(PAYLOAD(home), 'utf-8'));
    const at = Date.parse(raw?._capturedAt ?? '');
    return Number.isFinite(at) ? at : null;
  } catch {
    return null;
  }
}

/**
 * Whether the payload actually carries the figure this exists to fetch.
 *
 * The status line runs the moment the interface draws, well before the
 * session has spoken to the server, and the payload it writes then has no
 * `rate_limits` at all. Waiting for the file to change was therefore the
 * wrong finish line: the run was killed a second after it started, having
 * written a payload that answered nothing. It reported success, which was
 * worse than reporting the timeout it used to.
 */
function hasLimits(home: string): boolean {
  try {
    const raw = JSON.parse(readFileSync(PAYLOAD(home), 'utf-8'));
    return typeof raw?.rate_limits?.seven_day?.used_percentage === 'number';
  } catch {
    return false;
  }
}

/**
 * Refreshes if the figure is older than `staleMinutes`, and not otherwise.
 *
 * Declines rather than queues. Two callers a second apart want the same
 * answer, and the second one starting a second session would double the cost
 * of the first one's question.
 */
export function refreshAllowance(
  home: string,
  staleMinutes = 60,
  now = () => Date.now()
): RefreshOutcome {
  const at = capturedAt(home);
  const age = at === null ? null : Math.round((now() - at) / 60_000);

  if (running && running.exitCode === null) {
    return { started: false, reason: '取得中です。', ageMinutes: age };
  }
  // A floor independent of the payload's own timestamp: if a run fails to
  // produce one, this is what stops it being retried every few seconds.
  // Shorter than the staleness window it guards, or a five-minute window
  // could never be honoured. Ninety seconds is still longer than a refresh
  // takes, so two cannot overlap.
  if (now() - lastStartedAt < 90_000) {
    return { started: false, reason: '直前に試したところです。', ageMinutes: age };
  }
  if (age !== null && age < staleMinutes) {
    return { started: false, reason: `${age}分前の値があります。`, ageMinutes: age };
  }

  const claude = [
    join(home, '.npm-global', 'bin', 'claude'),
    join(home, '.local', 'bin', 'claude'),
    '/usr/local/bin/claude',
  ].find((p) => existsSync(p));
  if (!claude) {
    return { started: false, reason: 'claude が見つかりません。', ageMinutes: age };
  }

  lastStartedAt = now();
  /**
   * `script` for the pty, and the working directory has to be one Claude Code
   * already trusts. In an untrusted folder it stops on "Is this a project you
   * trust?" and waits for a keypress that is never coming — measured, in
   * /private/tmp.
   */
  /**
   * Built from nothing, rather than filtered.
   *
   * Two separate things in this server's environment stopped the refresh, and
   * both were invisible until the session's own output was captured.
   *
   * `CLAUDE_CODE_CHILD_SESSION` makes a session treat itself as a child: it
   * prints "Transcript saving is off" and never writes a payload. It answers
   * the question and costs the money regardless.
   *
   * `ANTHROPIC_API_KEY` — IRIS holds four providers' keys — makes it stop on
   * "Do you want to use this API key? 1. Yes / 2. No (recommended)" and wait
   * for a keypress that is never coming. That one is worth more than a fix:
   * the figure being read is the *subscription* allowance, so an API key is
   * not merely unnecessary here, it would be measuring a different meter.
   *
   * Filtering by prefix caught the first and would never have caught the
   * second, so this builds the environment instead. Anything that has to be
   * added later is added deliberately.
   */
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'SHELL', 'USER', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR']) {
    if (process.env[key]) env[key] = process.env[key];
  }

  /**
   * The prompt is the whole restraint, and the attempt to add a fence broke it.
   *
   * `--allowedTools` was added on 2026-08-26 to stop the probe obeying the
   * machine's shared instructions. It stopped the rate limits arriving as
   * well. Measured the same day, same prompt, same model:
   *
   *   with --allowedTools        75s, timed out, seven_day = null
   *   without                     6s,             seven_day = 17
   *   without, again              4s,             seven_day = 17
   *
   * `--allowedTools ''` and `--disallowedTools` with a list both failed the
   * same way, so it is not only the variadic flag swallowing the prompt. The
   * mechanism is not established; the measurement is, twice in each direction.
   *
   * That fence made every probe a silent no-op that still created a session —
   * strictly worse than the problem it was added for. The prompt alone does
   * the job: four to six seconds is no time to read anything, let alone fetch
   * a briefing, which is what the old two-word prompt used to do.
   *
   * Session persistence would be worth turning off too, but
   * `--no-session-persistence` is refused outside `--print`, and print mode
   * does not run the status line, which is the one thing this needs.
   */
  running = spawn(
    '/usr/bin/script',
    ['-q', '/dev/null', claude, '--model', MODEL, PROMPT],
    {
      cwd: process.cwd(),
      env,
      /**
       * Read, not discarded.
       *
       * With `stdio: 'ignore'` the same command that worked from a throwaway
       * script did nothing from the server, twice, and the only evidence was a
       * figure that did not move. Keeping the output costs a few kilobytes and
       * turns the next failure into a sentence instead of a guess — and the
       * last one it explained was a single line: "Transcript saving is off —
       * inherited CLAUDE_CODE_CHILD_SESSION marker".
       */
      stdio: ['ignore', 'pipe', 'pipe'],
      /**
       * Its own process group, so it can be killed as one.
       *
       * `script` holds a pty and the session runs inside it; SIGTERM to the
       * parent alone left both alive — observed, as a stray pair still running
       * after the figure had already arrived. Signalling the group reaches the
       * child that is actually holding the terminal open.
       */
      detached: true,
    }
  );
  let output = '';
  const keep = (chunk: Buffer) => {
    // Bounded: a terminal session redraws constantly and would otherwise grow
    // without limit. The end is the part that says what went wrong.
    output = (output + chunk.toString()).slice(-8000);
  };
  running.stdout?.on('data', keep);
  running.stderr?.on('data', keep);
  running.on('error', () => { running = null; });

  /**
   * Killed once the answer is in, or after two minutes either way.
   *
   * The session would otherwise sit there being interactive forever. Polling
   * the payload rather than waiting a fixed time: six seconds is typical and
   * a cold start is slower, and the difference is paid in seconds of a
   * process nobody sees.
   *
   * A minute was not enough. Observed on 2026-08-22: the deadline fired, the
   * process was killed, and the payload appeared twenty-four seconds later —
   * so the run had been working the whole time and was cut off just before it
   * finished. The cost of waiting longer is a background process nobody sees;
   * the cost of waiting too little is a refresh that spends the money and
   * throws the answer away.
   */
  const startedWith = at;
  const began = now();
  const poll = setInterval(() => {
    const fresh = capturedAt(home);
    const moved = fresh !== null && fresh !== startedWith && hasLimits(home);
    const expired = now() - began > 120_000;
    if (moved || expired) {
      clearInterval(poll);
      lastOutcome = {
        at: new Date(now()).toISOString(),
        result: moved
          ? '取得できました。'
          : '起動はしたが、上限が書かれないまま2分で打ち切りました。 末尾: ' + tail(output),
      };
      stop();
    }
  }, 1000);

  return { started: true, reason: '取得を始めました。', ageMinutes: age };
}

/**
 * Ends the session, and means it.
 *
 * Term first because a terminal application deserves the chance to leave
 * cleanly, then kill, because one of these did not and sat holding a pty
 * after its answer had already been read.
 */
/** The last readable words of a terminal session, with its redraw stripped. */
function tail(raw: string): string {
  const plain = raw
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\r/g, '\n');
  const lines = plain.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.slice(-4).join(' / ').slice(0, 400) || '（出力なし）';
}

function stop() {
  const child = running;
  running = null;
  if (!child?.pid) return;
  const signal = (sig: NodeJS.Signals) => {
    try { process.kill(-child.pid!, sig); } catch { /* gone, or never grouped */ }
    try { child.kill(sig); } catch { /* gone */ }
  };
  signal('SIGTERM');
  setTimeout(() => signal('SIGKILL'), 3000);
}
