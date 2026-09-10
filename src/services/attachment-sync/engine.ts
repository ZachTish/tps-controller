import {
    ATTACHMENT_CHUNK_BYTES,
    AttachmentCatalog,
    AttachmentSyncOptions,
    AttachmentSyncState,
    CatalogSnapshot,
    ChangeStamp,
    FileRevision,
    LocalFileInfo,
    LocalStore,
    PendingOperation,
    RemoteStore,
    StateStore,
    SyncRecord,
    SyncRunResult,
    compareChanges,
    isSafeContentPath,
    sameFile,
} from "./model";

export class AttachmentSyncError extends Error {
    constructor(readonly code: string, message: string) {
        super(message);
        this.name = "AttachmentSyncError";
    }
}

class SourceChanged extends AttachmentSyncError {
    constructor() { super("source-changed", "The local file changed during synchronization."); }
}

const own = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
const dictionary = <T>(value?: Record<string, T>): Record<string, T> => Object.assign(Object.create(null), value || {});
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const timestamp = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const identifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);

/** A single-flight, portable reconciliation engine. All I/O and cryptography are injected. */
export class AttachmentSyncEngine {
    private activeRun: Promise<SyncRunResult> | null = null;
    private generation = 0;
    private state!: AttachmentSyncState;
    private readonly now: () => number;
    private readonly reservationLifetime: number;
    private readonly maxCasAttempts: number;

    constructor(
        private readonly remote: RemoteStore,
        private readonly local: LocalStore,
        private readonly stateStore: StateStore,
        private readonly options: AttachmentSyncOptions,
    ) {
        this.now = options.now || Date.now;
        this.reservationLifetime = Math.max(60_000, options.reservationLifetimeMs || 24 * 60 * 60_000);
        this.maxCasAttempts = Math.max(1, Math.floor(options.maxCasAttempts || 8));
    }

    run(): Promise<SyncRunResult> {
        if (this.activeRun) return this.activeRun;
        const generation = this.generation;
        const run = this.execute(generation);
        this.activeRun = run;
        void run.finally(() => {
            if (this.activeRun === run) this.activeRun = null;
        }).catch(() => {});
        return run;
    }

    /** Invalidates pending work at its next I/O boundary. Already issued I/O is never assumed cancelled. */
    stop(): void { this.generation += 1; }

    private check(generation: number): void {
        if (generation !== this.generation) throw new AttachmentSyncError("cancelled", "Attachment synchronization was stopped.");
    }

    private async execute(generation: number): Promise<SyncRunResult> {
        const loaded = await this.stateStore.load();
        this.check(generation);
        this.state = loaded ? this.validateState(loaded) : {
            version: 1,
            collectionId: this.options.collectionId,
            deviceId: this.newId(),
            enrolled: false,
            lastCatalogSequence: 0,
            clock: { time: 0, counter: 0 },
            baseline: dictionary(),
            pending: dictionary(),
            applying: dictionary(),
        };
        if (!loaded) await this.persist(generation);
        await this.local.recover();
        this.check(generation);
        await this.recoverApplications(generation);

        let snapshot = await this.readCatalog(generation, true);
        const scan = await this.completeScan(generation);
        // Assign timestamps before observing previously unseen cloud changes. An offline edit
        // must not become newer merely because reconnecting revealed a more recent cloud edit.
        await this.captureChanges(scan, generation);
        this.observeCatalog(snapshot.catalog);
        await this.persist(generation);
        const result: SyncRunResult = { uploaded: 0, downloaded: 0, deleted: 0, retired: 0, pending: 0 };

        snapshot = await this.mutateCatalog(generation, (catalog) => {
            let changed = false;
            for (const reservation of Object.values(catalog.uploads)) {
                if (reservation.expiresAt > this.now()) continue;
                this.retire(catalog, reservation.revisionId, reservation.chunkCount);
                changed = true;
            }
            return changed;
        });

        for (const path of Object.keys(this.state.pending).sort()) {
            const pending = this.state.pending[path];
            if (!pending || !this.eligible(path)) continue;
            this.check(generation);
            try {
                if (pending.kind === "put") {
                    if (await this.upload(pending, generation)) result.uploaded += 1;
                } else if (await this.publishDeletion(pending, generation)) {
                    // This device already deleted it. The count reflects local deletions applied below.
                }
            } catch (error) {
                if (!(error instanceof SourceChanged)) throw error;
                await this.abandon(pending, generation);
                delete this.state.pending[path];
                await this.persist(generation);
                this.event("source-changed", { path });
            }
        }

        snapshot = await this.readCatalog(generation);
        if (this.local.pruneStages) {
            this.check(generation);
            await this.local.pruneStages(Object.values(snapshot.catalog.records));
            this.check(generation);
        }
        // Re-scan before downloads to notice edits made while uploads were in progress.
        await this.captureChanges(await this.completeScan(generation), generation);
        for (const record of Object.values(snapshot.catalog.records).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
            if (!this.eligible(record.path)) continue;
            await this.applyRemote(record, generation, result);
        }
        this.observeCatalog(snapshot.catalog);
        this.state.enrolled = true;
        await this.persist(generation);
        result.retired = await this.collectGarbage(generation);
        await this.persist(generation);
        result.pending = Object.keys(this.state.pending).length;
        this.event("complete", result as unknown as Record<string, number>);
        return result;
    }

