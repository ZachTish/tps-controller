import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs/promises";
import path from "node:path";

const require = createRequire(import.meta.url);
async function load(source) {
  const result = await build({ entryPoints: [fileURLToPath(new URL(`../src/services/attachment-sync/${source}.ts`, import.meta.url))], bundle: true, write: false, format: "cjs", platform: "node" });
  const module = { exports: {} };
  new Function("require", "module", "exports", result.outputFiles[0].text)(require, module, module.exports);
  return module.exports;
}
const localModule = await load("local-files");
const stateModule = await load("device-state");
const { ObsidianAttachmentLocalStore, isAttachmentPathEligible, safeAttachmentPath, readExactResourceRange } = localModule;
const { AttachmentDeviceStateStore, localVaultIdentity, validateDeviceState } = stateModule;
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const createHasher = () => {
  const state = createHash("sha256");
  return { update: bytes => { state.update(bytes); }, digestHex: async () => state.digest("hex") };
};

function fixture(initial = {}) {
  let clock = 100;
  const entries = new Map([["", { type: "folder", mtime: 1, size: 0 }]]);
  const events = [];
  const parent = path => path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  function directory(path) {
    if (!path || entries.has(path)) return;
    directory(parent(path)); entries.set(path, { type: "folder", size: 0, mtime: ++clock });
  }
  function set(path, bytes, mtime) {
    directory(parent(path));
    const value = typeof bytes === "string" ? new TextEncoder().encode(bytes) : new Uint8Array(bytes);
    entries.set(path, { type: "file", bytes: value.slice(), size: value.length, mtime: mtime ?? ++clock });
  }
  for (const [path, bytes] of Object.entries(initial)) set(path, bytes);
  const adapter = {
    getFullPath: path => `/device/vault-one/${path}`,
    getResourcePath: path => `memory://vault/${encodeURIComponent(path)}`,
    stat: async path => entries.has(path) ? { ...entries.get(path), bytes: undefined } : null,
    exists: async path => entries.has(path),
    list: async path => {
      if (entries.get(path)?.type !== "folder") throw new Error("missing directory");
      const files = [], folders = [];
      for (const [key, value] of entries) if (key && parent(key) === path) (value.type === "folder" ? folders : files).push(key);
      return { files, folders };
    },
    mkdir: async path => { if (entries.has(path)) throw new Error("exists"); directory(path); },
    writeBinary: async (path, bytes) => set(path, bytes),
    appendBinary: async (path, bytes, options) => {
      const old = entries.get(path); if (!old || old.type !== "file") throw new Error("missing append target");
      const next = new Uint8Array(old.size + bytes.byteLength); next.set(old.bytes); next.set(new Uint8Array(bytes), old.size);
      set(path, next, options?.mtime);
    },
    remove: async path => { events.push(["remove", path]); entries.delete(path); },
    rename: async (from, to) => {
      if (!entries.has(from) || entries.has(to)) throw new Error("invalid rename");
      events.push(["rename", from, to]); entries.set(to, entries.get(from)); entries.delete(from);
    },
    trashSystem: async path => { events.push(["system-trash", path]); return false; },
    trashLocal: async path => {
      events.push(["local-trash", path]); directory(".trash");
      entries.set(`.trash/${path.replaceAll("/", "-")}-${events.length}`, entries.get(path)); entries.delete(path);
    },
  };
  const app = {
    vault: { adapter, getAbstractFileByPath: () => null, getConfig: () => "local" },
    fileManager: { trashFile: async file => { events.push(["indexed-trash", file.path]); await adapter.trashLocal(file.path); } },
  };
  let journal = null;
  const state = {
    getJournal: async () => structuredClone(journal),
    saveJournal: async value => { journal = structuredClone(value); },
  };
  const fetcher = async (url, options) => {
    const path = decodeURIComponent(url.slice("memory://vault/".length));
    const entry = entries.get(path);
    const match = /^bytes=(\d+)-(\d+)$/.exec(options.headers.Range);
    const start = Number(match[1]), end = Number(match[2]);
    return new Response(entry.bytes.slice(start, end + 1), { status: 206, headers: { "Content-Range": `bytes ${start}-${end}/${entry.size}`, "Content-Length": String(end - start + 1) } });
  };
  let sequence = 0;
  const options = { isDesktop: false, fetch: fetcher, createHasher, randomId: () => `stage000${++sequence}` };
  const store = () => new ObsidianAttachmentLocalStore(app, state, options);
  return { store: store(), reopen: store, app, adapter, entries, events, set, options, state, get journal() { return journal; } };
}

