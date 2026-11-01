import assert from 'node:assert/strict';
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import { openDatabase } from '../server/services/db.js';
import { OAuthStore } from '../server/services/oauth_store.js';
import { IrisOAuthProvider } from '../server/services/oauth_provider.js';
(async () => {
 const db=openDatabase(':memory:');
 try {
  const store=new OAuthStore(db);
  store.saveTokens('calendar',{access_token:'FAKE_ACCESS',refresh_token:'FAKE_REFRESH'});
  const provider=new IrisOAuthProvider({serverId:'calendar',clientId:'fake-client',clientSecret:'FAKE_CLIENT_SECRET',redirectUri:'http://localhost:3002/api/mcp/oauth/callback',scopes:[],store});
  assert.equal(provider.tokens()?.issuer,'https://accounts.google.com/');
  assert.equal(store.getTokens('calendar')?.issuer,'https://accounts.google.com/');
  store.saveTokens('expired',{access_token:'fake',expires_in:-1});
  const oldExpiry=store.status('expired').expiresAt;
  store.bindLegacyIssuer('expired','https://accounts.google.com/');
  assert.equal(store.status('expired').expiresAt,oldExpiry);
  assert.equal(store.status('expired').expired,true);
  assert.throws(()=>provider.saveTokens({access_token:'fake',issuer:'https://attacker.example/'}));
  assert.throws(()=>provider.redirectToAuthorization(new URL('https://attacker.example/authorize')));
  assert.throws(()=>provider.saveDiscoveryState({authorizationServerUrl:'https://accounts.google.com',authorizationServerMetadata:{token_endpoint:'https://attacker.example/token'}}));
  const sent:string[]=[];
  await assert.rejects(auth(provider as any,{serverUrl:'https://mcp.example/mcp',fetchFn:async(input:any,init:any)=>{
   const url=String(input);sent.push(String(init?.body??''));
   if(url.includes('oauth-protected-resource'))return new Response(JSON.stringify({resource:'https://mcp.example/mcp',authorization_servers:['https://attacker.example']}),{headers:{'Content-Type':'application/json'}});
   return new Response(JSON.stringify({issuer:'https://attacker.example',authorization_endpoint:'https://attacker.example/auth',token_endpoint:'https://attacker.example/token',response_types_supported:['code'],code_challenge_methods_supported:['S256']}),{headers:{'Content-Type':'application/json'}});
  }}),/認可元|bound to authorization server/);
  assert.ok(sent.every(b=>!b.includes('FAKE_REFRESH')&&!b.includes('FAKE_CLIENT_SECRET')));
  console.log('OAuth issuer: SDK refuses substituted issuer/token endpoint before sending fake credentials; legacy Google tokens bound.');
 } finally {db.close()}
})();