    private eligible(path: string): boolean {
        return isSafeContentPath(path) && this.local.isEligible(path);
    }

    private newId(): string {
        const id = this.options.randomId();
        if (!identifier(id)) throw new AttachmentSyncError("invalid-identifier", "Sync identifiers must be safe, nonempty tokens.");
        return id;
    }

    private async persist(generation: number): Promise<void> {
        this.check(generation);
        await this.stateStore.save(clone(this.state));
        this.check(generation);
    }

    private async completeScan(generation: number): Promise<Record<string, LocalFileInfo>> {
        const result = await this.local.scan();
        this.check(generation);
        if (!result.complete || !Array.isArray(result.files)) {
            throw new AttachmentSyncError("incomplete-scan", "The local file scan was incomplete; no absence is treated as deletion.");
        }
        const files = dictionary<LocalFileInfo>();
        for (const file of result.files) {
            this.validateFile(file);
            if (!this.eligible(file.path)) continue;
            if (own(files, file.path)) throw new AttachmentSyncError("invalid-scan", "The local scan contains duplicate paths.");
            files[file.path] = clone(file);
        }
        return files;
    }

    private stamp(file: LocalFileInfo | null): ChangeStamp {
        const physical = file ? Math.floor(file.mtime) : Math.floor(this.now());
        const time = Math.max(physical, this.state.clock.time);
        const counter = time === this.state.clock.time ? this.state.clock.counter + 1 : 0;
        this.state.clock = { time, counter };
        return { time, counter, deviceId: this.state.deviceId, operationId: this.newId() };
    }

    private async captureChanges(files: Record<string, LocalFileInfo>, generation: number): Promise<void> {
        let changed = false;
        for (const path of new Set([...Object.keys(files), ...Object.keys(this.state.baseline), ...Object.keys(this.state.pending)])) {
            if (!this.eligible(path)) continue;
            const file = files[path] || null;
            const pending = this.state.pending[path];
            if (pending && sameFile(file, pending.source)) continue;
            if (pending) {
                await this.abandon(pending, generation);
                delete this.state.pending[path];
                changed = true;
            }
            const baseline = this.state.baseline[path];
            if (sameFile(file, baseline?.file)) continue;
            // Absence on enrollment, or at a never-acknowledged path, is not a deletion.
            if (!file && (!this.state.enrolled || !baseline?.file)) continue;
            this.state.pending[path] = {
                path, kind: file ? "put" : "delete", change: this.stamp(file), source: file,
                revisionId: file ? this.newId() : undefined, reservationCreated: false, chunks: [],
            };
            changed = true;
        }
        if (changed) await this.persist(generation);
    }

    private observeCatalog(catalog: AttachmentCatalog): void {
        this.state.lastCatalogSequence = Math.max(this.state.lastCatalogSequence, catalog.sequence);
        for (const record of Object.values(catalog.records)) {
            if (record.change.time > this.state.clock.time) {
                this.state.clock = { time: record.change.time, counter: record.change.counter };
            } else if (record.change.time === this.state.clock.time) {
                this.state.clock.counter = Math.max(this.state.clock.counter, record.change.counter);
            }
        }
    }

