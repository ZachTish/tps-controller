import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto, createHash } from "node:crypto";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const built = await build({
    entryPoints: [fileURLToPath(new URL("../src/services/attachment-sync/crypto.ts", import.meta.url))],
    bundle: true, write: false, format: "esm", platform: "browser",
});
const crypto = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`);
const encoder = new TextEncoder();
const context = { kind: "chunk", collectionId: "collection-test", revision: "revision-test", index: 0 };

test("32-byte recovery keys round-trip and import the same AES key", async () => {
    const key = crypto.generateRecoveryKey(webcrypto);
    assert.match(key, /^tps-attachments-v1:[A-Za-z0-9_-]{43}$/);
    assert.equal(crypto.normalizeRecoveryKey(` ${key}\n`), key);
    const first = await crypto.importRecoveryKey(key, webcrypto);
    const second = await crypto.importRecoveryKey(key, webcrypto);
    const plain = encoder.encode("binary payload\u0000\ufffd");
    const cipher = await first.encrypt(plain, context);
    assert.deepEqual(await second.decrypt(cipher, context), plain);
    assert.equal(cipher.byteLength, plain.byteLength + crypto.ATTACHMENT_ENCRYPTION_OVERHEAD);
});

test("each encryption chooses a fresh nonce and authenticates catalog context", async () => {
    const service = await crypto.importRecoveryKey(crypto.generateRecoveryKey(webcrypto), webcrypto);
    const plain = encoder.encode('{"path":"Attachments/private-photo.png"}');
    const catalogContext = { kind: "catalog", collectionId: "collection-test" };
    const first = await service.encrypt(plain, catalogContext);
    const second = await service.encrypt(plain, catalogContext);
    assert.notDeepEqual(first.subarray(1, 13), second.subarray(1, 13));
    assert.equal(Buffer.from(first).includes(Buffer.from("private-photo.png")), false);
    assert.deepEqual(await service.decrypt(first, catalogContext), plain);
    await assert.rejects(service.decrypt(first, { ...catalogContext, collectionId: "another-collection" }), /authentication failed/);
    await assert.rejects(service.decrypt(first, context), /authentication failed/);
});

test("wrong key, altered ciphertext, nonce, revision, and index cannot decrypt", async () => {
    const service = await crypto.importRecoveryKey(crypto.generateRecoveryKey(webcrypto), webcrypto);
    const other = await crypto.importRecoveryKey(crypto.generateRecoveryKey(webcrypto), webcrypto);
    const cipher = await service.encrypt(encoder.encode("secret bytes"), context);
    await assert.rejects(other.decrypt(cipher, context), /authentication failed/);
    for (const offset of [1, 13, cipher.length - 1]) {
        const tampered = cipher.slice();
        tampered[offset] ^= 1;
        await assert.rejects(service.decrypt(tampered, context), /authentication failed/);
    }
    await assert.rejects(service.decrypt(cipher, { ...context, revision: "different" }), /authentication failed/);
    await assert.rejects(service.decrypt(cipher, { ...context, index: 1 }), /authentication failed/);
});

test("malformed recovery material and oversized payloads fail closed", async () => {
    for (const value of ["", "x".repeat(32), "tps-attachments-v1:" + "A".repeat(42), "tps-attachments-v1:" + "B".repeat(43)]) {
        assert.throws(() => crypto.normalizeRecoveryKey(value));
    }
    const service = await crypto.importRecoveryKey(crypto.generateRecoveryKey(webcrypto), webcrypto);
    await assert.rejects(service.encrypt(new Uint8Array(crypto.ATTACHMENT_CHUNK_BYTES + 1), context), /size limit/);
    await assert.rejects(service.decrypt(new Uint8Array(28), context), /invalid format/);
    await assert.rejects(service.encrypt(new Uint8Array(), { ...context, index: -1 }), /chunk index/);
});

test("incremental SHA-256 matches known standard digests without a file buffer", async () => {
    const expected = createHash("sha256");
    const actual = crypto.createSha256();
    for (let index = 0; index < 1000; index++) {
        const chunk = encoder.encode(`chunk-${index}\u0000`);
        expected.update(chunk);
        actual.update(chunk);
    }
    assert.equal(await actual.digestHex(), expected.digest("hex"));
    assert.throws(() => actual.update(new Uint8Array()), /finalized/);
    await assert.rejects(actual.digestHex(), /finalized/);
    assert.equal(await crypto.createSha256().digestHex(), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});
