export type SyncRequestScope = "calendar" | "reminders" | "s3agle-archive";

export interface S3agleArchiveRequest {
    notePath: string;
    sourcePaths: string[];
    requestedAt: number;
}

export interface SyncRequest {
    requestId: string;
    requestedAt: number;
    requestedBy: string;
    scope: SyncRequestScope[];
    s3agleArchiveRequests?: S3agleArchiveRequest[];
}

export interface SyncRequestAcknowledgement {
    request: SyncRequest;
    acknowledged: boolean;
    reason: "acknowledged" | "stale-generation";
}

export interface SyncRequestFulfillmentFlight<T> {
    promise: Promise<T>;
    joined: boolean;
}

const SYNC_REQUEST_SCOPES: SyncRequestScope[] = ["calendar", "reminders", "s3agle-archive"];

export function createSyncRequestId(nowMs = Date.now(), randomValue = Math.random()): string {
    const random = Math.floor(Math.max(0, Math.min(0.999999999, randomValue)) * 0xFFFFFFFF)
        .toString(36)
        .padStart(7, "0");
    return `sync-${Math.max(0, Math.floor(nowMs)).toString(36)}-${random}`;
}

export function normalizeSyncRequest(value: unknown): SyncRequest | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const raw = value as Record<string, unknown>;
    const requestedAt = Number(raw.requestedAt);
    if (!Number.isFinite(requestedAt) || requestedAt <= 0 || !Array.isArray(raw.scope)) return null;

    const scope = Array.from(new Set(raw.scope
        .filter((item): item is SyncRequestScope => SYNC_REQUEST_SCOPES.includes(item as SyncRequestScope))));
    const requestedBy = typeof raw.requestedBy === "string" ? raw.requestedBy.trim() : "";
    const explicitRequestId = typeof raw.requestId === "string" ? raw.requestId.trim() : "";
    const requestId = explicitRequestId || `legacy-${Math.floor(requestedAt).toString(36)}-${scope.join("_") || "empty"}`;
    const s3agleArchiveRequests = normalizeS3agleArchiveRequests(raw.s3agleArchiveRequests, requestedAt);

    return {
        requestId,
        requestedAt,
        requestedBy,
        scope,
        ...(s3agleArchiveRequests.length ? { s3agleArchiveRequests } : {}),
    };
}

export function mergeSyncRequests(existing: SyncRequest | null, incoming: SyncRequest): SyncRequest {
    const previous = existing ? normalizeSyncRequest(existing) : null;
    const next = normalizeSyncRequest(incoming);
    if (!next) throw new Error("Incoming sync request is invalid.");
    if (!previous) return next;

    const scope = Array.from(new Set([...previous.scope, ...next.scope]));
    const s3agleArchiveRequests = normalizeS3agleArchiveRequests([
        ...(previous.s3agleArchiveRequests || []),
        ...(next.s3agleArchiveRequests || []),
    ], next.requestedAt);
    return {
        ...next,
        scope,
        ...(s3agleArchiveRequests.length ? { s3agleArchiveRequests } : {}),
    };
}

export function acknowledgeSyncRequest(
    current: SyncRequest,
    expected: SyncRequest,
    acknowledgedAt = Date.now(),
    acknowledgedBy = "",
): SyncRequestAcknowledgement {
    if (current.requestId !== expected.requestId) {
        return { request: current, acknowledged: false, reason: "stale-generation" };
    }
    return {
        request: {
            requestId: `ack-${expected.requestId}`,
            requestedAt: Math.max(1, Math.floor(acknowledgedAt)),
            requestedBy: acknowledgedBy,
            scope: [],
        },
        acknowledged: true,
        reason: "acknowledged",
    };
}

export function joinSyncRequestFulfillment<T>(
    active: Promise<T> | null,
    start: () => Promise<T>,
): SyncRequestFulfillmentFlight<T> {
    if (active) return { promise: active, joined: true };
    return { promise: start(), joined: false };
}

export async function executeSyncRequestGeneration(
    execute: () => Promise<void>,
    acknowledge: () => Promise<boolean>,
): Promise<boolean> {
    await execute();
    return acknowledge();
}

export function parseSyncRequestContent(content: string): SyncRequest | null {
    try {
        return normalizeSyncRequest(JSON.parse(content));
    } catch {
        return null;
    }
}

export function serializeSyncRequest(request: SyncRequest): string {
    return `${JSON.stringify(request, null, 2)}\n`;
}

function normalizeS3agleArchiveRequests(value: unknown, fallbackRequestedAt: number): S3agleArchiveRequest[] {
    if (!Array.isArray(value)) return [];
    const byNote = new Map<string, { sourcePaths: Set<string>; requestedAt: number }>();
    for (const item of value) {
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        const raw = item as Record<string, unknown>;
        const notePath = normalizeVaultPath(raw.notePath);
        if (!notePath || !Array.isArray(raw.sourcePaths)) continue;
        const sourcePaths = raw.sourcePaths.map(normalizeVaultPath).filter(Boolean);
        if (!sourcePaths.length) continue;
        const requestedAt = Number(raw.requestedAt);
        const existing = byNote.get(notePath) || {
            sourcePaths: new Set<string>(),
            requestedAt: Number.isFinite(requestedAt) && requestedAt > 0 ? requestedAt : fallbackRequestedAt,
        };
        for (const sourcePath of sourcePaths) existing.sourcePaths.add(sourcePath);
        if (Number.isFinite(requestedAt) && requestedAt > existing.requestedAt) existing.requestedAt = requestedAt;
        byNote.set(notePath, existing);
    }
    return Array.from(byNote.entries())
        .map(([notePath, request]) => ({
            notePath,
            sourcePaths: Array.from(request.sourcePaths).sort(),
            requestedAt: request.requestedAt,
        }))
        .sort((left, right) => left.notePath.localeCompare(right.notePath));
}

function normalizeVaultPath(value: unknown): string {
    if (typeof value !== "string") return "";
    const raw = value.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    if (!raw || raw.includes("\0")) return "";
    const parts = raw.split("/").filter((part) => part && part !== ".");
    if (!parts.length || parts.some((part) => part === "..")) return "";
    return parts.join("/");
}
