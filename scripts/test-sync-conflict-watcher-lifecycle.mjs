import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(
  new URL("../src/services/sync-conflict-watcher.ts", import.meta.url),
  "utf8",
);

let activeNotices = [];

class FakeTFile {
  constructor(path, frontmatter = undefined) {
    this.path = path;
    this.extension = path.includes(".") ? path.slice(path.lastIndexOf(".") + 1) : "";
    this.basename = path.slice(path.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "");
    this.parent = {
      path: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "/",
    };
    this.frontmatter = frontmatter;
  }
}

class FakeNotice {
  constructor(message) {
    activeNotices.push(String(message));
  }
}

class FakeEvents {
  constructor() {
    this.nextId = 1;
    this.refs = new Map();
    this.wrongEmitterOffrefs = 0;
  }

  on(name, callback) {
    const ref = {
      owner: this,
      id: this.nextId++,
      name,
      callback,
    };
    this.refs.set(ref.id, ref);
    return ref;
  }

  offref(ref) {
    if (ref?.owner !== this) {
      this.wrongEmitterOffrefs++;
      return;
    }
    this.refs.delete(ref.id);
  }

  emit(name, ...args) {
    for (const ref of this.refs.values()) {
      if (ref.name === name) ref.callback(...args);
    }
  }

  callbacks(name) {
    return [...this.refs.values()]
      .filter((ref) => ref.name === name)
      .map((ref) => ref.callback);
  }

  count(name = null) {
    return [...this.refs.values()].filter((ref) => name === null || ref.name === name).length;
  }
}

class FakeTimers {
  constructor() {
    this.nextId = 1;
    this.active = new Map();
    this.allCallbacks = [];
    this.cleared = 0;
  }

  setTimeout(callback, delay) {
    const id = this.nextId++;
    this.active.set(id, { callback, delay });
    this.allCallbacks.push(callback);
    return id;
  }

  clearTimeout(id) {
    if (this.active.delete(id)) this.cleared++;
  }

  async fireNext() {
    const entry = this.active.entries().next();
    if (entry.done) return false;
    const [id, timer] = entry.value;
    this.active.delete(id);
    timer.callback();
    await new Promise((resolve) => setImmediate(resolve));
    return true;
  }
}

function normalizePath(value) {
  return String(value ?? "")
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/$/, "");
}

function loadWatcherClass(canAutomaticallyMutate = async () => true) {
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  });
  const module = { exports: {} };
  const requireStub = (id) => {
    if (id === "obsidian") {
      return {
        Notice: FakeNotice,
        TFile: FakeTFile,
        normalizePath,
      };
    }
    if (id === "../logger") {
      return {
        flow() {},
        flowWarn() {},
        flowError() {},
      };
    }
    if (id === "../tps-gcm-api") {
      return {
        canAutomaticallyMutateViaGcm: canAutomaticallyMutate,
        getGcmApi: () => ({
          nativeRecords: {
            inspect: (frontmatter) => frontmatter?.gcmCalendarId
              ? { id: frontmatter.gcmCalendarId, kind: "calendar-event" }
              : null,
          },
        }),
      };
    }
    if (id === "./calendar-record-identity") {
      return {
        parseCalendarRecordId: (value) => /^calendar:v1:[A-Za-z0-9_-]{16}:[A-Za-z0-9_-]{27}$/u.test(String(value || ""))
          ? { version: 1 }
          : null,
      };
    }
    throw new Error(`Unexpected require: ${id}`);
  };
  const load = new Function("module", "exports", "require", compiled.outputText);
  load(module, module.exports, requireStub);
  return module.exports.SyncConflictWatcher;
}

function createDeferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function createHarness(files, options = {}) {
  const vaultEvents = new FakeEvents();
  const metadataEvents = new FakeEvents();
  const timers = new FakeTimers();
  const pathMap = new Map(files.map((file) => [file.path, file]));
  const ops = {
    enumerations: 0,
    metadataReads: 0,
    lookups: 0,
    renameStarted: 0,
    renames: [],
    folders: [],
  };

  const vault = Object.assign(vaultEvents, {
    getMarkdownFiles() {
      ops.enumerations++;
      return files.slice();
    },
    getAbstractFileByPath(path) {
      ops.lookups++;
      if (
        path === "System"
        || path === "System/Archive"
        || path === "System/Archive/Duplicates"
      ) {
        return { path };
      }
      return pathMap.get(path) ?? null;
    },
    async rename(file, newPath) {
      ops.renameStarted++;
      if (options.renameGate) await options.renameGate.promise;
      const oldPath = file.path;
      ops.renames.push([oldPath, newPath]);
      pathMap.delete(oldPath);
      file.path = newPath;
      file.basename = newPath.slice(newPath.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "");
      file.parent = {
        path: newPath.includes("/") ? newPath.slice(0, newPath.lastIndexOf("/")) : "/",
      };
      pathMap.set(newPath, file);
    },
    async createFolder(path) {
      ops.folders.push(path);
    },
  });
  const metadataCache = Object.assign(metadataEvents, {
    getFileCache(file) {
      ops.metadataReads++;
      if (options.metadataUnavailablePaths?.has(file.path)) return null;
      return { frontmatter: file.frontmatter };
    },
  });
  const app = { vault, metadataCache };

  globalThis.window = {
    setTimeout: (callback, delay) => timers.setTimeout(callback, delay),
    clearTimeout: (id) => timers.clearTimeout(id),
  };
  activeNotices = [];
  const Watcher = loadWatcherClass(options.canAutomaticallyMutate);
  const watcher = new Watcher(app);
  return {
    watcher,
    vaultEvents,
    metadataEvents,
    timers,
    ops,
    notices: activeNotices,
  };
}

