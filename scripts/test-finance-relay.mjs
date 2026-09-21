import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { build } from 'esbuild';
const result=await build({entryPoints:['src/services/finance-relay.ts'],bundle:true,platform:'browser',format:'cjs',write:false,external:['obsidian']});
const module={exports:{}};
new Function('module','exports','require','crypto',result.outputFiles[0].text)(module,module.exports,()=>({Platform:{isMobile:false}}),webcrypto);
const {FinanceRelayService,encodeRelay,decodeRelay,validHostedLink,financeRequestFolder}=module.exports;
const CONFIG='tps-finance-relay-v1',JOURNAL='tps-finance-relay-journal',KEY='tps-finance-relay-key';
const wait=()=>new Promise(resolve=>setImmediate(resolve));
function filesystem(){
 const files=new Map(), folders=new Set();let failWrites=false;
 return {files,folders,set failWrites(v){failWrites=v;},
  exists:async p=>files.has(p)||folders.has(p),stat:async p=>files.has(p)?{type:'file',size:files.get(p).length}:folders.has(p)?{type:'folder',size:0}:null,
  read:async p=>files.get(p),write:async(p,s)=>{if(failWrites)throw Error('disk failure');files.set(p,s);},
  rename:async(from,to)=>{if(failWrites)throw Error('disk failure');for(const [p,v] of [...files])if(p===from||p.startsWith(from+'/')){files.delete(p);files.set(to+p.slice(from.length),v);}for(const p of [...folders])if(p===from||p.startsWith(from+'/')){folders.delete(p);folders.add(to+p.slice(from.length));}},
  mkdir:async p=>{folders.add(p);},remove:async p=>files.delete(p),
  list:async dir=>({files:[...files.keys()].filter(p=>p.startsWith(dir+'/')&&!p.slice(dir.length+1).includes('/')),folders:[]})};
}
function device(clock,backend,fs=filesystem()){
 const local=new Map(),secrets=new Map();let controller=!!backend;
 const app={loadLocalStorage:k=>structuredClone(local.get(k)),saveLocalStorage:(k,v)=>local.set(k,structuredClone(v)),secretStorage:{getSecret:k=>secrets.get(k),setSecret:(k,v)=>secrets.set(k,v)},vault:{adapter:fs}};
 const make=()=>new FinanceRelayService(app,()=>controller,()=>backend,()=>clock.time);
 return {local,secrets,app,fs,relay:make(),make,set controller(v){controller=v;}};
}
function backend(clock){
 const calls=[],receipts=new Set();let completed=false,failSync=false;
 return {version:1,calls,receipts,get completed(){return completed;},set completed(v){completed=v;},set failSync(v){failSync=v;},
 snapshot:()=>({ready:true,items:[{localItemId:'item-1',institutionName:'Synthetic Bank',environment:'sandbox',lastSyncAt:'',accessToken:'never-leak'}]}),
 createLink:async itemId=>{calls.push('create');return{linkToken:'synthetic-link-secret',url:'https://secure.plaid.com/hl/synthetic',expiresAt:clock.time+1800_000,environment:'sandbox',clientRef:'client',secretRef:'secret',itemId};},
 pollLink:async()=>{calls.push('poll');return completed?{state:'complete',publicToken:'synthetic-public-secret'}:{state:'waiting'};},
 completeLink:async(s,r,id)=>{calls.push('exchange');receipts.add(id);},hasCompleted:id=>receipts.has(id),
 sync:async()=>{calls.push('sync');if(failSync)throw Object.assign(Error('private provider error'),{code:'INSTITUTION_DOWN'});},
 disconnect:async()=>{calls.push('disconnect');}};
}
function transfer(from,to){for(const [p,s] of from.fs.files)to.fs.files.set(p,s);for(const p of from.fs.folders)to.fs.folders.add(p);}
async function setup(){const clock={time:1_800_000_000_000};const b=backend(clock),host=device(clock,b),client=device(clock);
 await host.relay.configureHost();await host.relay.setIntervalMinutes(0);await client.relay.importPairing(host.relay.exportPairing());return{clock,b,host,client};}
