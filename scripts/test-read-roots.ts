/**
 * Read-only roots: what IRIS may read outside its workspace, and what it may not.
 *
 * Run: npx tsx scripts/test-read-roots.ts
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Workspace, WorkspaceAccessError } from '../server/tools/workspace.js';
import { createFilesystemTools } from '../server/tools/filesystem.js';

let passed = 0;
const failures: string[] = [];
const ok = (name: string, cond: boolean, detail = '') => { if (cond) passed++; else failures.push(`${name} ${detail}`); };
function throwsWith(name: string, f: () => unknown, reason: string) {
  try { f(); failures.push(`${name}: did not throw`); }
  catch (err: any) { ok(name, err instanceof WorkspaceAccessError && err.reason === reason, `(reason ${err?.reason ?? err?.message})`); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-readroots-'));
const work = path.join(tmp, 'work');
const shared = path.join(tmp, 'shared');
const outside = path.join(tmp, 'outside');
for (const d of [work, shared, outside, path.join(shared, 'Library', 'Keychains'), path.join(shared, 'docs')]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(shared, 'docs', 'schedule.txt'), '薬理学58-60');
fs.writeFileSync(path.join(shared, '.env'), 'SECRET=1');
fs.writeFileSync(path.join(shared, 'Library', 'Keychains', 'login'), 'k');
fs.writeFileSync(path.join(outside, 'private.txt'), 'nope');
fs.symlinkSync(outside, path.join(shared, 'escape'));
fs.symlinkSync(path.join(shared, '.env'), path.join(shared, 'docs', 'innocent.txt'));

(async () => {
  const ws = new Workspace({ root: work, readRoots: [shared] });
  const readable = ws.resolveRead(path.join(shared, 'docs', 'schedule.txt'));
  ok('a file inside a read root resolves', readable === path.join(shared, 'docs', 'schedule.txt'));
  ok('a relative path still means the workspace', ws.resolveRead('a.txt') === path.join(work, 'a.txt'));
  throwsWith('outside every root is refused', () => ws.resolveRead(path.join(outside, 'private.txt')), 'outside_workspace');
  throwsWith('a .env in a read root is refused', () => ws.resolveRead(path.join(shared, '.env')), 'denied_pattern');
  throwsWith('Library is refused by name', () => ws.resolveRead(path.join(shared, 'Library', 'Keychains', 'login')), 'denied_read_only_segment');
  throwsWith('a link out of the root is refused', () => ws.resolveRead(path.join(shared, 'escape', 'private.txt')), 'symlink_escape');
  throwsWith('a harmless name linked to .env is refused', () => ws.resolveRead(path.join(shared, 'docs', 'innocent.txt')), 'denied_pattern');
  throwsWith('.. cannot climb out', () => ws.resolveRead(path.join(shared, '..', 'outside', 'private.txt')), 'outside_workspace');

  // Writing and deleting never use the read roots.
  throwsWith('write path does not accept a read-root file', () => ws.resolve(path.join(shared, 'docs', 'schedule.txt')), 'outside_workspace');

  ok('outside the workspace is reported by absolute path', ws.relative(readable) === readable);
  ok('inside the workspace stays relative', ws.relative(path.join(work, 'x', 'y.txt')) === path.join('x', 'y.txt'));
  ok('Library is left out of a listing', ws.hiddenInListing(shared, 'Library') && !ws.hiddenInListing(shared, 'docs'));
  ok('.env is left out of a listing', ws.hiddenInListing(shared, '.env'));

  // Through the tools.
  const [list, read] = createFilesystemTools(ws);
  const read1: any = await read.execute({ path: path.join(shared, 'docs', 'schedule.txt') });
  ok('read_file reads it', read1.content === '薬理学58-60');
  const listing: any = await list.execute({ path: shared });
  ok('list_directory hides Library and .env', !listing.entries.some((e: any) => e.name === 'Library' || e.name === '.env'), JSON.stringify(listing.entries.map((e: any) => e.name)));
  let refused = false;
  try { await read.execute({ path: path.join(shared, '.env') }); } catch { refused = true; }
  ok('read_file refuses .env', refused);

  // No read roots configured: nothing outside opens.
  const closed = new Workspace({ root: work, readRoots: [] });
  throwsWith('no read roots means no outside reads', () => closed.resolveRead(path.join(shared, 'docs', 'schedule.txt')), 'outside_workspace');

  // The whole home directory, as configured on this machine.
  const home = new Workspace({ root: work, readRoots: [os.homedir()] });
  for (const secret of ['~/Library/Keychains/login.keychain-db', '~/.iris/iris.db', '~/.claude/settings.json', '~/.ssh/id_ed25519', '~/Projects/iris/.env', '~/.env', '~/.codex/auth.json']) {
    let denied = false;
    try { home.resolveRead(secret); } catch (err: any) { denied = err instanceof WorkspaceAccessError; }
    ok(`home: ${secret} is refused`, denied);
  }
  for (const fine of ['~/Documents/Founder-Development-Program/m2-schedule/x.pdf', '~/Downloads/a.pdf', '~/Projects/iris/README.md']) {
    let allowed = true;
    try { home.resolveRead(fine); } catch { allowed = false; }
    ok(`home: ${fine} is allowed`, allowed);
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`Read roots: ${passed} passed, ${failures.length} failed`);
  if (failures.length) { console.log(failures.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
  console.log('All read-root tests passed.');
})();
