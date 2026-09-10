import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import vm from "node:vm";
import ts from "typescript";

const cache = new Map();
function loadModule(name) {
    if (cache.has(name)) return cache.get(name);
    const source = readFileSync(new URL(`../src/services/attachment-sync/${name}.ts`, import.meta.url), "utf8");
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
    const module = { exports: {} };
    vm.runInNewContext(compiled, { module, exports: module.exports, require: (path) => loadModule(path.replace("./", "")), Uint8Array, Set, Map, Date, Error, Object, JSON, Number, Math, Promise }, { filename: `${name}.ts` });
    cache.set(name, module.exports);
    return module.exports;
}
const { AttachmentSyncEngine } = loadModule("engine");
const { ATTACHMENT_CHUNK_BYTES, sameFile, compareChanges } = loadModule("model");
const copy = (value) => JSON.parse(JSON.stringify(value));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const bytes = (value) => typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
const combine = (chunks) => new Uint8Array(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));

class FakeRemote {
    catalog = null;
    generation = 0;
    chunks = new Map();
    putCalls = [];
    getCalls = [];
    deleteCalls = [];
    beforeCas = null;
    beforePut = null;
    beforeGet = null;
    deleteFailure = null;
    catalogFailure = null;
    async getCatalog() {
        if (this.catalogFailure) throw this.catalogFailure;
        return this.catalog ? { catalog: copy(this.catalog), generation: String(this.generation) } : null;
    }
    async compareAndSwapCatalog(expected, catalog) {
        if (this.beforeCas) await this.beforeCas(expected, catalog);
        if (expected !== (this.catalog ? String(this.generation) : null)) return null;
        this.catalog = copy(catalog);
        this.generation += 1;
        return this.getCatalog();
    }
    async putChunk(revision, index, content, sha256) {
        this.putCalls.push({ revision, index, size: content.byteLength });
        if (this.beforePut) await this.beforePut(revision, index, content);
        assert.equal(digest(content), sha256);
        const key = `${revision}/${index}`;
        if (this.chunks.has(key)) assert.deepEqual(this.chunks.get(key), content, "immutable chunks may only be retried with identical bytes");
        else this.chunks.set(key, new Uint8Array(content));
    }
    async getChunk(revision, index) {
        this.getCalls.push({ revision, index });
        if (this.beforeGet) await this.beforeGet(revision, index);
        const value = this.chunks.get(`${revision}/${index}`);
        if (!value) throw new Error("404 chunk");
        return new Uint8Array(value);
    }
    async deleteRevision(revision, count) {
        this.deleteCalls.push({ revision, count });
        if (this.deleteFailure) throw this.deleteFailure;
        for (let index = 0; index < count; index += 1) this.chunks.delete(`${revision}/${index}`);
    }
    publish(path, content, time, device = "other") {
        const value = bytes(content);
        const revision = `remote-${device}-${time}`;
        const chunks = [];
        for (let offset = 0, index = 0; offset < value.length; offset += ATTACHMENT_CHUNK_BYTES, index += 1) {
            const chunk = value.slice(offset, offset + ATTACHMENT_CHUNK_BYTES);
            this.chunks.set(`${revision}/${index}`, chunk);
            chunks.push({ index, size: chunk.length, sha256: digest(chunk) });
        }
        this.catalog.records[path] = {
            path, deleted: false, change: { time, counter: 0, deviceId: device, operationId: revision },
            revision: { id: revision, size: value.length, mtime: time, sha256: digest(value), chunks },
        };
        this.catalog.sequence += 1;
        this.generation += 1;
    }
}

