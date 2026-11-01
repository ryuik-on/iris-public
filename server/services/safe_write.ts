import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const program = fs.readFileSync(path.resolve('server/native/safe_write.py'), 'utf8');

export function safeWrite(target: string, content: string, mode: string): Promise<{ created: boolean; size: number }> {
  if (!['overwrite', 'append', 'create_only'].includes(mode)) throw new Error('書き込み方法が不正です。');
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/python3', ['-I', '-S', '-c', program], {
      cwd: '/', env: { PATH: '/usr/bin:/bin', PYTHONDONTWRITEBYTECODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    child.stdout.on('data', (b) => { stdout += b.toString(); });
    child.stderr.on('data', (b) => { stderr += b.toString(); });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`安全に書き込めませんでした。${stderr.trim().split('\n').at(-1) ?? ''}`));
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error('書き込み結果を確認できませんでした。')); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ path: target, content, mode }));
  });
}
