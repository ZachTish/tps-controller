import type { App } from "obsidian";
import { AttachmentCrypto, generateRecoveryKey } from "./crypto";
import { AttachmentDeviceStateStore } from "./device-state";
import { ObsidianAttachmentLocalStore, safeAttachmentPath } from "./local-files";
import { ATTACHMENT_CHUNK_BYTES } from "./model";
import type { IncrementalSha256 } from "./model";

const QA_ROOT = "Inbox/Controller Attachment Sync QA";
const REQUIRED_BYTES = 500_000_000;
// One original 16×16 black H.264 frame, generated with ffmpeg; a valid MP4 free box pads it to 500 MB.
const VIDEO_SEED_BASE64 = "AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAMYbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAA+gAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAkJ0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAA+gAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAABAAAAAQAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAPoAAAAAAABAAAAAAG6bWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAABAAAAAQABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABZW1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAASVzdGJsAAAAwXN0c2QAAAAAAAAAAQAAALFhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAABAAEABIAAAASAAAAAAAAAABFUxhdmM2Mi4yOC4xMDIgbGlieDI2NAAAAAAAAAAAAAAAGP//AAAAN2F2Y0MBZAAK/+EAGWdkAAqscgRewEQAAAMABAAAAwAIPEiWEYABAAdo6EOCUsiw/fj4AAAAABBwYXNwAAAAAQAAAAEAAAAUYnRydAAAAAAAABYwAAAAAAAAABhzdHRzAAAAAAAAAAEAAAABAABAAAAAABxzdHNjAAAAAAAAAAEAAAABAAAAAQAAAAEAAAAUc3RzegAAAAAAAALGAAAAAQAAABRzdGNvAAAAAAAAAAEAAANIAAAAYnVkdGEAAABabWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAtaWxzdAAAACWpdG9vAAAAHWRhdGEAAAABAAAAAExhdmY2Mi4xMi4xMDIAAAAIZnJlZQAAAs5tZGF0AAACrwYF//+r3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE2NSByMzIyMiBiMzU2MDVhIC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAyNSAtIGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IGNhYmFjPTEgcmVmPTE2IGRlYmxvY2s9MTowOjAgYW5hbHlzZT0weDM6MHgxMzMgbWU9dW1oIHN1Ym1lPTEwIHBzeT0xIHBzeV9yZD0xLjAwOjAuMDAgbWl4ZWRfcmVmPTEgbWVfcmFuZ2U9MjQgY2hyb21hX21lPTEgdHJlbGxpcz0yIDh4OGRjdD0xIGNxbT0wIGRlYWR6b25lPTIxLDExIGZhc3RfcHNraXA9MSBjaHJvbWFfcXBfb2Zmc2V0PS0yIHRocmVhZHM9MSBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9MCBibHVyYXlfY29tcGF0PTAgY29uc3RyYWluZWRfaW50cmE9MCBiZnJhbWVzPTggYl9weXJhbWlkPTIgYl9hZGFwdD0yIGJfYmlhcz0wIGRpcmVjdD0zIHdlaWdodGI9MSBvcGVuX2dvcD0wIHdlaWdodHA9MiBrZXlpbnQ9MjUwIGtleWludF9taW49MSBzY2VuZWN1dD00MCBpbnRyYV9yZWZyZXNoPTAgcmNfbG9va2FoZWFkPTYwIHJjPWNyZiBtYnRyZWU9MSBjcmY9MzUuMCBxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzdGVwPTQgaXBfcmF0aW89MS40MCBhcT0xOjEuMDAAgAAAAA9liIEAAr/+9bF8Cmrp64E=";


export interface DiagnosticRemoteChunk {
    revisionId: string;
    index: number;
    bytes: Uint8Array;
    sha256: string;
}

export interface AttachmentDiagnosticOptions {
    isDesktop: boolean;
    createHasher: () => IncrementalSha256;
    onProgress?: (message: string) => void;
    fixturePaths?: { video: string; nonMedia: string };
    remoteRoundTrip?: (chunk: DiagnosticRemoteChunk) => Promise<Uint8Array>;
    cleanupRemote?: (revisionId: string, chunkCount: number) => Promise<void>;
    checkCurrent?: () => void;
}

