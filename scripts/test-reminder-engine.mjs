import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {execFileSync} from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import moment from 'moment';
import ts from 'typescript';
import { load as parseYaml, dump as stringifyYaml } from 'js-yaml';
import './test-notification-open-lifecycle.mjs';
const mainSource = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const overdueSource = readFileSync(new URL('../src/services/overdue-service.ts', import.meta.url), 'utf8');
const reminderCandidateSource = readFileSync(new URL('../src/services/reminder-candidate-service.ts', import.meta.url), 'utf8');
const reminderTargetSource = readFileSync(new URL('../src/services/reminder-target-service.ts', import.meta.url), 'utf8');
const reminderSettingsSource = readFileSync(new URL('../src/services/reminder-settings-service.ts', import.meta.url), 'utf8');
const reminderDeliveryWindowSource = readFileSync(new URL('../src/services/reminder-delivery-window.ts', import.meta.url), 'utf8');
const timeCalculationSource = readFileSync(new URL('../src/utils/time-calculation-service.ts', import.meta.url), 'utf8');
const utilsSource = readFileSync(new URL('../src/utils.ts', import.meta.url), 'utf8');
const notificationViewSource = readFileSync(new URL('../src/views/notification-view.ts', import.meta.url), 'utf8');
const notificationSignatureSource = readFileSync(new URL('../src/views/notification-view-signature.ts', import.meta.url), 'utf8');
const settingsTabSource = readFileSync(new URL('../src/settings-tab.ts', import.meta.url), 'utf8');
const typesSource = readFileSync(new URL('../src/types.ts', import.meta.url), 'utf8');
const gcmApiSource = readFileSync(new URL('../src/tps-gcm-api.ts', import.meta.url), 'utf8');

function getFrontMatterInfo(content) {
  const source = content.replace(/^\ufeff/u, '');
  const match = /^---\r?\n/u.test(source) ? source.match(/^---\r?\n([\s\S]*?)^---(?:\r?\n|$)/mu) : null;
  return { exists: !!match, frontmatter: match?.[1] || '' };
}

function loadTpsGcmApiModule() {
  const compiled = ts.transpileModule(gcmApiSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018 },
  });
  const module = { exports: {} };
  const requireStub = (id) => {
    if (id === './tps-contracts') return { TPS_EVENTS: {}, TPS_LEGACY_EVENTS: {} };
    throw new Error(`Unexpected require: ${id}`);
  };
  const load = new Function('module', 'exports', 'require', compiled.outputText);
  load(module, module.exports, requireStub);
  return module.exports;
}

function loadReminderTargetModule(taskSchedulePolicy = { available: false, isDailyNote: false, inheritUnscheduled: true }, onPolicyRead = () => {}) {
  const compiled = ts.transpileModule(reminderTargetSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018 },
  });
  const module = { exports: {} };
  const requireStub = (id) => {
    if (id === '../tps-gcm-api') {
      return {
        buildCalendarExternalId: () => 'calendar:test',
        getDailyNoteTaskSchedulePolicyViaGcm: () => {
          onPolicyRead();
          return taskSchedulePolicy;
        },
      };
    }
    if (id === 'obsidian') return { getFrontMatterInfo, parseYaml };
    throw new Error(`Unexpected require: ${id}`);
  };
  const load = new Function('module', 'exports', 'require', compiled.outputText);
  load(module, module.exports, requireStub);
  return module.exports;
}

function loadReminderSettingsModule() {
  const compiled = ts.transpileModule(reminderSettingsSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018 },
  });
  const module = { exports: {} };
  const requireStub = (id) => {
    throw new Error(`Unexpected require: ${id}`);
  };
  const load = new Function('module', 'exports', 'require', compiled.outputText);
  load(module, module.exports, requireStub);
  return module.exports;
}

function loadReminderBaseViewModule(TFile) {
  const source = readFileSync(new URL('../src/services/reminder-base-view-service.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018 },
  });
  const module = { exports: {} };
  new Function('module', 'exports', 'require', compiled.outputText)(module, module.exports, id => {
    if (id === 'obsidian') return { TFile, parseYaml, normalizePath: value => String(value || '').replace(/^\/+|\/+$/gu, '') };
    throw new Error(`Unexpected Base selector require: ${id}`);
  });
  return module.exports;
}

function loadReminderDeliveryWindowModule() {
  const compiled = ts.transpileModule(reminderDeliveryWindowSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018 },
  });
  const module = { exports: {} };
  const requireStub = (id) => {
    throw new Error(`Unexpected require: ${id}`);
  };
  const load = new Function('module', 'exports', 'require', compiled.outputText);
  load(module, module.exports, requireStub);
  return module.exports;
}

function loadReminderCandidateModule() {
  const compiled = ts.transpileModule(reminderCandidateSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018 },
  });
  const module = { exports: {} };
  const requireStub = (id) => {
    throw new Error(`Unexpected require: ${id}`);
  };
  const load = new Function('module', 'exports', 'require', compiled.outputText);
  load(module, module.exports, requireStub);
  return module.exports;
}

