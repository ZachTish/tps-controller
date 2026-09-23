import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {build} from 'esbuild';
if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', {value:webcrypto});
const out=await build({entryPoints:['src/services/finance-wallet-relay.ts'],bundle:true,write:false,format:'esm',platform:'node'});
const {reconcileWallet,walletDigest}=await import('data:text/javascript;base64,'+Buffer.from(out.outputFiles[0].text).toString('base64'));
const producerId='11111111-1111-4111-8111-111111111111',batchId='22222222-2222-4222-8222-222222222222';
async function fixture(){
 const files=new Map(),part=JSON.stringify({version:1,accounts:[],transactions:[],deletedTransactions:[]});
 const manifest={version:1,producerId,sequence:1,batchId,parts:[await walletDigest(part)]};
 files.set('wallet/pending',manifest);files.set(`wallet/${batchId}/0`,part);
 let receipt=null,calls=0,failImport=false,failSave=false,failAck=false,enabled=true;
 const io={read:async n=>structuredClone(files.get(n)??null),write:async(n,v)=>{if(failAck)throw Error('disk');files.set(n,structuredClone(v));},load:()=>structuredClone(receipt),save:r=>{if(failSave)throw Error('secret storage');receipt=structuredClone(r);},active:()=>enabled,importParts:async p=>{calls++;if(failImport)throw Error('partial write');assert.equal(p[0].version,1);}};
 return {files,manifest,io,get receipt(){return receipt;},set receipt(v){receipt=v;},get calls(){return calls;},set failImport(v){failImport=v;},set failSave(v){failSave=v;},set failAck(v){failAck=v;},set enabled(v){enabled=v;}};
}
test('complete verified transfer commits before acknowledgement and replays without writes',async()=>{const h=await fixture();await reconcileWallet(h.io);assert.equal(h.receipt.complete,true);assert.deepEqual(h.files.get('wallet/receipt'),h.receipt);await reconcileWallet(h.io);assert.equal(h.calls,1);});
test('incomplete sync waits without any mutation',async()=>{const h=await fixture();h.files.delete(`wallet/${batchId}/0`);await reconcileWallet(h.io);assert.equal(h.calls,0);assert.equal(h.receipt,null);});
test('tampered part is rejected before mutation',async()=>{const h=await fixture();h.files.set(`wallet/${batchId}/0`,'{}');await assert.rejects(reconcileWallet(h.io));assert.equal(h.calls,0);});
test('partial import resumes only the claimed batch',async()=>{const h=await fixture();h.failImport=true;await assert.rejects(reconcileWallet(h.io));assert.equal(h.receipt.complete,false);h.failImport=false;await reconcileWallet(h.io);assert.equal(h.calls,2);assert.equal(h.receipt.complete,true);});
test('changed content cannot reuse an interrupted sequence',async()=>{const h=await fixture();h.failImport=true;await assert.rejects(reconcileWallet(h.io));h.manifest.parts=[await walletDigest('{}')];h.files.set('wallet/pending',h.manifest);await assert.rejects(reconcileWallet(h.io),/identity changed/);assert.equal(h.calls,1);});
test('receipt save failure prevents importing and failed acknowledgement is repaired without reimport',async()=>{const h=await fixture();h.failSave=true;await assert.rejects(reconcileWallet(h.io));assert.equal(h.calls,0);h.failSave=false;h.failAck=true;await assert.rejects(reconcileWallet(h.io));assert.equal(h.calls,1);h.failAck=false;await reconcileWallet(h.io);assert.equal(h.calls,1);});
test('sequence gaps, alternate producers and malformed local state fail closed',async()=>{for(const scenario of ['gap','producer','state']){const h=await fixture();await reconcileWallet(h.io);if(scenario==='gap')h.manifest.sequence=3;if(scenario==='producer')h.manifest.producerId=batchId;if(scenario==='state')h.receipt={};h.files.set('wallet/pending',h.manifest);await assert.rejects(reconcileWallet(h.io));assert.equal(h.calls,1);}});
test('manifest changing during transfer and disabling the host prevent note writes',async()=>{for(const disable of [true,false]){const h=await fixture(),read=h.io.read;h.io.read=async name=>{const r=await read(name);if(name.endsWith('/0')){if(disable)h.enabled=false;else h.files.set('wallet/pending',{...h.manifest,sequence:2});}return r;};await reconcileWallet(h.io);assert.equal(h.calls,0);}});

const {retireWalletImporter}=await import('data:text/javascript;base64,'+Buffer.from(out.outputFiles[0].text).toString('base64'));
function handoff(){
 const request={version:1,producerId,requestId:batchId},files=new Map([['wallet/local-import',request]]);
 let owner,stops=0,failSave=false,failReply=false,active=true,previous=producerId;
 return {files,get owner(){return owner;},get stops(){return stops;},set failSave(v){failSave=v;},set failReply(v){failReply=v;},set active(v){active=v;},set previous(v){previous=v;},io:{
  read:async n=>structuredClone(files.get(n)??null),write:async(n,v)=>{if(failReply)throw Error('lost reply');files.set(n,v);},owner:()=>owner,previousProducer:()=>previous,
  retire:v=>{stops++;if(!failSave)owner=v;},active:()=>active}};
}
test('handoff retires durably before receipt; lost reply retries without retiring twice',async()=>{const h=handoff();h.failReply=true;await assert.rejects(retireWalletImporter(h.io));assert.ok(h.owner);assert.equal(h.files.has('wallet/local-import-receipt'),false);h.failReply=false;await retireWalletImporter(h.io);assert.equal(h.stops,1);assert.equal(h.files.get('wallet/local-import-receipt').complete,true);});
test('failed retirement, changed authority and another producer never acknowledge',async()=>{for(const scenario of ['save','inactive','producer']){const h=handoff();if(scenario==='save')h.failSave=true;if(scenario==='inactive')h.active=false;if(scenario==='producer')h.previous=batchId;if(scenario==='inactive')await retireWalletImporter(h.io);else await assert.rejects(retireWalletImporter(h.io));assert.equal(h.files.has('wallet/local-import-receipt'),false);}});
test('a stale handoff cannot replace the durable owner',async()=>{const h=handoff();await retireWalletImporter(h.io);h.files.set('wallet/local-import',{version:1,producerId,requestId:producerId});await assert.rejects(retireWalletImporter(h.io));assert.equal(h.stops,1);});
