import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const STARTED = "tps:calendar-sync-started";
const COMPLETED = "tps:calendar-sync-completed";

function deferred() {
  let resolve;
  const promise = new Promise((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function flushMicrotasks(rounds = 12) {
  for (let round = 0; round < rounds; round += 1) await Promise.resolve();
}

function loadCalendarAutomation(logs, notices) {
  const source = readFileSync(new URL("../src/services/calendar-automation.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  });
  const module = { exports: {} };
  const logger = {
    flow(scope, event, data = {}) {
      logs.push({ level: "flow", scope, event, data });
    },
    flowWarn(scope, event, data = {}) {
      logs.push({ level: "warn", scope, event, data });
    },
    async timeAsync(scope, event, data, action) {
      logs.push({ level: "time", scope, event, data });
      return action();
    },
  };
  const requireImpl = (specifier) => {
    if (specifier === "obsidian") {
      return {
        App: class {},
        Notice: class {
          constructor(message) {
            notices.push(String(message));
          }
        },
        normalizePath: (value) => String(value || "").replaceAll("\\", "/"),
      };
    }
    if (specifier === "./auto-create-service" || specifier === "./external-calendar-service" || specifier === "../types") {
      return {};
    }
    if (specifier === "../utils") {
      return {
        normalizeCalendarUrl: (value) => {
          const normalized = String(value || "").trim();
          return normalized.startsWith("webcal://") ? `https://${normalized.slice(9)}` : normalized;
        },
        normalizeCalendarTag: (value) => String(value || "").trim().replace(/^#+/, "").toLowerCase(),
      };
    }
    if (specifier === "../logger") return logger;
    if (specifier === "../tps-events") {
      return {
        TPS_EVENTS: {
          CALENDAR_SYNC_STARTED: STARTED,
          CALENDAR_SYNC_COMPLETED: COMPLETED,
        },
      };
    }
    throw new Error(`Unexpected CalendarAutomationService test import: ${specifier}`);
  };
  new Function("module", "exports", "require", compiled.outputText)(module, module.exports, requireImpl);
  return module.exports.CalendarAutomationService;
}

function createHarness({
  runAutoCreate,
  runCompletion = async () => {},
  onEvent = () => {},
  getReadiness = () => ({ ready: true, reason: "ready" }),
} = {}) {
  const logs = [];
  const notices = [];
  const events = [];
  const CalendarAutomationService = loadCalendarAutomation(logs, notices);
  const settings = {
    externalCalendars: [{
      url: "webcal://calendar.example/feed.ics",
      enabled: true,
      autoCreateEnabled: true,
      autoCreateMode: "note",
      autoCreateFolder: "Calendar",
    }],
    archiveFolder: "_archive",
    externalCalendarFilter: "",
    noLossSyncMode: true,
    eventIdKey: "externalEventId",
    uidKey: "tpsCalendarUid",
    titleKey: "title",
    statusKey: "status",
    previousStatusKey: "tpsCalendarPrevStatus",
    startProperty: "scheduled",
    endProperty: "scheduledEnd",
    syncOnEventDelete: "nothing",
    globalIgnorePaths: [],
    canceledStatusValue: "cancelled",
  };
  const autoCreateCalls = [];
  const autoCreateService = {
    updateConfig() {},
    async checkAndCreateMeetingNotes(...args) {
      autoCreateCalls.push(args);
      await runAutoCreate(...args);
    },
  };
  let service;
  const app = {
    workspace: {
      trigger(name, payload) {
        events.push({ name, payload });
        onEvent(name, payload, () => service);
      },
    },
  };
  service = new CalendarAutomationService(
    app,
    autoCreateService,
    {},
    () => settings,
    () => null,
    runCompletion,
    getReadiness,
  );
  return { service, autoCreateCalls, events, logs, notices };
}

function eventCount(events, name) {
  return events.filter((event) => event.name === name).length;
}

test("overlapping calendar sync callers join the physical run and preserve first-call options", async () => {
  const gate = deferred();
  let autoCreateActive = false;
  let physicalRuns = 0;
  let completionCalls = 0;
  const physicalOptions = [];
  const harness = createHarness({
    async runAutoCreate(_calendarService, _urls, _filter, _configs, force, options) {
      if (autoCreateActive) return;
      autoCreateActive = true;
      physicalRuns += 1;
      physicalOptions.push({ force, backfillPastEvents: options.backfillPastEvents });
      try {
        await gate.promise;
      } finally {
        autoCreateActive = false;
      }
    },
    async runCompletion() {
      completionCalls += 1;
    },
  });

  const first = harness.service.runSync(false, { backfillPastEvents: false });
  await flushMicrotasks();
  const callers = [first];
  for (let overlap = 0; overlap < 99; overlap += 1) {
    callers.push(harness.service.runSync(true, { backfillPastEvents: true }));
  }
  const second = callers[1];
  let firstSettled = false;
  let secondSettled = false;
  void first.then(() => { firstSettled = true; });
  void second.then(() => { secondSettled = true; });
  await flushMicrotasks();

  assert.deepEqual({
    allJoined: callers.every((caller) => caller === first),
    autoCreateCalls: harness.autoCreateCalls.length,
    physicalRuns,
    completionCalls,
    startedEvents: eventCount(harness.events, STARTED),
    completedEvents: eventCount(harness.events, COMPLETED),
    firstSettled,
    secondSettled,
  }, {
    allJoined: true,
    autoCreateCalls: 1,
    physicalRuns: 1,
    completionCalls: 0,
    startedEvents: 1,
    completedEvents: 0,
    firstSettled: false,
    secondSettled: false,
  });

  gate.resolve();
  await Promise.all(callers);
  assert.deepEqual(physicalOptions, [{ force: false, backfillPastEvents: false }]);
  assert.equal(completionCalls, 1);
  assert.equal(eventCount(harness.events, COMPLETED), 1);

  await harness.service.runSync(true, { backfillPastEvents: true });
  assert.equal(harness.autoCreateCalls.length, 2, "a fresh call must start after the joined run settles");
  assert.equal(physicalRuns, 2);
  assert.deepEqual(physicalOptions[1], { force: true, backfillPastEvents: true });
  assert.equal(completionCalls, 2);
});

test("joined calendar sync failures reject every caller and clear the flight for retry", async () => {
  const gate = deferred();
  const expectedFailure = new Error("calendar provider failed");
  let shouldFail = true;
  let completionCalls = 0;
  const harness = createHarness({
    async runAutoCreate() {
      if (!shouldFail) return;
      await gate.promise;
      throw expectedFailure;
    },
    async runCompletion() {
      completionCalls += 1;
    },
  });

  const first = harness.service.runSync();
  await flushMicrotasks();
  const second = harness.service.runSync(true);
  await flushMicrotasks();
  assert.equal(first, second);
  assert.equal(harness.autoCreateCalls.length, 1);

  gate.resolve();
  const [firstFailure, secondFailure] = await Promise.all([
    first.then(() => null, (error) => error),
    second.then(() => null, (error) => error),
  ]);
  assert.equal(firstFailure, expectedFailure);
  assert.equal(secondFailure, expectedFailure);
  assert.equal(completionCalls, 0);
  assert.equal(eventCount(harness.events, COMPLETED), 0);

  shouldFail = false;
  await harness.service.runSync(true);
  assert.equal(harness.autoCreateCalls.length, 2);
  assert.equal(completionCalls, 1);
  assert.equal(eventCount(harness.events, COMPLETED), 1);
});

test("a joined readiness skip clears the flight so a later ready call can run", async () => {
  let ready = false;
  let completionCalls = 0;
  const harness = createHarness({
    async runAutoCreate() {},
    async runCompletion() {
      completionCalls += 1;
    },
    getReadiness() {
      return ready
        ? { ready: true, reason: "ready" }
        : { ready: false, reason: "metadata cache not ready" };
    },
  });

  const first = harness.service.runSync(true);
  const second = harness.service.runSync();
  assert.equal(first, second);
  await Promise.all([first, second]);
  assert.equal(harness.autoCreateCalls.length, 0);
  assert.equal(completionCalls, 0);
  assert.equal(eventCount(harness.events, STARTED), 1);
  assert.equal(eventCount(harness.events, COMPLETED), 0);
  assert.deepEqual(harness.notices, ["Calendar Sync skipped: metadata cache not ready"]);

  ready = true;
  await harness.service.runSync();
  assert.equal(harness.autoCreateCalls.length, 1);
  assert.equal(completionCalls, 1);
  assert.equal(eventCount(harness.events, STARTED), 2);
  assert.equal(eventCount(harness.events, COMPLETED), 1);
});

test("completion-maintenance failure remains joined and retryable without a false completed event", async () => {
  const gate = deferred();
  const expectedFailure = new Error("recurrence maintenance failed");
  let failCompletion = true;
  let completionCalls = 0;
  const harness = createHarness({
    async runAutoCreate() {
      await gate.promise;
    },
    async runCompletion() {
      completionCalls += 1;
      if (failCompletion) throw expectedFailure;
    },
  });

  const first = harness.service.runSync();
  await flushMicrotasks();
  const second = harness.service.runSync(true);
  assert.equal(first, second);
  assert.equal(harness.autoCreateCalls.length, 1);

  gate.resolve();
  const [firstFailure, secondFailure] = await Promise.all([
    first.then(() => null, (error) => error),
    second.then(() => null, (error) => error),
  ]);
  assert.equal(firstFailure, expectedFailure);
  assert.equal(secondFailure, expectedFailure);
  assert.equal(completionCalls, 1);
  assert.equal(eventCount(harness.events, COMPLETED), 0);

  failCompletion = false;
  await harness.service.runSync(true);
  assert.equal(harness.autoCreateCalls.length, 2);
  assert.equal(completionCalls, 2);
  assert.equal(eventCount(harness.events, COMPLETED), 1);
});

test("a synchronous sync-start listener joins instead of re-entering calendar reconciliation", async () => {
  const gate = deferred();
  let autoCreateActive = false;
  let physicalRuns = 0;
  let nested;
  let reentered = false;
  const harness = createHarness({
    async runAutoCreate() {
      if (autoCreateActive) return;
      autoCreateActive = true;
      physicalRuns += 1;
      try {
        await gate.promise;
      } finally {
        autoCreateActive = false;
      }
    },
    onEvent(name, _payload, getService) {
      if (name !== STARTED || reentered) return;
      reentered = true;
      nested = getService().runSync(true, { backfillPastEvents: true });
    },
  });

  const outer = harness.service.runSync(false, { backfillPastEvents: false });
  await flushMicrotasks();
  assert.equal(nested, outer);
  assert.equal(harness.autoCreateCalls.length, 1);
  assert.equal(physicalRuns, 1);
  assert.equal(eventCount(harness.events, STARTED), 1);
  assert.equal(eventCount(harness.events, COMPLETED), 0);

  gate.resolve();
  await Promise.all([outer, nested]);
  assert.equal(eventCount(harness.events, COMPLETED), 1);
});
