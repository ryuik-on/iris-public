import { spawn } from 'child_process';
import { existsSync, mkdirSync, openSync, readSync, closeSync, writeFileSync, readFileSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';

/**
 * Running the speech helper as its own launchd job, and reading what it says.
 *
 * This exists for one measured fact. The helper holds a microphone grant under
 * its own bundle identifier, `local.iris.speech`, and TCC's record matches the
 * current binary exactly. Started as a child of the IRIS service it still
 * reports `notDetermined`; started as its own LaunchAgent — same binary, same
 * identifier, same grant — it reports `authorized`. The only difference is who
 * launched it.
 *
 * That is TCC's responsible-process model, and it cannot be worked around from
 * inside the child. A stable signing identity does not help either: it fixes
 * the grant being invalidated by every rebuild, which is a real and separate
 * problem, but the attribution is decided by the launch, not by the signature.
 *
 * So the helper is launched by launchd on its own account and IRIS talks to it
 * through a file. The helper already supports this: `--out` was added for the
 * detached case, with a comment naming this exact reason.
 *
 * Two things are deliberate.
 *
 * The job does not run at load, and IRIS starts it on demand. An always-running
 * agent means an always-open microphone, which is a different product from one
 * the user switches on, and not one to arrive at as a side effect of fixing a
 * permission bug.
 *
 * The transcript file is truncated at each start rather than appended to.
 * Recognised speech is the most sensitive thing this system handles, and a
 * file that accumulates every utterance forever is a transcript of the user's
 * home that nobody asked for.
 */

export const AGENT_LABEL = 'local.iris.speech.listen';

export interface SpeechAgentOptions {
  /** The helper's executable inside the installed bundle. */
  binaryPath: string;
  locale?: string;
  /** Where launchd writes its own stdio, and where the helper writes events. */
  stateDir?: string;
  onEvent?: (event: { type: string; detail?: Record<string, any> }) => void;
}

function uid(): number {
  return typeof process.getuid === 'function' ? process.getuid() : 501;
}

/** Runs launchctl and resolves with its exit code rather than throwing on failure. */
function launchctl(args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('/bin/launchctl', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });
    child.on('error', (err) => resolve({ code: -1, stderr: err.message }));
    child.on('close', (code) => resolve({ code: code ?? -1, stderr: stderr.trim() }));
  });
}

export class SpeechAgent {
  private readonly stateDir: string;
  readonly plistPath: string;
  readonly transcriptPath: string;

  constructor(private options: SpeechAgentOptions) {
    this.stateDir = options.stateDir ?? join(homedir(), 'Library/Application Support/IRIS');
    this.plistPath = join(homedir(), 'Library/LaunchAgents', `${AGENT_LABEL}.plist`);
    this.transcriptPath = join(this.stateDir, 'speech-events.jsonl');
  }

  /**
   * The job definition.
   *
   * `RunAtLoad` and `KeepAlive` are both false: the microphone opens when IRIS
   * asks and not before, and a helper that died is a fact to report rather than
   * something to restart underneath the caller — the bridge already has restart
   * logic that knows the difference between a crash and a configuration fault.
   *
   * launchd opens the stdio paths itself, before the job runs. Pointing them
   * anywhere it cannot reach makes the job fail with exit 78 and no log at all,
   * which is how a previous version of this failed silently for days. The state
   * directory is outside the guarded folders for that reason.
   */
  plist(): string {
    const args = [
      this.options.binaryPath,
      'listen',
      '--locale',
      this.options.locale ?? 'ja-JP',
      '--out',
      this.transcriptPath,
      // launchd connects stdin to /dev/null, and the helper treats stdin EOF
      // as "my parent is gone". Without this it reports `ready` and stops
      // 0.8 seconds later, before anything can be said into it.
      '--detached',
    ];
    const argXml = args.map((a) => `      <string>${escapeXml(a)}</string>`).join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argXml}
  </array>
  <key>RunAtLoad</key><false/>
  <key>KeepAlive</key><false/>
  <key>WorkingDirectory</key><string>/tmp</string>
  <!--
    標準出力は捨てる。同じものを二箇所に置かない。

    助手は out オプションで受け取ったファイルに同じ行を書く。launchd がそれを更に
    ログへ流していたが、そのログを回す仕組みが無かった。speech-events.jsonl は
    起動のたびに書き直されるので今日の分しか残らないのに、ログは 2026-08-19
    から積み上がり、聞こえた言葉 95 件が 276 KB ぶん残っていた（実測
    2026-09-29）。消したつもりの隣に、同じものがあった。

