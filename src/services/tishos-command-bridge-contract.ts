export const TISHOS_COMMAND_BRIDGE_SCHEMA_VERSION = 1 as const;
export const TISHOS_COMMAND_BRIDGE_MAX_COMMANDS = 4096;
export const TISHOS_COMMAND_BRIDGE_MAX_FILE_BYTES = 1024 * 1024;
export const TISHOS_COMMAND_BRIDGE_MAX_COMMAND_ID_BYTES = 256;
export const TISHOS_COMMAND_BRIDGE_MAX_COMMAND_NAME_BYTES = 256;
export const TISHOS_COMMAND_BRIDGE_MAX_DEVICE_BYTES = 80;
export const TISHOS_COMMAND_BRIDGE_MAX_REQUEST_AGE_MS = 2 * 60 * 1000;
export const TISHOS_COMMAND_BRIDGE_MAX_FUTURE_SKEW_MS = 30 * 1000;

export const TISHOS_COMMAND_BRIDGE_CATALOG_ROOT = ".tishos/command-bridge/v1";

const ENTRY_PREFIX = "tishos-command-entry-v1\n";
const CATALOG_PREFIX = "tishos-command-catalog-v1\n";
const REQUEST_PREFIX = "tishos-command-request-v1\n";
const REVOKE_PREFIX = "tishos-command-revoke-v1\n";
const NOTIFICATION_ACTION_PREFIX = "tishos-notification-action-v1\n";
const FORBIDDEN_DISPLAY_CHARACTER = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BASE64URL_SHA256 = /^[A-Za-z0-9_-]{43}$/;
const GENERATED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ISSUED_AT = /^(?:0|[1-9]\d{0,15})$/;

export interface ObsidianCommandValue {
    id: string;
    name: string;
}

export interface TishOSCommandCatalogEntry extends ObsidianCommandValue {
    digest: string;
}

export interface TishOSCommandCatalog {
    schemaVersion: 1;
    clientID: string;
    vaultName: string;
    generatedAt: string;
    publisher: {
        id: string;
        version: string;
    };
    commands: TishOSCommandCatalogEntry[];
    mac: string;
}

export interface TishOSCommandRunRequest {
    vaultName: string;
    clientID: string;
    commandID: string;
    entryDigest: string;
    requestID: string;
    issuedAt: string;
    mac: string;
}

export interface TishOSCommandRevokeRequest {
    vaultName: string;
    clientID: string;
    requestID: string;
    issuedAt: string;
    mac: string;
}

export interface TishOSNotificationActionRequest {
    vaultName: string;
    clientID: string;
    itemID: string;
    action: "complete";
    requestID: string;
    issuedAt: string;
    mac: string;
}

export interface NormalizedCommandRegistry {
    commands: ObsidianCommandValue[];
    invalidCount: number;
    duplicateCount: number;
    ambiguousDuplicateCount: number;
    rejectedForLimit: boolean;
}

const encoder = new TextEncoder();

export function utf8Bytes(value: string): Uint8Array {
    return encoder.encode(value);
}

export function utf8ByteCount(value: string): number {
    return utf8Bytes(value).byteLength;
}

function field(name: string, value: string): string {
    return `${name}:${utf8ByteCount(value)}:${value}\n`;
}

export function normalizeUUID(value: string): string | null {
    if (typeof value !== "string" || !CANONICAL_UUID.test(value)) return null;
    return value;
}

export function isCanonicalBase64URLSHA256(value: string): boolean {
    if (typeof value !== "string" || !BASE64URL_SHA256.test(value)) return false;
    try {
        return encodeBase64URL(decodeBase64URL(value)) === value && decodeBase64URL(value).byteLength === 32;
    } catch {
        return false;
    }
}

export function hasUnpairedUTF16Surrogate(value: string): boolean {
    for (let index = 0; index < value.length; index += 1) {
        const codeUnit = value.charCodeAt(index);
        if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
            const next = value.charCodeAt(index + 1);
            if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
            index += 1;
        } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
            return true;
        }
    }
    return false;
}

function hasForbiddenBoundaryWhitespace(value: string): boolean {
    return value !== value.trim()
        || value.startsWith("\u200b")
        || value.endsWith("\u200b")
        || value.startsWith("\ufeff")
        || value.endsWith("\ufeff");
}