interface DiagnosticCheckpoint {
    version: 1;
    id: string;
    root: string;
    sources: string[];
    synthetic: boolean;
    remote: boolean;
    offsets: number[];
    interrupted: boolean[];
}

export interface AttachmentDiagnosticReport {
    version: 1;
    platform: "desktop" | "mobile";
    userAgent: string;
    startedAt: string;
    completedAt: string;
    localPassed: boolean;
    cloudPassed: boolean;
    syntheticVideo: boolean;
    interruptionResumePassed: boolean;
    hiddenStageRangePassed: boolean;
    maxPlaintextBufferBytes: number;
    maxCiphertextBufferBytes: number;
    processPeakMemoryBytes: null;
    files: { path: string; bytes: number; sha256: string; restoredSha256: string }[];
    limitations: string[];
    error?: string;
}

function asBuffer(bytes: Uint8Array): ArrayBuffer { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer; }

/**
 * User-invoked evidence collection. It never runs at plugin startup, enables sync, or contacts a
 * remote unless an explicit isolated test transport is supplied. Real-device/cloud/memory evidence
 * remains distinct from a desktop or synthetic-extension diagnostic.
 */
export async function runAttachmentMobileDiagnostic(app: App, options: AttachmentDiagnosticOptions): Promise<AttachmentDiagnosticReport> {
    const report: AttachmentDiagnosticReport = {
        version: 1, platform: options.isDesktop ? "desktop" : "mobile",
        userAgent: globalThis.navigator?.userAgent || "unavailable", startedAt: new Date().toISOString(), completedAt: "",
        localPassed: false, cloudPassed: false, syntheticVideo: !options.fixturePaths,
        interruptionResumePassed: false, hiddenStageRangePassed: false, maxPlaintextBufferBytes: 0, maxCiphertextBufferBytes: 0,
        processPeakMemoryBytes: null, files: [], limitations: [],
    };
    const state = new AttachmentDeviceStateStore(app.vault.adapter, "local-diagnostic", "local-diagnostic-v1");
    const local = new ObsidianAttachmentLocalStore(app, state, options);
    const adapter = app.vault.adapter;
    const nativeAppend = adapter.appendBinary?.bind(adapter);
    const append = nativeAppend ? async (path: string, bytes: ArrayBuffer) => {
        await local.assertDiagnosticPath(path);
        options.checkCurrent?.();
        await nativeAppend(path, bytes);
    } : null;
    if (options.isDesktop) report.limitations.push("Desktop execution does not prove iPhone or iPad range support.");
    if (!options.remoteRoundTrip) report.limitations.push("No cloud transport was supplied; actual cloud upload/download and interrupted network recovery remain unverified.");
    if (!options.fixturePaths) report.limitations.push("The video is a generated playable one-frame H.264 MP4 padded with a valid free box to 500 MB; it does not test playback of a long user video.");
    report.limitations.push("Process-wide peak memory and OS suspension/resume must be observed on each physical iPhone and iPad. Buffer limits alone are not physical-device evidence.");
    try {
        if (!append) throw new Error("Obsidian 1.12.3 or later is required for appendBinary.");
        if (options.remoteRoundTrip && !options.cleanupRemote) throw new Error("A diagnostic cloud transport must provide cleanup for its isolated temporary revisions.");
        let checkpoint = await state.getPreference<DiagnosticCheckpoint>("diagnostic-session");
        if (checkpoint) validateCheckpoint(checkpoint);
        if (checkpoint && checkpoint.remote !== Boolean(options.remoteRoundTrip)) throw new Error("Resume the existing diagnostic with its original local/cloud transport before starting another.");
        if (!checkpoint) {
            const id = Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, "0")).join("");
            const root = `${QA_ROOT}/${id}`;
            checkpoint = {
                version: 1, id, root,
                sources: options.fixturePaths ? [options.fixturePaths.video, options.fixturePaths.nonMedia] : [`${root}/source.mp4`, `${root}/source.tps-sync-qa`],
                synthetic: !options.fixturePaths, remote: Boolean(options.remoteRoundTrip), offsets: [0, 0], interrupted: [false, false],
            };
            validateCheckpoint(checkpoint);
            await mkdirTree(app, local, root, options.checkCurrent);
            await state.setPreference("diagnostic-session", checkpoint);
        }
        report.syntheticVideo = checkpoint.synthetic;
        // Probe the same hidden staging reader that the production download verifier uses, before
        // spending time creating large fixtures. Mobile resource handlers can vary by path/extension.
        const probe = new Uint8Array(ATTACHMENT_CHUNK_BYTES);
        for (let index = 0; index < probe.length; index++) probe[index] = index % 251;
        const probeHash = options.createHasher(); probeHash.update(probe);
        const probeSha = await probeHash.digestHex();
        const probeRevision = { id: `diagnostic-stage-${checkpoint.id}`, size: probe.length, mtime: 1, sha256: probeSha, chunks: [{ index: 0, size: probe.length, sha256: probeSha }] };
        let probeStage = await local.createStage(`Inbox/Attachment sync staging diagnostic ${checkpoint.id}.bin`, probeRevision);
        const probeSize = await local.stageSize(probeStage);
        if (probeSize !== 0 && probeSize !== probe.length) {
            await local.discardStage(probeStage);
            probeStage = await local.createStage(`Inbox/Attachment sync staging diagnostic ${checkpoint.id}.bin`, probeRevision);
        }
        if (await local.stageSize(probeStage) === 0) await local.appendStage(probeStage, probe);
        const probeRead = options.createHasher(); probeRead.update(await local.readStageChunk(probeStage, 0, probe.length));
        if (await probeRead.digestHex() !== probeSha) throw new Error("The hidden attachment staging range probe did not match its written bytes.");
        await local.discardStage(probeStage);
        report.hiddenStageRangePassed = true;
        for (let fileIndex = 0; fileIndex < checkpoint.sources.length; fileIndex++) {
            const source = checkpoint.sources[fileIndex];
            await local.assertDiagnosticPath(source, true);
            if (checkpoint.synthetic) await makeFixture(app, local, source, fileIndex, append, options.onProgress, options.checkCurrent);
            const sourceStat = await adapter.stat(source);
            if (!sourceStat || sourceStat.type !== "file" || sourceStat.size < REQUIRED_BYTES) throw new Error("Each diagnostic fixture must be a local file at least 500,000,000 bytes in size.");
            const output = `${checkpoint.root}/restored-${fileIndex}.tps-sync-qa`;
            let outputStat = await adapter.stat(output);
            if (!outputStat) {
                await local.assertDiagnosticPath(output, true);
                options.checkCurrent?.();
                await adapter.writeBinary(output, new ArrayBuffer(0));
                outputStat = (await adapter.stat(output))!;
            }
            if (outputStat.size !== checkpoint.offsets[fileIndex]) {
                // A crash between append and the durable checkpoint invalidates the incomplete prefix.
                await local.assertDiagnosticPath(output);
                options.checkCurrent?.();
                await adapter.writeBinary(output, new ArrayBuffer(0));
                checkpoint.offsets[fileIndex] = 0;
                await state.setPreference("diagnostic-session", checkpoint);
            }
            const sourceHash = options.createHasher();
            const restoredHash = options.createHasher();
            const encryption = await AttachmentCrypto.fromRecoveryKey(generateRecoveryKey());
            const revisionId = `diagnostic-${checkpoint.id}-${fileIndex}`;
            let offset = 0;
            let resumed = checkpoint.interrupted[fileIndex];
            while (offset < sourceStat.size) {
                options.checkCurrent?.();
                const length = Math.min(ATTACHMENT_CHUNK_BYTES, sourceStat.size - offset);
                const bytes = await local.readDiagnosticChunk(source, offset, length);
                sourceHash.update(bytes);
                report.maxPlaintextBufferBytes = Math.max(report.maxPlaintextBufferBytes, bytes.byteLength);
                const index = Math.floor(offset / ATTACHMENT_CHUNK_BYTES);
                const chunkHash = options.createHasher(); chunkHash.update(bytes);
                const sha256 = await chunkHash.digestHex();
                if (offset < checkpoint.offsets[fileIndex]) {
                    const restored = await local.readDiagnosticChunk(output, offset, length);
                    const existingHash = options.createHasher(); existingHash.update(restored);
                    if (await existingHash.digestHex() !== sha256) throw new Error("The saved diagnostic prefix does not match its source; it was preserved for inspection.");
                    restoredHash.update(restored);
                } else {
                    const context = { kind: "chunk" as const, collectionId: checkpoint.id, revision: revisionId, index };
                    const encrypted = await encryption.encrypt(bytes, context);
                    report.maxCiphertextBufferBytes = Math.max(report.maxCiphertextBufferBytes, encrypted.byteLength);
                    let restored = await encryption.decrypt(encrypted, context);
                    if (options.remoteRoundTrip) restored = await options.remoteRoundTrip({ revisionId, index, bytes: restored, sha256 });
                    const restoredChunkHash = options.createHasher(); restoredChunkHash.update(restored);
                    if (restored.byteLength !== length || await restoredChunkHash.digestHex() !== sha256) throw new Error("The diagnostic roundtrip changed a chunk.");
                    await append(output, asBuffer(restored));
                    checkpoint.offsets[fileIndex] = offset + length;
                    await state.setPreference("diagnostic-session", checkpoint);
                    restoredHash.update(restored);
                }
                offset += length;
                options.onProgress?.(`Checking ${fileIndex ? "non-media" : "video-extension"} transfer: ${Math.floor(offset / sourceStat.size * 100)}%`);
                if (!checkpoint.interrupted[fileIndex] && index === 3) {
                    // End this transfer phase and reopen its durable checkpoint before continuing.
                    checkpoint.interrupted[fileIndex] = true;
                    await state.setPreference("diagnostic-session", checkpoint);
                    await state.close();
                    checkpoint = (await state.getPreference<DiagnosticCheckpoint>("diagnostic-session"))!;
                    validateCheckpoint(checkpoint);
                    const resumedStat = await adapter.stat(output);
                    if (!resumedStat || resumedStat.size !== checkpoint.offsets[fileIndex]) throw new Error("The diagnostic could not reopen its interrupted transfer checkpoint.");
                    resumed = true;
                }
            }
            if (!resumed) throw new Error("The diagnostic did not exercise its interruption checkpoint.");
            const actualSource = await adapter.stat(source);
            if (!actualSource || actualSource.size !== sourceStat.size || actualSource.mtime !== sourceStat.mtime) throw new Error("A diagnostic source changed during the transfer.");
            const sourceSha = await sourceHash.digestHex();
            const restoredSha = await restoredHash.digestHex();
            if (sourceSha !== restoredSha) throw new Error("The final diagnostic file hashes do not match.");
            // Read the written output again so the evidence covers persisted filesystem bytes.
            const diskHash = options.createHasher();
            for (let position = 0; position < sourceStat.size; position += ATTACHMENT_CHUNK_BYTES) {
                diskHash.update(await local.readDiagnosticChunk(output, position, Math.min(ATTACHMENT_CHUNK_BYTES, sourceStat.size - position)));
            }
            if (await diskHash.digestHex() !== sourceSha) throw new Error("The persisted diagnostic output has an incorrect hash.");
            report.files.push({ path: source, bytes: sourceStat.size, sha256: sourceSha, restoredSha256: restoredSha });
            if (options.cleanupRemote) await options.cleanupRemote(revisionId, Math.ceil(sourceStat.size / ATTACHMENT_CHUNK_BYTES));
        }
        report.localPassed = true;
        report.cloudPassed = Boolean(options.remoteRoundTrip);
        report.interruptionResumePassed = true;
        await mkdirTree(app, local, "_archive/Controller Attachment Sync QA", options.checkCurrent);
        const archivePath = `_archive/Controller Attachment Sync QA/${checkpoint.id}`;
        if (await adapter.exists(archivePath)) throw new Error("The diagnostic archive destination already exists; scratch files were preserved.");
        await local.assertDiagnosticPath(checkpoint.root);
        await local.assertDiagnosticPath(archivePath, true);
        options.checkCurrent?.();
        await adapter.rename(checkpoint.root, archivePath);
        for (const file of report.files) {
            if (file.path.startsWith(`${checkpoint.root}/`)) file.path = archivePath + file.path.slice(checkpoint.root.length);
        }
        await state.setPreference("diagnostic-session", null);
    } catch (error) {
        report.error = error instanceof Error ? error.message : "Attachment diagnostic failed.";
        report.limitations.push("The transfer remains in the excluded Inbox QA directory; rerun to resume after resolving the failure.");
    } finally {
        report.completedAt = new Date().toISOString();
        await state.close();
    }
    return report;
}