    private async readCatalog(generation: number, allowCreation = false): Promise<CatalogSnapshot> {
        this.check(generation);
        let snapshot = await this.remote.getCatalog();
        this.check(generation);
        if (!snapshot && allowCreation && this.options.allowCreateCatalog && !this.state.enrolled
            && this.state.lastCatalogSequence === 0) {
            const catalog: AttachmentCatalog = {
                version: 1, collectionId: this.options.collectionId, sequence: 1,
                records: dictionary(), uploads: dictionary(), garbage: dictionary(),
            };
            snapshot = await this.remote.compareAndSwapCatalog(null, catalog);
            this.check(generation);
            if (!snapshot) snapshot = await this.remote.getCatalog();
            this.check(generation);
        }
        if (!snapshot) throw new AttachmentSyncError("catalog-missing", "The cloud catalog is missing. Explicit new-collection setup is required.");
        this.validateCatalog(snapshot.catalog);
        if (typeof snapshot.generation !== "string" || !snapshot.generation) {
            throw new AttachmentSyncError("invalid-catalog", "The cloud catalog has no conditional-write generation.");
        }
        if (snapshot.catalog.sequence < this.state.lastCatalogSequence) {
            throw new AttachmentSyncError("catalog-rollback", "The cloud catalog is older than the last acknowledged catalog.");
        }
        return snapshot;
    }

    private async mutateCatalog(generation: number, mutate: (catalog: AttachmentCatalog) => boolean): Promise<CatalogSnapshot> {
        for (let attempt = 0; attempt < this.maxCasAttempts; attempt += 1) {
            const current = await this.readCatalog(generation);
            const next = clone(current.catalog);
            next.records = dictionary(next.records);
            next.uploads = dictionary(next.uploads);
            next.garbage = dictionary(next.garbage);
            if (!mutate(next)) return current;
            next.sequence = current.catalog.sequence + 1;
            this.validateCatalog(next);
            this.check(generation);
            const committed = await this.remote.compareAndSwapCatalog(current.generation, next);
            this.check(generation);
            if (committed) {
                this.validateCatalog(committed.catalog);
                this.state.lastCatalogSequence = Math.max(this.state.lastCatalogSequence, committed.catalog.sequence);
                return committed;
            }
        }
        throw new AttachmentSyncError("catalog-contention", "The cloud catalog changed repeatedly; synchronization will retry.");
    }

    private retire(catalog: AttachmentCatalog, revisionId: string, chunkCount: number, retiredUpload = false): void {
        const previous = catalog.garbage[revisionId];
        const wasUploading = retiredUpload || !!catalog.uploads[revisionId] || previous?.retiredUpload === true;
        catalog.garbage[revisionId] = wasUploading ? {
            revisionId, chunkCount, retiredUpload: true,
            cleanupAfter: previous?.cleanupAfter ?? Math.floor(this.now() + 5 * 60_000),
            ...(previous?.lastCleanupAt !== undefined ? { lastCleanupAt: previous.lastCleanupAt } : {}),
        } : { revisionId, chunkCount };
        delete catalog.uploads[revisionId];
    }

    private async abandon(pending: PendingOperation, generation: number): Promise<void> {
        if (!pending.revisionId || !pending.reservationCreated) return;
        await this.mutateCatalog(generation, (catalog) => {
            const reservation = catalog.uploads[pending.revisionId!];
            if (!reservation) return false;
            this.retire(catalog, reservation.revisionId, reservation.chunkCount);
            return true;
        });
    }

