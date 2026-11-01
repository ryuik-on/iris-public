import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
(async () => {
 const fixture=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'iris-http-security-')));
 const reserve=net.createServer(); await new Promise<void>(r=>reserve.listen(0,'127.0.0.1',r));const port=(reserve.address() as net.AddressInfo).port;await new Promise<void>(r=>reserve.close(()=>r()));
 fs.mkdirSync(path.join(fixture,'dist-server'));fs.copyFileSync('dist-server/index.cjs',path.join(fixture,'dist-server/index.cjs'));
 fs.mkdirSync(path.join(fixture,'server/native'),{recursive:true});fs.copyFileSync('server/native/safe_write.py',path.join(fixture,'server/native/safe_write.py'));
 fs.symlinkSync(path.resolve('node_modules'),path.join(fixture,'node_modules'));
 const home=path.join(fixture,'home');fs.mkdirSync(home);
 const immutable=path.join(fixture,'.iris/places.json');fs.mkdirSync(path.dirname(immutable));fs.writeFileSync(immutable,'{}',{mode:0o644});
 if(process.platform==='darwin')execFileSync('/usr/bin/chflags',['uchg',immutable]);
 let logs='';
 const start=()=>{const p=spawn(process.execPath,[path.join(fixture,'dist-server/index.cjs')],{cwd:fixture,env:{PATH:process.env.PATH,HOME:home,PORT:String(port),IRIS_SELF_DEV:'0'},stdio:['ignore','pipe','pipe']});p.stdout.on('data',b=>{logs=(logs+b.toString()).slice(-12000)});p.stderr.on('data',b=>{logs=(logs+b.toString()).slice(-12000)});return p;};
 let child=start();
 const base=`http://127.0.0.1:${port}`;
 try {
  let ready=false;
  for(let i=0;i<100;i++) {try {const r=await fetch(base+'/api/health');if(r.status===401){ready=true;break}}catch{} await new Promise(r=>setTimeout(r,100));}
  assert.ok(ready,'isolated API did not become ready: '+logs);
  const token=fs.readFileSync(path.join(home,'Library/Application Support/IRIS/local-session-token'),'utf8').trim();const owner={Authorization:`Bearer ${token}`};
  assert.equal((await fetch(base+'/api/access/token')).status,401);
  assert.equal((await fetch(base+'/api/health',{headers:{cookie:'iris_access=%'}})).status,401);
  assert.equal((await fetch(base+'/api/health',{headers:{Origin:'https://example.invalid'}})).status,403);
  assert.equal((await fetch(base+'/api/health',{headers:{...owner,Host:`evil.example:${port}`,Origin:`http://evil.example:${port}`}})).status,403);
  assert.equal((await fetch(base+'/api/health',{headers:{...owner,Origin:`https://127.0.0.1:${port}`}})).status,403);
  assert.equal((await fetch(base+'/api/health',{headers:owner})).status,200);
  assert.equal((await fetch(`http://[::1]:${port}/api/health`)).status,401);
  const markup='<script>document.title="BAD"</script>';
  const callback=await fetch(base+'/api/mcp/oauth/callback?error='+encodeURIComponent(markup));
  assert.equal(callback.status,400);assert.match(callback.headers.get('content-type')??'',/^text\/plain/);assert.ok((await callback.text()).includes(markup));assert.equal(callback.headers.get('x-content-type-options'),'nosniff');
  assert.match(callback.headers.get('content-security-policy')??'',/script-src 'self'/);
  const request={method:'POST',headers:{...owner,'Content-Type':'application/json'},body:JSON.stringify({path:'/?center=approvals'})};
  assert.equal((await fetch(base+'/api/access/launch',{...request,headers:{'Content-Type':'application/json'}})).status,401);
  const minted=await fetch(base+'/api/access/launch',request);assert.equal(minted.status,200);
  const url=new URL((await minted.json() as any).url);const ticket=new URLSearchParams(url.hash.slice(1)).get('iris-launch');assert.ok(ticket);
  assert.equal(url.hostname,'localhost');
  const redeem={method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ticket})};
  const accepted=await fetch(base+'/api/access/launch/redeem',redeem);assert.equal(accepted.status,200);
  const cookie=accepted.headers.get('set-cookie')??'';assert.match(cookie,/HttpOnly/i);assert.match(cookie,/SameSite=Strict/i);
  assert.equal((await fetch(base+'/api/health',{headers:{cookie:cookie.split(';')[0]}})).status,200);
  assert.equal((await fetch(base+'/api/access/launch/redeem',redeem)).status,401);
  assert.equal((await fetch(base+'/api/conversations',{method:'POST',headers:{...owner,'Content-Type':'application/json','Content-Encoding':'gzip'},body:gzipSync('{}')})).status,415);
  assert.equal((await fetch(base+'/api/chat',{method:'POST',headers:{'Content-Type':'application/json','Content-Encoding':'gzip'},body:Buffer.from('invalid compression')})).status,401);
  assert.equal((await fetch(base+'/api/health',{headers:owner})).status,200);
  assert.equal(fs.statSync(path.join(fixture,'.iris')).mode&0o777,0o700);
  assert.equal(fs.readFileSync(immutable,'utf8'),'{}');
  assert.equal(fs.statSync(path.join(home,'Library/Application Support/IRIS/local-session-token')).mode&0o777,0o600);
  child.kill('SIGTERM');await new Promise<void>(r=>child.once('exit',()=>r()));child=start();
  let newToken='';
  for(let i=0;i<100;i++){try{newToken=fs.readFileSync(path.join(home,'Library/Application Support/IRIS/local-session-token'),'utf8').trim();if(newToken!==token&&(await fetch(base+'/api/health',{headers:{Authorization:`Bearer ${newToken}`}})).status===200)break;}catch{}await new Promise(r=>setTimeout(r,100));}
  assert.notEqual(newToken,token);assert.equal((await fetch(base+'/api/health',{headers:owner})).status,401);
  assert.equal((await fetch(base+'/api/health',{headers:{cookie:cookie.split(';')[0]}})).status,401);
  const occupied=net.createServer();await new Promise<void>(r=>occupied.listen(0,'::1',r));const blockedPort=(occupied.address() as net.AddressInfo).port;
  try {
    const blockedHome=path.join(fixture,'blocked-home');fs.mkdirSync(blockedHome);
    const blocked=spawn(process.execPath,[path.join(fixture,'dist-server/index.cjs')],{cwd:fixture,env:{PATH:process.env.PATH,HOME:blockedHome,PORT:String(blockedPort),IRIS_SELF_DEV:'0'},stdio:'ignore'});
    const code=await new Promise<number|null>(r=>{const timer=setTimeout(()=>blocked.kill('SIGKILL'),10000);blocked.once('exit',c=>{clearTimeout(timer);r(c)});});
    assert.equal(code,1);assert.equal(fs.existsSync(path.join(blockedHome,'Library/Application Support/IRIS/local-session-token')),false);
  } finally { await new Promise<void>(r=>occupied.close(()=>r())); }
  console.log('HTTP security: loopback authentication, origin/Host guards, one-use tickets, restart key invalidation and compressed-body rejection verified; OAuth errors remain plain text.');
 } finally {
  child.kill('SIGTERM');await new Promise<void>(r=>{if(child.exitCode!==null)return r();child.once('exit',()=>r());setTimeout(()=>{child.kill('SIGKILL');r()},3000).unref()});if(process.platform==='darwin')execFileSync('/usr/bin/chflags',['nouchg',immutable]);fs.rmSync(fixture,{recursive:true,force:true});
 }
})();
