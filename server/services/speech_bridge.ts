import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { SpeechAgent, LineTail } from './speech_agent.js';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { EventEmitter } from 'events';

/**
 * Talks to the on-device speech helper.
 *
 * The Speech framework is Swift-only, so transcription runs in a child
 * process that writes one JSON object per line. Audio never crosses this
 * boundary — only text does. That is the property that makes an always-on
 * microphone explicable, and it is a property of the process split, not of a
 * promise in a comment.
 *
 * Two rules this class exists to hold:
 *
 *   1. Only finalized text is kept. Volatile results are the transcriber
 *      thinking out loud — "は" becomes "はい。" a frame later — and storing
 *      them would put words in the user's mouth that they never finished
 *      saying.
 *
 *   2. Nothing is sent anywhere. Transcripts accumulate here until something
 *      explicitly takes them. An always-on microphone that forwards to a
 *      provider by itself is the failure this whole design is arranged to
 *      avoid.
 */

export type SpeechState = 'idle' | 'starting' | 'listening' | 'stopping' | 'unavailable';

export interface SpeechTranscript {
  text: string;
  /** Seconds into the listening session. */
  start: number | null;
  end: number | null;
  at: string;
}

export interface SpeechProbe {
  transcriberAvailable: boolean;
  /** Null when running as a bare CLI, where permission belongs to the parent. */
  bundleIdentifier?: string | null;
  bundled?: boolean;
  /** Set when the helper sits somewhere that will hang under launchd. */
  locationWarning?: string | null;
  requestedLocale: string;
  resolvedLocale: string | null;
  assetStatus: 'unsupported' | 'supported' | 'downloading' | 'installed' | string;
  supportedLocales: string[];
  installedLocales: string[];
  microphoneAuthorization: string;
}

/**
 * Folders macOS guards with TCC.
 *
 * Running from inside one is not a permissions inconvenience — it hangs. Under
 * launchd the helper never reached `main`: dyld blocked in getCWD() → open()
 * while resolving a working directory inside ~/Downloads, with no error, no
 * crash and no log. A feature that silently never starts is worse than one
 * that fails, so this is checked and named rather than left to be rediscovered.
 */
const TCC_PROTECTED_DIRS = ['Downloads', 'Documents', 'Desktop'];

export function protectedLocationWarning(binaryPath: string, home = process.env.HOME ?? ''): string | null {
  if (!home) return null;
  for (const dir of TCC_PROTECTED_DIRS) {
    const guarded = join(home, dir);
    if (binaryPath === guarded || binaryPath.startsWith(guarded + '/')) {
      return (
        `音声ヘルパが ~/${dir} 配下にあります（${binaryPath}）。` +
        'このフォルダは TCC の保護対象で、launchd などバックグラウンドから起動すると ' +
        'dyld が作業ディレクトリの解決で停止し、エラーも出さずにハングします。' +
        '常時起動させる場合は ~/Library/Application Support/IRIS などへ配置してください。'
      );
    }
  }
  return null;
}

export class SpeechHelperMissingError extends Error {
  constructor(public readonly searched: string[]) {
    super(
      'iris-speech ヘルパがビルドされていません。`npm run build:speech` を実行してください。' +
        `（探した場所: ${searched.join(', ')}）`
    );
    this.name = 'SpeechHelperMissingError';
  }
}

/**
 * Failures that will recur identically on restart.
 *
 * A supervisor that retries these spins forever: the microphone will not
 * become authorized because we asked a second time, and the model will not
 * install itself. They stop the bridge and say why.
 */
const TERMINAL_ERROR_CODES = new Set([
  'microphone_denied',
  'microphone_prompt_unanswered',
  'model_not_installed',
  'locale_unsupported',
  'transcriber_unavailable',
  'unknown_command',
  'no_audio_format',
  'converter_unavailable',
]);

const RESTART_BASE_MS = 1_000;
const RESTART_CAP_MS = 30_000;
const MAX_CONSECUTIVE_RESTARTS = 5;
const STOP_GRACE_MS = 5_000;
/** Roughly a long meeting. An always-on microphone must not grow without bound. */
const DEFAULT_BUFFER_LIMIT = 2_000;

/**
 * Where the helper is run from.
 *
 * Not the repository. A child process inherits its parent's working directory,
 * and if that sits inside a TCC-guarded folder the helper hangs in dyld before
 * main — resolving the cwd is itself a guarded read. The helper is invoked by
 * absolute path and needs no particular directory, so it is given a boring one.
 */
