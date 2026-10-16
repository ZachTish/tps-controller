
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