function validateCheckpoint(checkpoint: DiagnosticCheckpoint): void {
    if (!checkpoint || checkpoint.version !== 1 || !/^[0-9a-f]{32}$/.test(checkpoint.id)
        || checkpoint.root !== `${QA_ROOT}/${checkpoint.id}` || !Array.isArray(checkpoint.sources) || checkpoint.sources.length !== 2
        || checkpoint.sources.some(path => !safeAttachmentPath(path) || !path.startsWith(`${QA_ROOT}/`))
        || !Array.isArray(checkpoint.offsets) || checkpoint.offsets.length !== 2 || checkpoint.offsets.some(offset => !Number.isSafeInteger(offset) || offset < 0)
        || !Array.isArray(checkpoint.interrupted) || checkpoint.interrupted.length !== 2) throw new Error("The attachment diagnostic checkpoint is invalid. No fixture was changed.");
}

async function mkdirTree(app: App, local: ObsidianAttachmentLocalStore, path: string, checkCurrent?: () => void): Promise<void> {
    let current = "";
    for (const part of path.split("/")) {
        current = current ? `${current}/${part}` : part;
        await local.assertDiagnosticPath(current, true);
        const existing = await app.vault.adapter.stat(current);
        if (existing && existing.type !== "folder") throw new Error("A diagnostic directory is occupied by a file.");
        if (!existing) { checkCurrent?.(); await app.vault.adapter.mkdir(current); }
    }
}

