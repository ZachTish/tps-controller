import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const logEntries = [];
const noticeMessages = [];

class FakeTFile {
  constructor(path) {
    this.setPath(path);
  }

  setPath(path) {
    this.path = path;
    this.name = path.split("/").at(-1) || path;
    const dot = this.name.lastIndexOf(".");
    this.extension = dot >= 0 ? this.name.slice(dot + 1) : "";
    this.basename = dot >= 0 ? this.name.slice(0, dot) : this.name;
    const parentPath = path.split("/").slice(0, -1).join("/");
    this.parent = { path: parentPath || "/" };
  }
}

class FakeNotice {
  constructor(message) {
    noticeMessages.push(String(message));
  }
}

function normalizePath(value) {
  return String(value || "")
    .replace(/\\/gu, "/")
    .replace(/\/{2,}/gu, "/")
    .replace(/^\.\//u, "")
    .replace(/\/$/u, "");
}

const loggerStub = {
  flow(scope, event, context) {
    logEntries.push({ level: "flow", scope, event, context });
  },
  flowWarn(scope, event, context) {
    logEntries.push({ level: "warn", scope, event, context });
  },
  flowError(scope, event, error, context) {
    logEntries.push({ level: "error", scope, event, error, context });
  },
};

function loadWatcherClass() {
  const source = readFileSync(
    new URL("../src/services/sync-conflict-watcher.ts", import.meta.url),
    "utf8",
  );
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  });
  const module = { exports: {} };
  const requireStub = (id) => {
    if (id === "obsidian") {
      return {
        App: class {},
        TFile: FakeTFile,
        Notice: FakeNotice,
        normalizePath,
      };
    }
    if (id === "../logger") return loggerStub;
    throw new Error(`Unexpected test import: ${id}`);
  };
  new Function("module", "exports", "require", compiled.outputText)(module, module.exports, requireStub);
  return module.exports.SyncConflictWatcher;
}

const SyncConflictWatcher = loadWatcherClass();

class FakeEventOwner {
  constructor(name) {
    this.name = name;
    this.refs = [];
    this.offrefCalls = 0;
  }

  on(event, callback) {
    const ref = { owner: this, event, callback, active: true };
    this.refs.push(ref);
    return ref;
  }

  offref(ref) {
    assert.equal(ref.owner, this, `${this.name} must only remove its own event refs`);
    if (!ref.active) return;
    ref.active = false;
    this.offrefCalls += 1;
  }

  listenerCount(event) {
    return this.refs.filter((ref) => ref.active && (!event || ref.event === event)).length;
  }

  capturedCallback(event, index = 0) {
    return this.refs.filter((ref) => ref.event === event)[index]?.callback;
  }

  async emit(event, ...args) {
    for (const ref of this.refs.filter((candidate) => candidate.active && candidate.event === event)) {
      await ref.callback(...args);
    }
  }
}

class FakeVault extends FakeEventOwner {
  constructor() {
    super("vault");
    this.entries = new Map();
    this.markdownFiles = [];
    this.scanCount = 0;
    this.renameCalls = [];
    this.createFolderCalls = [];
    this.renameHook = null;
    this.createFolderHook = null;
  }

  addEntry(entry) {
    this.entries.set(entry.path, entry);
    return entry;
  }

  addFolder(path) {
    return this.addEntry({ path, type: "folder" });
  }

  getMarkdownFiles() {
    this.scanCount += 1;
    return [...this.markdownFiles];
  }

  getAbstractFileByPath(path) {
    return this.entries.get(normalizePath(path)) || null;
  }

  async createFolder(path) {
    const normalized = normalizePath(path);
    this.createFolderCalls.push(normalized);
    if (this.createFolderHook) await this.createFolderHook(normalized, this.createFolderCalls.length);
    this.addFolder(normalized);
  }

  async rename(file, targetPath) {
    const normalized = normalizePath(targetPath);
    const originalPath = file.path;
    this.renameCalls.push({ originalPath, targetPath: normalized });
    if (this.renameHook) await this.renameHook(file, normalized, this.renameCalls.length);
    this.entries.delete(originalPath);
    file.setPath(normalized);
    this.entries.set(normalized, file);
  }
}

class FakeMetadataCache extends FakeEventOwner {
  constructor() {
    super("metadataCache");
  }

  getFileCache() {
    return {};
  }
}

class FakeTimerHost {
  constructor() {
    this.nextId = 1;
    this.entries = new Map();
    this.history = [];
    this.clearCalls = [];
  }

  setTimeout(callback, delayMs) {
    const entry = { id: this.nextId++, callback, delayMs };
    this.entries.set(entry.id, entry);
    this.history.push(entry);
    return entry.id;
  }

  clearTimeout(id) {
    this.clearCalls.push(id);
    this.entries.delete(id);
  }

  activeCount() {
    return this.entries.size;
  }

  capturedCallback(index = 0) {
    return this.history[index]?.callback;
  }
}

function createHarness() {
  logEntries.length = 0;
  noticeMessages.length = 0;
  const vault = new FakeVault();
  const metadataCache = new FakeMetadataCache();
  const timers = new FakeTimerHost();
  const app = { vault, metadataCache };
  const watcher = new SyncConflictWatcher(app, timers);
  return { app, metadataCache, timers, vault, watcher };
}