const revision = (content, id = "revision-a") => {
  const bytes = new TextEncoder().encode(content);
  return { id, size: bytes.length, mtime: 500, sha256: hash(bytes), chunks: bytes.length ? [{ index: 0, size: bytes.length, sha256: hash(bytes) }] : [] };
};
async function stage(store, path, content, id) {
  const rev = revision(content, id);
  const stageId = await store.createStage(path, rev);
  await store.appendStage(stageId, new TextEncoder().encode(content));
  return stageId;
}

test("adapter scans include unknown extensions and extensionless files while excluding native/internal/development content", async () => {
  const f = fixture({ "Inbox/photo.png": "image", "Inbox/voice.weirdcodec": "audio", "Inbox/opaque": "binary", "Inbox/note.MD": "note", "layout.canvas": "canvas", "view.base": "base", ".obsidian/plugins/main.js": "plugin", ".trash/old.jpg": "old", "Plugin Development/example/main.js": "code", "project/node_modules/module.js": "dependency", "Inbox/Controller Attachment Sync QA/large.mp4": "fixture" });
  assert.deepEqual((await f.store.scan()).files.map(file => file.path), ["Inbox/opaque", "Inbox/photo.png", "Inbox/voice.weirdcodec"]);
  f.options.excludedPaths = () => ["Inbox/voice.weirdcodec"];
  assert.deepEqual((await f.store.scan()).files.map(file => file.path), ["Inbox/opaque", "Inbox/photo.png"]);
});

test("unsafe, native and cross-platform collision paths are rejected", () => {
  for (const path of ["../file.mp4", "/file.mp4", "C:\\file.mp4", "images//file.png", "images/./file.png", "images/../file.png", ".tps/file.png", "x/CON.mp4", "x/a:b.mp4", "x/trailing. ", "x/control\u0001.png"]) assert.equal(safeAttachmentPath(path), false, path);
  for (const path of ["a.md", "a.canvas", "a.base", "node_modules/pkg/icon.svg", "Plugin Development/code.ts"]) assert.equal(isAttachmentPathEligible(path), false, path);
  assert.equal(isAttachmentPathEligible("Inbox/My voice recording.unfamiliar"), true);
  assert.equal(isAttachmentPathEligible("Inbox/md"), true);
});

test("incomplete or colliding scans throw before deletions can be inferred", async () => {
  const f = fixture({ "Inbox/photo.png": "a", "Inbox/PHOTO.PNG": "b" });
  await assert.rejects(f.store.scan(), /collision/);
  const broken = fixture({ "Inbox/a.png": "a" });
  broken.adapter.list = async () => { throw new Error("iCloud directory unavailable"); };
  await assert.rejects(broken.store.scan(), /unavailable/);
  const escaped = fixture();
  escaped.adapter.list = async () => ({ files: ["../outside.png"], folders: [] });
  await assert.rejects(escaped.store.scan(), /unsafe/);
});

test("mobile requests exactly one bounded range and rejects HTTP200 without consuming its body", async () => {
  let requested, read = false, aborted = false;
  const bytes = await readExactResourceRange("memory://file", 2, 3, 8, async (_url, options) => {
    requested = options.headers.Range;
    options.signal.addEventListener("abort", () => { aborted = true; });
    return new Response(new Uint8Array([2, 3, 4]), { status: 206, headers: { "Content-Range": "bytes 2-4/8", "Content-Length": "3" } });
  });
  assert.equal(requested, "bytes=2-4"); assert.deepEqual([...bytes], [2, 3, 4]); assert.equal(aborted, true);
  await assert.rejects(readExactResourceRange("memory://file", 0, 3, 500_000_000, async () => ({ status: 200, headers: new Headers(), get body() { read = true; throw new Error("whole file read"); } })), /no whole-file fallback/);
  assert.equal(read, false);
});