async function makeFixture(
    app: App, local: ObsidianAttachmentLocalStore, path: string, salt: number,
    append: (path: string, data: ArrayBuffer) => Promise<void>, onProgress?: (message: string) => void,
    checkCurrent?: () => void,
): Promise<void> {
    const stat = await app.vault.adapter.stat(path);
    if (stat?.size === REQUIRED_BYTES) return;
    if (stat && (stat.type !== "file" || stat.size > REQUIRED_BYTES)) throw new Error("The synthetic diagnostic fixture has unexpected content; it was preserved.");
    let offset = stat?.size || 0;
    if (!stat || offset % ATTACHMENT_CHUNK_BYTES !== 0) {
        await local.assertDiagnosticPath(path, true);
        checkCurrent?.();
        await app.vault.adapter.writeBinary(path, new ArrayBuffer(0));
        offset = 0;
    }
    const bytes = new Uint8Array(ATTACHMENT_CHUNK_BYTES);
    for (let index = 0; index < bytes.length; index++) bytes[index] = (index * 31 + salt * 71) % 251;
    while (offset < REQUIRED_BYTES) {
        checkCurrent?.();
        const length = Math.min(ATTACHMENT_CHUNK_BYTES, REQUIRED_BYTES - offset);
        if (salt === 0) {
            const seed = Uint8Array.from(atob(VIDEO_SEED_BASE64), value => value.charCodeAt(0));
            // Restore the reusable prefix after its first use; only the first chunk has MP4 headers.
            for (let index = 0; index < seed.length + 8; index++) bytes[index] = index * 31 % 251;
            if (offset === 0) {
                bytes.set(seed);
                new DataView(bytes.buffer).setUint32(seed.length, REQUIRED_BYTES - seed.length, false);
                bytes.set([0x66, 0x72, 0x65, 0x65], seed.length + 4);
            }
        }
        await append(path, asBuffer(bytes.subarray(0, length)));
        offset += length;
        onProgress?.(`Preparing 500 MB ${salt ? "non-media" : "video-extension"} fixture: ${Math.floor(offset / REQUIRED_BYTES * 100)}%`);
    }
}
