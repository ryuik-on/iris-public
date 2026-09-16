import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findWorkplace } from '../server/core/fdp_workplace.js';

let passed = 0, failed = 0;
const check = (name: string, ok: boolean) => { ok ? passed++ : failed++; console.log(`  ${ok ? '✓' : '✗'} ${name}`); };

const fdp = mkdtempSync(join(tmpdir(), 'fdp-'));
const other = mkdtempSync(join(tmpdir(), 'other-'));
mkdirSync(join(fdp, 't007-paper-reading'));
mkdirSync(join(fdp, 'ml-bridge-plan'));
writeFileSync(join(fdp, 'ml-bridge-plan', 'week0-numpy.md'), '');
mkdirSync(join(other, 'docs'));
writeFileSync(join(other, 'docs', 'ledger.csv'), '');
const roots = [fdp, other];

console.log('▸ 番号の名を持つ資料入れ');
{
  const w = findWorkplace({ id: 'T007', nextAction: 'なんでも' }, roots);
  check('t007-* が見つかる', w?.path === join(fdp, 't007-paper-reading'));
  check('根拠は folder-by-id', w?.basis === 'folder-by-id');
  check('種類は folder', w?.kind === 'folder');
}
console.log('▸ 文の中の道');
{
  const w = findWorkplace({ id: 'T006', nextAction: 'まずWeek0(numpy,30-45分,ml-bridge-plan/week0-numpy.md)を通す' }, roots);
  check('括弧の中の道でも拾う', w?.path === join(fdp, 'ml-bridge-plan', 'week0-numpy.md'));
  check('根拠は path-in-text', w?.basis === 'path-in-text');
  check('種類は file', w?.kind === 'file');
}
{
  const w = findWorkplace({ id: 'T011', doneCriteria: '台帳（docs/ledger.csv）の…' }, roots);
  check('二つ目の根の下でも見つかる', w?.path === join(other, 'docs', 'ledger.csv'));
}
console.log('▸ 無いものは無い');
{
  check('手続き系は null', findWorkplace({ id: 'T009', nextAction: '説明会の日程を確認する' }, roots) === null);
  check('実在しない道は拾わない', findWorkplace({ id: 'T099', nextAction: 'ghost-folder/README.md を読む' }, roots) === null);
  check('根の外へ出る道は拾わない', findWorkplace({ id: 'T098', nextAction: '../../etc/passwd' }, roots) === null);
}
rmSync(fdp, { recursive: true }); rmSync(other, { recursive: true });
console.log(`\nFDP workplace: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
