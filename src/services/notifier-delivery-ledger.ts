import type {
    TPSNotifierConsumerDeliveryResult,
    TPSNotifierConsumerDeliveryState,
    TPSNotifierConsumerEvidence,
    TPSNotifierConsumerTransport,
    TPSNotifierErrorCode,
} from "../tps-notifier-contract";

export const NOTIFIER_DELIVERY_LEDGER_SCHEMA_VERSION = 1 as const;

export interface NotifierDeliveryStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
}

export interface NotifierDeliveryLedgerRecord {
    readonly state: TPSNotifierConsumerDeliveryState;
    readonly updatedAt: number;
    readonly attemptId?: string;
    readonly transport?: TPSNotifierConsumerTransport;
    readonly evidence?: TPSNotifierConsumerEvidence;
    readonly attempted?: boolean | "unknown";
    readonly code?: TPSNotifierErrorCode;
    readonly httpStatus?: number;
    readonly providerMessageId?: string;
}

interface NotifierDeliveryLedgerDocument {
    readonly schemaVersion: 1;
    readonly nextAttemptSequence: number;
    readonly records: Record<string, NotifierDeliveryLedgerRecord>;
}

export interface NotifierDeliveryLedgerLoadResult {
    readonly ready: boolean;
    readonly migratedLegacyRecords: number;
    readonly recoveredAttemptingRecords: number;
    readonly blockedReason?: string;
}

export type NotifierDeliveryAttemptClaim =
    | {
        readonly claimed: true;
        readonly attemptId: string;
    }
    | {
        readonly claimed: false;
        readonly reason: "blocked" | "existing-record" | "invalid-key" | "persistence-failed";
        readonly existingRecord?: NotifierDeliveryLedgerRecord;
    };

export interface NotifierDeliverySettlementResult {
    readonly settled: boolean;
    readonly reason?: "blocked" | "invalid-result" | "stale-attempt" | "persistence-failed";
}

export interface NotifierDeliveryAttemptOptions {
    /** A persisted not-attempted result proves that no provider I/O occurred. */
    readonly retryNotAttempted?: boolean;
}

const DELIVERY_STATES = new Set<TPSNotifierConsumerDeliveryState>([
    "attempting",
    "accepted",
    "legacy-accepted",
    "rejected",
    "not-attempted",
    "unknown",
]);

const TERMINAL_DELIVERY_STATES = new Set<TPSNotifierConsumerDeliveryState>([
    "accepted",
    "legacy-accepted",
    "rejected",
    "not-attempted",
    "unknown",
]);

const TRANSPORTS = new Set<TPSNotifierConsumerTransport>([
    "notifier-v2",
    "notifier-v1",
    "unavailable",
    "unknown",
]);

const EVIDENCE = new Set<TPSNotifierConsumerEvidence>([
    "structured-receipt",
    "structured-rejection",
    "structured-not-attempted",
    "unconfirmed",
    "legacy-promise-resolved",
    "legacy-rejection",
    "service-unavailable",
    "malformed-v2-result",
    "unclassified-v2-failure",
    "consumer-timeout",
    "interrupted",
    "legacy-untracked",
    "invalid-record",
]);