class FakeLocal {
    files = new Map();
    stages = new Map();
    trash = [];
    reads = [];
    complete = true;
    beforeRead = null;
    beforeApply = null;
    afterApply = null;
    recoverCount = 0;
    write(path, content, mtime) { this.files.set(path, { content: bytes(content), mtime }); }
    text(path) { return new TextDecoder().decode(this.files.get(path)?.content); }
    isEligible(path) { return !path.split("/").some((part) => part.startsWith(".")) && !/\.(md|canvas|base)$/iu.test(path); }
    async stat(path) {
        const file = this.files.get(path);
        return file ? { path, size: file.content.length, mtime: file.mtime } : null;
    }
    async scan() { return { files: await Promise.all([...this.files.keys()].filter((path) => this.isEligible(path)).map((path) => this.stat(path))), complete: this.complete }; }
    async readChunk(path, offset, length) {
        this.reads.push({ path, offset, length });
        assert.ok(length <= ATTACHMENT_CHUNK_BYTES);
        if (this.beforeRead) await this.beforeRead(path, offset, length);
        return this.files.get(path).content.slice(offset, offset + length);
    }
    async createStage(path, revision) {
        const id = `stage-${revision.id}`;
        if (!this.stages.has(id)) this.stages.set(id, { path, chunks: [] });
        return id;
    }
    async appendStage(id, value) { this.stages.get(id).chunks.push(new Uint8Array(value)); }
    async stageSize(id) { return this.stages.get(id).chunks.reduce((sum, value) => sum + value.length, 0); }
    async readStageChunk(id, offset, length) { return combine(this.stages.get(id).chunks).slice(offset, offset + length); }
    async discardStage(id) { this.stages.delete(id); }
    async applyStage(id, path, expected, mtime) {
        if (this.beforeApply) await this.beforeApply(path);
        if (!sameFile(await this.stat(path), expected)) return false;
        if (this.files.has(path)) this.trash.push({ path, ...this.files.get(path) });
        this.files.set(path, { content: combine(this.stages.get(id).chunks), mtime });
        this.stages.delete(id);
        if (this.afterApply) await this.afterApply(path);
        return true;
    }
    async remove(path, expected) {
        if (!sameFile(await this.stat(path), expected)) return false;
        this.trash.push({ path, ...this.files.get(path) });
        this.files.delete(path);
        return true;
    }
    async recover() { this.recoverCount += 1; }
}

function device(remote, name, clock, local = new FakeLocal()) {
    let next = 0;
    const store = { value: null, failure: null, async load() { if (this.failure) throw this.failure; return this.value && copy(this.value); }, async save(value) { if (this.failure) throw this.failure; this.value = copy(value); } };
    const options = { collectionId: "test-collection", allowCreateCatalog: true, now: () => clock.time, randomId: () => `${name}-${++next}`, createHasher: () => { const value = createHash("sha256"); return { update(chunk) { value.update(chunk); }, async digestHex() { return value.digest("hex"); } }; } };
    return { local, store, options, engine: new AttachmentSyncEngine(remote, local, store, options), restart() { this.engine = new AttachmentSyncEngine(remote, local, store, options); } };
}

test("two devices preserve local copies and links while additions, edits, deletes, and empty files converge", async () => {
    const remote = new FakeRemote(); const clock = { time: 1000 };
    const a = device(remote, "a", clock); const b = device(remote, "b", clock);
    a.local.write("Inbox/image.png", "original", 1000);
    a.local.write("Inbox/empty.dat", "", 1000);
    a.local.write("Inbox/note.md", "![[image.png]]", 1000);
    await a.engine.run(); await b.engine.run();
    assert.equal(a.local.text("Inbox/image.png"), "original");
    assert.equal(b.local.text("Inbox/image.png"), "original");
    assert.equal(b.local.files.get("Inbox/empty.dat").content.length, 0);
    assert.equal(a.local.text("Inbox/note.md"), "![[image.png]]");
    assert.equal(remote.catalog.records["Inbox/note.md"], undefined);
    clock.time = 2000; b.local.write("Inbox/image.png", "edited", 2000);
    await b.engine.run(); await a.engine.run();
    assert.equal(a.local.text("Inbox/image.png"), "edited");
    assert.equal(a.local.trash.length, 1);
    clock.time = 3000; a.local.files.delete("Inbox/image.png");
    await a.engine.run(); await b.engine.run();
    assert.equal(b.local.files.has("Inbox/image.png"), false);
    assert.equal(remote.catalog.records["Inbox/image.png"].deleted, true);
    assert.equal(Object.keys(remote.catalog.garbage).length, 0);
    assert.equal([...remote.chunks.keys()].length, 0, "empty files require no payload chunks");
});