function isValidBoundedText(value: unknown, maxBytes: number): value is string {
    if (
        typeof value !== "string"
        || !value
        || hasForbiddenBoundaryWhitespace(value)
        || FORBIDDEN_DISPLAY_CHARACTER.test(value)
        || hasUnpairedUTF16Surrogate(value)
    ) return false;
    return utf8ByteCount(value) <= maxBytes;
}

export function isValidCommandID(value: unknown): value is string {
    return isValidBoundedText(value, TISHOS_COMMAND_BRIDGE_MAX_COMMAND_ID_BYTES);
}

export function isValidCommandName(value: unknown): value is string {
    return isValidBoundedText(value, TISHOS_COMMAND_BRIDGE_MAX_COMMAND_NAME_BYTES);
}

export function isValidDeviceName(value: unknown): value is string {
    return isValidBoundedText(value, TISHOS_COMMAND_BRIDGE_MAX_DEVICE_BYTES);
}

export function isValidPlatform(value: unknown): value is "ios" | "ipados" | "macos" {
    return value === "ios" || value === "ipados" || value === "macos";
}

export function isValidVaultName(value: unknown): value is string {
    return isValidBoundedText(value, 256);
}

export function isCanonicalGeneratedAt(value: unknown): value is string {
    if (typeof value !== "string" || !GENERATED_AT.test(value)) return false;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

export function isCanonicalIssuedAt(value: unknown): value is string {
    if (typeof value !== "string" || !ISSUED_AT.test(value)) return false;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 && String(parsed) === value;
}

export function isFreshIssuedAt(value: string, nowMs = Date.now()): boolean {
    if (!isCanonicalIssuedAt(value)) return false;
    const issuedAt = Number(value);
    return nowMs - issuedAt <= TISHOS_COMMAND_BRIDGE_MAX_REQUEST_AGE_MS
        && issuedAt - nowMs <= TISHOS_COMMAND_BRIDGE_MAX_FUTURE_SKEW_MS;
}

export function compareUTF8(left: string, right: string): number {
    const a = utf8Bytes(left);
    const b = utf8Bytes(right);
    const count = Math.min(a.length, b.length);
    for (let index = 0; index < count; index += 1) {
        if (a[index] !== b[index]) return a[index] - b[index];
    }
    return a.length - b.length;
}

export function normalizeCommandRegistry(values: readonly unknown[]): NormalizedCommandRegistry {
    const groups = new Map<string, Set<string>>();
    let invalidCount = 0;
    let duplicateCount = 0;

    for (const value of values) {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
            invalidCount += 1;
            continue;
        }
        const id = (value as Record<string, unknown>).id;
        const name = (value as Record<string, unknown>).name;
        if (!isValidCommandID(id) || !isValidCommandName(name)) {
            invalidCount += 1;
            continue;
        }
        const names = groups.get(id);
        if (names) {
            duplicateCount += 1;
            names.add(name);
        } else {
            groups.set(id, new Set([name]));
        }
    }

    const commands: ObsidianCommandValue[] = [];
    let ambiguousDuplicateCount = 0;
    for (const [id, names] of groups) {
        if (names.size !== 1) {
            ambiguousDuplicateCount += 1;
            continue;
        }
        commands.push({ id, name: names.values().next().value as string });
    }
    commands.sort((left, right) => compareUTF8(left.id, right.id));
    const rejectedForLimit = commands.length > TISHOS_COMMAND_BRIDGE_MAX_COMMANDS;
    return {
        commands: rejectedForLimit ? [] : commands,
        invalidCount,
        duplicateCount,
        ambiguousDuplicateCount,
        rejectedForLimit,
    };
}

export function canonicalCommandEntry(command: ObsidianCommandValue): Uint8Array {
    return utf8Bytes(`${ENTRY_PREFIX}${field("id", command.id)}${field("name", command.name)}`);
}

export async function commandEntryDigest(command: ObsidianCommandValue): Promise<string> {
    return sha256Base64URL(canonicalCommandEntry(command));
}