test("mobile rejects malformed, compressed, oversized, short and unstreamable range responses", async () => {
  const read = response => readExactResourceRange("memory://file", 0, 3, 8, async () => response);
  await assert.rejects(read(new Response(new Uint8Array(3), { status: 206, headers: { "Content-Range": "bytes 0-2/*" } })), /exact attachment byte ranges/);
  await assert.rejects(read(new Response(new Uint8Array(3), { status: 206, headers: { "Content-Range": "bytes 0-2/8", "Content-Encoding": "gzip" } })), /unencoded/);
  await assert.rejects(read(new Response(new Uint8Array(4), { status: 206, headers: { "Content-Range": "bytes 0-2/8" } })), /exceeded/);
  await assert.rejects(read(new Response(new Uint8Array(2), { status: 206, headers: { "Content-Range": "bytes 0-2/8" } })), /ended before/);
  await assert.rejects(read({ status: 206, headers: new Headers({ "Content-Range": "bytes 0-2/8" }), body: null }), /bounded/);
  await assert.rejects(readExactResourceRange("memory://file", 0, 8 * 1024 * 1024 + 1, 500_000_000, async () => { throw new Error("should not fetch"); }), /Invalid bounded/);
});

test("verified replacement retains ordinary path, uses configured trash and installs recorded mtime", async () => {
  const f = fixture({ "Inbox/audio.unusual": "old" });
  const before = await f.store.stat("Inbox/audio.unusual");
  const id = await stage(f.store, before.path, "new recording");
  assert.equal(await f.store.applyStage(id, before.path, before, 500), true);
  assert.equal(new TextDecoder().decode(f.entries.get(before.path).bytes), "new recording");
  assert.equal((await f.store.stat(before.path)).mtime, 500);
  assert.equal(f.events[0][0], "local-trash");
  assert.equal([...f.entries].some(([path, entry]) => path.startsWith(".trash/") && new TextDecoder().decode(entry.bytes) === "old"), true);
  assert.deepEqual(Object.keys(f.journal.stages), []);
});

test("guarded replacement preserves edits, corrupted staging and case-colliding targets", async () => {
  const f = fixture({ "Inbox/a.png": "old" });
  const before = await f.store.stat("Inbox/a.png");
  const id = await stage(f.store, before.path, "replacement");
  f.set(before.path, "edited by user");
  assert.equal(await f.store.applyStage(id, before.path, before, 500), false);
  assert.equal(f.events.length, 0);
  const corrupt = fixture({ "a.png": "old" });
  const current = await corrupt.store.stat("a.png");
  const corruptId = await stage(corrupt.store, "a.png", "replacement");
  corrupt.set(`.tps/attachment-sync/staging.nosync/${corruptId}.part`, "corruptdata");
  await assert.rejects(corrupt.store.applyStage(corruptId, "a.png", current, 500), /hash/);
  assert.equal(corrupt.events.length, 0);
  const collision = fixture({ "Inbox/Photo.png": "user" });
  const collisionId = await stage(collision.store, "Inbox/photo.png", "remote");
  await assert.rejects(collision.store.applyStage(collisionId, "Inbox/photo.png", null, 500), /collides/);
  assert.equal(collision.events.length, 0);
});