    private async reserve(pending: PendingOperation, generation: number): Promise<boolean> {
        let snapshot = await this.readCatalog(generation);
        const record = snapshot.catalog.records[pending.path];
        if (record && compareChanges(record.change, pending.change) >= 0) return false;
        const oldId = pending.revisionId!;
        if (snapshot.catalog.garbage[oldId]
            || (pending.reservationCreated && !snapshot.catalog.uploads[oldId])) {
            // A delayed PUT from an interrupted older run may have completed after cleanup.
            // Requeue exact retired keys before forgetting the prior revision locally.
            await this.mutateCatalog(generation, (catalog) => {
                if (Object.values(catalog.records).some((entry) => entry.deleted === false && entry.revision.id === oldId)) return false;
                if (catalog.garbage[oldId]) return false;
                this.retire(catalog, oldId, Math.ceil(pending.source!.size / ATTACHMENT_CHUNK_BYTES), true);
                return true;
            });
            // A reservation was retired or its result was uncertain. Never resurrect its keys.
            pending.revisionId = this.newId();
            pending.chunks = [];
            pending.reservationCreated = false;
        }
        const revisionId = pending.revisionId!;
        const mayCreate = !pending.reservationCreated;
        // Persist intent first; a crash after CAS may not allow recreating an expired old ID.
        pending.reservationCreated = true;
        await this.persist(generation);
        let reserved = false;
        snapshot = await this.mutateCatalog(generation, (catalog) => {
            reserved = false;
            const current = catalog.records[pending.path];
            if (current && compareChanges(current.change, pending.change) >= 0) return false;
            if (catalog.garbage[revisionId]) return false;
            const existing = catalog.uploads[revisionId];
            if (!existing && !mayCreate) return false;
            if (existing && (existing.path !== pending.path || existing.deviceId !== this.state.deviceId
                || compareChanges(existing.change, pending.change) !== 0)) {
                throw new AttachmentSyncError("revision-collision", "An upload revision belongs to a different operation.");
            }
            reserved = true;
            catalog.uploads[revisionId] = {
                revisionId, path: pending.path, change: clone(pending.change), deviceId: this.state.deviceId,
                expiresAt: Math.floor(this.now() + this.reservationLifetime),
                chunkCount: Math.ceil(pending.source!.size / ATTACHMENT_CHUNK_BYTES),
            };
            return true;
        });
        return reserved && !!snapshot.catalog.uploads[revisionId];
    }

    private async upload(pending: PendingOperation, generation: number): Promise<boolean> {
        if (!pending.source || !pending.revisionId) throw new AttachmentSyncError("invalid-state", "Upload state is incomplete.");
        if (!sameFile(await this.local.stat(pending.path), pending.source)) throw new SourceChanged();
        this.check(generation);
        if (!(await this.reserve(pending, generation))) {
            await this.abandon(pending, generation);
            await this.persist(generation);
            return false;
        }
        let renewedAt = this.now();
        const wholeHash = this.options.createHasher();
        const chunks = [];
        for (let offset = 0, index = 0; offset < pending.source.size; offset += ATTACHMENT_CHUNK_BYTES, index += 1) {
            this.check(generation);
            if (!sameFile(await this.local.stat(pending.path), pending.source)) throw new SourceChanged();
            if (this.now() - renewedAt > this.reservationLifetime / 2) {
                const previousRevisionId = pending.revisionId;
                if (!(await this.reserve(pending, generation)) || pending.revisionId !== previousRevisionId) {
                    // A retired/superseded operation keeps its original timestamp. A fresh revision
                    // must start from chunk zero on the next run, without manufacturing a new edit.
                    await this.persist(generation);
                    return false;
                }
                renewedAt = this.now();
            }
            const size = Math.min(ATTACHMENT_CHUNK_BYTES, pending.source.size - offset);
            const bytes = await this.local.readChunk(pending.path, offset, size);
            this.check(generation);
            if (bytes.byteLength !== size) throw new SourceChanged();
            const partHash = this.options.createHasher();
            partHash.update(bytes);
            wholeHash.update(bytes);
            const sha256 = await partHash.digestHex();
            this.check(generation);
            if (pending.chunks[index] && pending.chunks[index].sha256 !== sha256) throw new SourceChanged();
            if (!sameFile(await this.local.stat(pending.path), pending.source)) throw new SourceChanged();
            this.check(generation);
            // Retrying the exact same immutable chunk is idempotent; never trust only local resume state.
            await this.remote.putChunk(pending.revisionId, index, bytes, sha256);
            this.check(generation);
            const descriptor = { index, size, sha256 };
            chunks.push(descriptor);
            pending.chunks[index] = descriptor;
            await this.persist(generation);
        }
        const sha256 = await wholeHash.digestHex();
        this.check(generation);
        // A file can be rewritten in place without changing size or its restored mtime.
        // A second bounded pass prevents publishing a mixture of different source versions.
        if (await this.hashLocalFile(pending.path, pending.source, generation) !== sha256) throw new SourceChanged();
        const revision: FileRevision = {
            id: pending.revisionId, size: pending.source.size, mtime: pending.source.mtime, sha256, chunks,
        };
        let published = false;
        const snapshot = await this.mutateCatalog(generation, (catalog) => {
            published = false;
            const current = catalog.records[pending.path];
            if (current && compareChanges(current.change, pending.change) >= 0) {
                published = compareChanges(current.change, pending.change) === 0 && current.deleted === false
                    && current.revision.id === revision.id;
                if (!published && catalog.uploads[revision.id]) {
                    this.retire(catalog, revision.id, chunks.length);
                    return true;
                }
                return false;
            }
            const reservation = catalog.uploads[revision.id];
            if (!reservation || reservation.expiresAt <= this.now() || catalog.garbage[revision.id]) return false;
            if (current && current.deleted === false) this.retire(catalog, current.revision.id, current.revision.chunks.length);
            catalog.records[pending.path] = { path: pending.path, change: clone(pending.change), deleted: false, revision };
            delete catalog.uploads[revision.id];
            published = true;
            return true;
        });
        if (published && sameFile(await this.local.stat(pending.path), pending.source)) {
            this.state.baseline[pending.path] = { file: clone(pending.source), change: clone(pending.change) };
        }
        if (published) {
            delete this.state.pending[pending.path];
        }
        await this.persist(generation);
        return published;
    }

