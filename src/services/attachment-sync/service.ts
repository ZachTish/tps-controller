import { App, Notice, Platform, TAbstractFile, requestUrl } from "obsidian";
import type { S3agleAttachmentAutomationSettings } from "../../types";
import { resolveS3Credentials } from "../s3-credential-service";
import * as logger from "../../logger";
import { AttachmentSyncEngine } from "./engine";
import { createSha256, importRecoveryKey, randomId } from "./crypto";
import { GcsAttachmentRemote } from "./gcs-remote";
import { AttachmentDeviceStateStore } from "./device-state";
import { ObsidianAttachmentLocalStore } from "./local-files";
import { runAttachmentMobileDiagnostic } from "./mobile-diagnostic";
import { attachmentSyncConnectionIdentity, type AttachmentSyncSettings } from "./settings";
import type { LocalStore, RemoteStore, SyncRunResult } from "./model";
import { AttachmentLegacyMigration, type LegacyMigrationPreview } from "./legacy-migration";

export interface AttachmentSyncStatus {
    phase: "disabled" | "not-enrolled" | "paused" | "idle" | "syncing" | "error";
    message: string;
    lastRunAt: number | null;
    result: SyncRunResult | null;
    localEnabled: boolean;
    warnings: string[];
}

/** Owns scheduling only; file reconciliation and durable decisions live in the engine. */
export class AttachmentSyncService {
    private generation = 0;
    private interval: number | null = null;
    private debounce: number | null = null;
    private disposers: Array<() => void> = [];
    private active: Promise<unknown> | null = null;
    private engine: AttachmentSyncEngine | null = null;
    private listeners = new Set<() => void>();
    private cachedState: { identity: string; store: AttachmentDeviceStateStore } | null = null;
    private status: AttachmentSyncStatus = {
        phase: "disabled", message: "Attachment sync is disabled.", lastRunAt: null,
        result: null, localEnabled: false, warnings: [],
    };

    constructor(private readonly app: App, private readonly getSettings: () => AttachmentSyncSettings,
        private readonly getLegacySettings: () => S3agleAttachmentAutomationSettings) {}

    getStatus(): AttachmentSyncStatus {
        return { ...this.status, warnings: [...this.status.warnings], result: this.status.result && { ...this.status.result } };
    }

    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private update(change: Partial<AttachmentSyncStatus>): void {
        this.status = { ...this.status, ...change };
        for (const listener of this.listeners) listener();
    }

    start(): void {
        this.stop();
        if (this.getSettings().schema !== 1 || this.getSettings().provider !== "gcs") {
            this.update({ phase: "error", message: "These attachment sync settings require a newer Controller version. Other Controller features remain available." });
            return;
        }
        if (!this.getSettings().enabled) {
            this.update({ phase: "disabled", message: "Attachment sync is disabled." });
            return;
        }
        const generation = this.generation;
        const event = (file: TAbstractFile): void => {
            // Native notes, hidden service state and development changes never schedule S3 work.
            if (!this.pathMaySync(file.path)) return;
            this.schedule(2000);
        };
        for (const ref of [this.app.vault.on("create", event), this.app.vault.on("modify", event), this.app.vault.on("delete", event)]) {
            this.disposers.push(() => this.app.vault.offref(ref));
        }
        const renameRef = this.app.vault.on("rename", (file, oldPath) => {
            if (this.pathMaySync(file.path) || this.pathMaySync(oldPath)) this.schedule(2000);
        });
        this.disposers.push(() => this.app.vault.offref(renameRef));
        const resume = () => { if (!document.hidden) this.schedule(250); };
        document.addEventListener("visibilitychange", resume);
        window.addEventListener("online", resume);
        window.addEventListener("focus", resume);
        this.disposers.push(() => {
            document.removeEventListener("visibilitychange", resume);
            window.removeEventListener("online", resume);
            window.removeEventListener("focus", resume);
        });
        this.interval = window.setInterval(() => {
            if (!document.hidden && generation === this.generation) this.schedule(0);
        }, 60_000);
        this.app.workspace.onLayoutReady(() => {
            if (generation === this.generation) this.schedule(500);
        });
    }