test("a crash between trash and promotion recovers without a second trash or deleting a user edit", async () => {
  const f = fixture({ "a.png": "old" });
  const before = await f.store.stat("a.png");
  const id = await stage(f.store, "a.png", "new");
  const rename = f.adapter.rename;
  f.adapter.rename = async () => { throw new Error("simulated process stop"); };
  await assert.rejects(f.store.applyStage(id, "a.png", before, 500), /process stop/);
  assert.equal(await f.store.stat("a.png"), null);
  f.adapter.rename = rename;
  await f.reopen().recover();
  assert.equal(new TextDecoder().decode(f.entries.get("a.png").bytes), "new");
  assert.equal(f.events.filter(event => event[0] === "local-trash").length, 1);
  const changed = fixture({ "a.png": "old" });
  const changedId = await stage(changed.store, "a.png", "new");
  changed.adapter.rename = async () => { throw new Error("stop"); };
  await assert.rejects(changed.store.applyStage(changedId, "a.png", await changed.store.stat("a.png"), 500));
  changed.set("a.png", "new external edit");
  await changed.reopen().recover();
  assert.equal(new TextDecoder().decode(changed.entries.get("a.png").bytes), "new external edit");
  assert.equal(changed.journal.stages[changedId].phase, "downloading");
});

test("staging resumes at persisted bytes and supports collision-safe legacy retarget/seal", async () => {
  const f = fixture({ "source.png": "keep existing" });
  const id = await f.store.createStage("source.png", revision("new data"));
  await f.store.appendStage(id, new TextEncoder().encode("new "));
  const resumed = f.reopen();
  assert.equal(await resumed.createStage("source.png", revision("new data")), id);
  assert.equal(await resumed.stageSize(id), 4);
  assert.equal(new TextDecoder().decode(await resumed.readStageChunk(id, 0, 4)), "new ");
  await resumed.appendStage(id, new TextEncoder().encode("data"));
  await resumed.retargetStage(id, "restored.png");
  await resumed.sealStage(id, revision("new data"));
  assert.equal(await resumed.applyStage(id, "restored.png", null, 500), true);
  assert.equal(new TextDecoder().decode(f.entries.get("source.png").bytes), "keep existing");
  assert.equal(new TextDecoder().decode(f.entries.get("restored.png").bytes), "new data");
});

test("unknown extension deletes use system/local/none preference and fail closed when preference unavailable", async () => {
  for (const mode of ["system", "local", "none", undefined]) {
    const f = fixture({ "a.opaque": "a" });
    f.app.vault.getConfig = () => mode;
    if (mode === undefined) {
      await assert.rejects(f.store.remove("a.opaque", await f.store.stat("a.opaque")), /trash behavior/);
      assert.equal(f.entries.has("a.opaque"), true);
    } else {
      assert.equal(await f.store.remove("a.opaque", await f.store.stat("a.opaque")), true);
      assert.equal(f.entries.has("a.opaque"), false);
      assert.deepEqual(f.events.map(event => event[0]), mode === "system" ? ["system-trash", "local-trash"] : mode === "none" ? ["remove"] : ["local-trash"]);
    }
  }
});

test("adapter append failures and missing appendBinary preserve the original file", async () => {
  const f = fixture({ "a.png": "old" });
  const id = await f.store.createStage("a.png", revision("new"));
  f.adapter.appendBinary = undefined;
  await assert.rejects(f.store.appendStage(id, new Uint8Array([1])), /1.12.3/);
  assert.equal(new TextDecoder().decode(f.entries.get("a.png").bytes), "old");
});

test("pause during staging verification prevents trash and pause after trash preserves a recoverable promotion", async () => {
  const f = fixture({ "a.png": "old" });
  const id = await stage(f.store, "a.png", "new");
  let paused = false;
  f.options.checkCurrent = () => { if (paused) throw new Error("sync paused"); };
  f.options.createHasher = () => {
    const hasher = createHasher();
    return { update: hasher.update, digestHex: async () => { const digest = await hasher.digestHex(); paused = true; return digest; } };
  };
  await assert.rejects(f.store.applyStage(id, "a.png", await f.store.stat("a.png"), 500), /paused/);
  assert.equal(f.events.length, 0);
  assert.equal(new TextDecoder().decode(f.entries.get("a.png").bytes), "old");

  const interrupted = fixture({ "a.png": "old" });
  const transfer = await stage(interrupted.store, "a.png", "new");
  paused = false;
  interrupted.options.checkCurrent = f.options.checkCurrent;
  const trash = interrupted.adapter.trashLocal;
  interrupted.adapter.trashLocal = async path => { await trash(path); paused = true; };
  await assert.rejects(interrupted.store.applyStage(transfer, "a.png", await interrupted.store.stat("a.png"), 500), /paused/);
  assert.equal(interrupted.events.filter(event => event[0] === "rename").length, 0);
  assert.equal(interrupted.journal.stages[transfer].phase, "trashing");
  paused = false;
  await interrupted.reopen().recover();
  assert.equal(new TextDecoder().decode(interrupted.entries.get("a.png").bytes), "new");
});

