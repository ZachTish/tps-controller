
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import ts from 'typescript';
const readSource=path=>process.env.TPS_STARTUP_BASELINE_REF
  ? execFileSync('git',['show',`${process.env.TPS_STARTUP_BASELINE_REF}:${path}`],{encoding:'utf8'})
  :readFileSync(new URL(`../${path}`,import.meta.url),'utf8');
const main=readSource('src/main.ts');
const contractSource=readSource('src/services/sync-request-contract.ts');
const contract={exports:{}};
new Function('module','exports',ts.transpileModule(contractSource,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText)(contract,contract.exports);
class TFile {constructor(path){this.path=path;}}
const Platform={isMobile:false};
const logger={flow(){},flowWarn(){},flowError(){},setLoggingEnabled(){},timeAsync:(_a,_b,_c,run)=>run()};
const events={CONTROLLER_SETTINGS_CHANGED:'settings-changed'};
const settlement={exports:{}};
new Function('module','exports',ts.transpileModule(readSource('src/services/calendar-sync-settlement-filter.ts'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText)(settlement,settlement.exports);
function owner(names,bindings={}){
  const ast=ts.createSourceFile('main.ts',main,ts.ScriptTarget.Latest,true);
  const klass=ast.statements.find(n=>ts.isClassDeclaration(n)&&n.name?.text==='TPSControllerPlugin');
  const methods=names.map(name=>{const n=klass.members.find(n=>ts.isMethodDeclaration(n)&&n.name.getText(ast)===name);assert.ok(n,`actual ${name}`);return n.getText(ast);});
  const js=ts.transpileModule(`class Owner {${methods.join('\n')}}`,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
  return new Function('logger','TPS_EVENTS','Platform','TFile','executeSyncRequestGeneration','mergeSettingsChangeSet','shouldDeferCalendarSyncSettlementForPath',...Object.keys(bindings),`${js};return Owner;`)(logger,events,Platform,TFile,contract.exports.executeSyncRequestGeneration,(old,next,keys)=>Object.fromEntries([...Object.entries(old),...keys.map(k=>[k,next[k]])]),settlement.exports.shouldDeferCalendarSyncSettlementForPath,...Object.values(bindings));
}

test('unchanged settings save batches perform zero reads/writes/events/notification refreshes',async()=>{
  const Owner=owner(['persistSettingsSnapshot','finishSettingsSaveBatch']);
  const counts={reads:0,writes:0,events:0,refresh:0};
  const h=Object.assign(new Owner(),{manifest:{id:"tps-controller"},settings:{enableLogging:false},uncertainSettingsSaveKeys:new Set(),settingsSaveBatchChanged:false,
    async loadData(){counts.reads++;return {};},async saveData(){counts.writes++;},
    scheduleTishOSNativeNotificationRefresh(){counts.refresh++;},app:{workspace:{trigger(){counts.events++;}}}});
  for(let n=0;n<100;n++){await h.persistSettingsSnapshot({changedKeys:[],comparable:{},persisted:{},summary:{}});h.finishSettingsSaveBatch();}
  assert.deepEqual(counts,{reads:0,writes:0,events:0,refresh:0});
  await h.persistSettingsSnapshot({changedKeys:['enableLogging'],comparable:{enableLogging:true},persisted:{enableLogging:true},summary:{}});
  h.finishSettingsSaveBatch();h.finishSettingsSaveBatch();
  assert.deepEqual(counts,{reads:1,writes:1,events:1,refresh:1});
});

test('deferred calendar sync does not acknowledge the hidden request; ready completion does',async()=>{
  const Owner=owner(['fulfillOneSyncRequest']);let outcome='not-ready';let ack=0;let startup=0;let reads=0;
  const h=Object.assign(new Owner(),{automationRunning:true,automationGeneration:1,deviceRoleManager:{isController:()=>true},
    calendarAutomation:{async fulfillStartupSync(){startup++;},async runSync(){return outcome;}},
    syncRequestService:{async readRequest(){reads++;return {requestId:'one',scope:['calendar']};},async acknowledgeRequest(){ack++;return true;}},runReminderCheck:async()=>{}});
  await h.fulfillOneSyncRequest('controller-startup');assert.equal(ack,0);
  outcome='completed';await h.fulfillOneSyncRequest('poll-interval');assert.equal(ack,1);
  h.automationRunning=false;await h.fulfillOneSyncRequest('poll-interval');assert.equal(reads,2);assert.equal(startup,2);
});

test('shutdown invalidates producers/API before asynchronous finance drain settles',async()=>{
  const Owner=owner(['onunload','scheduleTishOSNativeNotificationRefresh']);let release;const held=new Promise(r=>release=r);const calls=[];
  const oldWindow=globalThis.window;globalThis.window={TPS:{},clearTimeout(){calls.push('clear');},setTimeout(){calls.push('new-timer');return 1;}};
  const h=Object.assign(new Owner(),{api:{},tishOSNotificationRefreshTimeoutId:1,
    financeRelay:{stop(){calls.push('finance');return held;}},calendarAutomation:{stop(){calls.push('calendar');return Promise.resolve();}},
    tishOSCommandBridgeService:{stop(){calls.push('bridge');return Promise.resolve();}},controllerPeriodicReloadService:{dispose(){calls.push('reload');}},
    stopS3agleAttachmentAutomation(){calls.push('attachments');},stopAllAutomation(){calls.push('automation');},
    settingsSaveQueue:{waitForIdle:async()=>{}},flushReminderStateNow:async()=>{},stopReminderStateFlushTimer(){}});
  try{const unload=h.onunload();assert.equal(h.api,undefined);assert.equal(globalThis.window.TPS,undefined);
    for(const action of ['calendar','bridge','reload','attachments','automation'])assert.ok(calls.includes(action),action);
    h.scheduleTishOSNativeNotificationRefresh('post-unload');assert.equal(calls.includes('new-timer'),false);
    release();await unload;
  }finally{globalThis.window=oldWindow;}
});

test('service-state and assets are excluded using configured finance folder, ordinary markdown remains a note source',()=>{
  const Owner=owner(['isNoteSourceFile']);const h=Object.assign(new Owner(),{financeRelay:{getRequestFolder:()=> 'Custom/Finance Relay'}});
  for(const path of ['.tishos/native-notifications/v1/x.json','.obsidian/data.md','Custom/Finance Relay/host/status.md','Custom/Finance Relay/request.md','Inbox/photo.png'])
    assert.equal(h.isNoteSourceFile(new TFile(path)),false,path);
  for(const path of ['Inbox/Reminder.md','Custom/Actual finance note.md','DEV Apigee Credentials.md'])assert.equal(h.isNoteSourceFile(new TFile(path)),true,path);
});

test('retired parent maintenance has no startup, bootstrap, recurring, or hidden delayed dispatch',()=>{
  for(const name of ['runParentChildMaintenanceTick','parentChildBootstrapIntervalId','scheduleParentChildStartupAfterMetadataReadiness','startParentChildMaintenanceLoop'])assert.equal(main.includes(name),false,name);
  assert.ok(main.includes('runRecurrenceMaintenanceTick'),'recurrence recovery is preserved');
});


test('service-only metadata resolution storms do zero notification or settlement work after first readiness',()=>{
  const Owner=owner(['handleMetadataIndexResolved','deferCalendarSyncSettlementForFile','isNoteSourceFile']);
  const counts={refresh:0,settlement:0};
  const h=Object.assign(new Owner(),{metadataIndexResolved:false,pendingNoteMetadataResolution:true,
    tishOSCommandBridgeService:{},financeRelay:{getRequestFolder:()=> 'Custom/Finance Relay'},
    scheduleTishOSNativeNotificationRefresh(){counts.refresh++;},deferCalendarSyncSettlement(){counts.settlement++;}});
  h.handleMetadataIndexResolved();assert.deepEqual(counts,{refresh:1,settlement:1});
  for(let n=0;n<100;n++)h.handleMetadataIndexResolved();assert.deepEqual(counts,{refresh:1,settlement:1});
  h.deferCalendarSyncSettlementForFile(new TFile('Custom/Finance Relay/host/status.md'),'file modify');
  h.handleMetadataIndexResolved();assert.deepEqual(counts,{refresh:1,settlement:1});
  h.deferCalendarSyncSettlementForFile(new TFile('Inbox/Reminder.md'),'file modify');
  h.handleMetadataIndexResolved();assert.deepEqual(counts,{refresh:2,settlement:2});
  h.scheduleTishOSNativeNotificationRefresh=()=>{counts.refresh++;h.deferCalendarSyncSettlementForFile(new TFile('Inbox/Another.md'),'file modify');};
  h.pendingNoteMetadataResolution=true;h.handleMetadataIndexResolved();
  assert.equal(h.pendingNoteMetadataResolution,true,'a reentrant note change is not dropped by consumed resolution');
});


test('missing attachment configuration migrates once instead of re-requesting unchanged startup saves',async()=>{
  const attachment={exports:{}};
  new Function('module','exports',ts.transpileModule(readSource('src/services/attachment-sync/settings.ts'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText)(attachment,attachment.exports);
  const defaults={attachmentSync:attachment.exports.DEFAULT_ATTACHMENT_SYNC_SETTINGS,notificationDeliveryProvider:'tishos',
    _migratedFromPlugins:true,enableLogging:false,externalCalendars:[],alertState:{},noteRules:[],s3agleAttachmentAutomation:{enabled:false,archiveUnreferencedBucketObjects:false}};
  const Owner=owner(['loadSettings','getChangedSettingKeys'],{
    DEFAULT_CONTROLLER_SETTINGS:defaults,countExternalCalendarsMissingId:()=>0,
    resolveNotificationDeliveryProvider:value=>value,normalizeAttachmentSyncSettings:attachment.exports.normalizeAttachmentSyncSettings,
    migrateCalendarTagRules:rules=>rules});
  let persisted={...defaults};delete persisted.attachmentSync;
  const saves=[];
  const oldWindow=globalThis.window;globalThis.window={localStorage:{getItem:()=> 'controller'}};
  const h=Object.assign(new Owner(),{app:{vault:{getName:()=> 'Obsidian Plugin Test Vault'}},
    async loadData(){return structuredClone(persisted);},cleanLegacySettings(){},snapshotSettingsForDiff(){return structuredClone(this.settings);},
    async migrateS3agleSettingsIfNeeded(){return false;},migrateS3CredentialsFromSettings(){return {changed:false};},
    loadAlertStateFromLocalStorage:()=>({}),hasAlertStateEntries:()=>false,sanitizeFrontmatterKeySettings(){},sanitizeTwoStageArchiveSettings(){},sanitizeS3agleAttachmentAutomationSettings(){},
    summarizeSettingsForLog:()=>({}),async saveSettings(){const keys=this.getChangedSettingKeys();saves.push(keys);for(const key of keys)persisted[key]=structuredClone(this.settings[key]);}});
  try{await h.loadSettings();assert.deepEqual(saves,[['attachmentSync']]);
    for(let n=0;n<10;n++)await h.loadSettings();assert.equal(saves.length,1);assert.deepEqual(persisted.attachmentSync,attachment.exports.DEFAULT_ATTACHMENT_SYNC_SETTINGS);
  }finally{globalThis.window=oldWindow;}
});


test('4049 startup note invalidations make zero timers; disabled and unpaired routes stay idle after layout',()=>{
  const Owner=owner(['scheduleTishOSNativeNotificationRefresh']);let ready=false;let paired=true;let starts=0;let cancels=0;let refresh=0;let callback;
  const oldWindow=globalThis.window;globalThis.window={setTimeout(next){starts++;callback=next;return starts;},clearTimeout(){cancels++;}};
  const h=Object.assign(new Owner(),{unloading:false,tishOSNotificationRefreshTimeoutId:null,
    settings:{notificationDeliveryProvider:'tishos',enableReminders:true,reminders:[{enabled:true}]},
    tishOSCommandBridgeService:{canRefreshNativeNotifications:()=>ready&&paired,refreshNativeNotifications(){refresh++;return Promise.resolve();}}});
  try{for(let n=0;n<4049;n++)h.scheduleTishOSNativeNotificationRefresh('file-create');assert.deepEqual({starts,cancels,refresh},{starts:0,cancels:0,refresh:0});
    ready=true;h.settings.reminders=[];for(let n=0;n<100;n++)h.scheduleTishOSNativeNotificationRefresh('metadata-resolved');assert.equal(starts,0);
    h.settings.reminders=[{enabled:true}];paired=false;h.scheduleTishOSNativeNotificationRefresh('file-modify');assert.equal(starts,0);
    paired=true;h.scheduleTishOSNativeNotificationRefresh('file-modify');assert.equal(starts,1);callback();assert.equal(refresh,1);
    h.settings.reminders=[];h.scheduleTishOSNativeNotificationRefresh('settings-save');assert.equal(starts,2,'disabling rules can publish an empty replacement');
  }finally{globalThis.window=oldWindow;}
});
