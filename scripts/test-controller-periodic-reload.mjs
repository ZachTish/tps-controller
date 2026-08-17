import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const sourceUrl = new URL("../src/services/controller-periodic-reload-service.ts", import.meta.url);
const source = readFileSync(sourceUrl, "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
  },
});
const loadedModule = { exports: {} };
new Function("module", "exports", "require", compiled.outputText)(
  loadedModule,
  loadedModule.exports,
  () => { throw new Error("Periodic reload core must not import runtime dependencies"); },
);

const {
  CONTROLLER_PERIODIC_RELOAD_INTERVAL_MS,
  CONTROLLER_PERIODIC_RELOAD_WARNING_MS,
  ControllerPeriodicReloadPreference,
  ControllerPeriodicReloadService,
} = loadedModule.exports;

const WARNING_DELAY_MS = CONTROLLER_PERIODIC_RELOAD_INTERVAL_MS
  - CONTROLLER_PERIODIC_RELOAD_WARNING_MS;

class MemoryStorage {
  values = new Map();

  getItem(key) {
    return this.values.get(key) ?? null;
  }

  setItem(key, value) {
    this.values.set(key, String(value));
  }

  removeItem(key) {
    this.values.delete(key);
  }
}

class FakeTimers {
  now = 0;
  nextId = 1;
  entries = new Map();

  setTimeout = (callback, delayMs) => {
    const id = this.nextId++;
    this.entries.set(id, { id, callback, at: this.now + delayMs, delayMs });
    return id;
  };

  clearTimeout = (handle) => {
    this.entries.delete(handle);
  };

  pending() {
    return [...this.entries.values()].sort((left, right) => left.at - right.at || left.id - right.id);
  }