    private async publishDeletion(pending: PendingOperation, generation: number): Promise<boolean> {
        if (await this.local.stat(pending.path)) throw new SourceChanged();
        this.check(generation);
        let published = false;
        await this.mutateCatalog(generation, (catalog) => {
            published = false;
            const current = catalog.records[pending.path];
            if (current && compareChanges(current.change, pending.change) >= 0) {
                published = current.deleted === true && compareChanges(current.change, pending.change) === 0;
                return false;
            }
            if (current && current.deleted === false) this.retire(catalog, current.revision.id, current.revision.chunks.length);
            catalog.records[pending.path] = { path: pending.path, change: clone(pending.change), deleted: true };
            published = true;
            return true;
        });
        if (published) this.state.baseline[pending.path] = { file: null, change: clone(pending.change) };
        if (published) delete this.state.pending[pending.path];
        await this.persist(generation);
        return published;
    }

    private async applyRemote(record: SyncRecord, generation: number, result: SyncRunResult): Promise<void> {
        const path = record.path;
        this.check(generation);
        let current = await this.local.stat(path);
        this.check(generation);
        const baseline = this.state.baseline[path];
        let pending = this.state.pending[path];
        if (!pending && !sameFile(current, baseline?.file)) {
            // The run's last scan is no authority to overwrite a file changed since that scan.
            if (current || (this.state.enrolled && baseline?.file)) {
                pending = {
                    path, kind: current ? "put" : "delete", change: this.stamp(current), source: current,
                    revisionId: current ? this.newId() : undefined, reservationCreated: false, chunks: [],
                };
                this.state.pending[path] = pending;
                await this.persist(generation);
            }
        }
        if (pending && compareChanges(pending.change, record.change) > 0) return;
        if (baseline && compareChanges(baseline.change, record.change) === 0 && sameFile(current, baseline.file)) return;
        if (record.deleted === true) {
            const latest = (await this.readCatalog(generation)).catalog.records[path];
            if (!latest || latest.deleted !== true || compareChanges(latest.change, record.change) !== 0) return;
            this.state.applying[path] = { record: clone(record), expected: current };
            await this.persist(generation);
            if (current) {
                this.check(generation);
                if (!(await this.local.remove(path, current))) {
                    delete this.state.applying[path];
                    await this.persist(generation);
                    return;
                }
                this.check(generation);
                result.deleted += 1;
            }
            this.acknowledge(record, null);
            await this.persist(generation);
            return;
        }
        const stageId = await this.local.createStage(path, record.revision);
        this.check(generation);
        let stagedSize = this.local.stageSize && this.local.readStageChunk ? await this.local.stageSize(stageId) : 0;
        const boundaries = new Set([0]);
        let boundary = 0;
        for (const chunk of record.revision.chunks) { boundary += chunk.size; boundaries.add(boundary); }
        if (!boundaries.has(stagedSize)) {
            await this.local.discardStage(stageId);
            throw new AttachmentSyncError("partial-stage", "An interrupted partial chunk was discarded; synchronization will retry.");
        }
        const wholeHash = this.options.createHasher();
        let offset = 0;
        for (const chunk of record.revision.chunks) {
            this.check(generation);
            const existing = stagedSize >= offset + chunk.size;
            const bytes = existing
                ? await this.local.readStageChunk!(stageId, offset, chunk.size)
                : await this.remote.getChunk(record.revision.id, chunk.index);
            this.check(generation);
            const partHash = this.options.createHasher();
            partHash.update(bytes);
            if (bytes.byteLength !== chunk.size || await partHash.digestHex() !== chunk.sha256) {
                await this.local.discardStage(stageId);
                throw new AttachmentSyncError("chunk-integrity", "Attachment chunk verification failed; the local file was preserved.");
            }
            wholeHash.update(bytes);
            if (!existing) {
                this.check(generation);
                await this.local.appendStage(stageId, bytes);
                this.check(generation);
                stagedSize += bytes.byteLength;
            }
            offset += chunk.size;
        }
        if (offset !== record.revision.size || await wholeHash.digestHex() !== record.revision.sha256) {
            await this.local.discardStage(stageId);
            throw new AttachmentSyncError("file-integrity", "Attachment verification failed; the local file was preserved.");
        }
        this.check(generation);
        // Re-read authoritative metadata after a long download, before any local mutation.
        const latest = (await this.readCatalog(generation)).catalog.records[path];
        if (!latest || latest.deleted === true || latest.revision.id !== record.revision.id
            || compareChanges(latest.change, record.change) !== 0) {
            await this.local.discardStage(stageId);
            return;
        }
        if (!sameFile(await this.local.stat(path), current)) return;
        this.state.applying[path] = { record: clone(record), expected: current };
        await this.persist(generation);
        this.check(generation);
        if (!(await this.local.applyStage(stageId, path, current, record.revision.mtime))) {
            delete this.state.applying[path];
            await this.persist(generation);
            return;
        }
        this.check(generation);
        current = await this.local.stat(path);
        this.check(generation);
        if (!current || current.size !== record.revision.size
            || await this.hashLocalFile(path, current, generation) !== record.revision.sha256) {
            // The adapter promoted verified bytes, but a user may already have edited them.
            // Leave the prior baseline intact so that edit becomes a new local operation.
            delete this.state.applying[path];
            await this.persist(generation);
            return;
        }
        this.acknowledge(record, current);
        await this.persist(generation);
        result.downloaded += 1;
    }

