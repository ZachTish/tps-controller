import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {readFileSync} from 'node:fs';
const output=await build({entryPoints:['src/services/finance-relay-settings.ts'],bundle:true,write:false,format:'cjs',platform:'browser',external:['obsidian']});
function render(mobile,config=null,entryOnly=false){
 const rows=[],titles=[];
 const root={empty(){rows.length=0;},createDiv(){return this;},createEl(tag,opts){titles.push(opts?.text);return this;},querySelector(){return null;}};
 const control=()=>{const item={};for(const name of ['setCta','setValue','setPlaceholder','setDisabled','onChange','addOption'])item[name]=()=>item;item.setButtonText=text=>{item.label=text;return item;};item.onClick=click=>{item.click=click;return item;};return item;};
 class Setting {constructor(){this.row={buttons:[]};rows.push(this.row);}setName(name){this.row.name=name;return this;}setDesc(desc){this.row.desc=desc;return this;}addText(fn){fn(control());return this;}addToggle(fn){this.row.toggle=true;fn(control());return this;}addDropdown(fn){fn(control());return this;}addButton(fn){const c=control();fn(c);this.row.buttons.push(c);return this;}}
 const module={exports:{}};new Function('module','exports','require',output.outputFiles[0].text)(module,module.exports,()=>({Platform:{isMobile:mobile},Setting,Modal:class{},Notice:class{}}));
 const relay={getConfiguration:()=>config,getStatus:()=>({message:'Synthetic status'}),getRequestFolder:()=> '_system/Finance'};
 if(entryOnly) module.exports.renderWalletSetupEntry(root); else module.exports.renderFinanceRelaySettings(root,{},relay,!mobile);
 return {rows,titles};
}
test('unpaired phone presents Wallet before bank pairing without desktop-only controls',()=>{
 const {rows,titles}=render(true);assert.deepEqual(titles,['Bank connections · This device']);
 assert.equal(rows.some(r=>r.name==='Apple Card & Savings'),false);
 assert.ok(rows.some(r=>r.name==='Pair bank connections'));
 for(const name of ['Host on this device','Request files folder','Import Apple Wallet · This device'])assert.equal(rows.some(r=>r.name===name),false);
});
test('desktop retains bank controls, pairing and folder editing; legacy import only exposes Stop',()=>{
 const {rows}=render(false,{mode:'host',enabled:false,intervalMinutes:60,walletEnabled:true});
 for(const name of ['Request files folder','Finance service · This device','Automatic bank refresh · This device','Pair another device'])assert.ok(rows.some(r=>r.name===name),name);
 const old=rows.find(r=>r.name==='Previous Wallet importer');assert.equal(old.buttons[0].label,'Stop old importer');assert.equal(old.toggle,undefined);
 assert.equal(render(false,{mode:'host',enabled:true,intervalMinutes:60,walletEnabled:false}).rows.some(r=>r.name==='Previous Wallet importer'),false);
});
test('paired phone retains bank unpairing and Finances entry',()=>{
 const {rows}=render(true,{mode:'client',enabled:false});
 assert.ok(rows.some(r=>r.buttons.some(b=>b.label==='Update pairing code')));assert.ok(rows.some(r=>r.name==='Remove this device’s pairing'));assert.equal(rows.some(r=>r.name==='Connections and pending requests'),false);
});

test('Overview always presents an actionable Wallet connection before role controls',()=>{
 const source=readFileSync('src/settings-tab.ts','utf8');
 const overview=source.slice(source.indexOf("if (this.activePage === 'overview')"),source.indexOf('const overviewCards'));
 assert.ok(overview.indexOf('renderWalletSetupEntry(containerEl)')>0);
 assert.ok(overview.indexOf('renderWalletSetupEntry(containerEl)')<overview.indexOf('deviceRoleManager'));
 const oldWindow=globalThis.window;
 try {
  for(const mobile of [true,false]){
   const calls=[];
   globalThis.window={location:{assign:url=>calls.push(['mobile',url])},open:url=>calls.push(['desktop',url])};
   const {rows}=render(mobile,null,true);
   assert.equal(rows.length,1);assert.equal(rows[0].buttons[0].label,'Connect Apple Wallet');
   rows[0].buttons[0].click();
   assert.deepEqual(calls,[[mobile?'mobile':'desktop','tishos://settings?section=apple-wallet']]);
  }
 } finally {globalThis.window=oldWindow;}
});
