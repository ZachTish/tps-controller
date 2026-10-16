import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

function loadTypeScriptModuleWithRequire(url, requireImpl) {
  const sourceText = readFileSync(url, 'utf8');
  const compiled = ts.transpileModule(sourceText, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018 },
  });
  const module = { exports: {} };
  new Function('module', 'exports', 'require', compiled.outputText)(module, module.exports, requireImpl);
  return module.exports;
}

const source = readFileSync(new URL('../src/services/reminder-target-service.ts', import.meta.url), 'utf8');
const gcmApiSource = readFileSync(new URL('../src/tps-gcm-api.ts', import.meta.url), 'utf8');
const gcmApi = loadTypeScriptModuleWithRequire(
  new URL('../src/tps-gcm-api.ts', import.meta.url),
  (specifier) => {
    if (specifier === './tps-contracts') {
      return {
        TPS_EVENTS: { FILES_UPDATED: 'tps:files-updated' },
        TPS_LEGACY_EVENTS: { GCM_FILES_UPDATED: 'tps-gcm-files-updated' },
      };
    }
    throw new Error(`Unexpected test require: ${specifier}`);
  },
);
const settingsTabSource = readFileSync(new URL('../src/settings-tab.ts', import.meta.url), 'utf8');
const mainSource = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');

test('external reminder synthetic frontmatter uses externalId instead of legacy calendar identity triplet', () => {
  assert.match(source, /externalId: buildCalendarExternalId\(null, event\)/);
  assert.doesNotMatch(source, /externalEventId: event\.id/);
  assert.doesNotMatch(source, /tpsCalendarUid: event\.uid/);
  assert.doesNotMatch(source, /tpsCalendarSourceUrl: event\.sourceUrl/);
});

test('external calendar settings cannot configure an inline task destination', () => {
  assert.doesNotMatch(settingsTabSource, /\.setName\("Task target note"\)/);
  assert.doesNotMatch(settingsTabSource, /\.setName\("Task destination"\)/);
  assert.doesNotMatch(settingsTabSource, /\.setName\("Create as"\)/);
});

test('GCM task adapter requires v3 and forwards configured Daily Note moves with user cause', async () => {
  const calls = [];
  const expectedResult = {
    ok: true,
    changed: true,
    task: { path: 'Projects/Target.md', line: 4, lineNumber: 3, rawLine: '- [ ] Task', title: 'Task' },
  };
  const createApp = (tasks) => ({
    plugins: {
      getPlugin(id) {
        return id === 'tps-global-context-menu' ? { api: { tasks } } : null;
      },
    },
  });
  const ref = {
    path: 'Daily/2026-08-10.md',
    lineNumber: 12,
    rawLine: '- [ ] Task [scheduled:: 2026-08-10 09:00]',
    title: 'Task',
  };
  const target = {
    targetPath: 'Projects/Target.md',
    sourcePolicy: 'configured-daily-note',
    resolution: 'exact-or-identity',
  };
  const cause = {
    kind: 'user',
    sourcePluginId: 'tps-controller',
    surface: 'reminder-modal',
  };
  const v3App = createApp({
    version: 3,
    async move(actualRef, actualTarget, actualCause) {
      calls.push({ ref: actualRef, target: actualTarget, cause: actualCause });
      return expectedResult;
    },
  });

  assert.deepEqual(await gcmApi.moveTaskViaGcm(v3App, ref, target, cause), {
    available: true,
    result: expectedResult,
  });
  assert.deepEqual(calls, [{ ref, target, cause }]);

  for (const tasks of [
    undefined,
    { move: async () => expectedResult },
    { version: 1, move: async () => expectedResult },
    { version: 2, move: async () => expectedResult },
  ]) {
    assert.deepEqual(await gcmApi.moveTaskViaGcm(createApp(tasks), ref, target, cause), {
      available: false,
      result: null,
    });
  }
  assert.equal(calls.length, 1);

  const rejected = { ok: false, changed: true, task: null, error: 'partial copy remains' };
  assert.deepEqual(
    await gcmApi.moveTaskViaGcm(createApp({ version: 3, move: async () => rejected }), ref, target, cause),
    { available: true, result: rejected },
  );
});