    private acknowledge(record: SyncRecord, file: LocalFileInfo | null): void {
        this.state.baseline[record.path] = { file: file && clone(file), change: clone(record.change) };
        const pending = this.state.pending[record.path];
        if (pending && compareChanges(pending.change, record.change) <= 0) delete this.state.pending[record.path];
        delete this.state.applying[record.path];
    }

    private async recoverApplications(generation: number): Promise<void> {
        for (const [path, application] of Object.entries(this.state.applying)) {
            this.check(generation);
            // An exclusion pauses ownership, including interrupted local mutations. Keep its
            // intent intact so re-inclusion can verify and acknowledge the recovered bytes.
            if (!this.eligible(path)) continue;
            const file = await this.local.stat(path);
            this.check(generation);
            const record = application.record;
            let confirmed = record.deleted === true ? !file : false;
            if (record.deleted === false && file && file.size === record.revision.size) {
                confirmed = await this.hashLocalFile(path, file, generation) === record.revision.sha256;
            }
            if (confirmed) this.acknowledge(record, file);
            else delete this.state.applying[path];
            await this.persist(generation);
        }
    }

    private async hashLocalFile(path: string, expected: LocalFileInfo, generation: number): Promise<string | null> {
        if (!sameFile(await this.local.stat(path), expected)) return null;
        const digest = this.options.createHasher();
        for (let offset = 0; offset < expected.size; offset += ATTACHMENT_CHUNK_BYTES) {
            this.check(generation);
            const size = Math.min(ATTACHMENT_CHUNK_BYTES, expected.size - offset);
            const bytes = await this.local.readChunk(path, offset, size);
            this.check(generation);
            if (bytes.byteLength !== size || !sameFile(await this.local.stat(path), expected)) return null;
            digest.update(bytes);
        }
        const result = await digest.digestHex();
        this.check(generation);
        return sameFile(await this.local.stat(path), expected) ? result : null;
    }