function addConflictPair(vault, basename, folder = "Inbox") {
  const canonical = vault.addEntry(new FakeTFile(`${folder}/${basename}.md`));
  const conflict = vault.addEntry(new FakeTFile(`${folder}/${basename} (1).md`));
  return { canonical, conflict };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

test("watcher start is idempotent and stop invalidates every queued callback", async () => {
  const { metadataCache, timers, vault, watcher } = createHarness();
  const { conflict } = addConflictPair(vault, "Queued callback");
  vault.markdownFiles = [conflict];

  watcher.start();
  const staleCreate = vault.capturedCallback("create");
  const staleRename = vault.capturedCallback("rename");
  const staleResolved = metadataCache.capturedCallback("resolved");
  const staleTimer = timers.capturedCallback();
  watcher.start();

  assert.equal(vault.listenerCount(), 2);
  assert.equal(metadataCache.listenerCount("resolved"), 1);
  assert.equal(timers.activeCount(), 1);
  assert.equal(logEntries.filter((entry) => entry.event === "start:already-active").length, 1);

  watcher.stop();
  assert.equal(vault.listenerCount(), 0);
  assert.equal(metadataCache.listenerCount(), 0);
  assert.equal(vault.offrefCalls, 2);
  assert.equal(metadataCache.offrefCalls, 1);
  assert.equal(timers.activeCount(), 0);

  watcher.start();
  await staleCreate(conflict);
  await staleRename(conflict);
  staleResolved();
  staleTimer();
  await flushMicrotasks();
  assert.equal(vault.scanCount, 0);
  assert.equal(vault.renameCalls.length, 0);

  watcher.stop();
  const vaultOffrefCalls = vault.offrefCalls;
  const metadataOffrefCalls = metadataCache.offrefCalls;
  watcher.stop();
  assert.equal(vault.offrefCalls, vaultOffrefCalls);
  assert.equal(metadataCache.offrefCalls, metadataOffrefCalls);
});

test("metadata resolution runs one sweep and cancels the fallback timer", async () => {
  const { metadataCache, timers, vault, watcher } = createHarness();
  watcher.start();
  const staleTimer = timers.capturedCallback();

  await metadataCache.emit("resolved");
  await flushMicrotasks();
  assert.equal(vault.scanCount, 1);
  assert.equal(timers.activeCount(), 0);

  staleTimer();
  await flushMicrotasks();
  assert.equal(vault.scanCount, 1);
  watcher.stop();
});

test("stop during folder creation prevents every later mutation", async () => {
  const { vault, watcher } = createHarness();
  const { conflict } = addConflictPair(vault, "Folder pause");
  vault.markdownFiles = [conflict];
  const folderCreation = deferred();
  vault.createFolderHook = async (_path, callNumber) => {
    if (callNumber === 1) await folderCreation.promise;
  };

  watcher.start();
  const sweep = watcher.sweepVaultForConflicts();
  await waitFor(() => vault.createFolderCalls.length === 1, "sweep did not reach folder creation");
  watcher.stop();
  folderCreation.resolve();
  await sweep;

  assert.equal(vault.createFolderCalls.length, 1, "no additional folder mutation may start after stop");
  assert.equal(vault.renameCalls.length, 0, "rename must not start after a stopped folder creation settles");
  assert.deepEqual(noticeMessages, []);
  assert.ok(logEntries.some((entry) => entry.event === "sweep:cancelled"));
});

test("event-driven archive work cannot overlap a restarted startup sweep", async () => {
  const { metadataCache, vault, watcher } = createHarness();
  vault.addFolder("System/Archive/Duplicates");
  const { conflict } = addConflictPair(vault, "Event conflict");
  vault.markdownFiles = [conflict];
  const firstRename = deferred();
  vault.renameHook = async (_file, _targetPath, callNumber) => {
    if (callNumber === 1) await firstRename.promise;
  };

  watcher.start();
  const createCallback = vault.capturedCallback("create");
  createCallback(conflict);
  await waitFor(() => vault.renameCalls.length === 1, "event archive did not reach rename");

  watcher.stop();
  watcher.start();
  await metadataCache.emit("resolved");
  const restartedSweep = watcher.sweepVaultForConflicts();
  await flushMicrotasks();
  assert.equal(vault.renameCalls.length, 1, "new sweep must wait for the already-issued event mutation");

  firstRename.resolve();
  await restartedSweep;
  assert.equal(vault.scanCount, 1);
  assert.equal(vault.renameCalls.length, 1, "the restarted sweep must not archive the same file twice");
  assert.deepEqual(noticeMessages, []);
  watcher.stop();
});

test("restart waits for an old sweep to unwind and does not lose the new sweep", async () => {
  const { metadataCache, timers, vault, watcher } = createHarness();
  vault.addFolder("System/Archive/Duplicates");
  const first = addConflictPair(vault, "First conflict");
  const second = addConflictPair(vault, "Second conflict");
  vault.markdownFiles = [first.conflict, second.conflict];
  const firstRename = deferred();
  vault.renameHook = async (_file, _targetPath, callNumber) => {
    if (callNumber === 1) await firstRename.promise;
  };

  watcher.start();
  const oldSweep = watcher.sweepVaultForConflicts();
  await waitFor(() => vault.renameCalls.length === 1, "old sweep did not reach its first rename");

  watcher.stop();
  watcher.start();
  await metadataCache.emit("resolved");
  const restartedSweep = watcher.sweepVaultForConflicts();
  firstRename.resolve();
  await Promise.all([oldSweep, restartedSweep]);

  assert.equal(vault.scanCount, 2, "each lifecycle gets exactly one startup scan");
  assert.deepEqual(
    vault.renameCalls.map((call) => call.originalPath),
    ["Inbox/First conflict (1).md", "Inbox/Second conflict (1).md"],
  );
  assert.deepEqual(noticeMessages, ["Controller: Archived 1 sync conflicts on startup."]);
  assert.equal(timers.activeCount(), 0);
  assert.ok(logEntries.some((entry) => entry.event === "archive:completed-after-stop"));
  assert.ok(logEntries.some((entry) => entry.event === "sweep:wait-prior-generation"));
  watcher.stop();
});
