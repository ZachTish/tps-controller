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
