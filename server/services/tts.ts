import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { writeFile, unlink, mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * Speaking out loud.
 *
 * Two engines, and the difference between them is not quality — it is whether
 * IRIS's words leave the machine.
 *
 * On-device is the default and always available: nothing is uploaded, it works
 * with the network off, and it costs nothing per word. Its ceiling is whatever
 * voices macOS has installed, and the stock Japanese set is poor. Cloud
 * synthesis sounds dramatically better and sends every spoken reply to a
 * third party.
 *
 * So the cloud engine is opt-in, by the same rule as everything else here that
 * crosses a boundary: available, off, and turned on deliberately rather than
 * arrived at by default.
 */

export interface SpeakOptions {
  voice?: string;
  /**
   * How to say it, for engines that accept direction. A long explanation and
   * a one-line acknowledgement do not want the same delivery.
   */
  instructions?: string;
  /** 0..1 for the device engine; ignored by cloud voices that do not expose it. */
  rate?: number;
  pitch?: number;
  signal?: AbortSignal;
}

export interface TtsEngine {
  id: string;
  label: string;
  /** True when the text leaves this machine to be synthesised. */
  remote: boolean;
  available(): Promise<{ ok: boolean; reason?: string }>;
  listVoices(locale: string): Promise<VoiceInfo[]>;
  speak(text: string, options: SpeakOptions): Promise<SpokenResult>;
}

export interface VoiceInfo {
  id: string;
  name: string;
  language?: string;
  /** 'default' is the stock, synthetic-sounding tier on macOS. */
  quality: string;
  gender?: string;
  engine: string;
}

export interface SpokenResult {
  engine: string;
  voice: string;
  quality?: string;
  ms: number;
  /**
   * Milliseconds from the request to the first sound.
   *
   * The number that decides whether an assistant feels responsive. Total
   * duration mostly measures how long the sentence was; this measures how
   * long the user waited. Only meaningful for engines that stream.
   */
  ttfaMs?: number;
  streamed?: boolean;
  /**
   * How many pieces the text was synthesised in.
   *
   * Present when an engine pipelines — synthesising the next sentence while
   * the current one is being spoken. Distinct from `streamed`, which means the
   * audio for one request arrived progressively. Reported because it is the
   * difference between a ttfaMs that reflects the whole reply and one that
   * reflects only its first sentence, and comparing the two without knowing
   * which is which would be comparing nothing.
   */
  segments?: number;
  /**
   * Set when speech was cut short rather than finishing.
   *
   * What the listener actually heard is not knowable from here — audio is
   * buffered, so a segment handed to the player is not a segment that reached
   * the room. What is knowable is that the utterance did not finish, and a
   * record claiming the whole reply was delivered would be a record of
   * something that did not happen.
   */
  interrupted?: boolean;
  interruptedBy?: string;
  /** Segments handed to the player before the stop. Written, not necessarily heard. */
  spokenSegments?: number;
  /** Reading corrections applied before synthesis, when any were. */
  corrections?: Array<{ term: string; reading: string; count: number }>;
  /** Set when the preferred engine failed and another one spoke instead. */
  fellBackFrom?: string;
  fallbackReason?: string;
}

/**
 * Thrown when an engine failed. `audioStarted` is the important field.
 *
 * The same reasoning as §47 for tool calls: a failure whose side effect may
 * already have happened must not be retried. Here the side effect is sound in
 * the room. If half a sentence was spoken before the failure, falling back to
 * another engine repeats it from the beginning, which is worse than saying
 * nothing.
 */
export class TtsFailure extends Error {
  constructor(
    public readonly engine: string,
    message: string,
    public readonly audioStarted: boolean,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'TtsFailure';
  }
}

export class TtsUnavailableError extends Error {
  constructor(engine: string, reason: string) {
    super(`${engine} は使用できません: ${reason}`);
    this.name = 'TtsUnavailableError';
  }
}

// ---------------------------------------------------------------------------

/** Runs the Swift helper's `voices` / `speak` commands. */
export class DeviceTtsEngine implements TtsEngine {
  id = 'device';
  label = 'オンデバイス (AVSpeechSynthesizer)';
  remote = false;

  constructor(private binaryPath: () => string) {}

  async available() {
    try {
      this.binaryPath();
      return { ok: true };
    } catch (err: any) {
      return { ok: false, reason: err.message };
    }
  }

  async listVoices(locale: string): Promise<VoiceInfo[]> {
    const events = await this.run(['voices', '--locale', locale], 30_000);
    const listing = events.find((e) => e.event === 'voices');
    return (listing?.voices ?? []).map((v: any) => ({
      id: v.identifier,
      name: v.name,
      language: v.language,
      quality: v.quality,
      gender: v.gender,
      engine: this.id,
    }));
  }

  async speak(text: string, options: SpeakOptions): Promise<SpokenResult> {
    const started = Date.now();
    const args = ['speak', '--text', text];
    if (options.voice) args.push('--voice', options.voice);
    if (options.rate !== undefined) args.push('--rate', String(options.rate));
    if (options.pitch !== undefined) args.push('--pitch', String(options.pitch));

    // Bounded by length: a long reply legitimately takes a while, but nothing
    // may hold the speaker open indefinitely.
    const events = await this.run(args, Math.max(60_000, text.length * 1_200), options.signal);
    const speaking = events.find((e) => e.event === 'speaking');
    return {
      engine: this.id,
      voice: speaking?.voice ?? 'system default',
      quality: speaking?.quality,
      ms: Date.now() - started,
    };
  }

  private run(args: string[], timeoutMs: number, signal?: AbortSignal): Promise<any[]> {
    return new Promise((resolve, reject) => {
      let binary: string;
      try {
        binary = this.binaryPath();
      } catch (err) {
        reject(err);
        return;
      }

      const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd: tmpdir() });
      const events: any[] = [];
      let pending = '';
      let stderr = '';

      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`${args[0]} が ${timeoutMs}ms 以内に終了しませんでした。`));
      }, timeoutMs);

      const onAbort = () => child.kill('SIGTERM');
      signal?.addEventListener('abort', onAbort, { once: true });

      child.stdout.on('data', (chunk: Buffer) => {
        pending += chunk.toString('utf8');
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) {
          try {
            if (line.trim()) events.push(JSON.parse(line));
          } catch {
            /* a malformed line is reported by exit code, not by throwing here */
          }
        }
      });
      child.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });
      child.on('error', (err) => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); reject(err); });
      child.on('close', (code) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (code !== 0) {
          const failure = events.find((e) => e.event === 'error');
          // The helper emits `speaking` immediately before audio begins, so
          // its presence is how we know whether the room already heard part
          // of this.
          const started = events.some((e) => e.event === 'speaking');
          reject(
            new TtsFailure(
              'device',
              failure?.message ?? stderr.trim() ?? `exit ${code}`,
              started
            )
          );
          return;
        }
        resolve(events);
      });
    });
  }
}

