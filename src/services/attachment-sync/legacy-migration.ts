import { App, TFile } from "obsidian";
import type { S3agleAttachmentAutomationSettings } from "../../types";
import { canAutomaticallyMutateSourceViaGcm, canAutomaticallyMutateViaGcm } from "../../tps-gcm-api";
import { ATTACHMENT_CHUNK_BYTES, isSafeContentPath, type FileRevision } from "./model";
import { createSha256, randomId } from "./crypto";
import type { AttachmentSyncEngine } from "./engine";
import type { GcsAttachmentRemote } from "./gcs-remote";
import type { AttachmentDeviceStateStore } from "./device-state";
import type { ObsidianAttachmentLocalStore } from "./local-files";

interface LegacyUpload {
    key: string;
    url: string;
    sourcePath: string;
    uploadedAt: number;
    archivedKey?: string;
}
export interface LegacyMigrationItem extends LegacyUpload { objectKey: string; size: number | null; generation: string | null; }
export interface LegacyMigrationPreview { items: LegacyMigrationItem[]; unfinished: string[]; }
interface LegacyJob {
    objectKey: string;
    generation: string;
    targetPath: string;
    size: number;
    sha256: string;
    restored: boolean;
    removed: boolean;
}
interface MigrationContext {
    engine: AttachmentSyncEngine;
    state: AttachmentDeviceStateStore;
    remote: GcsAttachmentRemote;
    local: ObsidianAttachmentLocalStore;
    bucket: string;
    prefix: string;
    check(): void;
}
const JOURNAL_KEY = "legacy-restoration-v1";

export function legacyPublicUrl(key: string, legacy: Partial<S3agleAttachmentAutomationSettings>): string {
    const base = String(legacy.contentUrl || legacy.endpoint || "").replace(/\/+$/, "");
    const url = new URL(base);
    if (url.username || url.password || url.search || url.hash || !["https:", "http:"].includes(url.protocol)) throw new Error("The legacy public URL configuration is invalid.");
    const encodedKey = key.split("/").map(encodeURIComponent).join("/");
    const authority = legacy.useBucketSubdomain ? `${legacy.bucket}.${url.host}` : url.host;
    const path = [url.pathname.replace(/^\/+|\/+$/g, ""), legacy.useBucketSubdomain ? "" : legacy.bucket, encodedKey].filter(Boolean).join("/");
    return `${url.protocol}//${authority}/${path}`;
}