  advanceBy(durationMs) {
    const target = this.now + durationMs;
    while (true) {
      const next = this.pending().find((entry) => entry.at <= target);
      if (!next) break;
      this.entries.delete(next.id);
      this.now = next.at;
      next.callback();
    }
    this.now = target;
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(rounds = 12) {
  for (let round = 0; round < rounds; round += 1) await Promise.resolve();
}

function createHarness(overrides = {}) {
  const timers = new FakeTimers();
  const events = [];
  const state = {
    eligible: true,
    warnings: 0,
    preflights: 0,
    reloads: 0,
  };
  const service = new ControllerPeriodicReloadService({
    timers,
    isEligible: () => state.eligible,
    showWarning: () => { state.warnings += 1; },
    preflight: async () => { state.preflights += 1; },
    executeReload: async () => {
      state.reloads += 1;
      return true;
    },
    onEvent: (event, data) => events.push({ event, data }),
    ...overrides,
  });
  return { timers, events, state, service };
}

test("device-local preference is vault scoped and defaults off", () => {
  const storage = new MemoryStorage();
  const alpha = new ControllerPeriodicReloadPreference("Alpha", storage);
  const beta = new ControllerPeriodicReloadPreference("Beta", storage);

  assert.equal(alpha.get(), false);
  assert.equal(beta.get(), false);
  assert.equal(alpha.set(true), true);
  assert.equal(alpha.get(), true);
  assert.equal(beta.get(), false);
  assert.deepEqual([...storage.values], [["tps-controller-periodic-reload-Alpha", "enabled"]]);

  assert.equal(alpha.set(false), true);
  assert.equal(alpha.get(), false);
  assert.equal(storage.values.size, 0, "disabled is represented by the safe missing-key default");

  const denied = new ControllerPeriodicReloadPreference("Denied", {
    getItem() { throw new Error("storage denied"); },
    setItem() { throw new Error("storage denied"); },
    removeItem() { throw new Error("storage denied"); },
  });
  assert.equal(denied.get(), false, "unavailable local storage must fail closed");
  assert.equal(denied.set(true), false, "a rejected enable must not escape into the UI");
  assert.equal(denied.get(), false);
  assert.equal(denied.set(false), false, "a rejected disable must not escape into the UI");
  assert.equal(denied.get(), false);

  const removeDeniedStorage = new MemoryStorage();
  removeDeniedStorage.removeItem = () => { throw new Error("remove denied"); };
  const removeDenied = new ControllerPeriodicReloadPreference("RemoveDenied", removeDeniedStorage);
  assert.equal(removeDenied.set(true), true);
  assert.equal(removeDenied.set(false), true, "a disabled marker safely replaces a key when deletion fails");
  assert.equal(removeDenied.get(), false);
  assert.equal(removeDeniedStorage.getItem("tps-controller-periodic-reload-RemoveDenied"), "disabled");

  const staleEnabled = new ControllerPeriodicReloadPreference("Stale", {
    getItem() { return "enabled"; },
    setItem() { throw new Error("write denied"); },
    removeItem() { throw new Error("remove denied"); },
  });
  assert.equal(staleEnabled.get(), true);
  assert.equal(staleEnabled.set(true), false);
  assert.equal(staleEnabled.get(), false, "a failed write overrides a stale enabled value for this session");
});

test("fixed cadence warns at minute 14 and reloads at minute 15 without an immediate action", async () => {
  const { timers, events, state, service } = createHarness();
  assert.equal(CONTROLLER_PERIODIC_RELOAD_INTERVAL_MS, 900_000);
  assert.equal(CONTROLLER_PERIODIC_RELOAD_WARNING_MS, 60_000);

  service.start();
  assert.deepEqual({ warnings: state.warnings, preflights: state.preflights, reloads: state.reloads }, {
    warnings: 0,
    preflights: 0,
    reloads: 0,
  });
  assert.deepEqual(timers.pending().map((entry) => entry.delayMs), [840_000]);

  timers.advanceBy(WARNING_DELAY_MS - 1);
  assert.equal(state.warnings, 0);
  timers.advanceBy(1);
  assert.equal(state.warnings, 1);
  assert.equal(state.reloads, 0);
  assert.deepEqual(timers.pending().map((entry) => entry.delayMs), [60_000]);

  timers.advanceBy(CONTROLLER_PERIODIC_RELOAD_WARNING_MS - 1);
  assert.equal(state.preflights, 0);
  timers.advanceBy(1);
  assert.equal(state.preflights, 1);
  assert.equal(state.reloads, 0, "reload waits for the asynchronous preflight");
  await flushMicrotasks();
  assert.equal(state.reloads, 1);
  assert.deepEqual(timers.pending().map((entry) => entry.delayMs), [840_000]);
  assert.ok(events.some(({ event }) => event === "reload-requested"));
});

test("start is idempotent, eligibility is rechecked, and stop invalidates stale callbacks", () => {
  const { timers, state, service } = createHarness();
  state.eligible = false;
  service.start();
  assert.equal(timers.pending().length, 0);

  state.eligible = true;
  service.start();
  service.start();
  assert.equal(timers.pending().length, 1);
  const staleWarning = timers.pending()[0].callback;

  state.eligible = false;
  timers.advanceBy(WARNING_DELAY_MS);
  assert.equal(state.warnings, 0);
  assert.equal(timers.pending().length, 0);

  state.eligible = true;
  service.start();
  assert.equal(timers.pending().length, 1);
  service.stop();
  assert.equal(timers.pending().length, 0);
  staleWarning();
  assert.equal(state.warnings, 0, "a callback retained by the host cannot outlive stop");

  service.dispose();
  service.start();
  assert.equal(timers.pending().length, 0, "disposed services cannot be rearmed");
});

test("a stopped asynchronous preflight cannot execute or disturb a replacement generation", async () => {
  const gate = deferred();
  const harness = createHarness({
    preflight: async () => {
      harness.state.preflights += 1;
      await gate.promise;
    },
  });
  harness.service.start();
  harness.timers.advanceBy(CONTROLLER_PERIODIC_RELOAD_INTERVAL_MS);
  assert.equal(harness.state.preflights, 1);

  harness.service.stop();
  harness.service.start();
  assert.deepEqual(harness.timers.pending().map((entry) => entry.delayMs), [840_000]);
  gate.resolve();
  await flushMicrotasks();

  assert.equal(harness.state.reloads, 0);
  assert.deepEqual(
    harness.timers.pending().map((entry) => entry.delayMs),
    [840_000],
    "stale completion must not clear or duplicate the replacement timer",
  );
});

test("preflight failure and a rejected reload each retry only after a new full cycle", async () => {
  let preflightShouldFail = true;
  const harness = createHarness({
    preflight: async () => {
      harness.state.preflights += 1;
      if (preflightShouldFail) throw new Error("save failed");
    },
    executeReload: async () => {
      harness.state.reloads += 1;
      return false;
    },
  });

  harness.service.start();
  harness.timers.advanceBy(CONTROLLER_PERIODIC_RELOAD_INTERVAL_MS);
  await flushMicrotasks();
  assert.equal(harness.state.reloads, 0);
  assert.deepEqual(harness.timers.pending().map((entry) => entry.delayMs), [840_000]);
  assert.ok(harness.events.some(({ event, data }) => event === "failed" && data.stage === "reload-attempt"));

  preflightShouldFail = false;
  harness.timers.advanceBy(CONTROLLER_PERIODIC_RELOAD_INTERVAL_MS);
  await flushMicrotasks();
  assert.equal(harness.state.reloads, 1);
  assert.ok(harness.events.some(({ event }) => event === "reload-rejected"));
  assert.deepEqual(harness.timers.pending().map((entry) => entry.delayMs), [840_000]);
});

test("duplicate timer delivery cannot create overlapping reload attempts", async () => {
  const gate = deferred();
  const harness = createHarness({
    preflight: async () => {
      harness.state.preflights += 1;
      await gate.promise;
    },
  });
  harness.service.start();
  harness.timers.advanceBy(WARNING_DELAY_MS);
  const reloadCallback = harness.timers.pending()[0].callback;
  harness.timers.advanceBy(CONTROLLER_PERIODIC_RELOAD_WARNING_MS);
  reloadCallback();
  reloadCallback();
  assert.equal(harness.state.preflights, 1);
  gate.resolve();
  await flushMicrotasks();
  assert.equal(harness.state.reloads, 1);
  assert.equal(harness.timers.pending().length, 1);
});

test("core contains no raw page reload fallback", () => {
  assert.doesNotMatch(source, /window\.location\.reload|location\.reload/);
  assert.doesNotMatch(source, /from\s+["']obsidian["']/);
});
