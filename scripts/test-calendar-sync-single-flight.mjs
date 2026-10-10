import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import test from "node:test";
import ts from "typescript";

const STARTED = "tps:calendar-sync-started";
const COMPLETED = "tps:calendar-sync-completed";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(rounds = 12) {
  for (let round = 0; round < rounds; round += 1) await Promise.resolve();
}

function loadCalendarAutomation(logs, notices) {
  const source = process.env.TPS_CALENDAR_AUTOMATION_BASELINE_REF
    ? execFileSync("git", ["show", `${process.env.TPS_CALENDAR_AUTOMATION_BASELINE_REF}:src/services/calendar-automation.ts`], { encoding: "utf8" })
    : readFileSync(new URL("../src/services/calendar-automation.ts", import.meta.url), "utf8");
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
    flowError(scope, event, error, data = {}) {
      logs.push({ level: "error", scope, event, error, data });
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
  runNativeSync,
  appliedPaths = ['Calendar/Changed.md'],
  runCompletion = async () => {},
  onEvent = () => {},
  getReadiness = () => ({ ready: true, reason: "ready" }),
} = {}) {
  const logs = [];
  const notices = [];
  const events = [];
  const CalendarAutomationService = loadCalendarAutomation(logs, notices);
  const settings = {
    calendarStorageMode: "native-records",
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
  const nativeSyncCalls = [];
  const autoCreateService = { updateConfig() {} };
  const nativeRecordService = {
    async sync(...args) {
      nativeSyncCalls.push(args);
      await runNativeSync(...args);
      return { fetched: 1, created: 0, updated: 0, archived: 0, failedFeeds: 0, appliedPaths };
    },
  };
  let service;
  let layoutCallback;
  const app = {
    workspace: {
      onLayoutReady(callback) {layoutCallback=callback;},
      trigger(name, payload) {
        events.push({ name, payload });
        onEvent(name, payload, () => service);
      },
    },
  };
  service = new CalendarAutomationService(
    app,
    autoCreateService,
    nativeRecordService,
    () => settings,
    () => null,
    runCompletion,
    getReadiness,
  );
  return { service, settings, nativeSyncCalls, events, logs, notices, fireLayout() {layoutCallback();} };
}

function eventCount(events, name) {
  return events.filter((event) => event.name === name).length;
}

test('unchanged sync performs zero recurrence dispatches, inventories, reads or writes', async () => {
  const counts = { recoveries: 0, inventories: 0, reads: 0, writes: 0 };
  const h = createHarness({ appliedPaths: [], async runNativeSync() {}, async runCompletion() {
    counts.recoveries++; counts.inventories++; counts.reads++; counts.writes++;
  } });
  await h.service.runSync(); await h.service.runSync(true);
  assert.deepEqual(counts, { recoveries: 0, inventories: 0, reads: 0, writes: 0 });
  assert.equal(eventCount(h.events, COMPLETED), 2, 'unchanged sync still reports successful settlement');
});

test('changed sync sends only its successful applied paths to recurrence recovery', async () => {
  const paths = ['Calendar/Created.md', 'Calendar/Renamed.md']; const scopes = [];
  const h = createHarness({ appliedPaths: paths, async runNativeSync() {}, async runCompletion(scope) { scopes.push(scope); } });
  await h.service.runSync();
  assert.deepEqual(scopes, [paths]);
});

test("saved legacy calendar mode pauses before either sync writer", async () => {
  const harness = createHarness({
    async runNativeSync() {
      assert.fail("native sync must wait for explicit whole-note activation");
    },
  });
  harness.settings.calendarStorageMode = "legacy";
  await harness.service.runSync(true);
  assert.equal(harness.nativeSyncCalls.length, 0);
  assert.equal(eventCount(harness.events, STARTED), 0);
  assert.equal(eventCount(harness.events, COMPLETED), 0);
  assert.deepEqual(harness.notices, ["Calendar sync is paused until whole-note event records are enabled in Controller settings."]);
  assert.equal(harness.logs.some((entry) => entry.event === "skip:legacy-mode-paused"), true);
});

test("overlapping calendar sync callers join the physical run and preserve first-call options", async () => {
  const gate = deferred();
  let nativeSyncActive = false;
  let physicalRuns = 0;
  let completionCalls = 0;
  const physicalOptions = [];
  const harness = createHarness({
    async runNativeSync(_calendars, _filter, force, backfillPastEvents) {
      if (nativeSyncActive) return;
      nativeSyncActive = true;
      physicalRuns += 1;
      physicalOptions.push({ force, backfillPastEvents });
      try {
        await gate.promise;
      } finally {
        nativeSyncActive = false;
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
    nativeSyncCalls: harness.nativeSyncCalls.length,
    physicalRuns,
    completionCalls,
    startedEvents: eventCount(harness.events, STARTED),
    completedEvents: eventCount(harness.events, COMPLETED),
    firstSettled,
    secondSettled,
  }, {
    allJoined: true,
    nativeSyncCalls: 1,
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
  assert.equal(harness.nativeSyncCalls.length, 2, "a fresh call must start after the joined run settles");
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
    async runNativeSync() {
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
  assert.equal(harness.nativeSyncCalls.length, 1);

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
  assert.equal(harness.nativeSyncCalls.length, 2);
  assert.equal(completionCalls, 1);
  assert.equal(eventCount(harness.events, COMPLETED), 1);
});

test("a joined readiness skip clears the flight so a later ready call can run", async () => {
  let ready = false;
  let completionCalls = 0;
  const harness = createHarness({
    async runNativeSync() {},
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
  assert.equal(harness.nativeSyncCalls.length, 0);
  assert.equal(completionCalls, 0);
  assert.equal(eventCount(harness.events, STARTED), 0);
  assert.equal(eventCount(harness.events, COMPLETED), 0);
  assert.deepEqual(harness.notices, ["Calendar Sync skipped: metadata cache not ready"]);

  ready = true;
  await harness.service.runSync(true);
  assert.equal(harness.nativeSyncCalls.length, 1);
  assert.equal(completionCalls, 1);
  assert.equal(eventCount(harness.events, STARTED), 1);
  assert.equal(eventCount(harness.events, COMPLETED), 1);
});

test("completion-maintenance failure remains joined and retryable without a false completed event", async () => {
  const gate = deferred();
  const expectedFailure = new Error("recurrence maintenance failed");
  let failCompletion = true;
  let completionCalls = 0;
  const harness = createHarness({
    async runNativeSync() {
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
  assert.equal(harness.nativeSyncCalls.length, 1);

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
  assert.equal(harness.nativeSyncCalls.length, 2);
  assert.equal(completionCalls, 2);
  assert.equal(eventCount(harness.events, COMPLETED), 1);
});

test("a synchronous sync-start listener joins instead of re-entering calendar reconciliation", async () => {
  const gate = deferred();
  let nativeSyncActive = false;
  let physicalRuns = 0;
  let nested;
  let reentered = false;
  const harness = createHarness({
    async runNativeSync() {
      if (nativeSyncActive) return;
      nativeSyncActive = true;
      physicalRuns += 1;
      try {
        await gate.promise;
      } finally {
        nativeSyncActive = false;
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
  assert.equal(harness.nativeSyncCalls.length, 1);
  assert.equal(physicalRuns, 1);
  assert.equal(eventCount(harness.events, STARTED), 1);
  assert.equal(eventCount(harness.events, COMPLETED), 0);

  gate.resolve();
  await Promise.all([outer, nested]);
  assert.equal(eventCount(harness.events, COMPLETED), 1);
});


test('not-ready sync returns a deferred outcome and emits no started/completed events', async () => {
  const h=createHarness({runNativeSync:async()=>{},getReadiness:()=>({ready:false,reason:'metadata pending'})});
  assert.equal(await h.service.runSync(),'not-ready');
  assert.equal(h.nativeSyncCalls.length,0); assert.deepEqual(h.events,[]);
});

test('stopping an active sync suppresses completion dispatch and later calls until restarted', async () => {
  const hold=deferred(); let completions=0;
  const h=createHarness({runNativeSync:()=>hold.promise,runCompletion:async()=>{completions++;}});
  const pending=h.service.runSync(); await flushMicrotasks();
  h.service.stop(); hold.resolve();
  assert.equal(await pending,'stopped'); assert.equal(completions,0);
  assert.equal(eventCount(h.events,COMPLETED),0);
  assert.equal(await h.service.runSync(),'stopped'); assert.equal(h.nativeSyncCalls.length,1);
});


test('existing startup obligation survives readiness skips and stale layout callbacks after stop cannot revive it', async () => {
  const priorWindow=globalThis.window; let intervals=0; let ready=false;
  globalThis.window={setInterval(){intervals++; return intervals;},clearInterval(){}};
  try {
    const h=createHarness({runNativeSync:async()=>{},getReadiness:()=>({ready,reason:'settling'})});
    h.service.start(); h.fireLayout(); await flushMicrotasks();
    assert.equal(h.nativeSyncCalls.length,0);
    for(let n=0;n<10;n++) await h.service.fulfillStartupSync();
    assert.equal(h.nativeSyncCalls.length,0); assert.equal(intervals,1,'no new readiness timer');
    ready=true; await h.service.fulfillStartupSync();
    for(let n=0;n<100;n++) await h.service.fulfillStartupSync();
    assert.equal(h.nativeSyncCalls.length,1,'initial ready sync exactly once');
    await h.service.stop(); h.fireLayout(); await flushMicrotasks();
    assert.equal(h.nativeSyncCalls.length,1);
  } finally {globalThis.window=priorWindow;}
});

async function withCalendarIntervals(run) {
  const priorWindow = globalThis.window;
  const callbacks = new Map();
  let nextId = 0;
  globalThis.window = {
    setInterval(callback) { const id = ++nextId; callbacks.set(id, callback); return id; },
    clearInterval(id) { callbacks.delete(id); },
  };
  try { await run(callbacks); }
  finally { globalThis.window = priorWindow; }
}

test('a real startup failure is attempted once across 100 request polls without disabling manual or configured sync', async () => {
  await withCalendarIntervals(async (intervals) => {
    const failure = new Error('duplicate native calendar identity');
    let shouldFail = true;
    let recurrenceCalls = 0;
    const h = createHarness({
      async runNativeSync() { if (shouldFail) throw failure; },
      async runCompletion() { recurrenceCalls += 1; },
    });
    h.service.start();
    try {
      await assert.rejects(h.service.fulfillStartupSync(), error => error === failure);
      for (let poll = 0; poll < 100; poll += 1) await h.service.fulfillStartupSync().catch(() => undefined);
      assert.equal(h.nativeSyncCalls.length, 1, 'request polling must not replay a failed startup run');
      assert.equal(recurrenceCalls, 0);
      assert.equal(eventCount(h.events, COMPLETED), 0, 'failure must not be reported as successful');
      assert.equal(intervals.size, 1, 'no new retry timer is created');

      shouldFail = false;
      assert.equal(await h.service.runSync(true), 'completed');
      assert.equal(h.nativeSyncCalls.length, 2, 'explicit sync still runs after the startup failure');
      const scheduledTick = [...intervals.values()][0];
      scheduledTick();
      await flushMicrotasks(30);
      assert.equal(h.nativeSyncCalls.length, 3, 'the existing configured interval still performs sync');
      assert.equal(recurrenceCalls, 2);
      assert.equal(eventCount(h.events, COMPLETED), 2);
      for (let poll = 0; poll < 100; poll += 1) await h.service.fulfillStartupSync();
      assert.equal(h.nativeSyncCalls.length, 3, 'startup polling remains idle after later normal syncs');
    } finally { await h.service.stop(); }
  });
});

test('restart preserves its startup obligation when it joins an older stopped flight', async () => {
  await withCalendarIntervals(async () => {
    const oldFlight = deferred();
    let physicalRuns = 0;
    const h = createHarness({
      async runNativeSync() { physicalRuns += 1; if (physicalRuns === 1) await oldFlight.promise; },
    });
    h.service.start();
    const oldStartup = h.service.fulfillStartupSync();
    await flushMicrotasks();
    assert.equal(physicalRuns, 1);
    void h.service.stop();
    h.service.start();
    const joinedNewStartup = h.service.fulfillStartupSync();
    await flushMicrotasks();
    assert.equal(physicalRuns, 1, 'restart joins the draining old flight rather than overlapping it');
    oldFlight.resolve();
    await Promise.all([oldStartup, joinedNewStartup]);
    assert.equal(eventCount(h.events, COMPLETED), 0, 'the stopped flight cannot complete the new startup');
    try {
      await h.service.fulfillStartupSync();
      assert.equal(physicalRuns, 2, 'the current generation runs after the old flight drains');
      assert.equal(eventCount(h.events, COMPLETED), 1);
      for (let poll = 0; poll < 100; poll += 1) await h.service.fulfillStartupSync();
      assert.equal(physicalRuns, 2);
    } finally { await h.service.stop(); }
  });
});

test('a stale native sync rejection cannot consume a newer startup generation', async () => {
  await withCalendarIntervals(async () => {
    const oldFlight = deferred();
    let physicalRuns = 0;
    const h = createHarness({
      async runNativeSync() { physicalRuns += 1; if (physicalRuns === 1) await oldFlight.promise; },
    });
    h.service.start();
    const staleStartup = h.service.fulfillStartupSync();
    await flushMicrotasks();
    void h.service.stop();
    h.service.start();
    oldFlight.reject(new Error('old lifecycle failed while draining'));
    // executeSync suppresses a stale owner's failure into the stopped outcome.
    await staleStartup;
    try {
      await h.service.fulfillStartupSync();
      assert.equal(physicalRuns, 2, 'the stale failure leaves the new startup obligation pending');
      assert.equal(eventCount(h.events, COMPLETED), 1);
      for (let poll = 0; poll < 100; poll += 1) await h.service.fulfillStartupSync();
      assert.equal(physicalRuns, 2);
    } finally { await h.service.stop(); }
  });
});