export function relativeAttachmentUrl(notePath: string, attachmentPath: string): string {
    const from = notePath.split("/").slice(0, -1);
    const to = attachmentPath.split("/");
    while (from.length && to.length && from[0] === to[0]) { from.shift(); to.shift(); }
    return [...from.map(() => ".."), ...to].map(part => part === ".." ? part : encodeURIComponent(part).replace(/[!'()*]/g,
        char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)).join("/");
}

/** Only ordinary Markdown link destinations emitted by the retired uploader are rewritten. */
export function restoreLegacyLinks(content: string, url: string, replacement: string): string {
    const codeRanges = markdownCodeRanges(content);
    const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(!?)\\[([^\\]\\n]*)\\]\\((?:<${escaped}>|${escaped})(?=\\s|\\))`, "g");
    return content.replace(pattern, (match, embed: string, label: string, offset: number) => {
        if (codeRanges.some(([start, end]) => offset >= start && offset < end)) return match;
        // The retired uploader generated [URL](URL) for ordinary links. Keeping that URL
        // as the label would leave a false remaining reference and prevent safe retirement.
        const readable = label === url ? decodeURIComponent(replacement.split("/").pop() || "Attachment").replace(/[\\\[\]]/g, "\\$&") : label;
        return `${embed}[${readable}](${replacement}`;
    });
}

/** Conservatively preserve literal examples; an untouched URL keeps its cloud original. */
function markdownCodeRanges(content: string): Array<[number, number]> {
    const ranges: Array<[number, number]> = [];
    let fence: { start: number; character: string; length: number } | null = null;
    let offset = 0;
    for (const line of content.match(/[^\n]*(?:\n|$)/g) || []) {
        if (!line) continue;
        const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
        if (fence) {
            if (marker && marker[1][0] === fence.character && marker[1].length >= fence.length
                && line.slice(marker[0].length).trim() === "") {
                ranges.push([fence.start, offset + line.length]); fence = null;
            }
        } else if (marker) fence = { start: offset, character: marker[1][0], length: marker[1].length };
        else if (/^(?: {4}|\t)/.test(line)) ranges.push([offset, offset + line.length]);
        offset += line.length;
    }
    if (fence) ranges.push([fence.start, content.length]);
    const runs = /`+/g;
    let opening: RegExpExecArray | null;
    while ((opening = runs.exec(content))) {
        if (ranges.some(([start, end]) => opening!.index >= start && opening!.index < end)) continue;
        const start = opening.index;
        const length = opening[0].length;
        const afterOpening = runs.lastIndex;
        let closing: RegExpExecArray | null;
        let found = false;
        while ((closing = runs.exec(content))) {
            if (closing[0].length !== length) continue;
            ranges.push([start, runs.lastIndex]); found = true; break;
        }
        if (!found) runs.lastIndex = afterOpening;
    }
    return ranges;
}

export class AttachmentLegacyMigration {
    constructor(private readonly app: App, private readonly legacy: S3agleAttachmentAutomationSettings,
        private readonly context: MigrationContext) {}

    async preview(): Promise<LegacyMigrationPreview> {
        const { local, remote, check } = this.context;
        check();
        const manifestPath = ".tps/s3-upload-manifest.json";
        if (!await this.app.vault.adapter.exists(manifestPath)) return { items: [], unfinished: ["No legacy upload manifest exists on this device. Import the uploader device's recognized records before retiring remaining public objects."] };
        const parsed: unknown = JSON.parse(await this.app.vault.adapter.read(manifestPath));
        if (!Array.isArray(parsed)) throw new Error("The legacy upload manifest is invalid; no objects were changed.");
        if (this.legacy.bucket !== this.context.bucket) throw new Error("Legacy restoration requires the original bucket connection.");
        const items: LegacyMigrationItem[] = [];
        const unfinished: string[] = [];
        const seen = new Set<string>();
        for (const value of parsed) {
            check();
            if (!value || typeof value !== "object" || typeof value.key !== "string" || typeof value.url !== "string"
                || typeof value.sourcePath !== "string" || !isSafeContentPath(value.key) || !local.isEligible(value.sourcePath)) {
                unfinished.push("An invalid or excluded legacy manifest entry was left unchanged."); continue;
            }
            if (seen.has(value.key)) continue;
            seen.add(value.key);
            try {
                if (legacyPublicUrl(value.key, this.legacy) !== value.url) throw new Error("URL does not match the recorded bucket object");
                const objectKey = value.archivedKey || value.key;
                if (typeof objectKey !== "string" || !isSafeContentPath(objectKey)
                    || (objectKey !== value.key && !objectKey.endsWith(`/${value.key}`))
                    || objectKey === this.context.prefix || objectKey.startsWith(`${this.context.prefix}/`)) {
                    throw new Error("Object is outside the legacy namespace");
                }
                const head = await remote.headLegacyObject(objectKey);
                items.push({ key: value.key, url: value.url, sourcePath: value.sourcePath,
                    uploadedAt: Number.isFinite(value.uploadedAt) ? Math.max(0, value.uploadedAt) : 0,
                    archivedKey: value.archivedKey, objectKey,
                    size: head?.size ?? null, generation: head?.generation ?? null });
                if (!head) unfinished.push(`${value.sourcePath}: the recorded cloud object is missing.`);
            } catch (error) {
                unfinished.push(`${value.sourcePath}: ${error instanceof Error ? error.message : "could not inspect legacy object"}`);
            }
        }
        return { items, unfinished };
    }

    async restore(): Promise<{ restored: number; unfinished: string[] }> {
        const { local, remote, state, engine, check } = this.context;
        const preview = await this.preview();
        const savedJournal = await state.getPreference<unknown>(JOURNAL_KEY);
        const rawJournal = savedJournal === undefined || savedJournal === null ? {} : savedJournal;
        if (!rawJournal || typeof rawJournal !== "object" || Array.isArray(rawJournal)) throw new Error("The legacy restoration journal is invalid.");
        const journal: Record<string, LegacyJob> = Object.create(null);
        for (const [key, value] of Object.entries(rawJournal)) {
            if (!isSafeContentPath(key) || !value || typeof value !== "object" || Array.isArray(value)
                || !isSafeContentPath(value.objectKey) || !local.isEligible(value.targetPath)
                || typeof value.generation !== "string" || !/^[1-9][0-9]*$/.test(value.generation)
                || !Number.isSafeInteger(value.size) || value.size < 0 || !/^[a-f0-9]{64}$/.test(value.sha256)
                || typeof value.restored !== "boolean" || typeof value.removed !== "boolean" || (value.removed && !value.restored)) {
                throw new Error("The legacy restoration journal is invalid.");
            }
            journal[key] = value as LegacyJob;
        }
        const missingMessage = (item: LegacyMigrationItem) => `${item.sourcePath}: the recorded cloud object is missing.`;
        const missingMessages = new Set(preview.items.filter(item => item.size === null).map(missingMessage));
        const unfinished = preview.unfinished.filter(message => !missingMessages.has(message));
        let restored = 0;
        for (const item of preview.items) {
            check();
            let job = journal[item.key];
            if (job?.removed) continue;
            if ((item.size === null || !item.generation) && !job?.restored) {
                unfinished.push(missingMessage(item)); continue;
            }
            if (job && (job.objectKey !== item.objectKey || (item.generation !== null && job.generation !== item.generation))) {
                unfinished.push(`${item.sourcePath}: the old cloud object changed during restoration.`); continue;
            }
            try {
                if (!job?.restored) {
                    const revision: FileRevision = { id: randomId(), size: item.size, mtime: item.uploadedAt || Date.now(), sha256: "", chunks: [] };
                    const stage = await local.createStage(item.sourcePath, revision);
                    try {
                        const hash = createSha256();
                        for (let offset = 0, index = 0; offset < item.size; offset += ATTACHMENT_CHUNK_BYTES, index++) {
                            check();
                            const bytes = await remote.readLegacyRange(item.objectKey, offset, Math.min(ATTACHMENT_CHUNK_BYTES, item.size - offset), item.generation);
                            hash.update(bytes);
                            const chunkHash = createSha256(); chunkHash.update(bytes);
                            revision.chunks.push({ index, size: bytes.length, sha256: await chunkHash.digestHex() });
                            await local.appendStage(stage, bytes);
                        }
                        revision.sha256 = await hash.digestHex();
                        const targetPath = await this.restorationPath(item.sourcePath, revision.sha256);
                        await local.retargetStage(stage, targetPath);
                        await local.sealStage(stage, revision);
                        // Save identity before installing; a crash can safely re-verify the selected target.
                        job = { objectKey: item.objectKey, generation: item.generation, targetPath,
                            size: item.size, sha256: revision.sha256, restored: false, removed: false };
                        journal[item.key] = job;
                        await state.setPreference(JOURNAL_KEY, journal);
                        check();
                        const existing = await local.stat(targetPath);
                        if (existing) {
                            if (existing.size !== item.size || await this.hashFile(targetPath, existing.size) !== revision.sha256) {
                                throw new Error("The restoration destination changed; retry the preview.");
                            }
                            await local.discardStage(stage);
                        } else if (!await local.applyStage(stage, targetPath, null, revision.mtime)) {
                            throw new Error("The restoration destination changed; retry the preview.");
                        }
                        job.restored = true;
                        await state.setPreference(JOURNAL_KEY, journal);
                    } catch (error) {
                        await local.discardStage(stage).catch(() => {});
                        throw error;
                    }
                }
                if (!job) throw new Error("Missing restoration journal.");
                check();
                const current = await local.stat(job.targetPath);
                if (!current || current.size !== job.size || await this.hashFile(job.targetPath, current.size) !== job.sha256) {
                    throw new Error("Restored local content changed; its legacy cloud object was retained.");
                }
                await engine.run();
                check();
                const snapshot = await remote.getCatalog();
                const record = snapshot?.catalog.records[job.targetPath];
                if (!record || record.deleted !== false || record.revision.sha256 !== job.sha256) {
                    throw new Error("Encrypted publication is not yet verified; legacy links were retained.");
                }
                await this.restoreNoteLinks(item.url, job.targetPath);
                check();
                const remaining = await this.referencePaths(item.url);
                if (remaining.length) throw new Error(`Legacy URLs remain in ${remaining.length} notes; cloud original retained.`);
                const latest = await remote.getCatalog();
                const latestRecord = latest?.catalog.records[job.targetPath];
                const latestLocal = await local.stat(job.targetPath);
                if (!latestRecord || latestRecord.deleted !== false || latestRecord.revision.sha256 !== job.sha256
                    || !latestLocal || await this.hashFile(job.targetPath, latestLocal.size) !== job.sha256) {
                    throw new Error("Attachment changed before legacy removal; cloud original retained.");
                }
                check();
                await remote.deleteLegacyObject(job.objectKey, job.generation);
                job.removed = true;
                await state.setPreference(JOURNAL_KEY, journal);
                restored++;
            } catch (error) {
                unfinished.push(`${item.sourcePath}: ${error instanceof Error ? error.message : "restoration failed"}`);
            }
        }
        return { restored, unfinished };
    }

    private notes(): TFile[] {
        return this.app.vault.getMarkdownFiles().filter(file => isSafeContentPath(file.path)
            && !file.path.split("/").some(part => part === "Plugin Development" || part === "node_modules"));
    }

    private async referencePaths(url: string): Promise<string[]> {
        const found: string[] = [];
        // Canvas/Base documents may also reference an old public URL. They are never
        // rewritten as Markdown, but their references must retain the public original.
        const documents = this.app.vault.getFiles().filter(file => /\.(md|canvas|base)$/i.test(file.path)
            && isSafeContentPath(file.path) && !file.path.split("/").some(part => part === "Plugin Development" || part === "node_modules"));
        for (const note of documents) {
            this.context.check();
            if ((await this.app.vault.read(note)).includes(url)) found.push(note.path);
        }
        return found;
    }

    private async restoreNoteLinks(url: string, path: string): Promise<void> {
        for (const note of this.notes()) {
            this.context.check();
            const before = await this.app.vault.read(note);
            if (!before.includes(url) || !await canAutomaticallyMutateViaGcm(this.app, note)) continue;
            const next = restoreLegacyLinks(before, url, relativeAttachmentUrl(note.path, path));
            if (next === before) continue;
            this.context.check();
            await this.app.vault.process(note, current => current === before
                && canAutomaticallyMutateSourceViaGcm(this.app, current) ? next : current);
        }
    }

    private async hashFile(path: string, size: number): Promise<string> {
        const hash = createSha256();
        for (let offset = 0; offset < size; offset += ATTACHMENT_CHUNK_BYTES) {
            this.context.check();
            hash.update(await this.context.local.readChunk(path, offset, Math.min(ATTACHMENT_CHUNK_BYTES, size - offset)));
        }
        return hash.digestHex();
    }

    private async restorationPath(sourcePath: string, sha256: string): Promise<string> {
        const local = this.context.local;
        const original = await local.stat(sourcePath);
        if (!original || await this.hashFile(sourcePath, original.size) === sha256) return sourcePath;
        const dot = sourcePath.lastIndexOf(".");
        const split = dot > sourcePath.lastIndexOf("/") ? dot : sourcePath.length;
        for (let suffix = 0; suffix < 1000; suffix++) {
            const candidate = `${sourcePath.slice(0, split)} (restored-${sha256.slice(0, 8)}${suffix ? `-${suffix}` : ""})${sourcePath.slice(split)}`;
            const info = await local.stat(candidate);
            if (!info || await this.hashFile(candidate, info.size) === sha256) return candidate;
        }
        throw new Error("No available restoration path.");
    }
}
