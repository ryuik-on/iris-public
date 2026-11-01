import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { verifyBranch, mergeApproved, type Exec } from '../server/core/self_fix.js';
(async()=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'iris-verified-sha-'))),repo=path.join(root,'repo');fs.mkdirSync(repo);
 const env={PATH:process.env.PATH,HOME:root,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'};
 const git=(...args:string[])=>execFileSync('git',args,{cwd:repo,env,encoding:'utf8'}).trim();
 try {
  git('init','-q','-b','main');git('config','user.email','test@localhost');git('config','user.name','Test');fs.writeFileSync(path.join(repo,'base'),'base');git('add','.');git('commit','-qm','base');git('checkout','-qb','candidate');
  fs.mkdirSync(path.join(repo,'scripts'));fs.writeFileSync(path.join(repo,'scripts/test-a.ts'),'// test');git('add','.');git('commit','-qm','candidate');const checked=git('rev-parse','HEAD');git('checkout','-q','main');
  const execute:Exec=async(command,args,options)=>{
   if(command!=='git')return {code:0,stdout:'test stub',stderr:''};
   try{return {code:0,stdout:execFileSync(command,args,{cwd:options.cwd,env,encoding:'utf8',stdio:['ignore','pipe','pipe']}),stderr:''}}catch(e:any){return {code:e.status??1,stdout:String(e.stdout??''),stderr:String(e.stderr??'')}}
  };
  const verification=await verifyBranch({exec:execute},{repo,branch:'candidate',workdir:path.join(root,'verify'),linkNodeModules:()=>{}});
  assert.ok(verification.ok);assert.equal(verification.headSha,checked);
  git('checkout','-q','candidate');fs.mkdirSync(path.join(repo,'server/core'),{recursive:true});fs.writeFileSync(path.join(repo,'server/core/access.ts'),'// UNCHECKED');git('add','.');git('commit','-qm','unchecked');git('checkout','-q','main');
  const finding:any={status:'awaiting_approval',verification};
  const stale=await mergeApproved({exec:execute},{repo,branch:'candidate',finding,confirmProtected:false});assert.ok(!stale.merged&&stale.reason==='stale_verification');assert.equal(fs.existsSync(path.join(repo,'server/core/access.ts')),false);
  const legacy=await mergeApproved({exec:execute},{repo,branch:'candidate',finding:{status:'awaiting_approval',verification:{ok:true,protectedHits:[]}} as any,confirmProtected:false});assert.ok(!legacy.merged&&legacy.reason==='stale_verification');
  git('update-ref','refs/heads/candidate',checked);
  const accepted=await mergeApproved({exec:execute},{repo,branch:'candidate',finding,confirmProtected:false});assert.ok(accepted.merged);assert.equal(git('rev-parse','HEAD'),checked);
  console.log('Verified commit: changed branch and legacy approval refused; only the tested immutable SHA merged.');
 } finally {fs.rmSync(root,{recursive:true,force:true})}
})();
