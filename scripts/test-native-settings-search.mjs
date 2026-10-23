import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { execFileSync } from 'node:child_process';
import { SOURCES } from './settings-search-config.mjs';

function load(source, bindings = {}) {
  const exports = {};
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  vm.runInNewContext(code, { exports, ...bindings });
  return exports;
}
const helper = load(readFileSync('src/native-settings-search.ts', 'utf8'));
const catalog = load(readFileSync('src/settings-search-catalog.ts', 'utf8'));
const flat = definitions => definitions.flatMap(def => def.items ? flat(def.items) : [def]);

test('search catalog is generated from current UI copy', () => {
  execFileSync(process.execPath, ['scripts/generate-settings-search.mjs', '--check']);
});

test('indexing is metadata-only, including inactive destinations and description/placeholder terms', () => {
  let renders = 0, opens = 0;
  const defs = helper.nativeSettingsSearch(catalog.SETTINGS_SEARCH_ENTRIES, catalog.SETTINGS_SEARCH_ROUTES, () => { renders++; }, () => { opens++; });
  assert.equal(renders, 0); assert.equal(opens, 0);
  const rows = flat(defs).filter(def => def.action);
  assert.equal(rows.length, catalog.SETTINGS_SEARCH_ENTRIES.length);
  for (const [index, entry] of catalog.SETTINGS_SEARCH_ENTRIES.entries()) {
    assert.ok(catalog.SETTINGS_SEARCH_ROUTES[entry.route]);
    const row = rows.find(row => row.name === entry.name && row.desc.startsWith(catalog.SETTINGS_SEARCH_ROUTES[entry.route]));
    assert.ok(row, 'indexed '+entry.name);
    assert.ok(row.desc.includes(entry.desc || ''));
    for (const alias of entry.aliases || []) assert.ok(row.aliases.includes(alias));
  }
});

test('search activation navigates only and never invokes an indexed destructive action', () => {
  const actions=[];
  const defs=helper.nativeSettingsSearch([{name:'Run archive now',desc:'Move files',route:'archive'}], {archive:'Archive'}, () => {throw Error('rendered during indexing');}, entry => actions.push(entry));
  const entry=flat(defs).find(def=>def.action);entry.action();
  assert.equal(actions.length,1);assert.equal(actions[0].name,'Run archive now');
});

test('actual tab definition method survives unchanged bursts without DOM, I/O, saves, or UI mounting', () => {
  const file=Object.keys(SOURCES)[0];
  const text=readFileSync(file,'utf8');
  const ast=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true);
  let body;
  const visit=node=>{if(ts.isMethodDeclaration(node)&&node.name.getText(ast)==='getSettingDefinitions')body=node.body.getText(ast);ts.forEachChild(node,visit);}; visit(ast);
  assert.ok(body);
  const fail=new Proxy({}, {get(){throw Error('Index touched runtime or DOM');}});
  const exports=load('export function definitions() '+body, {
    ...helper,...catalog,PROPERTY_GROUPS:{Common:['category']},propertyLabel:key=>key,EXTRA_NUTRIENTS:[],
    document:fail,window:fail,
  });
  const settings={properties:[{id:'label',key:'customKey',label:'Custom label'}]};
  const before=JSON.stringify(settings);
  const receiver={plugin:{settings,app:fail},app:fail,display(){throw Error('mounted UI');},hide(){throw Error('hid UI');},openSearchResult(){throw Error('navigated');}};
  for(let i=0;i<1000;i++)assert.ok(exports.definitions.call(receiver).length);
  assert.equal(JSON.stringify(settings),before);
});

test('focused result opens its disclosure, keeps existing values, and leaves disabled features hidden', () => {
  let focused=0,scrolled=0;
  const container={querySelectorAll:()=>[label]};
  const detail={tagName:'DETAILS',open:false,parentElement:container};
  const input={matches:()=>true,focus:()=>focused++};
  const row={parentElement:detail,getClientRects:()=>[{}],querySelector:()=>input,scrollIntoView:()=>scrolled++};
  const label={textContent:'Archive folder',closest:()=>row};
  assert.equal(helper.focusSettingsSearchResult(container,'Archive folder'),true);
  assert.equal(detail.open,true);assert.equal(focused,1);assert.equal(scrolled,1);
  row.getClientRects=()=>[];
  assert.equal(helper.focusSettingsSearchResult(container,'Archive folder'),false);
  assert.equal(focused,1);
  assert.equal(helper.focusSettingsSearchResult(container,'Missing'),false);
});
