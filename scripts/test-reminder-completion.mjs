import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { load as parseYaml, dump as stringifyYaml } from 'js-yaml';
import moment from 'moment';
import ts from 'typescript';

const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url));

class SyntheticFile {
  constructor(path) { this.rename(path); }
  rename(path) {
    this.path = path;
    this.name = path.split('/').pop();
    this.extension = 'md';
    this.basename = this.name.slice(0, -3);
  }
}

function frontmatterInfo(content) {
  const source = content.replace(/^\ufeff/u, '');
  const match = /^---\r?\n/u.test(source) ? source.match(/^---\r?\n([\s\S]*?)^---(?:\r?\n|$)/mu) : null;
  return { exists: !!match, frontmatter: match?.[1] || '' };
}

// Compile the actual Controller services in memory. Only the Obsidian host,
// optional GCM API and external calendar provider are synthetic boundaries.
function loadServices(events) {
  const loaded = new Map();
  const obsidian = {
    App: class {}, TFile: SyntheticFile, MarkdownView: class {}, WorkspaceLeaf: class {},
    Notice: class {}, moment, parseYaml, getFrontMatterInfo: frontmatterInfo,
    getAllTags: () => [], normalizePath: value => value,
  };
  function loadModule(filePath) {
    const path = resolve(sourceRoot, filePath);
    if (loaded.has(path)) return loaded.get(path).exports;
    const module = { exports: {} };
    loaded.set(path, module);
    const compiled = ts.transpileModule(readFileSync(path, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018 },
    });
    const requireStub = id => {
      if (id === 'obsidian') return obsidian;
      if (id.endsWith('/logger')) return { flow() {}, flowWarn() {}, flowError() {}, log() {}, warn() {} };
      if (id === '../views/notification-view') return { NOTIFICATION_VIEW_TYPE: 'synthetic-notifications' };
      if (id === './external-calendar-service') return { ExternalCalendarService: class {} };
      if (id === '../tps-gcm-api') return {
        emitFilesUpdated: (_app, paths) => events.push([...paths]),
        getGcmApi: () => null,
        buildCalendarExternalId: () => 'synthetic-calendar',
        getDailyNoteTaskSchedulePolicyViaGcm: () => ({ available: false }),
      };
      if (id.startsWith('.')) return loadModule(resolve(dirname(path), `${id}.ts`));
      throw new Error(`Unexpected Controller dependency: ${id}`);
    };
    new Function('module', 'exports', 'require', compiled.outputText)(module, module.exports, requireStub);
    return module.exports;
  }
  return {
    ...loadModule('services/overdue-service.ts'),
    ...loadModule('services/reminder-engine.ts'),
    ...loadModule('types.ts'),
  };
}

function fixture({ status = 'working', metadataStatus = status } = {}) {
  const events = [];
  const { OverdueService, ReminderEngine, DEFAULT_CONTROLLER_SETTINGS } = loadServices(events);
  const file = new SyntheticFile('Inbox/Synthetic overdue note.md');
  const files = new Map([[file.path, file]]);
  const content = new Map();
  const metadata = new Map();
  const counters = { read: 0, cachedRead: 0, scans: 0, fallback: 0, status: 0 };
  const settings = structuredClone(DEFAULT_CONTROLLER_SETTINGS);
  const now = new Date(2026, 9, 5, 12, 0).getTime();
  const dueAt = new Date(now - 2 * 60 * 60 * 1000).toISOString();
  const properties = {
    title: 'Synthetic overdue note', scheduled: dueAt,
    ...(status === undefined ? {} : { status }),
  };
  function save(propertiesToSave) {
    content.set(file, `---\n${stringifyYaml(propertiesToSave)}---\nPreserve this body.\n`);
    metadata.set(file, { ...propertiesToSave });
  }
  save(properties);
  metadata.set(file, { ...properties, status: metadataStatus });
  let statusOperation = async () => 0;
  let updateOperation = async () => 0;
  const bulkEdit = {
    setStatus: async (targets, nextStatus) => {
      counters.status++;
      assert.deepEqual(targets, [file]);
      return statusOperation(nextStatus);
    },
    updateFrontmatter: async (_targets, updates) => updateOperation(updates),
  };
  const app = {
    plugins: { getPlugin: () => ({ bulkEditService: bulkEdit }) },
    vault: {
      getAbstractFileByPath: path => files.get(path) || null,
      getMarkdownFiles: () => { counters.scans++; return [...files.values()]; },
      read: async target => { counters.read++; return content.get(target); },
      cachedRead: async target => { counters.cachedRead++; return content.get(target); },
    },
    metadataCache: { getFileCache: target => ({ frontmatter: metadata.get(target) }) },
    fileManager: { processFrontMatter: async () => { counters.fallback++; throw new Error('Unexpected fallback'); } },
  };
  const service = new OverdueService(app, () => settings);
  const engine = new ReminderEngine(app, null);
  settings.reminders = [{
    id: 'synthetic-repeat', enabled: true, property: 'scheduled', sourceTypes: ['file'],
    title: '{filename}', body: '{time}', mode: 'timeblock', triggerAtEnd: false,
    offsetMinutes: 0, repeatUntilComplete: true, repeatIntervalMinutes: 5,
    maxRepeats: -1, stopConditions: [], allDayFilter: 'both',
  }];
  const item = { file, targetKind: 'note', reminder: settings.reminders[0] };
  return {
    file, files, content, metadata, counters, events, service, engine, settings, now, properties, item,
    save, bulkEdit,
    setStatusOperation: value => { statusOperation = value; },
    setUpdateOperation: value => { updateOperation = value; },
    rename: path => { files.delete(file.path); file.rename(path); files.set(path, file); },
    app,
  };
}

