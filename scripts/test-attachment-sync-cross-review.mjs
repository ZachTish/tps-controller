import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
async function load(name) {
  const result = await build({ entryPoints: [fileURLToPath(new URL(`../src/services/attachment-sync/${name}.ts`, import.meta.url))], bundle: true, write: false, platform: "node", format: "cjs" });
  const module = { exports: {} };
  new Function("require", "module", "exports", result.outputFiles[0].text)(require, module, module.exports);
  return module.exports;
}
const { AttachmentSyncEngine } = await load("engine");
const { ObsidianAttachmentLocalStore } = await load("local-files");
const encode = value => typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
const sha256 = value => createHash("sha256").update(value).digest("hex");
const copy = value => value === null ? null : structuredClone(value);
const createHasher = () => {
  const hash = createHash("sha256");
  return { update: bytes => { hash.update(bytes); }, digestHex: async () => hash.digest("hex") };
};

class Remote {
  catalog = null; generation = 0; chunks = new Map(); beforeDelete = null;
  async getCatalog() { return this.catalog ? { catalog: copy(this.catalog), generation: String(this.generation) } : null; }
  async compareAndSwapCatalog(generation, catalog) {
    if (generation !== (this.catalog ? String(this.generation) : null)) return null;
    this.catalog = copy(catalog); this.generation += 1;
    return this.getCatalog();
  }
  async putChunk(id, index, bytes, hash) {
    assert.equal(sha256(bytes), hash);
    const key = `${id}/${index}`;
    if (this.chunks.has(key)) assert.deepEqual(bytes, this.chunks.get(key));
    this.chunks.set(key, bytes.slice());
  }
  async getChunk(id, index) {
    const bytes = this.chunks.get(`${id}/${index}`);
    if (!bytes) throw new Error("missing remote chunk");
    return bytes.slice();
  }
  async deleteRevision(id, count) {
    if (this.beforeDelete) await this.beforeDelete(id, count);
    for (let index = 0; index < count; index += 1) this.chunks.delete(`${id}/${index}`);
  }
}

function device(remote, name, clock) {
  let next = 0, stateValue = null, journal = null;
  const entries = new Map([["", { type: "folder", size: 0, mtime: 0 }]]);
  const excludes = [], trash = [], mutations = [];
  const parent = path => path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  const directory = path => {
    if (entries.has(path)) return;
    directory(parent(path)); entries.set(path, { type: "folder", size: 0, mtime: clock.time });
  };
  const write = (path, data, mtime = clock.time) => {
    directory(parent(path)); const bytes = encode(data);
    entries.set(path, { type: "file", bytes, size: bytes.length, mtime });
  };
  const adapter = {
    getResourcePath: path => `memory:///${encodeURIComponent(path)}`,
    stat: async path => { const entry = entries.get(path); return entry ? { type: entry.type, size: entry.size, mtime: entry.mtime } : null; },
    exists: async path => entries.has(path),
    list: async path => {
      const files = [], folders = [];
      for (const [key, entry] of entries) if (key && parent(key) === path) (entry.type === "file" ? files : folders).push(key);
      return { files, folders };
    },
    mkdir: async path => directory(path),
    writeBinary: async (path, bytes) => write(path, bytes),
    appendBinary: async (path, bytes, options) => {
      const old = entries.get(path).bytes, added = new Uint8Array(bytes), next = new Uint8Array(old.length + added.length);
      next.set(old); next.set(added, old.length); write(path, next, options?.mtime ?? clock.time);
    },
    remove: async path => { entries.delete(path); mutations.push(["remove", path]); },
    rename: async (from, to) => {
      if (!entries.has(from) || entries.has(to)) throw new Error("unsafe fake rename");
      entries.set(to, entries.get(from)); entries.delete(from); mutations.push(["rename", to]);
    },
    trashLocal: async path => { trash.push({ path, ...entries.get(path) }); entries.delete(path); mutations.push(["trash", path]); },
    trashSystem: async () => false,
  };
  const app = { vault: { adapter, getAbstractFileByPath: () => null, getConfig: () => "local" }, fileManager: {} };
  const state = {
    load: async () => copy(stateValue), save: async value => { stateValue = copy(value); },
    getJournal: async () => copy(journal), saveJournal: async value => { journal = copy(value); },
  };
  const local = new ObsidianAttachmentLocalStore(app, state, {
    isDesktop: false, excludedPaths: () => excludes, randomId: () => `${name}stage${String(++next).padStart(8, "0")}`, createHasher,
    fetch: async (url, options) => {
      const entry = entries.get(decodeURIComponent(url.slice("memory:///".length)));
      const [, first, last] = /^bytes=(\d+)-(\d+)$/.exec(options.headers.Range);
      return new Response(entry.bytes.slice(Number(first), Number(last) + 1), { status: 206, headers: { "Content-Range": `bytes ${first}-${last}/${entry.size}`, "Content-Length": String(Number(last) - Number(first) + 1) } });
    },
  });
  const options = { collectionId: "cross-review", allowCreateCatalog: true, now: () => clock.time, randomId: () => `${name}-${++next}`, createHasher };
  const result = { local, state, write, entries, excludes, trash, mutations, adapter, engine: new AttachmentSyncEngine(remote, local, state, options), get value() { return stateValue; }, get journal() { return journal; } };
  result.restart = () => { result.engine = new AttachmentSyncEngine(remote, local, state, options); };
  return result;
}

