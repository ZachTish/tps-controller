import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHmac, webcrypto } from "node:crypto";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const root = new URL("../", import.meta.url);
async function load(entry) {
    const result = await build({ entryPoints: [fileURLToPath(new URL(entry, root))], bundle: true,
        format: "esm", platform: "node", target: "node18", write: false });
    return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}
const contract = await load("src/services/tishos-native-mac-refresh-contract.ts");
const { NativeMacRefreshSender } = await load("src/services/tishos-native-mac-refresh-sender.ts");
const SECRET = Uint8Array.from({ length: 32 }, (_, index) => index);
const CLIENT = "11111111-2222-4333-8444-555555555555";
const REQUEST = "99999999-aaaa-4bbb-8ccc-dddddddddddd";
const INTENT = { vaultName: "QA Vault + 🧪", clientID: CLIENT, generation: "synthetic-local-generation", lifecycle: 1 };
const NOW = 1786722645123;
const mac = bytes => createHmac("sha256", SECRET).update(bytes).digest("base64url");
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const activeSenders = new Set();
afterEach(async () => {
    await Promise.all([...activeSenders].map(sender => sender.stop()));
    activeSenders.clear();
});
async function waitFor(predicate) {
    const deadline = Date.now() + 2000;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error("Expected transport state did not arrive");
        await pause(1);
    }
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function signedReceipt(request, overrides = {}) {
    const unsigned = { schemaVersion: 1, requestID: request.requestID, status: "queued" };
    return { status: 202, body: JSON.stringify({ ...unsigned,
        mac: mac(contract.canonicalNativeMacRefreshResponse(unsigned)), ...overrides }) };
}
function harness(options = {}) {
    const requests = []; const outcomes = []; let current = true; let supported = true; let nextRequest = 0;
    const sender = new NativeMacRefreshSender({ enabled: () => supported,
        resolveSecret: () => current ? SECRET : null, now: () => NOW,
        requestID: () => `99999999-aaaa-4bbb-8ccc-${String(++nextRequest).padStart(12, "0")}`,
        transport: async body => { const request = JSON.parse(body); requests.push(request); return signedReceipt(request); },
        onOutcome: value => outcomes.push(value), requestTimeoutMs: 40, minIntervalMs: 0, retryDelayMs: 2, ...options });
    activeSenders.add(sender);
    return { sender, requests, outcomes, setCurrent: value => { current = value; }, setSupported: value => { supported = value; } };
}

test("canonical request uses UTF8 byte lengths and independent Node HMAC; response is domain separated", () => {
    const unsigned = { schemaVersion: 1, vaultName: INTENT.vaultName, clientID: CLIENT, requestID: REQUEST, issuedAt: String(NOW) };
    const text = "tishos-vault-refresh-v1\nschema:1\nvault:15:QA Vault + 🧪\n"
        + `client:36:${CLIENT}\nrequest:36:${REQUEST}\nissued:13:${NOW}\n`;
    assert.equal(Buffer.from(contract.canonicalNativeMacRefreshRequest(unsigned)).toString(), text);
    assert.equal(mac(contract.canonicalNativeMacRefreshRequest(unsigned)), mac(Buffer.from(text)));
    const response = contract.canonicalNativeMacRefreshResponse({ schemaVersion: 1, requestID: REQUEST, status: "queued" });
    assert.equal(Buffer.from(response).toString(), `tishos-vault-refresh-response-v1\nschema:1\nrequest:36:${REQUEST}\nstatus:6:queued\n`);
    assert.notEqual(mac(response), mac(contract.canonicalNativeMacRefreshRequest(unsigned)));
});

test("request validation rejects noncanonical identifiers/times, injected controls, oversized names", () => {
    const base = { schemaVersion: 1, vaultName: INTENT.vaultName, clientID: CLIENT, requestID: REQUEST, issuedAt: String(NOW) };
    for (const patch of [{ requestID: REQUEST.toUpperCase() }, { requestID: "not-uuid" }, { issuedAt: "01" },
        { issuedAt: "-1" }, { issuedAt: "1e3" }, { vaultName: "injected\npath" }, { vaultName: "A".repeat(257) }, { schemaVersion: 2 }]) {
        assert.throws(() => contract.canonicalNativeMacRefreshRequest({ ...base, ...patch }));
    }
});