// ---------------------------------------------------------------------------

export interface OpenAiTtsOptions {
  apiKey?: string;
  model?: string;
  defaultVoice?: string;
  /**
   * How to deliver it, when the caller does not say.
   *
   * The lever for the complaint a dictionary cannot reach: reading the right
   * syllables and reading them like a person are different problems. Only
   * some engines accept direction at all — Chirp 3 HD over REST does not —
   * so this is stored per engine rather than as a service-wide setting.
   */
  defaultInstructions?: string;
  /** Off unless the user turned it on. Text leaves the machine when it is on. */
  enabled?: boolean;
  /** Resolves the on-device helper, which does the actual playback. */
  playerPath?: () => string;
}

/**
 * Cloud synthesis.
 *
 * Sounds far better than anything on-device, and every reply spoken this way
 * is sent to OpenAI. That is the entire trade, and it is why `enabled`
 * defaults to false rather than being inferred from a key being present — a
 * key configured for chat is not consent to upload speech.
 */
export class OpenAiTtsEngine implements TtsEngine {
  id = 'openai';
  label = 'OpenAI TTS (クラウド)';
  remote = true;

  private enabled: boolean;
  private model: string;
  private defaultVoice: string;
  private defaultInstructions: string | undefined;

  /** Documented options; the API is the authority, so an unknown one is passed through. */
  static readonly KNOWN_VOICES = [
    'alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'onyx', 'nova', 'sage', 'shimmer', 'verse',
  ];

  constructor(private options: OpenAiTtsOptions = {}) {
    this.enabled = options.enabled ?? false;
    this.model = options.model ?? 'gpt-4o-mini-tts';
    this.defaultVoice = options.defaultVoice ?? 'onyx';
    this.defaultInstructions = options.defaultInstructions;
  }

  /** Changed at runtime so a delivery can be tried without a restart. */
  setInstructions(instructions: string | undefined) {
    this.defaultInstructions = instructions;
  }

  get instructions(): string | undefined {
    return this.defaultInstructions;
  }

  private playerPath(): string {
    if (!this.options.playerPath) throw new TtsUnavailableError(this.id, '再生用ヘルパが設定されていません。');
    return this.options.playerPath();
  }

  setEnabled(enabled: boolean) {
    this.enabled = enabled;
  }

  get isEnabled() {
    return this.enabled;
  }

  async available() {
    if (!this.enabled) {
      return { ok: false, reason: '無効です。有効にすると読み上げテキストが OpenAI に送信されます。' };
    }
    if (!this.key()) return { ok: false, reason: 'OPENAI_API_KEY が設定されていません。' };
    return { ok: true };
  }

  private key(): string | undefined {
    return (this.options.apiKey ?? process.env.OPENAI_API_KEY)?.trim() || undefined;
  }

  async listVoices(): Promise<VoiceInfo[]> {
    // Not discoverable through the API, unlike chat models. Named as a fixed
    // list and marked so, rather than presented as something that was checked.
    return OpenAiTtsEngine.KNOWN_VOICES.map((name) => ({
      id: name,
      name,
      quality: 'cloud',
      engine: this.id,
    }));
  }

