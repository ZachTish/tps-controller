import type { S3agleAttachmentAutomationSettings } from "../../types";

export interface AttachmentSyncSettings {
    schema: 1;
    enabled: boolean;
    provider: "gcs";
    endpoint: string;
    bucket: string;
    prefix: string;
    collectionId: string;
    accessKeySecretName: string;
    secretKeySecretName: string;
    recoveryKeySecretName: string;
    excludedPaths: string[];
}

export const DEFAULT_ATTACHMENT_SYNC_SETTINGS: AttachmentSyncSettings = {
    schema: 1,
    enabled: false,
    provider: "gcs",
    endpoint: "https://storage.googleapis.com",
    bucket: "",
    prefix: "tps-attachment-sync",
    collectionId: "",
    accessKeySecretName: "tps-controller-s3-access-key",
    secretKeySecretName: "tps-controller-s3-secret-key",
    recoveryKeySecretName: "tps-controller-attachment-sync-recovery-key",
    excludedPaths: [],
};

/** Connection migration never enrolls a device or carries forward offloading behavior. */
export function normalizeAttachmentSyncSettings(
    value: unknown,
    legacy?: Partial<S3agleAttachmentAutomationSettings>,
): AttachmentSyncSettings {
    const raw = value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown> : {};
    if ((raw.schema !== undefined && raw.schema !== 1) || (raw.provider !== undefined && raw.provider !== "gcs")) {
        throw new Error("This attachment sync configuration needs a newer Controller version.");
    }
    const text = (key: keyof AttachmentSyncSettings, fallback: string): string =>
        typeof raw[key] === "string" ? (raw[key] as string).trim() : fallback;
    const oldPrefix = String(legacy?.folder || "").replace(/^\/+|\/+$/g, "");
    return {
        schema: 1,
        enabled: raw.enabled === true,
        provider: "gcs",
        endpoint: text("endpoint", legacy?.endpoint || DEFAULT_ATTACHMENT_SYNC_SETTINGS.endpoint),
        bucket: text("bucket", legacy?.bucket || ""),
        prefix: text("prefix", [oldPrefix, "tps-attachment-sync"].filter(Boolean).join("/")),
        collectionId: text("collectionId", ""),
        accessKeySecretName: text("accessKeySecretName", legacy?.accessKeySecretName || DEFAULT_ATTACHMENT_SYNC_SETTINGS.accessKeySecretName),
        secretKeySecretName: text("secretKeySecretName", legacy?.secretKeySecretName || DEFAULT_ATTACHMENT_SYNC_SETTINGS.secretKeySecretName),
        recoveryKeySecretName: text("recoveryKeySecretName", DEFAULT_ATTACHMENT_SYNC_SETTINGS.recoveryKeySecretName),
        excludedPaths: Array.isArray(raw.excludedPaths)
            ? [...new Set(raw.excludedPaths.filter((entry): entry is string => typeof entry === "string")
                .map(entry => entry.trim().replace(/\/+$/g, "")).filter(Boolean))] : [],
    };
}

export function attachmentSyncConnectionIdentity(settings: AttachmentSyncSettings): string {
    return JSON.stringify([settings.provider, settings.endpoint.replace(/\/+$/g, ""), settings.bucket,
        settings.prefix.replace(/^\/+|\/+$/g, ""), settings.collectionId]);
}