async function waitFor(predicate, label) {
  for (let attempt = 0; attempt < 2_000; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function waitForSweepToSettle(watcher) {
  await new Promise((resolve) => setImmediate(resolve));
  await waitFor(() => watcher.isSweeping === false, "sync-conflict sweep settlement");
}

function conflictFixture() {
  return [
    new FakeTFile("Inbox/Normal.md"),
    new FakeTFile("Inbox/Meeting.md"),
    new FakeTFile("Inbox/Meeting duplicate.md"),
    new FakeTFile("Inbox/Protected.md"),
    new FakeTFile("Inbox/Protected duplicate.md", { externalEventId: "calendar:test" }),
    new FakeTFile("Inbox/Canonical.md"),
    new FakeTFile("Inbox/Canonical duplicate.md", { tpsId: "calendar:v1:AAAAAAAAAAAAAAAA:BBBBBBBBBBBBBBBBBBBBBBBBBBB" }),
    new FakeTFile("Inbox/Tagged.md"),
    new FakeTFile("Inbox/Tagged duplicate.md", { gcmCalendarId: "calendar-tagged" }),
    new FakeTFile("Inbox/Legacy.md"),
    new FakeTFile("Inbox/Legacy duplicate.md", { tpsId: "item-random", externalId: "calendar:https://example.invalid#event" }),
    new FakeTFile("Inbox/Ordinary task.md"),
    new FakeTFile("Inbox/Ordinary task duplicate.md", { tpsId: "task-ordinary" }),
    new FakeTFile("Inbox/Orphan duplicate.md"),
  ];
}

test("SyncConflictWatcher lifecycle binds listeners and its startup fallback", async (t) => {
  const previousWindow = globalThis.window;
  try {
    await t.test("metadata resolution performs one active sweep and cancels the fallback timer", async () => {
      const harness = createHarness(conflictFixture());
      harness.watcher.start();

      assert.equal(harness.vaultEvents.count("create"), 1);
      assert.equal(harness.vaultEvents.count("rename"), 1);
      assert.equal(harness.metadataEvents.count("resolved"), 1);
      assert.equal(harness.metadataEvents.count("changed"), 1);
      assert.equal(harness.timers.active.size, 1);

      harness.metadataEvents.emit("resolved");
      await waitForSweepToSettle(harness.watcher);

      assert.equal(harness.ops.enumerations, 1);
      assert.deepEqual(harness.ops.renames, [[
        "Inbox/Meeting duplicate.md",
        "System/Archive/Duplicates/Meeting duplicate.md",
      ], [
        "Inbox/Ordinary task duplicate.md",
        "System/Archive/Duplicates/Ordinary task duplicate.md",
      ]]);
      assert.equal(harness.timers.active.size, 0);
      assert.equal(harness.timers.cleared, 1);

      harness.metadataEvents.emit("resolved");
      await waitForSweepToSettle(harness.watcher);
      assert.equal(harness.ops.enumerations, 1);

      harness.watcher.stop();
      assert.equal(harness.vaultEvents.count(), 0);
      assert.equal(harness.metadataEvents.count(), 0);
      assert.equal(harness.vaultEvents.wrongEmitterOffrefs, 0);
      assert.equal(harness.metadataEvents.wrongEmitterOffrefs, 0);
    });

    await t.test("the delayed fallback still performs one active sweep when resolution was missed", async () => {
      const harness = createHarness(conflictFixture());
      harness.watcher.start();

      assert.equal(await harness.timers.fireNext(), true);
      await waitForSweepToSettle(harness.watcher);

      assert.equal(harness.ops.enumerations, 1);
      assert.equal(harness.ops.renames.length, 2);
      assert.equal(harness.timers.active.size, 0);
      harness.watcher.stop();
    });

    await t.test("create waits for metadata before judging a conflict-style calendar filename", async () => {
      const canonical = new FakeTFile("Inbox/Standup.md");
      const conflictCanonical = new FakeTFile("Inbox/Meeting.md");
      const delayedCalendar = new FakeTFile("Inbox/Standup (2).md", {
        tpsId: "calendar:v1:AAAAAAAAAAAAAAAA:BBBBBBBBBBBBBBBBBBBBBBBBBBB",
      });
      const delayedConflict = new FakeTFile("Inbox/Meeting duplicate.md");
      const unavailable = new Set([delayedCalendar.path, delayedConflict.path]);
      const harness = createHarness([canonical, conflictCanonical, delayedCalendar, delayedConflict], {
        metadataUnavailablePaths: unavailable,
      });
      harness.watcher.start();

      harness.vaultEvents.emit("create", delayedCalendar);
      harness.vaultEvents.emit("create", delayedConflict);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(harness.ops.renames.length, 0);

      unavailable.clear();
      harness.metadataEvents.emit("changed", delayedCalendar);
      harness.metadataEvents.emit("changed", delayedConflict);
      await waitFor(() => harness.ops.renames.length === 1, "metadata retry conflict rename");
      assert.deepEqual(harness.ops.renames, [[
        "Inbox/Meeting duplicate.md",
        "System/Archive/Duplicates/Meeting duplicate.md",
      ]]);
      assert.equal(delayedCalendar.path, "Inbox/Standup (2).md");
      harness.watcher.stop();
    });

    await t.test("template protection is checked again at the conflict-rename boundary", async () => {
      const canonical = new FakeTFile("Inbox/Template.md");
      const conflict = new FakeTFile("Inbox/Template duplicate.md");
      let checks = 0;
      const harness = createHarness([canonical, conflict], {
        canAutomaticallyMutate: async () => {
          checks += 1;
          return checks === 1;
        },
      });
      harness.watcher.start();

      harness.vaultEvents.emit("create", conflict);
      await waitFor(() => checks === 2, "template mutation-boundary checks");

      assert.equal(harness.ops.renames.length, 0);
      assert.equal(conflict.path, "Inbox/Template duplicate.md");
      harness.watcher.stop();
    });

    await t.test("stop removes originating-emitter listeners and rejects captured stale callbacks", async () => {
      const files = Array.from(
        { length: 20_000 },
        (_, index) => new FakeTFile(`Inbox/Normal-${index}.md`),
      );
      const harness = createHarness(files);
      harness.watcher.start();
      const staleTimerCallbacks = harness.timers.allCallbacks.slice();
      const staleResolvedCallbacks = harness.metadataEvents.callbacks("resolved");

      harness.watcher.stop();

      assert.equal(harness.timers.active.size, 0);
      assert.equal(harness.timers.cleared, 1);
      assert.equal(harness.vaultEvents.count(), 0);
      assert.equal(harness.metadataEvents.count(), 0);
      assert.equal(harness.vaultEvents.wrongEmitterOffrefs, 0);
      assert.equal(harness.metadataEvents.wrongEmitterOffrefs, 0);

      for (const callback of [...staleResolvedCallbacks, ...staleTimerCallbacks]) callback();
      await waitForSweepToSettle(harness.watcher);
      assert.equal(harness.ops.enumerations, 0);
      assert.equal(harness.ops.metadataReads, 0);
      assert.equal(harness.ops.renames.length, 0);
    });

    await t.test("a stop-start cycle ignores the old generation and retains one current fallback", async () => {
      const harness = createHarness(conflictFixture());
      harness.watcher.start();
      const staleTimerCallback = harness.timers.allCallbacks[0];
      const staleResolvedCallback = harness.metadataEvents.callbacks("resolved")[0];
      harness.watcher.stop();
      harness.watcher.start();

      staleTimerCallback();
      staleResolvedCallback();
      await waitForSweepToSettle(harness.watcher);
      assert.equal(harness.ops.enumerations, 0);
      assert.equal(harness.timers.active.size, 1);

      assert.equal(await harness.timers.fireNext(), true);
      await waitForSweepToSettle(harness.watcher);
      assert.equal(harness.ops.enumerations, 1);
      assert.equal(harness.ops.renames.length, 2);
      harness.watcher.stop();
    });

    await t.test("stop does not cancel a sweep that already reached its physical rename", async () => {
      const renameGate = createDeferred();
      const harness = createHarness(conflictFixture(), { renameGate });
      harness.watcher.start();
      harness.metadataEvents.emit("resolved");
      await waitFor(() => harness.ops.renameStarted === 1, "blocked conflict rename");

      harness.watcher.stop();
      renameGate.resolve();
      await waitForSweepToSettle(harness.watcher);

      assert.equal(harness.ops.enumerations, 1);
      assert.equal(harness.ops.renames.length, 2);
      assert.equal(harness.timers.active.size, 0);
    });
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});