  async speak(text: string, options: SpeakOptions): Promise<SpokenResult> {
    const availability = await this.available();
    if (!availability.ok) throw new TtsUnavailableError(this.id, availability.reason!);

    const started = Date.now();
    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({ apiKey: this.key(), maxRetries: 1 });
    const voice = options.voice ?? this.defaultVoice;

    // pcm: 24kHz signed 16-bit mono, which is what the player expects and
    // what makes this streamable without a decoder.
    let response: Response;
    try {
      response = (await client.audio.speech.create(
        {
          model: this.model,
          voice: voice as any,
          input: text,
          response_format: 'pcm',
          ...(options.instructions ?? this.defaultInstructions
            ? { instructions: options.instructions ?? this.defaultInstructions }
            : {}),
        } as any,
        { signal: options.signal }
      )) as unknown as Response;
    } catch (err: any) {
      // Nothing has been heard yet, so another engine may safely take over.
      throw new TtsFailure(this.id, err?.message ?? String(err), false, err);
    }

    const player = new PcmPlayer(this.playerPath(), 24_000, 1);
    return streamToPlayer(this.id, response, player, {
      voice,
      quality: 'cloud',
      started,
      signal: options.signal,
    });
  }
}

/**
 * ElevenLabs.
 *
 * The best Japanese prosody of the three, and the furthest from this machine.
 * Opt-in for the same reason as the OpenAI engine: a key in .env is not
 * consent to upload every spoken reply.
 *
 * Latency is the real cost, and it is measurable rather than theoretical —
 * the OpenAI engine added roughly five seconds before a word was heard. The
 * `/stream` endpoint exists to reduce that, but true streaming playback needs
 * a player that reads stdin, and this Mac has only afplay, which does not.
 * So the response is buffered to a file first, and the streaming win is
 * registered as unfinished rather than claimed.
 */
export interface ElevenLabsOptions {
  apiKey?: string;
  /** Documented default. Lower-latency models exist; their ids are unverified. */
  model?: string;
  voiceId?: string;
  /** pcm_<rate>, so the player can consume it without decoding. */
  outputFormat?: string;
  languageCode?: string;
  enabled?: boolean;
  playerPath?: () => string;
}

export class ElevenLabsTtsEngine implements TtsEngine {
  id = 'elevenlabs';
  label = 'ElevenLabs (クラウド)';
  remote = true;

  private enabled: boolean;

  constructor(private options: ElevenLabsOptions = {}) {
    this.enabled = options.enabled ?? false;
  }

  private playerPath(): string {
    if (!this.options.playerPath) throw new TtsUnavailableError(this.id, '再生用ヘルパが設定されていません。');
    return this.options.playerPath();
  }

  /** Read from the requested format so the player is configured to match. */
  private sampleRate(): number {
    const match = /^pcm_(\d+)$/.exec(this.options.outputFormat ?? 'pcm_24000');
    return match ? Number(match[1]) : 24_000;
  }

  setEnabled(enabled: boolean) {
    this.enabled = enabled;
  }

  get isEnabled() {
    return this.enabled;
  }

  private key(): string | undefined {
    return (this.options.apiKey ?? process.env.ELEVENLABS_API_KEY)?.trim() || undefined;
  }

  async available() {
    if (!this.enabled) {
      return { ok: false, reason: '無効です。有効にすると読み上げテキストが ElevenLabs に送信されます。' };
    }
    if (!this.key()) return { ok: false, reason: 'ELEVENLABS_API_KEY が設定されていません。' };
    return { ok: true };
  }

  /** Asks the account which voices it has, rather than hardcoding a list. */
  async listVoices(): Promise<VoiceInfo[]> {
    const key = this.key();
    if (!key) return [];
    const response = await fetch('https://api.elevenlabs.io/v1/voices', {
      headers: { 'xi-api-key': key },
    });
    if (!response.ok) {
      throw new TtsFailure(this.id, `音声一覧を取得できません: HTTP ${response.status}`, false);
    }
    const body: any = await response.json();
    return (body?.voices ?? []).map((v: any) => ({
      id: v.voice_id,
      name: v.name,
      language: v.labels?.language,
      quality: 'neural',
      gender: v.labels?.gender,
      engine: this.id,
    }));
  }

