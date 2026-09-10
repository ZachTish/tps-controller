import type { DataAdapter } from "obsidian";
import type { AttachmentSyncState, StateStore } from "./model";
import { isSafeContentPath } from "./model";

const DATABASE_NAME = "tps-controller-attachment-sync-v1";
const STORE_NAME = "device-state";

type LocalAdapter = DataAdapter & { getBasePath?: () => string; getFullPath?: (path: string) => string };

/** A local filesystem identity, never just the display name shared by different vaults. */
export function localVaultIdentity(adapter: DataAdapter): string {
    const local = adapter as LocalAdapter;
    const base = local.getBasePath?.() || local.getFullPath?.("");
    if (typeof base === "string" && base.trim()) return `path:${base.replace(/\\/g, "/").replace(/\/+$/, "")}`;
    const resource = adapter.getResourcePath("");
    if (typeof resource !== "string" || !resource || resource === "/" || resource === "app://obsidian.md/") {
        throw new Error("Attachment sync cannot identify this local vault. Device state was not opened.");
    }
    // Resource URLs may append a cache timestamp; it must not create a new device at every launch.
    const identity = resource.split(/[?#]/, 1)[0].replace(/\/+$/, "");
    if (!identity || !identity.includes(":")) throw new Error("Attachment sync requires a vault-specific local resource URL.");
    return `resource:${identity}`;
}

function record(value: unknown): value is Record<string, any> {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function finite(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validFile(value: any, path: string): boolean {
    return value === null || (record(value) && value.path === path && finite(value.mtime)
        && Number.isSafeInteger(value.size) && value.size >= 0);
}

function validChange(value: any): boolean {
    return record(value) && finite(value.time) && Number.isSafeInteger(value.counter) && value.counter >= 0
        && typeof value.deviceId === "string" && Boolean(value.deviceId)
        && typeof value.operationId === "string" && Boolean(value.operationId);
}

/** Corrupt state is never silently replaced with an empty baseline. */
export function validateDeviceState(value: unknown, collectionId: string): asserts value is AttachmentSyncState {
    if (!record(value) || value.version !== 1 || value.collectionId !== collectionId
        || typeof value.deviceId !== "string" || !value.deviceId || typeof value.enrolled !== "boolean"
        || !Number.isSafeInteger(value.lastCatalogSequence) || value.lastCatalogSequence < 0
        || !record(value.clock) || !finite(value.clock.time) || !Number.isSafeInteger(value.clock.counter)
        || value.clock.counter < 0 || !record(value.baseline) || !record(value.pending) || !record(value.applying)) {
        throw new Error("Attachment sync device state is corrupt or belongs to a different collection. Sync is paused.");
    }
    for (const [path, entry] of Object.entries(value.baseline)) {
        if (!isSafeContentPath(path) || !record(entry) || !validFile(entry.file, path) || !validChange(entry.change)) {
            throw new Error("Attachment sync baseline is corrupt. Sync is paused.");
        }
    }
    for (const [path, operation] of Object.entries(value.pending)) {
        if (!isSafeContentPath(path) || !record(operation) || operation.path !== path
            || !["put", "delete"].includes(operation.kind) || !validFile(operation.source, path)
            || !validChange(operation.change) || !Array.isArray(operation.chunks)
            || (operation.kind === "put" && !operation.source)
            || (operation.revisionId !== undefined && typeof operation.revisionId !== "string")
            || operation.chunks.some((chunk: any, index: number) => !record(chunk) || chunk.index !== index
                || !Number.isSafeInteger(chunk.size) || chunk.size < 0 || !/^[0-9a-f]{64}$/.test(chunk.sha256))) {
            throw new Error("Attachment sync operation journal is corrupt. Sync is paused.");
        }
    }
    for (const [path, application] of Object.entries(value.applying)) {
        const intended = record(application) ? application.record : null;
        if (!isSafeContentPath(path) || !record(application) || !validFile(application.expected, path)
            || !record(intended) || intended.path !== path || typeof intended.deleted !== "boolean" || !validChange(intended.change)
            || (!intended.deleted && (!record(intended.revision) || typeof intended.revision.id !== "string"
                || !Number.isSafeInteger(intended.revision.size) || intended.revision.size < 0
                || !/^[0-9a-f]{64}$/.test(intended.revision.sha256) || !Array.isArray(intended.revision.chunks)))) {
            throw new Error("Attachment sync replacement journal is corrupt. Sync is paused.");
        }
    }
}

/** IndexedDB is device-local. Neither the baseline nor enrollment is saved into synced data.json. */
export class AttachmentDeviceStateStore implements StateStore {
    readonly vaultIdentity: string;
    private readonly scope: string;
    private database: Promise<IDBDatabase> | null = null;

    constructor(
        adapter: DataAdapter,
        remoteIdentity: string,
        private readonly collectionId: string,
        private readonly factory: IDBFactory | undefined = globalThis.indexedDB,
    ) {
        if (!remoteIdentity || !collectionId) throw new Error("Attachment sync requires a remote collection identity.");
        this.vaultIdentity = localVaultIdentity(adapter);
        this.scope = JSON.stringify([1, this.vaultIdentity, remoteIdentity, collectionId]);
    }

    async load(): Promise<AttachmentSyncState | null> {
        const state = await this.read<AttachmentSyncState>("engine");
        if (state !== null) validateDeviceState(state, this.collectionId);
        return state;
    }

    async save(state: AttachmentSyncState): Promise<void> {
        validateDeviceState(state, this.collectionId);
        await this.write("engine", state);
    }

    getPreference<T>(key: string): Promise<T | null> {
        this.checkPreferenceKey(key);
        return this.read<T>(`preference:${key}`);
    }

    setPreference<T>(key: string, value: T): Promise<void> {
        this.checkPreferenceKey(key);
        return this.write(`preference:${key}`, value);
    }

    /** Used only by the local filesystem transaction journal; never contains credentials. */
    getJournal<T>(): Promise<T | null> { return this.read<T>("local-journal"); }
    saveJournal<T>(journal: T): Promise<void> { return this.write("local-journal", journal); }

    async close(): Promise<void> {
        if (this.database) (await this.database).close();
        this.database = null;
    }

    private checkPreferenceKey(key: string): void {
        if (!/^[a-zA-Z0-9_-]{1,80}$/.test(key)) throw new Error("Invalid attachment device preference key.");
    }

    private async open(): Promise<IDBDatabase> {
        if (!this.factory) throw new Error("Attachment sync needs working device-local IndexedDB. Sync is paused.");
        if (!this.database) {
            this.database = new Promise<IDBDatabase>((resolve, reject) => {
                const request = this.factory!.open(DATABASE_NAME, 1);
                request.onupgradeneeded = () => {
                    if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
                };
                request.onerror = () => reject(new Error("Attachment device state could not be opened. Sync is paused."));
                request.onblocked = () => reject(new Error("Attachment device state is blocked by another app window. Close it and retry."));
                request.onsuccess = () => {
                    const database = request.result;
                    database.onversionchange = () => { database.close(); this.database = null; };
                    resolve(database);
                };
            }).catch((error) => { this.database = null; throw error; });
        }
        return this.database;
    }

    private async read<T>(slot: string): Promise<T | null> {
        const database = await this.open();
        return new Promise<T | null>((resolve, reject) => {
            const transaction = database.transaction(STORE_NAME, "readonly");
            const request = transaction.objectStore(STORE_NAME).get([this.scope, slot]);
            let result: T | null = null;
            request.onsuccess = () => { result = request.result === undefined ? null : request.result; };
            transaction.oncomplete = () => resolve(result);
            transaction.onabort = transaction.onerror = () => reject(new Error("Attachment device state read failed. Sync is paused."));
        });
    }

    private async write(slot: string, value: unknown): Promise<void> {
        const database = await this.open();
        return new Promise<void>((resolve, reject) => {
            // Request strict durability and verify it; unsupported WebViews fail closed.
            // The structural overload supports the repository's older TypeScript DOM declarations.
            const durable = database as IDBDatabase & {
                transaction(name: string, mode: "readwrite", options: { durability: "strict" }): IDBTransaction;
            };
            const transaction = durable.transaction(STORE_NAME, "readwrite", { durability: "strict" });
            if ((transaction as IDBTransaction & { durability?: string }).durability !== "strict") {
                transaction.abort();
                reject(new Error("Attachment sync requires strict IndexedDB durability on this device. Sync is paused."));
                return;
            }
            transaction.objectStore(STORE_NAME).put(value, [this.scope, slot]);
            transaction.oncomplete = () => resolve();
            transaction.onabort = transaction.onerror = () => reject(new Error("Attachment device state could not be saved. Sync is paused."));
        });
    }
}