test("first enrollment downloads absent files instead of publishing deletions", async () => {
    const remote = new FakeRemote(); const clock = { time: 1000 };
    const a = device(remote, "a", clock); a.local.write("audio.wav", "audio", 1000);
    await a.engine.run();
    const b = device(remote, "b", clock); await b.engine.run();
    assert.equal(b.local.text("audio.wav"), "audio");
    assert.equal(remote.catalog.records["audio.wav"].deleted, false);
    b.store.value = null; b.restart(); await b.engine.run();
    assert.equal(remote.catalog.records["audio.wav"].deleted, false);
});

test("an older offline edit never gets a new winning timestamp on reconnect", async () => {
    const remote = new FakeRemote(); const clock = { time: 1000 };
    const a = device(remote, "a", clock); const b = device(remote, "b", clock);
    a.local.write("image.png", "base", 1000); await a.engine.run(); await b.engine.run();
    a.local.write("image.png", "older offline", 2000);
    clock.time = 4000; b.local.write("image.png", "newest", 4000); await b.engine.run();
    clock.time = 9000; await a.engine.run();
    assert.equal(a.local.text("image.png"), "newest");
    assert.equal(remote.catalog.records["image.png"].change.time, 4000);
    assert.equal(Object.keys(a.store.value.pending).length, 0);
    assert.equal(a.local.trash.length, 1);
});

test("latest delete wins older edits and a deliberate later recreation outranks its tombstone", async () => {
    const remote = new FakeRemote(); const clock = { time: 1000 };
    const a = device(remote, "a", clock); const b = device(remote, "b", clock);
    a.local.write("file.bin", "base", 1000); await a.engine.run(); await b.engine.run();
    b.local.write("file.bin", "older edit", 2000);
    clock.time = 3000; a.local.files.delete("file.bin"); await a.engine.run();
    clock.time = 4000; await b.engine.run();
    assert.equal(b.local.files.has("file.bin"), false);
    clock.time = 5000; b.local.write("file.bin", "recreated", 5000); await b.engine.run(); await a.engine.run();
    assert.equal(a.local.text("file.bin"), "recreated");
    assert.equal(remote.catalog.records["file.bin"].deleted, false);
});

test("CAS retries preserve the original operation stamp and resolve a competing newer winner", async () => {
    const remote = new FakeRemote(); const clock = { time: 1000 };
    const a = device(remote, "a", clock); await a.engine.run();
    a.local.write("file.bin", "candidate", 2000);
    let collided = false;
    remote.beforeCas = async (_expected, next) => {
        if (!collided && next.records["file.bin"] && !next.records["file.bin"].deleted) {
            collided = true; remote.publish("file.bin", "concurrent winner", 3000);
        }
    };
    await a.engine.run();
    assert.equal(collided, true);
    assert.equal(a.local.text("file.bin"), "concurrent winner");
    assert.equal(remote.catalog.records["file.bin"].change.time, 3000);
    assert.equal(Object.keys(remote.catalog.uploads).length, 0);
});

test("large files use bounded chunks and downloads resume from a verified complete prefix", async () => {
    const remote = new FakeRemote(); const clock = { time: 1000 };
    const a = device(remote, "a", clock); const b = device(remote, "b", clock);
    const content = new Uint8Array(ATTACHMENT_CHUNK_BYTES * 2 + 17); content.fill(45); content[content.length - 1] = 99;
    a.local.write("movie.mp4", content, 1000); await a.engine.run();
    assert.deepEqual(remote.putCalls.map((call) => call.size), [ATTACHMENT_CHUNK_BYTES, ATTACHMENT_CHUNK_BYTES, 17]);
    remote.beforeGet = async (_revision, index) => { if (index === 1) throw new Error("connection interrupted"); };
    await assert.rejects(b.engine.run(), /connection interrupted/u);
    assert.equal(b.local.files.has("movie.mp4"), false);
    remote.beforeGet = null; remote.getCalls = []; b.restart(); await b.engine.run();
    assert.deepEqual(remote.getCalls.map((call) => call.index), [1, 2]);
    assert.equal(digest(b.local.files.get("movie.mp4").content), digest(content));
    assert.ok(a.local.reads.every((read) => read.length <= ATTACHMENT_CHUNK_BYTES));
});

