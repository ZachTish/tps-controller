import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
globalThis.crypto ||= webcrypto;
async function load(file) {
  const built = await build({ entryPoints:[file], bundle:true, write:false, platform:'node', format:'esm', logLevel:'silent', plugins:[{
    name:'obsidian', setup(b) {
      b.onResolve({filter:/^obsidian$/},()=>({path:'obsidian',namespace:'stub'}));
      b.onLoad({filter:/.*/,namespace:'stub'},()=>({loader:'js',resolveDir:process.cwd(),contents:`import {load,dump} from 'js-yaml'; export const parseYaml=load;export const stringifyYaml=dump;export class App{};export class TFile{ static [Symbol.hasInstance](v){return v?.extension==='md';}};export const normalizePath=v=>v;`}));
    }
  }]});
  return import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
}
const rules = await load('src/services/note-rules.ts');
const { NoteRuleRunner, parseRuleNote, writeRuleNote, isRuleNotePath } = await load('src/services/note-rule-runner.ts');
const condition=(field='property:type',operator='equals',value='event')=>({field,operator,value});
const action=(kind='title',value='123',key='')=>({kind,value,key});
const rule=(overrides={})=>({id:'one',name:'Rename event',enabled:true,match:'all',conditions:[condition(),condition('name','contains','xyz')],actions:[action()],stop:false,...overrides});
const config=(list=[rule()])=>({version:1,rules:list});
const input=(overrides={})=>({name:'XYZ event',path:'Inbox/XYZ event.md',title:'XYZ event',calendar:'work',properties:{type:'event',tpsId:'stable',tags:['keep']},protectedKeys:['customIdentity'],...overrides});
function evaluate(r=rule(),i=input()){return rules.createNoteRuleSession(config([r])).evaluate(i);}

