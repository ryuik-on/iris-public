/**
 * Production tool tests, weighted toward the security boundary.
 *
 * The confinement tests matter most: list_directory, read_file and
 * get_current_time are READ tools, so they auto-execute with no human in the
 * loop. If Workspace.resolve() can be talked out of its boundary, a single
 * model turn — or text injected into one — reaches .env, SSH keys or the IRIS
 * database. These tests try to break it.
 *
 * Run: npm run test:tools
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { Workspace, WorkspaceAccessError } from '../server/tools/workspace.js';
import { createFilesystemTools } from '../server/tools/filesystem.js';
import { createSystemTools } from '../server/tools/system.js';
import { ToolRegistry } from '../server/tools/registry.js';
import { RiskLevel, ToolTrust, Tool } from '../server/core/types.js';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    failures.push(name + (detail ? ` — ${detail}` : ''));
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function eq(name: string, actual: any, expected: any) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, ok, ok ? undefined : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function section(title: string) {
  console.log(`\n▸ ${title}`);
}

async function expectDenied(name: string, fn: () => any, reason?: string) {
  try {
    await fn();
    check(name, false, 'access was ALLOWED but should have been denied');
  } catch (err: any) {
    const isAccessError = err instanceof WorkspaceAccessError;
    if (reason) {
      check(name, isAccessError && err.reason === reason, `reason=${err?.reason} (${err?.message})`);
    } else {
      check(name, isAccessError, `unexpected error: ${err?.name}: ${err?.message}`);
    }
  }
}

async function main() {
  // `outside` sits next to the workspace and holds the secrets an escape would target.
  const base = mkdtempSync(join(tmpdir(), 'iris-tools-'));
  const root = join(base, 'workspace');
  const outside = join(base, 'outside');
  mkdirSync(root, { recursive: true });
  mkdirSync(outside, { recursive: true });

  writeFileSync(join(outside, 'secret.txt'), 'TOP SECRET API KEY');
  // Plain name, deliberately NOT matching the denylist, so symlink tests prove
  // the containment check fires rather than the denylist masking it.
  writeFileSync(join(outside, 'plain.txt'), 'OUTSIDE PLAIN CONTENT');
  writeFileSync(join(root, 'notes.md'), '# ノート\n心臓の刺激伝導系。\n');
  writeFileSync(join(root, '.env'), 'GEMINI_API_KEY=should-never-be-readable');
  writeFileSync(join(root, 'creds.pem'), 'PRIVATE KEY');
  writeFileSync(join(root, 'iris.db'), 'sqlite');
  mkdirSync(join(root, 'projects', 'medai'), { recursive: true });
  writeFileSync(join(root, 'projects', 'medai', 'plan.txt'), 'plan contents');
  mkdirSync(join(root, '.git'), { recursive: true });
  writeFileSync(join(root, '.git', 'config'), 'git config');
  writeFileSync(join(root, 'binary.bin'), Buffer.from([0x00, 0x01, 0x02, 0x00]));

  const workspace = new Workspace({ root });
  const fsTools = createFilesystemTools(workspace);
  const sysTools = createSystemTools(workspace);
  const byName = new Map<string, Tool>([...fsTools, ...sysTools].map((t) => [t.name, t]));
  const call = (name: string, args: any = {}) => byName.get(name)!.execute(args);

  try {
    // ---------------------------------------------------------------------
    section('Risk levels and trust classification');

    eq('list_directory is READ', byName.get('list_directory')!.riskLevel, RiskLevel.READ);
    eq('read_file is READ', byName.get('read_file')!.riskLevel, RiskLevel.READ);
    eq('get_current_time is READ', byName.get('get_current_time')!.riskLevel, RiskLevel.READ);
    eq('write_file is WRITE', byName.get('write_file')!.riskLevel, RiskLevel.WRITE);
    eq('delete_file is DESTRUCTIVE', byName.get('delete_file')!.riskLevel, RiskLevel.DESTRUCTIVE);

    check(
      'no production tool sets skipApproval',
      [...byName.values()].every((t) => !t.skipApproval)
    );
    check(
      'every production tool declares TRUSTED_CORE provenance',
      [...byName.values()].every((t) => t.trust === ToolTrust.TRUSTED_CORE)
    );

    const registry = new ToolRegistry();
    registry.registerAll([...sysTools, ...fsTools]);
    const described = registry.describe();
    eq(
      'registry marks exactly the non-READ tools as approval-required',
      described.filter((d) => d.requiresApproval).map((d) => d.name).sort(),
      ['delete_file', 'write_file']
    );
    check(
      'unmarked tools default to UNTRUSTED',
      (() => {
        const r = new ToolRegistry();
        r.register({
          name: 'anon',
          description: 'no trust declared',
          riskLevel: RiskLevel.READ,
          schema: { type: 'object', properties: {} },
          async execute() { return {}; },
        });
        return r.get('anon')!.trust === ToolTrust.UNTRUSTED;
      })()
    );
    try {
      registry.register(sysTools[0]);
      check('duplicate registration is rejected', false, 'no throw');
    } catch {
      check('duplicate registration is rejected', true);
    }

    // ---------------------------------------------------------------------
    section('Path confinement — escape attempts');

    await expectDenied('relative traversal is denied', () => call('read_file', { path: '../outside/secret.txt' }), 'outside_workspace');
    await expectDenied('deep traversal is denied', () => call('read_file', { path: '../../../../etc/passwd' }), 'outside_workspace');
    await expectDenied('absolute path outside root is denied', () => call('read_file', { path: '/etc/passwd' }), 'outside_workspace');
    await expectDenied('absolute path to the secret is denied', () => call('read_file', { path: join(outside, 'secret.txt') }), 'outside_workspace');
    await expectDenied('traversal hidden mid-path is denied', () => call('read_file', { path: 'projects/../../outside/secret.txt' }), 'outside_workspace');
    await expectDenied('traversal in write is denied', () => call('write_file', { path: '../outside/injected.txt', content: 'x' }), 'outside_workspace');
    await expectDenied('traversal in delete is denied', () => call('delete_file', { path: '../outside/secret.txt' }), 'outside_workspace');
    await expectDenied('traversal in list is denied', () => call('list_directory', { path: '..' }), 'outside_workspace');
    await expectDenied('NUL byte in path is denied', () => call('read_file', { path: 'notes.md\0.txt' }), 'invalid_path');
    await expectDenied('empty path is denied', () => call('read_file', { path: '' }), 'empty_path');

    check('the secret file was never modified', readFileSync(join(outside, 'secret.txt'), 'utf8') === 'TOP SECRET API KEY');
    check('no file was created outside the workspace', !existsSync(join(outside, 'injected.txt')));

    // ---------------------------------------------------------------------
    section('Symlink escape');

    symlinkSync(join(outside, 'plain.txt'), join(root, 'link-to-plain.txt'));
    symlinkSync(outside, join(root, 'link-to-outside'));
    // The bypass an independent review predicted and a probe confirmed: a link
    // INSIDE the workspace pointing at a protected file passed the denylist on
    // its own name and passed containment because its target is also inside.
    // read_file is a READ tool, so this leaked .env with no approval step.
    symlinkSync(join(root, '.env'), join(root, 'link-to-env.md'));
    symlinkSync(join(root, 'creds.pem'), join(root, 'harmless.txt'));
    mkdirSync(join(root, 'links'), { recursive: true });
    symlinkSync(join(root, '.env'), join(root, 'links', 'nested.md'));

    await expectDenied('symlinked file pointing outside is denied', () => call('read_file', { path: 'link-to-plain.txt' }), 'symlink_escape');
    await expectDenied('reading through a symlinked directory is denied', () => call('read_file', { path: 'link-to-outside/plain.txt' }), 'symlink_escape');
    await expectDenied('listing a symlinked directory is denied', () => call('list_directory', { path: 'link-to-outside' }), 'symlink_escape');

    // Reading through a link is reading the target — the denylist must judge
    // where a path leads, not the name used to reach it.
    await expectDenied(
      'a symlink to .env inside the workspace is denied',
      () => call('read_file', { path: 'link-to-env.md' }),
      'denied_pattern'
    );
    await expectDenied(
      'a symlink to a private key inside the workspace is denied',
      () => call('read_file', { path: 'harmless.txt' }),
      'denied_pattern'
    );
    await expectDenied(
      'a nested symlink to a protected file is denied',
      () => call('read_file', { path: 'links/nested.md' }),
      'denied_pattern'
    );
    // The write path must not become a way to clobber a protected file either.
    await expectDenied(
      'writing through a symlink to a protected file is denied',
      () => call('write_file', { path: 'link-to-env.md', content: 'x' }),
      'denied_pattern'
    );
    check(
      'the protected file was not modified through the link',
      readFileSync(join(root, '.env'), 'utf8').includes('should-never-be-readable')
    );
    await expectDenied('writing through a symlinked directory is denied', () => call('write_file', { path: 'link-to-outside/new.txt', content: 'x' }), 'symlink_escape');
    check('nothing was written through the symlink', !existsSync(join(outside, 'new.txt')));

    // ---------------------------------------------------------------------
    section('Secret denylist inside the workspace');

    await expectDenied('.env is denied even inside the root', () => call('read_file', { path: '.env' }), 'denied_pattern');
    await expectDenied('.pem key is denied', () => call('read_file', { path: 'creds.pem' }), 'denied_pattern');
    await expectDenied('sqlite database is denied', () => call('read_file', { path: 'iris.db' }), 'denied_pattern');
    await expectDenied('.git directory is denied', () => call('list_directory', { path: '.git' }), 'denied_segment');
    await expectDenied('files under .git are denied', () => call('read_file', { path: '.git/config' }), 'denied_segment');
    await expectDenied('writing a .env is denied', () => call('write_file', { path: '.env', content: 'x' }), 'denied_pattern');
    await expectDenied('deleting a protected file is denied', () => call('delete_file', { path: 'creds.pem' }), 'denied_pattern');

    check('the .env inside the workspace is intact', readFileSync(join(root, '.env'), 'utf8').includes('should-never-be-readable'));

    // ---------------------------------------------------------------------
    section('Legitimate operation');

    const listed: any = await call('list_directory', {});
    check('root listing succeeds', Array.isArray(listed.entries));
    check('listing includes an ordinary file', listed.entries.some((e: any) => e.name === 'notes.md'));
    check('listing reports entry types', listed.entries.find((e: any) => e.name === 'projects')?.type === 'directory');

    const nested: any = await call('list_directory', { path: 'projects/medai' });
    eq('nested listing is relative to the root', nested.path, join('projects', 'medai'));

    const read: any = await call('read_file', { path: 'notes.md' });
    check('file content is returned', read.content.includes('心臓の刺激伝導系'));
    eq('content is labelled as external evidence', read.source, 'workspace_file');
    eq('untruncated read reports truncated=false', read.truncated, false);

    try {
      await call('read_file', { path: 'projects' });
      check('reading a directory as a file is rejected', false, 'no throw');
    } catch (err: any) {
      check('reading a directory as a file is rejected', /ファイルではありません/.test(err.message));
    }

    const written: any = await call('write_file', { path: 'projects/medai/new-note.md', content: '新規メモ' });
    eq('write reports creation', written.created, true);
    check('written file exists on disk', existsSync(join(root, 'projects', 'medai', 'new-note.md')));
    eq('written content matches', readFileSync(join(root, 'projects', 'medai', 'new-note.md'), 'utf8'), '新規メモ');

    const appended: any = await call('write_file', { path: 'projects/medai/new-note.md', content: '追記', mode: 'append' });
    eq('append does not report creation', appended.created, false);
    eq('append concatenates', readFileSync(join(root, 'projects', 'medai', 'new-note.md'), 'utf8'), '新規メモ追記');

    const deepWrite: any = await call('write_file', { path: 'a/b/c/deep.txt', content: 'deep' });
    check('write creates missing parent directories', existsSync(join(root, 'a', 'b', 'c', 'deep.txt')));
    eq('deep write path is reported relative', deepWrite.path, join('a', 'b', 'c', 'deep.txt'));

    const deleted: any = await call('delete_file', { path: 'a/b/c/deep.txt' });
    eq('delete reports success', deleted.deleted, true);
    check('deleted file is gone', !existsSync(join(root, 'a', 'b', 'c', 'deep.txt')));

    // ---------------------------------------------------------------------
    section('Guard rails on ordinary use');

    try {
      await call('write_file', { path: 'notes.md', content: 'x', mode: 'create_only' });
      check('create_only refuses to clobber an existing file', false, 'no throw');
    } catch (err: any) {
      check('create_only refuses to clobber an existing file', /既に存在します/.test(err.message));
    }
    check('notes.md was not clobbered', readFileSync(join(root, 'notes.md'), 'utf8').includes('心臓'));

    try {
      await call('read_file', { path: 'binary.bin' });
      check('binary files are refused', false, 'no throw');
    } catch (err: any) {
      check('binary files are refused', /バイナリ/.test(err.message));
    }

    try {
      await call('delete_file', { path: 'projects' });
      check('delete refuses directories', false, 'no throw');
    } catch (err: any) {
      check('delete refuses directories', /ファイルのみ/.test(err.message));
    }
    check('the directory survived the delete attempt', existsSync(join(root, 'projects')));

    try {
      await call('write_file', { path: 'huge.txt', content: 'a'.repeat(2 * 1024 * 1024) });
      check('oversized writes are refused', false, 'no throw');
    } catch (err: any) {
      check('oversized writes are refused', /上限/.test(err.message));
    }

    // ---------------------------------------------------------------------
    section('System tools');

    const time: any = await call('get_current_time', { timeZone: 'Asia/Tokyo' });
    check('current time returns an ISO timestamp', !Number.isNaN(Date.parse(time.iso)));
    eq('requested timezone is honoured', time.timeZone, 'Asia/Tokyo');
    check('localized time is produced', typeof time.localized === 'string' && time.localized.length > 0);
    check('weekday is produced', typeof time.weekday === 'string' && time.weekday.length > 0);

    try {
      await call('get_current_time', { timeZone: 'Not/AZone' });
      check('invalid timezone is rejected', false, 'no throw');
    } catch (err: any) {
      check('invalid timezone is rejected', /不明なタイムゾーン/.test(err.message));
    }

    const info: any = await call('get_workspace_info', {});
    eq('workspace info reports the configured root', info.root, workspace.root);

    // ---------------------------------------------------------------------
    section('Registry error handling');

    const errorResult = await registry.executeTool('read_file', { path: '../outside/secret.txt' });
    check('denied access surfaces as a tool error, not a crash', typeof errorResult.error === 'string');
    check('the error names the reason', /許可されていません/.test(errorResult.error || ''));
    eq('unknown tool is reported', (await registry.executeTool('nope', {})).error, 'Tool "nope" is not registered.');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Production tools: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('All production tool tests passed.');
}

main().catch((err) => {
  console.error('\nTest harness crashed:', err);
  process.exit(1);
});