    private async collectGarbage(generation: number): Promise<number> {
        const snapshot = await this.readCatalog(generation);
        let retired = 0;
        for (const entry of Object.values(snapshot.catalog.garbage)) {
            this.check(generation);
            if (entry.retiredUpload && (this.now() < entry.cleanupAfter!
                || (entry.lastCleanupAt !== undefined && this.now() - entry.lastCleanupAt < 24 * 60 * 60_000))) continue;
            await this.remote.deleteRevision(entry.revisionId, entry.chunkCount);
            this.check(generation);
            await this.mutateCatalog(generation, (catalog) => {
                if (!catalog.garbage[entry.revisionId]) return false;
                const current = catalog.garbage[entry.revisionId];
                if (current.retiredUpload) current.lastCleanupAt = Math.floor(this.now());
                else delete catalog.garbage[entry.revisionId];
                return true;
            });
            retired += 1;
        }
        return retired;
    }

    private event(event: string, details: Record<string, string | number | boolean>): void {
        this.options.onEvent?.(event, details);
    }

    private validateFile(file: unknown): asserts file is LocalFileInfo {
        if (!object(file) || !isSafeContentPath(file.path) || !integer(file.size) || !timestamp(file.mtime)) {
            throw new AttachmentSyncError("invalid-file", "File metadata is invalid.");
        }
    }

    private validateStamp(change: unknown): asserts change is ChangeStamp {
        if (!object(change) || !integer(change.time) || !integer(change.counter)
            || !identifier(change.deviceId) || !identifier(change.operationId)) {
            throw new AttachmentSyncError("invalid-catalog", "A synchronization change identifier is invalid.");
        }
    }

    private validateRecord(record: unknown, path: string): asserts record is SyncRecord {
        if (!object(record) || !isSafeContentPath(path) || record.path !== path || typeof record.deleted !== "boolean") {
            throw new AttachmentSyncError("invalid-catalog", "A cloud file path is invalid.");
        }
        this.validateStamp(record.change);
        if (record.deleted === true) return;
        const revision = record.revision;
        if (!object(revision) || !identifier(revision.id) || !integer(revision.size) || !timestamp(revision.mtime)
            || !hash(revision.sha256) || !Array.isArray(revision.chunks)
            || revision.chunks.length !== Math.ceil(revision.size / ATTACHMENT_CHUNK_BYTES)) {
            throw new AttachmentSyncError("invalid-catalog", "A cloud file revision is invalid.");
        }
        for (let index = 0; index < revision.chunks.length; index += 1) {
            const chunk = revision.chunks[index];
            if (!object(chunk) || chunk.index !== index
                || chunk.size !== Math.min(ATTACHMENT_CHUNK_BYTES, revision.size - index * ATTACHMENT_CHUNK_BYTES)
                || !hash(chunk.sha256)) {
                throw new AttachmentSyncError("invalid-catalog", "A cloud chunk descriptor is invalid.");
            }
        }
    }

    private validateCatalog(catalog: AttachmentCatalog): void {
        if (!object(catalog) || catalog.version !== 1 || catalog.collectionId !== this.options.collectionId
            || !integer(catalog.sequence) || !object(catalog.records) || !object(catalog.uploads) || !object(catalog.garbage)) {
            throw new AttachmentSyncError("invalid-catalog", "The cloud catalog is invalid or belongs to another collection.");
        }
        catalog.records = dictionary(catalog.records);
        catalog.uploads = dictionary(catalog.uploads);
        catalog.garbage = dictionary(catalog.garbage);
        const live = new Set<string>();
        for (const [path, record] of Object.entries(catalog.records)) {
            this.validateRecord(record, path);
            if (record.deleted === true) continue;
            if (live.has(record.revision.id)) throw new AttachmentSyncError("invalid-catalog", "A file revision is referenced by multiple paths.");
            live.add(record.revision.id);
        }
        for (const [id, reservation] of Object.entries(catalog.uploads)) {
            if (!object(reservation) || !identifier(id) || reservation.revisionId !== id || !isSafeContentPath(reservation.path)
                || !identifier(reservation.deviceId) || !integer(reservation.expiresAt) || !integer(reservation.chunkCount)
                || live.has(id) || own(catalog.garbage, id)) {
                throw new AttachmentSyncError("invalid-catalog", "An upload reservation is invalid.");
            }
            this.validateStamp(reservation.change);
        }
        for (const [id, entry] of Object.entries(catalog.garbage)) {
            if (!object(entry) || !identifier(id) || entry.revisionId !== id || !integer(entry.chunkCount) || live.has(id)) {
                throw new AttachmentSyncError("invalid-catalog", "A cleanup entry is invalid or still referenced.");
            }
            if (entry.retiredUpload !== undefined && typeof entry.retiredUpload !== "boolean") {
                throw new AttachmentSyncError("invalid-catalog", "A retired upload marker is invalid.");
            }
            if (entry.retiredUpload && (!integer(entry.cleanupAfter)
                || (entry.lastCleanupAt !== undefined && !integer(entry.lastCleanupAt)))) {
                throw new AttachmentSyncError("invalid-catalog", "A retired upload cleanup cadence is invalid.");
            }
        }
    }