test('Complete rejects a fulfilled GCM zero result while the authored note remains working', async () => {
  const f = fixture();
  await assert.rejects(f.service.completeItemFromNativeNotification(f.item), /not applied/i);
  assert.equal(f.counters.read, 1);
  assert.equal(f.counters.fallback, 0);
  assert.deepEqual(f.events, []);
  assert.equal(f.files.size, 1);
  assert.equal(parseYaml(frontmatterInfo(f.content.get(f.file)).frontmatter).status, 'working');
});

test('Complete waits for a positive committed GCM result without extra source reads', async () => {
  const f = fixture();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  f.setStatusOperation(async next => { await gate; f.save({ ...f.properties, status: next }); return 1; });
  let settled = false;
  const completed = f.service.completeItemFromNativeNotification(f.item).then(value => { settled = true; return value; });
  await Promise.resolve();
  assert.equal(f.counters.status, 1);
  assert.equal(settled, false);
  release();
  assert.equal(await completed, true);
  assert.equal(f.counters.read, 0);
  assert.equal(f.counters.fallback, 0);
  assert.deepEqual(f.events, [[f.file.path]]);
});

test('Complete propagates GCM rejection without fallback or success event', async () => {
  const f = fixture();
  f.setStatusOperation(async () => { throw new Error('Synthetic write failure'); });
  await assert.rejects(f.service.completeItemFromNativeNotification(f.item), /Synthetic write failure/);
  assert.equal(f.counters.read, 0);
  assert.equal(f.counters.fallback, 0);
  assert.deepEqual(f.events, []);
});

test('a zero result accepts already-complete authored content, not stale metadata', async () => {
  const f = fixture({ status: 'complete', metadataStatus: 'working' });
  assert.equal(await f.service.completeItemFromNativeNotification(f.item), true);
  assert.equal(f.counters.read, 1);
  assert.equal(f.counters.fallback, 0);
});

test('a zero result does not trust stale completed metadata over working authored content', async () => {
  const f = fixture({ status: 'working', metadataStatus: 'complete' });
  await assert.rejects(f.service.completeItemFromNativeNotification(f.item), /not applied/i);
});

test('a zero result cannot confirm a different note occupying the former path', async () => {
  const f = fixture({ status: 'complete' });
  f.files.set(f.file.path, new SyntheticFile(f.file.path));
  await assert.rejects(f.service.completeItemFromNativeNotification(f.item), /not applied/i);
  assert.equal(f.counters.read, 0);
});

test('a zero result can confirm the same already-complete file after its settled rename', async () => {
  const f = fixture({ status: 'complete' });
  f.setStatusOperation(async () => { f.rename('Inbox/2026-10-05 Synthetic overdue note.md'); return 0; });
  assert.equal(await f.service.completeItemFromNativeNotification(f.item), true);
  assert.equal(f.files.size, 1);
  assert.equal(f.counters.read, 1);
  assert.deepEqual(f.events, [[f.file.path]]);
});