    stop(): void {
        this.generation++;
        this.engine?.stop();
        if (this.interval !== null) window.clearInterval(this.interval);
        if (this.debounce !== null) window.clearTimeout(this.debounce);
        this.interval = this.debounce = null;
        for (const dispose of this.disposers.splice(0)) dispose();
        const cached = this.cachedState;
        this.cachedState = null;
        if (cached) void Promise.resolve(this.active).catch(() => {}).then(() => cached.store.close()).catch(() => {});
    }

    private pathMaySync(path: string): boolean {
        return !!path && !path.split("/").some(p => p.startsWith(".") || p === "node_modules" || p === "Plugin Development")
            && !/\.(md|canvas|base)$/i.test(path);
    }

    private schedule(delay: number): void {
        if (this.debounce !== null) window.clearTimeout(this.debounce);
        this.debounce = window.setTimeout(() => {
            this.debounce = null;
            void this.runNow(false).catch(() => {}); // runNow records a safe status and structured failure.
        }, delay);
    }

    async runNow(showNotice = true): Promise<void> {
        if (!showNotice && this.active) { await this.active.catch(() => {}); return; }
        return this.exclusive(async (generation) => {
            if (!this.getSettings().enabled) {
                this.update({ phase: "disabled", message: "Enable attachment sync in Controller settings first." });
                if (showNotice) new Notice(this.status.message);
                return;
            }
            const store = this.stateStore();
            const identity = attachmentSyncConnectionIdentity(this.getSettings());
            const execution = JSON.stringify(this.getSettings());
            const participating = await store.getPreference<boolean>("participation");
            this.assertCurrent(generation, identity, execution);
            if (participating !== true) {
                this.update({ phase: "not-enrolled", localEnabled: false,
                    message: "Set up the connection and recovery key, then join this device." });
                if (showNotice) new Notice(this.status.message);
                return;
            }
            const context = await this.context(generation);
            this.update({ phase: "syncing", localEnabled: true, message: "Checking local and cloud files…" });
            const result = await context.engine.run();
            context.check();
            this.update({ phase: "idle", message: result.pending ? `${result.pending} changes are pending.` : "Attachments are up to date.",
                lastRunAt: Date.now(), result });
            if (showNotice) new Notice(this.status.message);
        });
    }

    async enroll(mode: "create" | "join"): Promise<void> {
        return this.exclusive(async (generation) => {
            const context = await this.context(generation, mode === "create");
            this.update({ phase: "syncing", message: mode === "create" ? "Creating the encrypted collection…" : "Joining the encrypted collection…" });
            const result = await context.engine.run();
            context.check();
            await context.state.setPreference("participation", true);
            context.check();
            const policy = await context.remote.getBucketPolicy();
            context.check();
            this.update({ phase: "idle", localEnabled: true, message: "This device has joined attachment sync.",
                lastRunAt: Date.now(), result, warnings: policy.warnings });
        });
    }

    async pauseDevice(): Promise<void> {
        const identity = attachmentSyncConnectionIdentity(this.getSettings());
        this.stop();
        const generation = this.generation;
        if (this.active) await this.active.catch(() => {});
        this.assertCurrent(generation, identity);
        await this.stateStore().setPreference("participation", false);
        this.assertCurrent(generation, identity);
        this.update({ phase: "paused", localEnabled: false, message: "Attachment sync is paused on this device." });
    }

    async previewLegacy(): Promise<LegacyMigrationPreview> {
        return this.exclusive(async generation => {
            const context = await this.context(generation);
            return new AttachmentLegacyMigration(this.app, this.getLegacySettings(), context).preview();
        });
    }

    async restoreLegacy(): Promise<void> {
        return this.exclusive(async (generation) => {
            const context = await this.context(generation);
            if (await context.state.getPreference<boolean>("participation") !== true) throw new Error("Join this device before restoring old uploads.");
            this.update({ phase: "syncing", message: "Restoring recognized cloud uploads…" });
            const report = await new AttachmentLegacyMigration(this.app, this.getLegacySettings(), context).restore();
            context.check();
            this.update({ phase: report.unfinished.length ? "error" : "idle",
                message: `Restored ${report.restored} old uploads; ${report.unfinished.length} unfinished.`,
                warnings: report.unfinished });
        });
    }

