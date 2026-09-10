import test from "node:test";
import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

globalThis.crypto ||= webcrypto;
const built = await build({ entryPoints: [fileURLToPath(new URL("../src/services/attachment-sync/legacy-migration.ts", import.meta.url))],
    bundle: true, write: false, format: "esm", platform: "browser", plugins: [{ name: "legacy-fixture", setup(builder) {
        builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "stub" }));
        builder.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "export class App {} export class TFile {}" }));
        builder.onResolve({ filter: /tps-gcm-api$/ }, () => ({ path: "gcm", namespace: "gcm" }));
        builder.onLoad({ filter: /.*/, namespace: "gcm" }, () => ({ contents: `
            export async function canAutomaticallyMutateViaGcm(app,file) { return !app.protectedPaths?.has(file.path); }
            export function canAutomaticallyMutateSourceViaGcm(app,source) { return !source.includes('template: true'); }
        ` }));
    } }] });
const module = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`);
const bytes = value => new TextEncoder().encode(value);
const hash = value => createHash("sha256").update(value).digest("hex");
const clone = value => structuredClone(value);
const journalKey = "legacy-restoration-v1";

function fixture(options = {}) {
    const legacy = { endpoint: "https://storage.googleapis.com", contentUrl: "https://public.example/assets", bucket: "test-bucket", useBucketSubdomain: false, ...options.legacy };
    const entry = { key: "old/photo.png", sourcePath: "Attachments/photo.png", uploadedAt: 100,
        url: module.legacyPublicUrl("old/photo.png", legacy), ...options.entry };
    const manifest = options.manifest === undefined ? [entry] : options.manifest;
    const originals = new Map([[entry.archivedKey || entry.key, { bytes: bytes("restored image"), generation: "12345678901234567890" }]]);
    const files = new Map();
    const notes = new Map([["Notes/example.md", `before ![photo](${entry.url}) after`]]);
    const preferences = new Map();
    const stages = new Map();
    const events = [];
    const records = Object.create(null);
    let serial = 0;
    let failFinalJournal = false;
    const local = {
        isEligible: path => typeof path === "string" && !path.startsWith(".") && !path.includes("..") && !/\.(md|canvas|base)$/i.test(path),
        async stat(path) { const file = files.get(path); return file ? { path, size: file.bytes.length, mtime: file.mtime } : null; },
        async readChunk(path, offset, length) { return files.get(path).bytes.slice(offset, offset + length); },
        async createStage(path, revision) { const id = `stage-${serial++}`; stages.set(id, { path, revision, chunks: [] }); return id; },
        async appendStage(id, chunk) { stages.get(id).chunks.push(chunk.slice()); },
        async retargetStage(id, path) { assert.ok(local.isEligible(path)); stages.get(id).path = path; },
        async sealStage(id, revision) { stages.get(id).revision = clone(revision); },
        async applyStage(id, path, expected, mtime) {
            const stage = stages.get(id);
            assert.equal(stage.path, path, "stage must be retargeted for a collision");
            if (files.has(path)) return false;
            const content = new Uint8Array(stage.chunks.reduce((sum, chunk) => sum + chunk.length, 0));
            let offset = 0;
            for (const chunk of stage.chunks) { content.set(chunk, offset); offset += chunk.length; }
            files.set(path, { bytes: content, mtime }); stages.delete(id); events.push("install"); return true;
        },
        async discardStage(id) { stages.delete(id); },
    };
    const state = {
        async getPreference(key) { return clone(preferences.get(key)); },
        async setPreference(key, value) {
            if (failFinalJournal && Object.values(value).some(job => job.removed)) { failFinalJournal = false; throw Error("simulated crash after delete"); }
            preferences.set(key, clone(value));
        },
    };
    const remote = {
        async headLegacyObject(key) { events.push(`head:${key}`); const item = originals.get(key); return item ? { size: item.bytes.length, generation: item.generation } : null; },
        async readLegacyRange(key, offset, length, generation) { const item = originals.get(key); assert.equal(item.generation, generation); return item.bytes.slice(offset, offset + length); },
        async getCatalog() { events.push("catalog"); return { generation: "99", catalog: { version: 1, collectionId: "collection", sequence: 1, records, uploads: {}, garbage: {} } }; },
        async deleteLegacyObject(key, generation) {
            events.push("delete"); const item = originals.get(key);
            if (item) assert.equal(item.generation, generation);
            originals.delete(key);
        },
    };
    const engine = { async run() {
        events.push("publish");
        if (options.noPublication) return;
        for (const [path, file] of files) records[path] = { path, deleted: false, revision: { sha256: hash(file.bytes), size: file.bytes.length } };
    } };
    const app = { protectedPaths: new Set(), vault: {
        adapter: { async exists() { return options.manifestMissing !== true; }, async read() { return typeof manifest === "string" ? manifest : JSON.stringify(manifest); } },
        getMarkdownFiles: () => [...notes.keys()].filter(path => path.endsWith(".md")).map(path => ({ path })),
        getFiles: () => [...notes.keys()].map(path => ({ path })),
        async read(note) { return notes.get(note.path); },
        async process(note, update) {
            events.push("rewrite");
            if (options.beforeProcess) notes.set(note.path, options.beforeProcess(notes.get(note.path)));
            notes.set(note.path, update(notes.get(note.path)));
        },
    } };
    const context = { local, state, remote, engine, bucket: options.bucket || legacy.bucket, prefix: "attachment-sync", check() {} };
    return { migration: new module.AttachmentLegacyMigration(app, legacy, context), legacy, entry, originals, files, notes, preferences, stages, events, records, context, app,
        failAfterDelete() { failFinalJournal = true; } };
}

test("legacy URLs match the exact configured bucket including base paths and subdomains", () => {
    const { legacy } = fixture();
    assert.equal(module.legacyPublicUrl("old/a b.png", legacy), "https://public.example/assets/test-bucket/old/a%20b.png");
    assert.equal(module.legacyPublicUrl("a.png", { ...legacy, useBucketSubdomain: true }), "https://test-bucket.public.example/assets/a.png");
    assert.throws(() => module.legacyPublicUrl("a.png", { ...legacy, contentUrl: "https://user:secret@example.com" }));
});

test("malformed manifests and mismatched URLs/buckets never inspect arbitrary objects", async () => {
    for (const manifest of ["not JSON", {}, null]) await assert.rejects(fixture({ manifest }).migration.preview());
    const mismatch = fixture({ entry: { url: "https://evil.example/old/photo.png" } });
    assert.equal((await mismatch.migration.preview()).items.length, 0);
    assert.equal(mismatch.events.length, 0);
    await assert.rejects(fixture({ bucket: "another-bucket" }).migration.preview(), /original bucket/);
    const excluded = fixture({ entry: { archivedKey: "attachment-sync/collection/catalog.bin" } });
    assert.equal((await excluded.migration.preview()).items.length, 0);
    const redirected = fixture({ entry: { archivedKey: "unrelated-private-object.png" } });
    assert.equal((await redirected.migration.preview()).items.length, 0);
    assert.equal(redirected.events.length, 0);
});

test("restoration verifies encrypted publication before rewriting notes or removing originals", async () => {
    const f = fixture();
    const result = await f.migration.restore();
    assert.equal(result.restored, 1);
    assert.deepEqual(result.unfinished, []);
    assert.equal(f.notes.get("Notes/example.md"), "before ![photo](../Attachments/photo.png) after");
    assert.ok(f.events.indexOf("publish") < f.events.indexOf("rewrite"));
    assert.ok(f.events.indexOf("rewrite") < f.events.indexOf("delete"));
    assert.equal(f.originals.size, 0);
});

test("collision restoration keeps existing bytes and rewrites to a retargeted stage", async () => {
    const f = fixture();
    f.files.set(f.entry.sourcePath, { bytes: bytes("other local content"), mtime: 99 });
    const result = await f.migration.restore();
    assert.equal(result.restored, 1);
    assert.deepEqual(result.unfinished, []);
    assert.equal(new TextDecoder().decode(f.files.get(f.entry.sourcePath).bytes), "other local content");
    assert.match(f.notes.get("Notes/example.md"), /photo%20%28restored-[0-9a-f]{8}%29\.png/);
});

test("non-embed links produced by the old uploader remove their generated URL labels", async () => {
    const f = fixture();
    f.notes.set("Notes/example.md", `[${f.entry.url}](${f.entry.url})`);
    const result = await f.migration.restore();
    assert.equal(result.restored, 1);
    assert.equal(f.notes.get("Notes/example.md").includes(f.entry.url), false);
});

test("failed publication and mid-note edits preserve legacy originals", async () => {
    const failed = fixture({ noPublication: true });
    const result = await failed.migration.restore();
    assert.equal(result.restored, 0);
    assert.equal(failed.events.includes("rewrite"), false);
    assert.equal(failed.originals.size, 1);
    const changed = fixture({ beforeProcess: source => source + " user edit" });
    const changedResult = await changed.migration.restore();
    assert.equal(changedResult.restored, 0);
    assert.ok(changed.notes.get("Notes/example.md").endsWith(" user edit"));
    assert.ok(changed.notes.get("Notes/example.md").includes(changed.entry.url));
    assert.equal(changed.originals.size, 1);
});

test("missing original without a verified journal stays unfinished", async () => {
    const f = fixture(); f.originals.clear();
    const result = await f.migration.restore();
    assert.equal(result.restored, 0);
    assert.ok(result.unfinished.some(message => message.includes("missing")));
    assert.equal(f.files.size, 0);
});

test("retry recovers a crash between deleting the original and saving final journal state", async () => {
    const f = fixture(); f.failAfterDelete();
    const first = await f.migration.restore();
    assert.equal(first.restored, 0);
    assert.equal(f.originals.size, 0);
    assert.equal(f.preferences.get(journalKey)[f.entry.key].removed, false);
    const second = await f.migration.restore();
    assert.equal(second.restored, 1);
    assert.deepEqual(second.unfinished, []);
    assert.equal(f.preferences.get(journalKey)[f.entry.key].removed, true);
    assert.deepEqual(await f.migration.restore(), { restored: 0, unfinished: [] });
});

test("invalid restoration journals cannot redirect local reads or cloud removals", async () => {
    const f = fixture();
    f.preferences.set(journalKey, { [f.entry.key]: { restored: true, removed: false, objectKey: f.entry.key,
        generation: "12345678901234567890", targetPath: "../outside", size: 1, sha256: "0".repeat(64) } });
    await assert.rejects(f.migration.restore(), /journal is invalid/);
    assert.equal(f.events.includes("delete"), false);
});

test("literal Markdown code examples are preserved and keep the old cloud object", async () => {
    const f = fixture();
    const link = `![photo](${f.entry.url})`;
    const examples = [`\`${link}\``, `\`\`\`markdown\n${link}\n\`\`\``, `~~~\n${link}\n~~~`, `    ${link}`];
    for (const example of examples) assert.equal(module.restoreLegacyLinks(example, f.entry.url, "local.png"), example);
    f.notes.set("Notes/example.md", `${link}\n\n${examples[0]}`);
    const result = await f.migration.restore();
    assert.equal(result.restored, 0);
    assert.ok(f.notes.get("Notes/example.md").startsWith("![photo](../Attachments/photo.png)"));
    assert.ok(f.notes.get("Notes/example.md").endsWith(examples[0]));
    assert.equal(f.originals.size, 1);
});

test("template source guard and archived uploader namespace remain enforced", async () => {
    const protectedNote = fixture();
    protectedNote.notes.set("Notes/example.md", "---\ntemplate: true\n---\n" + protectedNote.notes.get("Notes/example.md"));
    assert.equal((await protectedNote.migration.restore()).restored, 0);
    assert.equal(protectedNote.originals.size, 1);
    const archived = fixture({ entry: { archivedKey: "_archive/s3/2026/09/10/old/photo.png" } });
    assert.equal((await archived.migration.restore()).restored, 1);
    assert.ok(archived.events.includes("head:_archive/s3/2026/09/10/old/photo.png"));
});

test("remaining Canvas/Base URL references retain originals without rewriting native documents", async () => {
    const f = fixture();
    const canvas = JSON.stringify({ nodes: [{ type: "link", url: f.entry.url }] });
    f.notes.set("Diagrams/example.canvas", canvas);
    f.notes.set("Indexes/example.base", `filters:\n  url: ${f.entry.url}\n`);
    assert.equal((await f.migration.restore()).restored, 0);
    assert.equal(f.notes.get("Diagrams/example.canvas"), canvas);
    assert.equal(f.originals.size, 1);
});
