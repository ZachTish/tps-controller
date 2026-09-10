import type { AttachmentCatalog, CatalogSnapshot, RemoteStore } from "./model";
import { AttachmentCrypto, ATTACHMENT_CHUNK_BYTES, ATTACHMENT_CATALOG_MAX_BYTES, ATTACHMENT_ENCRYPTION_OVERHEAD, createSha256 } from "./crypto";

export interface GcsRequestParameters {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: ArrayBuffer;
    throw: false;
}

export interface GcsResponse {
    status: number;
    headers: Record<string, string>;
    arrayBuffer: ArrayBuffer;
}

export type GcsRequest = (parameters: GcsRequestParameters) => Promise<GcsResponse>;

export interface GcsAttachmentRemoteOptions {
    endpoint: string;
    bucket: string;
    prefix: string;
    collectionId: string;
    credentials: { accessKeyId: string; secretAccessKey: string };
    crypto: AttachmentCrypto;
    request: GcsRequest;
    now?: () => Date;
    webCrypto?: Crypto;
    /** Stops later network boundaries when the service is paused, unloaded, or reconfigured. */
    checkCurrent?: () => void;
}

export interface GcsObjectHead { size: number; generation: string; }
export interface GcsBucketPolicy {
    versioning: "enabled" | "disabled" | "unknown";
    softDelete: "unknown";
    retention: "unknown";
    warnings: string[];
}

export class GcsAttachmentRemoteError extends Error {
    constructor(readonly code: "configuration" | "http" | "precondition" | "invalid-response", message: string, readonly status?: number) {
        super(message);
        this.name = "GcsAttachmentRemoteError";
    }
}

const utf8 = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });
const HEX_HASH = /^[a-f0-9]{64}$/;

function encodeSegment(value: string): string {
    return encodeURIComponent(value).replace(/[!'()*]/g, (character) => "%" + character.charCodeAt(0).toString(16).toUpperCase());
}

function safeIdentity(value: string): string {
    if (!/^[a-zA-Z0-9_-]{1,256}$/.test(value)) throw new GcsAttachmentRemoteError("configuration", "Attachment collection and revision identities must be opaque letters, numbers, hyphens, or underscores.");
    return value;
}

function safeObjectKey(value: string): string {
    if (!value || value.startsWith("/") || value.endsWith("/") || value.includes("\\") || /[\u0000-\u001f\u007f]/.test(value)
        || value.split("/").some((part) => !part || part === "." || part === "..")) {
        throw new GcsAttachmentRemoteError("configuration", "The attachment object key is invalid.");
    }
    return value;
}

function headersLowercase(headers: Record<string, string>): Record<string, string> {
    const normalized: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers)) normalized[name.toLowerCase()] = String(value);
    return normalized;
}

function generation(value: string | undefined): string {
    if (!value || !/^[1-9][0-9]*$/.test(value)) throw new GcsAttachmentRemoteError("invalid-response", "Cloud Storage did not return a valid object generation.");
    return value;
}