const ERROR_CODES = new Set<TPSNotifierErrorCode>([
    "not-ready",
    "settings-read-only",
    "delivery-disabled",
    "delivery-invalidated",
    "transport-dirty",
    "invalid-configuration",
    "invalid-payload",
    "internal-error",
    "delivery-busy",
    "delivery-rejected",
    "delivery-unconfirmed",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

function isFiniteTimestamp(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isValidLedgerKey(value: unknown): value is string {
    return typeof value === "string" && value.length > 0 && value.length <= 4096;
}

function copyRecord(record: NotifierDeliveryLedgerRecord): NotifierDeliveryLedgerRecord {
    return { ...record };
}

function copyRecordMap(
    records: Record<string, NotifierDeliveryLedgerRecord>,
): Record<string, NotifierDeliveryLedgerRecord> {
    const copy = Object.create(null) as Record<string, NotifierDeliveryLedgerRecord>;
    for (const [key, record] of Object.entries(records)) copy[key] = copyRecord(record);
    return copy;
}

function hasNoProviderDetails(value: Record<string, unknown>): boolean {
    return value.code === undefined && value.httpStatus === undefined && value.providerMessageId === undefined;
}

function hasValidTerminalSemantics(value: Record<string, unknown>): boolean {
    switch (value.evidence) {
        case "structured-receipt":
            return value.state === "accepted"
                && value.transport === "notifier-v2"
                && value.attempted === true
                && value.code === undefined
                && typeof value.httpStatus === "number"
                && value.httpStatus >= 200
                && value.httpStatus < 300
                && typeof value.providerMessageId === "string";
        case "structured-rejection":
            return value.state === "rejected"
                && value.transport === "notifier-v2"
                && value.attempted === true
                && value.code !== undefined
                && value.providerMessageId === undefined;
        case "structured-not-attempted":
            return value.state === "not-attempted"
                && value.transport === "notifier-v2"
                && value.attempted === false
                && value.code !== undefined
                && value.providerMessageId === undefined;
        case "unconfirmed":
            return value.state === "unknown"
                && value.transport === "notifier-v2"
                && value.attempted === true
                && value.code !== undefined
                && value.providerMessageId === undefined;
        case "legacy-promise-resolved":
            return value.state === "legacy-accepted"
                && value.transport === "notifier-v1"
                && value.attempted === true
                && hasNoProviderDetails(value);
        case "legacy-rejection":
            return value.state === "unknown"
                && value.transport === "notifier-v1"
                && value.attempted === "unknown"
                && hasNoProviderDetails(value);
        case "service-unavailable":
            return value.state === "not-attempted"
                && value.transport === "unavailable"
                && value.attempted === false
                && hasNoProviderDetails(value);
        case "malformed-v2-result":
        case "unclassified-v2-failure":
            return value.state === "unknown"
                && value.transport === "notifier-v2"
                && value.attempted === "unknown"
                && hasNoProviderDetails(value);
        case "consumer-timeout":
            return value.state === "unknown"
                && (value.transport === "notifier-v2" || value.transport === "notifier-v1")
                && value.attempted === "unknown"
                && hasNoProviderDetails(value);
        case "interrupted":
            return hasNoProviderDetails(value)
                && ((value.state === "not-attempted"
                        && value.transport === "unavailable"
                        && value.attempted === false)
                    || (value.state === "unknown"
                        && value.transport === "unknown"
                        && value.attempted === "unknown"));
        case "legacy-untracked":
            return value.state === "legacy-accepted"
                && value.transport === "unknown"
                && value.attempted === "unknown"
                && hasNoProviderDetails(value);
        case "invalid-record":
            return value.state === "unknown"
                && value.transport === "unknown"
                && value.attempted === "unknown"
                && hasNoProviderDetails(value);
        default:
            return false;
    }
}

function parseLedgerRecord(value: unknown): NotifierDeliveryLedgerRecord | null {
    if (!isRecord(value)
        || !DELIVERY_STATES.has(value.state as TPSNotifierConsumerDeliveryState)
        || !isFiniteTimestamp(value.updatedAt)) return null;

    const state = value.state as TPSNotifierConsumerDeliveryState;
    const attemptId = value.attemptId;
    if (attemptId !== undefined && !isValidLedgerKey(attemptId)) return null;

    if (state === "attempting") {
        if (!isValidLedgerKey(attemptId)) return null;
        return {
            state,
            updatedAt: value.updatedAt,
            attemptId,
        };
    }

    if (!TERMINAL_DELIVERY_STATES.has(state)
        || !TRANSPORTS.has(value.transport as TPSNotifierConsumerTransport)
        || !EVIDENCE.has(value.evidence as TPSNotifierConsumerEvidence)
        || (typeof value.attempted !== "boolean" && value.attempted !== "unknown")) return null;

    if (value.code !== undefined && !ERROR_CODES.has(value.code as TPSNotifierErrorCode)) return null;
    if (value.httpStatus !== undefined
        && (typeof value.httpStatus !== "number"
            || !Number.isInteger(value.httpStatus)
            || value.httpStatus < 100
            || value.httpStatus > 599)) return null;
    if (value.providerMessageId !== undefined
        && (typeof value.providerMessageId !== "string"
            || value.providerMessageId.length < 1
            || value.providerMessageId.length > 256)) return null;
    if (!hasValidTerminalSemantics(value)) return null;

    return {
        state,
        updatedAt: value.updatedAt,
        ...(attemptId === undefined ? {} : { attemptId }),
        transport: value.transport as TPSNotifierConsumerTransport,
        evidence: value.evidence as TPSNotifierConsumerEvidence,
        attempted: value.attempted,
        ...(value.code === undefined ? {} : { code: value.code as TPSNotifierErrorCode }),
        ...(value.httpStatus === undefined ? {} : { httpStatus: value.httpStatus }),
        ...(value.providerMessageId === undefined ? {} : { providerMessageId: value.providerMessageId }),
    };
}

function parseDeliveryResult(value: unknown): TPSNotifierConsumerDeliveryResult | null {
    try {
        const parsed = parseLedgerRecord({
            ...(isRecord(value) ? value : {}),
            updatedAt: 0,
        });
        if (!parsed || parsed.state === "attempting" || !parsed.transport || !parsed.evidence
            || (typeof parsed.attempted !== "boolean" && parsed.attempted !== "unknown")) return null;
        return {
            state: parsed.state,
            transport: parsed.transport,
            evidence: parsed.evidence,
            attempted: parsed.attempted,
            ...(parsed.code === undefined ? {} : { code: parsed.code }),
            ...(parsed.httpStatus === undefined ? {} : { httpStatus: parsed.httpStatus }),
            ...(parsed.providerMessageId === undefined ? {} : { providerMessageId: parsed.providerMessageId }),
        };
    } catch {
        return null;
    }
}

function deliveryResultFromRecord(
    record: NotifierDeliveryLedgerRecord,
): TPSNotifierConsumerDeliveryResult | null {
    if (record.state === "attempting" || !record.transport || !record.evidence
        || (typeof record.attempted !== "boolean" && record.attempted !== "unknown")) return null;
    return {
        state: record.state,
        transport: record.transport,
        evidence: record.evidence,
        attempted: record.attempted,
        ...(record.code === undefined ? {} : { code: record.code }),
        ...(record.httpStatus === undefined ? {} : { httpStatus: record.httpStatus }),
        ...(record.providerMessageId === undefined ? {} : { providerMessageId: record.providerMessageId }),
    };
}

export class NotifierDeliveryLedger {
    private document?: NotifierDeliveryLedgerDocument;
    private blockedReason = "not-loaded";
    private closed = false;

    constructor(
        private readonly storage: NotifierDeliveryStorage,
        private readonly storageKey: string,
        private readonly now: () => number = () => Date.now(),
    ) {}

    get ready(): boolean {
        return !this.closed && !!this.document && !this.blockedReason;
    }

    get blockReason(): string {
        return this.blockedReason;
    }

    load(): NotifierDeliveryLedgerLoadResult {
        if (this.closed) return this.loadFailure("lifecycle-closed");
        let raw: string | null;
        try {
            raw = this.storage.getItem(this.storageKey);
        } catch {
            return this.block("storage-read-failed");
        }

        if (raw == null) {
            const empty = this.emptyDocument();
            if (!this.commit(empty)) return this.loadFailure("storage-write-failed");
            return this.loadSuccess(0, 0);
        }

        let value: unknown;
        try {
            value = JSON.parse(raw);
        } catch {
            return this.block("invalid-json");
        }
        if (!isRecord(value)) return this.block("invalid-root");

        if (!Object.prototype.hasOwnProperty.call(value, "schemaVersion")) {
            const migrated = this.migrateLegacyNumericDocument(value);
            if (!migrated) return this.block("invalid-legacy-record");
            if (!this.commit(migrated.document)) return this.loadFailure("storage-write-failed");
            return this.loadSuccess(migrated.count, 0);
        }

        if (value.schemaVersion !== NOTIFIER_DELIVERY_LEDGER_SCHEMA_VERSION) {
            return this.block("unsupported-schema-version");
        }
        if (!Number.isSafeInteger(value.nextAttemptSequence)
            || (value.nextAttemptSequence as number) < 1
            || (value.nextAttemptSequence as number) >= Number.MAX_SAFE_INTEGER
            || !isRecord(value.records)) return this.block("invalid-document");

        const records = Object.create(null) as Record<string, NotifierDeliveryLedgerRecord>;
        let recoveredAttemptingRecords = 0;
        for (const [key, rawRecord] of Object.entries(value.records)) {
            if (!isValidLedgerKey(key)) return this.block("invalid-record-key");
            const record = parseLedgerRecord(rawRecord);
            if (!record) return this.block("invalid-record");
            if (record.state === "attempting") {
                records[key] = {
                    state: "unknown",
                    updatedAt: this.now(),
                    attemptId: record.attemptId,
                    transport: "unknown",
                    evidence: "interrupted",
                    attempted: "unknown",
                };
                recoveredAttemptingRecords += 1;
            } else {
                records[key] = record;
            }
        }

        const document: NotifierDeliveryLedgerDocument = {
            schemaVersion: NOTIFIER_DELIVERY_LEDGER_SCHEMA_VERSION,
            nextAttemptSequence: value.nextAttemptSequence as number,
            records,
        };
        if (recoveredAttemptingRecords > 0 && !this.commit(document)) {
            return this.loadFailure("storage-write-failed");
        }
        if (recoveredAttemptingRecords === 0) {
            this.document = document;
            this.blockedReason = "";
        }
        return this.loadSuccess(0, recoveredAttemptingRecords);
    }

    getRecord(key: string): NotifierDeliveryLedgerRecord | undefined {
        const record = this.document?.records[key];
        return record ? copyRecord(record) : undefined;
    }

    beginAttempt(
        key: string,
        options: Readonly<NotifierDeliveryAttemptOptions> = {},
    ): NotifierDeliveryAttemptClaim {
        if (!this.ready || !this.document) return { claimed: false, reason: "blocked" };
        if (!isValidLedgerKey(key)) return { claimed: false, reason: "invalid-key" };
        const existingRecord = this.document.records[key];
        if (existingRecord
            && !(options.retryNotAttempted === true && existingRecord.state === "not-attempted")) {
            return {
                claimed: false,
                reason: "existing-record",
                existingRecord: copyRecord(existingRecord),
            };
        }

        const attemptId = `controller-${this.document.nextAttemptSequence}`;
        const records = copyRecordMap(this.document.records);
        const timestamp = this.now();
        records[key] = {
            state: "attempting",
            attemptId,
            updatedAt: timestamp,
        };
        const next: NotifierDeliveryLedgerDocument = {
            schemaVersion: NOTIFIER_DELIVERY_LEDGER_SCHEMA_VERSION,
            nextAttemptSequence: this.document.nextAttemptSequence + 1,
            records,
        };
        if (!this.commit(next)) return { claimed: false, reason: "persistence-failed" };
        return { claimed: true, attemptId };
    }

    settleAttempt(
        key: string,
        attemptId: string,
        result: TPSNotifierConsumerDeliveryResult,
    ): NotifierDeliverySettlementResult {
        if (!this.ready || !this.document) return { settled: false, reason: "blocked" };
        const parsedResult = parseDeliveryResult(result);
        if (!parsedResult) return { settled: false, reason: "invalid-result" };
        const record = this.document.records[key];
        if (!isValidLedgerKey(key)
            || !record
            || record.state !== "attempting"
            || record.attemptId !== attemptId) return { settled: false, reason: "stale-attempt" };

        const records = copyRecordMap(this.document.records);
        const timestamp = this.now();
        records[key] = {
            state: parsedResult.state,
            updatedAt: timestamp,
            attemptId,
            transport: parsedResult.transport,
            evidence: parsedResult.evidence,
            attempted: parsedResult.attempted,
            ...(parsedResult.code === undefined ? {} : { code: parsedResult.code }),
            ...(parsedResult.httpStatus === undefined ? {} : { httpStatus: parsedResult.httpStatus }),
            ...(parsedResult.providerMessageId === undefined
                ? {}
                : { providerMessageId: parsedResult.providerMessageId }),
        };
        const next: NotifierDeliveryLedgerDocument = {
            ...this.document,
            records,
        };
        if (!this.commit(next)) return { settled: false, reason: "persistence-failed" };
        return { settled: true };
    }

    pruneResolvedBefore(cutoff: number): boolean {
        if (!this.ready || !this.document || !Number.isFinite(cutoff)) return false;
        const records = copyRecordMap(this.document.records);
        let changed = false;
        for (const [key, record] of Object.entries(records)) {
            if (record.updatedAt >= cutoff || record.state === "attempting") continue;
            delete records[key];
            changed = true;
        }
        if (!changed) return true;
        return this.commit({ ...this.document, records });
    }

    resultForRecord(record: NotifierDeliveryLedgerRecord): TPSNotifierConsumerDeliveryResult | null {
        return deliveryResultFromRecord(record);
    }

    close(): void {
        this.closed = true;
        this.document = undefined;
        this.blockedReason = "lifecycle-closed";
    }

    private emptyDocument(): NotifierDeliveryLedgerDocument {
        return {
            schemaVersion: NOTIFIER_DELIVERY_LEDGER_SCHEMA_VERSION,
            nextAttemptSequence: 1,
            records: Object.create(null) as Record<string, NotifierDeliveryLedgerRecord>,
        };
    }

    private migrateLegacyNumericDocument(value: Record<string, unknown>): {
        document: NotifierDeliveryLedgerDocument;
        count: number;
    } | null {
        const document = this.emptyDocument();
        let count = 0;
        for (const [key, rawTimestamp] of Object.entries(value)) {
            const timestamp = typeof rawTimestamp === "string" && rawTimestamp.trim()
                ? Number(rawTimestamp)
                : rawTimestamp;
            if (!isValidLedgerKey(key) || !isFiniteTimestamp(timestamp)) return null;
            document.records[key] = {
                state: "legacy-accepted",
                updatedAt: timestamp,
                transport: "unknown",
                evidence: "legacy-untracked",
                attempted: "unknown",
            };
            count += 1;
        }
        return { document, count };
    }

    private commit(document: NotifierDeliveryLedgerDocument): boolean {
        if (this.closed) return false;
        try {
            this.storage.setItem(this.storageKey, JSON.stringify(document));
        } catch {
            this.blockedReason = "storage-write-failed";
            return false;
        }
        this.document = document;
        this.blockedReason = "";
        return true;
    }

    private block(reason: string): NotifierDeliveryLedgerLoadResult {
        this.document = undefined;
        this.blockedReason = reason;
        return this.loadFailure(reason);
    }

    private loadFailure(reason: string): NotifierDeliveryLedgerLoadResult {
        return {
            ready: false,
            migratedLegacyRecords: 0,
            recoveredAttemptingRecords: 0,
            blockedReason: reason,
        };
    }

    private loadSuccess(
        migratedLegacyRecords: number,
        recoveredAttemptingRecords: number,
    ): NotifierDeliveryLedgerLoadResult {
        return {
            ready: true,
            migratedLegacyRecords,
            recoveredAttemptingRecords,
        };
    }
}
