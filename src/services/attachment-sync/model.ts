/** Portable attachment-sync contracts. No Obsidian, DOM, or Node dependencies. */
export const ATTACHMENT_CHUNK_BYTES = 8 * 1024 * 1024;
export const ATTACHMENT_CATALOG_VERSION = 1;

export interface ChangeStamp {
    time: number;
    counter: number;
    deviceId: string;
    operationId: string;
}

export interface LocalFileInfo {
    path: string;
    size: number;
    mtime: number;
}

export interface ChunkDescriptor {
    index: number;
    size: number;
    sha256: string;
}

export interface FileRevision {
    id: string;
    size: number;
    mtime: number;
    sha256: string;
    chunks: ChunkDescriptor[];
}

export type SyncRecord = {
    path: string;
    change: ChangeStamp;
    deleted: true;
} | {
    path: string;
    change: ChangeStamp;
    deleted: false;
    revision: FileRevision;
};

export interface UploadReservation {
    revisionId: string;
    path: string;
    change: ChangeStamp;
    deviceId: string;
    expiresAt: number;
    chunkCount: number;
}

export interface RetiredRevision {
    revisionId: string;
    chunkCount: number;
    /** Retired in-flight uploads retain a metadata-only marker for delayed native PUT cleanup. */
    retiredUpload?: boolean;
    cleanupAfter?: number;
    lastCleanupAt?: number;
}

export interface AttachmentCatalog {
    version: 1;
    collectionId: string;
    sequence: number;
    records: Record<string, SyncRecord>;
    uploads: Record<string, UploadReservation>;
    garbage: Record<string, RetiredRevision>;
}

export interface CatalogSnapshot {
    catalog: AttachmentCatalog;
    generation: string;
}

export interface RemoteStore {
    /** null means a confirmed 404, never authentication/decryption/network failure. */
    getCatalog(): Promise<CatalogSnapshot | null>;
    /** null means a conditional-write conflict; all other failures throw. */
    compareAndSwapCatalog(expectedGeneration: string | null, catalog: AttachmentCatalog): Promise<CatalogSnapshot | null>;
    /** Create-only encrypted immutable chunk; an existing chunk must match plaintext/hash. */
    putChunk(revisionId: string, index: number, bytes: Uint8Array, sha256: string): Promise<void>;
    /** Returns authenticated plaintext, including AEAD identity checks. */
    getChunk(revisionId: string, index: number): Promise<Uint8Array>;
    /** Idempotently removes exactly indexes [0, chunkCount) for this retired revision. */
    deleteRevision(revisionId: string, chunkCount: number): Promise<void>;
}

export interface LocalStore {
    isEligible(path: string): boolean;
    /** complete=false prevents all reconciliation, especially inferred deletions. */
    scan(): Promise<{ files: LocalFileInfo[]; complete: boolean }>;
    stat(path: string): Promise<LocalFileInfo | null>;
    readChunk(path: string, offset: number, length: number): Promise<Uint8Array>;
    createStage(path: string, revision: FileRevision): Promise<string>;
    appendStage(stageId: string, bytes: Uint8Array): Promise<void>;
    /** Optional bounded-read resume support; both methods must be implemented together. */
    stageSize?(stageId: string): Promise<number>;
    readStageChunk?(stageId: string, offset: number, length: number): Promise<Uint8Array>;
    /** Guard expected fingerprint; journal trash/promote for crash recovery. False means source changed. */
    applyStage(stageId: string, path: string, expected: LocalFileInfo | null, mtime: number): Promise<boolean>;
    discardStage(stageId: string): Promise<void>;
    /** Guard expected fingerprint and use configured local trash. */
    remove(path: string, expected: LocalFileInfo): Promise<boolean>;
    /** Resolve interrupted local trash/promote operations before scanning. */
    recover(): Promise<void>;
    /** Remove obsolete download-only stages only when a validated catalog positively supersedes them. */
    pruneStages?(records: SyncRecord[]): Promise<void>;
}

export interface BaselineEntry {
    file: LocalFileInfo | null;
    change: ChangeStamp;
}

export interface PendingOperation {
    path: string;
    kind: "put" | "delete";
    change: ChangeStamp;
    source: LocalFileInfo | null;
    revisionId?: string;
    reservationCreated?: boolean;
    chunks: ChunkDescriptor[];
}

export interface AttachmentSyncState {
    version: 1;
    collectionId: string;
    deviceId: string;
    enrolled: boolean;
    lastCatalogSequence: number;
    clock: { time: number; counter: number };
    baseline: Record<string, BaselineEntry>;
    pending: Record<string, PendingOperation>;
    /** Saved before a local mutation; recovery verifies its bytes before acknowledging it. */
    applying: Record<string, { record: SyncRecord; expected: LocalFileInfo | null }>;
}

export interface StateStore {
    /** Missing state starts safe enrollment; corrupt/unavailable state must throw. */
    load(): Promise<AttachmentSyncState | null>;
    /** Atomic durable transaction; state is scoped to a local vault instance and collection. */
    save(state: AttachmentSyncState): Promise<void>;
}

export interface IncrementalSha256 {
    update(bytes: Uint8Array): void;
    digestHex(): Promise<string>;
}

export interface AttachmentSyncOptions {
    collectionId: string;
    /** Explicit first-collection setup only; ordinary enrollment never creates missing cloud state. */
    allowCreateCatalog?: boolean;
    now?: () => number;
    randomId: () => string;
    createHasher: () => IncrementalSha256;
    reservationLifetimeMs?: number;
    maxCasAttempts?: number;
    onEvent?: (event: string, details: Record<string, string | number | boolean>) => void;
}

export interface SyncRunResult {
    uploaded: number;
    downloaded: number;
    deleted: number;
    retired: number;
    pending: number;
}

export function compareChanges(left: ChangeStamp, right: ChangeStamp): number {
    return left.time - right.time || left.counter - right.counter
        || compareText(left.deviceId, right.deviceId) || compareText(left.operationId, right.operationId);
}

function compareText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

export function sameFile(left: LocalFileInfo | null | undefined, right: LocalFileInfo | null | undefined): boolean {
    if (!left || !right) return !left && !right;
    return left.path === right.path && left.size === right.size && left.mtime === right.mtime;
}

export function isSafeContentPath(path: string): boolean {
    if (typeof path !== "string" || !path || path.startsWith("/") || path.includes("\\")
        || /[\u0000-\u001f\u007f]/u.test(path) || /^[a-zA-Z]:/u.test(path)) return false;
    const parts = path.split("/");
    return parts.every((part) => part !== "" && part !== "." && part !== ".." && !part.startsWith("."));
}