async function deliver(host,client){await client.relay.tick();transfer(client,host);await host.relay.tick();transfer(host,client);await client.relay.tick();}

test('AES-GCM authenticates collection and path, uses fresh nonces, and rejects corruption',async()=>{
 const key=Buffer.from(webcrypto.getRandomValues(new Uint8Array(32))).toString('base64');
 const a=await encodeRelay({value:'secret'},key,'collection/request-1');const b=await encodeRelay({value:'secret'},key,'collection/request-1');
 assert.notEqual(a,b);assert.ok(!a.includes('secret'));assert.deepEqual(await decodeRelay(a,key,'collection/request-1'),{value:'secret'});
 await assert.rejects(()=>decodeRelay(a,key,'collection/request-2'));await assert.rejects(()=>decodeRelay(a.replace(/ciphertext":"./,'ciphertext":"!'),key,'collection/request-1'));
 for(const url of ['http://secure.plaid.com/hl/a','https://secure.plaid.com.evil/hl/a','https://user@secure.plaid.com/hl/a','https://secure.plaid.com:444/hl/a','javascript:alert(1)'])assert.equal(validHostedLink(url),false);
});

test('independent offline client connects, survives restart and imports once without sharing tokens',async()=>{
 const {host,client,b,clock}=await setup();const id=await client.relay.request('connect');await client.relay.tick();
 assert.equal(b.calls.length,0);assert.equal(client.relay.getOperations()[0].state,'queued');
 await deliver(host,client);assert.equal(client.relay.getOperations().find(op=>op.id===id).state,'awaiting-user');
 assert.equal(client.relay.getStatus().items[0].accessToken,undefined);
 for(const text of host.fs.files.values()) for(const secret of ['synthetic-link-secret','synthetic-public-secret','never-leak','Synthetic Bank'])assert.ok(!text.includes(secret));
 assert.ok(![...client.secrets.values()].join('').includes('synthetic-link-secret'));
 await host.relay.stop();host.relay=host.make();b.completed=true;clock.time+=10_000;await deliver(host,client);
 assert.equal(client.relay.getOperations().find(op=>op.id===id).state,'complete');assert.equal(b.calls.filter(c=>c==='exchange').length,1);assert.equal(b.calls.filter(c=>c==='sync').length,1);
 clock.time+=20*60_000;await host.relay.tick();assert.equal(b.calls.filter(c=>c==='sync').length,1,'manual mode stays manual after initial import');
});

test('concurrent local requests serialize with reconciliation and deduplicate a double tap',async()=>{
 const {host,client,b}=await setup();
 const [a,bid]=await Promise.all([client.relay.request('sync'),client.relay.request('sync'),client.relay.tick()]);assert.equal(a,bid);
 await deliver(host,client);assert.equal(b.calls.filter(c=>c==='sync').length,1);
 const saved=JSON.parse(client.secrets.get(JOURNAL));assert.equal(saved.pending.length,1);
});

test('missing request publication is repaired from durable client journal',async()=>{
 const {host,client,b}=await setup();client.fs.failWrites=true;await assert.rejects(()=>client.relay.request('sync'));
 client.fs.failWrites=false;await client.relay.tick();await deliver(host,client);assert.equal(b.calls.filter(c=>c==='sync').length,1);
});

test('replayed and response-lost requests acknowledge without repeating committed operations',async()=>{
 const {host,client,b}=await setup();await client.relay.request('sync');await deliver(host,client);
 for(const p of host.fs.files.keys())if(p.includes('/responses/'))host.fs.files.delete(p);
 await host.relay.stop();host.relay=host.make();await host.relay.tick();assert.equal(b.calls.filter(c=>c==='sync').length,1);
 assert.ok([...host.fs.files.keys()].some(p=>p.includes('/responses/')));
});