test("source mutation during upload retires the partial revision and never publishes torn bytes", async () => {
    const remote = new FakeRemote(); const clock = { time: 1000 };
    const a = device(remote, "a", clock);
    a.local.write("file.bin", new Uint8Array(ATTACHMENT_CHUNK_BYTES + 1), 1000);
    let mutated = false;
    remote.beforePut = async () => { if (!mutated) { mutated = true; a.local.write("file.bin", "replacement", 2000); } };
    await a.engine.run();
    assert.equal(remote.catalog.records["file.bin"], undefined);
    assert.equal(Object.keys(a.store.value.pending).length, 1);
    remote.beforePut = null; clock.time += 5 * 60_000; await a.engine.run();
    assert.equal(remote.catalog.records["file.bin"].revision.sha256, digest(bytes("replacement")));
    assert.equal(remote.chunks.size, 1);
});

test("a second bounded hash catches in-place edits that preserve size and modification time", async () => {
    const remote = new FakeRemote(); const clock = { time: 1000 };
    const a = device(remote, "a", clock); a.local.write("file.bin", "original", 1000);
    let changed = false;
    remote.beforePut = async () => { if (!changed) { changed = true; a.local.write("file.bin", "replaced", 1000); } };
    await a.engine.run();
    assert.equal(remote.catalog.records["file.bin"], undefined);
    remote.beforePut = null; clock.time += 5 * 60_000; await a.engine.run();
    assert.equal(remote.catalog.records["file.bin"].revision.sha256, digest(bytes("replaced")));
    assert.equal(remote.chunks.size, 1);
});

test("fractional filesystem timestamps remain valid fingerprints with integer logical stamps", async () => {
    const remote = new FakeRemote(); const clock = { time: 1000 };
    const a = device(remote, "a", clock); const b = device(remote, "b", clock);
    a.local.write("file.bin", "data", 1000.375); await a.engine.run(); await b.engine.run();
    assert.equal(remote.catalog.records["file.bin"].revision.mtime, 1000.375);
    assert.equal(remote.catalog.records["file.bin"].change.time, 1000);
    assert.equal(b.local.text("file.bin"), "data");
});

test("expired reservations are retired before cleanup and resumed upload allocates a fresh revision", async () => {
    const remote = new FakeRemote(); const clock = { time: 1000 };
    const a = device(remote, "a", clock); const b = device(remote, "b", clock);
    a.options.reservationLifetimeMs = 60_000; a.restart(); a.local.write("file.bin", "pending", 1000);
    remote.beforePut = async () => { throw new Error("offline"); };
    await assert.rejects(a.engine.run(), /offline/u);
    const retiredId = a.store.value.pending["file.bin"].revisionId;
    clock.time = 100_000; remote.beforePut = null; await b.engine.run();
    assert.equal(remote.deleteCalls.some((call) => call.revision === retiredId), false, "in-flight uploads get five minutes before the first sweep");
    clock.time += 5 * 60_000; await b.engine.run();
    assert.ok(remote.deleteCalls.some((call) => call.revision === retiredId));
    a.restart(); await a.engine.run();
    assert.notEqual(remote.catalog.records["file.bin"].revision.id, retiredId);
    assert.equal(remote.catalog.records["file.bin"].change.time, 1000);
});