  async speak(text: string, options: SpeakOptions): Promise<SpokenResult> {
    const availability = await this.available();
    if (!availability.ok) throw new TtsUnavailableError(this.id, availability.reason!);

    const started = Date.now();
    const voiceId = options.voice ?? this.options.voiceId;
    if (!voiceId) {
      throw new TtsUnavailableError(this.id, 'voice_id が指定されていません（アカウントの音声IDが必要です）。');
    }

    let response: Response;
    try {
      // The streaming endpoint, in PCM. Japanese text normalisation is left
      // at the service default: it improves numerals and abbreviations but
      // costs latency, and which way that trades is the user's call.
      response = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream` +
          `?output_format=${encodeURIComponent(this.options.outputFormat ?? 'pcm_24000')}`,
        {
          method: 'POST',
          headers: { 'xi-api-key': this.key()!, 'content-type': 'application/json' },
          body: JSON.stringify({
            text,
            model_id: this.options.model ?? 'eleven_multilingual_v2',
            ...(this.options.languageCode ? { language_code: this.options.languageCode } : {}),
          }),
          signal: options.signal,
        }
      );
    } catch (err: any) {
      // Nothing has been heard yet, so another engine may safely take over.
      throw new TtsFailure(this.id, err?.message ?? String(err), false, err);
    }

    const player = new PcmPlayer(this.playerPath(), this.sampleRate(), 1);
    return streamToPlayer(this.id, response, player, {
      voice: voiceId,
      quality: 'neural',
      started,
      signal: options.signal,
    });
  }
}

/**
 * Pipes raw PCM to the on-device player as it arrives.
 *
 * The reason every cloud engine below asks for PCM rather than MP3: raw
 * samples need no progressive decoding, so streaming them is copying bytes.
 * The five-to-seven seconds these services used to spend before a word was
 * heard was almost entirely waiting for a complete file.
 *
 * Cancellation is closing the pipe, which is why an interrupted sentence
 * stops where it was interrupted.
 */
export class PcmPlayer {
  private child: ChildProcessWithoutNullStreams | null = null;
  private firstAudioAt: number | null = null;
  private startedAt = 0;
  private exited: Promise<void> | null = null;
  private failure: string | null = null;

  constructor(
    private binaryPath: string,
    private sampleRate = 24_000,
    private channels = 1
  ) {}

  /**
   * `originMs` is when the *request* began, not when this player did. For an
   * engine that synthesises before playing, the user waited through both, and
   * measuring from the spawn would flatter it by hiding the synthesis.
   */
  start(signal?: AbortSignal, originMs?: number) {
    this.startedAt = originMs ?? Date.now();
    const child = spawn(
      this.binaryPath,
      ['play', '--rate-hz', String(this.sampleRate), '--channels', String(this.channels)],
      // Never the repository: inheriting a cwd inside a TCC-guarded folder
      // hangs the child in dyld before main.
      { stdio: ['pipe', 'pipe', 'pipe'], cwd: tmpdir() }
    );
    this.child = child;

    let pending = '';
    child.stdout.on('data', (chunk: Buffer) => {
      pending += chunk.toString('utf8');
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          // Taken from the player rather than estimated here: only it knows
          // when a sample actually reached the speakers.
          if (event.event === 'first_audio' && this.firstAudioAt === null) {
            this.firstAudioAt = Date.now();
          }
          if (event.event === 'error') this.failure = event.message ?? 'playback error';
        } catch {
          /* a malformed line is surfaced by the exit code */
        }
      }
    });
    child.stderr.resume();

    this.exited = new Promise<void>((resolve) => child.once('close', () => resolve()));
    signal?.addEventListener('abort', () => this.cancel(), { once: true });
  }

  write(chunk: Uint8Array) {
    if (!this.child || this.child.stdin.destroyed) return;
    this.child.stdin.write(Buffer.from(chunk));
  }

  get started(): boolean {
    return this.firstAudioAt !== null;
  }

  /** Closes the pipe and waits for the queued audio to finish playing. */
  async finish(): Promise<{ ttfaMs: number | undefined }> {
    if (!this.child) return { ttfaMs: undefined };
    this.child.stdin.end();
    await this.exited;
    if (this.failure) throw new Error(this.failure);
    return { ttfaMs: this.firstAudioAt ? this.firstAudioAt - this.startedAt : undefined };
  }

  cancel() {
    this.child?.kill('SIGTERM');
  }
}

/**
 * Pumps an HTTP response body into the player as it arrives.
 *
 * `audioStarted` is set from the player, not guessed here, because it decides
 * whether a failure may be handed to another engine: once a sample has been
 * heard, starting over in a different voice is worse than stopping.
 */
async function streamToPlayer(
  engineId: string,
  response: Response,
  player: PcmPlayer,
  meta: { voice: string; quality: string; started: number; signal?: AbortSignal }
): Promise<SpokenResult> {
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new TtsFailure(engineId, `HTTP ${response.status} ${detail.slice(0, 200)}`, false);
  }
  if (!response.body) {
    throw new TtsFailure(engineId, '音声ストリームが空でした。', false);
  }

  player.start(meta.signal, meta.started);
  try {
    const reader = (response.body as any).getReader
      ? (response.body as ReadableStream<Uint8Array>).getReader()
      : null;

    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) player.write(value);
      }
    } else {
      for await (const chunk of response.body as any) {
        player.write(chunk as Uint8Array);
      }
    }
  } catch (err: any) {
    player.cancel();
    throw new TtsFailure(engineId, err?.message ?? String(err), player.started, err);
  }

  try {
    const { ttfaMs } = await player.finish();
    return {
      engine: engineId,
      voice: meta.voice,
      quality: meta.quality,
      ms: Date.now() - meta.started,
      ttfaMs,
      streamed: true,
    };
  } catch (err: any) {
    throw new TtsFailure(engineId, err?.message ?? String(err), player.started, err);
  }
}

function playFile(path: string, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('afplay', [path], { stdio: 'ignore' });
    const onAbort = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', reject);
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      code === 0 || signal?.aborted ? resolve() : reject(new Error(`afplay exit ${code}`));
    });
  });
}

/**
 * Google Cloud Text-to-Speech, Chirp 3: HD.
 *
 * Voice names are discovered rather than written down. The documented pattern
 * is `ja-JP-Chirp3-HD-<name>`, but a list of names in a source file is a list
 * that rots — the same lesson a retired Anthropic model id already taught this
 * repository. Asking costs one request and is always right.
 *
 * One honest limitation: Google's streaming synthesis is a bidirectional gRPC
 * call, not a REST one. Over REST the whole clip arrives before playback can
 * begin, so this engine's time-to-first-audio is full synthesis time and it
 * is reported as not streamed. The other two cloud engines do stream.
 */
export interface GoogleTtsOptions {
  apiKey?: string;
  voiceName?: string;
  languageCode?: string;
  sampleRate?: number;
  enabled?: boolean;
  playerPath?: () => string;
}

export class GoogleTtsEngine implements TtsEngine {
  id = 'google';
  label = 'Google Chirp 3: HD (クラウド)';
  remote = true;

  private enabled: boolean;

  constructor(private options: GoogleTtsOptions = {}) {
    this.enabled = options.enabled ?? false;
  }

  setEnabled(enabled: boolean) {
    this.enabled = enabled;
  }

  get isEnabled() {
    return this.enabled;
  }

  private key(): string | undefined {
    return (this.options.apiKey ?? process.env.GOOGLE_TTS_API_KEY)?.trim() || undefined;
  }

  private playerPath(): string {
    if (!this.options.playerPath) throw new TtsUnavailableError(this.id, '再生用ヘルパが設定されていません。');
    return this.options.playerPath();
  }

  private get languageCode(): string {
    return this.options.languageCode ?? 'ja-JP';
  }

  private get sampleRate(): number {
    return this.options.sampleRate ?? 24_000;
  }

  async available() {
    if (!this.enabled) {
      return { ok: false, reason: '無効です。有効にすると読み上げテキストが Google に送信されます。' };
    }
    if (!this.key()) {
      return {
        ok: false,
        reason: 'GOOGLE_TTS_API_KEY が設定されていません（Cloud Text-to-Speech API の鍵が必要です）。',
      };
    }
    return { ok: true };
  }

  async listVoices(locale?: string): Promise<VoiceInfo[]> {
    const key = this.key();
    if (!key) return [];
    const language = locale ?? this.languageCode;
    const response = await fetch(
      `https://texttospeech.googleapis.com/v1/voices?languageCode=${encodeURIComponent(language)}&key=${encodeURIComponent(key)}`
    );
    if (!response.ok) {
      throw new TtsFailure(this.id, `音声一覧を取得できません: HTTP ${response.status}`, false);
    }
    const body: any = await response.json();
    return (body?.voices ?? [])
      .map((v: any) => ({
        id: v.name,
        name: v.name,
        language: (v.languageCodes ?? [])[0],
        // Chirp 3 HD is the tier worth reaching for; the rest are marked so a
        // reader does not mistake a legacy voice for the good one.
        quality: /Chirp3-HD/i.test(v.name) ? 'chirp3-hd' : 'standard',
        gender: (v.ssmlGender ?? '').toLowerCase(),
        engine: this.id,
      }))
      .sort((a: VoiceInfo, b: VoiceInfo) => (a.quality === 'chirp3-hd' ? -1 : 1) - (b.quality === 'chirp3-hd' ? -1 : 1));
  }

