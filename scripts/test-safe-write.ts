import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from '../server/tools/workspace.js';
import { createFilesystemTools } from '../server/tools/filesystem.js';
import { safeWrite } from '../server/services/safe_write.js';
(async () => {
 const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'iris-safe-write-test-')));
 try {
  const root=path.join(fixture,'work');const outside=path.join(fixture,'outside');fs.mkdirSync(root);fs.mkdirSync(outside);
  const workspace=new Workspace({root,readRoots:[],writeRoots:[]});const write=createFilesystemTools(workspace).find(x=>x.name==='write_file')!;
  const execute=(p:string,content='ok',mode='create_only')=>write.execute({path:p,content,mode});
  fs.symlinkSync(path.join(outside,'missing.txt'),path.join(root,'dangling.txt'));
  await assert.rejects(execute('dangling.txt'));
  assert.equal(fs.existsSync(path.join(outside,'missing.txt')),false);
  fs.mkdirSync(path.join(root,'dir'));
  const approved=workspace.resolveWrite('dir/file.txt');
  fs.renameSync(path.join(root,'dir'),path.join(root,'old-dir'));fs.symlinkSync(outside,path.join(root,'dir'));
  await assert.rejects(safeWrite(approved,'bad','overwrite'));
  assert.equal(fs.existsSync(path.join(outside,'file.txt')),false);
  const original=path.join(outside,'original.txt');fs.writeFileSync(original,'ORIGINAL');fs.linkSync(original,path.join(root,'hardlink.txt'));
  await execute('hardlink.txt','NEW','overwrite');assert.equal(fs.readFileSync(original,'utf8'),'ORIGINAL');
  const races=await Promise.allSettled([execute('once.txt','FIRST'),execute('once.txt','SECOND')]);
  assert.equal(races.filter(r=>r.status==='fulfilled').length,1);
  assert.ok(['FIRST','SECOND'].includes(fs.readFileSync(path.join(root,'once.txt'),'utf8')));
  await execute('once.txt','+append','append');assert.ok(fs.readFileSync(path.join(root,'once.txt'),'utf8').endsWith('+append'));
  assert.equal(fs.statSync(path.join(root,'once.txt')).mode&0o777,0o600);
  console.log('Safe file writes: dangling links, directory swaps, external hard links and concurrent create-only protected.');
 } finally {fs.rmSync(fixture,{recursive:true,force:true})}
})();