test('a zero result rejects target replacement during its authoritative source read', async () => {
  const f = fixture({ status: 'complete' });
  f.app.vault.read = async target => {
    f.counters.read++;
    f.files.set(target.path, new SyntheticFile(target.path));
    return f.content.get(target);
  };
  await assert.rejects(f.service.completeItemFromNativeNotification(f.item), /not applied/i);
  assert.deepEqual(f.events, []);
});

test('direct note Complete also rejects a refused GCM write', async () => {
  const f = fixture();
  await assert.rejects(f.service.markFileComplete(f.file), /not applied/i);
  assert.equal(f.counters.fallback, 0);
  assert.deepEqual(f.events, []);
});

test('the GCM updateFrontmatter route cannot report an unapplied status as successful', async () => {
  const f = fixture();
  delete f.bulkEdit.setStatus;
  await assert.rejects(f.service.completeItemFromNativeNotification(f.item), /not applied/i);
  assert.equal(f.counters.fallback, 0);
  assert.deepEqual(f.events, []);
});

test('invalid GCM result does not count as a committed completion', async () => {
  const f = fixture({ status: 'complete' });
  f.setStatusOperation(async () => undefined);
  await assert.rejects(f.service.completeItemFromNativeNotification(f.item), /not applied/i);
});

test('committed completion plus rename removes the original reminder from the actual projection', async () => {
  const f = fixture();
  const originalPath = f.file.path;
  const before = await f.engine.projectScheduledNotifications(f.settings, f.now, 30 * 60 * 1000);
  assert.ok(before.length > 0);
  assert.ok(before.every(item => item.sourcePath === originalPath));
  f.setStatusOperation(async next => {
    f.save({ ...f.properties, status: next });
    f.rename('Inbox/2026-10-05 Synthetic overdue note.md');
    return 1;
  });
  assert.equal(await f.service.completeItemFromNativeNotification(f.item), true);
  const after = await f.engine.projectScheduledNotifications(f.settings, f.now, 30 * 60 * 1000);
  assert.deepEqual(after, []);
  assert.equal(f.files.size, 1);
  assert.equal(f.files.has(originalPath), false);
  assert.match(f.content.get(f.file), /Preserve this body\./);
});

test('a refused completion does not remove the original source from reminder projection', async () => {
  const f = fixture();
  const before = await f.engine.projectScheduledNotifications(f.settings, f.now, 30 * 60 * 1000);
  assert.ok(before.length > 0);
  await assert.rejects(f.service.completeItemFromNativeNotification(f.item), /not applied/i);
  const after = await f.engine.projectScheduledNotifications(f.settings, f.now, 30 * 60 * 1000);
  assert.deepEqual(after, before);
  assert.equal(f.files.size, 1);
});

test('the first projection after saved completion ignores still-working metadata', async () => {
  const f = fixture({ status: 'complete', metadataStatus: 'working' });
  const schedule = await f.engine.projectScheduledNotifications(f.settings, f.now, 30 * 60 * 1000);
  assert.deepEqual(schedule, []);
  assert.equal(f.counters.read, 1);
  assert.equal(f.counters.cachedRead, 0);
  assert.equal(f.counters.scans, 1);
});

test('the first projection after authored reopening ignores still-complete metadata', async () => {
  const f = fixture({ status: 'working', metadataStatus: 'complete' });
  const schedule = await f.engine.projectScheduledNotifications(f.settings, f.now, 30 * 60 * 1000);
  assert.ok(schedule.length > 0);
  assert.equal(f.counters.read, 1);
  assert.equal(f.counters.cachedRead, 0);
  assert.equal(f.counters.scans, 1);
});

for (const removedFrontmatter of [false, true]) {
  test(`current source ${removedFrontmatter ? 'without frontmatter' : 'without scheduled'} removes a cached reminder`, async () => {
    const f = fixture();
    f.content.set(f.file, removedFrontmatter ? 'Only the preserved body.\n' : '---\ntitle: Still a note\n---\nPreserved body.\n');
    assert.deepEqual(await f.engine.projectScheduledNotifications(f.settings, f.now, 30 * 60 * 1000), []);
    assert.equal(f.counters.read, 1);
    assert.equal(f.counters.cachedRead, 0);
    assert.equal(f.counters.scans, 1);
  });
}