  async speak(text: string, options: SpeakOptions): Promise<SpokenResult> {
    const availability = await this.available();
    if (!availability.ok) throw new TtsUnavailableError(this.id, availability.reason!);

    const started = Date.now();
    const voice = options.voice ?? this.options.voiceName;
    if (!voice) {
      throw new TtsUnavailableError(
        this.id,
        '音声名が指定されていません（例: ja-JP-Chirp3-HD-… — voices で一覧できます）。'
      );
    }

    // Split, because REST synthesis returns nothing until the whole request
    // has finished. Asked for a paragraph, the listener hears silence for as
    // long as the paragraph takes to synthesise — measured at 3.6s for the
    // morning briefing, against 1.7s for a single sentence. The wait grows
    // with the length of the reply, so the most useful thing IRIS says is the
    // thing it takes longest to start saying.
    //
    // Sentence by sentence, the wait before the first word is the first
    // sentence's synthesis, and the rest is synthesised while that one is
    // being spoken.
    const segments = splitForSpeech(text);

    // Two ahead. Speech is slower than synthesis, so one finished segment
    // buys enough time for the next; queueing the whole reply would only
    // spend requests that an interruption throws away.
    const LOOKAHEAD = 2;
    const pending: Array<Promise<Uint8Array> | undefined> = new Array(segments.length);
    const request = (i: number) => {
      if (i >= segments.length || pending[i]) return;
      const p = this.synthesize(segments[i], voice, options.signal);
      // Attached now, awaited later. A rejection nobody is waiting on yet is
      // an unhandled rejection; the failure is re-raised at the await below.
      p.catch(() => {});
      pending[i] = p;
    };
    for (let i = 0; i < LOOKAHEAD; i++) request(i);

    let player: PcmPlayer | null = null;
    try {
      for (let i = 0; i < segments.length; i++) {
        request(i);

        let audio: Uint8Array;
        try {
          audio = await pending[i]!;
        } catch (err: any) {
          // Whether anything has been heard decides whether another engine may
          // take over. Before the first segment plays it may; after that it
          // may not, because starting the reply again in a different voice is
          // worse than stopping.
          throw new TtsFailure(
            this.id,
            player?.started
              ? `${i + 1}文目以降を合成できませんでした: ${err?.message ?? err}`
              : (err?.message ?? String(err)),
            Boolean(player?.started),
            err
          );
        }

        if (!player) {
          player = new PcmPlayer(this.playerPath(), this.sampleRate, 1);
          // Measured from the request, so the synthesis the user waited
          // through is inside the number rather than hidden behind it.
          player.start(options.signal, started);
        }
        player.write(audio);
        request(i + LOOKAHEAD);
      }

      const { ttfaMs } = await player!.finish();
      return {
        engine: this.id,
        voice,
        quality: 'chirp3-hd',
        ms: Date.now() - started,
        ttfaMs,
        // REST has no streaming synthesis; that is a gRPC call. What happens
        // here is segment pipelining, which is a different thing, and saying
        // so is better than leaving someone to infer it from the latency.
        streamed: false,
        segments: segments.length,
      };
    } catch (err: any) {
      if (err instanceof TtsFailure) throw err;
      throw new TtsFailure(this.id, err?.message ?? String(err), Boolean(player?.started), err);
    }
  }

