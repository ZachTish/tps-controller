import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import moment from 'moment';
import ts from 'typescript';
import './test-notification-open-lifecycle.mjs';

const source = readFileSync(new URL('../src/services/reminder-engine.ts', import.meta.url), 'utf8');
const mainSource = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const overdueSource = readFileSync(new URL('../src/services/overdue-service.ts', import.meta.url), 'utf8');
const reminderCandidateSource = readFileSync(new URL('../src/services/reminder-candidate-service.ts', import.meta.url), 'utf8');
const reminderTargetSource = readFileSync(new URL('../src/services/reminder-target-service.ts', import.meta.url), 'utf8');
const reminderSettingsSource = readFileSync(new URL('../src/services/reminder-settings-service.ts', import.meta.url), 'utf8');
const reminderDeliveryWindowSource = readFileSync(new URL('../src/services/reminder-delivery-window.ts', import.meta.url), 'utf8');
const reminderRuntimePolicySource = readFileSync(new URL('../src/services/reminder-runtime-policy.ts', import.meta.url), 'utf8');
const timeCalculationSource = readFileSync(new URL('../src/utils/time-calculation-service.ts', import.meta.url), 'utf8');
const utilsSource = readFileSync(new URL('../src/utils.ts', import.meta.url), 'utf8');
const notificationViewSource = readFileSync(new URL('../src/views/notification-view.ts', import.meta.url), 'utf8');
const notificationSignatureSource = readFileSync(new URL('../src/views/notification-view-signature.ts', import.meta.url), 'utf8');
const overdueModalSource = readFileSync(new URL('../src/modals/overdue-modal.ts', import.meta.url), 'utf8');
const settingsTabSource = readFileSync(new URL('../src/settings-tab.ts', import.meta.url), 'utf8');
const typesSource = readFileSync(new URL('../src/types.ts', import.meta.url), 'utf8');
const gcmApiSource = readFileSync(new URL('../src/tps-gcm-api.ts', import.meta.url), 'utf8');

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

function loadReminderTargetModule(taskSchedulePolicy = { available: false, isDailyNote: false, inheritUnscheduled: true }) {
  const compiled = ts.transpileModule(reminderTargetSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018 },
  });
  const module = { exports: {} };
  const requireStub = (id) => {
    if (id === '../tps-gcm-api') {
      return {
        buildCalendarExternalId: () => 'calendar:test',
        getDailyNoteTaskSchedulePolicyViaGcm: () => taskSchedulePolicy,
      };
    }
    if (id === 'obsidian') return {};
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

function loadReminderRuntimePolicyModule() {
  const compiled = ts.transpileModule(reminderRuntimePolicySource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018 },
  });
  const module = { exports: {} };
  const load = new Function('module', 'exports', 'require', compiled.outputText);
  load(module, module.exports, () => {
    throw new Error('Reminder runtime policy must not load external modules');
  });
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

