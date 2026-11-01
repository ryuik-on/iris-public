import fs from 'node:fs';
import { localAuthHeaders } from '../server/core/owner_access.js';
(async()=>{
 const [method='GET',target='/api/briefing']=process.argv.slice(2);
 if(!['GET','POST','PATCH','PUT','DELETE'].includes(method)||!target.startsWith('/api/')||target.includes('\\'))throw new Error('METHOD と /api/ で始まるパスを指定してください。');
 let body:string|undefined;
 if(method!=='GET') {const input=fs.readFileSync(0,'utf8').trim();if(input){if(Buffer.byteLength(input)>100*1024)throw new Error('本文が大きすぎます。');try{JSON.parse(input)}catch{throw new Error('本文を JSON として読めません。')}body=input}}
 const response=await fetch('http://127.0.0.1:3002'+target,{method,headers:{...localAuthHeaders(),...(body?{'Content-Type':'application/json'}:{})},body,redirect:'error',signal:AbortSignal.timeout(30000)});
 process.stdout.write(await response.text()+'\n');if(!response.ok)process.exitCode=1;
})().catch(e=>{process.stderr.write(`IRIS に接続できませんでした: ${e.message}\n`);process.exitCode=1});