  private async synthesize(text: string, voice: string, signal?: AbortSignal): Promise<Uint8Array> {
    const response = await fetch(
      `https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(this.key()!)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          input: { text },
          voice: { languageCode: this.languageCode, name: voice },
          audioConfig: { audioEncoding: 'LINEAR16', sampleRateHertz: this.sampleRate },
        }),
        signal,
      }
    );
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status} ${detail.slice(0, 200)}`);
    }
    const body: any = await response.json();
    if (!body?.audioContent) throw new Error('audioContent が空でした。');
    return stripWavHeader(Buffer.from(body.audioContent, 'base64'));
  }
}

/**
 * Breaks text where a speaker would pause.
 *
 * Two failure modes pull in opposite directions.
 *
 * Segments that are too long defeat the point: the first one is what the
 * listener waits through, so a three-sentence opener is barely better than
 * not splitting at all.
 *
 * Segments that are too short cost more than they save. Each is its own
 * request with its own round trip, and 「はい。」 synthesises in less time
 * than the request takes to leave the machine. Worse, Chirp decides
 * intonation per request, so cutting a clause in half leaves the two halves
 * disagreeing about where the sentence was going.
 *
 * So: split at sentence endings, merge anything too short into its neighbour,
 * and fall back to clause commas only for a sentence long enough that waiting
 * for all of it would be the larger problem.
 */
export function splitForSpeech(text: string, minChars = 12, maxChars = 90): string[] {
  const sentences = text
    .split(/(?<=[。．！？!?\n])/)
    .map((s) => s.trim())
    .filter(Boolean);

  const pieces: string[] = [];
  for (const sentence of sentences) {
    if (sentence.length <= maxChars) {
      pieces.push(sentence);
      continue;
    }
    // Long enough that the listener would notice; broken at clause commas,
    // which are places a speaker pauses anyway.
    let buffer = '';
    for (const clause of sentence.split(/(?<=[、,])/)) {
      if (buffer && buffer.length + clause.length > maxChars) {
        pieces.push(buffer);
        buffer = '';
      }
      buffer += clause;
    }
    if (buffer) pieces.push(buffer);
  }

  // Merged forward, so a short tail joins the segment before it rather than
  // becoming a request of its own.
  const merged: string[] = [];
  for (const piece of pieces) {
    const last = merged[merged.length - 1];
    if (
      last !== undefined &&
      (last.length < minChars || piece.length < minChars) &&
      last.length + piece.length <= maxChars
    ) {
      merged[merged.length - 1] = last + piece;
    } else {
      merged.push(piece);
    }
  }

  return merged.length > 0 ? merged : [text];
}

/**
 * LINEAR16 comes back as a WAV file, and the player wants bare samples.
 * Walks the chunk table rather than assuming a 44-byte header, because the
 * header is only that size when no optional chunks are present.
 */
function stripWavHeader(buffer: Buffer): Uint8Array {
  if (buffer.length < 12 || buffer.toString('ascii', 0, 4) !== 'RIFF') return buffer;
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === 'data') return buffer.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + (size % 2);
  }
  return buffer;
}

