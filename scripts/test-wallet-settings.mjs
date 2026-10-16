import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {readFileSync,existsSync} from 'node:fs';
const output=await build({entryPoints:['src/services/finance-relay-settings.ts'],bundle:true,write:false,format:'cjs',platform:'browser',external:['obsidian']});
function render(mobile,config=null,entryOnly=false){
 const rows=[],titles=[];
 const root={empty(){rows.length=0;},createDiv(){return this;},createEl(tag,opts){titles.push(opts?.text);return this;},querySelector(){return null;}};
 const control=()=>{const item={};for(const name of ['setCta','setValue','setPlaceholder','setDisabled','onChange','addOption'])item[name]=()=>item;item.setButtonText=text=>{item.label=text;return item;};item.onClick=click=>{item.click=click;return item;};return item;};
 class Setting {constructor(){this.row={buttons:[]};rows.push(this.row);}setName(name){this.row.name=name;return this;}setDesc(desc){this.row.desc=desc;return this;}addText(fn){fn(control());return this;}addToggle(fn){this.row.toggle=true;fn(control());return this;}addDropdown(fn){fn(control());return this;}addButton(fn){const c=control();fn(c);this.row.buttons.push(c);return this;}}
 const module={exports:{}};new Function('module','exports','require',output.outputFiles[0].text)(module,module.exports,()=>({Platform:{isMobile:mobile},Setting,Modal:class{},Notice:class{}}));
 if(entryOnly) module.exports.renderWalletSetupEntry(root); else module.exports.renderFinanceImportRetirement(root);
 return {rows,titles};
}

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

test('bank retirement settings have no credentials, pairing, imports or file controls',()=>{
 for(const mobile of [true,false])for(let i=0;i<20;i++){const {rows,titles}=render(mobile);assert.equal(rows.length,0);assert.equal(titles.length,1);assert.match(titles[0],/retired/);}
 const main=readFileSync('src/main.ts','utf8'),settings=readFileSync('src/settings-tab.ts','utf8');
 assert.doesNotMatch(main,/FinanceRelayService|PlaidConnectionService|financeRelay|plaidConnection|controllerFinanceBackend/);
 assert.doesNotMatch(settings,/renderFinanceRelaySettings|renderPlaidConnectionSettings|Bank setup/);
 for(const file of ['finance-relay','finance-wallet-relay','plaid-connection'])assert.equal(existsSync('src/services/'+file+'.ts'),false);
});
