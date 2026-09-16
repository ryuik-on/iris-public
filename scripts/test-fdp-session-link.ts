import { mkdtempSync, mkdirSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sessionsFor } from '../server/core/fdp_session_link.js';

let passed = 0, failed = 0;
const check = (name: string, ok: boolean) => { ok ? passed++ : failed++; console.log(`  ${ok ? '✓' : '✗'} ${name}`); };
const base = mkdtempSync(join(tmpdir(), 'link-'));
const plan = join(base, 'ml-bridge-plan'); mkdirSync(plan); mkdirSync(join(plan, 'week1'));
const other = join(base, 'elsewhere'); mkdirSync(other);
const alias = join(base, 'alias'); symlinkSync(plan, alias);
const S = (id: string, cwd: string | null, live = true, lastAt = '2026-09-11T00:00:00Z') =>
  ({ id, name: id, live, resume: id, cwd, lastAt, kind: 'claude' as const });

console.log('▸ cwd が作業場所の中にあるものを拾う');
{
  const hits = sessionsFor({ path: plan, kind: 'folder' }, [S('a', plan), S('b', join(plan, 'week1')), S('c', other), S('d', null)]);
  check('直下と下の階層が当たる', hits.map((h) => h.id).sort().join() === 'a,b');
  check('別の場所は当たらない', !hits.some((h) => h.id === 'c'));
  check('cwd が無いものは当たらない', !hits.some((h) => h.id === 'd'));
}
console.log('▸ ファイルの作業場所は、その資料入れで比べる');
{
  const hits = sessionsFor({ path: join(plan, 'README.md'), kind: 'file' }, [S('a', plan)]);
  check('親の資料入れのセッションが当たる', hits.length === 1);
}
console.log('▸ シンボリックリンク越しでも同じ場所');
{
  const hits = sessionsFor({ path: alias, kind: 'folder' }, [S('a', plan)]);
  check('実体で比べる', hits.length === 1 && realpathSync(alias) === realpathSync(plan));
}
console.log('▸ 並び');
{
  const hits = sessionsFor({ path: plan, kind: 'folder' }, [
    S('old-live', plan, true, '2026-09-10T00:00:00Z'),
    S('new-dead', plan, false, '2026-09-11T00:00:00Z'),
    S('new-live', plan, true, '2026-09-11T00:00:00Z'),
  ]);
  check('生きているものが先、その中で新しい順', hits.map((h) => h.id).join() === 'new-live,old-live,new-dead');
}
console.log('▸ 根までなら、上にいるセッションも拾う');
{
  const proj = join(base, 'medrecall'); mkdirSync(proj); mkdirSync(join(proj, '.git')); mkdirSync(join(proj, 'docs'));
  const hits = sessionsFor({ path: join(proj, 'docs', 'ledger.csv'), kind: 'file' }, [S('root', proj), S('docs', join(proj, 'docs')), S('above', base)]);
  check('プロジェクトの根にいるものは enclosing で当たる', hits.some((h) => h.id === 'root' && h.scope === 'enclosing'));
  check('中にいるものは inside で先', hits[0]?.id === 'docs' && hits[0].scope === 'inside');
  check('根より上は当たらない', !hits.some((h) => h.id === 'above'));
}
console.log('▸ 無いものは無い');
{
  check('作業場所が無ければ空', sessionsFor(null, [S('a', plan)]).length === 0);
  check('消えた資料入れなら空', sessionsFor({ path: join(base, 'gone'), kind: 'folder' }, [S('a', plan)]).length === 0);
}
rmSync(base, { recursive: true });
console.log(`\nFDP session link: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