// ---------------------------------------------------------------------------

export interface TtsServiceOptions {
  /**
   * Rewrites text before it reaches a voice. Returns the spoken form; the
   * caller's text is never modified, because a transcript reading へいかつきん
   * instead of 平滑筋 would trade one wrong output for another.
   */
  pronounce?: (text: string) => { text: string; applied: Array<{ term: string; reading: string; count: number }> };
  /**
   * Preference order. The first usable engine speaks; if it fails before any
   * audio was heard, the next one does.
   *
   * The intended shape is neural first, on-device last: the good voice when
   * the network is there, and something rather than silence when it is not.
   * On-device belongs at the end precisely because it can always run.
   */
  order?: string[];
  defaultVoice?: string;
  locale?: string;
  onEvent?: (event: { type: string; detail?: Record<string, any> }) => void;
}

export class TtsService {
  private engines = new Map<string, TtsEngine>();
  private order: string[];
  private selectedVoice: string | undefined;
  private speaking: AbortController | null = null;
  /**
   * What is being said, and since when.
   *
   * Held so barge-in can tell the user's voice from the assistant's own coming
   * back through the microphone — a decision that needs the text, not merely
   * the knowledge that speech is happening.
   */
  private utterance: { text: string; original: string; startedAt: number } | null = null;
  private stopReason: string | null = null;
  private voiceByEngine = new Map<string, string>();

  constructor(engines: TtsEngine[], private options: TtsServiceOptions = {}) {
    for (const engine of engines) this.engines.set(engine.id, engine);
    const requested = (options.order ?? []).filter((id) => this.engines.has(id));
    // Anything configured but unnamed still belongs in the chain — an engine
    // the user set up should not be unreachable because the order predates it.
    this.order = [...requested, ...[...this.engines.keys()].filter((id) => !requested.includes(id))];
    this.selectedVoice = options.defaultVoice;
  }

  /** The engine that would be tried first. */
  private get selectedEngine(): string {
    return this.order[0];
  }

  get locale() {
    return this.options.locale ?? 'ja-JP';
  }

  async status() {
    const engines = await Promise.all(
      [...this.engines.values()].map(async (engine) => ({
        id: engine.id,
        label: engine.label,
        remote: engine.remote,
        ...(await engine.available()),
      }))
    );
    return {
      engine: this.selectedEngine,
      order: this.order,
      voice: this.selectedVoice ?? null,
      speaking: this.speaking !== null,
      engines,
      note:
        'remote: true のエンジンは、読み上げるテキストをこの端末の外に送信します。' +
        '先頭のエンジンが音声を出す前に失敗した場合のみ、次のエンジンに切り替わります。',
    };
  }

  /**
   * Moves an engine to the front of the order.
   *
   * The rest of the chain is preserved rather than discarded, so choosing a
   * cloud voice does not also remove the offline fallback behind it.
   */
  select(engineId: string, voice?: string) {
    if (!this.engines.has(engineId)) throw new Error(`未知のエンジンです: ${engineId}`);
    this.order = [engineId, ...this.order.filter((id) => id !== engineId)];
    // Remembered per engine: a voice name from one engine means nothing to
    // another, so a fallback must not inherit the name it cannot resolve.
    if (voice) this.voiceByEngine.set(engineId, voice);
    this.selectedVoice = voice;
    this.options.onEvent?.({ type: 'tts.selected', detail: { engine: engineId, voice: voice ?? null } });
  }

  setOrder(order: string[]) {
    const known = order.filter((id) => this.engines.has(id));
    if (known.length === 0) throw new Error('有効なエンジンが1つも指定されていません。');
    this.order = [...known, ...[...this.engines.keys()].filter((id) => !known.includes(id))];
    this.options.onEvent?.({ type: 'tts.order_changed', detail: { order: this.order } });
  }

  async voices(engineId = this.selectedEngine): Promise<VoiceInfo[]> {
    const engine = this.engines.get(engineId);
    if (!engine) throw new Error(`未知のエンジンです: ${engineId}`);
    return engine.listVoices(this.locale);
  }

  /** Every voice from every engine that can currently be used. */
  async allVoices(): Promise<VoiceInfo[]> {
    const lists = await Promise.all(
      [...this.engines.values()].map(async (engine) => {
        const availability = await engine.available();
        if (!availability.ok) return [];
        try {
          return await engine.listVoices(this.locale);
        } catch {
          return [];
        }
      })
    );
    return lists.flat();
  }