test('example requires both type and name and never alters input or identity',()=>{
  const original=input(), snapshot=structuredClone(original), result=evaluate(rule(),original);
  assert.equal(result.title,'123');assert.equal(result.rename,true);assert.deepEqual(original,snapshot);
  assert.equal(evaluate(rule(),input({name:'other'})).matched.length,0);
  assert.equal(evaluate(rule(),input({properties:{type:'transaction'}})).matched.length,0);
});
test('any, missing fields, lists, booleans and numeric comparisons',()=>{
  assert.equal(evaluate(rule({match:'any'}),input({name:'other'})).matched.length,1);
  for(const op of ['not-equals','not-contains','greater','less']) assert.equal(evaluate(rule({conditions:[condition('missing',op,'3')]})).matched.length,0);
  for(const [field,op,value] of [['list','equals','two'],['bool','equals','false'],['amount','less','0'],['empty','missing','']]) {
    assert.equal(evaluate(rule({conditions:[condition(field,op,value)]}),input({properties:{list:['one','Two'],bool:false,amount:-12}})).matched.length,1);
  }
  assert.equal(evaluate(rule({conditions:[condition('amount','greater','1')]}),input({properties:{amount:'n/a'}})).matched.length,0);
});
test('conditions use original note, action ordering and stop are deterministic',()=>{
  const first=rule({actions:[action('title','Changed'),action('set-property','new','type')]});
  const second=rule({id:'two',actions:[action('title','Final')]});
  const session=rules.createNoteRuleSession(config([first,second]));first.actions[0].value='mutated';
  assert.equal(session.evaluate(input()).title,'Final');
  first.stop=true;assert.equal(rules.createNoteRuleSession(config([first,second])).evaluate(input()).title,'mutated');
});
test('replace text, tag deduplication, removals and typed custom values',()=>{
  const result=evaluate(rule({actions:[action('replace-title','ABC','XYZ'),action('add-tag','#Keep'),action('add-tag','food/healthy'),action('remove-tag','keep'),action('set-property','3','Score'),action('remove-property','','score'),action('set-property','["a","b"]','SCORE')]}));
  assert.equal(result.title,'ABC event');assert.deepEqual(result.updates.tags,['food/healthy']);
  assert.deepEqual(result.updates.Score,['a','b']);assert.deepEqual(result.removals,[]);
  const after=rules.applyNoteRuleResult(input().properties,result,'Title');assert.equal(after.Title,'ABC event');assert.equal(after.tpsId,'stable');
});
test('disabled drafts, unsupported schema and invalid values fail safely',()=>{
  assert.doesNotThrow(()=>rules.validateNoteRules(config([rule({enabled:false,actions:[]})])));
  for(const c of [{version:2,rules:[]},config([rule({conditions:[]})]),config([rule({actions:[]})]),config([rule({actions:[action('set-property','{}','custom')]})]),config([rule({conditions:[condition('amount','greater','no')]})])]) assert.throws(()=>rules.validateNoteRules(c));
});
test('IDs and configured identity keys cannot be changed',()=>{
  for(const key of ['tpsId','financeId','ExternalId','__proto__','constructor']) assert.throws(()=>evaluate(rule({actions:[action('set-property','bad',key)]})));
  assert.throws(()=>evaluate(rule({actions:[action('set-property','bad','customIdentity')]})));
});
test('unsafe or empty generated filenames are rejected',()=>{
  for(const title of ['../note','a/b','CON','ends.','bad\nname','']) assert.throws(()=>evaluate(rule({actions:[action('title',title)]})));
  assert.throws(()=>evaluate(rule({actions:[action('replace-title','','XYZ event')]})));
});
test('old calendar tag becomes an explicit command rule once',()=>{
  const migrated=rules.migrateCalendarTagRules(undefined,[{id:'work',autoCreateTag:'#team'}]);
  assert.equal(migrated.rules.length,1);assert.equal(migrated.rules[0].conditions[0].field,'calendar');
  assert.deepEqual(rules.migrateCalendarTagRules(migrated,[{id:'work',autoCreateTag:'#changed'}]),migrated);
  assert.deepEqual(rules.createNoteRuleSession(migrated).evaluate(input()).updates.tags,['keep','team']);
  assert.deepEqual(rules.createNoteRuleSession(migrated).evaluate(input({calendar:''})).matched,[]);
});
test('frontmatter parsing preserves body, BOM, CRLF and empty/no frontmatter',()=>{
  for(const original of ['Body\n','---\n---\nBody','\ufeff---\r\ntype: event\r\n---\r\n\r\n# Body\r\n']) {
    const parsed=parseRuleNote(original),written=writeRuleNote(original,{...parsed.properties,tags:['new']});
    assert.equal(parseRuleNote(written).body,parsed.body);assert.equal(parseRuleNote(written).bom,parsed.bom);assert.equal(parseRuleNote(written).eol,parsed.eol);
  }
  for(const invalid of ['---\ntitle: broken','---\n- array\n---\n','---\nTitle: A\ntitle: B\n---\n']) assert.throws(()=>parseRuleNote(invalid));
});
test('internal/development/archive paths excluded',()=>{
  for(const path of ['.obsidian/data.md','Plugin Development/src.md','_archive/note.md','folder/node_modules/x.md','../out.md']) assert.equal(isRuleNotePath(path),false);
  assert.equal(isRuleNotePath('Inbox/note.md'),true);
});
function harness(initial={'Inbox/XYZ event.md':'---\ntype: event\ntpsId: stable\ntags: [keep]\n---\nKeep body\n'},settings=config()) {
  const files=new Map(),contents=new Map(),writes=[],renames=[];
  const seed=(path,content)=>{files.set(path,{path,basename:path.split('/').pop().replace(/\.md$/,''),extension:'md',stat:{size:content.length}});contents.set(path,content);};
  for(const [path,content] of Object.entries(initial))seed(path,content);
  const state={noteRules:settings,titleKey:'title',eventIdKey:'externalEventId',uidKey:'calendarUid',externalCalendars:[]};
  let readHook=null,processHook=null,renameHook=null;
  const app={plugins:{plugins:{}},vault:{
    getMarkdownFiles:()=>[...files.values()],getAllLoadedFiles:()=>[...files.values()],getAbstractFileByPath:path=>files.get(path),
    read:async file=>{await readHook?.(file);return contents.get(file.path);},
    process:async(file,fn)=>{await processHook?.(file);const value=fn(contents.get(file.path));contents.set(file.path,value);writes.push(file.path);},
  },fileManager:{renameFile:async(file,path)=>{await renameHook?.(file,path);if(files.has(path))throw Error('occupied');const content=contents.get(file.path);files.delete(file.path);contents.delete(file.path);renames.push([file.path,path]);file.path=path;file.basename=path.split('/').pop().replace(/\.md$/,'');files.set(path,file);contents.set(path,content);}}};
  const runner=new NoteRuleRunner(app,()=>state);
  return {runner,app,state,seed,files,contents,writes,renames,readHook:fn=>readHook=fn,processHook:fn=>processHook=fn,renameHook:fn=>renameHook=fn};
}
const preview=h=>h.runner.preview({kind:'vault'});
const apply=(h,plan)=>h.runner.apply(plan,new Set(plan.changes.map(change=>change.path)));
test('preview is read-only; apply renames and preserves body and identity',async()=>{
  const h=harness(),plan=await preview(h);assert.equal(plan.changes.length,1);assert.equal(h.writes.length,0);
  const result=await apply(h,plan);assert.deepEqual(result.applied,['Inbox/123.md']);assert.equal(result.failed.length,0);
  assert.equal(parseRuleNote(h.contents.get('Inbox/123.md')).properties.tpsId,'stable');assert.equal(parseRuleNote(h.contents.get('Inbox/123.md')).body,'Keep body\n');
  assert.equal((await preview(h)).changes.length,0);await assert.rejects(()=>apply(h,plan),/expired/);
});
test('selection and folder boundaries; nonmatching/manual content untouched',async()=>{
  const h=harness();h.seed('Inbox/XYZ second.md','---\ntype: event\n---\n');h.seed('InboxElse/XYZ third.md','---\ntype: event\n---\n');
  const plan=await h.runner.preview({kind:'folder',path:'Inbox'});assert.equal(plan.scanned,2);
  await h.runner.apply(plan,new Set(['Inbox/XYZ event.md']));assert.ok(h.files.has('Inbox/XYZ second.md'));assert.ok(h.files.has('InboxElse/XYZ third.md'));
});
test('one changed note rejects all selected writes at preflight',async()=>{
  const h=harness();h.seed('Inbox/XYZ second.md','---\ntype: event\n---\n');
  h.state.noteRules=config([rule({actions:[action('add-tag','new')]})]);
  const plan=await preview(h);h.contents.set('Inbox/XYZ second.md','Changed elsewhere');
  await assert.rejects(()=>apply(h,plan),/changed since preview/);assert.equal(h.writes.length,0);
});
test('rules changed or plan tampered after preview is rejected',async()=>{
  const h=harness(),plan=await preview(h);plan.changes[0].nextPath='Elsewhere.md';await assert.rejects(()=>apply(h,plan),/expired/);
  const next=await preview(h);h.state.noteRules.rules[0].actions[0].value='other';await assert.rejects(()=>apply(h,next),/expired/);assert.equal(h.writes.length,0);
});
test('existing and competing destination collisions block before writes',async()=>{
  for(const path of ['Inbox/123.md','Inbox/123.MD','Inbox/XYZ another.md']){
    const h=harness();h.seed(path,'---\ntype: event\n---\n');const plan=await preview(h);
    assert.ok(plan.changes.some(change=>change.error));await assert.rejects(()=>apply(h,plan));assert.equal(h.writes.length,0);
  }
});
test('mutation-boundary race reports failure without overwriting',async()=>{
  const h=harness(),plan=await preview(h);h.processHook(file=>h.contents.set(file.path,'User edit'));
  const result=await apply(h,plan);assert.equal(result.applied.length,0);assert.equal(result.failed.length,1);assert.equal(h.contents.get('Inbox/XYZ event.md'),'User edit');assert.equal(h.renames.length,0);
});
test('rename failure reports saved properties and a new preview can complete it',async()=>{
  const h=harness();h.state.noteRules=config([rule({conditions:[condition()],actions:[action()]})]);
  const plan=await preview(h);h.renameHook(()=>{throw Error('Disk failure');});const result=await apply(h,plan);
  assert.match(result.failed[0].reason,/Properties saved; rename unfinished/);assert.equal(parseRuleNote(h.contents.get('Inbox/XYZ event.md')).properties.title,'123');
  h.renameHook(null);const retry=await preview(h);assert.equal((await apply(h,retry)).applied.length,1);
});
test('protected templates, corrupt notes and oversized notes are reported',async()=>{
  const h=harness();h.app.plugins.plugins['tps-global-context-menu']={api:{templates:{version:1,canAutomaticallyMutate:async()=>false}}};
  let plan=await preview(h);assert.equal(plan.changes.length,0);assert.match(plan.skipped[0].reason,/Protected/);
  delete h.app.plugins.plugins['tps-global-context-menu'];h.contents.set('Inbox/XYZ event.md','---\nbroken');plan=await preview(h);assert.equal(plan.skipped.length,1);
  h.files.get('Inbox/XYZ event.md').stat.size=3*1024*1024;plan=await preview(h);assert.match(plan.skipped[0].reason,/larger/);
});
test('single active run and unload guard',async()=>{
  const h=harness();let release;h.readHook(()=>new Promise(resolve=>release=resolve));const first=preview(h);
  await new Promise(resolve=>setTimeout(resolve,0));await assert.rejects(()=>preview(h),/running/);release();await first;
  h.runner.dispose();await assert.rejects(()=>preview(h),/reloaded/);
});
test('calendar source migration resolves canonical ID and preserves unrelated notes',async()=>{
  const identity=await load('src/services/calendar-record-identity.ts');const id=await identity.deriveCalendarRecordId('work','event');
  const h=harness({'Calendar.md':`---\ntpsId: ${id}\n---\n`},rules.migrateCalendarTagRules(undefined,[{id:'work',autoCreateTag:'team'}]));h.state.externalCalendars=[{id:'work',url:'https://example.test/feed'}];
  const plan=await preview(h);assert.equal(plan.changes.length,1);assert.deepEqual(plan.changes[0].after.tags,['team']);
});
test('settings/actions inventory and command-only wiring',()=>{
  const settings=readFileSync('src/settings-tab.ts','utf8'), main=readFileSync('src/main.ts','utf8'), ui=readFileSync('src/services/note-rule-ui.ts','utf8'),css=readFileSync('styles.css','utf8');
  for(const name of ['Overview','Calendar rules','Note rules','Reminder rules','Automations','Advanced'])assert.ok(settings.includes(`label: '${name}'`));
  assert.doesNotMatch(settings,/setValue\(calendar\.autoCreateTag/);
  assert.ok(main.includes('run-note-rules-current-note'));assert.ok(main.includes('run-note-rules'));
  for(const name of ['Add rule','Save rules','Preview saved rules','Add condition','Add action','Select all','Select none'])assert.ok(ui.includes(name));
  assert.match(ui,/aria-pressed/);assert.match(ui,/aria-live/);assert.match(ui,/type: 'button'/);assert.match(css,/tps-controller-rule-fields[\s\S]*grid-template-columns:minmax/);
  const runner=readFileSync('src/services/note-rule-runner.ts','utf8');assert.doesNotMatch(runner,/\.on\(|setInterval/);
});


test('record identity tags are protected, including configured prefixes', () => {
  for (const [tag,prefixes] of [['tps/record/v1/task/id',[]],['records/v1/task/id',['records']]]) {
    assert.throws(()=>evaluate(rule({actions:[action('remove-tag',tag)]}),input({protectedTagPrefixes:prefixes})),/identity tags/);
  }
});
test('valid multiple legacy tags migrate; invalid legacy drafts are preserved disabled', () => {
  const migrated=rules.migrateCalendarTagRules(undefined,[{id:'work',autoCreateTag:'one, two'},{id:'bad',autoCreateTag:'tag!'}]);
  assert.equal(migrated.rules[0].actions.length,2);assert.equal(migrated.rules[1].enabled,false);
  assert.equal(migrated.rules[1].actions[0].value,'tag!');
});
test('Unicode filenames cannot exceed portable byte limits', () => {
  assert.throws(()=>evaluate(rule({actions:[action('title','界'.repeat(90))]})),/unsafe/);
});
test('changing only tags does not rewrite user title or rename a note', async () => {
  const h=harness(undefined,config([rule({actions:[action('add-tag','new')]})]));
  const plan=await preview(h);assert.equal(plan.changes[0].nextPath,plan.changes[0].path);
  await apply(h,plan);assert.equal(h.renames.length,0);assert.equal(parseRuleNote(h.contents.get('Inbox/XYZ event.md')).properties.title,undefined);
});


test('externally changed saved rules reject preview and application', async () => {
  const h=harness();let saved=structuredClone(h.state.noteRules);
  const runner=new NoteRuleRunner(h.app,()=>h.state,async()=>saved);
  const plan=await runner.preview({kind:'vault'});saved={version:1,rules:[]};
  await assert.rejects(()=>runner.apply(plan,new Set(plan.changes.map(c=>c.path))),/changed on disk/);
  await assert.rejects(()=>runner.preview({kind:'vault'}),/changed on disk/);assert.equal(h.writes.length,0);
});


test('reload between read and mutation rejects the write', async () => {
  const h=harness(),plan=await preview(h);h.processHook(()=>h.runner.dispose());
  const result=await apply(h,plan);assert.equal(result.failed.length,1);assert.equal(h.writes.length,0);assert.equal(h.renames.length,0);
});


test('already present tags do not cause formatting-only writes', async () => {
  const h=harness({'Inbox/XYZ event.md':'---\ntype: event\ntags: [keep]\ntpsId: stable\n---\nBody'},config([rule({actions:[action('add-tag','keep')]})]));
  assert.equal((await preview(h)).changes.length,0);assert.equal(h.writes.length,0);
});
test('numeric zero title is respected instead of falling back to filename', async () => {
  const h=harness({'Inbox/XYZ event.md':'---\ntype: event\ntitle: 0\n---\nBody'},config([rule({conditions:[condition('title','equals','0')],actions:[action('add-tag','zero') ]})]));
  assert.equal((await preview(h)).changes.length,1);
});


test('configured title cannot alias tags or a custom record identity', async () => {
  for (const titleKey of ['recordIdentity', 'TAGS', 'legacyIdentity', 'recordSchema']) {
    const h=harness();h.state.titleKey=titleKey;
    h.app.plugins.plugins['tps-global-context-menu']={settings:{nativeRecordIdentityPropertyKey:'recordIdentity',nativeRecordSchemaPropertyKey:'recordSchema',nativeRecordStorageAliases:[{identityPropertyKey:'legacyIdentity'}]}};
    await assert.rejects(()=>preview(h),/separate from tags and record IDs/);
    assert.equal(h.writes.length,0);assert.equal(h.renames.length,0);
  }
});
