import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { runVerification } from '../server/services/verification_sandbox.js';
(async () => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-isolation-test-'));
 const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
 try {
  const work = path.join(root, 'work'); fs.mkdirSync(work);
  const secret = path.join(root, 'fake-secret'); fs.writeFileSync(secret, 'FAKE_SECRET');
  const outside = path.join(root, 'outside');
  fs.writeFileSync(path.join(work, '.git'), 'AUDIT-GIT-POINTER');
  const code = `const fs=require('fs'),net=require('net'); const results={};
    for(const [k,fn] of Object.entries({read:()=>fs.readFileSync(${JSON.stringify(secret)}),write:()=>fs.writeFileSync(${JSON.stringify(outside)},'BAD'),git:()=>fs.writeFileSync('.git','BAD'),outsideSignal:()=>process.kill(${unrelated.pid},'SIGTERM')})) {try{fn();results[k]='allowed'}catch(e){results[k]='denied'}}
    fs.writeFileSync('allowed','ok');results.inside='allowed';results.privateHome=process.env.HOME!==${JSON.stringify(os.homedir())};
    const child=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    child.on('spawn',()=>child.kill('SIGTERM'));child.on('exit',()=>{results.childStop='allowed';
    const s=net.connect({host:'127.0.0.1',port:3002});s.on('connect',()=>{results.network='allowed';s.destroy();console.log(JSON.stringify(results))});s.on('error',()=>{results.network='denied';console.log(JSON.stringify(results))});});`;
  const r = await runVerification(process.execPath, ['-e', code], {cwd:work,timeoutMs:15000,dependencies:path.resolve('node_modules')});
  assert.equal(r.code,0,r.stderr);
  const result=JSON.parse(r.stdout.trim());
  assert.deepEqual(result,{read:'denied',write:'denied',git:'denied',outsideSignal:'denied',inside:'allowed',privateHome:true,childStop:'allowed',network:'denied'});
  assert.equal(unrelated.exitCode,null);
  assert.equal(fs.existsSync(outside),false);
  console.log('Verification isolation: outside reads/writes, shared Git writes and network denied; isolated writes allowed.');
 } finally { unrelated.kill('SIGKILL'); fs.rmSync(root,{recursive:true,force:true}); }
})();