function loadNotificationSignatureModule() {
  const compiled = ts.transpileModule(notificationSignatureSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018 },
  });
  const module = { exports: {} };
  const requireStub = (id) => {
    throw new Error(`Unexpected require: ${id}`);
  };
  const load = new Function('module', 'exports', 'require', compiled.outputText);
  load(module, module.exports, requireStub);
  return module.exports;
}

function loadTimeCalculationModule(getAllTags = () => []) {
  const compiled = ts.transpileModule(timeCalculationSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018 },
  });
  const module = { exports: {} };
  const requireStub = (id) => {
    if (id === 'obsidian') {
      return {
        moment,
        getAllTags,
      };
    }
    if (id === '../utils') {
      return loadUtilsModule();
    }
    throw new Error(`Unexpected require: ${id}`);
  };
  const load = new Function('module', 'exports', 'require', compiled.outputText);
  load(module, module.exports, requireStub);
  return module.exports;
}

function loadUtilsModule() {
  const compiled = ts.transpileModule(utilsSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018 },
  });
  const module = { exports: {} };
  const load = new Function('module', 'exports', 'require', compiled.outputText);
  load(module, module.exports, () => {
    throw new Error('Controller utils must not load external modules');
  });
  return module.exports;
}

function loadCompiledOverdueServiceHarness(options = {}) {
  const notices = [];
  const logs = [];
  const openedModals = [];
  const moveCalls = [];
  let moveImplementation = async () => ({ available: false, result: null });

  class TestTFile {
    constructor(path) {
      this.path = path;
      this.name = path.split('/').pop() || path;
      this.extension = this.name.includes('.') ? this.name.split('.').pop() : '';
      this.basename = this.name.replace(/\.[^.]+$/u, '');
    }
  }

  class TestFuzzySuggestModal {
    constructor(app) {
      this.app = app;
    }

    setPlaceholder(value) {
      this.placeholder = value;
    }

    open() {
      openedModals.push(this);
      return this;
    }

    onClose() {}
  }

  class TestNotice {
    constructor(message) {
      notices.push(String(message));
    }
  }

  const logger = {};
  for (const level of ['log', 'warn', 'error', 'flow', 'flowWarn', 'flowError']) {
    logger[level] = (...args) => logs.push({ level, args });
  }

  const compiled = ts.transpileModule(overdueSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018 },
  });
  const module = { exports: {} };
  const requireStub = (id) => {
    if (id === 'obsidian') {
      return {
        App: class {},
        FuzzySuggestModal: TestFuzzySuggestModal,
        MarkdownView: class {},
        Notice: TestNotice,
        TFile: TestTFile,
        WorkspaceLeaf: class {},
        moment: () => ({ isValid: () => false, format: () => '' }),
      };
    }
    if (id === '../views/notification-view') return { NOTIFICATION_VIEW_TYPE: 'tps-notifications' };
    if (id === '../logger') return logger;
    if (id === '../utils/time-calculation-service') {
      return {
        parseDate: options.parseDate || (() => null),
        parseTimeRange: options.parseTimeRange || (() => ({ start: null, end: null })),
        parseDuration: () => 0,
        getEffectiveEndTime: () => null,
        formatTemplate: () => '',
        checkStopCondition: () => false,
        hasRequiredStatus: () => true,
        hasRequiredCheckboxState: () => true,
        shouldIgnoreForReminder: options.shouldIgnoreForReminder || (() => false),
        isAllDayEvent: () => false,
        hasExplicitTimeInValue: () => false,
        getReminderTriggerBase: options.getReminderTriggerBase || (() => null),
        getReminderCancellationStatuses: options.getReminderCancellationStatuses || ((_fm, status) => [status]),
      };
    }
    if (id === './reminder-target-service') {
      return {
        buildReminderTargetsForFile: options.buildReminderTargetsForFile || (async () => []),
        buildEffectiveReminderContextForTarget: options.buildEffectiveReminderContextForTarget || (() => null),
        buildReminderDisplayName: () => '',
        getReminderTagsForTarget: (target) => target?.reminderTags,
      };
    }
    if (id === './reminder-base-view-service') return loadReminderBaseViewModule(TestTFile);
    if (id === './reminder-candidate-service') {
      return { getReminderCandidateFiles: async () => ({ files: options.candidateFiles || [], stats: {} }) };
    }
    if (id === './reminder-delivery-window') {
      return {
        getFileReminderLiveWindowMs: () => 60_000,
        shouldSkipStaleOneShotReminder: () => false,
      };
    }
    if (id === '../tps-contracts') {
      return {
        TPS_EVENTS: { FILES_UPDATED: 'tps:files-updated' },
        TPS_LEGACY_EVENTS: { GCM_FILES_UPDATED: 'tps-gcm-files-updated' },
      };
    }
    if (id === '../tps-gcm-api') {
      return {
        emitFilesUpdated: () => {},
        getInternalIdPropertyKey: loadTpsGcmApiModule().getInternalIdPropertyKey,
        async moveTaskViaGcm(...args) {
          moveCalls.push(args);
          return moveImplementation(...args);
        },
      };
    }
    throw new Error(`Unexpected require: ${id}`);
  };
  const load = new Function('module', 'exports', 'require', compiled.outputText);
  load(module, module.exports, requireStub);

  return {
    OverdueService: module.exports.OverdueService,
    TFile: TestTFile,
    notices,
    logs,
    openedModals,
    moveCalls,
    setMoveImplementation(implementation) {
      moveImplementation = implementation;
    },
    reset() {
      notices.length = 0;
      logs.length = 0;
      openedModals.length = 0;
      moveCalls.length = 0;
    },
  };
}

