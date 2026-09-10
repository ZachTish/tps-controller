import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { builtinModules } from 'node:module';
import { webcrypto } from 'node:crypto';
globalThis.crypto ??= webcrypto;
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
const bundle = await build({
  entryPoints: [fileURLToPath(new URL('src/services/attachment-sync/service.ts', root))], bundle: true, write: false,
  format: 'esm', platform: 'browser', external: [...builtinModules,...builtinModules.map(name=>'node:'+name)], logLevel: 'silent',
  plugins: [{ name: 'obsidian-fixture', setup(build) {
    build.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'fixture' }));
    build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `
      export class Notice { constructor(message) {} }
      export class TFile {}
      export const Platform = {isMobile:false};
      export const normalizePath = p=>p;
      export const requestUrl = async()=>{throw new Error('Unexpected external request');};
    `, loader: 'js' }));
  }}],
});
const { AttachmentSyncService } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const settingsBundle = await build({entryPoints:[fileURLToPath(new URL('src/services/attachment-sync/settings.ts',root))],bundle:true,write:false,format:'esm',platform:'node',logLevel:'silent'});
const {normalizeAttachmentSyncSettings} = await import(`data:text/javascript;base64,${Buffer.from(settingsBundle.outputFiles[0].text).toString('base64')}`);
const noResults = () => ({uploaded:0,downloaded:0,deleted:0,retired:0,pending:0});
const deferred = () => { let resolve; const promise=new Promise(r=>resolve=r); return {promise,resolve}; };

function fixture(enabled=true) {
  const timers=new Map(); let nextTimer=1; const events=[]; const off=[];
  globalThis.window={setTimeout:fn=>{const id=nextTimer++;timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id),setInterval:fn=>{const id=nextTimer++;timers.set(id,fn);return id;},clearInterval:id=>timers.delete(id),addEventListener(){},removeEventListener(){}};
  globalThis.document={hidden:false,addEventListener(){},removeEventListener(){}};
  const settings=normalizeAttachmentSyncSettings({schema:1,enabled,collectionId:'fixture-collection'});
  const app={vault:{on:(name,fn)=>{events.push({name,fn});return {name};},offref:ref=>off.push(ref),adapter:{}},workspace:{onLayoutReady:fn=>fn()}};
  const service=new AttachmentSyncService(app,()=>settings,()=>({}));
  const preferences=new Map();
  const state={getPreference:async key=>preferences.get(key)??null,setPreference:async(key,value)=>preferences.set(key,value)};
  service.stateStore=()=>state;
  let contexts=0; let stopped=0; let runs=0;
  service.context=async(generation)=>{contexts++;const engine={run:async()=>{runs++;return noResults();},stop:()=>stopped++};service.engine=engine;return {identity:JSON.stringify(['gcs',settings.endpoint,settings.bucket,settings.prefix,settings.collectionId]),check:()=>service.assertCurrent(generation,JSON.stringify(['gcs',settings.endpoint,settings.bucket,settings.prefix,settings.collectionId])),engine,state,remote:{getBucketPolicy:async()=>({warnings:[]})}};};
  return {service,settings,preferences,state,events,off,timers,stats:()=>({contexts,stopped,runs})};
}

test('legacy connection migration copies references but never enrolls or enables offloading',()=>{
  const next=normalizeAttachmentSyncSettings(undefined,{enabled:true,endpoint:'https://storage.googleapis.com',bucket:'fixture',folder:'old',accessKeySecretName:'access-reference',secretKeySecretName:'secret-reference',archiveUploadedSources:true});
  assert.equal(next.enabled,false);assert.equal(next.bucket,'fixture');assert.equal(next.prefix,'old/tps-attachment-sync');
  assert.equal(next.accessKeySecretName,'access-reference');assert.equal(next.collectionId,'');
  assert.equal('archiveUploadedSources' in next,false);assert.equal('accessKey' in next,false);
});
test('disabled lifecycle installs no listeners and makes no connection',async()=>{
  const f=fixture(false);f.service.start();await f.service.runNow(false);
  assert.equal(f.events.length,0);assert.equal(f.stats().contexts,0);assert.equal(f.service.getStatus().phase,'disabled');
});
test('shared enabled settings cannot enroll an unconfigured device or contact cloud',async()=>{
  const f=fixture();f.service.start();await f.service.runNow(false);
  assert.equal(f.stats().contexts,0);assert.equal(f.service.getStatus().phase,'not-enrolled');f.service.stop();
});
test('explicit enrollment stores participation only after successful synchronization',async()=>{
  const f=fixture();await f.service.enroll('join');assert.equal(f.preferences.get('participation'),true);assert.equal(f.stats().runs,1);
  await f.service.runNow(false);assert.equal(f.stats().runs,2);assert.equal(f.service.getStatus().phase,'idle');
});
test('failed enrollment never enables participation',async()=>{
  const f=fixture();f.service.context=async()=>({engine:{run:async()=>{throw new Error('Wrong recovery key');}},state:f.state});
  await assert.rejects(f.service.enroll('join'),/Wrong recovery key/);assert.equal(f.preferences.has('participation'),false);assert.equal(f.service.getStatus().phase,'error');
});
test('configuration change invalidates an active result before enrollment is saved',async()=>{
  const f=fixture();const gate=deferred();f.service.context=async(generation)=>{const identity=JSON.stringify(['gcs',f.settings.endpoint,f.settings.bucket,f.settings.prefix,f.settings.collectionId]);return {identity,check:()=>f.service.assertCurrent(generation,identity),engine:{run:()=>gate.promise},state:f.state};};
  const pending=f.service.enroll('join');await new Promise(r=>setImmediate(r));f.settings.bucket='another-bucket';gate.resolve(noResults());
  await assert.rejects(pending,/configuration changed/);assert.equal(f.preferences.has('participation'),false);
});
test('new explicit action waits for current work instead of silently joining a different action',async()=>{
  const f=fixture();const gate=deferred();const order=[];
  const first=f.service.exclusive(async()=>{order.push('first');await gate.promise;});
  const second=f.service.exclusive(async()=>{order.push('second');return 'result';});
  await new Promise(r=>setImmediate(r));assert.deepEqual(order,['first']);gate.resolve();await first;assert.equal(await second,'result');assert.deepEqual(order,['first','second']);
});
test('scheduling ignores native/internal edits and handles attachment rename away from scope',()=>{
  const f=fixture();f.service.start();f.timers.clear();
  const modify=f.events.find(e=>e.name==='modify').fn;
  for(const path of ['Note.md','Canvas.canvas','.obsidian/plugins/controller/data.json','Plugin Development/code.ts'])modify({path});
  assert.equal(f.timers.size,0);modify({path:'Attachments/sound.wav'});assert.equal(f.timers.size,1);
  f.timers.clear();f.events.find(e=>e.name==='rename').fn({path:'.trash/sound.wav'},'Attachments/sound.wav');assert.equal(f.timers.size,1);
  f.service.stop();assert.equal(f.timers.size,0);assert.equal(f.off.length,4);
});
test('settings retain route accessibility and expose only the replacement workflow',()=>{
  const ui=readFileSync(new URL('src/services/attachment-sync/settings-ui.ts',root),'utf8');
  const tab=readFileSync(new URL('src/settings-tab.ts',root),'utf8');
  const css=readFileSync(new URL('styles-ui.css',root),'utf8');
  for(const label of ['Sync now','This device','GCS endpoint','Bucket','Recovery key','Excluded paths','Legacy attachments','Large-file diagnostic'])assert.ok(ui.includes(label),label);
  assert.equal((ui.match(/createEl\("details"\)/g)||[]).length,1);
  assert.match(tab,/label: 'Sync attachments'/);assert.match(tab,/aria-pressed/);
  assert.match(css,/tps-controller-attachment-sync-settings button:focus-visible/);assert.match(css,/@media \(max-width: 600px\)/);
  assert.doesNotMatch(tab,/Make Uploaded Objects Public|Run on Paste|Run S3 Upload Now/);
});