test('integration field reads and writes use the GCM configured-name contract', () => {
 const frontmatter = { mirror: 'old', title: 'Keep' };
 const app = { plugins: { plugins: { 'tps-global-context-menu': { api: { identity: {
  getNoteField: (fm, field) => { assert.equal(field, 'externalId'); return fm.mirror; },
  setNoteField: (fm, field, value) => { assert.equal(field, 'externalId'); if(value == null) delete fm.mirror; else fm.mirror=value; }
 } } } } } };
 assert.equal(gcmApi.getIntegrationNoteField(app,frontmatter,'externalId'),'old');
 gcmApi.setIntegrationNoteField(app,frontmatter,'externalId','new');assert.deepEqual(frontmatter,{mirror:'new',title:'Keep'});
 gcmApi.setIntegrationNoteField(app,frontmatter,'externalId',null);assert.deepEqual(frontmatter,{title:'Keep'});
});


test('standalone identities use id without changing an existing value or field casing', () => {
  const existing = { ID: 'kept-value', externalId: 'calendar:keep', title: 'Keep' };
  assert.equal(gcmApi.ensureInternalIdInFrontmatter(null, existing), 'kept-value');
  assert.deepEqual(existing, { ID: 'kept-value', externalId: 'calendar:keep', title: 'Keep' });
  const created = { title: 'Fresh', externalId: 'calendar:source' };
  const value = gcmApi.ensureInternalIdInFrontmatter(null, created);
  assert.match(value, /^item_/u);
  assert.equal(created.id, value);
  assert.equal(created.title, 'Fresh');
  assert.equal(created.externalId, 'calendar:source');
  assert.equal(Object.hasOwn(created, 'tpsId'), false);
});

test('identity fallback respects the configured physical key and the profile takes precedence', () => {
  const plugin = { settings: { nativeRecordIdentityPropertyKey: 'savedIdentity' }, api: {
    nativeRecords: { getStorageProfile: () => ({ identityPropertyKey: 'recordIdentity' }) },
  } };
  const app = { plugins: { plugins: { 'tps-global-context-menu': plugin } } };
  const existing = { RecordIdentity: 'same-id', externalId: 'calendar:keep' };
  assert.equal(gcmApi.ensureInternalIdInFrontmatter(app, existing), 'same-id');
  assert.deepEqual(existing, { RecordIdentity: 'same-id', externalId: 'calendar:keep' });
  const created = {};
  const value = gcmApi.ensureInternalIdInFrontmatter(app, created);
  assert.deepEqual(created, { recordIdentity: value });
  plugin.api.nativeRecords.getStorageProfile = () => ({ identityPropertyKey: 'tpsId' });
  const configuredLegacy = { tpsId: 'unchanged-legacy-value' };
  assert.equal(gcmApi.ensureInternalIdInFrontmatter(app, configuredLegacy), 'unchanged-legacy-value');
  assert.deepEqual(configuredLegacy, { tpsId: 'unchanged-legacy-value' });
  plugin.api = {};
  const saved = { SavedIdentity: 'saved-id' };
  assert.equal(gcmApi.ensureInternalIdInFrontmatter(app, saved), 'saved-id');
  assert.deepEqual(saved, { SavedIdentity: 'saved-id' });
});

test('an available identity owner remains authoritative and its failure cannot create a competing id', () => {
  const frontmatter = { title: 'Keep' };
  const app = { plugins: { plugins: { 'tps-global-context-menu': { api: { identity: {
    ensureInternalIdInFrontmatter: () => { throw new Error('owner rejected'); },
  } } } } } };
  assert.throws(() => gcmApi.ensureInternalIdInFrontmatter(app, frontmatter), /owner rejected/u);
  assert.deepEqual(frontmatter, { title: 'Keep' });
});
