import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

class FakeFile {
  constructor(path) {
    this.path = path;
    this.basename = path.split("/").pop().replace(/\.md$/i, "");
    this.name = path.split("/").pop();
    this.extension = "md";
    this.parent = {
      path: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "/",
    };
  }
}

let gcmAttemptHandler = async () => ({ available: false, file: null });

function loadDailyTemplateModule() {
  const sourceText = readFileSync(new URL("../src/services/daily-note-template.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(sourceText, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  const module = { exports: {} };
  new Function("module", "exports", "require", compiled.outputText)(module, module.exports, () => {
    throw new Error("Daily Note template helper has no runtime imports.");
  });
  return module.exports;
}

function loadExternalCalendarInlineTaskModule() {
  const sourceText = readFileSync(new URL("../src/services/external-calendar-inline-task.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(sourceText, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  const module = { exports: {} };
  new Function("module", "exports", "require", compiled.outputText)(module, module.exports, () => {
    throw new Error("External calendar inline-task helper has no runtime imports.");
  });
  return module.exports;
}

function loadExternalCalendarTaskNoteModule() {
  const sourceText = readFileSync(new URL("../src/services/external-calendar-task-note.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(sourceText, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  const module = { exports: {} };
  const requireImpl = (specifier) => {
    if (specifier === "obsidian") return { normalizePath };
    if (specifier === "../utils") {
      return { normalizeCalendarUrl: (value) => String(value || "").trim().replace(/\/+$/u, "") };
    }
    if (specifier === "../types") return {};
    throw new Error(`Unexpected task-note helper import: ${specifier}`);
  };
  new Function("module", "exports", "require", compiled.outputText)(module, module.exports, requireImpl);
  return module.exports;
}

function loadAutoCreateService() {
  const dailyTemplate = loadDailyTemplateModule();
  const externalCalendarInlineTask = loadExternalCalendarInlineTaskModule();
  const externalCalendarTaskNote = loadExternalCalendarTaskNoteModule();
  const sourceText = readFileSync(new URL("../src/services/auto-create-service.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(sourceText, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  const module = { exports: {} };
  const logger = {
    flow() {},
    flowWarn() {},
    flowError() {},
    warn() {},
    error() {},
  };
  const noOp = () => null;
  const requireImpl = (specifier) => {
    if (specifier === "obsidian") {
      return {
        App: class {},
        Notice: class {},
        TFile: FakeFile,
        normalizePath,
      };
    }
    if (specifier === "../logger") return logger;
    if (specifier === "./external-event-modal") return { createMeetingNoteFromExternalEvent: noOp };
    if (specifier === "../utils") {
      return {
        formatDateTimeForFrontmatter: (date) => {
          const pad = (part) => String(part).padStart(2, "0");
          return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
        },
        matchesExclusionPattern: () => false,
        normalizeCalendarUrl: (value) => String(value || ""),
        normalizeComparablePath: (value) => String(value || ""),
        parseFrontmatterDate: () => null,
      };
    }
    if (specifier === "../utils/tag-utils") return { normalizeTagValue: (value) => String(value || "") };
    if (specifier === "../tps-gcm-api") {
      return {
        buildCalendarExternalId: (_app, event) => `calendar:${event.sourceUrl || ""}#${event.id}`,
        emitFilesUpdated() {},
        ensureDailyNoteForIsoDateViaGcm: (...args) => gcmAttemptHandler(...args),
        ensureInternalIdInFrontmatter: () => "",
        getExternalId: () => "",
      };
    }
    if (specifier === "./daily-note-template") return dailyTemplate;
    if (specifier === "./external-calendar-cancellation") return { cancelOpenInlineTaskLine: noOp };
    if (specifier === "./external-calendar-inline-task") return externalCalendarInlineTask;
    if (specifier === "./external-calendar-task-note") return externalCalendarTaskNote;
    if (specifier === "./external-calendar-service") return {};
    if (specifier === "../types") return {};
    throw new Error(`Unexpected AutoCreateService test import: ${specifier}`);
  };
  new Function("module", "exports", "require", compiled.outputText)(module, module.exports, requireImpl);
  return module.exports;
}

function createHarness({
  dailyNotes = {
    folder: "Inbox/Daily",
    format: "YYYY/MM/DD",
    template: "Templates/Daily",
  },
  templates = {
    dateFormat: "dddd, MMMM D",
    timeFormat: "HH.mm",
  },
  persistedDailyNotes = null,
  persistedTemplates = null,
  includeTemplate = true,
  initialFiles = {},
  templaterAutoTrigger = false,
  templaterLocalAutoTrigger,
  templaterLegacyAutoTrigger,
  templaterLocalSettingsUnavailable = false,
  templaterAutoDelayMs = 15,
  templaterEventName = "templater:overwrite-file",
  templaterTransform = async (content) => (
    content.replace("<% controller-template-body %>", "Controller template body")
  ),
} = {}) {
  const files = new Map();
  const fileTimes = new Map();
  const folders = new Set([""]);
  const workspaceListeners = new Map();
  let createCount = 0;
  let templaterRuns = 0;
  const templaterPendingFiles = new Set();
  const hasLocalTemplaterSetting = templaterLocalSettingsUnavailable !== true;
  const localTemplaterAutoCreate = templaterLocalAutoTrigger
    ?? templaterAutoTrigger;
  const legacyTemplaterAutoCreate = templaterLegacyAutoTrigger
    ?? templaterAutoTrigger;
  const triggerWorkspaceEvent = (name, detail) => {
    for (const callback of workspaceListeners.get(name) ?? []) callback(detail);
  };
  if (includeTemplate) {
    files.set("Templates/Daily.md", [
      "---",
      "title: {{date}}",
      "createdAt: {{time}}",
      "kind: dailynote",
      "---",
      "",
      "<% controller-template-body %>",
    ].join("\n"));
    fileTimes.set("Templates/Daily.md", Date.now() - 10_000);
  }
  for (const [path, content] of Object.entries(initialFiles)) {
    const normalized = normalizePath(path);
    files.set(normalized, String(content));
    fileTimes.set(normalized, Date.now() - 10_000);
  }

  const fileFor = (path) => {
    if (!files.has(path)) return null;
    const file = new FakeFile(path);
    const timestamp = fileTimes.get(path) ?? (Date.now() - 10_000);
    file.stat = {
      ctime: timestamp,
      mtime: timestamp,
      size: String(files.get(path) || "").length,
    };
    return file;
  };
  const app = {
    loadLocalStorage(key) {
      if (key !== "templater-local-settings" || !hasLocalTemplaterSetting) return null;
      return { trigger_on_file_creation: localTemplaterAutoCreate === true };
    },
    workspace: {
      on(name, callback) {
        const listeners = workspaceListeners.get(name) ?? new Set();
        listeners.add(callback);
        workspaceListeners.set(name, listeners);
        return { name, callback };
      },
      offref(ref) {
        workspaceListeners.get(ref?.name)?.delete(ref?.callback);
      },
      trigger: triggerWorkspaceEvent,
    },
    internalPlugins: {
      getPluginById(id) {
        if (id === "daily-notes" && dailyNotes !== null) {
          return { enabled: true, instance: { options: dailyNotes } };
        }
        if (id === "templates" && templates !== null) {
          return { enabled: true, instance: { options: templates } };
        }
        return null;
      },
      plugins: {},
    },
    plugins: {
      plugins: {
        "templater-obsidian": {
          settings: {
            trigger_on_file_creation: legacyTemplaterAutoCreate === true,
            templates_folder: "Templates",
            ignore_folders_on_creation: [],
          },
          templater: {
            files_with_pending_templates: templaterPendingFiles,
            async overwrite_file_commands(file) {
              templaterRuns += 1;
              templaterPendingFiles.add(file.path);
              try {
                const snapshot = files.get(file.path);
                const content = await templaterTransform(snapshot, file);
                files.set(file.path, content);
                triggerWorkspaceEvent(templaterEventName, { file, content });
              } finally {
                templaterPendingFiles.delete(file.path);
              }
            },
          },
        },
      },
    },
    vault: {
      configDir: ".obsidian",
      getAbstractFileByPath(path) {
        return fileFor(normalizePath(path))
          ?? (folders.has(normalizePath(path)) ? { path: normalizePath(path) } : null);
      },
      async createFolder(path) {
        const normalized = normalizePath(path);
        const parent = normalized.includes("/") ? normalized.slice(0, normalized.lastIndexOf("/")) : "";
        if (parent && !folders.has(parent)) throw new Error(`Missing parent folder: ${parent}`);
        folders.add(normalized);
      },
      async create(path, content) {
        await Promise.resolve();
        const normalized = normalizePath(path);
        if (files.has(normalized)) throw new Error(`File already exists: ${normalized}`);
        const parent = normalized.includes("/") ? normalized.slice(0, normalized.lastIndexOf("/")) : "";
        if (parent && !folders.has(parent)) throw new Error(`Missing parent folder: ${parent}`);
        createCount += 1;
        files.set(normalized, content);
        fileTimes.set(normalized, Date.now());
        const file = fileFor(normalized);
        const autoCreateEnabled = hasLocalTemplaterSetting
          ? localTemplaterAutoCreate === true
          : legacyTemplaterAutoCreate === true;
        if (autoCreateEnabled) {
          setTimeout(() => {
            void app.plugins.plugins["templater-obsidian"].templater.overwrite_file_commands(file);
          }, templaterAutoDelayMs);
        }
        return file;
      },
      async cachedRead(file) {
        if (!files.has(file.path)) throw new Error(`Missing file: ${file.path}`);
        return files.get(file.path);
      },
      async read(file) {
        if (!files.has(file.path)) throw new Error(`Missing file: ${file.path}`);
        return files.get(file.path);
      },
      async process(file, processor) {
        if (!files.has(file.path)) throw new Error(`Missing file: ${file.path}`);
        files.set(file.path, processor(files.get(file.path)));
      },
      adapter: {
        async read(path) {
          const normalized = normalizePath(path);
          if (normalized === ".obsidian/daily-notes.json" && persistedDailyNotes) {
            return JSON.stringify(persistedDailyNotes);
          }
          if (normalized === ".obsidian/templates.json" && persistedTemplates) {
            return JSON.stringify(persistedTemplates);
          }
          throw new Error(`Missing config: ${normalized}`);
        },
      },
    },
  };
  return {
    app,
    files,
    seedExternalCreation(path, content) {
      const normalized = normalizePath(path);
      files.set(normalized, String(content));
      fileTimes.set(normalized, Date.now());
      const file = fileFor(normalized);
      const autoCreateEnabled = hasLocalTemplaterSetting
        ? localTemplaterAutoCreate === true
        : legacyTemplaterAutoCreate === true;
      if (autoCreateEnabled) {
        setTimeout(() => {
          void app.plugins.plugins["templater-obsidian"].templater.overwrite_file_commands(file);
        }, templaterAutoDelayMs);
      }
      return file;
    },
    stats: {
      get createCount() { return createCount; },
      get templaterRuns() { return templaterRuns; },
    },
  };
}

function installMoment() {
  const previousWindow = globalThis.window;
  const pad = (part) => String(part).padStart(2, "0");
  const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  const factory = (value) => {
    const date = value == null ? new Date(2027, 0, 13, 14, 45, 0) : new Date(value);
    return {
      isValid: () => !Number.isNaN(date.getTime()),
      format(pattern) {
        return String(pattern)
          .replace("dddd", weekdays[date.getDay()])
          .replace("MMMM", months[date.getMonth()])
          .replace("YYYY", String(date.getFullYear()))
          .replace("MM", pad(date.getMonth() + 1))
          .replace("DD", pad(date.getDate()))
          .replace("D", String(date.getDate()))
          .replace("HH", pad(date.getHours()))
          .replace("mm", pad(date.getMinutes()));
      },
    };
  };
  globalThis.window = { moment: factory, setTimeout };
  return () => {
    globalThis.window = previousWindow;
  };
}

function normalizePath(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/+|\/+$/g, "");
}

test("Controller standalone Daily Note creation is template-aware, nested-format safe, and single-flight", async () => {
  const restoreMoment = installMoment();
  try {
    gcmAttemptHandler = async () => ({ available: false, file: null });
    const { AutoCreateService } = loadAutoCreateService();
    const harness = createHarness({
      templaterLocalAutoTrigger: false,
      templaterLegacyAutoTrigger: true,
    });
    const service = new AutoCreateService(harness.app);
    const date = new Date(2027, 0, 13, 9, 0, 0);

    const [first, second] = await Promise.all([
      service.ensureDailyNoteFile(date),
      service.ensureDailyNoteFile(date),
    ]);

    assert.equal(first.path, "Inbox/Daily/2027/01/13.md");
    assert.equal(second.path, first.path);
    assert.equal(harness.stats.createCount, 1);
    assert.equal(harness.stats.templaterRuns, 1);
    const content = harness.files.get(first.path);
    assert.match(content, /title: Wednesday, January 13/);
    assert.match(content, /createdAt: 14\.45/);
    assert.match(content, /Controller template body/);
  } finally {
    restoreMoment();
  }
});

test("Controller task sync ignores stale note-mode folders before routing to the Daily Note writer", async () => {
  const restoreMoment = installMoment();
  try {
    const targetPath = "Inbox/Daily/2027/01/13.md";
    const harness = createHarness({
      initialFiles: {
        [targetPath]: "---\nkind: dailynote\n---\n\n",
      },
    });
    gcmAttemptHandler = async () => ({
      available: true,
      file: harness.app.vault.getAbstractFileByPath(targetPath),
    });
    const { AutoCreateService } = loadAutoCreateService();
    const service = new AutoCreateService(harness.app);
    const event = {
      id: "stale-note-folder-event",
      uid: "stale-note-folder-event",
      title: "Still create this task",
      description: "",
      startDate: new Date(2027, 0, 13, 9, 0, 0),
      endDate: new Date(2027, 0, 13, 9, 30, 0),
      sourceUrl: "https://calendar.example/team.ics",
      location: "",
      url: "",
      isAllDay: false,
    };
    const empty = new Map();

    const result = await service.processEvent(
      event,
      empty,
      empty,
      empty,
      empty,
      empty,
      empty,
      {
        mode: "task",
        taskDestination: "daily-note",
        taskNoteStrategy: "occurrence-day",
        taskNoteFolder: "Calendar Events",
        typeFolder: "_archive/Legacy calendar notes",
        folder: "_archive/Legacy calendar notes",
        autoCreateEnabled: true,
      },
      [],
      false,
    );

    assert.equal(result.action, "created");
    assert.equal(result.file?.path, targetPath);
    assert.match(harness.files.get(targetPath), /Still create this task/u);
  } finally {
    restoreMoment();
  }
});

test("Controller migrates a rescheduled calendar task block to the new Daily Note", async () => {
  const restoreMoment = installMoment();
  try {
    const sourcePath = "Inbox/Daily/2026/08/18.md";
    const targetPath = "Inbox/Daily/2026/08/19.md";
    const externalId = "calendar:https://calendar.example/team.ics#series-uid-20260818T090000";
    const sourceLine = `- [ ] Team standup [scheduled:: 2026-08-18 09:00:00] [timeEstimate:: 30] %% tps-inline-props:${JSON.stringify({
      externalId,
      externalEventId: "series-uid-20260818T090000",
      tpsCalendarUid: "series-uid",
      tpsCalendarSourceUrl: "https://calendar.example/team.ics",
    })} %%`;
    const harness = createHarness({
      initialFiles: {
        [sourcePath]: ['---', 'kind: dailynote', '---', sourceLine, '  - preserve this child', '', '- [ ] Keep me', ''].join('\n'),
        [targetPath]: ['---', 'kind: dailynote', '---', '', 'Target body', ''].join('\n'),
      },
    });
    gcmAttemptHandler = async (_app, isoDate) => ({
      available: true,
      file: isoDate === '2026-08-19'
        ? harness.app.vault.getAbstractFileByPath(targetPath)
        : null,
    });
    const { AutoCreateService } = loadAutoCreateService();
    const service = new AutoCreateService(harness.app);
    const event = {
      id: "series-uid-20260818T090000",
      uid: "series-uid",
      title: "Team standup",
      description: "",
      startDate: new Date(2026, 7, 19, 10, 0, 0),
      endDate: new Date(2026, 7, 19, 10, 30, 0),
      sourceUrl: "https://calendar.example/team.ics",
      location: "",
      url: "",
      isAllDay: false,
    };
    const calendarInfo = {
      mode: "task",
      taskDestination: "daily-note",
      taskNoteStrategy: "occurrence-day",
      taskNoteFolder: "Calendar Events",
    };
    const taskNoteLink = service.buildTaskNoteLink(event, calendarInfo, null);
    const result = await service.updateExistingInlineTask({
      file: harness.app.vault.getAbstractFileByPath(sourcePath),
      isInlineTask: true,
      inSyncScope: true,
      taskLineIndex: 3,
      taskRawLine: sourceLine,
      associatedNotePath: null,
      externalId,
      eventId: event.id,
      uid: event.uid,
      eventUrl: null,
      storedStart: "2026-08-18 09:00:00",
      storedEnd: 30,
      storedTitle: "Team standup",
      storedLocation: "",
      storedAllDay: false,
      startDate: new Date(2026, 7, 18, 9, 0, 0),
      sourceUrl: event.sourceUrl,
      orphanCandidateAt: null,
      isArchived: false,
    }, event, calendarInfo, taskNoteLink, {
      expectedStart: "2026-08-19 10:00:00",
      expectedEnd: 30,
      startChanged: true,
      endChanged: false,
      titleMissing: false,
      locationMissing: false,
      sourceChanged: false,
      urlChanged: false,
      allDayChanged: false,
      repairedEventId: false,
    });

    assert.equal(result.changed, true);
    assert.equal(result.file.path, targetPath);
    assert.doesNotMatch(harness.files.get(sourcePath), /series-uid-20260818T090000/u);
    assert.match(harness.files.get(sourcePath), /Keep me/u);
    const target = harness.files.get(targetPath);
    assert.match(target, /\[\[Calendar Events\/2026-08-19\/Calendar event--[a-f0-9]{8}\|Team standup\]\]/u);
    assert.match(target, /\[scheduled:: 2026-08-19 10:00:00\]/u);
    assert.match(target, /preserve this child/u);
    assert.match(target, /"associatedNotePath":"Calendar Events\/2026-08-19\/Calendar event--[a-f0-9]{8}\.md"/u);
  } finally {
    restoreMoment();
  }
});

test("Controller matches a rescheduled single event by unique source-scoped UID and rejects recurring ambiguity", () => {
  const { AutoCreateService } = loadAutoCreateService();
  const harness = createHarness();
  const service = new AutoCreateService(harness.app);
  const event = {
    id: 'single-uid-20260819T100000',
    uid: 'single-uid',
    title: 'Moved event',
    startDate: new Date(2026, 7, 19, 10, 0, 0),
    sourceUrl: 'https://calendar.example/feed.ics',
  };
  const candidate = {
    file: new FakeFile('Inbox/Daily/2026/08/18.md'),
    uid: event.uid,
    sourceUrl: event.sourceUrl,
    isArchived: false,
  };
  const uidKey = service.buildUidKey(event.uid, event.sourceUrl);
  const empty = new Map();

  const unique = service.findVaultNoteForEvent(
    event,
    empty,
    empty,
    empty,
    new Map([[uidKey, [candidate]]]),
    empty,
    empty,
  );
  assert.equal(unique.note, candidate);
  assert.equal(unique.repairedEventId, true);

  const ambiguous = service.findVaultNoteForEvent(
    event,
    empty,
    empty,
    empty,
    new Map([[uidKey, [candidate, { ...candidate, file: new FakeFile('Other.md') }]]]),
    empty,
    empty,
  );
  assert.equal(ambiguous.note, null);
});

test("Controller rolls back a reschedule target when the source task block changes concurrently", async () => {
  const restoreMoment = installMoment();
  try {
    const sourcePath = 'Inbox/Daily/2026/08/18.md';
    const targetPath = 'Inbox/Daily/2026/08/19.md';
    const externalId = 'calendar:https://calendar.example/feed.ics#move-race';
    const sourceLine = `- [ ] Move race [scheduled:: 2026-08-18 09:00:00] %% tps-inline-props:${JSON.stringify({ externalId })} %%`;
    const harness = createHarness({ initialFiles: {
      [sourcePath]: ['---', '---', sourceLine, '  - original child', '', 'Keep source body', ''].join('\n'),
      [targetPath]: ['---', '---', '', 'Keep target body', ''].join('\n'),
    } });
    gcmAttemptHandler = async () => ({
      available: true,
      file: harness.app.vault.getAbstractFileByPath(targetPath),
    });
    const originalProcess = harness.app.vault.process.bind(harness.app.vault);
    let driftInjected = false;
    harness.app.vault.process = async (file, processor) => {
      if (file.path === targetPath && !driftInjected) {
        driftInjected = true;
        harness.files.set(sourcePath, harness.files.get(sourcePath).replace('original child', 'concurrent child edit'));
      }
      return originalProcess(file, processor);
    };
    const { AutoCreateService } = loadAutoCreateService();
    const service = new AutoCreateService(harness.app);
    const event = {
      id: 'move-race', uid: 'move-race', title: 'Move race', description: '',
      startDate: new Date(2026, 7, 19, 10), endDate: new Date(2026, 7, 19, 10, 30),
      sourceUrl: 'https://calendar.example/feed.ics', location: '', url: '', isAllDay: false,
    };
    const calendarInfo = { mode: 'task', taskDestination: 'daily-note', taskNoteStrategy: 'series' };
    const taskNoteLink = service.buildTaskNoteLink(event, calendarInfo, null);
    const result = await service.updateExistingInlineTask({
      file: harness.app.vault.getAbstractFileByPath(sourcePath), isInlineTask: true, inSyncScope: true,
      taskLineIndex: 2, taskRawLine: sourceLine, associatedNotePath: null, externalId,
      eventId: event.id, uid: event.uid, eventUrl: null, storedStart: '2026-08-18 09:00:00',
      storedEnd: '', storedTitle: 'Move race', storedLocation: '', storedAllDay: false,
      startDate: new Date(2026, 7, 18, 9), sourceUrl: event.sourceUrl,
      orphanCandidateAt: null, isArchived: false,
    }, event, calendarInfo, taskNoteLink, {
      expectedStart: '2026-08-19 10:00:00', expectedEnd: '', startChanged: true, endChanged: false,
      titleMissing: false, locationMissing: false, sourceChanged: false, urlChanged: false,
      allDayChanged: false, repairedEventId: false,
    });

    assert.equal(result.changed, false);
    assert.match(harness.files.get(sourcePath), /concurrent child edit/u);
    assert.match(harness.files.get(sourcePath), /move-race/u);
    assert.doesNotMatch(harness.files.get(targetPath), /move-race/u);
    assert.match(harness.files.get(targetPath), /Keep target body/u);
  } finally {
    restoreMoment();
  }
});

test("Controller falls back to the legacy Templater auto-create setting when device-local state is unavailable", async () => {
  const restoreMoment = installMoment();
  try {
    gcmAttemptHandler = async () => ({ available: false, file: null });
    const { AutoCreateService } = loadAutoCreateService();
    const harness = createHarness({
      templaterLocalSettingsUnavailable: true,
      templaterLegacyAutoTrigger: true,
    });
    const service = new AutoCreateService(harness.app);

    const created = await service.ensureDailyNoteFile(new Date(2027, 0, 14, 9, 0, 0));

    assert.equal(created.path, "Inbox/Daily/2027/01/14.md");
    assert.equal(harness.stats.templaterRuns, 1);
    assert.match(harness.files.get(created.path), /Controller template body/);
  } finally {
    restoreMoment();
  }
});

test("Controller standalone Daily Note creation fails closed for a missing configured template", async () => {
  const restoreMoment = installMoment();
  try {
    gcmAttemptHandler = async () => ({ available: false, file: null });
    const { AutoCreateService } = loadAutoCreateService();
    const harness = createHarness({ includeTemplate: false });
    const service = new AutoCreateService(harness.app);

    await assert.rejects(
      () => service.ensureDailyNoteFile(new Date(2027, 0, 14, 9, 0, 0)),
      /Configured Daily Notes template was not found/,
    );
    assert.equal(harness.stats.createCount, 0);
  } finally {
    restoreMoment();
  }
});

test("Controller fails closed when GCM is available but returns no Daily Note", async () => {
  const restoreMoment = installMoment();
  try {
    gcmAttemptHandler = async () => ({ available: true, file: null });
    const { AutoCreateService } = loadAutoCreateService();
    const harness = createHarness();
    const service = new AutoCreateService(harness.app);

    await assert.rejects(
      () => service.ensureDailyNoteFile(new Date(2027, 0, 15, 9, 0, 0)),
      /GCM could not create the daily note/,
    );
    assert.equal(harness.stats.createCount, 0);
  } finally {
    restoreMoment();
  }
});

test("Controller asks GCM before reusing a conflicting local Daily Note target", async () => {
  const restoreMoment = installMoment();
  try {
    const localPath = "Inbox/Daily/2027/01/16.md";
    const canonicalPath = "Canonical Daily/2027-01-16.md";
    const localContent = "---\ntitle: Wrong local target\n---\n\nMust remain untouched\n";
    const requestedDates = [];
    const harness = createHarness({
      initialFiles: {
        [localPath]: localContent,
        [canonicalPath]: "---\ntitle: Canonical readable title\nkind: dailynote\n---\n\nCanonical body\n",
      },
    });
    gcmAttemptHandler = async (_app, isoDate) => {
      requestedDates.push(isoDate);
      return {
        available: true,
        file: harness.app.vault.getAbstractFileByPath(canonicalPath),
      };
    };
    const { AutoCreateService } = loadAutoCreateService();
    const service = new AutoCreateService(harness.app);

    const resolved = await service.ensureDailyNoteFile(new Date(2027, 0, 16, 9, 0, 0));

    assert.deepEqual(requestedDates, ["2027-01-16"]);
    assert.equal(resolved.path, canonicalPath);
    assert.equal(harness.files.get(localPath), localContent);
    assert.match(harness.files.get(canonicalPath), /Canonical body/);
  } finally {
    restoreMoment();
  }
});

test("Controller waits for the device-local delayed Templater auto-create snapshot before appending a task", async () => {
  const restoreMoment = installMoment();
  try {
    gcmAttemptHandler = async () => ({ available: false, file: null });
    let harness;
    let transformFinished = false;
    harness = createHarness({
      templaterLocalAutoTrigger: true,
      templaterLegacyAutoTrigger: false,
      templaterTransform: async (content, file) => {
        assert.doesNotMatch(harness.files.get(file.path), /Delayed controller task/);
        await new Promise((resolve) => setTimeout(resolve, 15));
        transformFinished = true;
        return content.replace("<% controller-template-body %>", "Delayed controller body");
      },
    });
    const { AutoCreateService } = loadAutoCreateService();
    const service = new AutoCreateService(harness.app);
    const startDate = new Date(2027, 0, 17, 9, 0, 0);
    const event = {
      id: "delayed-controller-event",
      uid: "delayed-controller-uid",
      title: "Delayed controller task",
      startDate,
      endDate: new Date(2027, 0, 17, 9, 30, 0),
      isAllDay: false,
      sourceUrl: "",
      location: "",
      url: "",
    };

    const result = await service.createTaskInTaskNote(event, null);

    assert.equal(transformFinished, true);
    assert.equal(harness.stats.templaterRuns, 1);
    assert.equal(result?.file.path, "Inbox/Daily/2027/01/17.md");
    const content = harness.files.get(result.file.path);
    assert.match(content, /Delayed controller body/);
    assert.match(content, /Delayed controller task/);
    assert.doesNotMatch(content, /<% controller-template-body %>/);
  } finally {
    restoreMoment();
  }
});

test("Controller also waits for a delayed Templater auto-create snapshot when the template has no commands", async () => {
  const restoreMoment = installMoment();
  try {
    gcmAttemptHandler = async () => ({ available: false, file: null });
    const harness = createHarness({
      initialFiles: {
        "Templates/Daily.md": [
          "---",
          "title: Plain Controller Daily",
          "kind: dailynote",
          "---",
          "",
          "Plain controller body",
        ].join("\n"),
      },
      templaterLocalAutoTrigger: true,
      templaterLegacyAutoTrigger: false,
      templaterEventName: "templater:new-note-from-template",
      templaterTransform: async (snapshot) => {
        await new Promise((resolve) => setTimeout(resolve, 15));
        return snapshot;
      },
    });
    const { AutoCreateService } = loadAutoCreateService();
    const service = new AutoCreateService(harness.app);
    const startDate = new Date(2027, 0, 19, 9, 0, 0);

    const result = await service.createTaskInTaskNote({
      id: "plain-controller-event",
      uid: "plain-controller-uid",
      title: "Plain-template controller task",
      startDate,
      endDate: new Date(2027, 0, 19, 9, 30, 0),
      isAllDay: false,
      sourceUrl: "",
      location: "",
      url: "",
    }, null);

    assert.equal(harness.stats.templaterRuns, 1);
    assert.match(harness.files.get(result.file.path), /Plain controller body/);
    assert.match(harness.files.get(result.file.path), /Plain-template controller task/);
  } finally {
    restoreMoment();
  }
});

test("Controller settles Templater before writing into a new template-less Daily Note", async () => {
  const restoreMoment = installMoment();
  try {
    gcmAttemptHandler = async () => ({ available: false, file: null });
    const harness = createHarness({
      dailyNotes: {
        folder: "Inbox/Daily",
        format: "YYYY/MM/DD",
        template: "",
      },
      includeTemplate: false,
      templaterLocalAutoTrigger: true,
      templaterLegacyAutoTrigger: false,
      templaterTransform: async (snapshot) => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return snapshot;
      },
    });
    const { AutoCreateService } = loadAutoCreateService();
    const service = new AutoCreateService(harness.app);
    const startDate = new Date(2027, 0, 20, 9, 0, 0);

    const result = await service.createTaskInTaskNote({
      id: "template-less-controller-event",
      uid: "template-less-controller-uid",
      title: "Template-less controller task",
      startDate,
      endDate: new Date(2027, 0, 20, 9, 30, 0),
      isAllDay: false,
      sourceUrl: "",
      location: "",
      url: "",
    }, null);

    assert.equal(harness.stats.templaterRuns, 1);
    assert.match(harness.files.get(result.file.path), /context\/scheduled/);
    assert.match(harness.files.get(result.file.path), /Template-less controller task/);
  } finally {
    restoreMoment();
  }
});

test("Controller waits when an exact Daily Note was freshly created by another caller", async () => {
  const restoreMoment = installMoment();
  try {
    gcmAttemptHandler = async () => ({ available: false, file: null });
    const harness = createHarness({
      templaterLocalAutoTrigger: true,
      templaterLegacyAutoTrigger: false,
      templaterTransform: async (snapshot) => {
        await new Promise((resolve) => setTimeout(resolve, 90));
        return snapshot.replace("<% external-controller-body %>", "External controller body resolved");
      },
    });
    harness.seedExternalCreation("Inbox/Daily/2027/01/21.md", [
      "---",
      "title: Fresh external Controller Daily",
      "kind: dailynote",
      "---",
      "",
      "<% external-controller-body %>",
    ].join("\n"));
    const { AutoCreateService } = loadAutoCreateService();
    const service = new AutoCreateService(harness.app);
    const startDate = new Date(2027, 0, 21, 9, 0, 0);

    const result = await service.createTaskInTaskNote({
      id: "external-controller-event",
      uid: "external-controller-uid",
      title: "Task after external Controller creation",
      startDate,
      endDate: new Date(2027, 0, 21, 9, 30, 0),
      isAllDay: false,
      sourceUrl: "",
      location: "",
      url: "",
    }, null);

    assert.equal(harness.stats.createCount, 0);
    assert.equal(harness.stats.templaterRuns, 1);
    assert.match(harness.files.get(result.file.path), /External controller body resolved/);
    assert.match(harness.files.get(result.file.path), /Task after external Controller creation/);
  } finally {
    restoreMoment();
  }
});

test("Controller fails closed before task append when Templater leaves commands unresolved", async () => {
  const restoreMoment = installMoment();
  try {
    gcmAttemptHandler = async () => ({ available: false, file: null });
    const harness = createHarness({
      templaterLocalAutoTrigger: true,
      templaterLegacyAutoTrigger: false,
      templaterTransform: async (content) => content,
    });
    const { AutoCreateService } = loadAutoCreateService();
    const service = new AutoCreateService(harness.app);
    const targetPath = "Inbox/Daily/2027/01/18.md";
    const startDate = new Date(2027, 0, 18, 9, 0, 0);

    await assert.rejects(
      () => service.createTaskInTaskNote({
        id: "unresolved-controller-event",
        uid: "unresolved-controller-uid",
        title: "Must not append after unresolved Templater",
        startDate,
        endDate: new Date(2027, 0, 18, 9, 30, 0),
        isAllDay: false,
        sourceUrl: "",
        location: "",
        url: "",
      }, null),
      /Templater did not finish processing Daily Note commands/,
    );

    assert.equal(harness.stats.templaterRuns, 1);
    assert.match(harness.files.get(targetPath), /<% controller-template-body %>/);
    assert.doesNotMatch(harness.files.get(targetPath), /Must not append after unresolved Templater/);
  } finally {
    restoreMoment();
  }
});