    助手の側も直してある（out オプションがあるときは print しない）が、そちらはアプリを
    作り直さないと効かない。作り直すとマイクの許可が署名に紐づいているぶん
    取り直しになるので、ここで断つ。失敗は err.log に残る。
  -->
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>${escapeXml(join(this.stateDir, 'speech-agent.err.log'))}</string>
</dict>
</plist>
`;
  }

  /**
   * Whether the loaded job matches what this code would write.
   *
   * Compared by content rather than by existence. An older definition sitting
   * on disk is worse than none: it loads, it runs, and it runs the previous
   * arguments — which is how a helper missing `--detached` kept stopping 0.8
   * seconds after start while the plist looked perfectly present.
   */
  installed(): boolean {
    if (!existsSync(this.plistPath)) return false;
    try {
      return readFileSync(this.plistPath, 'utf8') === this.plist();
    } catch {
      return false;
    }
  }

  /** Writes the job definition and loads it, without starting it. */
  async install(): Promise<{ installed: boolean; note: string }> {
    if (!existsSync(this.options.binaryPath)) {
      return { installed: false, note: `ヘルパが見つかりません: ${this.options.binaryPath}` };
    }
    mkdirSync(dirname(this.plistPath), { recursive: true });
    mkdirSync(this.stateDir, { recursive: true });
    writeFileSync(this.plistPath, this.plist(), 'utf8');

    // Replacing a definition means removing the old one first; bootstrapping
    // over a loaded job is an error rather than an update.
    await launchctl(['bootout', `gui/${uid()}/${AGENT_LABEL}`]);
    const loaded = await launchctl(['bootstrap', `gui/${uid()}`, this.plistPath]);
    if (loaded.code !== 0) {
      return { installed: false, note: `launchctl bootstrap が失敗しました: ${loaded.stderr}` };
    }
    this.options.onEvent?.({ type: 'speech.agent_installed', detail: { label: AGENT_LABEL } });
    return { installed: true, note: 'ヘルパを独立した LaunchAgent として登録しました。' };
  }

  async uninstall(): Promise<void> {
    await launchctl(['bootout', `gui/${uid()}/${AGENT_LABEL}`]);
  }

  /**
   * Starts listening.
   *
   * The transcript file is truncated first, so a reader starting now is not
   * handed the previous session's speech as though it had just been said.
   */
  async start(): Promise<{ ok: boolean; note?: string }> {
    if (!this.installed()) {
      const result = await this.install();
      if (!result.installed) return { ok: false, note: result.note };
    }
    writeFileSync(this.transcriptPath, '', 'utf8');
    const started = await launchctl(['kickstart', '-k', `gui/${uid()}/${AGENT_LABEL}`]);
    if (started.code !== 0) {
      return { ok: false, note: `launchctl kickstart が失敗しました: ${started.stderr}` };
    }
    return { ok: true };
  }

  async stop(): Promise<void> {
    await launchctl(['kill', 'SIGTERM', `gui/${uid()}/${AGENT_LABEL}`]);
  }

  /** Whether launchd currently has a running process for the job. */
  async running(): Promise<boolean> {
    const { code } = await launchctl(['print', `gui/${uid()}/${AGENT_LABEL}`]);
    return code === 0;
  }
}

/**
 * Reads newly appended lines from a file.
 *
 * Polling rather than fs.watch: the writer is a separate process appending
 * small amounts often, and watch reports "something changed" without saying
 * what, so the offset has to be tracked either way. Polling is the same
 * bookkeeping with fewer platform differences.
 *
 * A file that shrank is treated as a new file. That happens on every start,
 * because the transcript is truncated rather than accumulated — continuing
 * from the old offset would skip everything until the new content passed it.
 */
export class LineTail {
  private offset = 0;
  private carry = '';

  constructor(private path: string) {}

  reset() {
    this.offset = 0;
    this.carry = '';
  }

  read(): string[] {
    let size: number;
    try {
      size = statSync(this.path).size;
    } catch {
      return [];
    }
    if (size < this.offset) this.reset();
    if (size === this.offset) return [];

    const fd = openSync(this.path, 'r');
    try {
      const length = size - this.offset;
      const buffer = Buffer.allocUnsafe(length);
      const read = readSync(fd, buffer, 0, length, this.offset);
      this.offset += read;
      this.carry += buffer.subarray(0, read).toString('utf8');
    } finally {
      closeSync(fd);
    }

    const lines = this.carry.split('\n');
    // The last piece may be half a line the writer has not finished; it is
    // held until the rest arrives rather than parsed as truncated JSON.
    this.carry = lines.pop() ?? '';
    return lines.filter((l) => l.trim().length > 0);
  }
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
