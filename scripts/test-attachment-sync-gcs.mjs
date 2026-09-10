import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto, createHash, createHmac } from "node:crypto";
const webCrypto = webcrypto;
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

async function moduleAt(relative) {
    const built = await build({ entryPoints: [fileURLToPath(new URL(relative, import.meta.url))], bundle: true,
        write: false, format: "esm", platform: "browser" });
    assert.equal(/\brequire\(["'](?:node:|fs|crypto)/.test(built.outputFiles[0].text), false);
    return import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`);
}
const remoteModule = await moduleAt("../src/services/attachment-sync/gcs-remote.ts");
const crypto = await moduleAt("../src/services/attachment-sync/crypto.ts");
const credentials = { accessKeyId: "GOOGTESTACCESS", secretAccessKey: "only-a-test-secret" };
const fixedTime = new Date("2026-09-10T12:34:56.000Z");
const arrayBuffer = (bytes = new Uint8Array()) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const catalog = () => ({ version: 1, collectionId: "collection-one", sequence: 0, records: {}, uploads: {}, garbage: {} });

function memoryGcs() {
    const objects = new Map();
    const requests = [];
    let nextGeneration = 10000000000000000n;
    const response = (status, headers = {}, bytes) => ({ status, headers, arrayBuffer: arrayBuffer(bytes) });
    return {
        objects, requests,
        async request(parameters) {
            requests.push(parameters);
            const key = new URL(parameters.url).pathname;
            const current = objects.get(key);
            const expected = parameters.headers["x-goog-if-generation-match"];
            if (parameters.method === "HEAD") return current ? response(200,
                { "Content-Length": String(current.bytes.length), "X-Goog-Generation": current.generation }) : response(404);
            if (parameters.method === "PUT") {
                if ((expected === "0" && current) || (expected !== "0" && current?.generation !== expected)) return response(412);
                const stored = { generation: String(nextGeneration++), bytes: new Uint8Array(parameters.body).slice() };
                objects.set(key, stored);
                return response(200, { "x-goog-generation": stored.generation });
            }
            if (parameters.method === "GET") {
                if (!current) return response(404);
                if (expected !== current.generation) return response(412);
                const [, first, last] = /^bytes=(\d+)-(\d+)$/.exec(parameters.headers.range);
                const bytes = current.bytes.slice(Number(first), Number(last) + 1);
                return response(206, { "content-range": `bytes ${first}-${last}/${current.bytes.length}`, "x-goog-generation": current.generation }, bytes);
            }
            if (parameters.method === "DELETE") {
                if (!current) return response(404);
                if (expected !== current.generation) return response(412);
                objects.delete(key);
                return response(204);
            }
            throw Error("unexpected test request");
        },
    };
}

async function fixture(overrides = {}) {
    const memory = memoryGcs();
    const encryption = await crypto.importRecoveryKey(crypto.generateRecoveryKey(webcrypto), webcrypto);
    const options = { endpoint: "https://storage.googleapis.com", bucket: "test-bucket", prefix: "attachments-sync",
        collectionId: "collection-one", credentials, crypto: encryption, request: memory.request,
        now: () => fixedTime, webCrypto, ...overrides };
    return { memory, encryption, options, remote: new remoteModule.GcsAttachmentRemote(options) };
}

test("SigV4 canonicalization signs GCS generation guards, encoded paths, sorted queries, and payload", async () => {
    const body = new TextEncoder().encode("abc");
    const signed = await remoteModule.signGcsRequest({
        url: "https://storage.googleapis.com/test-bucket/a%20b%2B%21?z=last&a=%2B&a=first&versioning",
        method: "PUT", headers: { "Content-Type": " application/octet-stream ", "x-goog-if-generation-match": "9007199254740993" },
        body, credentials, now: fixedTime, webCrypto,
    });
    const expectedCanonical = ["PUT", "/test-bucket/a%20b%2B%21", "a=%2B&a=first&versioning=&z=last",
        "content-type:application/octet-stream\nhost:storage.googleapis.com\nx-amz-content-sha256:" + hash(body)
            + "\nx-amz-date:20260910T123456Z\nx-goog-if-generation-match:9007199254740993\n",
        "content-type;host;x-amz-content-sha256;x-amz-date;x-goog-if-generation-match", hash(body)].join("\n");
    assert.equal(signed.canonicalRequest, expectedCanonical);
    const expectedString = ["AWS4-HMAC-SHA256", "20260910T123456Z", "20260910/auto/s3/aws4_request", hash(expectedCanonical)].join("\n");
    assert.equal(signed.stringToSign, expectedString);
    let key = Buffer.from("AWS4" + credentials.secretAccessKey);
    for (const value of ["20260910", "auto", "s3", "aws4_request"]) key = createHmac("sha256", key).update(value).digest();
    const signature = createHmac("sha256", key).update(expectedString).digest("hex");
    assert.ok(signed.headers.authorization.endsWith(`Signature=${signature}`));
    assert.equal(signed.headers.host, undefined);
    assert.equal(signed.headers["x-goog-if-generation-match"], "9007199254740993");
});

test("encrypted catalog CAS uses string generations and losing writers cannot overwrite", async () => {
    const { remote, memory } = await fixture();
    assert.equal(await remote.getCatalog(), null);
    const initial = catalog();
    initial.records["Attachments/private-photo.png"] = { private: "test only" };
    const first = await remote.compareAndSwapCatalog(null, initial);
    assert.equal(first.generation, "10000000000000000");
    assert.equal(await remote.compareAndSwapCatalog(null, catalog()), null);
    assert.deepEqual(await remote.getCatalog(), first);
    const second = await remote.compareAndSwapCatalog(first.generation, { ...initial, sequence: 1 });
    assert.equal(await remote.compareAndSwapCatalog(first.generation, { ...initial, sequence: 2 }), null);
    assert.equal((await remote.getCatalog()).generation, second.generation);
    for (const stored of memory.objects.values()) assert.equal(Buffer.from(stored.bytes).includes(Buffer.from("private-photo.png")), false);
    for (const request of memory.requests.filter(item => item.method === "PUT")) {
        assert.equal(request.headers["if-match"], undefined);
        assert.equal(request.headers["if-none-match"], undefined);
        assert.ok(request.headers.authorization.includes("x-goog-if-generation-match"));
        assert.equal(request.headers["content-encoding"], undefined);
    }
});

test("immutable encrypted chunks retry only after proving existing plaintext and hash match", async () => {
    const { remote, memory } = await fixture();
    const data = Uint8Array.from([0, 1, 2, 255]);
    await remote.putChunk("revision-one", 0, data, hash(data));
    await remote.putChunk("revision-one", 0, data, hash(data));
    assert.equal(memory.requests.filter(request => request.method === "PUT").length, 1, "resume does not re-upload an acknowledged chunk");
    assert.deepEqual(await remote.getChunk("revision-one", 0), data);
    assert.equal(memory.objects.size, 1);
    await assert.rejects(remote.putChunk("revision-one", 0, new Uint8Array([3]), hash(new Uint8Array([3]))), /different content/);
    await assert.rejects(remote.putChunk("revision-one", 1, data, "0".repeat(64)), /expected size or hash/);
    const original = [...memory.objects.values()][0];
    memory.objects.set("/test-bucket/attachments-sync/collection-one/chunks/revision-one/1.bin", { ...original });
    await assert.rejects(remote.getChunk("revision-one", 1), /authentication failed/);
});

test("retirement deletes only exact indexes with observed generations and is idempotent", async () => {
    const { remote, memory } = await fixture();
    const data = new Uint8Array([42]);
    for (const index of [0, 1, 2]) await remote.putChunk("revision-one", index, data, hash(data));
    await remote.putChunk("revision-other", 0, data, hash(data));
    await remote.deleteRevision("revision-one", 2);
    await remote.deleteRevision("revision-one", 2);
    assert.equal(memory.objects.size, 2);
    for (const request of memory.requests.filter(item => item.method === "DELETE")) {
        assert.match(request.headers["x-goog-if-generation-match"], /^[1-9][0-9]+$/);
        assert.match(request.url, /revision-one\/[01]\.bin$/);
    }
    const existing = await remote.headLegacyObject("attachments-sync/collection-one/chunks/revision-other/0.bin");
    const key = "/test-bucket/attachments-sync/collection-one/chunks/revision-other/0.bin";
    memory.objects.get(key).generation = "999999999999999999";
    await assert.rejects(remote.deleteLegacyObject(key.slice("/test-bucket/".length), existing.generation), error => error.code === "precondition");
    assert.equal(memory.objects.has(key), true);
});

test("transport rejects unsafe endpoints, keys, redirects and does not leak request error contents", async () => {
    const base = await fixture();
    for (const endpoint of ["http://storage.googleapis.com", "https://evil.example", "https://storage.googleapis.com.evil.example", "https://user@storage.googleapis.com", "https://storage.googleapis.com/path", "https://storage.googleapis.com?x=1"]) {
        assert.throws(() => new remoteModule.GcsAttachmentRemote({ ...base.options, endpoint }), /endpoint/);
    }
    for (const key of ["/absolute", "../outside", "nested/../outside", "back\\slash", "https://other.example/secret"]) {
        await assert.rejects(base.remote.headLegacyObject(key), /invalid/);
    }
    const redirect = await fixture({ request: async () => ({ status: 302, headers: { location: "https://evil.example" }, arrayBuffer: arrayBuffer() }) });
    await assert.rejects(redirect.remote.getCatalog(), /unexpected redirect/);
    const failed = await fixture({ request: async () => { throw new Error("authorization=" + credentials.secretAccessKey); } });
    await assert.rejects(failed.remote.getCatalog(), error => !error.message.includes(credentials.secretAccessKey));
});

test("oversized metadata stops before GET and authentication failures never mean empty catalog", async () => {
    const requests = [];
    const { remote } = await fixture({ request: async parameters => {
        requests.push(parameters);
        return { status: 200, headers: { "content-length": String(crypto.ATTACHMENT_CATALOG_MAX_BYTES + 100), "x-goog-generation": "7" }, arrayBuffer: arrayBuffer() };
    } });
    await assert.rejects(remote.getCatalog(), /size limit/);
    assert.equal(requests.length, 1);
    const denied = await fixture({ request: async () => ({ status: 403, headers: {}, arrayBuffer: arrayBuffer() }) });
    await assert.rejects(denied.remote.getCatalog(), error => error.status === 403);
    const { remote: first, memory, options } = await fixture();
    await first.compareAndSwapCatalog(null, catalog());
    const otherKey = await crypto.importRecoveryKey(crypto.generateRecoveryKey(webcrypto), webcrypto);
    const other = new remoteModule.GcsAttachmentRemote({ ...options, crypto: otherKey, request: memory.request });
    await assert.rejects(other.getCatalog(), /authentication failed/);
});

test("legacy range reads validate size, generation and exact Content-Range", async () => {
    const { remote, memory } = await fixture();
    memory.objects.set("/test-bucket/old/a%20b%2B%21.mp4", { generation: "19", bytes: new Uint8Array([1, 2, 3, 4]) });
    const metadata = await remote.headLegacyObject("old/a b+!.mp4");
    assert.deepEqual(metadata, { size: 4, generation: "19" });
    assert.deepEqual(await remote.readLegacyRange("old/a b+!.mp4", 1, 2, "19"), new Uint8Array([2, 3]));
    const invalid = await fixture({ request: async () => ({ status: 206, headers: { "content-range": "bytes 0-1/4", "x-goog-generation": "20" }, arrayBuffer: arrayBuffer(new Uint8Array(2)) }) });
    await assert.rejects(invalid.remote.readLegacyRange("old/file", 1, 2, "19"), /unexpected.*byte range/);
});

test("retention inspection is read-only and explicitly reports unsupported policies as unknown", async () => {
    const requests = [];
    const { remote } = await fixture({ request: async parameters => {
        requests.push(parameters);
        return { status: 200, headers: {}, arrayBuffer: arrayBuffer(new TextEncoder().encode('<VersioningConfiguration><Enabled>true</Enabled></VersioningConfiguration>')) };
    } });
    const result = await remote.getBucketPolicy();
    assert.equal(result.versioning, "enabled");
    assert.equal(result.softDelete, "unknown");
    assert.equal(result.retention, "unknown");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, "GET");
    assert.ok(requests[0].url.endsWith("?versioning"));
});

test("authenticated but malformed catalog envelopes are rejected before reconciliation", async () => {
    const { remote, memory, encryption } = await fixture();
    const malformed = [null, [], { ...catalog(), version: 2 }, { ...catalog(), collectionId: "other" },
        { ...catalog(), sequence: -1 }, { ...catalog(), sequence: 1.5 }, { ...catalog(), records: [] },
        { ...catalog(), uploads: null }, { ...catalog(), garbage: "no" }];
    for (const value of malformed) {
        const encrypted = await encryption.encrypt(new TextEncoder().encode(JSON.stringify(value)), { kind: "catalog", collectionId: "collection-one" });
        memory.objects.set("/test-bucket/attachments-sync/collection-one/catalog.bin", { bytes: encrypted, generation: "23" });
        await assert.rejects(remote.getCatalog(), /catalog is invalid/);
    }
    const encrypted = await encryption.encrypt(new Uint8Array([255]), { kind: "catalog", collectionId: "collection-one" });
    memory.objects.set("/test-bucket/attachments-sync/collection-one/catalog.bin", { bytes: encrypted, generation: "24" });
    await assert.rejects(remote.getCatalog(), /not valid JSON/);
    assert.equal(memory.requests.some(request => request.method === "PUT" || request.method === "DELETE"), false);
});

test("pausing during a HEAD prevents the following exact-generation deletion", async () => {
    let active = true;
    const requests = [];
    const { remote } = await fixture({ checkCurrent: () => { if (!active) throw new Error("stopped"); },
        request: async parameters => {
            requests.push(parameters);
            active = false;
            return { status: 200, headers: { "content-length": "100", "x-goog-generation": "100" }, arrayBuffer: arrayBuffer() };
        } });
    await assert.rejects(remote.deleteRevision("retired-one", 100), /stopped/);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, "HEAD");
});

test("configuration change during request signing stops before native transport", async () => {
    let active = true;
    let calls = 0;
    const { remote } = await fixture({ checkCurrent: () => { if (!active) throw new Error("stopped"); },
        now: () => { active = false; return fixedTime; }, request: async () => { calls++; throw Error("should not call"); } });
    await assert.rejects(remote.getCatalog(), /stopped/);
    assert.equal(calls, 0);
});

test("a competing create between chunk HEAD and PUT is reconciled by authenticated equality", async () => {
    const { memory, encryption, options } = await fixture();
    const bytes = new Uint8Array([10, 20, 30]);
    const encrypted = await encryption.encrypt(bytes, { kind: "chunk", collectionId: "collection-one", revision: "race", index: 0 });
    let raced = false;
    const remote = new remoteModule.GcsAttachmentRemote({ ...options, request: async parameters => {
        if (parameters.method === "PUT" && !raced) {
            raced = true;
            memory.objects.set(new URL(parameters.url).pathname, { generation: "900", bytes: encrypted });
        }
        return memory.request(parameters);
    } });
    await remote.putChunk("race", 0, bytes, hash(bytes));
    assert.deepEqual(await remote.getChunk("race", 0), bytes);
    assert.equal(memory.objects.size, 1);
});
