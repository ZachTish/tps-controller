import { Sha256 } from "@aws-crypto/sha256-js";
import { ATTACHMENT_CHUNK_BYTES } from "./model";

export { ATTACHMENT_CHUNK_BYTES } from "./model";
export const ATTACHMENT_CATALOG_MAX_BYTES = 16 * 1024 * 1024;
export const ATTACHMENT_ENCRYPTION_OVERHEAD = 29;
const RECOVERY_PREFIX = "tps-attachments-v1:";
const NONCE_BYTES = 12;
const encoder = new TextEncoder();

export interface AttachmentEncryptionContext {
    kind: "catalog" | "chunk";
    collectionId: string;
    revision?: string;
    index?: number;
}

function cryptoProvider(provider?: Crypto): Crypto {
    const available = provider || globalThis.crypto;
    if (!available?.subtle || !available.getRandomValues) {
        throw new Error("Attachment encryption requires Web Crypto on this device.");
    }
    return available;
}

function encodeKey(bytes: Uint8Array): string {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeKey(value: string): Uint8Array {
    const trimmed = value.trim();
    if (!trimmed.startsWith(RECOVERY_PREFIX)) throw new Error("The attachment recovery key has an unsupported format.");
    const encoded = trimmed.slice(RECOVERY_PREFIX.length);
    if (!/^[A-Za-z0-9_-]{43}$/.test(encoded)) throw new Error("The attachment recovery key must contain 32 random bytes.");
    const binary = atob(encoded.replace(/-/g, "+").replace(/_/g, "/") + "=");
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    if (bytes.length !== 32 || encodeKey(bytes) !== encoded) throw new Error("The attachment recovery key is invalid.");
    return bytes;
}

/** Recovery material is deliberately returned to the caller; never persist it in plugin settings. */
export function generateRecoveryKey(provider?: Crypto): string {
    const bytes = cryptoProvider(provider).getRandomValues(new Uint8Array(32));
    try {
        return RECOVERY_PREFIX + encodeKey(bytes);
    } finally {
        bytes.fill(0);
    }
}

export function randomId(provider?: Crypto): string {
    return Array.from(cryptoProvider(provider).getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Validates and normalizes a user-supplied key for device-local SecretStorage/export. */
export function normalizeRecoveryKey(value: string): string {
    const bytes = decodeKey(value);
    try {
        return RECOVERY_PREFIX + encodeKey(bytes);
    } finally {
        bytes.fill(0);
    }
}

function associatedData(context: AttachmentEncryptionContext): Uint8Array {
    if (typeof context.collectionId !== "string" || !context.collectionId || context.collectionId.length > 256) {
        throw new Error("Attachment encryption requires a valid collection identity.");
    }
    if (context.kind === "catalog") {
        if (context.revision !== undefined || context.index !== undefined) throw new Error("Invalid catalog encryption context.");
        return encoder.encode(JSON.stringify(["tps-controller-attachment-sync", 1, context.collectionId, "catalog"]));
    }
    if (context.kind !== "chunk" || typeof context.revision !== "string" || !context.revision || context.revision.length > 256
        || !Number.isSafeInteger(context.index) || context.index! < 0) {
        throw new Error("Attachment chunks require a revision and nonnegative chunk index.");
    }
    return encoder.encode(JSON.stringify(["tps-controller-attachment-sync", 1, context.collectionId, "chunk", context.revision, context.index]));
}

function maximumPlaintext(context: AttachmentEncryptionContext): number {
    return context.kind === "catalog" ? ATTACHMENT_CATALOG_MAX_BYTES : ATTACHMENT_CHUNK_BYTES;
}

export class AttachmentCrypto {
    private constructor(private readonly key: CryptoKey, private readonly provider: Crypto) {}

    static async fromRecoveryKey(value: string, provider?: Crypto): Promise<AttachmentCrypto> {
        const available = cryptoProvider(provider);
        const bytes = decodeKey(value);
        try {
            const key = await available.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
            return new AttachmentCrypto(key, available);
        } finally {
            bytes.fill(0);
        }
    }

    async encrypt(data: Uint8Array, context: AttachmentEncryptionContext): Promise<Uint8Array> {
        const additionalData = associatedData(context);
        if (data.byteLength > maximumPlaintext(context)) throw new Error("Attachment encryption input exceeds its bounded size limit.");
        const nonce = this.provider.getRandomValues(new Uint8Array(NONCE_BYTES));
        const ciphertext = await this.provider.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData, tagLength: 128 }, this.key, data);
        const envelope = new Uint8Array(1 + NONCE_BYTES + ciphertext.byteLength);
        envelope[0] = 1;
        envelope.set(nonce, 1);
        envelope.set(new Uint8Array(ciphertext), 1 + NONCE_BYTES);
        return envelope;
    }

    async decrypt(data: Uint8Array, context: AttachmentEncryptionContext): Promise<Uint8Array> {
        const additionalData = associatedData(context);
        if (data.byteLength < ATTACHMENT_ENCRYPTION_OVERHEAD || data.byteLength > maximumPlaintext(context) + ATTACHMENT_ENCRYPTION_OVERHEAD || data[0] !== 1) {
            throw new Error("Attachment encrypted content has an invalid format or size.");
        }
        try {
            const plaintext = await this.provider.subtle.decrypt({
                name: "AES-GCM", iv: data.subarray(1, 1 + NONCE_BYTES), additionalData, tagLength: 128,
            }, this.key, data.subarray(1 + NONCE_BYTES));
            return new Uint8Array(plaintext);
        } catch {
            throw new Error("Attachment authentication failed. Check the recovery key and collection; content was not applied.");
        }
    }
}

export function importRecoveryKey(value: string, provider?: Crypto): Promise<AttachmentCrypto> {
    return AttachmentCrypto.fromRecoveryKey(value, provider);
}

export interface IncrementalAttachmentHash {
    update(data: Uint8Array): void;
    digestHex(): Promise<string>;
}

/** Incremental SHA-256 never retains the file-sized input. */
export function createSha256(): IncrementalAttachmentHash {
    const hasher = new Sha256();
    let finalized = false;
    return {
        update(data) {
            if (finalized) throw new Error("Attachment hash has already been finalized.");
            hasher.update(data);
        },
        async digestHex() {
            if (finalized) throw new Error("Attachment hash has already been finalized.");
            finalized = true;
            return Array.from(await hasher.digest(), (byte) => byte.toString(16).padStart(2, "0")).join("");
        },
    };
}