export function canonicalCommandCatalog(catalog: Omit<TishOSCommandCatalog, "mac">): Uint8Array {
    let value = CATALOG_PREFIX;
    value += "schema:1\n";
    value += field("client", catalog.clientID);
    value += field("vault", catalog.vaultName);
    value += field("generated", catalog.generatedAt);
    value += field("publisher-id", catalog.publisher.id);
    value += field("publisher-version", catalog.publisher.version);
    value += `commands:${catalog.commands.length}\n`;
    for (const command of catalog.commands) value += field("entry", command.digest);
    return utf8Bytes(value);
}

export function canonicalCommandRunRequest(request: Omit<TishOSCommandRunRequest, "mac">): Uint8Array {
    let value = REQUEST_PREFIX;
    value += field("vault", request.vaultName);
    value += field("client", request.clientID);
    value += field("command", request.commandID);
    value += field("entry", request.entryDigest);
    value += field("request", request.requestID);
    value += field("issued", request.issuedAt);
    return utf8Bytes(value);
}

export function canonicalCommandRevokeRequest(request: Omit<TishOSCommandRevokeRequest, "mac">): Uint8Array {
    let value = REVOKE_PREFIX;
    value += field("vault", request.vaultName);
    value += field("client", request.clientID);
    value += field("request", request.requestID);
    value += field("issued", request.issuedAt);
    return utf8Bytes(value);
}

export function canonicalNotificationActionRequest(
    request: Omit<TishOSNotificationActionRequest, "mac">,
): Uint8Array {
    let value = NOTIFICATION_ACTION_PREFIX;
    value += field("vault", request.vaultName);
    value += field("client", request.clientID);
    value += field("item", request.itemID);
    value += field("action", request.action);
    value += field("request", request.requestID);
    value += field("issued", request.issuedAt);
    return utf8Bytes(value);
}

export function encodeBase64URL(bytes: Uint8Array): string {
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function decodeBase64URL(value: string): Uint8Array {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid Base64URL value.");
    const padding = "=".repeat((4 - value.length % 4) % 4);
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + padding);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
}

function webCrypto(): Crypto {
    const value = globalThis.crypto;
    if (!value?.subtle) throw new Error("Web Crypto is unavailable.");
    return value;
}

export async function sha256Base64URL(bytes: Uint8Array): Promise<string> {
    const digest = await webCrypto().subtle.digest("SHA-256", bytes);
    return encodeBase64URL(new Uint8Array(digest));
}

export async function hmacSHA256Base64URL(secret: Uint8Array, bytes: Uint8Array): Promise<string> {
    const key = await webCrypto().subtle.importKey(
        "raw",
        secret,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
    );
    const signature = await webCrypto().subtle.sign("HMAC", key, bytes);
    return encodeBase64URL(new Uint8Array(signature));
}

export async function verifyHmacSHA256Base64URL(
    secret: Uint8Array,
    bytes: Uint8Array,
    signature: string,
): Promise<boolean> {
    if (!isCanonicalBase64URLSHA256(signature)) return false;
    const key = await webCrypto().subtle.importKey(
        "raw",
        secret,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["verify"],
    );
    return webCrypto().subtle.verify("HMAC", key, decodeBase64URL(signature), bytes);
}

export async function buildSignedCommandCatalog(
    clientID: string,
    vaultName: string,
    generatedAt: string,
    publisher: { id: string; version: string },
    commands: readonly ObsidianCommandValue[],
    secret: Uint8Array,
): Promise<TishOSCommandCatalog> {
    const entries: TishOSCommandCatalogEntry[] = [];
    for (const command of commands) {
        entries.push({ ...command, digest: await commandEntryDigest(command) });
    }
    const unsigned: Omit<TishOSCommandCatalog, "mac"> = {
        schemaVersion: 1,
        clientID,
        vaultName,
        generatedAt,
        publisher,
        commands: entries,
    };
    return {
        ...unsigned,
        mac: await hmacSHA256Base64URL(secret, canonicalCommandCatalog(unsigned)),
    };
}

export async function semanticCatalogFingerprint(
    clientID: string,
    vaultName: string,
    publisher: { id: string; version: string },
    commands: readonly ObsidianCommandValue[],
): Promise<string> {
    const entries: TishOSCommandCatalogEntry[] = [];
    for (const command of commands) entries.push({ ...command, digest: await commandEntryDigest(command) });
    return sha256Base64URL(canonicalCommandCatalog({
        schemaVersion: 1,
        clientID,
        vaultName,
        generatedAt: "",
        publisher,
        commands: entries,
    }));
}
