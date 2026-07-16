export const DEFAULT_S3_ACCESS_KEY_SECRET_NAME = "tps-controller-s3-access-key";
export const DEFAULT_S3_SECRET_KEY_SECRET_NAME = "tps-controller-s3-secret-key";

export interface S3CredentialReferenceSettings {
    accessKeySecretName: string;
    secretKeySecretName: string;
}

export interface S3ExecutionCredentials {
    accessKeyId: string;
    secretAccessKey: string;
}

export interface S3SecretStorage {
    getSecret(name: string): string | null;
    setSecret(name: string, value: string): void;
}

export type S3CredentialErrorCode =
    | "missing-access-reference"
    | "missing-secret-reference"
    | "conflicting-references"
    | "missing-access-key"
    | "missing-secret-key"
    | "secret-storage-unavailable";

export class S3CredentialConfigurationError extends Error {
    constructor(readonly code: S3CredentialErrorCode, message: string) {
        super(message);
        this.name = "S3CredentialConfigurationError";
    }
}

export interface S3CredentialMigrationResult {
    changed: boolean;
    migrated: number;
    reusedExisting: number;
    retainedLegacy: number;
    failedFields: Array<"access-key" | "secret-key">;
}

export type RetainedLegacyS3Credentials = Partial<Record<"accessKey" | "secretKey", string>>;

const CREDENTIAL_FIELDS = [
    {
        legacyKey: "accessKey",
        referenceKey: "accessKeySecretName",
        defaultReference: DEFAULT_S3_ACCESS_KEY_SECRET_NAME,
        field: "access-key",
    },
    {
        legacyKey: "secretKey",
        referenceKey: "secretKeySecretName",
        defaultReference: DEFAULT_S3_SECRET_KEY_SECRET_NAME,
        field: "secret-key",
    },
] as const;

export function migrateLegacyS3Credentials(
    rule: Record<string, unknown>,
    secretStorage: S3SecretStorage,
): S3CredentialMigrationResult {
    const result: S3CredentialMigrationResult = {
        changed: false,
        migrated: 0,
        reusedExisting: 0,
        retainedLegacy: 0,
        failedFields: [],
    };

    for (const config of CREDENTIAL_FIELDS) {
        const hasReference = Object.prototype.hasOwnProperty.call(rule, config.referenceKey);
        const referenceName = hasReference
            ? String(rule[config.referenceKey] || "").trim()
            : config.defaultReference;
        if (!hasReference || rule[config.referenceKey] !== referenceName) {
            rule[config.referenceKey] = referenceName;
            result.changed = true;
        }

        if (!Object.prototype.hasOwnProperty.call(rule, config.legacyKey)) continue;
        const legacyValue = String(rule[config.legacyKey] || "").trim();
        if (!legacyValue) {
            delete rule[config.legacyKey];
            result.changed = true;
            continue;
        }
        if (!referenceName) {
            result.retainedLegacy += 1;
            result.failedFields.push(config.field);
            continue;
        }

        let existingValue = "";
        try {
            existingValue = String(secretStorage.getSecret(referenceName) || "").trim();
        } catch {
            result.retainedLegacy += 1;
            result.failedFields.push(config.field);
            continue;
        }
        if (existingValue) {
            if (existingValue === legacyValue) {
                delete rule[config.legacyKey];
                result.changed = true;
                result.reusedExisting += 1;
            } else {
                result.retainedLegacy += 1;
                result.failedFields.push(config.field);
            }
            continue;
        }

        try {
            secretStorage.setSecret(referenceName, legacyValue);
            const writtenValue = String(secretStorage.getSecret(referenceName) || "").trim();
            if (writtenValue !== legacyValue) throw new Error("SecretStorage did not confirm the write.");
            delete rule[config.legacyKey];
            result.changed = true;
            result.migrated += 1;
        } catch {
            result.retainedLegacy += 1;
            result.failedFields.push(config.field);
        }
    }

    return result;
}

export function takeRetainedLegacyS3Credentials(rule: Record<string, unknown>): RetainedLegacyS3Credentials {
    const retained: RetainedLegacyS3Credentials = {};
    const accessKey = String(rule.accessKey || "").trim();
    const secretKey = String(rule.secretKey || "").trim();
    if (accessKey) retained.accessKey = accessKey;
    if (secretKey) retained.secretKey = secretKey;
    delete rule.accessKey;
    delete rule.secretKey;
    return retained;
}

export function withRetainedLegacyS3Credentials(
    rule: Record<string, unknown>,
    retained: RetainedLegacyS3Credentials,
): Record<string, unknown> {
    return { ...rule, ...retained };
}

export function resolveS3Credentials(
    settings: S3CredentialReferenceSettings,
    readSecret: (name: string) => string | null,
): S3ExecutionCredentials {
    const accessKeySecretName = String(settings.accessKeySecretName || "").trim();
    const secretKeySecretName = String(settings.secretKeySecretName || "").trim();
    if (!accessKeySecretName) {
        throw new S3CredentialConfigurationError(
            "missing-access-reference",
            "Select a device-local S3 access-key secret in TPS Controller settings.",
        );
    }
    if (!secretKeySecretName) {
        throw new S3CredentialConfigurationError(
            "missing-secret-reference",
            "Select a device-local S3 secret-key secret in TPS Controller settings.",
        );
    }
    if (accessKeySecretName === secretKeySecretName) {
        throw new S3CredentialConfigurationError(
            "conflicting-references",
            "Select two different device-local secrets for the S3 access key and secret key.",
        );
    }

    let accessKeyId = "";
    let secretAccessKey = "";
    try {
        accessKeyId = String(readSecret(accessKeySecretName) || "").trim();
        secretAccessKey = String(readSecret(secretKeySecretName) || "").trim();
    } catch {
        throw new S3CredentialConfigurationError(
            "secret-storage-unavailable",
            "S3 credentials could not be read from device-local SecretStorage.",
        );
    }
    if (!accessKeyId) {
        throw new S3CredentialConfigurationError(
            "missing-access-key",
            "The selected device-local S3 access-key secret is empty or unavailable.",
        );
    }
    if (!secretAccessKey) {
        throw new S3CredentialConfigurationError(
            "missing-secret-key",
            "The selected device-local S3 secret-key secret is empty or unavailable.",
        );
    }
    return { accessKeyId, secretAccessKey };
}