test('real context forwards resumable stages and fences master switch, references, exclusions and secret values', async()=>{
  const f=fixture();
  const secrets=new Map([[f.settings.accessKeySecretName,'fixture-access'],[f.settings.secretKeySecretName,'fixture-secret'],[f.settings.recoveryKeySecretName,'tps-attachments-v1:'+Buffer.alloc(32,7).toString('base64url')]]);
  f.settings.bucket='fixture-bucket';
  f.service.app.secretStorage={getSecret:key=>secrets.get(key)||null};
  const realContext=AttachmentSyncService.prototype.context.bind(f.service);
  const context=await realContext(f.service.generation);
  context.local.stageSize=async id=>id==='stage-a'?8388608:0;
  context.local.readStageChunk=async(id,offset,length)=>new Uint8Array([offset,length]);
  assert.equal(await context.engine.local.stageSize('stage-a'),8388608);
  assert.deepEqual([...await context.engine.local.readStageChunk('stage-a',3,2)],[3,2]);
  for(const [field,value] of [['enabled',false],['accessKeySecretName','new-access'],['secretKeySecretName','new-secret'],['recoveryKeySecretName','new-recovery'],['excludedPaths',['private']]]){
    const previous=f.settings[field];f.settings[field]=value;
    assert.throws(context.check,/configuration changed/,field);f.settings[field]=previous;context.check();
  }
  secrets.set(f.settings.recoveryKeySecretName,'changed');assert.throws(context.check,/key changed/);
});

test('pause cannot change enrollment in a newly selected collection',async()=>{
  const f=fixture();const gate=deferred();
  const active=f.service.exclusive(()=>gate.promise);
  await new Promise(r=>setImmediate(r));
  const paused=f.service.pauseDevice();f.settings.collectionId='another-collection';gate.resolve();await active;
  await assert.rejects(paused,/configuration changed/);assert.equal(f.preferences.has('participation'),false);
});

test('a stale participation read cannot overwrite the stopped status',async()=>{
  const f=fixture();const gate=deferred();f.state.getPreference=()=>gate.promise;
  const pending=f.service.runNow(false);await new Promise(r=>setImmediate(r));f.service.stop();
  f.service.update({phase:'paused',message:'paused'});gate.resolve(false);
  await assert.rejects(pending,/configuration changed/);assert.equal(f.service.getStatus().phase,'paused');assert.equal(f.stats().contexts,0);
});

test('real state store reuses handles for the current vault and closes on stop',async()=>{
  const f=fixture();f.service.app.vault.adapter.getBasePath=()=>'/fixture/test-vault';
  delete f.service.stateStore;
  const first=f.service.stateStore();assert.equal(f.service.stateStore(),first);
  let closed=0;first.close=async()=>closed++;
  f.service.stop();await new Promise(r=>setImmediate(r));assert.equal(closed,1);
  assert.notEqual(f.service.stateStore(),first);f.service.stop();
});

test('unknown schema or provider pauses only attachment lifecycle',()=>{
  for(const field of ['schema','provider']){const f=fixture();f.settings[field]=field==='schema'?2:'other-provider';f.service.start();assert.equal(f.service.getStatus().phase,'error');assert.equal(f.events.length,0);}
  assert.throws(()=>normalizeAttachmentSyncSettings({provider:'unknown'}),/newer Controller/);
});