  /**
   * Says something. One utterance at a time: two voices talking over each
   * other is worse than a delayed sentence, so a new request cancels the
   * previous one rather than joining it.
   */
  async speak(text: string, options: SpeakOptions & { engine?: string } = {}): Promise<SpokenResult> {
    const raw = text?.trim();
    if (!raw) throw new Error('読み上げるテキストが空です。');

    // Applied once, above every engine: each vendor gets a different subset of
    // Japanese compounds wrong, and correcting per engine would mean
    // maintaining the same knowledge several times over.
    let trimmed = raw;
    let corrections: Array<{ term: string; reading: string; count: number }> = [];
    if (this.options.pronounce) {
      try {
        const result = this.options.pronounce(raw);
        trimmed = result.text;
        corrections = result.applied;
      } catch {
        // A dictionary failure must not cost the user their reply; the
        // uncorrected text is still perfectly speakable.
      }
    }

    // An explicit engine is a request, not a preference: auditioning a
    // specific voice must not quietly play a different one.
    const chain = options.engine ? [options.engine] : this.order;
    for (const id of chain) {
      if (!this.engines.has(id)) throw new Error(`未知のエンジンです: ${id}`);
    }

    this.stop('superseded');
    const controller = new AbortController();
    this.speaking = controller;
    // Both forms are kept, and both are needed.
    //
    // `text` is what the speaker emits — the reading dictionary and the
    // notation rules have already run, so `30問` has become `30もん`.
    // `original` is what was asked for.
    //
    // Recognition returns neither reliably: it hears さんじゅうもん and writes
    // it back in standard orthography as `30問`, matching the original rather
    // than the string that was spoken. Comparing only against the spoken form
    // made the assistant's own voice look like somebody else's, and barge-in
    // duly interrupted it.
    this.utterance = { text: trimmed, original: raw, startedAt: Date.now() };
    this.stopReason = null;

    let lastError: any;
    let fellBackFrom: string | undefined;
    let fallbackReason: string | undefined;

    try {
      for (const engineId of chain) {
        const engine = this.engines.get(engineId)!;
        const availability = await engine.available();
        if (!availability.ok) {
          lastError = new TtsUnavailableError(engineId, availability.reason!);
          if (!fellBackFrom) { fellBackFrom = engineId; fallbackReason = availability.reason; }
          continue;
        }

        this.options.onEvent?.({
          type: 'tts.speaking',
          detail: {
            engine: engineId,
            remote: engine.remote,
            characters: trimmed.length,
            // Recorded because it is the fact worth being able to audit later.
            leftDevice: engine.remote,
          },
        });

        try {
          const result = await engine.speak(trimmed, {
            ...options,
            voice: options.voice ?? this.voiceByEngine.get(engineId),
            signal: controller.signal,
          });
          const withCorrections =
            corrections.length > 0 ? { ...result, corrections } : result;
          // Checked after the engine returns, not only when it throws.
          //
          // A stop landing while the player was draining produced no error at
          // all: every segment had been handed over, `finish()` resolved, and
          // the result described a complete utterance. Measured — 11.8s of a
          // reply that runs for 35 — so the record said the whole thing was
          // said while the room had heard a third of it. Whether the utterance
          // finished is a property of the abort signal, not of how the engine
          // happened to return.
          const cut = controller.signal.aborted
            ? { interrupted: true, interruptedBy: this.stopReason ?? 'stopped' }
            : {};
          return fellBackFrom
            ? { ...withCorrections, ...cut, fellBackFrom, fallbackReason }
            : { ...withCorrections, ...cut };
        } catch (err: any) {
          if (controller.signal.aborted) {
            // Not a failure. Someone asked it to stop, and the result should
            // say so rather than surfacing an abort as an engine fault.
            const stopped: SpokenResult = {
              engine: engineId,
              voice: options.voice ?? this.voiceByEngine.get(engineId) ?? '',
              ms: 0,
              interrupted: true,
              interruptedBy: this.stopReason ?? 'stopped',
              ...(corrections.length > 0 ? { corrections } : {}),
            };
            return stopped;
          }
          lastError = err;

          // Sound already in the room cannot be taken back. Re-speaking from
          // the top with a different voice is worse than stopping here.
          if (err instanceof TtsFailure && err.audioStarted) {
            this.options.onEvent?.({
              type: 'tts.failed_mid_utterance',
              detail: { engine: engineId, message: err.message },
            });
            throw err;
          }

          if (!fellBackFrom) { fellBackFrom = engineId; fallbackReason = err?.message; }
          this.options.onEvent?.({
            type: 'tts.fallback',
            detail: { from: engineId, message: err?.message },
          });
        }
      }

      throw lastError ?? new Error('利用できる音声エンジンがありません。');
    } finally {
      if (this.speaking === controller) {
        this.speaking = null;
        this.utterance = null;
      }
    }
  }

  /**
   * Stops whatever is being said.
   *
   * The reason is carried so the result can say what happened. "Finished" and
   * "cut off by the user" are different events, and a conversation record that
   * cannot tell them apart will later claim the user heard something they
   * talked over.
   */
  stop(reason = 'stopped') {
    if (!this.speaking) return false;
    this.stopReason = reason;
    this.speaking.abort();
    this.speaking = null;
    this.utterance = null;
    this.options.onEvent?.({ type: 'tts.stopped', detail: { reason } });
    return true;
  }

  /** What is currently being said, for anything that has to reason about it. */
  currentUtterance(): { text: string; original: string; startedAt: number } | null {
    return this.utterance;
  }
}