test('interrupted exchange uses a saved receipt, otherwise fails closed without another exchange',async()=>{
 for(const receipt of [true,false]){
  const {host,client,b}=await setup();const id=await client.relay.request('connect');await deliver(host,client);
  const j=JSON.parse(host.secrets.get(JOURNAL));j.jobs[id].phase='exchanging';host.secrets.set(JOURNAL,JSON.stringify(j));if(receipt)b.receipts.add(id);
  await host.relay.stop();host.relay=host.make();await host.relay.tick();
  assert.equal(host.relay.getOperations().find(op=>op.id===id).state,receipt?'complete':'uncertain');assert.equal(b.calls.filter(c=>c==='exchange').length,0);
 }
});

test('missing or corrupt journal/key pauses all provider calls',async()=>{
 for(const corrupt of ['missing-journal','bad-journal','missing-key','wrong-key']){
  const {host,client,b}=await setup();await client.relay.request('sync');await client.relay.tick();transfer(client,host);
  if(corrupt==='missing-journal')host.secrets.delete(JOURNAL);
  if(corrupt==='bad-journal')host.secrets.set(JOURNAL,'{}');
  if(corrupt==='missing-key')host.secrets.delete(KEY);
  if(corrupt==='wrong-key')host.secrets.set(KEY,Buffer.alloc(32,1).toString('base64'));
  await host.relay.tick();assert.equal(b.calls.length,0,corrupt);assert.equal(host.relay.getStatus().online,false);assert.match(host.relay.getStatus().message,/paused/);
 }
});

test('five bounded retries report failure without leaking provider text',async()=>{
 const {host,client,b,clock}=await setup();b.failSync=true;const id=await client.relay.request('sync');await deliver(host,client);
 for(let n=0;n<8;n++){clock.time+=61_000;await host.relay.tick();}
 assert.equal(b.calls.filter(c=>c==='sync').length,5);const result=host.relay.getOperations().find(op=>op.id===id);
 assert.equal(result.state,'failed');assert.match(result.message,/INSTITUTION_DOWN/);assert.ok(!result.message.includes('private provider'));
});

test('expired undelivered requests cannot resurrect on a stale device',async()=>{
 const {host,client,b,clock}=await setup();await client.relay.request('connect');await client.relay.tick();clock.time+=31*60_000;transfer(client,host);await host.relay.tick();assert.equal(b.calls.length,0);
 clock.time+=25*60*60_000;await host.relay.tick();assert.equal(Object.keys(JSON.parse(host.secrets.get(JOURNAL)).jobs).length,0);
 transfer(client,host);await host.relay.tick();assert.equal(b.calls.length,0);
});

test('paused/non-controller host never imports, and client detects stale heartbeat',async()=>{
 const {host,client,b,clock}=await setup();transfer(host,client);await client.relay.tick();assert.equal(client.relay.getStatus().online,true);
 host.controller=false;await client.relay.request('sync');await deliver(host,client);assert.equal(b.calls.length,0);
 clock.time+=91_000;assert.equal(client.relay.getStatus().online,false);assert.match(client.relay.getStatus().message,/Waiting for the Controller/);host.controller=true;await host.relay.setEnabled(false);await host.relay.tick();assert.equal(b.calls.length,0);assert.match(host.relay.getStatus().message,/paused/);
});

test('sign-in completed before expiry can be recovered after the URL expires',async()=>{
 const {host,client,b,clock}=await setup();await client.relay.request('connect');await deliver(host,client);b.completed=true;clock.time+=31*60_000;await host.relay.tick();assert.equal(b.calls.filter(c=>c==='exchange').length,1);
});

test('a reloaded instance waits for the previous device operation to settle',async()=>{
 const {host,client,b}=await setup();let release;const gate=new Promise(resolve=>release=resolve);const original=b.sync;b.sync=async()=>{await gate;return original();};
 await client.relay.request('sync');await client.relay.tick();transfer(client,host);const first=host.relay.tick();await wait();const stopped=host.relay.stop();const next=host.make();const second=next.tick();await wait();assert.equal(b.calls.length,0);release();await Promise.all([first,stopped,second]);assert.equal(b.calls.filter(c=>c==='sync').length,1);
});

