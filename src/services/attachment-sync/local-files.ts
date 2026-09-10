import type { App, DataAdapter } from "obsidian";
import { ATTACHMENT_CHUNK_BYTES, isSafeContentPath, sameFile } from "./model";
import type { FileRevision, IncrementalSha256, LocalFileInfo, LocalStore, SyncRecord } from "./model";
import type { AttachmentDeviceStateStore } from "./device-state";

const STAGING_ROOT = ".tps/attachment-sync/staging.nosync";
const NATIVE_EXTENSIONS = new Set(["md", "canvas", "base"]);
const EXCLUDED_DIRECTORIES = new Set(["node_modules", "plugin development", "plugins", "themes", "trash", "controller attachment sync qa"]);

export interface AttachmentLocalOptions {
    isDesktop: boolean;
    excludedPaths?: () => string[];
    fetch?: typeof fetch;
    createHasher: () => IncrementalSha256;
    randomId?: () => string;
    checkCurrent?: () => void;
}

interface StageEntry {
    id: string;
    path: string;
    revision: FileRevision;
    phase: "downloading" | "prepared" | "trashing" | "promoting";
    written: number;
    expected?: LocalFileInfo | null;
    mtime?: number;
}

interface DeleteEntry { path: string; expected: LocalFileInfo }
interface LocalJournal { version: 1; stages: Record<string, StageEntry>; deletes: Record<string, DeleteEntry> }

type BinaryAdapter = DataAdapter & {
    appendBinary?: (path: string, data: ArrayBuffer, options?: { mtime?: number }) => Promise<void>;
    getBasePath?: () => string;
};

