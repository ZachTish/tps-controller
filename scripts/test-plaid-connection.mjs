import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const result=await build({entryPoints:['src/services/plaid-connection.ts'],bundle:true,platform:'node',format:'cjs',write:false,external:['obsidian']});
const module={exports:{}}; let calls=[];
new Function('module','exports','require',result.outputFiles[0].text)(module,module.exports,()=>({requestUrl:async options=>{calls.push(options);return {status:200,json:{ok:true}};}}));
const {PlaidConnectionService}=module.exports;
const device=()=>{const local=new Map();return new PlaidConnectionService({loadLocalStorage:k=>local.get(k),saveLocalStorage:(k,v)=>local.set(k,structuredClone(v)),secretStorage:{getSecret:k=>({client:'client-value',secret:'secret-value'})[k]}});};
test('connection config is local, imports legacy references once, and authenticates fixed hosts',async()=>{
 const a=device(),b=device();const legacy={plaidEnvironment:'sandbox',plaidClientIdSecret:'client',plaidSecretSecret:'secret',oauthRedirectUri:''};
 a.getConfiguration(legacy);b.getConfiguration(legacy);a.saveConfiguration({...legacy,plaidEnvironment:'production'});
 assert.equal(a.getConfiguration(legacy).plaidEnvironment,'production');assert.equal(b.getConfiguration().plaidEnvironment,'sandbox');
 await b.request('sandbox','/accounts/get',{access_token:'synthetic'});assert.equal(calls.at(-1).url,'https://sandbox.plaid.com/accounts/get');
 assert.equal(calls.at(-1).headers['PLAID-CLIENT-ID'],'client-value');
 await assert.rejects(()=>b.request('sandbox','https://evil.invalid',{}),/Unsupported/);
 await assert.rejects(()=>b.request('__proto__','/accounts/get',{}),/Unsupported/);
 await assert.rejects(()=>b.request('sandbox','/accounts/get',{},'missing','secret'),/Configure/);
});
test('conflicting secret references fail before transport and expose only setup status', async () => {
 const service=device();
 service.saveConfiguration({plaidEnvironment:'sandbox',plaidClientIdSecret:'client',plaidSecretSecret:'client',oauthRedirectUri:''});
 assert.deepEqual(service.inspect(),{state:'conflicting-credentials',clientIdConfigured:true,secretConfigured:true});
 const before=calls.length;
 await assert.rejects(()=>service.request('sandbox','/accounts/get',{}),/Configure separate/);
 assert.equal(calls.length,before);
});