test("new exclusions pause retained staging and deletion journals without blocking unrelated files", async () => {
  const f = fixture({ "excluded.png": "old", "ordinary.png": "ordinary" });
  const id = await stage(f.store, "excluded.png", "replacement");
  const oldTrash = f.adapter.trashLocal;
  f.adapter.trashLocal = async () => { throw new Error("trash unavailable"); };
  await assert.rejects(f.store.remove("excluded.png", await f.store.stat("excluded.png")), /unavailable/);
  f.adapter.trashLocal = oldTrash;
  f.options.excludedPaths = () => ["excluded.png"];
  await f.reopen().recover();
  assert.deepEqual((await f.store.scan()).files.map(file => file.path), ["ordinary.png"]);
  assert.ok(f.journal.stages[id]);
  assert.ok(f.journal.deletes["excluded.png"]);
  assert.equal(new TextDecoder().decode(f.entries.get("excluded.png").bytes), "old");
  await assert.rejects(f.store.appendStage(id, new Uint8Array()), /excluded/);
  f.options.excludedPaths = () => [];
  await f.reopen().recover();
  assert.equal(f.entries.has("excluded.png"), false);
  assert.deepEqual(Object.keys(f.journal.deletes), []);
});

test("extensionless object-like names retain their durable deletion intent through structured cloning", async () => {
  const f = fixture();
  f.set("__proto__", "attachment bytes");
  const trash = f.adapter.trashLocal;
  f.adapter.trashLocal = async () => { throw new Error("interrupted trash"); };
  await assert.rejects(f.store.remove("__proto__", await f.store.stat("__proto__")), /interrupted/);
  assert.equal(Object.hasOwn(f.journal.deletes, "__proto__"), true);
  f.adapter.trashLocal = trash;
  await f.reopen().recover();
  assert.equal(f.entries.has("__proto__"), false);
});