test("request and queued receipt match the native CryptoKit interoperability fixture", () => {
    const unsigned = { schemaVersion: 1, vaultName: "Synthetic Vault",
        clientID: "11111111-1111-4111-8111-111111111111",
        requestID: "22222222-2222-4222-8222-222222222222", issuedAt: "1700000000000" };
    assert.equal(mac(contract.canonicalNativeMacRefreshRequest(unsigned)), "zG28UTYSsE99VQ8DuGTQwdIqCPm3Hs8WFFKdoIp9dm0");
    assert.equal(mac(contract.canonicalNativeMacRefreshResponse({ schemaVersion: 1,
        requestID: unsigned.requestID, status: "queued" })), "LnCNRBUppblR2Cnka941ySJWQmeifXogvzIEOABBR7I");
});

test("response is exact, bounded, current-request-only and rejects duplicate keys", () => {
    const body = signedReceipt({ requestID: REQUEST }).body;
    assert.equal(contract.parseNativeMacRefreshResponse(body, REQUEST)?.status, "queued");
    for (const invalid of [body.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'),
        body.replace('"mac":', '"\\u006dac":"' + "A".repeat(43) + '","mac":'),
        JSON.stringify({ ...JSON.parse(body), command: "anything" }), body.replace(REQUEST, CLIENT),
        body.replace('"queued"', '"uploaded"'), "x".repeat(2049), "bad json"]) {
        assert.equal(contract.parseNativeMacRefreshResponse(invalid, REQUEST), null);
    }
});

test("authenticated 202 means queued only; request contains no generation, path, note or command", async () => {
    const h = harness(); h.sender.signal(INTENT); await h.sender.whenIdle();
    assert.equal(h.requests.length, 1);
    const request = h.requests[0];
    assert.deepEqual(Object.keys(request).sort(), ["clientID", "issuedAt", "mac", "requestID", "schemaVersion", "vaultName"]);
    const { mac: signature, ...unsigned } = request;
    assert.equal(signature, mac(contract.canonicalNativeMacRefreshRequest(unsigned)));
    assert.deepEqual(h.outcomes, ["queued"]);
    assert.deepEqual(SECRET, Uint8Array.from({ length: 32 }, (_, index) => index));
    await h.sender.stop();
});

test("unsigned, wrong-request, wrong-MAC, and redirect responses cannot claim delivery or retry", async () => {
    for (const response of [() => ({ status: 202, body: "{}" }), request => signedReceipt(request, { mac: "A".repeat(43) }),
        request => signedReceipt(request, { requestID: CLIENT }), request => ({ ...signedReceipt(request), status: 302 })]) {
        let attempts = 0; const h = harness({ transport: async body => { attempts++; return response(JSON.parse(body)); } });
        h.sender.signal(INTENT); await h.sender.whenIdle();
        assert.equal(attempts, 1); assert.deepEqual(h.outcomes, ["unavailable"]);
        await h.sender.stop();
    }
});

test("network/503/429 failures retry once with a new request nonce and remain nonthrowing", async () => {
    for (const fail of [async () => { throw new Error("synthetic error must not leak"); },
        async () => ({ status: 503, body: "unavailable" }), async () => ({ status: 429, body: "busy" })]) {
        const requests = []; const h = harness({ transport: async body => { const request = JSON.parse(body); requests.push(request); return fail(); } });
        h.sender.signal(INTENT); await h.sender.whenIdle();
        assert.equal(requests.length, 2); assert.notEqual(requests[0].requestID, requests[1].requestID);
        assert.deepEqual(h.outcomes, ["unavailable", "unavailable"]); await h.sender.stop();
    }
});

test("authority rechecks reject revoked/rotated pairing without network or late receipt claim", async () => {
    const waiting = deferred(); let attempts = 0;
    const h = harness({ transport: async body => { attempts++; await waiting.promise; return signedReceipt(JSON.parse(body)); } });
    h.sender.signal(INTENT); await waitFor(() => attempts === 1); h.setCurrent(false); h.sender.revoke(CLIENT); waiting.resolve();
    await h.sender.whenIdle(); assert.equal(attempts, 1); assert.deepEqual(h.outcomes, []);
    h.sender.signal(INTENT); await h.sender.whenIdle(); assert.equal(attempts, 1); await h.sender.stop();
});