test("retired upload markers remove late native PUTs on a daily retry without reviving content", async () => {
    const remote = new FakeRemote(); const clock = { time: 1000 };
    const a = device(remote, "a", clock); const b = device(remote, "b", clock);
    a.options.reservationLifetimeMs = 60_000; a.restart(); a.local.write("file.bin", "pending", 1000);
    remote.beforePut = async () => { throw new Error("offline"); };
    await assert.rejects(a.engine.run(), /offline/u);
    const oldId = a.store.value.pending["file.bin"].revisionId;
    remote.beforePut = null; clock.time = 100_000; await b.engine.run();
    clock.time += 5 * 60_000; await b.engine.run();
    const firstSweepAt = remote.catalog.garbage[oldId].lastCleanupAt;
    remote.chunks.set(`${oldId}/0`, bytes("pending")); // An already-issued native request finishes very late.
    clock.time += 60_000; await b.engine.run();
    assert.equal(remote.chunks.has(`${oldId}/0`), true);
    assert.equal(remote.catalog.garbage[oldId].lastCleanupAt, firstSweepAt);
    clock.time += 24 * 60 * 60_000; await b.engine.run();
    assert.equal(remote.chunks.has(`${oldId}/0`), false);
    assert.equal(remote.catalog.garbage[oldId].retiredUpload, true, "the small marker remains for eventual delayed-request cleanup");
    assert.equal(remote.catalog.records["file.bin"], undefined);
});

test("cleanup failure keeps its catalog obligation durable until a later successful run", async () => {
    const remote = new FakeRemote(); const clock = { time: 1000 };
    const a = device(remote, "a", clock); a.local.write("file.bin", "old", 1000); await a.engine.run();
    const old = remote.catalog.records["file.bin"].revision.id;
    a.local.write("file.bin", "new", 2000); remote.deleteFailure = new Error("delete denied");
    await assert.rejects(a.engine.run(), /delete denied/u);
    assert.equal(remote.catalog.garbage[old].revisionId, old);
    assert.equal(remote.catalog.records["file.bin"].revision.sha256, digest(bytes("new")));
    remote.deleteFailure = null; a.restart(); await a.engine.run();
    assert.equal(remote.catalog.garbage[old], undefined);
    assert.equal(remote.chunks.has(`${old}/0`), false);
});

test("incomplete scans, missing joined catalogs, corrupt local state, and cloud failure fail closed", async () => {
    const remote = new FakeRemote(); const clock = { time: 1000 };
    const a = device(remote, "a", clock); a.local.write("file.bin", "keep", 1000); await a.engine.run();
    const before = copy(remote.catalog);
    a.local.files.delete("file.bin"); a.local.complete = false;
    await assert.rejects(a.engine.run(), (error) => error.code === "incomplete-scan");
    assert.deepEqual(remote.catalog, before);
    a.local.complete = true; remote.catalog = null;
    await assert.rejects(a.engine.run(), (error) => error.code === "catalog-missing");
    assert.equal(remote.catalog, null);
    remote.catalog = before; a.store.value.baseline = [];
    await assert.rejects(a.engine.run(), (error) => error.code === "invalid-state");
    a.store.value.baseline = {}; remote.catalogFailure = new Error("decryption failed");
    await assert.rejects(a.engine.run(), /decryption failed/u);
    assert.deepEqual(remote.catalog, before);
});

test("corrupt or identity-invalid cloud records cannot trash local content", async () => {
    const remote = new FakeRemote(); const clock = { time: 1000 };
    const a = device(remote, "a", clock); const b = device(remote, "b", clock);
    a.local.write("file.bin", "original", 1000); await a.engine.run(); await b.engine.run();
    a.local.write("file.bin", "next", 2000); await a.engine.run();
    const revision = remote.catalog.records["file.bin"].revision;
    remote.chunks.set(`${revision.id}/0`, bytes("evil"));
    await assert.rejects(b.engine.run(), (error) => error.code === "chunk-integrity");
    assert.equal(b.local.text("file.bin"), "original"); assert.equal(b.local.trash.length, 0);
    remote.catalog.records["../escape.bin"] = { ...remote.catalog.records["file.bin"], path: "../escape.bin" };
    await assert.rejects(b.engine.run(), (error) => error.code === "invalid-catalog");
    assert.equal(b.local.trash.length, 0);
});