function loadTimeCalculationModule() {
  const compiled = ts.transpileModule(timeCalculationSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018 },
  });
  const module = { exports: {} };
  const requireStub = (id) => {
    if (id === 'obsidian') {
      return {
        moment,
        getAllTags: () => [],
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

function loadCompiledReminderEngineHarness(options = {}) {
  class TestTFile {
    constructor(path) {
      this.path = path;
      this.name = path.split('/').pop() || path;
      this.extension = this.name.includes('.') ? this.name.split('.').pop() : '';
      this.basename = this.name.replace(/\.[^.]+$/u, '');
    }
  }

  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018 },
  });
  const module = { exports: {} };
  const requireStub = (id) => {
    if (id === 'obsidian') {
      return {
        App: class {},
        TFile: TestTFile,
        moment: (...args) => moment(...args),
        normalizePath: (value) => String(value || '').replace(/^\/+|\/+$/gu, ''),
      };
    }
    if (id === '../logger') {
      return {
        flow: () => {},
        flowWarn: () => {},
        flowError: () => {},
        errorSummary: (error) => String(error),
      };
    }
    if (id === '../utils') {
      return {
        normalizeCalendarUrl: (value) => String(value || ''),
        parseFrontmatterDate: options.parseFrontmatterDate || (() => null),
      };
    }
    if (id === '../utils/time-calculation-service') {
      return {
        parseDate: options.parseDate || (() => null),
        parseTimeRange: options.parseTimeRange || (() => ({ start: Date.now() - 1_000, end: null })),
        parseDuration: options.parseDuration || (() => 0),
        getEffectiveEndTime: options.getEffectiveEndTime || (() => null),
        formatTemplate: options.formatTemplate || ((value) => String(value || '')),
        formatRemaining: options.formatRemaining || (() => 'due'),
        checkStopCondition: () => false,
        normalizeStatus: (value) => String(value || '').trim().toLowerCase(),
        getStatuses: () => [],
        hasRequiredStatus: () => true,
        hasRequiredCheckboxState: () => true,
        shouldIgnoreForReminder: options.shouldIgnoreForReminder,
        isAllDayEvent: options.isAllDayEvent || (() => false),
        hasExplicitTimeInValue: options.hasExplicitTimeInValue || (() => true),
        getReminderTriggerBase: options.getReminderTriggerBase || ((start) => start),
      };
    }
    if (id === './reminder-target-service') {
      return {
        buildReminderTargetsForFile: options.buildReminderTargetsForFile,
        buildEffectiveReminderContextForTarget: options.buildEffectiveReminderContextForTarget,
        buildReminderDisplayName: (file, target) => target.taskTitle || file.basename,
      };
    }
    if (id === './external-calendar-service') return { ExternalCalendarService: class {} };
    if (id === './reminder-candidate-service') {
      return { getReminderCandidateFiles: async () => ({ files: options.candidateFiles || [] }) };
    }
    if (id === './reminder-delivery-window') {
      return {
        getFileReminderLiveWindowMs: () => 60_000,
        shouldSkipStaleOneShotReminder: () => false,
      };
    }
    if (id === './calendar-record-identity') {
      return {
        calendarEventOccurrenceIdentity: (event) => event.occurrenceIdentity || event.id || event.uid,
        deriveCalendarRecordId: async (calendarId, occurrenceIdentity) => buildCanonicalCalendarRecordId(calendarId, occurrenceIdentity),
      };
    }
    if (id === '../tps-gcm-api') {
      return { getGcmApi: () => options.gcmApi || null };
    }
    throw new Error(`Unexpected require: ${id}`);
  };
  const load = new Function('module', 'exports', 'require', compiled.outputText);
  load(module, module.exports, requireStub);
  return { ReminderEngine: module.exports.ReminderEngine, TFile: TestTFile };
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
    taskRawLine: '- [ ] Move me [scheduled:: 2026-08-10 09:00] [tpsId:: task_move]',
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

test('all-day task reminders can repeat until their stop condition', () => {
  assert.match(source, /reminder\.repeatUntilComplete\s*&&\s*\(!reminder\.mode \|\| reminder\.mode === "task"\)/);
  assert.doesNotMatch(source, /reminder\.repeatUntilComplete\s*&&[\s\S]{0,160}!isAllDaySafe/);
});

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

test('native projection preserves zoned time, all-day base time, repeats, and deterministic order together', async () => {
  const now = Date.parse('2026-08-27T12:00:00.000Z');
  const time = loadTimeCalculationModule();
  const frontmatterByPath = new Map([
    ['Zulu.md', { kind: 'calendar-event', status: 'scheduled', scheduled: '2026-08-27T09:00:00.000-05:00', allDay: false }],
    ['All Day.md', { kind: 'calendar-event', status: 'scheduled', scheduled: '2026-08-28', allDay: true }],
    ['Repeat.md', { kind: 'task', status: 'todo', due: '2026-08-27T13:00:00.000Z' }],
    ['Alpha.md', { kind: 'calendar-event', status: 'scheduled', scheduled: '2026-08-27T14:00:00.000Z', allDay: false }],
  ]);
  const candidateFiles = [];
  const engineHarness = loadCompiledReminderEngineHarness({
    candidateFiles,
    parseDate: time.parseDate,
    parseTimeRange: time.parseTimeRange,
    parseDuration: time.parseDuration,
    getEffectiveEndTime: time.getEffectiveEndTime,
    formatTemplate: time.formatTemplate,
    formatRemaining: time.formatRemaining,
    shouldIgnoreForReminder: time.shouldIgnoreForReminder,
    isAllDayEvent: time.isAllDayEvent,
    hasExplicitTimeInValue: time.hasExplicitTimeInValue,
    getReminderTriggerBase: time.getReminderTriggerBase,
    buildReminderTargetsForFile: async (_app, file) => [{
      sourceKey: file.path,
      sourceType: 'file',
      targetKind: 'note',
      noteTitle: file.basename,
      reminderTags: [],
    }],
    buildEffectiveReminderContextForTarget: (_target, frontmatter, property) => ({
      frontmatter,
      propertyValue: frontmatter[property],
    }),
  });
  for (const path of ['Zulu.md', 'All Day.md', 'Repeat.md', 'Alpha.md']) {
    candidateFiles.push(new engineHarness.TFile(path));
  }
  const app = {
    metadataCache: {
      getFileCache: (file) => ({ frontmatter: frontmatterByPath.get(file.path) }),
    },
    vault: { getMarkdownFiles: () => candidateFiles, cachedRead: async () => '' },
  };
  const settings = {
    enableReminders: true,
    pollMinutes: 1.5,
    reminders: [{
      id: 'timed-minus-15',
      enabled: true,
      property: 'scheduled',
      offsetMinutes: -15,
      repeatUntilComplete: false,
      repeatIntervalMinutes: 5,
      maxRepeats: -1,
      stopConditions: [],
      title: 'Reminder: {filename}',
      body: 'At {time}',
      sourceTypes: ['file'],
      allDayFilter: 'false',
    }, {
      id: 'all-day-at-nine',
      enabled: true,
      property: 'scheduled',
      offsetMinutes: 0,
      repeatUntilComplete: false,
      repeatIntervalMinutes: 5,
      maxRepeats: -1,
      stopConditions: [],
      title: 'Today: {filename}',
      body: 'At {time}',
      sourceTypes: ['file'],
      allDayFilter: 'true',
    }, {
      id: 'repeat-three-times',
      enabled: true,
      property: 'due',
      mode: 'task',
      offsetMinutes: 0,
      repeatUntilComplete: true,
      repeatIntervalMinutes: 5,
      maxRepeats: 2,
      repeatEndAt: 'stop-condition',
      stopConditions: [],
      title: 'Due: {filename}',
      body: 'At {time}',
      sourceTypes: ['file'],
      allDayFilter: 'false',
    }],
    alertState: {},
    archiveFolder: '_archive',
    globalIgnorePaths: [],
    globalIgnoreTags: [],
    globalIgnoreStatuses: [],
    globalIgnoreCheckboxStates: [],
    defaultAllDayBaseTime: '09:00',
    snoozeProperty: 'reminderSnooze',
    canceledStatusValue: 'cancelled',
    externalCalendars: [],
  };
  const engine = new engineHarness.ReminderEngine(app, {});

  const schedule = await engine.projectScheduledNotifications(settings, now);

  assert.equal(schedule.length, 6);
  assert.deepEqual(
    schedule.slice(0, 5).map((item) => [item.fireAt, item.sourceKey]),
    [
      [Date.parse('2026-08-27T13:00:00.000Z'), 'Repeat.md'],
      [Date.parse('2026-08-27T13:05:00.000Z'), 'Repeat.md'],
      [Date.parse('2026-08-27T13:10:00.000Z'), 'Repeat.md'],
      [Date.parse('2026-08-27T13:45:00.000Z'), 'Alpha.md'],
      [Date.parse('2026-08-27T13:45:00.000Z'), 'Zulu.md'],
    ],
  );
  assert.equal(moment(schedule[5].fireAt).format('YYYY-MM-DD HH:mm'), '2026-08-28 09:00');
  assert.equal(schedule[5].sourceKey, 'All Day.md');
  assert.deepEqual(settings.alertState, {}, 'projection remains read-only across mixed reminder semantics');
});

test('native schedule projection is Controller-rule-owned and read-only', async () => {
  const now = Date.parse('2026-08-15T15:00:00.000Z');
  const start = now + 60 * 60 * 1000;
  const file = { path: 'Projects/Alpha.md', basename: 'Alpha', extension: 'md' };
  const settings = {
    enableReminders: true,
    reminders: [{
      id: 'rule-15-minutes',
      enabled: true,
      property: 'scheduled',
      mode: 'task',
      offsetMinutes: -15,
      repeatUntilComplete: false,
      repeatIntervalMinutes: 5,
      maxRepeats: -1,
      stopConditions: [],
      title: 'Do {filename}',
      body: '{time} · {remaining}',
    }, {
      id: 'rule-5-minutes',
      enabled: true,
      property: 'scheduled',
      mode: 'task',
      offsetMinutes: -5,
      repeatUntilComplete: false,
      repeatIntervalMinutes: 5,
      maxRepeats: -1,
      stopConditions: [],
      title: 'Soon {filename}',
      body: '{time}',
    }],
    alertState: {},
    archiveFolder: '_archive',
    globalIgnorePaths: [],
    globalIgnoreTags: [],
    globalIgnoreStatuses: [],
    globalIgnoreCheckboxStates: [],
    defaultAllDayBaseTime: '09:00',
    snoozeProperty: 'reminderSnooze',
    externalCalendars: [],
  };
  const candidateFiles = [];
  const engineHarness = loadCompiledReminderEngineHarness({
    candidateFiles,
    shouldIgnoreForReminder: () => false,
    parseTimeRange: () => ({ start, end: null }),
    buildReminderTargetsForFile: async () => [{
      sourceKey: 'Projects/Alpha.md::task:3',
      sourceType: 'file',
      targetKind: 'task',
      taskTitle: 'Write proposal',
      taskFrontmatter: { scheduled: '2026-08-15 11:00' },
    }],
    buildEffectiveReminderContextForTarget: (target) => ({
      frontmatter: target.taskFrontmatter,
      propertyValue: target.taskFrontmatter.scheduled,
    }),
  });
  const TestFile = engineHarness.TFile;
  const nativeFile = new TestFile(file.path);
  candidateFiles.push(nativeFile);
  const app = {
    metadataCache: { getFileCache: () => ({ frontmatter: { scheduled: '2026-08-15 11:00' } }) },
    vault: { getMarkdownFiles: () => [nativeFile], cachedRead: async () => '' },
  };
  const engine = new engineHarness.ReminderEngine(app, {});
  const before = structuredClone(settings.alertState);
  const schedule = await engine.projectScheduledNotifications(settings, now);

  assert.equal(schedule.length, 2, 'every matching Controller rule contributes its own occurrence');
  assert.equal(schedule[0].fireAt, start - 15 * 60 * 1000);
  assert.equal(schedule[1].fireAt, start - 5 * 60 * 1000);
  assert.equal(schedule[0].sourcePath, 'Projects/Alpha.md');
  assert.equal(schedule[0].sourceKey, 'Projects/Alpha.md::task:3');
  assert.deepEqual(settings.alertState, before, 'projection must not consume Controller delivery state');
});

test('native calendar records suppress matched pathless external alerts while retaining truly unmatched events', async (t) => {
  const now = Date.parse('2026-08-25T12:00:00.000Z');
  const sourceUrl = 'https://calendar.invalid/native-records.ics';
  const calendarId = 'calendar-regression';
  const matchingEvent = {
    id: 'series-native-20260827T090000',
    uid: 'series-native',
    occurrenceIdentity: 'series-native-20260827T090000',
    title: 'Native calendar event',
    description: '',
    startDate: new Date('2026-08-27T14:00:00.000Z'),
    endDate: new Date('2026-08-27T14:30:00.000Z'),
    sourceUrl,
    isAllDay: false,
    isRecurring: true,
  };
  const unmatchedEvent = {
    ...matchingEvent,
    id: 'series-unmatched-20260828T100000',
    uid: 'series-unmatched',
    occurrenceIdentity: 'series-unmatched-20260828T100000',
    title: 'Unmatched calendar event',
    startDate: new Date('2026-08-28T15:00:00.000Z'),
    endDate: new Date('2026-08-28T15:30:00.000Z'),
  };
  const canonicalRecordId = buildCanonicalCalendarRecordId(calendarId, matchingEvent.occurrenceIdentity);
  const nativeRecord = {
    tpsId: canonicalRecordId,
    tpsSchemaVersion: 1,
    kind: 'calendar-event',
    title: '[[Calendar Events/2026-08-27/Event note|Linked display title]]',
    eventTitle: matchingEvent.title,
    status: 'scheduled',
    scheduled: matchingEvent.startDate.toISOString(),
  };
  const settings = {
    calendarStorageMode: 'native-records',
    enableReminders: true,
    pollMinutes: 0.5,
    reminders: [{
      id: 'recommended-timed',
      enabled: true,
      property: 'scheduled',
      mode: 'task',
      offsetMinutes: -15,
      repeatUntilComplete: false,
      repeatIntervalMinutes: 5,
      maxRepeats: -1,
      stopConditions: [],
      title: 'Reminder: {filename}',
      body: 'At {time}',
      sourceTypes: ['file', 'external-event'],
      includeUnmatchedExternalEvents: true,
      allDayFilter: 'false',
    }],
    alertState: {},
    archiveFolder: '',
    globalIgnorePaths: [],
    globalIgnoreTags: [],
    globalIgnoreStatuses: [],
    globalIgnoreCheckboxStates: [],
    defaultAllDayBaseTime: '09:00',
    snoozeProperty: 'reminderSnooze',
    canceledStatusValue: 'cancelled',
    eventIdKey: 'externalEventId',
    uidKey: 'tpsCalendarUid',
    startProperty: 'scheduled',
    endProperty: 'timeEstimate',
    titleKey: 'title',
    externalCalendars: [{ id: calendarId, enabled: true, url: sourceUrl }],
  };
  let currentFrontmatter = nativeRecord;
  let authoritativeRecords = [];
  const candidateFiles = [];
  const engineHarness = loadCompiledReminderEngineHarness({
    candidateFiles,
    parseFrontmatterDate: (value) => {
      const parsed = new Date(value);
      return Number.isFinite(parsed.getTime()) ? parsed : null;
    },
    parseTimeRange: (value) => ({ start: Date.parse(String(value)), end: null }),
    shouldIgnoreForReminder: () => false,
    buildReminderTargetsForFile: async (_app, file) => [{
      sourceKey: file.path,
      sourceType: 'file',
      targetKind: 'note',
    }],
    buildEffectiveReminderContextForTarget: (target, frontmatter, property) => {
      if (target.sourceType === 'external-event') {
        const scheduled = target.externalEvent.startDate.toISOString();
        return {
          frontmatter: { scheduled, title: target.externalEvent.title, status: 'scheduled' },
          propertyValue: property === 'scheduled' ? scheduled : undefined,
        };
      }
      return { frontmatter, propertyValue: frontmatter[property] };
    },
    gcmApi: {
      nativeRecords: {
        inspect: (frontmatter) => frontmatter.__inspectedId
          ? { id: frontmatter.__inspectedId }
          : null,
        snapshot: async () => ({ token: 1, records: authoritativeRecords }),
      },
    },
  });
  const nativeFile = new engineHarness.TFile('_records/calendar-events/calendar-native-regression.md');
  candidateFiles.push(nativeFile);
  const app = {
    metadataCache: { getFileCache: () => ({ frontmatter: currentFrontmatter }) },
    vault: { getMarkdownFiles: () => [nativeFile], cachedRead: async () => '' },
  };
  const externalCalendarService = {
    fetchEvents: async () => [matchingEvent, unmatchedEvent],
  };
  const engine = new engineHarness.ReminderEngine(app, externalCalendarService);

  const schedule = await engine.projectScheduledNotifications(settings, now);
  assert.equal(schedule.length, 2, 'the matched occurrence must not be projected once from its file and again from the feed');
  assert.deepEqual(
    schedule.map((item) => ({ sourcePath: item.sourcePath, sourceKey: item.sourceKey })),
    [{
      sourcePath: nativeFile.path,
      sourceKey: nativeFile.path,
    }, {
      sourcePath: undefined,
      sourceKey: `external-event::${sourceUrl}::${unmatchedEvent.id}`,
    }],
  );
  assert.equal(schedule[0].fireAt, matchingEvent.startDate.getTime() - 15 * 60_000);
  assert.equal(schedule[1].fireAt, unmatchedEvent.startDate.getTime() - 15 * 60_000);

  const identityVariants = [{
    label: 'canonical tpsId property',
    frontmatter: {
      scheduled: nativeRecord.scheduled,
      tpsId: canonicalRecordId,
    },
  }, {
    label: 'canonical GCM-inspected tag identity',
    frontmatter: {
      scheduled: nativeRecord.scheduled,
      __inspectedId: canonicalRecordId,
    },
  }, {
    label: 'legacy occurrence identity during migration',
    frontmatter: {
      scheduled: nativeRecord.scheduled,
      calendarOccurrenceIdentity: matchingEvent.occurrenceIdentity,
    },
  }, {
    label: 'legacy event title plus scheduled during migration',
    frontmatter: {
      scheduled: nativeRecord.scheduled,
      title: nativeRecord.title,
      eventTitle: nativeRecord.eventTitle,
    },
  }];
  for (const variant of identityVariants) {
    await t.test(variant.label, async () => {
      currentFrontmatter = variant.frontmatter;
      const unmatched = await engine.buildUnmatchedExternalReminderTargets([], settings);
      assert.deepEqual(
        unmatched.map((target) => target.externalEvent.id),
        [unmatchedEvent.id],
        `${variant.label} must match the native record while preserving the real feed-only event`,
      );
    });
  }

  await t.test('cache-null authoritative canonical identity remains one file-backed source', async () => {
    currentFrontmatter = null;
    authoritativeRecords = [{
      file: nativeFile,
      path: nativeFile.path,
      id: canonicalRecordId.toLocaleUpperCase(),
      kind: 'calendar-event',
      frontmatter: nativeRecord,
    }];
    const unmatched = await engine.buildUnmatchedExternalReminderTargets([], settings);
    assert.deepEqual(
      unmatched.map((target) => target.externalEvent.id),
      [unmatchedEvent.id],
      'authoritative GCM identity suppresses the matching feed fallback even before MetadataCache arrives',
    );
    authoritativeRecords = [];
  });
});

test('configured cancellation status globally suppresses native calendar records for recommended rules', async () => {
  const now = Date.parse('2026-08-25T12:00:00.000Z');
  const { parseTimeRange, shouldIgnoreForReminder } = loadTimeCalculationModule();
  const cancelledRecord = {
    tags: [
      'calendar-event',
      'tps/record/v1/calendar-event/calendar-cancelled-poc-shape',
    ],
    scheduled: '2026-09-25T15:00:00.000Z',
    status: 'cancelled',
    allDay: false,
    kind: 'calendar-event',
  };
  const recommendedRule = {
    id: 'reminder-standard-timed-scheduled',
    label: 'Timed scheduled things',
    enabled: true,
    property: 'scheduled',
    mode: 'task',
    offsetMinutes: -15,
    repeatUntilComplete: false,
    repeatIntervalMinutes: 5,
    maxRepeats: -1,
    stopConditions: ['status: complete', 'status: wont-do'],
    ignorePaths: [],
    ignoreTags: [],
    ignoreStatuses: [],
    ignoreCheckboxStates: [],
    requiredStatuses: [],
    requiredCheckboxStates: [],
    requiredPaths: [],
    title: 'Reminder: {filename}',
    body: 'At {time} ({remaining})',
    triggerAtEnd: false,
    sourceTypes: ['file', 'external-event'],
    allDayFilter: 'false',
    includeUnmatchedExternalEvents: true,
  };
  const settings = {
    enableReminders: true,
    reminders: [recommendedRule],
    alertState: {},
    archiveFolder: '',
    canceledStatusValue: 'cancelled',
    globalIgnorePaths: ['System/'],
    globalIgnoreTags: ['archive', 'template'],
    globalIgnoreStatuses: ['complete', 'wont-do'],
    globalIgnoreCheckboxStates: ['x', '-'],
    defaultAllDayBaseTime: '09:00',
    snoozeProperty: 'reminderSnooze',
    externalCalendars: [],
  };
  const candidateFiles = [];
  const engineHarness = loadCompiledReminderEngineHarness({
    candidateFiles,
    shouldIgnoreForReminder,
    parseTimeRange,
    buildReminderTargetsForFile: async () => [{
      sourceKey: '2026-09-25 - Canceled event.md',
      sourceType: 'file',
      targetKind: 'note',
      reminderTags: cancelledRecord.tags.map((tag) => `#${tag}`),
    }],
    buildEffectiveReminderContextForTarget: (_target, baseFrontmatter) => ({
      frontmatter: baseFrontmatter,
      propertyValue: baseFrontmatter.scheduled,
    }),
  });
  const nativeFile = new engineHarness.TFile('2026-09-25 - Canceled event.md');
  candidateFiles.push(nativeFile);
  const app = {
    metadataCache: { getFileCache: () => ({ frontmatter: cancelledRecord }) },
    vault: { getMarkdownFiles: () => [nativeFile], cachedRead: async () => '' },
  };
  const engine = new engineHarness.ReminderEngine(app, {});

  assert.deepEqual(await engine.projectScheduledNotifications(settings, now), []);

  const customCancelledRecord = { ...cancelledRecord, status: 'Declined' };
  settings.canceledStatusValue = 'declined';
  app.metadataCache.getFileCache = () => ({ frontmatter: customCancelledRecord });
  assert.deepEqual(
    await engine.projectScheduledNotifications(settings, now),
    [],
    'custom configured cancellation values are terminal and case-insensitive',
  );

  const scheduledRecord = { ...cancelledRecord, status: 'scheduled', calendarSyncState: 'current' };
  settings.canceledStatusValue = 'cancelled';
  app.metadataCache.getFileCache = () => ({ frontmatter: scheduledRecord });
  const projected = await engine.projectScheduledNotifications(settings, now);
  assert.equal(projected.length, 1, 'the matching recommended rule still projects an active occurrence');
  assert.equal(projected[0].fireAt, Date.parse(scheduledRecord.scheduled) - 15 * 60_000);
});

test('master reminder switch keeps the audit list and native schedule projection empty in parity', async () => {
  const disabledSettings = {
    enableReminders: false,
    reminders: [{
      id: 'disabled-rule',
      enabled: true,
      property: 'scheduled',
      mode: 'task',
      stopConditions: [],
    }],
    alertState: {},
    archiveFolder: '_archive',
    externalCalendars: [],
  };
  const inaccessibleApp = {
    metadataCache: {
      getFileCache: () => {
        throw new Error('disabled reminder surfaces must not inspect metadata');
      },
    },
    vault: {
      getMarkdownFiles: () => {
        throw new Error('disabled reminder surfaces must not scan the vault');
      },
    },
  };

  const overdueHarness = loadCompiledOverdueServiceHarness();
  const overdue = new overdueHarness.OverdueService(inaccessibleApp, () => disabledSettings);
  assert.deepEqual(await overdue.getOverdueItems(), []);
  assert.equal(
    overdueHarness.logs.some(({ args }) => args[0] === 'OverdueItems' && args[1] === 'scan:reminders-disabled'),
    true,
  );

  const engineHarness = loadCompiledReminderEngineHarness();
  const engine = new engineHarness.ReminderEngine(inaccessibleApp, {});
  assert.deepEqual(await engine.projectScheduledNotifications(disabledSettings), []);
});

test('reminder audit surfaces report master, provider, platform, and per-device publication truth', () => {
  assert.match(mainSource, /getReminderDeliveryAuditStatus\(\)[\s\S]*remindersEnabled:[\s\S]*notificationDeliveryProvider:[\s\S]*localDeliveryMode:[\s\S]*tishOSNativeNotificationsSupported:[\s\S]*commandBridge:/);
  assert.match(notificationViewSource, /Reminder delivery is off\. No reminder is being published\./);
  assert.match(notificationViewSource, /Local Obsidian notices are active while Obsidian is open/);
  assert.match(notificationViewSource, /ntfy delivery does not run on this mobile\/User device/);
  assert.match(notificationViewSource, /nativeNotificationState === 'pending'/);
  assert.match(notificationViewSource, /nativeNotificationReason/);
  assert.match(notificationViewSource, /nativeNotificationItemCount/);
  assert.match(notificationViewSource, /nativeNotificationPublishedAt/);
  assert.doesNotMatch(notificationViewSource, /reduce\([\s\S]{0,200}nativeNotificationItemCount/);
  assert.match(settingsTabSource, /private describeNativeNotificationStatus/);
  assert.match(settingsTabSource, /reminders are off/);
  assert.match(settingsTabSource, /ntfy is selected/);
  assert.match(settingsTabSource, /nativeNotificationReason/);
  assert.match(settingsTabSource, /nativeNotificationPublishedAt/);
  assert.match(settingsTabSource, /\.setName\(localObsidianFallback \? 'Local Obsidian fallback' : 'Local TishOS schedule'\)/);
  assert.match(settingsTabSource, /tishOSNativeNotificationsSupported === false/);
  assert.match(settingsTabSource, /Local Obsidian fallback is blocked because Enable Reminders is off/);
  assert.match(settingsTabSource, /a closed or suspended app cannot be notified/);
});

test('native schedule retains the modal-visible due occurrence with its stable fire time', async () => {
  const now = Date.parse('2026-08-15T15:00:00.000Z');
  const triggerTime = now - 30 * 1000;
  const settings = {
    enableReminders: true,
    pollMinutes: 2,
    reminders: [{
      id: 'due-rule',
      enabled: true,
      property: 'scheduled',
      mode: 'task',
      offsetMinutes: 0,
      repeatUntilComplete: false,
      repeatIntervalMinutes: 5,
      maxRepeats: -1,
      stopConditions: [],
      title: 'Due {filename}',
      body: '{time}',
    }],
    alertState: {},
    archiveFolder: '_archive',
    globalIgnorePaths: [],
    globalIgnoreTags: [],
    globalIgnoreStatuses: [],
    globalIgnoreCheckboxStates: [],
    defaultAllDayBaseTime: '09:00',
    snoozeProperty: 'reminderSnooze',
    externalCalendars: [],
  };
  const candidateFiles = [];
  const engineHarness = loadCompiledReminderEngineHarness({
    candidateFiles,
    shouldIgnoreForReminder: () => false,
    parseTimeRange: () => ({ start: triggerTime, end: null }),
    buildReminderTargetsForFile: async () => [{
      sourceKey: 'Projects/Due.md::task:1',
      sourceType: 'file',
      targetKind: 'task',
      taskTitle: 'Due task',
      taskFrontmatter: { scheduled: '2026-08-15 09:58' },
    }],
    buildEffectiveReminderContextForTarget: (target) => ({
      frontmatter: target.taskFrontmatter,
      propertyValue: target.taskFrontmatter.scheduled,
    }),
  });
  const nativeFile = new engineHarness.TFile('Projects/Due.md');
  candidateFiles.push(nativeFile);
  const app = {
    metadataCache: { getFileCache: () => ({ frontmatter: { scheduled: '2026-08-15 09:58' } }) },
    vault: { getMarkdownFiles: () => [nativeFile], cachedRead: async () => '' },
  };
  const engine = new engineHarness.ReminderEngine(app, {});

  const due = await engine.projectScheduledNotifications(settings, now);
  assert.equal(due.length, 1);
  assert.equal(due[0].fireAt, triggerTime, 'the logical occurrence time must remain stable');
  assert.deepEqual(settings.alertState, {}, 'late projection must remain read-only');

  const stale = await engine.projectScheduledNotifications(settings, triggerTime + 60 * 1000 + 1);
  assert.equal(stale.length, 0, 'the item disappears with the same bounded modal live window');
});

test('native schedule projects the deterministic next occurrence for an overdue repeating reminder', async () => {
  const now = Date.parse('2026-08-15T15:22:00.000Z');
  const triggerTime = Date.parse('2026-08-15T15:00:00.000Z');
  const settings = {
    enableReminders: true,
    pollMinutes: 2,
    reminders: [{
      id: 'repeat-rule',
      enabled: true,
      property: 'scheduled',
      mode: 'task',
      offsetMinutes: 0,
      repeatUntilComplete: true,
      repeatIntervalMinutes: 5,
      maxRepeats: -1,
      stopConditions: [],
      title: 'Still due {filename}',
      body: '{time}',
    }],
    alertState: {},
    archiveFolder: '_archive',
    globalIgnorePaths: [],
    globalIgnoreTags: [],
    globalIgnoreStatuses: [],
    globalIgnoreCheckboxStates: [],
    defaultAllDayBaseTime: '09:00',
    snoozeProperty: 'reminderSnooze',
    externalCalendars: [],
  };
  const candidateFiles = [];
  const engineHarness = loadCompiledReminderEngineHarness({
    candidateFiles,
    shouldIgnoreForReminder: () => false,
    parseTimeRange: () => ({ start: triggerTime, end: null }),
    buildReminderTargetsForFile: async () => [{
      sourceKey: 'Projects/Repeat.md::task:1',
      sourceType: 'file',
      targetKind: 'task',
      taskTitle: 'Persistent task',
      taskFrontmatter: { scheduled: '2026-08-15 10:00' },
    }],
    buildEffectiveReminderContextForTarget: (target) => ({
      frontmatter: target.taskFrontmatter,
      propertyValue: target.taskFrontmatter.scheduled,
    }),
  });
  const nativeFile = new engineHarness.TFile('Projects/Repeat.md');
  candidateFiles.push(nativeFile);
  const app = {
    metadataCache: { getFileCache: () => ({ frontmatter: { scheduled: '2026-08-15 10:00' } }) },
    vault: { getMarkdownFiles: () => [nativeFile], cachedRead: async () => '' },
  };
  const engine = new engineHarness.ReminderEngine(app, {});

  const schedule = await engine.projectScheduledNotifications(settings, now);
  assert.equal(schedule.length, 128, 'the bounded schedule carries later repeats without another Obsidian wake');
  assert.equal(schedule[0].fireAt, Date.parse('2026-08-15T15:25:00.000Z'));
  assert.equal(schedule[1].fireAt, Date.parse('2026-08-15T15:30:00.000Z'));
  assert.equal(schedule.at(-1).fireAt, Date.parse('2026-08-16T02:00:00.000Z'));
  assert.deepEqual(settings.alertState, {}, 'projection must not manufacture Controller delivery state');

  settings.reminders[0].maxRepeats = 4;
  const exhausted = await engine.projectScheduledNotifications(settings, now);
  assert.equal(exhausted.length, 0, 'the projection honors the Controller repeat limit');
});

test('native trigger-base repeats stay on the logical cadence and stop strictly before the base', async () => {
  const now = Date.parse('2026-08-15T13:40:00.000Z');
  const triggerBase = Date.parse('2026-08-15T14:00:00.000Z');
  const settings = {
    enableReminders: true,
    pollMinutes: 1.5,
    reminders: [{
      id: 'pre-event-cadence',
      enabled: true,
      property: 'scheduled',
      offsetMinutes: -15,
      repeatUntilComplete: true,
      repeatIntervalMinutes: 5,
      maxRepeats: -1,
      repeatEndAt: 'trigger-base',
      stopConditions: [],
      title: 'Reminder: {filename}',
      body: 'At {time}',
      sourceTypes: ['file'],
      allDayFilter: 'false',
    }],
    alertState: {},
    archiveFolder: '_archive',
    globalIgnorePaths: [],
    globalIgnoreTags: [],
    globalIgnoreStatuses: [],
    globalIgnoreCheckboxStates: [],
    defaultAllDayBaseTime: '09:00',
    snoozeProperty: 'reminderSnooze',
    externalCalendars: [],
  };
  const candidateFiles = [];
  const engineHarness = loadCompiledReminderEngineHarness({
    candidateFiles,
    shouldIgnoreForReminder: () => false,
    parseTimeRange: () => ({ start: triggerBase, end: null }),
    buildReminderTargetsForFile: async () => [{
      sourceKey: 'Calendar/Event.md',
      sourceType: 'file',
      targetKind: 'note',
      reminderTags: ['calendar-event'],
    }],
    buildEffectiveReminderContextForTarget: () => ({
      frontmatter: { scheduled: '2026-08-15T14:00:00.000Z' },
      propertyValue: '2026-08-15T14:00:00.000Z',
    }),
  });
  const nativeFile = new engineHarness.TFile('Calendar/Event.md');
  candidateFiles.push(nativeFile);
  const app = {
    metadataCache: { getFileCache: () => ({ frontmatter: { scheduled: '2026-08-15T14:00:00.000Z' } }) },
    vault: { getMarkdownFiles: () => [nativeFile], cachedRead: async () => '' },
  };
  const engine = new engineHarness.ReminderEngine(app, {});

  const schedule = await engine.projectScheduledNotifications(settings, now);
  assert.deepEqual(
    schedule.map((item) => item.fireAt),
    [
      Date.parse('2026-08-15T13:45:00.000Z'),
      Date.parse('2026-08-15T13:50:00.000Z'),
      Date.parse('2026-08-15T13:55:00.000Z'),
    ],
    'the projected cadence matches foreground semantics and never manufactures an at-base follow-up',
  );
  assert.equal(new Set(schedule.map((item) => item.sourceKey)).size, 1);
  assert.deepEqual(settings.alertState, {}, 'projection remains read-only');

  settings.reminders[0].maxRepeats = 1;
  const finite = await engine.projectScheduledNotifications(settings, now);
  assert.deepEqual(
    finite.map((item) => item.fireAt),
    [Date.parse('2026-08-15T13:45:00.000Z'), Date.parse('2026-08-15T13:50:00.000Z')],
    'maxRepeats counts follow-ups after the initial occurrence',
  );
});

test('live-shaped calendar filtering gives the eligible pre-event rule one repeated series', async () => {
  const now = Date.parse('2026-08-15T13:40:00.000Z');
  const triggerBase = Date.parse('2026-08-15T14:00:00.000Z');
  const time = loadTimeCalculationModule();
  const settings = {
    enableReminders: true,
    pollMinutes: 1.5,
    reminders: [{
      id: 'fifteen-minutes-before',
      enabled: true,
      property: 'scheduled',
      offsetMinutes: -15,
      repeatUntilComplete: true,
      repeatIntervalMinutes: 5,
      maxRepeats: -1,
      repeatEndAt: 'trigger-base',
      stopConditions: [],
      ignoreTags: ['dailynote'],
      title: 'Reminder: {filename}',
      body: 'At {time}',
      sourceTypes: ['file', 'external-event'],
      allDayFilter: 'false',
    }, {
      id: 'post-end-until-complete',
      enabled: true,
      property: 'scheduled',
      offsetMinutes: 15,
      triggerAtEnd: true,
      repeatUntilComplete: true,
      repeatIntervalMinutes: 5,
      maxRepeats: -1,
      repeatEndAt: 'stop-condition',
      stopConditions: ['status: complete'],
      ignoreTags: ['calendar-event', 'dailynote', 'health'],
      title: 'Still due: {filename}',
      body: 'At {time}',
      sourceTypes: ['file'],
      allDayFilter: 'false',
    }],
    alertState: {},
    archiveFolder: '_archive',
    globalIgnorePaths: [],
    globalIgnoreTags: [],
    globalIgnoreStatuses: [],
    globalIgnoreCheckboxStates: [],
    defaultAllDayBaseTime: '09:00',
    snoozeProperty: 'reminderSnooze',
    canceledStatusValue: 'cancelled',
    externalCalendars: [],
  };
  const candidateFiles = [];
  const engineHarness = loadCompiledReminderEngineHarness({
    candidateFiles,
    shouldIgnoreForReminder: time.shouldIgnoreForReminder,
    parseTimeRange: () => ({ start: triggerBase, end: triggerBase + 30 * 60 * 1000 }),
    buildReminderTargetsForFile: async () => [{
      sourceKey: 'Calendar/Event.md',
      sourceType: 'file',
      targetKind: 'note',
      reminderTags: ['calendar-event'],
    }],
    buildEffectiveReminderContextForTarget: (_target, frontmatter, property) => ({
      frontmatter,
      propertyValue: frontmatter[property],
    }),
  });
  const nativeFile = new engineHarness.TFile('Calendar/Event.md');
  candidateFiles.push(nativeFile);
  const frontmatter = {
    kind: 'calendar-event',
    status: 'scheduled',
    scheduled: '2026-08-15T14:00:00.000Z',
    end: '2026-08-15T14:30:00.000Z',
    allDay: false,
  };
  const app = {
    metadataCache: { getFileCache: () => ({ frontmatter }) },
    vault: { getMarkdownFiles: () => [nativeFile], cachedRead: async () => '' },
  };
  const engine = new engineHarness.ReminderEngine(app, {});

  const schedule = await engine.projectScheduledNotifications(settings, now);
  assert.equal(schedule.length, 3);
  assert.deepEqual(
    schedule.map((item) => [item.reminderId, item.fireAt]),
    [
      ['fifteen-minutes-before', Date.parse('2026-08-15T13:45:00.000Z')],
      ['fifteen-minutes-before', Date.parse('2026-08-15T13:50:00.000Z')],
      ['fifteen-minutes-before', Date.parse('2026-08-15T13:55:00.000Z')],
    ],
  );
  assert.equal(
    schedule.some((item) => item.reminderId === 'post-end-until-complete'),
    false,
    'the separately configured post-end rule remains excluded for calendar events',
  );
});

test('native trigger-base catch-up never invents an at-base repeat but preserves an offset-zero initial', async () => {
  const triggerBase = Date.parse('2026-08-15T14:00:00.000Z');
  const settings = {
    enableReminders: true,
    pollMinutes: 1.5,
    reminders: [{
      id: 'pre-event-cadence',
      enabled: true,
      property: 'scheduled',
      offsetMinutes: -15,
      repeatUntilComplete: true,
      repeatIntervalMinutes: 5,
      maxRepeats: -1,
      repeatEndAt: 'trigger-base',
      stopConditions: [],
      title: 'Reminder: {filename}',
      body: 'At {time}',
      sourceTypes: ['file'],
      allDayFilter: 'false',
    }],
    alertState: {},
    archiveFolder: '_archive',
    globalIgnorePaths: [],
    globalIgnoreTags: [],
    globalIgnoreStatuses: [],
    globalIgnoreCheckboxStates: [],
    defaultAllDayBaseTime: '09:00',
    snoozeProperty: 'reminderSnooze',
    externalCalendars: [],
  };
  const candidateFiles = [];
  const engineHarness = loadCompiledReminderEngineHarness({
    candidateFiles,
    shouldIgnoreForReminder: () => false,
    parseTimeRange: () => ({ start: triggerBase, end: null }),
    buildReminderTargetsForFile: async () => [{
      sourceKey: 'Calendar/Event.md',
      sourceType: 'file',
      targetKind: 'note',
      reminderTags: ['calendar-event'],
    }],
    buildEffectiveReminderContextForTarget: () => ({
      frontmatter: { scheduled: '2026-08-15T14:00:00.000Z' },
      propertyValue: '2026-08-15T14:00:00.000Z',
    }),
  });
  const nativeFile = new engineHarness.TFile('Calendar/Event.md');
  candidateFiles.push(nativeFile);
  const app = {
    metadataCache: { getFileCache: () => ({ frontmatter: { scheduled: '2026-08-15T14:00:00.000Z' } }) },
    vault: { getMarkdownFiles: () => [nativeFile], cachedRead: async () => '' },
  };
  const engine = new engineHarness.ReminderEngine(app, {});

  const catchUp = await engine.projectScheduledNotifications(
    settings,
    Date.parse('2026-08-15T13:58:00.000Z'),
  );
  assert.deepEqual(catchUp, [], 'the next cadence point at the trigger base is not a repeat');

  settings.reminders[0].offsetMinutes = 0;
  const initialAtBase = await engine.projectScheduledNotifications(
    settings,
    Date.parse('2026-08-15T13:58:00.000Z'),
  );
  assert.deepEqual(
    initialAtBase.map((item) => item.fireAt),
    [triggerBase],
    'an offset-zero initial occurrence remains valid at the trigger base',
  );
  assert.deepEqual(settings.alertState, {}, 'catch-up projection remains read-only');
});

test('foreground trigger-base evaluation suppresses pre-event catch-up at the base but preserves an offset-zero initial', () => {
  const triggerBase = Date.parse('2026-08-15T14:00:00.000Z');
  const settings = {
    enableReminders: true,
    pollMinutes: 1.5,
    reminders: [{
      id: 'pre-event-cadence',
      enabled: true,
      property: 'scheduled',
      offsetMinutes: -15,
      repeatUntilComplete: true,
      repeatIntervalMinutes: 5,
      maxRepeats: -1,
      repeatEndAt: 'trigger-base',
      stopConditions: [],
      title: 'Reminder: {filename}',
      body: 'At {time}',
      sourceTypes: ['file'],
      allDayFilter: 'false',
    }],
    alertState: {},
    archiveFolder: '_archive',
    globalIgnorePaths: [],
    globalIgnoreTags: [],
    globalIgnoreStatuses: [],
    globalIgnoreCheckboxStates: [],
    defaultAllDayBaseTime: '09:00',
    snoozeProperty: 'reminderSnooze',
    externalCalendars: [],
  };
  const engineHarness = loadCompiledReminderEngineHarness({
    shouldIgnoreForReminder: () => false,
    parseTimeRange: () => ({ start: triggerBase, end: null }),
    buildEffectiveReminderContextForTarget: () => ({
      frontmatter: { scheduled: '2026-08-15T14:00:00.000Z' },
      propertyValue: '2026-08-15T14:00:00.000Z',
    }),
  });
  const nativeFile = new engineHarness.TFile('Calendar/Event.md');
  const target = {
    sourceKey: nativeFile.path,
    sourceType: 'file',
    targetKind: 'note',
    reminderTags: ['calendar-event'],
  };
  const engine = new engineHarness.ReminderEngine({}, {});
  const evaluate = () => engine.evaluateTarget({
    target,
    fileRef: nativeFile,
    cache: { frontmatter: { scheduled: '2026-08-15T14:00:00.000Z' } },
    baseFrontmatter: { scheduled: '2026-08-15T14:00:00.000Z' },
    settings,
    now: triggerBase,
    alertState: settings.alertState,
  });

  const preEvent = evaluate();
  assert.deepEqual(preEvent.notifications, [], 'an empty foreground state cannot catch up at-time');
  assert.equal(settings.alertState[nativeFile.path]['pre-event-cadence'].triggered, true);

  settings.reminders[0].offsetMinutes = 0;
  settings.alertState = {};
  const atBaseInitial = evaluate();
  assert.equal(atBaseInitial.notifications.length, 1, 'an offset-zero initial remains valid at its base');
  assert.equal(settings.alertState[nativeFile.path]['pre-event-cadence'].lastSent, triggerBase);
});

test('native schedule keeps an hours-overdue five-minute rule alive while Obsidian is suspended', async () => {
  const now = Date.parse('2026-08-17T21:10:00.000Z');
  const triggerTime = Date.parse('2026-08-17T14:00:00.000Z');
  const settings = {
    enableReminders: true,
    pollMinutes: 1.5,
    reminders: [{
      id: 'repeat-until-complete',
      enabled: true,
      property: 'scheduled',
      mode: 'task',
      offsetMinutes: 0,
      repeatUntilComplete: true,
      repeatIntervalMinutes: 5,
      maxRepeats: -1,
      repeatEndAt: 'stop-condition',
      stopConditions: ['status: complete', 'status: wont-do'],
      title: 'Reminder: {filename}',
      body: 'At {time} ({remaining})',
    }],
    alertState: {},
    archiveFolder: '_archive',
    globalIgnorePaths: [],
    globalIgnoreTags: [],
    globalIgnoreStatuses: [],
    globalIgnoreCheckboxStates: [],
    defaultAllDayBaseTime: '09:00',
    snoozeProperty: 'reminderSnooze',
    externalCalendars: [],
  };
  const candidateFiles = [];
  const engineHarness = loadCompiledReminderEngineHarness({
    candidateFiles,
    shouldIgnoreForReminder: () => false,
    parseTimeRange: () => ({ start: triggerTime, end: null }),
    buildReminderTargetsForFile: async () => [{
      sourceKey: '2026-08-17.md::task:13',
      sourceType: 'file',
      targetKind: 'task',
      taskTitle: 'Daily Standup for GCP App Support',
      taskFrontmatter: { scheduled: '2026-08-17 09:00' },
    }],
    buildEffectiveReminderContextForTarget: (target) => ({
      frontmatter: target.taskFrontmatter,
      propertyValue: target.taskFrontmatter.scheduled,
    }),
  });
  const nativeFile = new engineHarness.TFile('2026-08-17.md');
  candidateFiles.push(nativeFile);
  const app = {
    metadataCache: { getFileCache: () => ({ frontmatter: {} }) },
    vault: { getMarkdownFiles: () => [nativeFile], cachedRead: async () => '' },
  };
  const engine = new engineHarness.ReminderEngine(app, {});

  const schedule = await engine.projectScheduledNotifications(settings, now);
  assert.equal(schedule.length, 128);
  assert.equal(schedule[0].fireAt, Date.parse('2026-08-17T21:15:00.000Z'));
  assert.equal(schedule[1].fireAt, Date.parse('2026-08-17T21:20:00.000Z'));
  assert.equal(schedule[0].dueAt, triggerTime);
  assert.equal(schedule[0].repeatEverySeconds, 300);
  assert.equal(schedule[0].sourceKey, '2026-08-17.md::task:13');
});

test('native schedule retains file reminders when optional external discovery fails', async () => {
  const now = Date.parse('2026-08-18T21:10:00.000Z');
  const triggerTime = Date.parse('2026-08-18T14:00:00.000Z');
  const settings = {
    enableReminders: true,
    pollMinutes: 1.5,
    reminders: [{
      id: 'repeat-until-complete',
      enabled: true,
      property: 'scheduled',
      sourceTypes: ['file', 'external-event'],
      offsetMinutes: 0,
      repeatUntilComplete: true,
      repeatIntervalMinutes: 5,
      maxRepeats: -1,
      repeatEndAt: 'stop-condition',
      stopConditions: ['status: complete', 'status: wont-do'],
      title: 'Reminder: {filename}',
      body: 'At {time} ({remaining})',
    }],
    alertState: {},
    archiveFolder: '_archive',
    globalIgnorePaths: [],
    globalIgnoreTags: [],
    globalIgnoreStatuses: [],
    globalIgnoreCheckboxStates: [],
    defaultAllDayBaseTime: '09:00',
    snoozeProperty: 'reminderSnooze',
    externalCalendars: [{ enabled: true, url: 'https://calendar.invalid/test.ics' }],
  };
  const candidateFiles = [];
  const engineHarness = loadCompiledReminderEngineHarness({
    candidateFiles,
    shouldIgnoreForReminder: () => false,
    parseTimeRange: () => ({ start: triggerTime, end: null }),
    buildReminderTargetsForFile: async () => [{
      sourceKey: '2026-08-18.md::task:13',
      sourceType: 'file',
      targetKind: 'task',
      taskTitle: 'Checklist review',
      taskFrontmatter: { scheduled: '2026-08-18 09:00' },
    }],
    buildEffectiveReminderContextForTarget: (target) => ({
      frontmatter: target.taskFrontmatter,
      propertyValue: target.taskFrontmatter.scheduled,
    }),
  });
  const nativeFile = new engineHarness.TFile('2026-08-18.md');
  candidateFiles.push(nativeFile);
  const app = {
    metadataCache: { getFileCache: () => ({ frontmatter: {} }) },
    vault: { getMarkdownFiles: () => [nativeFile], cachedRead: async () => '' },
  };
  const engine = new engineHarness.ReminderEngine(app, {});
  engine.buildUnmatchedExternalReminderTargets = async () => {
    throw new Error('synthetic external index failure');
  };

  const schedule = await engine.projectScheduledNotifications(settings, now);
  assert.equal(schedule.length, 128);
  assert.equal(schedule[0].fireAt, Date.parse('2026-08-18T21:15:00.000Z'));
  assert.equal(schedule[0].sourceKey, '2026-08-18.md::task:13');
});

test('reminder scheduler wakes at the shortest active repeat interval', () => {
  assert.match(mainSource, /const activeRepeatMs = \(this\.settings\.reminders \|\| \[\]\)/);
  assert.match(mainSource, /Math\.min\(pollMs, \.\.\.activeRepeatMs\)/);
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

test('delivery and overdue surfaces both suppress nested archive paths', async (t) => {
  const { shouldIgnoreForReminder } = loadTimeCalculationModule();
  const ignoredFile = { path: 'Markdown/_archive/Hidden.md', basename: 'Hidden', extension: 'md' };
  const visibleFile = { path: 'Markdown/Projects/Visible.md', basename: 'Visible', extension: 'md' };
  const dueFrontmatter = { scheduled: '2026-08-14 12:00' };

  for (const ignoreScope of ['global', 'per-rule']) {
    for (const targetKind of ['note', 'task']) {
      await t.test(`${ignoreScope} ${targetKind}`, async () => {
        const reminder = {
          id: 'scheduled-rule',
          enabled: true,
          property: 'scheduled',
          mode: 'task',
          offsetMinutes: 0,
          repeatUntilComplete: false,
          repeatIntervalMinutes: 5,
          maxRepeats: -1,
          stopConditions: [],
          title: 'Reminder',
          body: 'Due',
          ignorePaths: ignoreScope === 'per-rule' ? ['_archive'] : [],
        };
        const buildTarget = (file) => ({
          sourceKey: targetKind === 'task' ? `${file.path}::task:0` : file.path,
          sourceType: 'file',
          targetKind,
          taskTitle: targetKind === 'task' ? `Task in ${file.basename}` : undefined,
          taskFrontmatter: targetKind === 'task' ? { ...dueFrontmatter } : undefined,
          reminderTags: [],
        });
        const buildContext = (target, frontmatter, property) => {
          const effective = target.taskFrontmatter || frontmatter;
          return { frontmatter: effective, propertyValue: effective[property] };
        };
        const settings = {
          reminders: [reminder],
          alertState: {},
          archiveFolder: 'Unrelated/Calendar Archive',
          globalIgnorePaths: ignoreScope === 'global' ? ['_archive'] : [],
          globalIgnoreTags: [],
          globalIgnoreStatuses: [],
          globalIgnoreCheckboxStates: [],
          defaultAllDayBaseTime: '09:00',
          pollMinutes: 0.5,
          snoozeProperty: 'reminderSnooze',
          enableLogging: false,
          notificationSortDirection: 'asc',
          statusKey: 'status',
          externalCalendars: [],
        };
        const expectedSourceKey = targetKind === 'task'
          ? 'Markdown/Projects/Visible.md::task:0'
          : 'Markdown/Projects/Visible.md';

        const engineHarness = loadCompiledReminderEngineHarness({
          shouldIgnoreForReminder,
          candidateFiles: [ignoredFile, visibleFile],
          buildReminderTargetsForFile: async (_app, file) => [buildTarget(file)],
          buildEffectiveReminderContextForTarget: buildContext,
        });
        const engineApp = {
          metadataCache: { getFileCache: () => ({ frontmatter: { ...dueFrontmatter } }) },
          vault: { getMarkdownFiles: () => [], cachedRead: async () => '' },
        };
        const engine = new engineHarness.ReminderEngine(engineApp, {});
        const delivery = await engine.evaluateReminders(structuredClone(settings));
        assert.deepEqual(delivery.notifications.map((item) => item.sourceKey), [expectedSourceKey]);

        const overdueHarness = loadCompiledOverdueServiceHarness({
          shouldIgnoreForReminder,
          candidateFiles: [ignoredFile, visibleFile],
          buildReminderTargetsForFile: async (_app, file) => [buildTarget(file)],
          buildEffectiveReminderContextForTarget: buildContext,
          parseTimeRange: () => ({ start: Date.now() - 1_000, end: null }),
          getReminderTriggerBase: (start) => start,
        });
        const overdueApp = {
          metadataCache: { getFileCache: () => ({ frontmatter: { ...dueFrontmatter } }) },
          vault: { getMarkdownFiles: () => [ignoredFile, visibleFile] },
        };
        const overdue = new overdueHarness.OverdueService(overdueApp, () => structuredClone(settings));
        const items = await overdue.getOverdueItems();
        assert.deepEqual(items.map((item) => item.sourceKey), [expectedSourceKey]);
        assert.equal(items[0].targetKind, targetKind);
      });
    }
  }
});

test('ignore-path edits invalidate every reminder run and refresh open notification views', () => {
  assert.match(mainSource, /refreshReminderPolicy\(\): void \{[\s\S]*this\.restartReminderLoop\(\);[\s\S]*this\.refreshNotificationViews\(\);/);
  assert.match(mainSource, /runGeneration: number = this\.reminderRunGeneration/);
  assert.match(mainSource, /if \(runGeneration !== this\.reminderRunGeneration\) \{/);
  assert.doesNotMatch(mainSource, /runGeneration !== undefined && runGeneration !== this\.reminderRunGeneration/);
  assert.equal((settingsTabSource.match(/this\.plugin\.refreshReminderPolicy\(\);/g) || []).length, 8);
});

test('direct reminder delivery preserves ntfy ownership and adds role-agnostic local fallback', () => {
  const { resolveReminderDeliveryMode } = loadReminderRuntimePolicyModule();
  const resolve = (overrides = {}) => resolveReminderDeliveryMode({
    enableReminders: true,
    notificationDeliveryProvider: 'ntfy',
    isController: true,
    isMobile: false,
    supportsTishOSNativeNotifications: true,
    ...overrides,
  });

  assert.equal(resolve(), 'ntfy');
  assert.equal(resolve({ notificationDeliveryProvider: 'tishos' }), null);
  assert.equal(resolve({
    notificationDeliveryProvider: 'tishos',
    supportsTishOSNativeNotifications: false,
    isController: false,
  }), 'local-obsidian');
  assert.equal(resolve({
    notificationDeliveryProvider: 'tishos',
    supportsTishOSNativeNotifications: false,
    isController: false,
    isMobile: true,
  }), 'local-obsidian');
  assert.equal(resolve({ isController: false }), null);
  assert.equal(resolve({ isMobile: true }), null);
  assert.equal(resolve({
    enableReminders: false,
  }), null);
  assert.equal(resolve({
    enableReminders: 'true',
  }), null);
});

test('consuming checks reuse device-local alert state and local fallback exits before Messager lookup', () => {
  assert.match(typesSource, /notificationDeliveryProvider: NotificationDeliveryProvider/);
  assert.match(mainSource, /const evaluationAlertState = this\.cloneAlertState\(this\.settings\.alertState\)/);
  assert.match(mainSource, /const evaluationSettings: TPSControllerSettings = \{[\s\S]*alertState: evaluationAlertState/);
  assert.match(mainSource, /this\.settings\.alertState = evaluationAlertState;[\s\S]*this\.scheduleReminderStateSave\(\)/);
  assert.match(mainSource, /loadAlertStateFromLocalStorage\(\)/);
  assert.match(mainSource, /persistAlertStateToLocalStorage\(this\.settings\.alertState\)/);
  assert.doesNotMatch(mainSource, /localUserAlertState/);
  const localFallbackExit = mainSource.indexOf('if (deliveryMode === "local-obsidian")');
  const notifierLookup = mainSource.indexOf('const notifier = this.getNotifierPlugin();', localFallbackExit);
  assert.ok(localFallbackExit > 0 && notifierLookup > localFallbackExit);
  assert.match(mainSource.slice(localFallbackExit, notifierLookup), /return;/);
  assert.match(mainSource, /delivery:messager-skipped-role-change/);
  assert.match(mainSource, /check:join-active/);
  assert.match(mainSource, /check:discarded-stopped-run/);
});

test('provider-selected reminder loops start and stop with lifecycle, role, and captured delivery mode', () => {
  assert.match(mainSource, /if \(this\.deviceRoleManager\.isController\(\)\) \{[\s\S]*this\.enterControllerMode\(\);[\s\S]*\} else \{[\s\S]*this\.restartReminderLoop\(\)/);
  assert.match(mainSource, /if \(Platform\.isMobile\) \{[\s\S]*this\.stopAllAutomation\(\);[\s\S]*this\.restartReminderLoop\(\)/);
  assert.match(mainSource, /private exitControllerMode\(\) \{[\s\S]*this\.stopAllAutomation\(\);[\s\S]*this\.restartReminderLoop\(\)/);
  assert.match(mainSource, /const deliveryMode = this\.getReminderDeliveryMode\(\)/);
  assert.match(mainSource, /this\.runReminderCheck\(deliveryMode, runGeneration\)/);
  assert.match(mainSource, /private stopReminderLoop\(\) \{[\s\S]*this\.reminderRunGeneration\+\+/);
});

test('stale one-shot reminders expire without blocking repeat-until-complete rules', () => {
  const {
    getFileReminderLiveWindowMs,
    shouldSkipStaleOneShotReminder,
  } = loadReminderDeliveryWindowModule();
  const triggerTime = Date.UTC(2026, 6, 12, 12, 0, 0);
  const liveWindowMs = getFileReminderLiveWindowMs(0.5);

  assert.equal(liveWindowMs, 60 * 1000);
  assert.equal(shouldSkipStaleOneShotReminder(triggerTime + liveWindowMs, triggerTime, false, liveWindowMs), false);
  assert.equal(shouldSkipStaleOneShotReminder(triggerTime + liveWindowMs + 1, triggerTime, false, liveWindowMs), true);
  assert.equal(shouldSkipStaleOneShotReminder(triggerTime + (3 * 24 * 60 * 60 * 1000), triggerTime, false, liveWindowMs), true);
  assert.equal(shouldSkipStaleOneShotReminder(triggerTime + (3 * 24 * 60 * 60 * 1000), triggerTime, true, liveWindowMs), false);
  assert.equal(getFileReminderLiveWindowMs(60), 5 * 60 * 1000);
  assert.match(source, /shouldSkipStaleOneShotReminder\([\s\S]{0,180}reminder\.repeatUntilComplete/);
  assert.match(source, /notification:skipped-stale/);
  assert.match(source, /stale-one-shot/);
  assert.match(overdueSource, /getFileReminderLiveWindowMs\(settings\.pollMinutes\)/);
  assert.match(overdueSource, /shouldSkipStaleOneShotReminder\([\s\S]{0,180}reminder\.repeatUntilComplete/);
  assert.match(overdueSource, /staleOneShotHidden/);
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
  assert.match(mainSource, /normalizeReminderSettingsInPlace\(this\.settings\.reminders \|\| \[\]\)/);
  assert.doesNotMatch(mainSource, /const normalizedReminder = \{ \.\.\.reminder \}/);
});

test('triggered reminders show local system notices even without the sidebar or notifier', () => {
  assert.match(mainSource, /this\.showLocalReminderNotices\(batches\);/);
  assert.match(mainSource, /private showLocalReminderNotices/);
  assert.match(mainSource, /new Notice\(this\.buildLocalReminderNoticeFragment\(batch\), 10000\)/);
  assert.match(mainSource, /private buildLocalReminderNoticeFragment/);
  assert.match(mainSource, /items\.slice\(0, 5\)/);
  assert.match(mainSource, /Click to open note/);
  assert.match(mainSource, /private async openReminderNoticeTarget/);
  assert.match(mainSource, /private async openReminderFile/);
  assert.match(mainSource, /await leaf\.openFile\(file\)/);
  assert.match(mainSource, /await this\.overdueService\.openNotificationModal\(\)/);
  assert.match(mainSource, /TPS Notifier plugin not found\. Local system notices were shown\./);
  assert.match(mainSource, /Notifier plugin has no send API\. Local system notices were shown\./);
  assert.doesNotMatch(mainSource, /this\.restoreAlertStateAfterDeliveryFailure\(alertStateBeforeRun, "TPS Notifier plugin not found\."/);
  assert.doesNotMatch(mainSource, /this\.restoreAlertStateAfterDeliveryFailure\(alertStateBeforeRun, "Notifier plugin has no send API\."/);
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

test('reminder candidate discovery includes task-line reminder entities without parent frontmatter', () => {
  assert.match(reminderCandidateSource, /function hasReminderFrontmatter\(file: TFile, app: App, reminderProperties: Set<string>\): boolean/);
  assert.match(reminderCandidateSource, /async function hasReminderInlineTaskProperty\(file: TFile, app: App, reminderProperties: Set<string>\): Promise<boolean>/);
  assert.equal(reminderCandidateSource.includes('const TASK_LINE_PATTERN = /^\\s*(?:[-*+]|\\d+[.)])\\s+\\[[^\\]]?]\\s+/;'), true);
  assert.equal(reminderCandidateSource.includes('const INLINE_PROPERTY_PATTERN = /\\[([^\\[\\]:]+)::\\s*([^\\]]+)\\]/g;'), true);
  assert.match(reminderCandidateSource, /if \(hasReminderFrontmatter\(file, app, propertySet\)\) \{/);
  assert.match(reminderCandidateSource, /for \(const key of Object\.keys\(frontmatter\)\) \{/);
  assert.match(reminderCandidateSource, /reminderProperties\.has\(key\.trim\(\)\.toLowerCase\(\)\)/);
  assert.doesNotMatch(reminderCandidateSource, /const keys = new Set/);
  assert.match(reminderCandidateSource, /await app\.vault\.cachedRead\(file\)/);
  assert.match(reminderCandidateSource, /if \(!TASK_LINE_PATTERN\.test\(line\)\) continue;/);
  assert.match(reminderCandidateSource, /if \(key && reminderProperties\.has\(key\)\) return true;/);
  assert.match(source, /discoverReminderCandidateFiles\(this\.app, settings, properties\)/);
  assert.match(overdueSource, /getReminderCandidateFiles\(\s*this\.app,/);
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

  assert.deepEqual(result.files.map(({ path }) => path), ['Alpha.md', 'Inline.md', 'Zeta.md']);
  assert.deepEqual(cachedReads, ['Inherited.md', 'Inline.md', 'None.md']);
});

test('reminder task parsing ignores task examples inside fenced code blocks', () => {
  assert.match(reminderCandidateSource, /const FENCED_CODE_BLOCK_PATTERN = \/\^\\s\*\(```\|~~~\)\//);
  assert.match(reminderTargetSource, /const FENCED_CODE_BLOCK_PATTERN = \/\^\\s\*\(```\|~~~\)\//);
  assert.match(reminderCandidateSource, /let inFencedCodeBlock = false/);
  assert.match(reminderTargetSource, /let inFencedCodeBlock = false/);
  assert.match(reminderCandidateSource, /if \(FENCED_CODE_BLOCK_PATTERN\.test\(line\)\) \{/);
  assert.match(reminderTargetSource, /if \(FENCED_CODE_BLOCK_PATTERN\.test\(line\)\) \{/);
  assert.match(reminderCandidateSource, /if \(inFencedCodeBlock\) continue;\s+if \(!TASK_LINE_PATTERN\.test\(line\)\) continue;/);
  assert.match(reminderTargetSource, /if \(inFencedCodeBlock\) continue;[\s\S]{0,500}const parsed = parseTaskReminderLine\(line\)/);
});

test('reminder target builder does not create task targets from fenced markdown examples', async () => {
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

  assert.equal(taskTargets.length, 1);
  assert.equal(taskTargets[0].taskTitle, '[[Real Task]]');
  assert.equal(taskTargets[0].taskLine, 4);
});

test('native calendar reminders use the semantic event title instead of a wikilink or dated filename', async () => {
  const { buildReminderDisplayName, buildReminderTargetsForFile } = loadReminderTargetModule();
  const app = { vault: { cachedRead: async () => '' } };
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

  const [target] = await buildReminderTargetsForFile(app, file, frontmatter, {});

  assert.equal(target.noteTitle, 'Semantic event title');
  assert.equal(buildReminderDisplayName(file, target), 'Semantic event title');
  assert.doesNotMatch(buildReminderDisplayName(file, target), /\[\[|2026-08-28/);

  const regularFile = { basename: 'Project Notes' };
  assert.equal(buildReminderDisplayName(regularFile, { sourceType: 'file' }), 'Project Notes');
});

test('task-level reminder targets preserve task title and containing note', () => {
  assert.match(reminderTargetSource, /parseTaskReminderLine/);
  assert.match(reminderTargetSource, /sourceKey: `\$\{file\.path\}::task:\$\{index\}`/);
  assert.match(reminderTargetSource, /targetKind: "task"/);
  assert.match(reminderTargetSource, /taskTitle: parsed\.title/);
  assert.match(reminderTargetSource, /taskRawLine: lines\[index\]/);
  assert.match(reminderTargetSource, /const noteTitle = buildNoteDisplayName\(file, frontmatter\)/);
  assert.match(reminderTargetSource, /noteTitle,/);
  assert.match(reminderTargetSource, /props\[key\.toLowerCase\(\)\] = value/);
  assert.match(overdueSource, /taskTitle: target\.taskTitle/);
  assert.match(overdueSource, /taskRawLine: target\.taskRawLine/);
  assert.match(overdueSource, /taskLine: target\.taskLine/);
  assert.match(overdueSource, /item\.targetKind === "task" && typeof item\.taskLine === "number"/);
  assert.match(overdueSource, /updateTaskLineProperties/);
  assert.match(overdueSource, /applyInlinePropertyPatch/);
  assert.match(notificationViewSource, /item\.targetKind === 'task' && item\.taskTitle/);
  assert.match(notificationViewSource, /getItemNoteSubtitle/);
  assert.match(notificationViewSource, /tps-notification-note-title/);
});

test('Daily Note task inheritance follows GCM while ignore tags stay scoped to each reminder target', async () => {
  const policy = { available: true, isDailyNote: true, inheritUnscheduled: false };
  const {
    buildEffectiveReminderContextForTarget,
    buildReminderTargetsForFile,
    getReminderTagsForTarget,
  } = loadReminderTargetModule(policy);
  const { shouldIgnoreForReminder } = loadTimeCalculationModule();
  const file = { path: 'System/Dailynotes/2026-08-10.md', basename: '2026-08-10', extension: 'md' };
  const frontmatter = { scheduled: '2026-08-10', tags: ['dailynote'] };
  const app = {
    vault: {
      async cachedRead() {
        return [
          'Daily context #journal',
          '- [ ] Inherited task',
          '- [ ] Explicit task #dailynote #taskonly [scheduled:: 2026-08-10 10:00]',
        ].join('\n');
      },
    },
  };

  const targets = await buildReminderTargetsForFile(app, file, frontmatter, {});
  const note = targets.find((target) => target.targetKind === 'note');
  const inherited = targets.find((target) => target.taskTitle === 'Inherited task');
  const explicit = targets.find((target) => target.taskTitle === 'Explicit task');
  assert.ok(note);
  assert.ok(inherited);
  assert.ok(explicit);

  assert.equal(buildEffectiveReminderContextForTarget(inherited, frontmatter, 'scheduled', {}), null);
  assert.equal(
    buildEffectiveReminderContextForTarget(explicit, frontmatter, 'scheduled', {}).propertyValue,
    '2026-08-10 10:00',
  );
  assert.equal(
    buildEffectiveReminderContextForTarget(note, frontmatter, 'scheduled', {}).propertyValue,
    '2026-08-10',
  );

  const reminder = { ignoreTags: ['dailynote'] };
  assert.equal(shouldIgnoreForReminder(file, null, frontmatter, reminder, [], [], [], [], getReminderTagsForTarget(note)), true);
  assert.equal(shouldIgnoreForReminder(file, null, inherited.taskFrontmatter, reminder, [], [], [], [], getReminderTagsForTarget(inherited)), false);
  assert.equal(shouldIgnoreForReminder(file, null, explicit.taskFrontmatter, reminder, [], [], [], [], getReminderTagsForTarget(explicit)), true);
  assert.deepEqual(getReminderTagsForTarget(note).sort(), ['#dailynote', '#journal']);
  assert.deepEqual(getReminderTagsForTarget(explicit).sort(), ['#dailynote', '#taskonly']);
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

test('Controller preserves historical task date inheritance when the GCM policy API is unavailable', async () => {
  const { buildEffectiveReminderContextForTarget, buildReminderTargetsForFile } = loadReminderTargetModule();
  const file = { path: 'Notes/Project.md', basename: 'Project', extension: 'md' };
  const frontmatter = { scheduled: '2026-08-10' };
  const app = { vault: { cachedRead: async () => '- [ ] Inherited task' } };
  const targets = await buildReminderTargetsForFile(app, file, frontmatter, {});
  const task = targets.find((target) => target.targetKind === 'task');

  assert.equal(
    buildEffectiveReminderContextForTarget(task, frontmatter, 'scheduled', {}).propertyValue,
    '2026-08-10',
  );
});

test('notification sidebar uses task icons for task reminder rows', () => {
  assert.match(notificationViewSource, /private getItemIcon\(item: OverdueItem\): \{ icon: string; color: string \}/);
  assert.match(notificationViewSource, /if \(item\.targetKind === 'task'\) \{/);
  assert.match(notificationViewSource, /return \{ icon: 'check-square', color: 'var\(--text-muted\)' \}/);
  assert.match(notificationViewSource, /const \{ icon: iconName, color: iconColor \} = this\.getItemIcon\(item\)/);
  assert.doesNotMatch(notificationViewSource, /const iconName = rawIcon\.includes\(': '\)/);
});

test('notification sidebar titles can extend under row action buttons', () => {
  assert.match(notificationViewSource, /row\.style\.position = 'relative'/);
  assert.match(notificationViewSource, /content\.style\.minWidth = '0'/);
  assert.match(notificationViewSource, /actions\.style\.position = 'absolute'/);
  assert.match(notificationViewSource, /actions\.style\.right = '12px'/);
  assert.match(notificationViewSource, /actions\.style\.transform = 'translateY\(-50%\)'/);
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

test('reminder external task matching reads hidden inline metadata comments', () => {
  assert.match(source, /\(\?:tpsinlineprops\|tps-inline-props\|data-tps-inline-props\|\\\[\\\^tps-inline:\)/);
  assert.match(source, /private parseHiddenInlineMetadata\(line: string, encoded\?: string\): Record<string, unknown>/);
  assert.match(source, /%%\\s\*tps-inline-props:\(\[\\s\\S]\*\?\)\\s\*%%/);
  assert.match(source, /this\.mergeInlineMetadata\(hiddenProps, raw, !hiddenMatch\[1]\)/);
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

test('task reminder entity status is derived from checkbox marker, not parent note status', () => {
  assert.match(reminderTargetSource, /const noteStatus = getFrontmatterValueCaseInsensitive\(frontmatter, "status"\)/);
  assert.match(reminderTargetSource, /noteStatus,/);
  assert.match(reminderTargetSource, /const parsedStatus = typeof properties\.status === "string" \? properties\.status\.trim\(\) : properties\.status/);
  assert.match(reminderTargetSource, /if \(parsedStatus\) properties\.inlineStatus = parsedStatus/);
  assert.match(reminderTargetSource, /properties\.status = markerStatus/);
  assert.match(reminderTargetSource, /properties\.checkboxStatus = markerStatus/);
  assert.match(reminderTargetSource, /properties\.checkboxState = checkboxState/);
  assert.match(reminderTargetSource, /properties\.taskCheckboxState = checkboxState/);
  assert.match(reminderTargetSource, /properties\.taskStatus = markerStatus/);
  assert.match(reminderTargetSource, /if \(marker === "x"\) return "complete"/);
  assert.match(reminderTargetSource, /if \(marker === "-" \|\| marker === "~"\) return "wont-do"/);
  assert.match(reminderTargetSource, /props\[key] = value/);
  assert.match(reminderTargetSource, /props\[key\.toLowerCase\(\)] = value/);
  assert.match(reminderTargetSource, /\.\.\.frontmatter,\s+\.\.\.parsed\.properties,\s+noteStatus,/);
  assert.doesNotMatch(reminderTargetSource, /properties\.status = markerStatus !== "todo" \|\| !parsedStatus \? markerStatus : parsedStatus/);
});

test('reminder rules evaluate checkbox states separately from statuses', () => {
  assert.match(typesSource, /ignoreCheckboxStates\?: string\[\]/);
  assert.match(typesSource, /requiredCheckboxStates\?: string\[\]/);
  assert.match(typesSource, /globalIgnoreCheckboxStates: string\[\]/);
  assert.match(typesSource, /globalIgnoreCheckboxStates: \["x", "-"\]/);
  assert.match(timeCalculationSource, /export function normalizeCheckboxState\(value: unknown\): string/);
  assert.match(timeCalculationSource, /raw === "space" \|\| raw === "blank" \|\| raw === "empty" \|\| raw === "open" \|\| raw === "todo"/);
  assert.match(timeCalculationSource, /export function hasRequiredCheckboxState\(fm: any, reminder: PropertyReminder\): boolean/);
  assert.match(timeCalculationSource, /const states = getCheckboxStates\(fm\)/);
  assert.match(timeCalculationSource, /if \(states\.length === 0\) return false/);
  assert.match(timeCalculationSource, /globalIgnoreCheckboxStates: string\[\] = \[\]/);
  assert.match(timeCalculationSource, /const ignoreCheckboxStates = Array\.isArray\(reminder\.ignoreCheckboxStates\)/);
  assert.match(timeCalculationSource, /const checkboxStates = new Set<string>\(getCheckboxStates\(fm\)\)/);
  assert.match(source, /hasRequiredStatus, hasRequiredCheckboxState, shouldIgnoreForReminder/);
  assert.match(source, /settings\.globalIgnoreStatuses,\s+settings\.globalIgnoreCheckboxStates,/);
  assert.match(source, /if \(!hasRequiredCheckboxState\(effectiveFm, reminder\)\) \{\s+this\.countSkip\(params\.stats, "checkbox-filter"\);\s+continue;\s+\}/);
  assert.match(overdueSource, /hasRequiredStatus, hasRequiredCheckboxState,/);
  assert.match(overdueSource, /const ignoreCheckboxStates = settings\.globalIgnoreCheckboxStates \|\| \[\]/);
  assert.match(overdueSource, /ignoreStatuses, ignoreCheckboxStates/);
  assert.match(settingsTabSource, /Ignore Checkbox States/);
  assert.match(settingsTabSource, /Required Checkbox States/);
  assert.match(reminderSettingsSource, /if \(!Array\.isArray\(reminder\.ignoreCheckboxStates\)\) reminder\.ignoreCheckboxStates = \[\]/);
  assert.match(reminderSettingsSource, /if \(!Array\.isArray\(reminder\.requiredCheckboxStates\)\) reminder\.requiredCheckboxStates = \[\]/);
});

test('migrated task records are never re-enqueued as reminders', () => {
  const { normalizeCheckboxState, shouldIgnoreForReminder } = loadTimeCalculationModule();
  const file = { path: 'Daily/2026-08-10.md', basename: '2026-08-10' };
  const reminder = {};

  assert.equal(normalizeCheckboxState('migrated'), '>');
  assert.equal(shouldIgnoreForReminder(file, null, { status: 'migrated' }, reminder, [], [], [], []), true);
  assert.equal(shouldIgnoreForReminder(file, null, { checkboxState: '>' }, reminder, [], [], [], []), true);
  assert.match(reminderTargetSource, /if \(marker === ">"\) return "migrated"/);
  assert.match(timeCalculationSource, /if \(statuses\.has\("migrated"\) \|\| checkboxStates\.has\(">"\)\) \{/);
});

test('migrated task blocks suppress their nested scratchpad tasks from reminder discovery', async () => {
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
  assert.deepEqual(targets.filter((target) => target.targetKind === 'task').map((target) => target.taskTitle), [
    'Active task',
  ]);
  assert.match(reminderTargetSource, /let migratedTaskIndent: number \| null = null/);
  assert.match(reminderTargetSource, /if \(parsed\.properties\.status === "migrated"\)/);
});

test('open checklist reminders surface task rows instead of parent note rows', () => {
  assert.doesNotMatch(
    reminderTargetSource,
    /some\(\(key\) => \["scheduled", "due", "date", "start"\]\.includes\(key\.toLowerCase\(\)\)\)/,
  );
  assert.match(reminderTargetSource, /properties\.status = markerStatus/);
  assert.match(overdueSource, /const taskBackedReminderKeys = new Set/);
  assert.match(overdueSource, /filter\(\(item\) => item\.targetKind === "task"\)/);
  assert.match(overdueSource, /item\.targetKind !== "note"/);
  assert.match(overdueSource, /taskBackedReminderKeys\.has\(`\$\{item\.file\.path\}::\$\{item\.reminder\.id\}`\)/);
  assert.match(source, /const fileNotifications: PendingNotification\[\] = \[\]/);
  assert.match(source, /suppressNoteNotificationsBackedByTaskNotifications\(fileNotifications, alertState\)/);
  assert.match(source, /notification\.sourceKey\.includes\("::task:"\)/);
  assert.match(source, /notification\.sourceKey !== notification\.file\.path/);
  assert.match(source, /state\.triggered = false/);
  assert.match(source, /state\.lastTriggerKey = undefined/);
});

test('task reminder rows resolve schedule instead of showing a status pill', () => {
  assert.match(reminderTargetSource, /taskPropertyKeys\?: string\[\]/);
  assert.match(reminderTargetSource, /taskPropertyKeys: Object\.keys\(parsed\.properties\)/);
  assert.match(overdueSource, /reminderPropertySource: this\.getReminderPropertySource\(target, reminder\.property\)/);
  assert.match(overdueSource, /async resolveTaskReminder\(item: OverdueItem\): Promise<boolean>/);
  assert.match(overdueSource, /item\.reminderPropertySource === "task"/);
  assert.match(overdueSource, /private async clearFileReminderProperty\(file: TFile, property: string\): Promise<void>/);
  assert.match(overdueSource, /await this\.updateTaskLineProperties\(item, \{ \[property\]: null \}, "clear-task-reminder"\)/);
  assert.match(overdueSource, /return this\.moveTaskToFile\(item, targetFile\)/);
  assert.match(notificationViewSource, /resolveOverdueTaskReminder\?\(item: OverdueItem\): Promise<boolean>/);
  assert.match(notificationViewSource, /item\.sourceType !== 'external-event' && !!item\.reminder\.property/);
  assert.match(notificationViewSource, /const shouldMoveTask = item\.targetKind === 'task' && item\.reminderPropertySource !== 'task'/);
  assert.match(notificationViewSource, /const changed = this\.plugin\.resolveOverdueTaskReminder/);
  assert.match(notificationViewSource, /if \(changed\) this\.removeItemOptimistically\(item\)/);
  assert.match(notificationViewSource, /new Notice\('Could not move or clear the reminder task\.'\)/);
  assert.match(notificationViewSource, /new ConfirmClearScheduledModal\(this\.app, item/);
  assert.match(notificationViewSource, /class ConfirmClearScheduledModal extends Modal/);
  assert.match(notificationViewSource, /text: 'Clear scheduled'/);
  assert.match(notificationViewSource, /this\.refreshDebounced\(\)/);
  assert.doesNotMatch(notificationViewSource, /window\.setTimeout\(\(\): void => void this\.refresh\(\), 100\)/);
  assert.match(mainSource, /resolveOverdueTaskReminder\(item: OverdueItem\): Promise<boolean>/);
});

test('notification task moves use GCM v3 configured Daily Note semantics with user cause', () => {
  assert.match(overdueSource, /private findCurrentTaskLineIndex\(lines: string\[\], item: OverdueItem\): number/);
  assert.match(overdueSource, /this\.isSameTaskLine\(lines\[preferredIndex\] \|\| "", item\)/);
  assert.match(overdueSource, /const rawLine = String\(item\.taskRawLine \|\| ""\)/);
  assert.match(overdueSource, /lines\.findIndex\(\(line\) => line === rawLine && this\.isTaskLine\(line \|\| ""\)\)/);
  assert.match(overdueSource, /private isSameTaskLine\(line: string, item: OverdueItem\): boolean/);
  assert.match(overdueSource, /this\.normalizeTaskText\(this\.cleanTaskLineTitle\(line \|\| ""\)\) === normalizedTitle/);
  assert.match(overdueSource, /const resolvedIndex = this\.findCurrentTaskLineIndex\(lines, item\)/);
  assert.match(overdueSource, /item\.taskLine = resolvedIndex/);
  assert.match(overdueSource, /item\.taskRawLine = lines\[resolvedIndex\]/);
  assert.match(overdueSource, /const attempt = await moveTaskViaGcm\(/);
  assert.match(overdueSource, /lineNumber: Math\.max\(0, Math\.floor\(item\.taskLine\)\)/);
  assert.match(overdueSource, /rawLine: item\.taskRawLine/);
  assert.match(overdueSource, /title: item\.taskTitle/);
  assert.match(overdueSource, /sourcePolicy: "configured-daily-note"/);
  assert.match(overdueSource, /resolution: "exact-or-identity"/);
  assert.match(overdueSource, /kind: "user"/);
  assert.match(overdueSource, /sourcePluginId: "tps-controller"/);
  assert.match(overdueSource, /surface: "reminder-modal"/);
  assert.match(overdueSource, /requiredTaskApiVersion: 3/);
  assert.match(overdueSource, /move-task:gcm-rejected/);
  assert.match(overdueSource, /route: "gcm-task-api-v3"/);
  assert.match(overdueSource, /new TargetFileSuggestModal\(this\.app, sourcePath, resolve\)/);
  assert.match(overdueSource, /\.filter\(\(file\) => file\.path !== this\.excludedPath\)/);
  assert.doesNotMatch(overdueSource, /buildDailyNoteScratchpadMovedTaskBlock/);
  assert.doesNotMatch(overdueSource, /completedDate: "null"/);
  assert.match(overdueSource, /private didSettle = false/);
  assert.match(overdueSource, /window\.setTimeout\(\(\) => \{/);
  assert.match(overdueSource, /if \(!this\.didChoose\) this\.settle\(null\)/);
  assert.match(overdueSource, /private settle\(file: TFile \| null\): void/);
  assert.doesNotMatch(overdueSource, /preferredIndex >= 0 && this\.isTaskLine\(lines\[preferredIndex\] \|\| ""\)\) return preferredIndex/);
});

test('compiled reminder move picker excludes the source note and canceling does not call GCM', async () => {
  const harness = loadCompiledOverdueServiceHarness();
  harness.setMoveImplementation(async () => {
    throw new Error('GCM should not be called when the picker is canceled');
  });
  const fixture = beginCompiledReminderMove(harness);

  assert.equal(fixture.modal.placeholder, 'Move task to note...');
  assert.deepEqual(
    fixture.modal.getItems().map((file) => file.path),
    ['Projects/Alpha.md', 'Projects/Zulu.md'],
  );

  const previousWindow = globalThis.window;
  globalThis.window = {
    setTimeout(callback) {
      callback();
      return 1;
    },
  };
  try {
    fixture.modal.onClose();
    fixture.modal.onClose();
    assert.equal(await fixture.pending, false);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }

  assert.equal(harness.moveCalls.length, 0);
  assert.deepEqual(harness.notices, []);
  assert.equal(
    harness.logs.filter(({ args }) => args[1] === 'resolve-reminder:canceled').length,
    1,
  );
});

test('compiled reminder moves honor every GCM v3 outcome without corrupting source coordinates', async (t) => {
  const cases = [
    {
      name: 'unavailable API',
      response: { available: false, result: null },
      expected: false,
      notice: 'Update TPS Global Context Menu before moving reminder tasks.',
      logEvent: 'move-task:gcm-unavailable',
    },
    {
      name: 'rejected mutation',
      response: {
        available: true,
        result: { ok: false, changed: false, task: null, error: 'source is stale' },
      },
      expected: false,
      notice: 'Could not move task: source is stale',
      logEvent: 'move-task:gcm-rejected',
    },
    {
      name: 'partial mutation report',
      response: {
        available: true,
        result: { ok: false, changed: true, task: null, error: 'target copy may remain' },
      },
      expected: false,
      notice: 'Could not move task: target copy may remain',
      logEvent: 'move-task:gcm-rejected',
    },
    {
      name: 'committed move with unavailable refreshed task',
      response: {
        available: true,
        result: { ok: true, changed: true, task: null, error: 'refresh unavailable' },
      },
      expected: true,
      notice: 'Moved task to Alpha.',
      logEvent: 'move-task:done',
      movedLine: -1,
    },
    {
      name: 'committed move with refreshed target coordinates',
      response: {
        available: true,
        result: {
          ok: true,
          changed: true,
          task: {
            path: 'Projects/Alpha.md',
            lineNumber: 6,
            rawLine: '- [ ] Moved task [tpsId:: task_move]',
            title: 'Moved task',
          },
        },
      },
      expected: true,
      notice: 'Moved task to Alpha.',
      logEvent: 'move-task:done',
      movedLine: 6,
      updatesCoordinates: true,
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const harness = loadCompiledOverdueServiceHarness();
      harness.setMoveImplementation(async () => scenario.response);
      const fixture = beginCompiledReminderMove(harness);

      fixture.modal.onChooseItem(fixture.targetFile);
      assert.equal(await fixture.pending, scenario.expected);

      assert.equal(harness.moveCalls.length, 1);
      const [app, reference, target, cause] = harness.moveCalls[0];
      assert.equal(app, fixture.app);
      assert.deepEqual(reference, {
        path: 'Daily/2026-08-10.md',
        lineNumber: 12,
        rawLine: '- [ ] Move me [scheduled:: 2026-08-10 09:00] [tpsId:: task_move]',
        title: 'Move me',
      });
      assert.deepEqual(target, {
        targetPath: 'Projects/Alpha.md',
        sourcePolicy: 'configured-daily-note',
        resolution: 'exact-or-identity',
      });
      assert.deepEqual(cause, {
        kind: 'user',
        sourcePluginId: 'tps-controller',
        surface: 'reminder-modal',
      });
      assert.deepEqual(harness.notices, [scenario.notice]);
      assert.ok(harness.logs.some(({ args }) => args[1] === scenario.logEvent));

      if (scenario.updatesCoordinates) {
        assert.equal(fixture.item.file, fixture.targetFile);
        assert.equal(fixture.item.taskLine, 6);
        assert.equal(fixture.item.taskRawLine, '- [ ] Moved task [tpsId:: task_move]');
        assert.equal(fixture.item.taskTitle, 'Moved task');
        assert.equal(fixture.item.noteTitle, 'Alpha');
      } else {
        assert.equal(fixture.item.file, fixture.sourceFile);
        assert.equal(fixture.item.taskLine, 12.8);
        assert.equal(
          fixture.item.taskRawLine,
          '- [ ] Move me [scheduled:: 2026-08-10 09:00] [tpsId:: task_move]',
        );
        assert.equal(fixture.item.taskTitle, 'Move me');
        assert.equal(fixture.item.noteTitle, '2026-08-10');
      }

      if (scenario.expected) {
        const doneLog = harness.logs.find(({ args }) => args[1] === 'move-task:done');
        assert.equal(doneLog.args[2].route, 'gcm-task-api-v3');
        assert.equal(doneLog.args[2].movedPath, 'Projects/Alpha.md');
        assert.equal(doneLog.args[2].movedLine, scenario.movedLine);
      }
    });
  }
});

test('compiled reminder move propagates a thrown GCM failure for the notification action boundary', async () => {
  const harness = loadCompiledOverdueServiceHarness();
  const failure = new Error('transport failed');
  harness.setMoveImplementation(async () => {
    throw failure;
  });
  const fixture = beginCompiledReminderMove(harness);

  fixture.modal.onChooseItem(fixture.targetFile);
  await assert.rejects(fixture.pending, (error) => error === failure);

  assert.equal(harness.moveCalls.length, 1);
  assert.deepEqual(harness.notices, []);
  assert.equal(fixture.item.file, fixture.sourceFile);
  assert.equal(fixture.item.taskLine, 12.8);
  assert.equal(fixture.item.taskTitle, 'Move me');
  assert.ok(harness.logs.some(({ args }) => args[1] === 'move-task:start'));
  assert.equal(harness.logs.some(({ args }) => args[1] === 'move-task:done'), false);
});

test('notification sort direction can be reversed from settings', () => {
  assert.match(typesSource, /notificationSortDirection: "asc" \| "desc"/);
  assert.match(typesSource, /notificationSortDirection: "asc"/);
  assert.match(settingsTabSource, /Notification Sort Direction/);
  assert.match(settingsTabSource, /\.addOption\('asc', 'Oldest first'\)/);
  assert.match(settingsTabSource, /\.addOption\('desc', 'Newest first'\)/);
  assert.match(settingsTabSource, /this\.plugin\.settings\.notificationSortDirection = value === 'desc' \? 'desc' : 'asc'/);
  assert.match(settingsTabSource, /this\.plugin\.refreshNotificationViews\(\)/);
  assert.match(mainSource, /refreshNotificationViews\(\): void/);
  assert.match(overdueSource, /const sortDirection = this\.getSettings\(\)\.notificationSortDirection === "desc" \? -1 : 1/);
  assert.match(overdueSource, /return delta \* sortDirection/);
});

test('overdue modal complete actions are single-click and preserve list position', () => {
  assert.match(overdueModalSource, /private suppressedItemKeys = new Set<string>\(\)/);
  assert.match(overdueModalSource, /this\.suppressedItemKeys\.add\(key\)/);
  assert.match(overdueModalSource, /nextItems\.filter\(\(item\) => !this\.suppressedItemKeys\.has\(this\.getItemKey\(item\)\)\)/);
  assert.match(overdueModalSource, /const previousScrollTop = this\.container\.scrollTop/);
  assert.match(overdueModalSource, /this\.container\.scrollTop = previousScrollTop/);
  assert.match(overdueModalSource, /if \(button\.disabled\) return/);
  assert.match(overdueModalSource, /button\.disabled = true/);
  assert.match(overdueModalSource, /this\.refreshDebounced\(\)/);
  assert.match(overdueModalSource, /this\.suppressedItemKeys\.delete\(this\.getItemKey\(item\)\)/);
  assert.doesNotMatch(overdueModalSource, /window\.setTimeout\(\(\): void => void this\.refresh\(\), 100\)/);
});

test('notification sidebar refreshes are coalesced to avoid action lag', () => {
  assert.match(notificationViewSource, /private isRefreshing = false/);
  assert.match(notificationViewSource, /private refreshPending = false/);
  assert.match(notificationViewSource, /private lastRenderedSignature = '\\u0000'/);
  assert.match(notificationViewSource, /}, 750, false\)/);
  assert.match(notificationViewSource, /window\.setInterval\(\(\) => this\.refreshDebounced\(\), 30000\)/);
  assert.match(notificationViewSource, /if \(this\.isRefreshing\) \{/);
  assert.match(notificationViewSource, /this\.refreshPending = true/);
  assert.match(notificationViewSource, /buildNotificationItemsSignature\(nextItems\)/);
  assert.match(notificationViewSource, /nextSignature !== this\.lastRenderedSignature/);
  assert.match(notificationViewSource, /\[NotificationView\] slow refresh/);
});