    async runDiagnostic(): Promise<void> {
        return this.exclusive(async (generation) => {
            this.update({ phase: "syncing", message: "Running the 500 MB file-transfer diagnostic…" });
            const configured = this.getSettings().collectionId && this.getSettings().bucket;
            const context = configured ? await this.context(generation) : null;
            const check = () => {
                if (generation !== this.generation) throw new Error("Attachment diagnostic cancelled.");
                context?.check();
            };
            const cleanupKey = "diagnostic-remote-cleanup";
            const cleanup = context ? await context.state.getPreference<Record<string, number>>(cleanupKey) || {} : {};
            if (context) {
                for (const [id, count] of Object.entries(cleanup)) {
                    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id) || !Number.isSafeInteger(count) || count < 0 || count > 10000) {
                        throw new Error("The diagnostic cleanup journal is invalid.");
                    }
                    context.check();
                    await context.remote.deleteRevision(id, count);
                    delete cleanup[id];
                    await context.state.setPreference(cleanupKey, cleanup);
                }
            }
            const report = await runAttachmentMobileDiagnostic(this.app, {
                isDesktop: !Platform.isMobile, createHasher: createSha256,
                checkCurrent: check,
                onProgress: (message: string) => { if (generation === this.generation) this.update({ message }); },
                remoteRoundTrip: context ? async ({ revisionId, index, bytes, sha256 }) => {
                    context.check();
                    cleanup[revisionId] = Math.max(cleanup[revisionId] || 0, index + 1);
                    await context.state.setPreference(cleanupKey, cleanup);
                    await context.remote.putChunk(revisionId, index, bytes, sha256);
                    return context.remote.getChunk(revisionId, index);
                } : undefined,
                cleanupRemote: context ? async (revisionId, count) => {
                    context.check();
                    await context.remote.deleteRevision(revisionId, count);
                    delete cleanup[revisionId];
                    await context.state.setPreference(cleanupKey, cleanup);
                } : undefined,
            });
            if (generation !== this.generation) return;
            check();
            // Local diagnostics remain available before connection/key setup.
            const reportText = JSON.stringify(report, null, 2);
            logger.flow("AttachmentSync", "diagnostic:complete", { physicalMobile: Platform.isMobile });
            this.update({ phase: report.localPassed ? "idle" : "error",
                message: report.localPassed ? "Transfer diagnostic complete. Review its report; physical-device memory and suspension checks remain separate." : `Transfer diagnostic failed: ${report.error || "see report"}` });
            new Notice(this.status.message, 12000);
            const folder = "Inbox/Controller Attachment Sync QA";
            if (!await this.app.vault.adapter.exists(folder)) await this.app.vault.adapter.mkdir(folder);
            check();
            await this.app.vault.adapter.write(`${folder}/Latest diagnostic.json`, reportText);
        });
    }

    private stateStore(): AttachmentDeviceStateStore {
        const settings = this.getSettings();
        if (settings.schema !== 1 || settings.provider !== "gcs" || !/^[a-zA-Z0-9_-]{8,128}$/.test(settings.collectionId)) {
            throw new Error("Configure a collection ID before joining attachment sync.");
        }
        const identity = attachmentSyncConnectionIdentity(settings);
        if (this.cachedState?.identity === identity) return this.cachedState.store;
        if (this.cachedState) void this.cachedState.store.close().catch(() => {});
        const store = new AttachmentDeviceStateStore(this.app.vault.adapter, identity, settings.collectionId);
        this.cachedState = { identity, store };
        return store;
    }

    private assertCurrent(generation: number, identity: string, execution?: string): void {
        if (generation !== this.generation || identity !== attachmentSyncConnectionIdentity(this.getSettings())
            || (execution !== undefined && execution !== JSON.stringify(this.getSettings()))) {
            throw new Error("Attachment sync stopped because its configuration changed.");
        }
    }

    private async context(generation: number, allowCreateCatalog = false) {
        const settings = { ...this.getSettings(), excludedPaths: [...this.getSettings().excludedPaths] };
        const identity = attachmentSyncConnectionIdentity(settings);
        const execution = JSON.stringify(settings);
        const state = this.stateStore();
        const credentials = resolveS3Credentials(settings, name => this.app.secretStorage.getSecret(name));
        const recoveryKey = this.app.secretStorage.getSecret(settings.recoveryKeySecretName);
        if (!recoveryKey) throw new Error("Import the collection recovery key into SecretStorage on this device.");
        const check = () => {
            this.assertCurrent(generation, identity, execution);
            if (this.app.secretStorage.getSecret(settings.recoveryKeySecretName) !== recoveryKey
                || String(this.app.secretStorage.getSecret(settings.accessKeySecretName) || "").trim() !== credentials.accessKeyId
                || String(this.app.secretStorage.getSecret(settings.secretKeySecretName) || "").trim() !== credentials.secretAccessKey) {
                throw new Error("Attachment sync stopped because a device-local key changed.");
            }
        };
        const crypto = await importRecoveryKey(recoveryKey);
        check();
        const remote = new GcsAttachmentRemote({
            endpoint: settings.endpoint, bucket: settings.bucket, prefix: settings.prefix, collectionId: settings.collectionId,
            credentials, crypto, request: requestUrl, checkCurrent: check,
        });
        const local = new ObsidianAttachmentLocalStore(this.app, state, {
            isDesktop: !Platform.isMobile, excludedPaths: () => settings.excludedPaths,
            createHasher: createSha256, randomId, checkCurrent: check,
        });
        const guardedRemote: RemoteStore = {
            getCatalog: async () => { check(); const value = await remote.getCatalog(); check(); return value; },
            compareAndSwapCatalog: async (token, catalog) => { check(); return remote.compareAndSwapCatalog(token, catalog); },
            putChunk: async (...args) => { check(); return remote.putChunk(...args); },
            getChunk: async (...args) => { check(); return remote.getChunk(...args); },
            deleteRevision: async (...args) => { check(); return remote.deleteRevision(...args); },
        };
        const guardedLocal: LocalStore = {
            isEligible: path => local.isEligible(path),
            scan: async () => { check(); return local.scan(); },
            stat: async path => { check(); return local.stat(path); },
            readChunk: async (...args) => { check(); return local.readChunk(...args); },
            createStage: async (...args) => { check(); return local.createStage(...args); },
            appendStage: async (...args) => { check(); return local.appendStage(...args); },
            stageSize: async (...args) => { check(); return local.stageSize(...args); },
            readStageChunk: async (...args) => { check(); return local.readStageChunk(...args); },
            applyStage: async (...args) => { check(); return local.applyStage(...args); },
            discardStage: async (...args) => local.discardStage(...args),
            remove: async (...args) => { check(); return local.remove(...args); },
            recover: async () => { check(); return local.recover(); },
            pruneStages: async records => { check(); return local.pruneStages(records); },
        };
        const engine = new AttachmentSyncEngine(guardedRemote, guardedLocal, state, {
            collectionId: settings.collectionId, allowCreateCatalog, randomId, createHasher: createSha256,
            onEvent: (event, details) => {
                check();
                logger.flow("AttachmentSync", event, details);
                if (typeof details.path === "string") this.update({ message: `${event}: ${details.path}` });
            },
        });
        this.engine = engine;
        check();
        return { engine, state, remote, local, identity, check, bucket: settings.bucket, prefix: settings.prefix };
    }

    private exclusive<T>(work: (generation: number) => Promise<T>): Promise<T> {
        const generation = this.generation;
        const previous = this.active;
        const run = Promise.resolve(previous).catch(() => {}).then(() => {
            if (generation !== this.generation) throw new Error("Attachment sync action was cancelled by a configuration change.");
            return work(generation);
        }).catch(error => {
            if (generation === this.generation) {
                const message = error instanceof Error ? error.message : "Attachment sync failed.";
                this.update({ phase: "error", message });
                logger.flowWarn("AttachmentSync", "run:failed", { reason: message.replace(/https?:\/\/\S+/g, "[endpoint]") });
            }
            throw error;
        });
        this.active = run;
        void run.finally(() => { if (this.active === run) { this.active = null; this.engine = null; } }).catch(() => {});
        return run;
    }
}