test('temporary polling outages retain the sign-in and resume within its bounded recovery window',async()=>{
 const {host,client,b,clock}=await setup();const id=await client.relay.request('connect');await deliver(host,client);
 const original=b.pollLink;b.pollLink=async()=>{throw Error('network offline');};
 for(let n=0;n<5;n++){clock.time+=61_000;await host.relay.tick();}
 assert.equal(host.relay.getOperations().find(op=>op.id===id).state,'awaiting-user');
 b.pollLink=original;b.completed=true;clock.time+=5*60_000;await host.relay.tick();assert.equal(b.calls.filter(c=>c==='exchange').length,1);
});

test('a completed response deleted locally is repaired without replaying the mutation',async()=>{
 const {host,client,b}=await setup();await client.relay.request('sync');await deliver(host,client);
 for(const p of host.fs.files.keys())if(p.includes('/responses/'))host.fs.files.delete(p);
 await host.relay.tick();assert.equal(b.calls.filter(c=>c==='sync').length,1);assert.ok([...host.fs.files.keys()].some(p=>p.includes('/responses/')));
});

test('unpair clears only the client transport, allowing a corrected pairing without touching host banks',async()=>{
 const {host,client,b}=await setup();await client.relay.unpairClient();assert.equal(client.relay.getConfiguration(),null);assert.equal(b.calls.length,0);assert.ok(host.relay.getConfiguration());
 await client.relay.importPairing(host.relay.exportPairing());assert.equal(client.relay.getConfiguration().mode,'client');await assert.rejects(()=>host.relay.unpairClient(),/Only a paired client/);
});

test('malformed local waiting session is rejected before calling the bank',async()=>{
 const {host,client,b}=await setup();const id=await client.relay.request('connect');await deliver(host,client);const before=b.calls.length;
 const j=JSON.parse(host.secrets.get(JOURNAL));delete j.jobs[id].session;host.secrets.set(JOURNAL,JSON.stringify(j));await host.relay.tick();assert.equal(b.calls.length,before);assert.equal(host.relay.getStatus().online,false);
});


test('custom finance folders travel in pairing codes and legacy codes retain the old default',async()=>{
 const clock={time:1_800_000_000_000},b=backend(clock),host=device(clock,b),client=device(clock);
 await host.relay.configureHost('_system/銀行 requests');await client.relay.importPairing(host.relay.exportPairing());
 assert.equal(client.relay.getRequestFolder(),'_system/銀行 requests');await client.relay.request('sync');await deliver(host,client);assert.equal(b.calls.filter(c=>c==='sync').length,1);
 assert.ok([...host.fs.files.keys()].every(p=>p.startsWith('_system/銀行 requests/')));
 const old=JSON.parse(Buffer.from(host.relay.exportPairing().split(':')[1],'base64'));delete old.folder;
 const legacy=device(clock);await legacy.relay.importPairing('tps-finance-v1:'+Buffer.from(JSON.stringify(old)).toString('base64'));assert.equal(legacy.relay.getRequestFolder(),'_assets/TPS Finance Relay');
});

test('moving a finance collection preserves pending work, keys, receipts and unrelated files',async()=>{
 const {host,client,b,clock}=await setup();const id=await client.relay.request('connect');await deliver(host,client);
 const key=host.secrets.get(KEY),clientJournal=client.secrets.get(JOURNAL),deviceId=client.relay.getConfiguration().deviceId;
 host.fs.files.set('_assets/personal.md','keep');
 await host.relay.setRequestFolder('_system/TPS Finance Relay');assert.equal(host.secrets.get(KEY),key);assert.equal(host.fs.files.get('_assets/personal.md'),'keep');
 await client.relay.importPairing(host.relay.exportPairing());assert.equal(client.secrets.get(JOURNAL),clientJournal);assert.equal(client.relay.getConfiguration().deviceId,deviceId);
 b.completed=true;clock.time+=10_000;await deliver(host,client);assert.equal(client.relay.getOperations().find(o=>o.id===id).state,'complete');assert.equal(b.calls.filter(c=>c==='exchange').length,1);
 await host.relay.tick();assert.equal(b.calls.filter(c=>c==='exchange').length,1);
});