for (const [invalidSource, source] of [
  ['malformed YAML', 'status: [unterminated'],
  ['incomplete frontmatter', null],
  ['read failure', null],
  ['scalar timestamp', '2026-10-05'],
  ['scalar null', 'null'],
  ['scalar string', 'complete'],
  ['list', '- complete'],
]) {
  test(`projection refuses uncertain ${invalidSource} rather than stale reminders or authoritative empty`, async () => {
    const f = fixture();
    if (invalidSource === 'read failure') f.app.vault.read = async () => { throw new Error('Synthetic disk failure'); };
    else f.content.set(f.file, invalidSource === 'incomplete frontmatter' ? '---\nstatus: complete\n' : `---\n${source}\n---\nBody\n`);
    await assert.rejects(f.engine.projectScheduledNotifications(f.settings, f.now, 30 * 60 * 1000));
    assert.equal(f.counters.scans, 1);
    assert.equal(f.counters.cachedRead, 0);
  });
}

for (const source of ['', '# Empty property map', '{}']) {
  test(`an intentionally empty property map removes a cached reminder: ${JSON.stringify(source)}`, async () => {
    const f = fixture();
    f.content.set(f.file, `---\n${source}\n---\nPreserved body.\n`);
    assert.deepEqual(await f.engine.projectScheduledNotifications(f.settings, f.now, 30 * 60 * 1000), []);
    assert.equal(f.counters.read, 1);
  });
}

test('status clear accepts an authored no-op only when a valid map actually omits the status', async () => {
  const f = fixture();
  f.content.set(f.file, '---\ntitle: Still a note\n---\nBody\n');
  await f.service.setItemStatus(f.item, null);
  assert.equal(f.counters.read, 1);
  assert.equal(f.counters.fallback, 0);
  f.content.set(f.file, '---\nnull\n---\nBody\n');
  await assert.rejects(f.service.setItemStatus(f.item, null), /not applied/i);
});

test('fresh source title and tags replace cached values in one authoritative candidate read', async () => {
  const f = fixture();
  f.metadata.set(f.file, { ...f.properties, kind: 'calendar-event', eventTitle: 'Stale title', tags: ['blocked'] });
  f.content.set(f.file, `---\n${stringifyYaml({ ...f.properties, kind: 'calendar-event', eventTitle: 'Current title', tags: ['allowed'] })}---\nBody #current-tag.\n`);
  f.settings.globalIgnoreTags = ['blocked'];
  const schedule = await f.engine.projectScheduledNotifications(f.settings, f.now, 30 * 60 * 1000);
  assert.ok(schedule.length > 0);
  assert.ok(schedule.every(item => item.title === 'Current title'));
  assert.equal(f.counters.read, 1);
  assert.equal(f.counters.cachedRead, 0);
});

test('authoritative projection does not read unrelated notes or add a second vault scan', async () => {
  const f = fixture();
  for (let index = 0; index < 1000; index++) {
    const file = new SyntheticFile(`Ordinary/Unrelated ${index}.md`);
    f.files.set(file.path, file);
    f.metadata.set(file, {});
  }
  for (let index = 0; index < 3; index++) {
    assert.ok((await f.engine.projectScheduledNotifications(f.settings, f.now, 30 * 60 * 1000)).length > 0);
    assert.equal(f.counters.read, index + 1);
    assert.equal(f.counters.cachedRead, 0);
    assert.equal(f.counters.scans, index + 1);
  }
});

test('display-only overdue calculation reuses cached body content with its current frontmatter', async () => {
  const f = fixture({ status: 'complete', metadataStatus: 'working' });
  assert.deepEqual(await f.service.getOverdueItems(), []);
  assert.equal(f.counters.read, 0);
  assert.equal(f.counters.cachedRead, 1);
  assert.equal(f.counters.scans, 1);
});

test('authoritative projection rejects a file that is replaced during its current source read', async () => {
  const f = fixture();
  f.app.vault.read = async target => {
    f.files.set(target.path, new SyntheticFile(target.path));
    return f.content.get(target);
  };
  await assert.rejects(f.engine.projectScheduledNotifications(f.settings, f.now, 30 * 60 * 1000));
});
