import test from "node:test";
import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

if (!globalThis.crypto?.subtle) Object.defineProperty(globalThis, "crypto", { value: webcrypto });
const fixtureKey = "__tpsAttachmentServiceWrapperFixture";
const source = new URL("../src/services/attachment-sync/service.ts", import.meta.url);
const virtual = {
    obsidian: `export class Notice { constructor() {} } export class TFile {} export const Platform={isMobile:false}; export const normalizePath=p=>p; export const requestUrl=()=>{throw new Error('Unmocked network');};`,
    "./gcs-remote": `export class GcsAttachmentRemote { constructor(){globalThis.${fixtureKey}.remoteConstructed++;return globalThis.${fixtureKey}.remote;} }`,
    "./device-state": `export class AttachmentDeviceStateStore { constructor(){globalThis.${fixtureKey}.stateConstructed++;return globalThis.${fixtureKey}.state;} }`,
    "./local-files": `export class ObsidianAttachmentLocalStore { constructor(){return globalThis.${fixtureKey}.local;} }`,
    "./mobile-diagnostic": `export const runAttachmentMobileDiagnostic=()=>{throw new Error('Diagnostic not requested');};`,
};
const result = await build({
    entryPoints: [fileURLToPath(source)], bundle: true, write: false, format: "esm", platform: "browser", logLevel: "silent",
    plugins: [{ name: "service-ports", setup(builder) {
        builder.onResolve({ filter: /^(obsidian|\.\/(gcs-remote|device-state|local-files|mobile-diagnostic))$/u }, args =>
            Object.hasOwn(virtual, args.path) ? { path: args.path, namespace: "port" } : undefined);
        builder.onLoad({ filter: /.*/u, namespace: "port" }, args => ({ contents: virtual[args.path], loader: "js" }));
    } }],
});
const { AttachmentSyncService } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
const clone = value => JSON.parse(JSON.stringify(value));

function fixture(participating = true) {
    const data = new TextEncoder().encode("resume bytes");
    const sha256 = createHash("sha256").update(data).digest("hex");
    const path = "Inbox/attachment.bin";
    const revision = { id: "fixture-revision", size: data.length, mtime: 1000, sha256,
        chunks: [{ index: 0, size: data.length, sha256 }] };
    const record = { path, change: { time: 1000, counter: 0, deviceId: "other-device", operationId: "other-operation" }, deleted: false, revision };
    const catalog = { version: 1, collectionId: "fixture-collection", sequence: 1, records: { [path]: record }, uploads: {}, garbage: {} };
    const counters = { stateConstructed: 0, remoteConstructed: 0, stateClosed: 0, downloadedChunks: 0, appendedChunks: 0 };
    const state = {
        value: null,
        async load() { return this.value && clone(this.value); },
        async save(value) { this.value = clone(value); },
        async getPreference(key) { return key === "participation" ? participating : null; },
        async setPreference() {},
        async close() { counters.stateClosed++; },
    };
    let localFile = null;
    let stagedBytes = new Uint8Array(data); // Previously downloaded complete prefix survives an interrupted service run.
    const local = {
        isEligible: () => true,
        async recover() {},
        async pruneStages() {},
        async scan() { return { complete: true, files: localFile ? [{ path, size: localFile.length, mtime: 1000 }] : [] }; },
        async stat() { return localFile ? { path, size: localFile.length, mtime: 1000 } : null; },
        async readChunk(_path, offset, length) { return localFile.slice(offset, offset + length); },
        async createStage() { return "persisted-stage"; },
        async stageSize() { return stagedBytes.length; },
        async readStageChunk(_stage, offset, length) { return stagedBytes.slice(offset, offset + length); },
        async appendStage(_stage, content) {
            counters.appendedChunks++;
            stagedBytes = new Uint8Array(Buffer.concat([stagedBytes, content]));
        },
        async applyStage() {
            assert.equal(stagedBytes.length, revision.size, "service must preserve resume metadata instead of duplicating a stored prefix");
            localFile = new Uint8Array(stagedBytes);
            return true;
        },
        async discardStage() {},
        async remove() { throw new Error("No local deletion was requested"); },
    };
    const remote = {
        async getCatalog() { return { catalog: clone(catalog), generation: "1" }; },
        async compareAndSwapCatalog() { throw new Error("Existing unchanged cloud catalog must not be rewritten"); },
        async getChunk() { counters.downloadedChunks++; return new Uint8Array(data); },
        async putChunk() { throw new Error("A completed cloud download must not be uploaded as a new local edit"); },
        async deleteRevision() { throw new Error("No revision was retired"); },
    };
    globalThis[fixtureKey] = Object.assign(counters, { state, local, remote });
    globalThis.window = { clearInterval() {}, clearTimeout() {} };
    const key = `tps-attachments-v1:${Buffer.alloc(32, 7).toString("base64url")}`;
    const settings = {
        schema: 1, provider: "gcs", enabled: true, endpoint: "https://storage.googleapis.com", bucket: "fixture-bucket",
        prefix: "fixture-prefix", collectionId: "fixture-collection", excludedPaths: [],
        accessKeySecretName: "fixture-access", secretKeySecretName: "fixture-secret", recoveryKeySecretName: "fixture-recovery",
    };
    const app = { vault: { adapter: {} }, secretStorage: { getSecret(name) {
        if (name === "fixture-recovery") return key;
        return name === "fixture-access" ? "synthetic-access" : "synthetic-secret";
    } } };
    return { service: new AttachmentSyncService(app, () => settings, () => ({})), counters,
        getLocalBytes: () => localFile, expectedBytes: data };
}

test("real service context forwards persisted stage resume methods to the real engine", async () => {
    const f = fixture();
    await f.service.runNow(false);
    assert.deepEqual(f.getLocalBytes(), f.expectedBytes);
    assert.equal(f.counters.downloadedChunks, 0, "verified existing stage prefix is reused through the service wrapper");
    assert.equal(f.counters.appendedChunks, 0);
    await f.service.runNow(false);
    assert.equal(f.counters.stateConstructed, 1, "participation and engine operations reuse one device-state store");
    f.service.stop();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.counters.stateClosed, 1, "the service closes its cached device-state handle on stop");
});

test("a shared enabled switch without local participation opens no transport through the real context", async () => {
    const f = fixture(false);
    await f.service.runNow(false);
    assert.equal(f.counters.stateConstructed, 1);
    assert.equal(f.counters.remoteConstructed, 0);
    assert.equal(f.getLocalBytes(), null);
    f.service.stop();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.counters.stateClosed, 1);
});
