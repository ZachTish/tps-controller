import {
    isCanonicalBase64URLSHA256,
    isCanonicalIssuedAt,
    isValidVaultName,
    normalizeUUID,
    utf8ByteCount,
} from "./tishos-command-bridge-contract";

export const NATIVE_MAC_REFRESH_BODY_LIMIT = 2048;
export const NATIVE_MAC_REFRESH_PORT = 51002;
export const NATIVE_MAC_REFRESH_PATH = "/v1/vault/refresh";

export interface NativeMacRefreshRequest {
    schemaVersion: 1;
    vaultName: string;
    clientID: string;
    requestID: string;
    issuedAt: string;
    mac: string;
}

export interface NativeMacRefreshResponse {
    schemaVersion: 1;
    requestID: string;
    status: "queued";
    mac: string;
}

function canonicalUUID(value: unknown): value is string {
    return typeof value === "string" && normalizeUUID(value) === value;
}

function field(name: string, value: string): string {
    return `${name}:${utf8ByteCount(value)}:${value}\n`;
}

export function canonicalNativeMacRefreshRequest(value: Omit<NativeMacRefreshRequest, "mac">): Uint8Array {
    if (value.schemaVersion !== 1 || !isValidVaultName(value.vaultName)
        || !canonicalUUID(value.clientID) || !canonicalUUID(value.requestID)
        || !isCanonicalIssuedAt(value.issuedAt)) throw new Error("Invalid native refresh request");
    return new TextEncoder().encode("tishos-vault-refresh-v1\nschema:1\n"
        + field("vault", value.vaultName) + field("client", value.clientID)
        + field("request", value.requestID) + field("issued", value.issuedAt));
}

export function canonicalNativeMacRefreshResponse(value: Omit<NativeMacRefreshResponse, "mac">): Uint8Array {
    if (value.schemaVersion !== 1 || !canonicalUUID(value.requestID) || value.status !== "queued") {
        throw new Error("Invalid native refresh response");
    }
    return new TextEncoder().encode("tishos-vault-refresh-response-v1\nschema:1\n"
        + field("request", value.requestID) + field("status", value.status));
}

export function parseNativeMacRefreshResponse(body: string, requestID: string): NativeMacRefreshResponse | null {
    // Every canonical field is ASCII with no escapes. Reject escaped spelling
    // as well as literal duplicate keys before JSON.parse can collapse them.
    if (utf8ByteCount(body) > NATIVE_MAC_REFRESH_BODY_LIMIT || body.includes("\\")) return null;
    try {
        // The four permitted scalar fields cannot contain escaped key text.
        // Reject repeated keys rather than accepting JSON.parse's last winner.
        const keys = [...body.matchAll(/"(mac|requestID|schemaVersion|status)"\s*:/g)].map(match => match[1]);
        if (keys.length !== 4 || new Set(keys).size !== 4) return null;
        const value: unknown = JSON.parse(body);
        if (!value || typeof value !== "object" || Array.isArray(value)) return null;
        const record = value as Record<string, unknown>;
        if (Object.keys(record).sort().join(",") !== "mac,requestID,schemaVersion,status"
            || record.schemaVersion !== 1 || record.requestID !== requestID
            || !canonicalUUID(record.requestID) || record.status !== "queued"
            || !isCanonicalBase64URLSHA256(String(record.mac))) return null;
        return record as unknown as NativeMacRefreshResponse;
    } catch { return null; }
}