test("crash after local promotion is acknowledged by hash recovery without creating a new edit", async () => {
    const remote = new FakeRemote(); const clock = { time: 1000 };
    const a = device(remote, "a", clock); const b = device(remote, "b", clock);
    a.local.write("file.bin", "base", 1000); await a.engine.run(); await b.engine.run();
    a.local.write("file.bin", "next", 2000); await a.engine.run();
    b.local.afterApply = async () => { throw new Error("app terminated after rename"); };
    await assert.rejects(b.engine.run(), /app terminated/u);
    assert.ok(b.store.value.applying["file.bin"]);
    assert.equal(b.local.text("file.bin"), "next");
    const revisionId = remote.catalog.records["file.bin"].revision.id;
    b.local.afterApply = null; b.restart(); await b.engine.run();
    assert.equal(remote.catalog.records["file.bin"].revision.id, revisionId);
    assert.equal(b.store.value.applying["file.bin"], undefined);
    assert.equal(Object.keys(b.store.value.pending).length, 0);
});

test("a user edit during download wins when newer and is never hidden by path-based suppression", async () => {
    const remote = new FakeRemote(); const clock = { time: 1000 };
    const a = device(remote, "a", clock); const b = device(remote, "b", clock);
    a.local.write("file.bin", "base", 1000); await a.engine.run(); await b.engine.run();
    a.local.write("file.bin", "remote", 2000); await a.engine.run();
    remote.beforeGet = async () => { b.local.write("file.bin", "fresh local", 3000); };
    await b.engine.run(); assert.equal(b.local.text("file.bin"), "fresh local");
    assert.equal(b.local.trash.length, 0);
    remote.beforeGet = null; await b.engine.run(); await a.engine.run();
    assert.equal(a.local.text("file.bin"), "fresh local");
});

test("a user edit immediately after promotion is not acknowledged as downloaded content", async () => {
    const remote = new FakeRemote(); const clock = { time: 1000 };
    const a = device(remote, "a", clock); const b = device(remote, "b", clock);
    a.local.write("file.bin", "base", 1000); await a.engine.run(); await b.engine.run();
    a.local.write("file.bin", "remote", 2000); await a.engine.run();
    b.local.afterApply = async () => { b.local.write("file.bin", "edited", 3000); };
    await b.engine.run();
    assert.equal(b.local.text("file.bin"), "edited");
    assert.equal(b.store.value.baseline["file.bin"].file.mtime, 1000);
    b.local.afterApply = null; await b.engine.run(); await a.engine.run();
    assert.equal(a.local.text("file.bin"), "edited");
});

test("single-flight callers share a run and stop prevents a delayed upload from publishing", async () => {
    const remote = new FakeRemote(); const clock = { time: 1000 };
    const a = device(remote, "a", clock); a.local.write("file.bin", "bytes", 1000);
    let release; const wait = new Promise((resolve) => { release = resolve; });
    let entered; const ready = new Promise((resolve) => { entered = resolve; });
    remote.beforePut = async () => { entered(); await wait; };
    const first = a.engine.run(); const second = a.engine.run();
    assert.equal(first, second); await ready; a.engine.stop(); release();
    await assert.rejects(first, (error) => error.code === "cancelled");
    assert.equal(remote.catalog.records["file.bin"], undefined);
    assert.equal(Object.keys(remote.catalog.uploads).length, 1);
});

test("equal physical times use deterministic logical/device/operation ordering", () => {
    const left = { time: 1000, counter: 0, deviceId: "a", operationId: "1" };
    const right = { time: 1000, counter: 0, deviceId: "b", operationId: "1" };
    assert.ok(compareChanges(left, right) < 0);
    assert.ok(compareChanges({ ...left, counter: 1 }, right) > 0);
    assert.equal(compareChanges(left, copy(left)), 0);
});