test("unsupported/mobile and stopped senders never load a transport", async () => {
    let attempts = 0; const h = harness({ transport: async () => { attempts++; throw new Error("must not run"); } });
    h.setSupported(false); h.sender.signal(INTENT); await h.sender.whenIdle();
    h.setSupported(true); await h.sender.stop(); h.sender.signal(INTENT); await h.sender.whenIdle();
    assert.equal(attempts, 0);
});

test("stop followed by restart cannot report an earlier in-flight receipt", async () => {
    const waiting = deferred(); let attempts = 0;
    const h = harness({ transport: async body => { attempts++; await waiting.promise; return signedReceipt(JSON.parse(body)); } });
    h.sender.signal(INTENT); await waitFor(() => attempts === 1);
    const stopped = h.sender.stop(); h.sender.start(); waiting.resolve(); await stopped;
    assert.equal(attempts, 1); assert.deepEqual(h.outcomes, []);
    h.sender.signal(INTENT); await h.sender.whenIdle(); assert.equal(attempts, 2);
    assert.deepEqual(h.outcomes, ["queued"]); await h.sender.stop();
});

test("authenticated attempts are rate limited and pending clients are bounded", async () => {
    let attempts = 0;
    const h = harness({ transport: async body => { attempts++; return signedReceipt(JSON.parse(body)); } });
    for (let index = 0; index < 100; index++) h.sender.signal({ ...INTENT,
        clientID: `11111111-2222-4333-8444-${String(index).padStart(12, "0")}` });
    assert.equal(h.sender.pending.size, 32);
    await waitFor(() => attempts === 10); await pause(50); assert.equal(attempts, 10);
    assert.ok(h.sender.pending.size <= 32); await h.sender.stop(); await h.sender.whenIdle();
});

test("bursts coalesce into latest pending signal and never run transports concurrently", async () => {
    const first = deferred(); const requests = []; let concurrent = 0; let peak = 0;
    const h = harness({ requestTimeoutMs: 1000, transport: async body => { const request = JSON.parse(body); requests.push(request);
        concurrent++; peak = Math.max(peak, concurrent); if (requests.length === 1) await first.promise;
        concurrent--; return signedReceipt(request); } });
    h.sender.signal(INTENT); await waitFor(() => requests.length === 1);
    for (let index = 0; index < 100; index++) h.sender.signal({ ...INTENT, generation: `newest-${index}` });
    first.resolve(); await h.sender.whenIdle();
    assert.equal(requests.length, 2); assert.equal(peak, 1);
    assert.deepEqual(h.outcomes, ["queued", "queued"]); await h.sender.stop();
});

test("uncooperative transport is bounded; stop interrupts its deadline immediately", async () => {
    let attempts = 0;
    const h = harness({ transport: async () => { attempts++; return new Promise(() => {}); }, requestTimeoutMs: 20 });
    h.sender.signal(INTENT); await h.sender.whenIdle(); assert.equal(attempts, 2);
    let secondAttempts = 0;
    const second = harness({ transport: async () => { secondAttempts++; return new Promise(() => {}); }, requestTimeoutMs: 2000 });
    second.sender.signal(INTENT); await waitFor(() => secondAttempts === 1);
    await Promise.race([second.sender.stop(), pause(100).then(() => { throw new Error("Stop must not await transport"); })]);
    assert.deepEqual(second.outcomes, []); await h.sender.stop();
});

test("default transport is fixed native loopback and is not renderer fetch or foreground UI", async () => {
    const source = await readFile(new URL("src/services/tishos-native-mac-refresh-sender.ts", root), "utf8");
    assert.match(source, /require\("http"\)/); assert.match(source, /host: "127\.0\.0\.1"/);
    assert.match(source, /"Content-Length": utf8ByteCount\(body\)/);
    assert.equal(source.includes("window.open("), false); assert.equal(source.includes("fetch("), false);
});