function exactBuffer(bytes: Uint8Array): ArrayBuffer {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function hashHex(bytes: Uint8Array): Promise<string> {
    const hasher = createSha256();
    hasher.update(bytes);
    return hasher.digestHex();
}

/** The URL supplied here is constructed by GcsAttachmentRemote, never taken from cloud response bodies. */
export async function signGcsRequest(input: {
    url: string;
    method: string;
    headers?: Record<string, string>;
    body?: Uint8Array;
    credentials: { accessKeyId: string; secretAccessKey: string };
    now?: Date;
    webCrypto?: Crypto;
}): Promise<{ headers: Record<string, string>; canonicalRequest: string; stringToSign: string }> {
    const provider = input.webCrypto || globalThis.crypto;
    if (!provider?.subtle) throw new GcsAttachmentRemoteError("configuration", "Cloud Storage signing requires Web Crypto on this device.");
    if (!/^[A-Za-z0-9_-]+$/.test(input.credentials.accessKeyId) || !input.credentials.secretAccessKey) {
        throw new GcsAttachmentRemoteError("configuration", "Cloud Storage HMAC credentials are missing or invalid.");
    }
    const url = new URL(input.url);
    const headers = headersLowercase(input.headers || {});
    if (headers.authorization) throw new GcsAttachmentRemoteError("configuration", "Unexpected authorization override.");
    const timestamp = (input.now || new Date()).toISOString().replace(/[:-]|\.\d{3}/g, "");
    const day = timestamp.slice(0, 8);
    headers.host = url.host;
    headers["x-amz-date"] = timestamp;
    headers["x-amz-content-sha256"] = await hashHex(input.body || new Uint8Array());
    const query: Array<[string, string]> = [];
    url.searchParams.forEach((value, key) => query.push([encodeSegment(key), encodeSegment(value)]));
    query.sort(([leftKey, leftValue], [rightKey, rightValue]) => leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0);
    const names = Object.keys(headers).sort();
    for (const name of names) {
        if (/\r|\n/.test(headers[name])) throw new GcsAttachmentRemoteError("configuration", "Cloud Storage request headers contain invalid whitespace.");
        headers[name] = headers[name].trim().replace(/\s+/g, " ");
    }
    const canonicalRequest = [input.method.toUpperCase(), url.pathname,
        query.map(([key, value]) => `${key}=${value}`).join("&"),
        names.map((name) => `${name}:${headers[name]}\n`).join(""), names.join(";"), headers["x-amz-content-sha256"]].join("\n");
    const scope = `${day}/auto/s3/aws4_request`;
    const stringToSign = ["AWS4-HMAC-SHA256", timestamp, scope, await hashHex(utf8.encode(canonicalRequest))].join("\n");
    const hmac = async (keyBytes: Uint8Array, value: string): Promise<Uint8Array> => {
        const key = await provider.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
        return new Uint8Array(await provider.subtle.sign("HMAC", key, utf8.encode(value)));
    };
    let signingKey = utf8.encode("AWS4" + input.credentials.secretAccessKey);
    for (const component of [day, "auto", "s3", "aws4_request"]) {
        const next = await hmac(signingKey, component);
        signingKey.fill(0);
        signingKey = next;
    }
    try {
        const signature = Array.from(await hmac(signingKey, stringToSign), (byte) => byte.toString(16).padStart(2, "0")).join("");
        headers.authorization = `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`;
    } finally {
        signingKey.fill(0);
    }
    // The native HTTP implementation owns Host; its value is still signed above.
    delete headers.host;
    return { headers, canonicalRequest, stringToSign };
}

export class GcsAttachmentRemote implements RemoteStore {
    private readonly bucketUrl: string;
    private readonly collectionPrefix: string;

    constructor(private readonly options: GcsAttachmentRemoteOptions) {
        let endpoint: URL;
        try { endpoint = new URL(options.endpoint); } catch { throw new GcsAttachmentRemoteError("configuration", "Enter a valid Cloud Storage HTTPS endpoint."); }
        if (!/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(options.bucket)) throw new GcsAttachmentRemoteError("configuration", "Enter a valid Cloud Storage bucket name.");
        const virtualHost = `${options.bucket}.storage.googleapis.com`;
        if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
            || (endpoint.port && endpoint.port !== "443") || endpoint.pathname !== "/"
            || !["storage.googleapis.com", virtualHost].includes(endpoint.hostname)) {
            throw new GcsAttachmentRemoteError("configuration", "Attachment sync uses https://storage.googleapis.com or this bucket's storage.googleapis.com endpoint.");
        }
        this.bucketUrl = endpoint.hostname === virtualHost ? endpoint.origin : `${endpoint.origin}/${encodeSegment(options.bucket)}`;
        const prefix = safeObjectKey(options.prefix.replace(/^\/+|\/+$/g, ""));
        this.collectionPrefix = `${prefix}/${safeIdentity(options.collectionId)}`;
    }

    private objectUrl(key: string): string {
        return `${this.bucketUrl}/${safeObjectKey(key).split("/").map(encodeSegment).join("/")}`;
    }

    private catalogKey(): string { return `${this.collectionPrefix}/catalog.bin`; }
    private chunkKey(revisionId: string, index: number): string {
        if (!Number.isSafeInteger(index) || index < 0) throw new GcsAttachmentRemoteError("configuration", "Invalid attachment chunk index.");
        return `${this.collectionPrefix}/chunks/${safeIdentity(revisionId)}/${index}.bin`;
    }

    private async request(url: string, method: string, headers: Record<string, string> = {}, body?: Uint8Array): Promise<GcsResponse> {
        this.options.checkCurrent?.();
        const signed = await signGcsRequest({ url, method, headers, body, credentials: this.options.credentials,
            now: this.options.now?.(), webCrypto: this.options.webCrypto });
        this.options.checkCurrent?.();
        let response: GcsResponse;
        try {
            response = await this.options.request({ url, method, headers: signed.headers,
                ...(body ? { body: exactBuffer(body) } : {}), throw: false });
        } catch {
            // Native errors can contain signed request details; never rethrow those payloads.
            throw new GcsAttachmentRemoteError("http", "Cloud Storage request failed; local files were preserved.");
        }
        this.options.checkCurrent?.();
        if (response.status >= 300 && response.status < 400) {
            throw new GcsAttachmentRemoteError("http", "Cloud Storage returned an unexpected redirect; attachment sync will not retry it.", response.status);
        }
        return { ...response, headers: headersLowercase(response.headers) };
    }

    private requireStatus(response: GcsResponse, allowed: number[]): void {
        if (!allowed.includes(response.status)) throw new GcsAttachmentRemoteError(response.status === 412 ? "precondition" : "http",
            `Cloud Storage attachment request returned HTTP ${response.status}.`, response.status);
    }

    private async head(key: string): Promise<GcsObjectHead | null> {
        const response = await this.request(this.objectUrl(key), "HEAD");
        if (response.status === 404) return null;
        this.requireStatus(response, [200]);
        const sizeText = response.headers["content-length"];
        const size = Number(sizeText);
        if (!sizeText || !/^[0-9]+$/.test(sizeText) || !Number.isSafeInteger(size) || size < 0) throw new GcsAttachmentRemoteError("invalid-response", "Cloud Storage returned an invalid attachment size.");
        if (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity") throw new GcsAttachmentRemoteError("invalid-response", "Encoded Cloud Storage objects require an explicit byte-preserving migration.");
        return { size, generation: generation(response.headers["x-goog-generation"]) };
    }

    private async readRange(key: string, offset: number, length: number, expectedGeneration: string, maximum = ATTACHMENT_CHUNK_BYTES + ATTACHMENT_ENCRYPTION_OVERHEAD): Promise<Uint8Array> {
        generation(expectedGeneration);
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length <= 0 || length > maximum
            || !Number.isSafeInteger(offset + length)) throw new GcsAttachmentRemoteError("configuration", "Invalid bounded attachment read.");
        const response = await this.request(this.objectUrl(key), "GET", {
            range: `bytes=${offset}-${offset + length - 1}`, "x-goog-if-generation-match": expectedGeneration,
        });
        this.requireStatus(response, [206]);
        const match = /^bytes ([0-9]+)-([0-9]+)\/([0-9]+)$/.exec(response.headers["content-range"] || "");
        if (!match || Number(match[1]) !== offset || Number(match[2]) !== offset + length - 1
            || !Number.isSafeInteger(Number(match[3])) || Number(match[3]) < offset + length || response.arrayBuffer.byteLength !== length
            || generation(response.headers["x-goog-generation"]) !== expectedGeneration) {
            throw new GcsAttachmentRemoteError("invalid-response", "Cloud Storage returned an unexpected attachment byte range.");
        }
        return new Uint8Array(response.arrayBuffer);
    }

    private async readEncrypted(key: string, max: number): Promise<{ bytes: Uint8Array; generation: string } | null> {
        const head = await this.head(key);
        if (!head) return null;
        if (head.size < ATTACHMENT_ENCRYPTION_OVERHEAD || head.size > max + ATTACHMENT_ENCRYPTION_OVERHEAD) {
            throw new GcsAttachmentRemoteError("invalid-response", "Encrypted attachment data exceeds its bounded size limit.");
        }
        const bytes = await this.readRange(key, 0, head.size, head.generation, max + ATTACHMENT_ENCRYPTION_OVERHEAD);
        return { bytes, generation: head.generation };
    }

    async getCatalog(): Promise<CatalogSnapshot | null> {
        const stored = await this.readEncrypted(this.catalogKey(), ATTACHMENT_CATALOG_MAX_BYTES);
        if (!stored) return null;
        const plaintext = await this.options.crypto.decrypt(stored.bytes, { kind: "catalog", collectionId: this.options.collectionId });
        let catalog: AttachmentCatalog;
        try { catalog = JSON.parse(textDecoder.decode(plaintext)); } catch { throw new GcsAttachmentRemoteError("invalid-response", "The decrypted attachment catalog is not valid JSON."); }
        this.validateCatalog(catalog);
        return { catalog, generation: stored.generation };
    }

    private validateCatalog(catalog: AttachmentCatalog): void {
        const dictionary = (value: unknown): boolean => !!value && typeof value === "object" && !Array.isArray(value);
        if (!catalog || catalog.version !== 1 || catalog.collectionId !== this.options.collectionId
            || !Number.isSafeInteger(catalog.sequence) || catalog.sequence < 0
            || !dictionary(catalog.records) || !dictionary(catalog.uploads) || !dictionary(catalog.garbage)) {
            throw new GcsAttachmentRemoteError("invalid-response", "The attachment catalog is invalid or belongs to another collection.");
        }
    }

    async compareAndSwapCatalog(expectedGeneration: string | null, catalog: AttachmentCatalog): Promise<CatalogSnapshot | null> {
        this.validateCatalog(catalog);
        const plain = utf8.encode(JSON.stringify(catalog));
        const encrypted = await this.options.crypto.encrypt(plain, { kind: "catalog", collectionId: this.options.collectionId });
        const response = await this.request(this.objectUrl(this.catalogKey()), "PUT", {
            "content-type": "application/octet-stream", "cache-control": "no-store, no-transform",
            "x-goog-if-generation-match": expectedGeneration === null ? "0" : generation(expectedGeneration),
        }, encrypted);
        if (response.status === 412) return null;
        this.requireStatus(response, [200, 201]);
        return { catalog, generation: generation(response.headers["x-goog-generation"]) };
    }

    async putChunk(revisionId: string, index: number, bytes: Uint8Array, sha256: string): Promise<void> {
        if (bytes.byteLength > ATTACHMENT_CHUNK_BYTES || !HEX_HASH.test(sha256) || await hashHex(bytes) !== sha256) {
            throw new GcsAttachmentRemoteError("configuration", "Attachment chunk content does not match its expected size or hash.");
        }
        const key = this.chunkKey(revisionId, index);
        // Resume from the durable cloud chunk: avoid sending already uploaded file bytes again.
        const stored = await this.readEncrypted(key, ATTACHMENT_CHUNK_BYTES);
        if (stored) {
            const existing = await this.options.crypto.decrypt(stored.bytes, { kind: "chunk", collectionId: this.options.collectionId, revision: revisionId, index });
            if (existing.byteLength !== bytes.byteLength || await hashHex(existing) !== sha256) throw new GcsAttachmentRemoteError("precondition", "An immutable attachment chunk already exists with different content.", 412);
            return;
        }
        const encrypted = await this.options.crypto.encrypt(bytes, { kind: "chunk", collectionId: this.options.collectionId, revision: revisionId, index });
        const response = await this.request(this.objectUrl(key), "PUT", {
            "content-type": "application/octet-stream", "cache-control": "no-store, no-transform", "x-goog-if-generation-match": "0",
        }, encrypted);
        if (response.status === 412) {
            const existing = await this.getChunk(revisionId, index);
            if (existing.byteLength !== bytes.byteLength || await hashHex(existing) !== sha256) throw new GcsAttachmentRemoteError("precondition", "An immutable attachment chunk already exists with different content.", 412);
            return;
        }
        this.requireStatus(response, [200, 201]);
    }

    async getChunk(revisionId: string, index: number): Promise<Uint8Array> {
        const stored = await this.readEncrypted(this.chunkKey(revisionId, index), ATTACHMENT_CHUNK_BYTES);
        if (!stored) throw new GcsAttachmentRemoteError("http", "An attachment revision is missing a required cloud chunk.", 404);
        return this.options.crypto.decrypt(stored.bytes, { kind: "chunk", collectionId: this.options.collectionId, revision: revisionId, index });
    }

    private async deleteGeneration(key: string, expectedGeneration: string): Promise<void> {
        const response = await this.request(this.objectUrl(key), "DELETE", { "x-goog-if-generation-match": generation(expectedGeneration) });
        this.requireStatus(response, [200, 204, 404]);
    }

    async deleteRevision(revisionId: string, chunkCount: number): Promise<void> {
        if (!Number.isSafeInteger(chunkCount) || chunkCount < 0 || chunkCount > 1000000) throw new GcsAttachmentRemoteError("configuration", "Invalid retired attachment chunk count.");
        for (let index = 0; index < chunkCount; index++) {
            const key = this.chunkKey(revisionId, index);
            const current = await this.head(key);
            if (current) await this.deleteGeneration(key, current.generation);
        }
    }

    /** Explicit legacy migration only: exact configured bucket keys, never arbitrary public URLs. */
    async headLegacyObject(key: string): Promise<GcsObjectHead | null> { return this.head(safeObjectKey(key)); }
    async readLegacyRange(key: string, offset: number, length: number, expectedGeneration: string): Promise<Uint8Array> {
        return this.readRange(safeObjectKey(key), offset, length, expectedGeneration, ATTACHMENT_CHUNK_BYTES);
    }
    async deleteLegacyObject(key: string, expectedGeneration: string): Promise<void> { return this.deleteGeneration(safeObjectKey(key), expectedGeneration); }

    async getBucketPolicy(): Promise<GcsBucketPolicy> {
        const result: GcsBucketPolicy = { versioning: "unknown", softDelete: "unknown", retention: "unknown", warnings: [] };
        try {
            const response = await this.request(`${this.bucketUrl}?versioning`, "GET");
            if (response.status === 200 && response.arrayBuffer.byteLength <= 65536) {
                const xml = textDecoder.decode(response.arrayBuffer);
                const enabled = /<(?:[A-Za-z0-9_]+:)?Enabled>\s*(true|false)\s*<\/(?:[A-Za-z0-9_]+:)?Enabled>/.exec(xml);
                if (enabled) result.versioning = enabled[1] === "true" ? "enabled" : "disabled";
                else if (/<(?:[A-Za-z0-9_]+:)?VersioningConfiguration\b[^>]*\/>/.test(xml)) result.versioning = "disabled";
            }
        } catch { /* Policy introspection is read-only and optional; unknown remains explicit. */ }
        if (result.versioning === "enabled") result.warnings.push("Bucket versioning retains older object generations after sync deletes them.");
        if (result.versioning === "unknown") result.warnings.push("Bucket versioning could not be verified with the configured HMAC permissions.");
        result.warnings.push("Soft-delete and retention policies are unknown through this XML connection; verify them in Google Cloud before expecting deleted bytes to stop consuming storage.");
        return result;
    }
}