function pathKey(path: string): string { return path.normalize("NFC").toLowerCase(); }
function parentPath(path: string): string { return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ""; }
function basename(path: string): string { return path.slice(path.lastIndexOf("/") + 1); }
function buffer(bytes: Uint8Array): ArrayBuffer {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
function validSnapshot(file: LocalFileInfo | null | undefined, path: string): boolean {
    return file === null || Boolean(file && file.path === path && Number.isSafeInteger(file.size)
        && file.size >= 0 && Number.isFinite(file.mtime) && file.mtime >= 0);
}

/** Reject names that collide or cannot roundtrip on one of the supported filesystems. */
export function safeAttachmentPath(path: string): boolean {
    return isSafeContentPath(path) && path.split("/").every((part) => !/[<>:"|?*]/.test(part)
        && !/[. ]$/.test(part) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}

export function isAttachmentPathEligible(path: string, exclusions: string[] = []): boolean {
    if (!safeAttachmentPath(path)) return false;
    const parts = path.split("/");
    if (parts.slice(0, -1).some((part) => EXCLUDED_DIRECTORIES.has(pathKey(part)))) return false;
    const name = basename(path);
    if (name.includes(".") && NATIVE_EXTENSIONS.has(name.slice(name.lastIndexOf(".") + 1).toLowerCase())) return false;
    const key = pathKey(path);
    return !exclusions.some((exclusion) => {
        const excluded = pathKey(exclusion.trim().replace(/\/+$/, ""));
        return Boolean(excluded) && (key === excluded || key.startsWith(`${excluded}/`));
    });
}

/** Reads exactly one range; a server ignoring Range is rejected before consuming its body. */
export async function readExactResourceRange(
    resourceUrl: string, offset: number, length: number, size: number, fetcher: typeof fetch,
): Promise<Uint8Array> {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0
        || length > ATTACHMENT_CHUNK_BYTES || offset + length > size) throw new Error("Invalid bounded attachment read.");
    if (length === 0) return new Uint8Array(0);
    const controller = new AbortController();
    const timeout = globalThis.setTimeout(() => controller.abort(), 60_000);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
        const response = await fetcher(resourceUrl, {
            headers: { Range: `bytes=${offset}-${offset + length - 1}` }, cache: "no-store", signal: controller.signal,
        });
        if (response.status !== 206 || response.headers.get("Content-Range") !== `bytes ${offset}-${offset + length - 1}/${size}`) {
            throw new Error("This device does not provide exact attachment byte ranges (HTTP 206 and Content-Range required). Large-file sync is paused; no whole-file fallback is used.");
        }
        const encoding = response.headers.get("Content-Encoding");
        const contentLength = response.headers.get("Content-Length");
        if ((encoding && encoding !== "identity") || (contentLength !== null && Number(contentLength) !== length) || !response.body?.getReader) {
            throw new Error("This device cannot provide a bounded, unencoded attachment range stream. Sync is paused.");
        }
        reader = response.body.getReader();
        const output = new Uint8Array(length);
        let written = 0;
        while (true) {
            const next = await reader.read();
            if (next.done) break;
            if (!(next.value instanceof Uint8Array) || written + next.value.byteLength > length) {
                throw new Error("Attachment range exceeded its declared size; transfer was cancelled.");
            }
            output.set(next.value, written);
            written += next.value.byteLength;
        }
        if (written !== length) throw new Error("Attachment range ended before the requested bytes arrived.");
        return output;
    } finally {
        globalThis.clearTimeout(timeout);
        controller.abort();
        if (reader) {
            try { await reader.cancel(); } catch { /* the aborted stream may already be closed */ }
            reader.releaseLock();
        }
    }
}

/** Filesystem transactions are independent from the encrypted-catalog transaction journal. */
export class ObsidianAttachmentLocalStore implements LocalStore {
    private readonly adapter: BinaryAdapter;
    private writes: Promise<unknown> = Promise.resolve();
    private node: { fs: typeof import("fs").promises; path: typeof import("path"); base: string } | null = null;

    constructor(private readonly app: App, private readonly deviceState: AttachmentDeviceStateStore, private readonly options: AttachmentLocalOptions) {
        this.adapter = app.vault.adapter as BinaryAdapter;
    }

    isEligible(path: string): boolean { return isAttachmentPathEligible(path, this.options.excludedPaths?.() || []); }

    async scan(): Promise<{ files: LocalFileInfo[]; complete: boolean }> {
        const files: LocalFileInfo[] = [];
        const seen = new Set<string>();
        const visit = async (directory: string): Promise<void> => {
            await this.assertContained(directory);
            const listed = await this.adapter.list(directory);
            for (const child of [...listed.files, ...listed.folders]) {
                if (parentPath(child) !== directory || !isSafeContentPath(child)) {
                    // Hidden internal files are not enumerated, but malformed/outside paths fail the entire scan.
                    if (parentPath(child) === directory && basename(child).startsWith(".")) continue;
                    throw new Error("Attachment scan returned an unsafe path. Sync is paused.");
                }
            }
            for (const folder of listed.folders) {
                if (this.isExcludedDirectory(folder)) continue;
                await this.assertContained(folder);
                this.assertUnique(seen, folder);
                await visit(folder);
            }
            for (const path of listed.files) {
                if (!this.isEligible(path)) continue;
                this.assertUnique(seen, path);
                const file = await this.stat(path);
                if (!file) throw new Error("An attachment disappeared during scanning. Retry after vault changes settle.");
                files.push(file);
            }
        };
        await visit("");
        return { files: files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0), complete: true };
    }

    async stat(path: string): Promise<LocalFileInfo | null> {
        if (!this.isEligible(path)) throw new Error("Attachment sync refused an excluded or unsafe path.");
        await this.assertContained(path, true);
        const stat = await this.adapter.stat(path);
        if (stat === null) return null;
        if (stat.type !== "file" || !Number.isSafeInteger(stat.size) || stat.size < 0 || !Number.isFinite(stat.mtime) || stat.mtime < 0) {
            throw new Error("Attachment path is not a regular file with valid metadata.");
        }
        return { path, size: stat.size, mtime: stat.mtime };
    }

    async readChunk(path: string, offset: number, length: number): Promise<Uint8Array> {
        const before = await this.stat(path);
        if (!before) throw new Error("Attachment disappeared before reading.");
        const bytes = await this.readBounded(path, offset, length, before.size);
        if (!sameFile(before, await this.stat(path))) throw new Error("Attachment changed during reading. Retry after changes settle.");
        return bytes;
    }

    /** Explicit QA only; the normal scan always excludes this fixture directory. */
    async assertDiagnosticPath(path: string, allowMissing = false): Promise<void> {
        const roots = ["Inbox/Controller Attachment Sync QA", "_archive/Controller Attachment Sync QA"];
        if (!safeAttachmentPath(path) || !(path === "Inbox" || path === "_archive" || roots.some(root => path === root || path.startsWith(`${root}/`)))) {
            throw new Error("Attachment diagnostics are confined to their Inbox and archive fixture directories.");
        }
        await this.assertContained(path, allowMissing);
        await this.assertNoCollision(path);
    }

    /** Explicit QA only; the normal scan always excludes this fixture directory. */
    async readDiagnosticChunk(path: string, offset: number, length: number): Promise<Uint8Array> {
        if (!safeAttachmentPath(path) || !path.startsWith("Inbox/Controller Attachment Sync QA/")) throw new Error("Attachment diagnostics are confined to their Inbox fixture directory.");
        await this.assertContained(path);
        const stat = await this.adapter.stat(path);
        if (!stat || stat.type !== "file") throw new Error("Attachment diagnostic fixture is missing.");
        return this.readBounded(path, offset, length, stat.size);
    }

    createStage(path: string, revision: FileRevision): Promise<string> {
        return this.serial(async () => {
            if (!this.isEligible(path)) throw new Error("Attachment download targets an excluded or unsafe path.");
            this.validateRevision(revision, true);
            const journal = await this.loadJournal();
            const existing = Object.values(journal.stages).find((stage) => stage.path === path && stage.revision.id === revision.id && stage.phase === "downloading");
            if (existing) {
                const stat = await this.adapter.stat(this.stagePath(existing.id));
                if (stat?.type === "file" && stat.size <= revision.size) return existing.id;
                if (stat) throw new Error("Attachment staging file has unexpected content or size.");
                delete journal.stages[existing.id];
            }
            const id = (this.options.randomId?.() || this.randomId()).replace(/-/g, "");
            if (!/^[a-zA-Z0-9_]{8,128}$/.test(id) || journal.stages[id]) throw new Error("Attachment staging identity is invalid or already exists.");
            const stagePath = this.stagePath(id);
            await this.ensureDirectory(STAGING_ROOT, true);
            await this.assertContained(stagePath, true);
            if (await this.adapter.exists(stagePath)) throw new Error("Attachment staging identity collided with an existing file.");
            journal.stages[id] = { id, path, revision, phase: "downloading", written: 0 };
            await this.deviceState.saveJournal(journal);
            this.checkCurrent();
            await this.adapter.writeBinary(stagePath, new ArrayBuffer(0));
            return id;
        });
    }

    appendStage(stageId: string, bytes: Uint8Array): Promise<void> {
        return this.serial(async () => {
            const journal = await this.loadJournal();
            const stage = this.requireStage(journal, stageId);
            if (!this.isEligible(stage.path)) throw new Error("The attachment download is excluded on this device; its staging bytes were preserved.");
            const path = this.stagePath(stageId);
            await this.assertContained(path);
            const stat = await this.adapter.stat(path);
            if (stage.phase !== "downloading" || !stat || stat.type !== "file" || bytes.byteLength > ATTACHMENT_CHUNK_BYTES
                || stat.size + bytes.byteLength > stage.revision.size) throw new Error("Attachment staging append has an invalid offset or size.");
            await this.appendBinary(path, bytes);
            stage.written = stat.size + bytes.byteLength;
            await this.deviceState.saveJournal(journal);
        });
    }

    /** Legacy restoration learns the final hash while streaming, before it can be committed. */
    retargetStage(stageId: string, path: string): Promise<void> {
        return this.serial(async () => {
            if (!this.isEligible(path)) throw new Error("Attachment restoration targets an excluded or unsafe path.");
            const journal = await this.loadJournal();
            const stage = this.requireStage(journal, stageId);
            if (!this.isEligible(stage.path)) throw new Error("The attachment download is excluded on this device; its staging bytes were preserved.");
            if (stage.phase !== "downloading") throw new Error("Only an uncommitted attachment download can change its restoration path.");
            stage.path = path;
            await this.deviceState.saveJournal(journal);
        });
    }

    /** Legacy restoration learns the final hash while streaming, before it can be committed. */
    sealStage(stageId: string, revision: FileRevision): Promise<void> {
        return this.serial(async () => {
            this.validateRevision(revision);
            const journal = await this.loadJournal();
            const stage = this.requireStage(journal, stageId);
            if (!this.isEligible(stage.path)) throw new Error("The attachment download is excluded on this device; its staging bytes were preserved.");
            if (stage.phase !== "downloading" || stage.revision.id !== revision.id || stage.revision.size !== revision.size) {
                throw new Error("Attachment staging seal does not match the downloaded revision.");
            }
            stage.revision = revision;
            await this.deviceState.saveJournal(journal);
        });
    }

    async stageSize(stageId: string): Promise<number> {
        const journal = await this.loadJournal();
        this.requireStage(journal, stageId);
        await this.assertContained(this.stagePath(stageId));
        const stat = await this.adapter.stat(this.stagePath(stageId));
        if (!stat || stat.type !== "file") throw new Error("Attachment staging file disappeared.");
        return stat.size;
    }

    async readStageChunk(stageId: string, offset: number, length: number): Promise<Uint8Array> {
        return this.readBounded(this.stagePath(stageId), offset, length, await this.stageSize(stageId));
    }

    applyStage(stageId: string, path: string, expected: LocalFileInfo | null, mtime: number): Promise<boolean> {
        return this.serial(async () => {
            const journal = await this.loadJournal();
            const stage = this.requireStage(journal, stageId);
            if (stage.path !== path || !this.isEligible(path) || !Number.isFinite(mtime) || mtime < 0) throw new Error("Invalid attachment replacement target.");
            if (!sameFile(await this.stat(path), expected)) return false;
            await this.assertNoCollision(path);
            await this.verifyStage(stage);
            if (!sameFile(await this.stat(path), expected)) return false;
            this.checkCurrent();
            stage.phase = "prepared";
            stage.expected = expected;
            stage.mtime = mtime;
            await this.deviceState.saveJournal(journal);
            return this.finishPromotion(journal, stage);
        });
    }

    discardStage(stageId: string): Promise<void> {
        return this.serial(async () => {
            const journal = await this.loadJournal();
            const stage = this.requireStage(journal, stageId);
            if (stage.phase !== "downloading") throw new Error("An attachment replacement is awaiting recovery; its staging file was preserved.");
            await this.assertContained(this.stagePath(stageId), true);
            if (await this.adapter.exists(this.stagePath(stageId))) {
                this.checkCurrent();
                await this.adapter.remove(this.stagePath(stageId));
            }
            delete journal.stages[stageId];
            await this.deviceState.saveJournal(journal);
        });
    }

    /** A positively superseding cloud record retires unfinished download bytes, never a local file. */
    pruneStages(records: SyncRecord[]): Promise<void> {
        return this.serial(async () => {
            const current = new Map(records.map(record => [record.path, record]));
            const journal = await this.loadJournal();
            for (const stage of Object.values(journal.stages)) {
                if (!this.isEligible(stage.path) || stage.phase !== "downloading" || !/^[0-9a-f]{64}$/.test(stage.revision.sha256)) continue;
                const winner = current.get(stage.path);
                if (!winner || (winner.deleted === false && winner.revision.id === stage.revision.id)) continue;
                const path = this.stagePath(stage.id);
                await this.assertContained(path, true);
                if (await this.adapter.exists(path)) {
                    this.checkCurrent();
                    await this.adapter.remove(path);
                }
                delete journal.stages[stage.id];
                await this.deviceState.saveJournal(journal);
            }
        });
    }

    remove(path: string, expected: LocalFileInfo): Promise<boolean> {
        return this.serial(async () => {
            if (!sameFile(await this.stat(path), expected)) return false;
            const journal = await this.loadJournal();
            journal.deletes[path] = { path, expected };
            await this.deviceState.saveJournal(journal);
            if (!sameFile(await this.stat(path), expected)) {
                delete journal.deletes[path];
                await this.deviceState.saveJournal(journal);
                return false;
            }
            const removed = await this.trash(path, expected);
            delete journal.deletes[path];
            await this.deviceState.saveJournal(journal);
            return removed;
        });
    }

    recover(): Promise<void> {
        return this.serial(async () => {
            const journal = await this.loadJournal();
            for (const stage of Object.values(journal.stages)) {
                if (!this.isEligible(stage.path)) continue;
                if (stage.phase === "downloading") continue;
                const staged = await this.adapter.stat(this.stagePath(stage.id));
                if (!staged) {
                    // A completed rename or a removed staging file is resolved by the engine's durable applying intent.
                    delete journal.stages[stage.id];
                    await this.deviceState.saveJournal(journal);
                    continue;
                }
                await this.verifyStage(stage);
                await this.finishPromotion(journal, stage);
            }
            for (const deletion of Object.values(journal.deletes)) {
                if (!this.isEligible(deletion.path)) continue;
                const current = await this.stat(deletion.path);
                if (sameFile(current, deletion.expected)) await this.trash(deletion.path, deletion.expected);
                // A newly edited file is preserved; the engine determines its subsequent revision.
                delete journal.deletes[deletion.path];
                await this.deviceState.saveJournal(journal);
            }
        });
    }

    private async finishPromotion(journal: LocalJournal, stage: StageEntry): Promise<boolean> {
        const current = await this.stat(stage.path);
        this.checkCurrent();
        if (stage.phase !== "promoting" && current && sameFile(current, stage.expected)) {
            stage.phase = "trashing";
            await this.deviceState.saveJournal(journal);
            if (!sameFile(await this.stat(stage.path), stage.expected)) return this.cancelPromotion(journal, stage);
            if (!await this.trash(stage.path, stage.expected!)) return this.cancelPromotion(journal, stage);
        } else if (current) {
            return this.cancelPromotion(journal, stage);
        } else if (stage.phase === "prepared" && stage.expected !== null) {
            // A user deletion occurred before Controller attempted its own trash operation.
            return this.cancelPromotion(journal, stage);
        }
        this.checkCurrent();
        stage.phase = "promoting";
        await this.deviceState.saveJournal(journal);
        await this.ensureDirectory(parentPath(stage.path));
        await this.assertNoCollision(stage.path);
        if (await this.stat(stage.path)) return this.cancelPromotion(journal, stage);
        await this.appendBinary(this.stagePath(stage.id), new Uint8Array(0), { mtime: stage.mtime });
        await this.assertContained(this.stagePath(stage.id));
        await this.assertContained(stage.path, true);
        if (await this.adapter.exists(stage.path)) return this.cancelPromotion(journal, stage);
        this.checkCurrent();
        await this.adapter.rename(this.stagePath(stage.id), stage.path);
        delete journal.stages[stage.id];
        await this.deviceState.saveJournal(journal);
        return true;
    }

    private async cancelPromotion(journal: LocalJournal, stage: StageEntry): Promise<false> {
        stage.phase = "downloading";
        delete stage.expected;
        delete stage.mtime;
        await this.deviceState.saveJournal(journal);
        return false;
    }

    private async verifyStage(stage: StageEntry): Promise<void> {
        this.validateRevision(stage.revision);
        const stat = await this.adapter.stat(this.stagePath(stage.id));
        if (!stat || stat.type !== "file" || stat.size !== stage.revision.size) throw new Error("Attachment download is incomplete. The existing file was preserved.");
        const hash = this.options.createHasher();
        for (let offset = 0; offset < stat.size; offset += ATTACHMENT_CHUNK_BYTES) {
            hash.update(await this.readBounded(this.stagePath(stage.id), offset, Math.min(ATTACHMENT_CHUNK_BYTES, stat.size - offset), stat.size));
        }
        if (await hash.digestHex() !== stage.revision.sha256) throw new Error("Attachment staging hash did not match. The existing file was preserved.");
    }

    private async readBounded(path: string, offset: number, length: number, size: number): Promise<Uint8Array> {
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0
            || length > ATTACHMENT_CHUNK_BYTES || offset + length > size) throw new Error("Invalid bounded attachment read.");
        await this.assertContained(path);
        if (length === 0) return new Uint8Array(0);
        if (this.options.isDesktop) {
            const node = await this.desktop();
            const handle = await node.fs.open(node.path.join(node.base, path), "r");
            try {
                const before = await handle.stat();
                if (!before.isFile() || before.size !== size) throw new Error("Attachment changed before range reading.");
                const result = new Uint8Array(length);
                let count = 0;
                while (count < length) {
                    const read = await handle.read(result, count, length - count, offset + count);
                    if (!read.bytesRead) throw new Error("Attachment ended before the requested bytes were read.");
                    count += read.bytesRead;
                }
                const after = await handle.stat();
                if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("Attachment changed during range reading.");
                await this.assertContained(path);
                return result;
            } finally { await handle.close(); }
        }
        return readExactResourceRange(this.adapter.getResourcePath(path), offset, length, size, this.options.fetch || globalThis.fetch.bind(globalThis));
    }

    private async appendBinary(path: string, bytes: Uint8Array, options?: { mtime?: number }): Promise<void> {
        if (typeof this.adapter.appendBinary !== "function") throw new Error("Attachment sync requires Obsidian 1.12.3 or later for bounded binary writes.");
        this.checkCurrent();
        await this.adapter.appendBinary(path, buffer(bytes), options);
    }

    private async trash(path: string, expected: LocalFileInfo): Promise<boolean> {
        await this.assertContained(path);
        await this.assertNoCollision(path);
        // Containment and collision checks await filesystem work. Recheck after them, immediately
        // before dispatch, so an edit during those checks cannot be mistaken for our old revision.
        if (!sameFile(await this.stat(path), expected)) return false;
        const indexed = this.app.vault.getAbstractFileByPath(path);
        this.checkCurrent();
        if (indexed) {
            await this.app.fileManager.trashFile(indexed);
            return true;
        }
        // Obsidian's public FileManager handles indexed files. Adapter-only extensions still obey the same setting.
        const vault = this.app.vault as App["vault"] & { getConfig?: (key: string) => unknown };
        const mode = vault.getConfig?.("trashOption");
        if (mode === "system") {
            if (!await this.adapter.trashSystem(path)) {
                if (!sameFile(await this.stat(path), expected)) return false;
                this.checkCurrent();
                await this.adapter.trashLocal(path);
            }
        } else if (mode === "local") await this.adapter.trashLocal(path);
        else if (mode === "none") await this.adapter.remove(path);
        else throw new Error("Attachment sync could not resolve the configured trash behavior for this file type. The file was preserved.");
        return true;
    }

    private async ensureDirectory(path: string, internal = false): Promise<void> {
        let current = "";
        for (const part of path.split("/").filter(Boolean)) {
            current = current ? `${current}/${part}` : part;
            if (!internal && !safeAttachmentPath(current)) throw new Error("Attachment parent directory is unsafe.");
            await this.assertContained(current, true);
            if (!internal) await this.assertNoCollision(current);
            const stat = await this.adapter.stat(current);
            if (stat && stat.type !== "folder") throw new Error("An attachment parent path is occupied by a file.");
            if (!stat) {
                this.checkCurrent();
                await this.adapter.mkdir(current);
            }
        }
    }

    private async assertNoCollision(path: string): Promise<void> {
        let parent = "";
        for (const part of path.split("/")) {
            const stat = parent ? await this.adapter.stat(parent) : { type: "folder" };
            if (!stat) break;
            if (stat.type !== "folder") throw new Error("Attachment path conflicts with a file.");
            const listed = await this.adapter.list(parent);
            const candidate = parent ? `${parent}/${part}` : part;
            const conflicts = [...listed.files, ...listed.folders].filter((existing) => pathKey(existing) === pathKey(candidate) && existing !== candidate);
            if (conflicts.length) throw new Error("Attachment path collides with a differently cased or Unicode-normalized local name. Sync is paused.");
            parent = candidate;
        }
    }

    private isExcludedDirectory(path: string): boolean {
        return path.split("/").some((part) => part.startsWith(".") || EXCLUDED_DIRECTORIES.has(pathKey(part)))
            || (this.options.excludedPaths?.() || []).some((excluded) => {
                const key = pathKey(excluded.trim().replace(/\/+$/, ""));
                return key && (pathKey(path) === key || pathKey(path).startsWith(`${key}/`));
            });
    }

    private assertUnique(seen: Set<string>, path: string): void {
        const key = pathKey(path);
        if (seen.has(key)) throw new Error("Attachment scan found a filesystem name collision. Sync is paused.");
        seen.add(key);
    }

    private async desktop(): Promise<NonNullable<ObsidianAttachmentLocalStore["node"]>> {
        if (!this.options.isDesktop || typeof require !== "function" || !this.adapter.getBasePath) throw new Error("Desktop attachment filesystem access is unavailable.");
        if (!this.node) {
            // No top-level Node import: the mobile bundle never loads filesystem modules.
            const nodeRequire = require;
            const fs: typeof import("fs").promises = nodeRequire("fs").promises;
            const path: typeof import("path") = nodeRequire("path");
            const base = await fs.realpath(this.adapter.getBasePath());
            this.node = { fs, path, base };
        }
        return this.node;
    }

    private async assertContained(path: string, allowMissing = false): Promise<void> {
        if (path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => part === ".." || part === ".")) throw new Error("Attachment path escapes the vault.");
        if (!this.options.isDesktop) return;
        const node = await this.desktop();
        let current = node.base;
        for (const part of path.split("/").filter(Boolean)) {
            current = node.path.join(current, part);
            let stat;
            try { stat = await node.fs.lstat(current); } catch (error) {
                if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return;
                throw error;
            }
            if (stat.isSymbolicLink()) throw new Error("Attachment sync does not follow filesystem symlinks. Sync is paused to preserve the baseline.");
            const resolved = await node.fs.realpath(current);
            const relative = node.path.relative(node.base, resolved);
            if (relative === ".." || relative.startsWith(`..${node.path.sep}`) || node.path.isAbsolute(relative)) throw new Error("Attachment filesystem path escapes the vault.");
        }
    }

    private stagePath(id: string): string {
        if (!/^[a-zA-Z0-9_]{8,128}$/.test(id)) throw new Error("Invalid attachment staging identity.");
        return `${STAGING_ROOT}/${id}.part`;
    }

    private validateRevision(revision: FileRevision, allowUnsealed = false): void {
        if (!revision || typeof revision.id !== "string" || !revision.id || !Number.isSafeInteger(revision.size) || revision.size < 0
            || !Number.isFinite(revision.mtime) || revision.mtime < 0
            || (!allowUnsealed && !/^[0-9a-f]{64}$/.test(revision.sha256)) || !Array.isArray(revision.chunks)) throw new Error("Invalid attachment staging revision.");
    }

    private requireStage(journal: LocalJournal, id: string): StageEntry {
        this.stagePath(id);
        const stage = Object.prototype.hasOwnProperty.call(journal.stages, id) ? journal.stages[id] : undefined;
        if (!stage) throw new Error("Attachment staging journal is missing. Sync is paused.");
        return stage;
    }

    private async loadJournal(): Promise<LocalJournal> {
        const value = await this.deviceState.getJournal<LocalJournal>();
        if (value === null) return { version: 1, stages: Object.create(null), deletes: Object.create(null) };
        if (!value || value.version !== 1 || !value.stages || !value.deletes || typeof value.stages !== "object" || typeof value.deletes !== "object"
            || Array.isArray(value.stages) || Array.isArray(value.deletes)) throw new Error("Attachment local transaction journal is corrupt. Sync is paused.");
        // Structured cloning can restore ordinary object prototypes. Attachment names such as
        // "constructor" remain data keys rather than inherited object members.
        value.stages = Object.assign(Object.create(null), value.stages);
        value.deletes = Object.assign(Object.create(null), value.deletes);
        for (const [id, stage] of Object.entries(value.stages)) {
            if (!stage || stage.id !== id || !isAttachmentPathEligible(stage.path) || !["downloading", "prepared", "trashing", "promoting"].includes(stage.phase)
                || !Number.isSafeInteger(stage.written) || stage.written < 0) throw new Error("Attachment staging journal is corrupt. Sync is paused.");
            this.stagePath(id);
            this.validateRevision(stage.revision, stage.phase === "downloading");
            if (stage.written > stage.revision.size || (stage.phase !== "downloading" && (!validSnapshot(stage.expected, stage.path) || !Number.isFinite(stage.mtime) || stage.mtime! < 0))) throw new Error("Attachment replacement journal is incomplete. Sync is paused.");
        }
        for (const [path, deletion] of Object.entries(value.deletes)) {
            if (!deletion || path !== deletion.path || !isAttachmentPathEligible(path) || !deletion.expected || !validSnapshot(deletion.expected, path)) throw new Error("Attachment deletion journal is corrupt. Sync is paused.");
        }
        return value;
    }

    private randomId(): string {
        return Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
    }

    private serial<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.writes.then(() => { this.checkCurrent(); return operation(); });
        this.writes = result.catch(() => undefined);
        return result;
    }

    private checkCurrent(): void { this.options.checkCurrent?.(); }
}