function buildCanonicalCalendarRecordId(calendarId, occurrenceIdentity) {
  const digest = (value, bytes) => createHash('sha256')
    .update(String(value), 'utf8')
    .digest()
    .subarray(0, bytes)
    .toString('base64url');
  return `calendar:v1:${digest(calendarId, 12)}:${digest(`${calendarId}\0${occurrenceIdentity}`, 20)}`;
}

function beginCompiledReminderMove(harness) {
  const sourceFile = new harness.TFile('Daily/2026-08-10.md');
  const targetFile = new harness.TFile('Projects/Alpha.md');
  const laterTargetFile = new harness.TFile('Projects/Zulu.md');
  const app = {
    vault: {
      getMarkdownFiles: () => [laterTargetFile, sourceFile, targetFile],
    },
  };
  const service = new harness.OverdueService(app, () => ({
    startProperty: 'scheduled',
    statusKey: 'status',
  }));
  const item = {
    file: sourceFile,
    targetKind: 'task',
    taskLine: 12.8,
    taskRawLine: '- [ ] Move me [scheduled:: 2026-08-10 09:00] [id:: task_move]',
    taskTitle: 'Move me',
    noteTitle: sourceFile.basename,
    reminderProperty: 'scheduled',
    reminderPropertySource: 'note',
    reminder: { property: 'scheduled' },
  };
  const pending = service.resolveTaskReminder(item);
  assert.equal(harness.openedModals.length, 1, 'target picker should open synchronously');
  return {
    app,
    item,
    pending,
    sourceFile,
    targetFile,
    laterTargetFile,
    modal: harness.openedModals[0],
  };
}

test('native-record canonical ISO timestamps preserve their time and zone before embedded-date parsing', () => {
  const { parseDate, parseTimeRange } = loadTimeCalculationModule();
  const pocTimestamp = '2026-08-27T13:30:00.000Z';
  const offsetTimestamp = '2026-08-27T08:30:00.000-05:00';

  assert.equal(parseDate(pocTimestamp), Date.parse(pocTimestamp));
  assert.equal(parseTimeRange(pocTimestamp).start, Date.parse(pocTimestamp));
  assert.equal(parseDate(offsetTimestamp), Date.parse(offsetTimestamp));
  assert.equal(
    parseDate(offsetTimestamp),
    parseDate(pocTimestamp),
    'equivalent Z and offset timestamps must resolve to the same instant',
  );
});

test('reminder ignore paths match archive folders at any path boundary for notes and tasks', () => {
  const { matchesExclusionPattern, normalizeComparablePath } = loadUtilsModule();
  const { shouldIgnoreForReminder } = loadTimeCalculationModule();
  const rootFile = { path: '_archive/Root note.md', basename: 'Root note' };
  const prefixedFile = { path: 'Markdown/_archive/Nested task note.md', basename: 'Nested task note' };
  const lookalikeFile = { path: 'Markdown/_archive-old/Keep.md', basename: 'Keep' };
  const reminder = { ignorePaths: ['path:_archive'] };

  const matches = (file, pattern) => matchesExclusionPattern(
    normalizeComparablePath(file.path),
    normalizeComparablePath(file.basename),
    pattern,
  );

  assert.equal(matches(rootFile, '_archive'), true);
  assert.equal(matches(prefixedFile, '_archive'), true);
  assert.equal(matches(prefixedFile, '_archive/'), true);
  assert.equal(matches(prefixedFile, 'path:_archive'), true);
  assert.equal(matches(lookalikeFile, '_archive'), false);

  assert.equal(shouldIgnoreForReminder(rootFile, null, {}, {}, ['_archive'], [], [], []), true);
  assert.equal(shouldIgnoreForReminder(prefixedFile, null, {}, {}, ['_archive'], [], [], []), true);
  assert.equal(shouldIgnoreForReminder(prefixedFile, null, { targetKind: 'task' }, reminder, [], [], [], []), true);
  assert.equal(shouldIgnoreForReminder(lookalikeFile, null, {}, reminder, [], [], [], []), false);
});

