
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import ts from 'typescript';
const readSource=path=>process.env.TPS_STARTUP_BASELINE_REF
  ? execFileSync('git',['show',`${process.env.TPS_STARTUP_BASELINE_REF}:${path}`],{encoding:'utf8'})
  :readFileSync(new URL(`../${path}`,import.meta.url),'utf8');
const main=readSource('src/main.ts');
const settingsPersistence={exports:{}};
new Function('module','exports',ts.transpileModule(readSource('src/services/settings-persistence.ts'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText)(settingsPersistence,settingsPersistence.exports);
class TFile {constructor(path){this.path=path;}}
const Platform={isMobile:false};
const logger={flow(){},flowWarn(){},flowError(){},setLoggingEnabled(){},timeAsync:(_a,_b,_c,run)=>run()};
const events={CONTROLLER_SETTINGS_CHANGED:'settings-changed'};
function owner(names,bindings={}){
  const ast=ts.createSourceFile('main.ts',main,ts.ScriptTarget.Latest,true);
  const klass=ast.statements.find(n=>ts.isClassDeclaration(n)&&n.name?.text==='TPSControllerPlugin');
  const methods=names.map(name=>{const n=klass.members.find(n=>ts.isMethodDeclaration(n)&&n.name.getText(ast)===name);assert.ok(n,`actual ${name}`);return n.getText(ast);});
  const js=ts.transpileModule(`class Owner {${methods.join('\n')}}`,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
  return new Function('logger','TPS_EVENTS','Platform','TFile','mergeSettingsChangeSet',...Object.keys(bindings),`${js};return Owner;`)(logger,events,Platform,TFile,settingsPersistence.exports.mergeSettingsChangeSet,...Object.values(bindings));
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
  assert.deepEqual(counts,{reads:1,writes:1,events:1,refresh:0});
});



test('shutdown invalidates API before requested settings saves drain',async()=>{
 const Owner=owner(['onunload']);let release;const held=new Promise(r=>release=r),calls=[];
 const oldWindow=globalThis.window;globalThis.window={TPS:{}};
 const h=Object.assign(new Owner(),{api:{},settingsSaveQueue:{waitForIdle(){calls.push('drain');return held;}}});
 for(const name of ['financeRelay','tishOSCommandBridgeService','calendarAutomation','attachmentSyncService'])Object.defineProperty(h,name,{get(){throw new Error('retired owner '+name);}});
 try{const pending=h.onunload();assert.equal(h.unloading,true);assert.equal(h.api,undefined);assert.equal(globalThis.window.TPS,undefined);assert.deepEqual(calls,['drain']);release();await pending;}finally{globalThis.window=oldWindow;}
});

test('retired parent maintenance has no startup, bootstrap, recurring, or hidden delayed dispatch',()=>{
  for(const name of ['runParentChildMaintenanceTick','parentChildBootstrapIntervalId','scheduleParentChildStartupAfterMetadataReadiness','startParentChildMaintenanceLoop'])assert.equal(main.includes(name),false,name);
  assert.equal(main.includes('runRecurrenceMaintenanceTick'), false, 'recurrence recovery is retired');
});


test('missing attachment configuration stays inert without startup migrations or saves',async()=>{
  const attachment={exports:{}};
  new Function('module','exports',ts.transpileModule(readSource('src/services/attachment-sync/settings.ts'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText)(attachment,attachment.exports);
  const defaults={attachmentSync:attachment.exports.DEFAULT_ATTACHMENT_SYNC_SETTINGS,notificationDeliveryProvider:'tishos',
    _migratedFromPlugins:true,enableLogging:false,externalCalendars:[],alertState:{},noteRules:[],s3agleAttachmentAutomation:{enabled:false,archiveUnreferencedBucketObjects:false}};
  const Owner=owner(['loadSettings','getChangedSettingKeys'],{
    DEFAULT_CONTROLLER_SETTINGS:defaults,normalizeReminderSettingsInPlace:r=>r});
  let persisted={...defaults};delete persisted.attachmentSync;
  const saves=[];
  const oldWindow=globalThis.window;globalThis.window={localStorage:{getItem:()=> 'controller'}};
  const h=Object.assign(new Owner(),{app:{vault:{getName:()=> 'Obsidian Plugin Test Vault'}},
    async loadData(){return structuredClone(persisted);},cleanLegacySettings(){},snapshotSettingsForDiff(){return structuredClone(this.settings);},
    loadAlertStateFromLocalStorage:()=>({}),hasAlertStateEntries:()=>false,sanitizeFrontmatterKeySettings(){},sanitizeTwoStageArchiveSettings(){},
    summarizeSettingsForLog:()=>({}),async saveSettings(){const keys=this.getChangedSettingKeys();saves.push(keys);for(const key of keys)persisted[key]=structuredClone(this.settings[key]);}});
  try{await h.loadSettings();assert.deepEqual(saves,[]);
    for(let n=0;n<10;n++)await h.loadSettings();assert.equal(saves.length,0);assert.equal(persisted.attachmentSync,undefined);
    const oldState={attachmentSync:{schema:99,enabled:true,bucket:'fixture',recoveryKeySecretName:'existing-reference'},s3agleAttachmentAutomation:{enabled:true,archiveUnreferencedBucketObjects:true,legacyCredential:'synthetic-preserved-value'}};
    Object.assign(persisted,structuredClone(oldState));
    h.app.secretStorage=new Proxy({}, {get(){assert.fail('Retired migration must not access credentials');}});
    for(let n=0;n<10;n++)await h.loadSettings();
    assert.equal(saves.length,0);
    for(const key of Object.keys(oldState)){assert.deepEqual(h.settings[key],oldState[key]);assert.deepEqual(persisted[key],oldState[key]);}
  }finally{globalThis.window=oldWindow;}
});

function actualVaultListeners() {
  const ast=ts.createSourceFile('main.ts',main,ts.ScriptTarget.Latest,true);
  const listeners=new Map();
  function visit(node) {
    if(ts.isCallExpression(node)&&node.expression.getText(ast)==='this.app.vault.on'
      &&ts.isStringLiteral(node.arguments[0])&&['create','modify','delete','rename'].includes(node.arguments[0].text)) {
      const code=`function listenerOwner(file: unknown, oldPath?: string) { const listener = ${node.arguments[1].getText(ast)}; return listener(file, oldPath); }`;
      const compiled=ts.transpileModule(code,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
      listeners.set(node.arguments[0].text,new Function(`${compiled}; return listenerOwner;`)());
    }
    ts.forEachChild(node,visit);
  }
  visit(ast);
  assert.deepEqual([...listeners.keys()].sort(),['create','delete','modify','rename']);
  return listeners;
}

test('retired startup migrations neither save nor inspect other plugins, local storage or vault state',async()=>{
 const defaults={enableLogging:false,reminders:[]};
 const Owner=owner(['loadSettings'],{DEFAULT_CONTROLLER_SETTINGS:defaults,normalizeReminderSettingsInPlace:r=>r});
 const samples=[null,{}, {_migratedFromPlugins:false,externalCalendars:[{url:'https://example.invalid/feed',autoCreateMode:'task',autoCreateTag:'old'}],notificationDeliveryProvider:'legacy',enableLocalReminderNoticesOnUserDevices:true,inlineTaskReminders:'both',autoCreateConfigs:[{old:true}],nativeCalendarCancellationState:{keep:'unchanged'}}];
 for(const sample of samples){
  let reads=0;const expected=structuredClone(sample);
  const h=Object.assign(new Owner(),{app:new Proxy({}, {get(){assert.fail('Startup must not inspect another owner');}}),
   async loadData(){reads++;return structuredClone(sample);},async saveSettings(){assert.fail('No startup saves');},
   sanitizeFrontmatterKeySettings(){},sanitizeTwoStageArchiveSettings(){},
   snapshotSettingsForDiff(){return structuredClone(this.settings);},summarizeSettingsForLog:()=>({})});
  for(let n=0;n<20;n++)await h.loadSettings();
  assert.equal(reads,20);assert.deepEqual(sample,expected);
  for(const key of Object.keys(sample||{})){if(key==='inlineTaskReminders')assert.equal(Object.hasOwn(h.settings,key),false);else assert.deepEqual(h.settings[key],expected[key]);}
 }
 assert.doesNotMatch(main,/migrateSettingsFromPlugins|migrateCalendarTagRules|countExternalCalendarsMissingId|notificationProviderMigrationChanged|cleanLegacySettings/);
});

test('unload during settings initialization prevents all later owner registration', async () => {
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  let registrations = 0;
  const Owner = owner(['onload', 'onunload'], {
    NoteRuleRunner: class { constructor() { registrations++; throw new Error('Late owner registered'); } },
  });
  const oldWindow = globalThis.window;
  globalThis.window = { TPS: {} };
  const h = Object.assign(new Owner(), {
    manifest: { id: 'tps-controller', version: 'test' },
    unloading: false,
    loadSettings: () => waiting,
    settingsSaveQueue: { waitForIdle: async () => {} },
  });
  try {
    const starting = h.onload();
    await h.onunload();
    release();
    await starting;
    assert.equal(registrations, 0);
    assert.equal(h.api, undefined);
  } finally { globalThis.window = oldWindow; }
});


test('retired automatic options are omitted without changing current preferences, credentials or execution state',()=>{
 const retired=['syncIntervalMinutes','calendarImportHorizonDays','missingEventStatusValue','inlineTaskReminders','enableTimeTrackingHourlyReminders','batchNotifications','previousStatusKey','noLossSyncMode','syncOnEventDelete'];
 const stored={...Object.fromEntries(retired.map(key=>[key,'unused'])),alertState:{existing:{lastAt:123}},_migratedFromPlugins:true,nativeCalendarCancellationState:{record:{pendingApplication:true}},attachmentSync:{enabled:true,recoveryKeySecretName:'existing-reference'},extensionOwned:{future:true},enableLogging:false};
 const original=structuredClone(stored);
 const merged=settingsPersistence.exports.mergeSettingsChangeSet(stored,{enableLogging:true},['enableLogging']);
 for(const key of retired)assert.equal(Object.hasOwn(merged,key),false,key);
 assert.equal(merged.enableLogging,true);
 for(const key of ['alertState','_migratedFromPlugins','nativeCalendarCancellationState','attachmentSync','extensionOwned'])assert.deepEqual(merged[key],stored[key],key);
 assert.deepEqual(stored,original,'normalization cannot mutate the source object');
});