    private validateState(state: AttachmentSyncState): AttachmentSyncState {
        if (!object(state) || state.version !== 1 || state.collectionId !== this.options.collectionId
            || !identifier(state.deviceId) || typeof state.enrolled !== "boolean" || !integer(state.lastCatalogSequence)
            || !object(state.clock) || !integer(state.clock.time) || !integer(state.clock.counter)
            || !object(state.baseline) || !object(state.pending) || !object(state.applying)) {
            throw new AttachmentSyncError("invalid-state", "Device-local synchronization state is invalid or belongs to another collection.");
        }
        state.baseline = dictionary(state.baseline);
        state.pending = dictionary(state.pending);
        state.applying = dictionary(state.applying);
        for (const [path, baseline] of Object.entries(state.baseline)) {
            if (!isSafeContentPath(path) || !object(baseline)) throw new AttachmentSyncError("invalid-state", "A device baseline is invalid.");
            this.validateStamp(baseline.change);
            if (baseline.file) {
                this.validateFile(baseline.file);
                if (baseline.file.path !== path) throw new AttachmentSyncError("invalid-state", "A device baseline path is invalid.");
            } else if (baseline.file !== null) throw new AttachmentSyncError("invalid-state", "A device baseline fingerprint is invalid.");
        }
        for (const [path, pending] of Object.entries(state.pending)) {
            if (!object(pending) || !isSafeContentPath(path) || pending.path !== path || !["put", "delete"].includes(pending.kind)
                || !Array.isArray(pending.chunks)
                || (pending.reservationCreated !== undefined && typeof pending.reservationCreated !== "boolean")) {
                throw new AttachmentSyncError("invalid-state", "A pending synchronization operation is invalid.");
            }
            this.validateStamp(pending.change);
            if (pending.kind === "put") {
                this.validateFile(pending.source);
                if (pending.source.path !== path || !identifier(pending.revisionId)) throw new AttachmentSyncError("invalid-state", "A pending upload is invalid.");
                if (pending.chunks.length > Math.ceil(pending.source.size / ATTACHMENT_CHUNK_BYTES)) {
                    throw new AttachmentSyncError("invalid-state", "A pending upload has excess chunk metadata.");
                }
                for (let index = 0; index < pending.chunks.length; index += 1) {
                    const chunk = pending.chunks[index];
                    if (!object(chunk) || chunk.index !== index || !hash(chunk.sha256)
                        || chunk.size !== Math.min(ATTACHMENT_CHUNK_BYTES, pending.source.size - index * ATTACHMENT_CHUNK_BYTES)) {
                        throw new AttachmentSyncError("invalid-state", "A pending upload chunk is invalid.");
                    }
                }
            } else if (pending.source !== null || pending.revisionId !== undefined || pending.chunks.length !== 0) {
                throw new AttachmentSyncError("invalid-state", "A pending deletion is invalid.");
            }
        }
        for (const [path, application] of Object.entries(state.applying)) {
            if (!object(application)) throw new AttachmentSyncError("invalid-state", "A local mutation journal is invalid.");
            this.validateRecord(application.record, path);
            if (application.expected) {
                this.validateFile(application.expected);
                if (application.expected.path !== path) throw new AttachmentSyncError("invalid-state", "A local mutation fingerprint belongs to another path.");
            } else if (application.expected !== null) throw new AttachmentSyncError("invalid-state", "A local mutation fingerprint is invalid.");
        }
        return state;
    }
}
