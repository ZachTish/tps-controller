import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
class Element {
 constructor(){this.children=[];this.dataset={};this.scrollTop=0;}
 createDiv(){const child=new Element();this.children.push(child);return child;}
 createEl(tag,options){const child=this.createDiv();child.tag=tag;child.text=options?.text;return child;}
 empty(){this.children=[];} querySelector(){return null;} all(){return [this,...this.children.flatMap(c=>c.all())];}
}
class Control {
 constructor(){this.buttonEl=new Element();this.extraSettingsEl=new Element();}
 setValue(value){this.value=value;return this;} setButtonText(value){this.label=value;return this;}
 setDisabled(value){this.disabled=value;return this;} onChange(fn){this.change=fn;return this;} onClick(fn){this.click=fn;return this;}
 setCta(){return this;} setWarning(){return this;} setPlaceholder(){return this;} setIcon(){return this;} setTooltip(){return this;}
}
class Setting {
 constructor(parent){this.settingEl=parent.createDiv();this.settingEl.setting=this;this.buttons=[];}
 setName(name){this.name=name;return this;} setDesc(desc){this.desc=desc;return this;}
 addButton(fn){const c=new Control();fn(c);this.buttons.push(c);return this;}
 addExtraButton(fn){return this.addButton(fn);}
 addText(fn){this.text=new Control();fn(this.text);return this;}
 addComponent(fn){this.secret=fn(this.settingEl.createDiv());return this;}
}
const output=await build({entryPoints:['src/services/connection-settings.ts'],bundle:true,write:false,format:'cjs',platform:'browser',external:['obsidian']});
const module={exports:{}};
new Function('module','exports','require',output.outputFiles[0].text)(module,module.exports,()=>({Setting,SecretComponent:class extends Control{},App:class{},Notice:class{},Modal:class{},ButtonComponent:Control,Platform:{isMobile:true}}));
const rows=root=>root.all().filter(el=>el.setting).map(el=>el.setting);

const {mountConnectionSettings, connectionSection}=module.exports;
test('missing or outdated adapters do not access state, secrets, or network',()=>{
 for(const adapter of [undefined,{version:2,render(){throw Error('must not run');}}]) {
  const root=new Element();let writes=0;
  const app={plugins:{plugins:{'tps-finances':{api:{connectionSettings:adapter}}}},saveLocalStorage(){writes++;}};
  const dispose=mountConnectionSettings(app,root,'finance');dispose();
  assert.equal(rows(root)[0].name,'TPS Finances');assert.equal(writes,0);
 }
});
test('each section mounts only its own editor and forwards disposal',()=>{
 for(const [section,id] of [['finance','tps-finances'],['ai','tps-ai-gateway'],['health','tps-health']]) {
  let mounted=0,disposed=0;const root=new Element();
  const app={plugins:{plugins:{[id]:{api:{connectionSettings:{version:1,render(parent){assert.equal(parent,root);mounted++;return()=>disposed++;}}}}}}};
  const stop=mountConnectionSettings(app,root,section);assert.equal(mounted,1);stop();assert.equal(disposed,1);
 }
});
test('invalid handoffs normalize and broken editors display an actionable error',()=>{
 assert.equal(connectionSection('credentials'),'finance');assert.equal(connectionSection('health'),'health');
 const root=new Element();mountConnectionSettings({plugins:{plugins:{'tps-finances':{api:{connectionSettings:{version:1,render(){throw Error('secret must not escape');}}}}}}},root,'finance');
 assert.match(root.children[0].text,/could not be loaded/);assert.doesNotMatch(root.children[0].text,/secret must/);
});