test('reminder settings normalization preserves live editor objects across rapid text input', () => {
  const { normalizeReminderSettingsInPlace } = loadReminderSettingsModule();
  const reminders = [{
    requiredStatuses: [],
    sourceTypes: ['file', 'invalid'],
  }];
  const editorRule = reminders[0];

  for (const value of ['t', 'to', 'tod', 'todo']) {
    editorRule.requiredStatuses = [value];
    normalizeReminderSettingsInPlace(reminders);
    assert.equal(reminders[0], editorRule);
  }

  assert.deepEqual(reminders[0].requiredStatuses, ['todo']);
  assert.deepEqual(reminders[0].sourceTypes, ['file']);
  assert.deepEqual(reminders[0].ignoreCheckboxStates, []);
  assert.deepEqual(reminders[0].requiredCheckboxStates, []);
  editorRule.ignoreCheckboxStates = ['x'];
  editorRule.requiredCheckboxStates = [' '];
  normalizeReminderSettingsInPlace(reminders);
  assert.deepEqual(editorRule.ignoreCheckboxStates, [], 'saved task-line filters cannot affect note reminders');
  assert.deepEqual(editorRule.requiredCheckboxStates, [], 'saved task-line requirements cannot suppress note reminders');
  assert.match(mainSource, /normalizeReminderSettingsInPlace\(this\.settings\.reminders \|\| \[\]\)/);
  assert.doesNotMatch(mainSource, /const normalizedReminder = \{ \.\.\.reminder \}/);
});

test('overdue reminder status writes delegate to GCM bulk edit guards when available', () => {
  assert.match(overdueSource, /private getGcmBulkEditService\(\): any \| null/);
  assert.match(overdueSource, /bulkEditService\.setStatus\(\[item\.file\], resolvedStatus\)/);
  assert.match(overdueSource, /bulkEditService\.updateFrontmatter\(\[item\.file\], \{ \[statusKey\]: null \}\)/);
});