const SAFE_CWD = tmpdir();

export interface SpeechBridgeOptions {
  /** Overridden in tests with a stand-in that emits canned lines. */
  binaryPath?: string;
  locale?: string;
  bufferLimit?: number;
  onEvent?: (event: { type: string; detail?: Record<string, any> }) => void;
  spawnFn?: typeof spawn;
  /**
   * Run the helper as its own launchd job instead of as a child process.
   *
   * The difference is not tidiness. TCC attributes the microphone to whoever
   * launched the process: spawned from the IRIS service the helper reports
   * `notDetermined`, and started as its own LaunchAgent — same binary, same
   * bundle identifier, same grant on record — it reports `authorized`.
   *
   * Kept optional because the child-process path is the one that works while
   * developing, where the shell already holds a grant and there is no launchd
   * job to reinstall on every rebuild.
   */
  agent?: SpeechAgent;
  /** How often to read what the agent has written. */
  pollMs?: number;
}

export class SpeechBridge extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private transcripts: SpeechTranscript[] = [];
  private dropped = 0;
  private _state: SpeechState = 'idle';
  private restarts = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private stopRequested = false;
  private lastError: { code: string; message: string; hint?: string } | null = null;
  private startedAt: string | null = null;
  private readonly spawnFn: typeof spawn;
  private readonly bufferLimit: number;
  private partial = '';
  /** Set only in agent mode. */
  private tail: LineTail | null = null;
  private poller: NodeJS.Timeout | null = null;

  constructor(private options: SpeechBridgeOptions = {}) {
    super();
    this.spawnFn = options.spawnFn ?? spawn;
    this.bufferLimit = options.bufferLimit ?? DEFAULT_BUFFER_LIMIT;
  }

  get state(): SpeechState {
    return this._state;
  }

  /**
   * Where the compiled helper is.
   *
   * The bundle comes first, and the reason is not tidiness. A bare CLI has no
   * bundle identifier, so TCC attributes the microphone to whichever process
   * launched it: granted from one terminal, notDetermined from a server
   * started in another shell, with no prompt in between. Inside the bundle the
   * executable has an identity of its own and the decision sticks to it.
   *
   * The loose binaries are still accepted, because a developer who has only
   * run `swift build` should not be told the feature does not exist — they
   * will simply inherit whatever permission their shell has.
   */
  resolveBinary(root: string): string {
    if (this.options.binaryPath) return this.options.binaryPath;
    // An explicit install location wins, which is how a background-launched
    // IRIS avoids the guarded folder the repository happens to live in.
    const configured = process.env.IRIS_SPEECH_BINARY?.trim();
    if (configured) {
      if (!existsSync(configured)) throw new SpeechHelperMissingError([configured]);
      return configured;
    }
    const searched = [
      join(root, 'swift/iris-speech/IrisSpeech.app/Contents/MacOS/IrisSpeech'),
      join(root, 'swift/iris-speech/.build/release/IrisSpeech'),
      join(root, 'swift/iris-speech/.build/debug/IrisSpeech'),
    ];
    const found = searched.find((p) => existsSync(p));
    if (!found) throw new SpeechHelperMissingError(searched);
    return found;
  }

  /** Runs a one-shot subcommand and returns the events it emitted. */
  private runOnce(binary: string, args: string[], timeoutMs = 120_000): Promise<any[]> {
    return new Promise((resolve, reject) => {
      const child = this.spawnFn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'], cwd: SAFE_CWD });
      const events: any[] = [];
      let stderr = '';
      let pending = '';

      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`${args[0]} が ${timeoutMs}ms 以内に終了しませんでした。`));
      }, timeoutMs);

      child.stdout.on('data', (chunk: Buffer) => {
        pending += chunk.toString('utf8');
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) {
          const parsed = safeParse(line);
          if (parsed) events.push(parsed);
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        const failure = events.find((e) => e.event === 'error');
        if (code !== 0) {
          const err: any = new Error(failure?.message ?? stderr.trim() ?? `exit ${code}`);
          err.code = failure?.code;
          err.hint = failure?.hint;
          reject(err);
          return;
        }
        resolve(events);
      });
    });
  }

  async probe(root: string, locale = this.options.locale ?? 'ja-JP'): Promise<SpeechProbe> {
    const binary = this.resolveBinary(root);
    const events = await this.runOnce(binary, ['probe', '--locale', locale], 60_000);
    const probe = events.find((e) => e.event === 'probe');
    if (!probe) throw new Error('probe が結果を返しませんでした。');
    // Reported alongside a successful probe, because from a foreground shell
    // everything looks fine — the hazard only shows up once it is started by
    // something else, which is exactly when nobody is watching.
    return { ...(probe as SpeechProbe), locationWarning: protectedLocationWarning(binary) };
  }

  /** Downloads the on-device model. Slow the first time, a no-op after. */
  async install(root: string, locale = this.options.locale ?? 'ja-JP'): Promise<{ alreadyPresent: boolean }> {
    const binary = this.resolveBinary(root);
    const events = await this.runOnce(binary, ['install', '--locale', locale], 600_000);
    const done = events.find((e) => e.event === 'installed');
    if (!done) throw new Error('install が完了を報告しませんでした。');
    return { alreadyPresent: Boolean(done.alreadyPresent) };
  }

  start(root: string, locale = this.options.locale ?? 'ja-JP') {
    if (this._state === 'listening' || this._state === 'starting') return;
    this.stopRequested = false;
    this.lastError = null;
    this.restarts = 0;

    if (this.options.agent) {
      void this.startAgent();
      return;
    }
    const binary = this.resolveBinary(root);
    this.spawnListener(binary, locale);
  }

  /**
   * Starts the helper through launchd and reads the file it writes.
   *
   * No pipe exists in this direction — that is the point. A job launchd starts
   * on its own account is its own TCC responsible process, and stdout belongs
   * to launchd rather than to us.
   */
  private async startAgent() {
    const agent = this.options.agent!;
    this._state = 'starting';
    this.buffer = '';
    this.partial = '';

    const started = await agent.start();
    if (!started.ok) {
      this.lastError = { code: 'agent_start_failed', message: started.note ?? 'launchctl が失敗しました。' };
      this._state = 'unavailable';
      this.emitEvent('speech.agent_start_failed', { message: this.lastError.message });
      return;
    }

    this.tail = new LineTail(agent.transcriptPath);
    this.tail.reset();
    this.poller = setInterval(() => {
      if (this.stopRequested) return;
      for (const line of this.tail?.read() ?? []) this.handleLine(line);
    }, this.options.pollMs ?? 200);
    this.poller.unref?.();

    this.emitEvent('speech.agent_started', { label: 'local.iris.speech.listen' });
  }

  private spawnListener(binary: string, locale: string) {
    this._state = 'starting';
    this.buffer = '';
    this.partial = '';

    const child = this.spawnFn(binary, ['listen', '--locale', locale], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: SAFE_CWD,
    });
    this.child = child;

    child.stdout.on('data', (chunk: Buffer) => this.consume(chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim();
      if (text) this.emitEvent('speech.stderr', { message: text.slice(0, 500) });
    });

    child.on('error', (err) => {
      this.lastError = { code: 'spawn_failed', message: err.message };
      this._state = 'unavailable';
      this.emitEvent('speech.spawn_failed', { message: err.message });
    });

    child.on('close', (code, signal) => {
      this.child = null;
      if (this.stopRequested) {
        this._state = 'idle';
        this.emitEvent('speech.stopped', { code, signal });
        return;
      }
      this.handleUnexpectedExit(binary, locale, code, signal);
    });
  }

  private handleUnexpectedExit(binary: string, locale: string, code: number | null, signal: string | null) {
    // A configuration fault produces the same exit every time. Restarting it
    // makes a loud loop out of a quiet, fixable problem.
    if (this.lastError && TERMINAL_ERROR_CODES.has(this.lastError.code)) {
      this._state = 'unavailable';
      this.emitEvent('speech.unavailable', { ...this.lastError });
      return;
    }

    this.restarts++;
    if (this.restarts > MAX_CONSECUTIVE_RESTARTS) {
      this._state = 'unavailable';
      this.emitEvent('speech.gave_up', {
        restarts: this.restarts - 1,
        code,
        signal,
        message: this.lastError?.message ?? null,
      });
      return;
    }

    const delay = Math.min(RESTART_CAP_MS, RESTART_BASE_MS * 2 ** (this.restarts - 1));
    this._state = 'starting';
    this.emitEvent('speech.restarting', { attempt: this.restarts, delayMs: delay, code, signal });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.stopRequested) this.spawnListener(binary, locale);
    }, delay);
    this.restartTimer.unref?.();
  }

  /**
   * Closes stdin, which is how the helper is told to finish.
   *
   * It finalizes whatever was mid-utterance before exiting, so the end of the
   * user's last sentence survives the stop. SIGKILL is the backstop only: a
   * microphone left open by a process nobody is reading is the worst outcome
   * here, so the grace period is generous but finite.
   */
  async stop(): Promise<void> {
    if (this.options.agent) {
      this.stopRequested = true;
      this._state = 'stopping';
      if (this.poller) { clearInterval(this.poller); this.poller = null; }
      // Drained before the job goes away: the last utterance was written
      // before the process was told to stop, and dropping it because the
      // reader shut down first would lose speech that was actually heard.
      for (const line of this.tail?.read() ?? []) this.handleLine(line);
      this.tail = null;
      await this.options.agent.stop();
      this._state = 'idle';
      this.emitEvent('speech.stopped', { via: 'launchd' });
      return;
    }
    if (!this.child) {
      this._state = 'idle';
      return;
    }
    this.stopRequested = true;
    this._state = 'stopping';
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    const child = this.child;
    const exited = new Promise<void>((resolve) => child.once('close', () => resolve()));
    child.stdin.end();

    const killer = setTimeout(() => {
      this.emitEvent('speech.force_killed', { graceMs: STOP_GRACE_MS });
      child.kill('SIGKILL');
    }, STOP_GRACE_MS);
    killer.unref?.();

    await exited;
    clearTimeout(killer);
    this._state = 'idle';
  }

  private consume(chunk: string) {
    // NDJSON arrives in whatever sizes the pipe felt like; a line can be split
    // across two chunks, and parsing per-chunk would drop it.
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    for (const line of lines) this.handleLine(line);
  }

  private handleLine(line: string) {
    const parsed = safeParse(line);
    if (!parsed) {
      // A malformed line is a bug in the helper, not a reason to stop
      // listening. It is reported and skipped.
      if (line.trim()) this.emitEvent('speech.unparseable', { line: line.slice(0, 200) });
      return;
    }

    switch (parsed.event) {
      case 'ready':
        this._state = 'listening';
        this.restarts = 0;
        this.startedAt = parsed.at ?? new Date().toISOString();
        this.emitEvent('speech.listening', {
          locale: parsed.locale,
          sampleRate: parsed.sampleRate,
        });
        break;

      case 'partial':
        // Held, never stored. It exists so a UI can show the sentence forming.
        this.partial = String(parsed.text ?? '');
        this.emit('partial', this.partial);
        break;

      case 'final': {
        const transcript: SpeechTranscript = {
          text: String(parsed.text ?? '').trim(),
          start: numberOrNull(parsed.start),
          end: numberOrNull(parsed.end),
          at: parsed.at ?? new Date().toISOString(),
        };
        this.partial = '';
        if (!transcript.text) break;
        this.transcripts.push(transcript);
        if (this.transcripts.length > this.bufferLimit) {
          // Dropping the oldest is the lesser evil, but it is counted: a
          // reader that silently lost the start of a session should be able
          // to tell.
          this.transcripts.splice(0, this.transcripts.length - this.bufferLimit);
          this.dropped++;
        }
        this.emit('final', transcript);
        break;
      }

      case 'error':
        this.lastError = { code: parsed.code, message: parsed.message, hint: parsed.hint };
        this.emitEvent('speech.error', this.lastError);
        break;

      case 'stopped':
        break;

      default:
        this.emitEvent('speech.unknown_event', { event: parsed.event });
    }
  }

  /**
   * Hands over what has been heard, and forgets it.
   *
   * Reading is destructive on purpose: the caller is taking responsibility for
   * these words, and leaving a copy behind invites the same sentence being
   * acted on twice.
   */
  drain(): { transcripts: SpeechTranscript[]; dropped: number } {
    const transcripts = this.transcripts;
    const dropped = this.dropped;
    this.transcripts = [];
    this.dropped = 0;
    return { transcripts, dropped };
  }

  /** Reads without consuming, for a status view. */
  peek(limit = 20): SpeechTranscript[] {
    return this.transcripts.slice(-limit);
  }

  status() {
    return {
      state: this._state,
      startedAt: this.startedAt,
      pending: this.transcripts.length,
      dropped: this.dropped,
      /** The sentence currently being formed. Not durable. */
      partial: this.partial || null,
      lastError: this.lastError,
      restarts: this.restarts,
    };
  }

  private emitEvent(type: string, detail?: Record<string, any>) {
    this.options.onEvent?.({ type, detail });
    this.emit('event', { type, detail });
  }
}

function safeParse(line: string): any | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function numberOrNull(value: any): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
