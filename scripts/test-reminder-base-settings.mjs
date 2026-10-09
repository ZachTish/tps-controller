import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { load as parseYaml } from 'js-yaml';

class Element {
  constructor(tag='div', options={}) { this.tag=tag; this.className=options.cls||''; this.textContent=options.text||'';
    this.children=[]; this.dataset={}; this.style={}; this.attributes={}; this.listeners={}; this.value=''; }
  all() { return [this,...this.children.flatMap(child=>child.all())]; }
  createEl(tag,options={}) { const child=new Element(tag,options); child.parentElement=this; this.children.push(child); return child; }
  createDiv(options={}) { return this.createEl('div',options); }
  createSpan(options={}) { return this.createEl('span',options); }
  setAttr(key,value) { this.attributes[key]=value; if(key==='open')this.open=true; }
  addEventListener(key,handler) { (this.listeners[key] ||= []).push(handler); }
  empty() { this.children=[]; }
  querySelectorAll(selector) { const [tag,cls]=selector.split('.'); return this.all().slice(1).filter(e=>(!tag||e.tag===tag)&&(!cls||e.className.split(' ').includes(cls))); }
  querySelector(selector) { return this.querySelectorAll(selector)[0]||null; }
}
class File {
  constructor(path) { this.path=path; this.name=path.split('/').pop(); this.extension=this.name.split('.').pop(); this.basename=this.name.replace(/\.[^.]+$/u,''); }
}
class Control {
  constructor(row,tag) { this.el=row.createEl(tag); this.options={}; this.selectEl=this.el; this.inputEl=this.el; }
  setValue(value) { this.value=value; this.el.value=value; return this; }
  onChange(fn) { this.change=fn; return this; }
  addOption(key,value) { this.options[key]=value; return this; }
  setPlaceholder() { return this; } setButtonText(value) { this.el.textContent=value; return this; }
  setCta() { return this; } setWarning() { return this; } setDisabled(value) { this.disabled=value; return this; }
  onClick(fn) { this.click=fn; return this; }
}
class Setting {
  constructor(parent) { this.row=parent.createDiv({cls:'setting-item'}); this.row.controls=[]; }
  setName(value) { this.row.name=value; return this; } setDesc() { return this; }
  add(callback,tag) { const c=new Control(this.row,tag); this.row.controls.push(c); callback(c); return this; }
  addText(fn) { return this.add(fn,'input'); } addDropdown(fn) { return this.add(fn,'select'); }
  addToggle(fn) { return this.add(fn,'input'); } addButton(fn) { return this.add(fn,'button'); }
}
const obsidian=new Proxy({Setting,TFile:File,parseYaml,normalizePath:path=>path,PluginSettingTab:class {}}, {get:(target,key)=>target[key]||class {}});
const output=await build({entryPoints:[fileURLToPath(new URL('../src/settings-tab.ts',import.meta.url))],bundle:true,write:false,format:'cjs',platform:'node',external:['obsidian'],logLevel:'silent'});
const module={exports:{}}; const require=createRequire(import.meta.url);
new Function('module','exports','require',output.outputFiles[0].text)(module,module.exports,id=>id==='obsidian'?obsidian:require(id));
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function fixture() {
  const tab=Object.create(module.exports.TPSControllerSettingTab.prototype);
  const base=new File('Inbox/Reminders.base'); const note=new File('Inbox/Selected.md'); const counts={reads:0,queries:0,saves:0,refresh:0};
  const app={vault:{getFiles:()=>[base,note],getAbstractFileByPath:path=>[base,note].find(f=>f.path===path),cachedRead:async()=>{counts.reads++;return 'views:\n  - type: table\n    name: Alerts\n';}},
    cli:{handlers:new Map([['base:query',{handler:async()=>{counts.queries++;return note.path;}}]])}};
  const rem={id:'one',enabled:true,property:'scheduled',offsetMinutes:0,repeatUntilComplete:false,repeatIntervalMinutes:5,maxRepeats:-1,stopConditions:[],title:'Reminder',body:'',requiredStatuses:['open'],ignoreStatuses:['complete']};
  tab.app=app; tab.plugin={settings:{reminders:[rem]},saveSettings:async()=>{counts.saves++;},refreshReminderPolicy(){counts.refresh++;},restartReminderLoop(){counts.refresh++;}};
  tab.reminderRuleFilterQuery='';tab.reminderRuleViewState=new Map([[rem.id,true]]); const root=new Element();tab.renderReminderRules(root);
  const row=name=>root.all().find(e=>e.name===name);
  const group=name=>root.all().find(e=>e.textContent===name&&e.tag==='h5')?.parentElement;
  return {tab,rem,root,counts,row,group};
}

