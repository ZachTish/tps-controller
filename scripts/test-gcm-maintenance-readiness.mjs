import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const mainSource = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const registrySource = readFileSync(new URL('../src/core/type-guards.ts', import.meta.url), 'utf8');
const registryModule = { exports: {} };
new Function('module', 'exports', ts.transpileModule(registrySource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText)(registryModule, registryModule.exports);
const { getPluginById, isPluginEnabled } = registryModule.exports;

class TFile {
  constructor(path, frontmatter = {}) {
    this.path = path;
    this.extension = 'md';
    this.basename = path.replace(/\.md$/u, '');
    this.frontmatter = frontmatter;
  }
}

function loadActualMethods() {
  const source = ts.createSourceFile('main.ts', mainSource, ts.ScriptTarget.Latest, true);
  const owner = source.statements.find(node => ts.isClassDeclaration(node)
    && node.name?.text === 'TPSControllerPlugin');
  assert.ok(owner, 'Actual Controller owner must exist');
  const names = [
    'getGcmPlugin', 'getCalendarPlugin', 'getNotifierPlugin',
    'runRecurrenceMaintenanceTick', 'runParentChildMaintenanceTick',
    'hasFrontmatterKeyCaseInsensitive', 'getFrontmatterValueCaseInsensitive',
  ];
  const methods = names.map(name => {
    const method = owner.members.find(member => ts.isMethodDeclaration(member)
      && member.name.getText(source) === name);
    assert.ok(method, `Execute actual ${name} source`);
    return method.getText(source);
  });
  const compiled = ts.transpileModule(`class Controller { ${methods.join('\n')} }`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const logger = { flow() {}, flowWarn() {}, flowError() {}, errorSummary: String };
  return new Function('getPluginById', 'isPluginEnabled', 'TFile', 'logger',
    `${compiled}\nreturn Controller;`)(getPluginById, isPluginEnabled, TFile, logger);
}

const Controller = loadActualMethods();
const GCM_ID = 'tps-global-context-menu';
const LEGACY_GCM_ID = 'TPS-Global-Context-Menu (Dev)';

function createHarness({ apiState = 'ready', enabled = true, installed = true, role = 'controller', id = GCM_ID } = {}) {
  const counts = { inventory: 0, metadata: 0, reads: 0, writes: 0, provider: 0,
    model: 0, recurrence: 0, reconcile: 0, selfLink: 0, privateAccess: 0, registry: 0 };
  const parent = new TFile('Parent.md', { parentOf: ['[[Child]]'] });
  const child = new TFile('Child.md', { childOf: ['[[Parent]]'] });
  const frame = {
    recurrence: {
      async checkMissingRecurrences() {
        assert.equal(this, frame.recurrence, 'Shared recurrence receiver must be retained');
        counts.recurrence++;
        counts.model++;
      },
    },
    parents: { getParentKey() { counts.model++; return 'childOf'; } },
    links: {
      extractTargetsFromValue(raw) { counts.model++; return raw ? ['Parent'] : []; },
      resolveToFile(target) { counts.model++; return target === 'Parent' ? parent : null; },
    },
  };
  const bulk = {
    async checkMissingRecurrences() {
      assert.equal(this, bulk, 'Private recurrence receiver must be retained');
      counts.recurrence++;
      counts.model++;
    },
    async reconcileParentChildLinksForParent(file) {
      assert.equal(this, bulk, 'Parent reconciliation receiver must be retained');
      assert.equal(file, parent);
      counts.reconcile++;
      counts.reads++;
      return 0;
    },
    async ensureParentSelfLinkForParent(file) {
      assert.equal(this, bulk, 'Self-link receiver must be retained');
      assert.equal(file, parent);
      counts.selfLink++;
      counts.writes++;
      return true;
    },
  };
  const timeTracking = { async getActiveTimers() { counts.model++; return []; } };
  const gcm = {};
  for (const [key, value] of Object.entries({
    settings: { parentLinkFrontmatterKey: 'childOf', childLinkFrontmatterKey: 'parentOf' },
    sharedServices: frame, bulkEditService: bulk, timeTrackingService: timeTracking,
  })) Object.defineProperty(gcm, key, { configurable: true, get() { counts.privateAccess++; return value; } });
  const publish = () => { gcm.api = { services: frame, timeTracking }; };
  if (apiState === 'ready') publish();
  else if (apiState === 'null') gcm.api = null;
  else if (apiState === 'false') gcm.api = false;
  const calendarApi = { getSettings: () => ({ safe: true }) };
  const notifier = { sendNotification() { counts.provider++; } };
  const plugins = { 'tps-calendar-base': { api: calendarApi }, 'tps-messager': notifier };
  if (installed) plugins[id] = gcm;
  const enabledPlugins = new Set(['tps-calendar-base', 'tps-messager']);
  if (enabled) enabledPlugins.add(id);
  const app = {
    plugins: { plugins, enabledPlugins, getPlugin(key) { counts.registry++; return plugins[key] ?? null; } },
    vault: { getMarkdownFiles() { counts.inventory++; return [parent, child]; } },
    metadataCache: { getFileCache(file) { counts.metadata++; return { frontmatter: file.frontmatter }; } },
  };
  const controller = Object.assign(new Controller(), {
    app, parentChildMaintenanceActivated: false,
    deviceRoleManager: { role, isController: () => role === 'controller' },
  });
  return { controller, app, counts, gcm, publish, parent, bulk, frame, timeTracking, calendarApi, notifier };
}

function assertNoMaintenance(h) {
  const { registry, ...work } = h.counts;
  assert.deepEqual(work, { inventory: 0, metadata: 0, reads: 0, writes: 0, provider: 0,
    model: 0, recurrence: 0, reconcile: 0, selfLink: 0, privateAccess: 0 });
  assert.equal(h.controller.parentChildMaintenanceActivated, false,
    'An unavailable dependency must not stop the existing bootstrap owner');
}

test('ready GCM API preserves shared recurrence, parent maintenance and exact method receivers', async () => {
  const h = createHarness();
  await h.controller.runRecurrenceMaintenanceTick();
  await h.controller.runParentChildMaintenanceTick();
  assert.equal(h.counts.recurrence, 1);
  assert.equal(h.counts.inventory, 1);
  assert.equal(h.counts.metadata, 2);
  assert.equal(h.counts.reconcile, 1);
  assert.equal(h.counts.selfLink, 1);
  assert.equal(h.controller.parentChildMaintenanceActivated, true);
  assert.equal(h.controller.getGcmPlugin().timeTracking, h.timeTracking);
});

test('ready GCM still permits existing private bulk fallback where the published API omits recurrence', async () => {
  const h = createHarness();
  h.gcm.api = {};
  // Published legacy-compatible API can omit a public recurrence adapter.
  const shared = { ...h.frame, recurrence: undefined };
  Object.defineProperty(h.gcm, 'sharedServices', { get() { h.counts.privateAccess++; return shared; } });
  await h.controller.runRecurrenceMaintenanceTick();
  assert.equal(h.counts.recurrence, 1);
});

for (const apiState of ['missing', 'null', 'false']) {
  test(`unpublished GCM (${apiState} API) performs no private maintenance or vault/model/provider work`, async () => {
    const h = createHarness({ apiState });
    await h.controller.runRecurrenceMaintenanceTick();
    await h.controller.runParentChildMaintenanceTick();
    assertNoMaintenance(h);
  });
}

test('actual unload contract removes API authority even while old private service objects remain registered', async () => {
  const h = createHarness();
  delete h.gcm.api; // Check after unload has removed API authority, not during its event callback.
  await h.controller.runRecurrenceMaintenanceTick();
  await h.controller.runParentChildMaintenanceTick();
  assertNoMaintenance(h);
});

for (const state of [
  { enabled: false }, { installed: false }, { role: 'user' },
]) {
  test(`disabled, missing or User-role GCM cannot activate maintenance: ${JSON.stringify(state)}`, async () => {
    const h = createHarness(state);
    await h.controller.runRecurrenceMaintenanceTick();
    await h.controller.runParentChildMaintenanceTick();
    assertNoMaintenance(h);
  });
}

test('an unrelated enabled plugin cannot grant GCM maintenance authority', async () => {
  const h = createHarness({ enabled: false });
  h.app.plugins.enabledPlugins.add('unrelated-plugin');
  h.app.plugins.plugins['unrelated-plugin'] = h.gcm;
  await h.controller.runRecurrenceMaintenanceTick();
  await h.controller.runParentChildMaintenanceTick();
  assertNoMaintenance(h);
});

test('the existing next tick observes late publication without a new poller or cached availability state', async () => {
  const h = createHarness({ apiState: 'missing' });
  await h.controller.runRecurrenceMaintenanceTick();
  await h.controller.runParentChildMaintenanceTick();
  assertNoMaintenance(h);
  h.publish();
  await h.controller.runRecurrenceMaintenanceTick();
  await h.controller.runParentChildMaintenanceTick();
  assert.equal(h.counts.recurrence, 1);
  assert.equal(h.counts.inventory, 1);
  assert.equal(h.counts.metadata, 2);
  assert.equal(h.counts.reconcile, 1);
  assert.equal(h.counts.selfLink, 1);
});

test('canonical and existing legacy GCM registry IDs both require publication', async () => {
  const h = createHarness({ id: LEGACY_GCM_ID, apiState: 'missing' });
  await h.controller.runRecurrenceMaintenanceTick();
  await h.controller.runParentChildMaintenanceTick();
  assertNoMaintenance(h);
  h.publish();
  await h.controller.runRecurrenceMaintenanceTick();
  assert.equal(h.counts.recurrence, 1);
});

test('waiting for GCM does not affect Calendar or Notifier lookup contracts', () => {
  const h = createHarness({ apiState: 'missing' });
  assert.equal(h.controller.getCalendarPlugin(), h.calendarApi);
  assert.equal(h.controller.getNotifierPlugin(), h.notifier);
  assert.equal(h.counts.privateAccess + h.counts.inventory + h.counts.metadata + h.counts.provider, 0);
});

test('empty scope dispatches no recovery and never inventories or accesses GCM', async () => {
  const h = createHarness(); await h.controller.runRecurrenceMaintenanceTick([]);
  assertNoMaintenance(h); assert.equal(h.counts.registry, 0);
});

test('scoped dispatch preserves exact paths and receiver without a Controller inventory', async () => {
  const h = createHarness(); const paths = ['Calendar/Changed.md'];
  h.frame.recurrence.checkMissingRecurrences = async function(scope) {
    assert.equal(this, h.frame.recurrence); assert.equal(scope, paths); h.counts.recurrence++;
  };
  await h.controller.runRecurrenceMaintenanceTick(paths);
  assert.equal(h.counts.recurrence, 1); assert.equal(h.counts.inventory + h.counts.reads + h.counts.writes, 0);
});

test('recovery failure propagates to the calendar caller rather than reporting success', async () => {
  const h = createHarness(); const failure = new Error('recurrence write failed');
  h.frame.recurrence.checkMissingRecurrences = async () => { throw failure; };
  await assert.rejects(h.controller.runRecurrenceMaintenanceTick(['Calendar/Changed.md']), error => error === failure);
});