function fakeIndexedDB() {
  const values = new Map();
  let initialized = false;
  const factory = {
    failWrite: false,
    open() {
      const request = {};
      queueMicrotask(() => {
        request.result = {
          objectStoreNames: { contains: () => initialized }, createObjectStore: () => { initialized = true; }, close() {},
          transaction(_name, mode, options) {
            const transaction = { durability: options?.durability || "default", abort() {} };
            transaction.objectStore = () => ({
              get(key) {
                const read = {};
                queueMicrotask(() => { read.result = structuredClone(values.get(JSON.stringify(key))); read.onsuccess?.(); transaction.oncomplete?.(); });
                return read;
              },
              put(value, key) {
                queueMicrotask(() => {
                  if (factory.failWrite) { factory.failWrite = false; transaction.onabort?.(); return; }
                  values.set(JSON.stringify(key), structuredClone(value)); transaction.oncomplete?.();
                });
              },
            });
            return transaction;
          },
        };
        if (!initialized) request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  };
  return factory;
}

function emptyState() { return { version: 1, collectionId: "collection", deviceId: "device", enrolled: true, lastCatalogSequence: 0, clock: { time: 0, counter: 0 }, baseline: {}, pending: {}, applying: {} }; }

test("device state and enrollment are isolated by actual local path AND remote identity", async () => {
  const factory = fakeIndexedDB();
  const adapter = base => ({ getFullPath: () => base, getResourcePath: () => "memory://same-display-name" });
  const first = new AttachmentDeviceStateStore(adapter("/device/one/Same name"), "remote", "collection", factory);
  const otherPath = new AttachmentDeviceStateStore(adapter("/device/two/Same name"), "remote", "collection", factory);
  const otherRemote = new AttachmentDeviceStateStore(adapter("/device/one/Same name"), "different", "collection", factory);
  await first.save(emptyState());
  await first.setPreference("participation", true);
  assert.equal((await first.load()).deviceId, "device");
  assert.equal(await first.getPreference("participation"), true);
  assert.equal(await otherPath.load(), null);
  assert.equal(await otherRemote.load(), null);
  assert.equal(await otherPath.getPreference("participation"), null);
  factory.failWrite = true;
  await assert.rejects(first.save({ ...emptyState(), deviceId: "changed" }), /could not be saved/);
  assert.equal((await first.load()).deviceId, "device");
});

test("missing IndexedDB, unusable vault identity and corrupt baselines fail closed", async () => {
  const f = fixture();
  const unavailable = new AttachmentDeviceStateStore(f.adapter, "remote", "collection", null);
  await assert.rejects(unavailable.load(), /IndexedDB/);
  assert.throws(() => localVaultIdentity({ getResourcePath: () => "app://obsidian.md/" }), /identify/);
  assert.equal(localVaultIdentity({ getResourcePath: () => "capacitor://local/vault-a/?mtime=123" }), "resource:capacitor://local/vault-a");
  assert.throws(() => validateDeviceState({ ...emptyState(), collectionId: "other" }, "collection"), /corrupt/);
  assert.throws(() => validateDeviceState({ ...emptyState(), baseline: { "../outside.png": {} } }, "collection"), /corrupt/);
  assert.throws(() => validateDeviceState({ ...emptyState(), applying: { "a.png": { expected: null, record: { path: "a.png", deleted: false } } } }, "collection"), /corrupt/);
});

test("desktop reads bounded chunks and refuses symlinks before following them outside its vault", async () => {
  const cache = fileURLToPath(new URL("../../../.plugin-dev-cache.nosync/tps-controller", import.meta.url));
  await fs.mkdir(cache, { recursive: true });
  const fixtureRoot = await fs.mkdtemp(path.join(cache, "attachment-local-qa-"));
  const base = path.join(fixtureRoot, "vault");
  try {
    await fs.mkdir(base);
    await fs.writeFile(path.join(base, "media.bin"), new Uint8Array([1, 2, 3, 4, 5, 6]));
    await fs.writeFile(path.join(fixtureRoot, "outside.bin"), new Uint8Array([99]));
    const memory = fixture();
    memory.adapter.getBasePath = () => base;
    memory.adapter.stat = async relative => {
      try { const value = await fs.stat(path.join(base, relative)); return { type: value.isDirectory() ? "folder" : "file", size: value.size, mtime: value.mtimeMs, ctime: value.ctimeMs }; }
      catch (error) { if (error.code === "ENOENT") return null; throw error; }
    };
    memory.adapter.list = async relative => {
      const contents = await fs.readdir(path.join(base, relative), { withFileTypes: true });
      return { files: contents.filter(item => !item.isDirectory()).map(item => relative ? `${relative}/${item.name}` : item.name), folders: contents.filter(item => item.isDirectory()).map(item => relative ? `${relative}/${item.name}` : item.name) };
    };
    memory.options.isDesktop = true;
    const store = memory.reopen();
    assert.deepEqual([...await store.readChunk("media.bin", 2, 3)], [3, 4, 5]);
    await fs.symlink(path.join(fixtureRoot, "outside.bin"), path.join(base, "linked.bin"));
    await assert.rejects(store.readChunk("linked.bin", 0, 1), /symlinks/);
    await assert.rejects(store.scan(), /symlinks/);
    assert.deepEqual([...await fs.readFile(path.join(fixtureRoot, "outside.bin"))], [99]);
  } finally { await fs.rm(fixtureRoot, { recursive: true, force: true }); }
});
