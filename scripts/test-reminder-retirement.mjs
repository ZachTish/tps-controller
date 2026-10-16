import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const settings = readFileSync(new URL('../src/settings-tab.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('main.ts', main, ts.ScriptTarget.Latest, true);
const owner = ast.statements.find(n => ts.isClassDeclaration(n) && n.name?.text === 'TPSControllerPlugin');
const onload = owner.members.find(n => n.name?.getText(ast) === 'onload');

test('retired reminder/catalog owners have no files, hooks, timers or invocation paths', () => {
  for (const name of ['reminder-engine','tishos-command-bridge-service','tishos-native-mac-refresh-sender','tishos-command-bridge-contract','tishos-native-notification-contract','tishos-native-mac-refresh-contract']) {
    assert.equal(existsSync(new URL(`../src/services/${name}.ts`, import.meta.url)), false, name);
  }
  assert.doesNotMatch(main, /ReminderEngine|TishOSCommandBridgeService|NativeMacRefreshSender|refreshCatalogs|projectScheduledNotifications|runReminderCheck|startReminderLoop|setInterval|setTimeout|metadataCache\.on|vault\.on/);
  assert.doesNotMatch(settings, /Refresh Schedule|Enable Reminders|Hourly Time Tracking Reminders|Reset Alert State|reminderDeliveryStatusTimer/);
  assert.doesNotMatch(main, /localStorage\.(?:setItem|removeItem).*alert|alertState:\s*\{\}/);
});

test('400 legacy app protocol requests report retirement without reading state or mutating', () => {
  const routes = new Map();
  const notices = [];
  const host = { registerObsidianProtocolHandler: (route, callback) => routes.set(route, callback) };
  Object.defineProperty(host, 'app', { get() { throw new Error('retired route accessed app'); } });
  for (const statement of onload.body.statements) {
    if (!statement.getText(ast).includes('Controller reminder and command bridges are retired.')) continue;
    const code = ts.transpileModule(statement.getText(ast), {compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText;
    new Function('Notice', code).call(host, class {constructor(message){notices.push(message);}});
  }
  assert.deepEqual([...routes.keys()].sort(), ['tps-controller-command-bridge-pair','tps-controller-command-bridge-revoke','tps-controller-native-notification-action','tps-controller-run-command'].sort());
  const request = new Proxy({}, {get(){throw new Error('retired route read request authority');}});
  for(let i=0;i<100;i++)for(const callback of routes.values())callback(request);
  assert.equal(notices.length,400);
  assert.ok(notices.every(n=>n.includes('No action was performed.')));
});

test('retirement settings render without touching configuration, providers or vault', () => {
  const a=ts.createSourceFile('settings.ts',settings,ts.ScriptTarget.Latest,true);
  const cls=a.statements.find(n=>ts.isClassDeclaration(n));
  const method=cls.members.find(n=>n.name?.getText(a)==='renderReminderSettingsPage');
  const js=ts.transpileModule(`class View {${method.getText(a)}}`,{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText;
  const View=new Function(`${js};return View;`)();
  let renders=0;
  const view=new View();view.renderPageHeading=()=>{};
  for(const key of ['plugin','app'])Object.defineProperty(view,key,{get(){throw new Error('settings touched '+key);}});
  for(let i=0;i<20;i++)view.renderReminderSettingsPage({createEl:()=>renders++});
  assert.equal(renders,20);
});