test('folder changes reject unsafe paths and collisions without replacing files',async()=>{
 for(const p of ['', '../outside','/absolute','a/../b','.obsidian/queue','a//b','a\\b','C:/outside','a./b'])assert.throws(()=>financeRequestFolder(p));
 const {host,client}=await setup(),c=host.relay.getConfiguration();host.fs.files.set('_system/'+c.relayId,'unrelated');
 await assert.rejects(()=>host.relay.setRequestFolder('_system'),/already contains/);assert.equal(host.fs.files.get('_system/'+c.relayId),'unrelated');assert.equal(host.relay.getRequestFolder(),'_assets/TPS Finance Relay');
 await assert.rejects(()=>client.relay.setRequestFolder('_system'),/host/);
});

test('an interrupted folder rename resumes before any provider work, including while paused',async()=>{
 const {host,client,b}=await setup();await client.relay.request('sync');await client.relay.tick();transfer(client,host);
 const original=host.fs.rename;host.fs.rename=async()=>{throw Error('disk failure');};await assert.rejects(()=>host.relay.setRequestFolder('_system'),/disk failure/);
 assert.ok(host.relay.getConfiguration().folderMove);await host.relay.tick();assert.equal(b.calls.length,0);
 host.fs.rename=async(...args)=>{await original(...args);throw Error('crash after rename');};await assert.rejects(()=>host.relay.setRequestFolder('_system'),/crash/);
 await host.relay.stop();host.fs.rename=original;host.relay=host.make();await host.relay.tick();assert.equal(host.relay.getRequestFolder(),'_system');assert.equal(b.calls.filter(c=>c==='sync').length,1);
 host.relay.setEnabled(false);await host.relay.setRequestFolder('_system/paused');assert.equal(host.relay.getRequestFolder(),'_system/paused');assert.equal(host.relay.getConfiguration().enabled,false);
});

test('Wallet uses the same encrypted relay, preserves replay receipts, and works without Plaid',async()=>{
 const clock={time:1_800_000_000_000}, b=backend(clock), host=device(clock,b);
 b.snapshot=()=>({ready:false,items:[]}); let imports=0;
 b.importWallet=async parts=>{imports++;assert.equal(parts[0].version,1)};
 await host.relay.configureHost(); host.relay.setWalletEnabled(true);
 const c=host.relay.getConfiguration(), key=host.secrets.get(KEY), base=`${c.folder||'_assets/TPS Finance Relay'}/${c.relayId}/`;
 const producerId='11111111-1111-4111-8111-111111111111',batchId='22222222-2222-4222-8222-222222222222';
 const part=JSON.stringify({version:1,accounts:[],transactions:[],deletedTransactions:[]});
 const digest=Buffer.from(await webcrypto.subtle.digest('SHA-256',new TextEncoder().encode(part))).toString('hex');
 const m={batchId,parts:[digest],producerId,sequence:1,version:1};
 host.fs.files.set(base+`wallet/${batchId}/0.md`,await encodeRelay(part,key,`${c.relayId}/wallet/${batchId}/0`));
 host.fs.files.set(base+'wallet/pending.md',await encodeRelay(m,key,`${c.relayId}/wallet/pending`));
 clock.time+=16*60_000;await host.relay.tick();assert.equal(imports,1);assert.equal(b.calls.length,0);
 const receipt=await decodeRelay(host.fs.files.get(base+'wallet/receipt.md'),key,c.relayId+'/wallet/receipt');assert.equal(receipt.complete,true);
 await host.relay.stop();host.relay=host.make();await host.relay.tick();assert.equal(imports,1);
 host.relay.setWalletEnabled(false);host.relay.setWalletEnabled(true);await host.relay.tick();assert.equal(imports,1);
});