test('Base matching controls preserve manual filters and do no query during configuration',async()=>{
  const f=fixture(); const mode=f.row('Choose notes using').controls[0];
  assert.equal(mode.value,'rules');assert.equal(f.row('Base file'),undefined);
  await mode.change('base-view'); assert.equal(f.group('More Filters').style.display,'none');
  assert.deepEqual(f.rem.requiredStatuses,['open']);assert.deepEqual(f.rem.ignoreStatuses,['complete']);
  const picker=f.row('Base file').controls[0];assert.deepEqual(picker.options,{'':'Choose a Base','Inbox/Reminders.base':'Inbox/Reminders.base'});
  assert.equal(picker.selectEl.attributes['aria-label'],'Reminder Base file');
  await picker.change('Inbox/Reminders.base');await flush();
  const view=f.row('Base view').controls[0]; assert.equal(view.options.Alerts,'Alerts');
  assert.equal(view.selectEl.attributes['aria-label'],'Reminder Base view');
  await view.change('Alerts'); assert.equal(f.counts.queries,0);
  await f.row('Check view').controls[0].click();assert.equal(f.counts.queries,1);
  assert.equal(f.root.all().find(e=>e.attributes.role==='status').textContent,'1 matching notes. Notifications use the date/time property below.');
  await mode.change('rules');assert.equal(f.group('More Filters').style.display,'');assert.equal(f.row('Base file'),undefined);
  assert.equal(f.rem.basePath,'Inbox/Reminders.base');assert.equal(f.rem.baseView,'Alerts');
  assert.deepEqual(f.rem.requiredStatuses,['open']);assert.deepEqual(f.rem.ignoreStatuses,['complete']);
});

test('Check view reports missing selection without enabling automation or querying notes',async()=>{
  const f=fixture();await f.row('Choose notes using').controls[0].change('base-view');
  const button=f.row('Check view').controls[0];await button.click();
  assert.match(f.root.all().find(e=>e.attributes.role==='status').textContent,/\.base file path/);
  assert.equal(button.disabled,false);assert.equal(f.counts.queries,0);
});

test('Base path/view labels participate in the existing reminder filter',async()=>{
  const f=fixture();f.rem.selectionMode='base-view';f.rem.basePath='Inbox/Reminders.base';f.rem.baseView='Alerts';
  f.tab.reminderRuleFilterQuery='alerts';f.tab.renderReminderRules(f.root);await flush();
  assert.equal(f.root.querySelectorAll('details.tps-controller-reminder-rule').length,1);
  f.tab.reminderRuleFilterQuery='reminders.base';f.tab.renderReminderRules(f.root);await flush();
  assert.equal(f.root.querySelectorAll('details.tps-controller-reminder-rule').length,1);
});

test('collapsed Base reminders do no picker reads or note queries until opened',async()=>{
  const f=fixture();f.rem.selectionMode='base-view';f.rem.basePath='Inbox/Reminders.base';f.rem.baseView='Alerts';
  f.root.children=[];f.tab.reminderRuleViewState.set(f.rem.id,false);f.tab.renderReminderRules(f.root);await flush();
  assert.equal(f.counts.reads,0);assert.equal(f.counts.queries,0);assert.equal(f.row('Base file'),undefined);
  const detail=f.root.querySelectorAll('details.tps-controller-reminder-rule')[0];detail.open=true;
  for(const fn of detail.listeners.toggle||[])fn();await flush();
  assert.equal(f.counts.reads,1);assert.equal(f.row('Base view').controls[0].value,'Alerts');assert.equal(f.counts.queries,0);
});
