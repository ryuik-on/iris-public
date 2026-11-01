import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanEnv } from '../core/self_fix.js';

const quoted = (s: string) => JSON.stringify(s);
const canonical = (s: string) => fs.realpathSync(s);

/** No sockets, Keychain, user home, shared Git writes, or shared dependency writes. */
export function verificationProfile(workdir: string, scratch: string, dependencies: string, runtime: string): string {
  const reads = ['/System/Library', '/usr', '/bin', '/sbin', '/private/etc', '/private/var/db/timezone', '/Library/Apple', '/Library/Developer', '/Applications/Xcode.app/Contents/Developer', workdir, scratch, dependencies, runtime];
  const parents = new Set<string>(['/']);
  for (const root of [workdir, scratch, dependencies, runtime]) {
    for (let dir = path.dirname(root); dir !== '/'; dir = path.dirname(dir)) parents.add(dir);
  }
  return [
    '(version 1)', '(deny default)',
    '(allow process-exec process-fork sysctl-read)',
    '(allow signal (target self) (target children))',
    '(allow file-read-metadata)',
    `(allow file-read* ${[...parents].map(p => `(literal ${quoted(p)})`).join(' ')})`,
    `(allow file-read* ${reads.map((p) => `(subpath ${quoted(p)})`).join(' ')})`,
    '(allow file-read* (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom"))',
    `(allow file-write* (subpath ${quoted(workdir)}) (subpath ${quoted(scratch)}) (literal "/dev/null"))`,
    `(deny file-write* (literal ${quoted(path.join(workdir, '.git'))}))`,
    `(deny file-write* (literal ${quoted(path.join(workdir, 'node_modules'))}))`,
  ].join('\n');
}

export async function runVerification(command: string, args: string[], options: { cwd: string; timeoutMs: number; dependencies: string }) {
  if (process.platform !== 'darwin' || !fs.existsSync('/usr/bin/sandbox-exec')) {
    return { code: 1, stdout: '', stderr: '隔離して検査できる実行環境がありません。安全のため実行しません。' };
  }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-verification-'));
  fs.chmodSync(scratch, 0o700);
  const home = path.join(scratch, 'home');
  const tmp = path.join(scratch, 'tmp');
  fs.mkdirSync(home, { mode: 0o700 });
  fs.mkdirSync(tmp, { mode: 0o700 });
  const env = { ...cleanEnv(process.env, path.dirname(process.execPath)), HOME: home, TMPDIR: tmp, npm_config_cache: path.join(home, '.npm') };
  const pointer = path.join(options.cwd, '.git');
  let savedPointer: Buffer | null = null, swappedPointer = false;
  try {
    // Tests may inspect Git state. Give them metadata derived only from this
    // candidate's files; never expose the real repository's config or history.
    const gitDir = path.join(scratch, 'git');
    const gitEnv = { ...env, GIT_DIR: gitDir, GIT_WORK_TREE: canonical(options.cwd), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
    const git = (args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgSign=false', ...args], { cwd: options.cwd, env: gitEnv, timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'init', '--bare', '-q', '-b', 'verification', gitDir], { cwd: scratch, env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
    git(['add', '-A']);
    git(['-c', 'user.name=IRIS verification', '-c', 'user.email=verification@localhost', 'commit', '-qm', 'candidate files', '--allow-empty']);
    git(['config', 'core.bare', 'false']);
    git(['config', 'core.worktree', canonical(options.cwd)]);
    if (fs.existsSync(pointer)) {
      if (!fs.lstatSync(pointer).isFile()) throw new Error('検査用のGit参照が通常のファイルではありません。');
      savedPointer = fs.readFileSync(pointer);
    }
    fs.writeFileSync(pointer, `gitdir: ${canonical(gitDir)}\n`, { mode: 0o600 });
    swappedPointer = true;
    const profile = verificationProfile(canonical(options.cwd), canonical(scratch), canonical(options.dependencies), canonical(path.resolve(path.dirname(process.execPath), '..')));
    return await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      const child = spawn('/usr/bin/sandbox-exec', ['-p', profile, command, ...args], {
        cwd: options.cwd, env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '', stderr = '', reason = '', bytes = 0;
      const stop = () => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } } };
      const timer = setTimeout(() => { reason = '検査が制限時間を超えたため、子プロセスも終了しました。'; stop(); }, options.timeoutMs);
      const collect = (chunk: Buffer, error: boolean) => {
        bytes += chunk.length;
        if (bytes > 64 * 1024 * 1024) { reason = '検査の出力が上限を超えました。'; stop(); return; }
        if (error) stderr += chunk.toString(); else stdout += chunk.toString();
      };
      child.stdout.on('data', (b) => collect(b, false));
      child.stderr.on('data', (b) => collect(b, true));
      child.on('exit', stop);
      child.on('error', (err) => { reason = err.message; });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code: reason ? 1 : (code ?? 1), stdout, stderr: reason ? `${reason}\n${stderr}` : stderr });
      });
    });
  } finally {
    if (swappedPointer) {
      if (savedPointer) fs.writeFileSync(pointer, savedPointer); else fs.rmSync(pointer, { force: true });
    }
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