test("real local store first enrollment honors a newer tombstone and later recreation still converges", async () => {
  const remote = new Remote(), clock = { time: 1000 }, a = device(remote, "a", clock);
  a.write("Inbox/video.mp4", "original"); await a.engine.run();
  clock.time = 3000; a.entries.delete("Inbox/video.mp4"); await a.engine.run();
  const b = device(remote, "b", clock); b.write("Inbox/video.mp4", "older offline copy", 1000);
  await b.engine.run(); await b.engine.run();
  assert.equal(b.entries.has("Inbox/video.mp4"), false);
  assert.equal(remote.catalog.records["Inbox/video.mp4"].deleted, true);
  assert.equal(Object.keys(b.value.pending).length, 0);
  clock.time = 5000; b.write("Inbox/video.mp4", "deliberate recreation"); await b.engine.run(); await a.engine.run();
  assert.equal(new TextDecoder().decode(a.entries.get("Inbox/video.mp4").bytes), "deliberate recreation");
});

test("excluding an interrupted local download preserves its journal while unrelated sync continues", async () => {
  const remote = new Remote(), clock = { time: 1000 }, a = device(remote, "a", clock), b = device(remote, "b", clock);
  a.write("Media/video.mp4", "video"); a.write("Inbox/audio.wav", "audio"); await a.engine.run();
  const revision = remote.catalog.records["Media/video.mp4"].revision;
  const stage = await b.local.createStage("Media/video.mp4", revision);
  await b.local.appendStage(stage, encode("video")); b.excludes.push("Media");
  await b.engine.run();
  assert.ok(b.journal.stages[stage], "excluded download is retained for resumption");
  assert.equal(b.entries.has("Media/video.mp4"), false);
  assert.equal(new TextDecoder().decode(b.entries.get("Inbox/audio.wav").bytes), "audio");
  b.excludes.length = 0; await b.engine.run();
  assert.equal(new TextDecoder().decode(b.entries.get("Media/video.mp4").bytes), "video");
  assert.equal(b.journal.stages[stage], undefined);
});

test("excluding a pending engine application preserves its intent and avoids reading the excluded file", async () => {
  const remote = new Remote(), clock = { time: 1000 }, a = device(remote, "a", clock), b = device(remote, "b", clock);
  a.write("Media/video.mp4", "video"); await a.engine.run(); await b.engine.run();
  const application = { record: copy(remote.catalog.records["Media/video.mp4"]), expected: null };
  b.value.applying["Media/video.mp4"] = application; b.excludes.push("Media"); b.restart();
  clock.time = 2000; a.write("Inbox/audio.wav", "audio"); await a.engine.run();
  await b.engine.run();
  assert.deepEqual(b.value.applying["Media/video.mp4"], application);
  assert.equal(new TextDecoder().decode(b.entries.get("Inbox/audio.wav").bytes), "audio");
  b.excludes.length = 0; await b.engine.run();
  assert.equal(b.value.applying["Media/video.mp4"], undefined);
});

test("crash after local trash resumes verified promotion and converges to a newer cloud revision", async () => {
  const remote = new Remote(), clock = { time: 1000 }, a = device(remote, "a", clock), b = device(remote, "b", clock);
  a.write("Media/video.mp4", "old"); await a.engine.run(); await b.engine.run();
  clock.time = 2000; a.write("Media/video.mp4", "middle"); await a.engine.run();
  const rename = b.adapter.rename; b.adapter.rename = async () => { throw new Error("simulated power loss before rename"); };
  await assert.rejects(b.engine.run(), /simulated power loss/);
  assert.equal(b.entries.has("Media/video.mp4"), false);
  assert.ok(b.value.applying["Media/video.mp4"]);
  assert.equal(b.trash.length, 1);
  clock.time = 3000; a.write("Media/video.mp4", "newest"); await a.engine.run();
  b.adapter.rename = rename; b.restart(); await b.engine.run();
  assert.equal(new TextDecoder().decode(b.entries.get("Media/video.mp4").bytes), "newest");
  assert.equal(b.value.applying["Media/video.mp4"], undefined);
  assert.equal(Object.keys(b.journal.stages).length, 0);
});