test('status and snooze clear actions delete only their configured properties', () => {
  assert.match(overdueSource, /const isStatusClear = status == null \|\| String\(status\)\.trim\(\) === ""/);
  assert.match(overdueSource, /if \(existingStatusKey\) delete fm\[existingStatusKey\]/);
  assert.match(overdueSource, /if \(snoozeTimeStr\) \{[\s\S]*fm\[existingSnoozeKey \|\| snoozeKey\] = snoozeTimeStr;[\s\S]*delete fm\[existingSnoozeKey\]/);
  assert.doesNotMatch(overdueSource, /fm\[snoozeKey\] = snoozeTimeStr/);
  assert.match(notificationViewSource, /const isStatusClear = newStatus == null \|\| String\(newStatus\)\.trim\(\) === ''/);
  assert.match(notificationViewSource, /if \(existingStatusKey\) delete fm\[existingStatusKey\]/);
  assert.doesNotMatch(notificationViewSource, /fm\[statusKey\] = ''/);
});

test('notification command expands and focuses the sidebar view leaf', () => {
  assert.match(overdueSource, /workspace\.detachLeavesOfType\(NOTIFICATION_VIEW_TYPE\)/);
  assert.match(overdueSource, /ensureSideLeaf\(NOTIFICATION_VIEW_TYPE, "right"/);
  assert.match(overdueSource, /await workspace\.revealLeaf\(leaf\)/);
  assert.match(overdueSource, /workspace\.setActiveLeaf\(leaf, \{ focus: true \}\)/);
  assert.match(overdueSource, /void workspace\.requestSaveLayout\(\)/);
  assert.doesNotMatch(overdueSource, /getRightLeaf\(true\)/);
  assert.doesNotMatch(overdueSource, /leaf\.setViewState/);
  assert.doesNotMatch(overdueSource, /rightSplit/);
  assert.doesNotMatch(overdueSource, /activateLeafTab/);
  assert.doesNotMatch(overdueSource, /leaf\.loadIfDeferred/);
  assert.doesNotMatch(overdueSource, /await \(leaf\.view as any\)\?\.refresh\?\.\(\)/);
});

test('reminder candidate discovery normalizes own frontmatter keys without a per-file key collection', async () => {
  const { getReminderCandidateFiles } = loadReminderCandidateModule();
  const files = [
    { path: 'Zeta.md' },
    { path: 'None.md' },
    { path: 'Inherited.md' },
    { path: 'Inline.md' },
    { path: 'Alpha.md' },
  ];
  const inheritedFrontmatter = Object.create({ scheduled: '2026-07-28' });
  inheritedFrontmatter.other = true;
  const frontmatterByPath = new Map([
    ['Zeta.md', { '  SCHEDULED  ': '2026-07-28' }],
    ['None.md', { unrelated: true }],
    ['Inherited.md', inheritedFrontmatter],
    ['Inline.md', { unrelated: true }],
    ['Alpha.md', { DuE: '2026-07-28' }],
  ]);
  const contentByPath = new Map([
    ['None.md', 'No reminder here.'],
    ['Inherited.md', 'Inherited frontmatter properties are not candidates.'],
    ['Inline.md', '- [ ] Follow up [ Scheduled :: 2026-07-28]'],
  ]);
  const cachedReads = [];
  const app = {
    metadataCache: {
      getFileCache(file) {
        return { frontmatter: frontmatterByPath.get(file.path) };
      },
    },
    vault: {
      getMarkdownFiles() {
        return files.slice();
      },
      async cachedRead(file) {
        cachedReads.push(file.path);
        return contentByPath.get(file.path) || '';
      },
    },
  };

  const result = await getReminderCandidateFiles(app, {}, [' scheduled ', 'dUe', '  ']);

  assert.deepEqual(result.files.map(({ path }) => path), ['Alpha.md', 'Zeta.md']);
  assert.deepEqual(cachedReads, []);
});

for (const scenario of [
  { name: 'explicit none', mode: 'none', reads: 0 },
  { name: 'GCM native records', mode: 'gcm', architecture: 'native-records', reads: 0 },
  { name: 'GCM unavailable', mode: 'gcm', reads: 0 },
  { name: 'GCM map fallback', mode: 'gcm', architecture: 'native-records', mapFallback: true, reads: 0 },
  { name: 'GCM legacy', mode: 'gcm', architecture: 'legacy', reads: 0 },
  { name: 'explicit scheduled', mode: 'scheduled', reads: 0 },
  { name: 'explicit all', mode: 'all', reads: 0 },
  { name: 'missing mode uses whole notes', reads: 0 },
]) {
  test(`reminder discovery avoids impossible inline work: ${scenario.name}`, async () => {
    const { getReminderCandidateFiles } = loadReminderCandidateModule();
    const files = Array.from({ length: 1000 }, (_, index) => ({ path: `Ordinary/${index}.md` }));
    const task = { path: 'Task.md' };
    const note = { path: 'Scheduled.md' };
    files.push(task, note);
    let reads = 0;
    const gcm = scenario.architecture ? { settings: { dataArchitectureMode: scenario.architecture } } : undefined;
    const app = {
      plugins: scenario.mapFallback
        ? { plugins: { 'tps-global-context-menu': gcm } }
        : { getPlugin: () => gcm },
      metadataCache: { getFileCache: (file) => ({
        frontmatter: file === note ? { SCHEDULED: '2026-09-27', tags: ['note-tag'] } : {},
        // Deliberately stale/empty task metadata must not hide an enabled task.
        listItems: [],
      }) },
      vault: {
        getMarkdownFiles: () => files.slice(),
        cachedRead: async (file) => { reads++; return file === task ? '- [ ] New task [scheduled:: 2026-09-27]' : 'Plain body'; },
      },
    };
    const settings = scenario.mode === undefined ? {} : { inlineTaskReminders: scenario.mode };
    for (let repeat = 0; repeat < 3; repeat++) {
      const result = await getReminderCandidateFiles(app, settings, ['scheduled']);
      assert.equal(reads, scenario.reads * (repeat + 1));
      assert.deepEqual(result.files.map(file => file.path), scenario.reads === 0 ? ['Scheduled.md'] : ['Scheduled.md', 'Task.md']);
    }
  });
}

test('stale inline reminder actions never read or mutate the containing note', async () => {
  const harness = loadCompiledOverdueServiceHarness();
  let operations = 0;
  const app = {
    vault: {
      cachedRead: async () => { operations++; throw new Error('unexpected read'); },
      modify: async () => { operations++; throw new Error('unexpected write'); },
    },
    fileManager: {
      processFrontMatter: async () => { operations++; throw new Error('unexpected frontmatter write'); },
    },
  };
  const service = new harness.OverdueService(app, () => ({ statusKey: 'status', snoozeProperty: 'reminderSnooze' }));
  const item = {
    file: new harness.TFile('Daily/2026-08-10.md'),
    targetKind: 'task',
    taskLine: 2,
    reminder: { property: 'scheduled' },
  };

  await service.setItemStatus(item, 'complete');
  await service.snoozeItem(item, 10);
  assert.equal(await service.completeItemFromNativeNotification(item), false);
  assert.equal(await service.snoozeItemFromNativeNotification(item, 10), false);
  assert.equal(await service.resolveTaskReminder(item), false);
  assert.equal(operations, 0);
  assert.equal(harness.openedModals.length, 0);
  assert.equal(harness.moveCalls.length, 0);
});

test('reminder target builder ignores task lines inside and outside code fences', async () => {
  const { buildReminderTargetsForFile } = loadReminderTargetModule();
  const content = [
    'Before',
    '```md',
    '- [ ] [[Contract Summary|Draft contract summary]] [scheduled:: 2026-06-23]',
    '```',
    '- [ ] [[Real Task]] [scheduled:: 2026-06-24]',
  ].join('\n');
  const app = { vault: { cachedRead: async () => content } };
  const file = { path: 'Notes/TPS System Contract.md', basename: 'TPS System Contract', extension: 'md' };
  const targets = await buildReminderTargetsForFile(app, file, {}, {});
  const taskTargets = targets.filter((target) => target.targetKind === 'task');

  assert.equal(taskTargets.length, 0);
  assert.deepEqual(targets.map((target) => target.targetKind), ['note']);
});

test('native calendar reminders use the semantic event title instead of a wikilink or dated filename', async () => {
  const { buildReminderDisplayName, buildReminderTargetsForFile } = loadReminderTargetModule();
  const file = {
    path: '2026-08-28 - Readable event record.md',
    basename: '2026-08-28 - Readable event record',
    extension: 'md',
  };
  const frontmatter = {
    kind: 'calendar-event',
    eventTitle: '  Semantic\n event   title  ',
    title: '[[2026-08-28 - Readable event record|Linked event title]]',
    scheduled: '2026-08-28T14:00:00.000Z',
  };
  const app = { vault: { cachedRead: async () => `---\n${stringifyYaml(frontmatter)}---\n` } };

  const [target] = await buildReminderTargetsForFile(app, file, frontmatter, {});

  assert.equal(target.noteTitle, 'Semantic event title');
  assert.equal(buildReminderDisplayName(file, target), 'Semantic event title');
  assert.doesNotMatch(buildReminderDisplayName(file, target), /\[\[|2026-08-28/);

  const regularFile = { basename: 'Project Notes' };
  assert.equal(buildReminderDisplayName(regularFile, { sourceType: 'file' }), 'Project Notes');
});

test('Controller consumes only the versioned GCM Daily Note task policy and falls back compatibly', () => {
  const { getDailyNoteTaskSchedulePolicyViaGcm } = loadTpsGcmApiModule();
  const file = { path: 'System/Dailynotes/2026-08-10.md', basename: '2026-08-10' };
  const app = {
    plugins: {
      getPlugin() {
        return {
          api: {
            dailyNotes: {
              version: 2,
              getTaskSchedulePolicy(received) {
                assert.equal(received, file);
                return { isDailyNote: true, inheritUnscheduled: false };
              },
            },
          },
        };
      },
    },
  };

  assert.deepEqual(getDailyNoteTaskSchedulePolicyViaGcm(app, file), {
    available: true,
    isDailyNote: true,
    inheritUnscheduled: false,
  });
  app.plugins.getPlugin = () => ({ api: { dailyNotes: { version: 1 } } });
  assert.deepEqual(getDailyNoteTaskSchedulePolicyViaGcm(app, file), {
    available: false,
    isDailyNote: false,
    inheritUnscheduled: true,
  });
});

test('notification sidebar uses task icons for task reminder rows', () => {
  assert.match(notificationViewSource, /private getItemIcon\(item: OverdueItem\): \{ icon: string; color: string \}/);
  assert.match(notificationViewSource, /if \(item\.targetKind === 'task'\) \{/);
  assert.match(notificationViewSource, /return \{ icon: 'check-square', color: 'var\(--text-muted\)' \}/);
  assert.match(notificationViewSource, /const \{ icon: iconName, color: iconColor \} = this\.getItemIcon\(item\)/);
  assert.doesNotMatch(notificationViewSource, /const iconName = rawIcon\.includes\(': '\)/);
});

test('notification actions wrap below titles and status menus support keyboard positioning', () => {
  assert.match(notificationViewSource, /content\.createDiv\(\{ cls: 'tps-notification-actions' \}\)/);
  assert.match(notificationViewSource, /actions\.style\.flexWrap = 'wrap'/);
  assert.doesNotMatch(notificationViewSource, /actions\.style\.position = 'absolute'/);
  assert.match(notificationViewSource, /statusPill\.getBoundingClientRect\(\)/);
  assert.match(notificationViewSource, /menu\.showAtPosition/);
});

test('notification view redraw signature includes visible row and action fields', () => {
  const { buildNotificationItemsSignature } = loadNotificationSignatureModule();
  const base = {
    file: { path: 'Inbox/Reminder.md', basename: 'Reminder' },
    reminder: { id: 'scheduled', property: 'scheduled' },
    propertyTime: 0,
    diff: 'Due now',
    id: '1',
    sourceKey: 'Inbox/Reminder.md::task:3',
    sourceType: 'file',
    targetKind: 'task',
    taskTitle: 'Original task',
    noteTitle: 'Reminder',
    taskLine: 3,
    taskRawLine: '- [ ] Original task [scheduled:: 2026-07-04]',
    reminderProperty: 'scheduled',
    reminderPropertySource: 'task',
    status: 'open',
    icon: 'file-text',
    color: '#4c76ae',
    isAllDay: false,
  };
  const signature = (patch) => buildNotificationItemsSignature([{ ...base, ...patch }]);

  assert.notEqual(signature({}), signature({ taskTitle: 'Renamed task' }));
  assert.notEqual(signature({}), signature({ noteTitle: 'Different source note' }));
  assert.notEqual(signature({}), signature({ icon: 'calendar', color: '#ff0000' }));
  assert.notEqual(signature({}), signature({ reminderPropertySource: 'note' }));
  assert.notEqual(signature({}), signature({ sourceType: 'external-event', targetKind: 'external-event' }));
  assert.notEqual(signature({}), signature({ diff: 'Snoozed until 14:00' }));
  assert.notEqual(signature({}), signature({ taskRawLine: '- [ ] Updated task [scheduled:: 2026-07-04]' }));
});

test('notification item opens use the GCM pinned-safe file opener', () => {
  assert.match(overdueSource, /plugins\?\.plugins\?\.\["tps-global-context-menu"\]/);
  assert.match(overdueSource, /gcm\.openFileInLeaf\(file, false, \(\) => this\.app\.workspace\.getLeaf\(false\), \{/);
  assert.match(overdueSource, /active: true/);
  assert.match(overdueSource, /revealLeaf: true/);
  assert.match(overdueSource, /this\.findOpenMarkdownLeaf\(file\) \?\? this\.app\.workspace\.activeLeaf/);
  assert.match(overdueSource, /this\.app\.workspace\.getLeaf\(true\)/);
  assert.match(overdueSource, /this\.app\.workspace\.setActiveLeaf\(leaf, \{ focus: true \} as any\)/);
  assert.match(overdueSource, /private findOpenMarkdownLeaf\(file: TFile\): WorkspaceLeaf \| null/);
});

test('notification view renders reminder titles as clickable markdown links', () => {
  assert.match(notificationViewSource, /MarkdownRenderer/);
  assert.match(notificationViewSource, /private renderInlineMarkdownTitle/);
  assert.match(notificationViewSource, /MarkdownRenderer\.renderMarkdown\(source, container, sourcePath, this\)/);
  assert.match(notificationViewSource, /tps-notification-title/);
  assert.match(notificationViewSource, /a\.internal-link, a\.external-link/);
  assert.match(notificationViewSource, /a\.internal-link, a\[href\^="app:\/\/obsidian\.md\/"\]/);
  assert.match(notificationViewSource, /tps-notification-title-link/);
  assert.match(notificationViewSource, /private resolveRenderedInternalLink/);
  assert.match(notificationViewSource, /private getRenderedInternalLinkResolutionTarget/);
  assert.match(notificationViewSource, /replace\(\/#\.\*\/, ''\)/);
  assert.match(notificationViewSource, /getFirstLinkpathDest\(resolutionTarget, sourcePath\)/);
  assert.match(notificationViewSource, /link\.replaceWith\(document\.createTextNode\(link\.textContent \|\| ''\)\)/);
  assert.match(notificationViewSource, /private openRenderedTitleLink/);
  assert.match(notificationViewSource, /event\.stopPropagation\(\)/);
  assert.match(notificationViewSource, /this\.app\.workspace\.openLinkText\(normalized, sourcePath, false\)/);
  assert.doesNotMatch(notificationViewSource, /createEl\('span', \{ text: this\.getItemDisplayTitle\(item\) \}\)/);
});

test('migrated task records are never re-enqueued as reminders', () => {
  const { normalizeCheckboxState, shouldIgnoreForReminder } = loadTimeCalculationModule();
  const file = { path: 'Daily/2026-08-10.md', basename: '2026-08-10' };
  const reminder = {};

  assert.equal(normalizeCheckboxState('migrated'), '>');
  assert.equal(shouldIgnoreForReminder(file, null, { status: 'migrated' }, reminder, [], [], [], []), true);
  assert.equal(shouldIgnoreForReminder(file, null, { checkboxState: '>' }, reminder, [], [], [], []), true);
  assert.match(timeCalculationSource, /if \(statuses\.has\("migrated"\) \|\| checkboxStates\.has\(">"\)\) \{/);
});

test('legacy task blocks remain untouched by whole-note reminder discovery', async () => {
  const { buildReminderTargetsForFile } = loadReminderTargetModule();
  const file = { path: 'Daily/2026-08-10.md', basename: '2026-08-10', extension: 'md' };
  const app = {
    vault: {
      async cachedRead() {
        return [
          '- [>] Migrated root [migratedTo:: [[Projects/Target]]]',
          '  - [ ] Nested task [scheduled:: 2026-08-10 09:00]',
          '    supporting detail',
          '',
          '- [ ] Active task [scheduled:: 2026-08-10 10:00]',
        ].join('\n');
      },
    },
  };

  const targets = await buildReminderTargetsForFile(app, file, {}, {});
  assert.deepEqual(targets.map((target) => target.targetKind), ['note']);
});

test('notification sidebar refreshes are coalesced to avoid action lag', () => {
  assert.match(notificationViewSource, /private isRefreshing = false/);
  assert.match(notificationViewSource, /private refreshPending = false/);
  assert.match(notificationViewSource, /private lastRenderedSignature = '\\u0000'/);
  assert.match(notificationViewSource, /}, 750, false\)/);
  assert.doesNotMatch(notificationViewSource, /setInterval|registerEvent/);
  assert.match(notificationViewSource, /if \(this\.isRefreshing\) \{/);
  assert.match(notificationViewSource, /this\.refreshPending = true/);
  assert.match(notificationViewSource, /buildNotificationItemsSignature\(nextItems\)/);
  assert.match(notificationViewSource, /nextSignature !== this\.lastRenderedSignature/);
  assert.match(notificationViewSource, /\[NotificationView\] slow refresh/);
});


test('saved GCM architecture modes cannot re-enable inline reminder targets', async () => {
  const { buildReminderTargetsForFile } = loadReminderTargetModule();
  const file = {path: 'Inbox/Scope.md', basename: 'Scope', extension: 'md'};
  const app = {vault: {cachedRead: async () => '- [ ] Own [scheduled:: 2026-09-15]\n- [ ] Plain'}};
  const settings = {inlineTaskReminders: 'gcm'};
  assert.equal((await buildReminderTargetsForFile(app, file, {}, settings)).length, 1);
  app.plugins = {getPlugin: () => ({settings: {dataArchitectureMode: 'native-records'}})};
  assert.equal((await buildReminderTargetsForFile(app, file, {}, settings)).length, 1);
  app.plugins = {getPlugin: () => ({settings: {dataArchitectureMode: 'legacy'}})};
  assert.equal((await buildReminderTargetsForFile(app, file, {}, settings)).length, 1);
});


test('candidate discovery includes unresolved metadata conservatively without reading any body',async()=>{
  const {getReminderCandidateFiles}=loadReminderCandidateModule();
  const files=[{path:'Inbox/Unknown.md'},{path:'Inbox/Eligible.md'},{path:'Inbox/Ordinary.md'}];
  let scans=0;let reads=0;let metadata=0;
  const app={vault:{getMarkdownFiles(){scans++;return [...files];},cachedRead:async()=>{reads++;return '';}},
    metadataCache:{getFileCache(file){metadata++;return file.path.endsWith('Unknown.md')?null:{frontmatter:file.path.endsWith('Eligible.md')?{scheduled:'2026-10-08'}:{}};}}};
  const result=await getReminderCandidateFiles(app,{},['scheduled'],{includeUnknownMetadata:true});
  assert.deepEqual(result.files.map(f=>f.path),['Inbox/Eligible.md','Inbox/Unknown.md']);
  assert.deepEqual({scans,reads,metadata},{scans:1,reads:0,metadata:3});
});


test('truthy caches with absent or malformed property maps remain conservative reminder candidates',async()=>{
  const {getReminderCandidateFiles}=loadReminderCandidateModule();
  const cases=[{}, {frontmatter:null}, {frontmatter:[]}, {frontmatter:'bad'}];
  const files=cases.map((_,n)=>({path:`Inbox/Unknown ${n}.md`}));
  const app={vault:{getMarkdownFiles:()=>files},metadataCache:{getFileCache:file=>cases[files.indexOf(file)]}};
  const result=await getReminderCandidateFiles(app,{},['scheduled'],{includeUnknownMetadata:true});
  assert.deepEqual(result.files,files);
});


test('repeated whole-note display uses metadata without body reads, writes or GCM policy calls', async () => {
  let reads = 0;
  let policies = 0;
  const { buildReminderTargetsForFile, buildEffectiveReminderContextForTarget } = loadReminderTargetModule({}, () => { policies++; });
  const fail = () => { reads++; throw new Error('Display must not access the vault'); };
  const app = { vault: { read: fail, cachedRead: fail, process: fail, getMarkdownFiles: fail } };
  const file = { path: 'Example.md', basename: 'Example', extension: 'md' };
  for (const inlineTaskReminders of ['none', 'gcm', 'scheduled', 'all']) {
    for (let i = 0; i < 100; i++) {
      const fm = { scheduled: '2026-10-15', status: i % 2 ? 'complete' : 'todo' };
      const [target] = await buildReminderTargetsForFile(app, file, fm, { inlineTaskReminders });
      assert.equal(target.targetKind, 'note');
      assert.equal(target.reminderTags, undefined, 'whole-note tag filtering uses Obsidian metadata');
      const context = buildEffectiveReminderContextForTarget(target, fm, 'scheduled', {});
      assert.equal(context.frontmatter, fm);
      assert.equal(context.propertyValue, fm.scheduled);
    }
  }
  assert.equal(reads, 0);
  assert.equal(policies, 0);
});


test('whole-note ignored tags use existing metadata including nested body and frontmatter tags', async () => {
  const { buildReminderTargetsForFile, getReminderTagsForTarget } = loadReminderTargetModule();
  const { shouldIgnoreForReminder } = loadTimeCalculationModule(cache => cache.tags.map(entry => entry.tag));
  const file = { path: 'Example.md', basename: 'Example' };
  const [target] = await buildReminderTargetsForFile({}, file, {}, {});
  for (const tag of ['#archive', '#archive/child', '#ARCHIVE/child']) {
    assert.equal(shouldIgnoreForReminder(file, { tags: [{ tag }] }, {}, {}, [], ['archive'], [], [], getReminderTagsForTarget(target)), true);
  }
  assert.equal(shouldIgnoreForReminder(file, { tags: [{ tag: '#active' }] }, {}, {}, [], ['archive'], [], [], getReminderTagsForTarget(target)), false);
});