test("concurrent garbage collection and publication never remove the winning revision", async () => {
  const remote = new Remote(), clock = { time: 1000 }, a = device(remote, "a", clock), b = device(remote, "b", clock);
  a.write("Media/video.mp4", "old"); await a.engine.run(); await b.engine.run();
  remote.beforeDelete = async () => {
    remote.beforeDelete = null; clock.time = 3000;
    b.write("Media/video.mp4", "concurrent winner"); await b.engine.run();
  };
  clock.time = 2000; a.write("Media/video.mp4", "middle"); await a.engine.run(); await a.engine.run();
  const record = remote.catalog.records["Media/video.mp4"];
  assert.equal(record.deleted, false);
  assert.equal(new TextDecoder().decode(await remote.getChunk(record.revision.id, 0)), "concurrent winner");
  assert.equal(new TextDecoder().decode(a.entries.get("Media/video.mp4").bytes), "concurrent winner");
  assert.equal(Object.keys(remote.catalog.garbage).length, 0);
});

test("superseded interrupted downloads release obsolete local staging bytes", async () => {
  const remote = new Remote(), clock = { time: 1000 }, a = device(remote, "a", clock), b = device(remote, "b", clock);
  a.write("Media/video.mp4", "old large download"); await a.engine.run();
  const oldRevision = remote.catalog.records["Media/video.mp4"].revision;
  const abandoned = await b.local.createStage("Media/video.mp4", oldRevision);
  await b.local.appendStage(abandoned, encode("old large download"));
  clock.time = 3000; a.write("Media/video.mp4", "new large download"); await a.engine.run();
  b.restart(); await b.engine.run();
  assert.equal(new TextDecoder().decode(b.entries.get("Media/video.mp4").bytes), "new large download");
  assert.equal(b.journal.stages[abandoned], undefined, "retired revisions must not retain potentially hundreds of MB forever");
  assert.equal([...b.entries.keys()].filter(path => path.endsWith(".part")).length, 0);
});

test("local edit during asynchronous pre-trash collision checks remains the live winning file", async () => {
  const remote = new Remote(), clock = { time: 1000 }, a = device(remote, "a", clock), b = device(remote, "b", clock);
  a.write("Media/video.mp4", "old"); await a.engine.run(); await b.engine.run();
  clock.time = 2000; a.write("Media/video.mp4", "remote edit"); await a.engine.run();
  let edited = false; const list = b.adapter.list;
  b.adapter.list = async path => {
    if (!edited && Object.values(b.journal?.stages || {}).some(stage => stage.phase === "trashing")) {
      edited = true; clock.time = 3000; b.write("Media/video.mp4", "newest local edit");
    }
    return list(path);
  };
  await b.engine.run();
  assert.equal(edited, true);
  assert.equal(new TextDecoder().decode(b.entries.get("Media/video.mp4").bytes), "newest local edit");
  assert.equal(b.trash.length, 0, "new local edit must never be trashed by the older cloud revision");
  await b.engine.run();
  const record = remote.catalog.records["Media/video.mp4"];
  assert.equal(new TextDecoder().decode(await remote.getChunk(record.revision.id, 0)), "newest local edit");
});

test("local edit during a tombstone's pre-trash checks survives and replaces the older deletion", async () => {
  const remote = new Remote(), clock = { time: 1000 }, a = device(remote, "a", clock), b = device(remote, "b", clock);
  a.write("Media/video.mp4", "old"); await a.engine.run(); await b.engine.run();
  clock.time = 2000; a.entries.delete("Media/video.mp4"); await a.engine.run();
  let edited = false; const list = b.adapter.list;
  b.adapter.list = async path => {
    if (!edited && b.journal?.deletes["Media/video.mp4"]) {
      edited = true; clock.time = 3000; b.write("Media/video.mp4", "newest local edit");
    }
    return list(path);
  };
  await b.engine.run();
  assert.equal(edited, true);
  assert.equal(new TextDecoder().decode(b.entries.get("Media/video.mp4").bytes), "newest local edit");
  assert.equal(b.trash.length, 0);
  await b.engine.run();
  const record = remote.catalog.records["Media/video.mp4"];
  assert.equal(record.deleted, false);
  assert.equal(new TextDecoder().decode(await remote.getChunk(record.revision.id, 0)), "newest local edit");
});
