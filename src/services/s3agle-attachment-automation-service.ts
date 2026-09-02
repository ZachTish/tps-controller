import { App, Notice, TFile, normalizePath, requestUrl } from "obsidian";
import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, PutObjectAclCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { createHash } from "crypto";
import type { S3agleAttachmentAutomationSettings, TPSControllerSettings } from "../types";
import type { S3agleArchiveRequest } from "./sync-request-service";
import {
    resolveS3Credentials,
    S3CredentialConfigurationError,
    type S3ExecutionCredentials,
} from "./s3-credential-service";
import * as logger from "../logger";
import { canAutomaticallyMutateSourceViaGcm, canAutomaticallyMutateViaGcm } from "../tps-gcm-api";

interface LocalAttachmentReference {
    reference: string;
    path: string;
}

interface S3agleAutomationResult {
    notePath: string;
    uploadedCount: number;
    archivedCount: number;
    skippedArchiveCount: number;
}

interface UploadResult {
    key: string;
    url: string;
}

interface S3BucketArchiveResult {
    archivedCount: number;
    skippedCount: number;
    lastError?: string;
    lastSkipReason?: string;
}

interface S3UploadManifestEntry {
    key: string;
    url: string;
    notePath: string;
    sourcePath: string;
    uploadedAt: number;
    lastSeenAt: number;
    archivedAt?: number;
    archivedKey?: string;
}

export class S3agleAttachmentAutomationService {
    private readonly manifestPath = ".tps/s3-upload-manifest.json";
    private eventDisposers: (() => void)[] = [];
    private runTimerId: number | null = null;
    private activeRun: Promise<S3agleAutomationResult | null> | null = null;
    private activeBucketArchiveRun: Promise<S3BucketArchiveResult> | null = null;
    private lastRunByPath = new Map<string, number>();
    private originalExecuteCommandById: ((id: string, ...args: unknown[]) => unknown) | null = null;
    private commandPatchInstalled = false;
    private lastCredentialNoticeAt = 0;

    constructor(
        private readonly app: App,
        private readonly getSettings: () => TPSControllerSettings,
        private readonly isController: () => boolean,
        private readonly requestControllerArchive: (notePath: string, sourcePaths: string[]) => Promise<void>,
        private readonly saveSettings: () => Promise<void>,
        private readonly readSecret: (name: string) => string | null,
    ) {}

    start(): void {
        this.stop();
        const rule = this.getRule();
        if (!rule.enabled) {
            logger.flow("S3agleAutomation", "start:not-enabled");
            return;
        }
        if (!this.hasUploadConfiguration(rule)) {
            logger.flowWarn("S3agleAutomation", "start:not-configured");
            return;
        }

        if (rule.runOnActiveNoteOpen) {
            const event = this.app.workspace.on("file-open", (file) => {
                if (file instanceof TFile) this.scheduleForFile(file, "file-open");
            });
            this.eventDisposers.push(() => this.app.workspace.offref(event));
        }
        if (rule.runOnPaste) {
            const onPaste = (event: ClipboardEvent) => this.handlePasteEvent(event);
            document.addEventListener("paste", onPaste, true);
            this.eventDisposers.push(() => document.removeEventListener("paste", onPaste, true));
        }
        if (rule.runOnActiveNoteModify) {
            const event = this.app.vault.on("modify", (file) => {
                const active = this.app.workspace.getActiveFile();
                if (file instanceof TFile && active instanceof TFile && file.path === active.path) {
                    this.scheduleForFile(file, "active-file-modify");
                }
            });
            this.eventDisposers.push(() => this.app.vault.offref(event));
        }
        if (rule.runAfterCommandIds.length > 0) {
            this.installCommandTriggerPatch();
        }

        logger.flow("S3agleAutomation", "start", {
            runOnActiveNoteOpen: rule.runOnActiveNoteOpen,
            runOnActiveNoteModify: rule.runOnActiveNoteModify,
            runOnPaste: rule.runOnPaste,
            runAfterCommandIds: rule.runAfterCommandIds,
            debounceSeconds: rule.debounceSeconds,
            cooldownMinutes: rule.cooldownMinutes,
        });
    }

    stop(): void {
        for (const dispose of this.eventDisposers) dispose();
        this.eventDisposers = [];
        if (this.runTimerId !== null) {
            window.clearTimeout(this.runTimerId);
            this.runTimerId = null;
        }
        this.uninstallCommandTriggerPatch();
    }

    restart(): void {
        this.start();
    }

    async runActiveNoteNow(): Promise<S3agleAutomationResult | null> {
        const activeFile = this.app.workspace.getActiveFile();
        if (!(activeFile instanceof TFile)) {
            new Notice("S3 attachment upload: no active note.");
            return null;
        }
        return this.runForFileIfActive(activeFile, "manual", { bypassCooldown: true, showSkippedNotices: true });
    }

    private scheduleForFile(file: TFile, reason: string): void {
        if (file.extension.toLowerCase() !== "md") return;
        if (this.isInIgnoredSystemPath(file.path)) return;
        const rule = this.getRule();
        if (!rule.enabled) return;

        if (this.runTimerId !== null) window.clearTimeout(this.runTimerId);
        this.runTimerId = window.setTimeout(() => {
            this.runTimerId = null;
            void this.runForFileIfActive(file, reason).catch((error) => {
                logger.flowError("S3agleAutomation", "scheduled-run:failed", error, { path: file.path, reason });
            });
        }, Math.max(1, rule.debounceSeconds) * 1000);
    }

    private handlePasteEvent(event: ClipboardEvent): void {
        const rule = this.getRule();
        if (!rule.enabled || !rule.runOnPaste) return;
        const activeFile = this.app.workspace.getActiveFile();
        if (!(activeFile instanceof TFile)) return;
        const files = Array.from(event.clipboardData?.files || []);
        const hasFiles = files.length > 0;
        const hasImageData = Array.from(event.clipboardData?.items || [])
            .some((item) => item.kind === "file" && item.type.toLowerCase().startsWith("image/"));
        logger.flow("S3agleAutomation", "paste:detected", {
            path: activeFile.path,
            files: files.length,
            hasImageData,
        });
        if (!hasFiles && !hasImageData) return;
        window.setTimeout(() => {
            const current = this.app.workspace.getActiveFile();
            if (current instanceof TFile && current.path === activeFile.path) {
                this.scheduleForFile(current, "paste");
            }
        }, 500);
    }

    private async runForFileIfActive(
        file: TFile,
        reason: string,
        options: { bypassCooldown?: boolean; showSkippedNotices?: boolean } = {},
    ): Promise<S3agleAutomationResult | null> {
        const activeFile = this.app.workspace.getActiveFile();
        if (!(activeFile instanceof TFile) || activeFile.path !== file.path) {
            logger.flow("S3agleAutomation", "run:skip-not-active", { path: file.path, reason });
            if (options.showSkippedNotices) new Notice("S3 attachment upload: active note changed before the run started.");
            return null;
        }
        if (this.activeRun) {
            logger.flow("S3agleAutomation", "run:skip-active-run", { path: file.path, reason });
            return this.activeRun;
        }
        this.activeRun = this.runForActiveFile(file, reason, options);
        try {
            return await this.activeRun;
        } finally {
            this.activeRun = null;
        }
    }

    private async runForActiveFile(
        file: TFile,
        reason: string,
        options: { bypassCooldown?: boolean; showSkippedNotices?: boolean } = {},
    ): Promise<S3agleAutomationResult | null> {
        const rule = this.getRule();
        if (!rule.enabled) return null;
        if (!this.hasUploadConfiguration(rule)) {
            logger.flowWarn("S3agleAutomation", "run:skip-not-configured", { path: file.path, reason });
            this.reportCredentialFailure(
                "upload",
                "incomplete-settings",
                "S3 attachment upload settings are incomplete. Configure the endpoint, bucket, and device-local credential secrets.",
                options.showSkippedNotices === true,
            );
            return null;
        }
        if (!options.bypassCooldown && this.isCoolingDown(file.path, rule)) {
            logger.flow("S3agleAutomation", "run:skip-cooldown", { path: file.path, reason });
            if (options.showSkippedNotices) new Notice("S3 attachment upload: skipped because this note is cooling down.");
            return null;
        }

        const automatic = reason !== "manual";
        if (automatic && !(await this.canAutomaticallyMutateNote(file, reason, "preflight"))) {
            return null;
        }

        const beforeContent = await this.app.vault.cachedRead(file);
        if (automatic && !this.canAutomaticallyMutateNoteSource(beforeContent, file, reason)) return null;
        const beforeRefs = this.extractLocalAttachmentReferences(beforeContent, file.path);
        if (!beforeRefs.length) {
            logger.flow("S3agleAutomation", "run:skip-no-local-refs", { path: file.path, reason });
            if (options.showSkippedNotices) new Notice("S3 attachment upload: no local attachments found in the active note.");
            return null;
        }
        const credentials = this.resolveExecutionCredentials("upload", options.showSkippedNotices === true);
        if (!credentials) return null;

        logger.flow("S3agleAutomation", "run:start", {
            path: file.path,
            reason,
            localRefs: beforeRefs.length,
        });
        this.lastRunByPath.set(file.path, Date.now());
        const uploadResults = await this.uploadAndRewriteReferences(file, beforeContent, beforeRefs, credentials, automatic, reason);
        const afterContent = uploadResults.content;
        const remainingRefs = this.extractLocalAttachmentReferences(afterContent, file.path);
        const uploadedPaths = uploadResults.uploadedPaths;
        const archived = rule.archiveUploadedSources
            ? await this.handleUploadedSources(file.path, uploadedPaths, automatic)
            : { archivedCount: 0, skippedArchiveCount: 0 };
        const uploadedCount = uploadedPaths.length;

        logger.flow("S3agleAutomation", "run:done", {
            path: file.path,
            uploadedCount,
            archivedCount: archived.archivedCount,
            skippedArchiveCount: archived.skippedArchiveCount,
        });

        if (uploadedCount > 0 || archived.archivedCount > 0) {
            new Notice(`S3 attachment automation: uploaded ${uploadedCount}, archived ${archived.archivedCount}.`);
        } else if (reason === "manual") {
            new Notice("S3 attachment upload: no attachments were uploaded.");
        }

        return {
            notePath: file.path,
            uploadedCount,
            archivedCount: archived.archivedCount,
            skippedArchiveCount: archived.skippedArchiveCount,
        };
    }

    async fulfillArchiveRequests(requests: S3agleArchiveRequest[] | undefined): Promise<{ archivedCount: number; skippedArchiveCount: number }> {
        let archivedCount = 0;
        let skippedArchiveCount = 0;
        for (const request of requests || []) {
            const result = await this.archiveControllerRequestedSources(request);
            archivedCount += result.archivedCount;
            skippedArchiveCount += result.skippedArchiveCount;
        }
        if (archivedCount > 0 || skippedArchiveCount > 0) {
            logger.flow("S3agleAutomation", "controller-archive:batch-done", { archivedCount, skippedArchiveCount });
        }
        return { archivedCount, skippedArchiveCount };
    }

    private installCommandTriggerPatch(): void {
        if (this.commandPatchInstalled) return;
        const commands = (this.app as any).commands;
        if (typeof commands?.executeCommandById !== "function") return;
        const service = this;
        this.originalExecuteCommandById = commands.executeCommandById.bind(commands);
        commands.executeCommandById = function patchedExecuteCommandById(id: string, ...args: unknown[]) {
            const result = service.originalExecuteCommandById?.(id, ...args);
            service.scheduleAfterCommandIfConfigured(id);
            return result;
        };
        this.commandPatchInstalled = true;
    }

    private uninstallCommandTriggerPatch(): void {
        if (!this.commandPatchInstalled) return;
        const commands = (this.app as any).commands;
        if (this.originalExecuteCommandById && commands?.executeCommandById) {
            commands.executeCommandById = this.originalExecuteCommandById;
        }
        this.originalExecuteCommandById = null;
        this.commandPatchInstalled = false;
    }

    private scheduleAfterCommandIfConfigured(commandId: string): void {
        if (commandId === "tps-controller:run-s3agle-attachment-automation-now") return;
        const rule = this.getRule();
        if (!rule.enabled || !rule.runAfterCommandIds.includes(commandId)) return;
        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile instanceof TFile) this.scheduleForFile(activeFile, `command:${commandId}`);
    }

    private async uploadAndRewriteReferences(
        noteFile: TFile,
        content: string,
        refs: LocalAttachmentReference[],
        credentials: S3ExecutionCredentials,
        automatic: boolean,
        reason: string,
    ): Promise<{ content: string; uploadedPaths: string[] }> {
        let updatedContent = content;
        const uploadedPaths: string[] = [];
        const replacements: Array<{ reference: string; replacement: string }> = [];
        const refsByPath = new Map<string, LocalAttachmentReference[]>();
        for (const ref of refs) {
            const list = refsByPath.get(ref.path) || [];
            list.push(ref);
            refsByPath.set(ref.path, list);
        }
        for (const [path, pathRefs] of refsByPath.entries()) {
            if (automatic && !(await this.canAutomaticallyMutateNote(noteFile, reason, "upload-boundary"))) {
                return { content, uploadedPaths: [] };
            }
            const source = this.app.vault.getAbstractFileByPath(path);
            if (!(source instanceof TFile)) continue;
            if (!this.shouldUploadAttachment(source, this.getRule())) {
                logger.flow("S3agleAutomation", "upload:skip-extension", {
                    notePath: noteFile.path,
                    sourcePath: path,
                    extension: source.extension,
                });
                continue;
            }
            try {
                const upload = await this.uploadFile(source, credentials);
                const replacement = this.buildReplacement(pathRefs[0].reference, upload.url);
                for (const ref of pathRefs) {
                    updatedContent = updatedContent.split(ref.reference).join(replacement);
                    replacements.push({ reference: ref.reference, replacement });
                }
                await this.recordUploadedObject({
                    key: upload.key,
                    url: upload.url,
                    notePath: noteFile.path,
                    sourcePath: path,
                    uploadedAt: Date.now(),
                    lastSeenAt: Date.now(),
                });
                uploadedPaths.push(path);
            } catch (error) {
                logger.flowError("S3agleAutomation", "upload:failed", error, { notePath: noteFile.path, sourcePath: path });
                new Notice(`S3 attachment upload failed for ${source.name}: ${(error as Error).message}`);
            }
        }
        if (updatedContent !== content) {
            if (!automatic) {
                await this.app.vault.modify(noteFile, updatedContent);
            } else {
                if (!(await this.canAutomaticallyMutateNote(noteFile, reason, "mutation-boundary"))) {
                    return { content, uploadedPaths: [] };
                }
                let blocked = false;
                let currentResult = content;
                await this.app.vault.process(noteFile, (current) => {
                    if (!canAutomaticallyMutateSourceViaGcm(this.app, current)) {
                        blocked = true;
                        return current;
                    }
                    currentResult = replacements.reduce(
                        (next, replacement) => next.split(replacement.reference).join(replacement.replacement),
                        current,
                    );
                    return currentResult;
                });
                if (blocked) {
                    logger.flowWarn("S3agleAutomation", "rewrite:skip-template-protected", {
                        path: noteFile.path,
                        reason,
                        stage: "mutation-boundary",
                    });
                    return { content: currentResult, uploadedPaths: [] };
                }
                updatedContent = currentResult;
            }
        }
        return { content: updatedContent, uploadedPaths: uploadedPaths.sort() };
    }

    private async uploadFile(file: TFile, credentials: S3ExecutionCredentials): Promise<UploadResult> {
        const rule = this.getRule();
        const body = await this.app.vault.readBinary(file);
        const key = this.buildObjectKey(file, body);
        const client = this.createS3Client(credentials);
        try {
            await client.send(new PutObjectCommand({
                Bucket: rule.bucket,
                Key: key,
                Body: new Uint8Array(body),
                ContentType: this.getMimeType(file.extension),
            }));
            if (rule.makeUploadedObjectsPublic) {
                await this.ensurePublicObjectAccess(client, rule.bucket, key, this.buildPublicUrl(key));
            }
        } catch (error) {
            await this.deleteFailedUpload(client, rule.bucket, key);
            throw error;
        }
        return { key, url: this.buildPublicUrl(key) };
    }

    private async deleteFailedUpload(client: S3Client, bucket: string, key: string): Promise<void> {
        try {
            await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
        } catch (error) {
            logger.flowWarn("S3agleAutomation", "upload:cleanup-failed", {
                key,
                message: String((error as Error)?.message || error),
            });
        }
    }

    private async ensurePublicObjectAccess(client: S3Client, bucket: string, key: string, url: string): Promise<void> {
        try {
            await client.send(new PutObjectAclCommand({
                Bucket: bucket,
                Key: key,
                ACL: "public-read",
            }));
            return;
        } catch (error) {
            logger.flowWarn("S3agleAutomation", "upload:public-acl-failed", {
                key,
                message: String((error as Error)?.message || error),
            });
        }

        if (await this.isPublicUrlReachable(url)) return;
        throw new Error(`uploaded ${key}, but the generated URL is not publicly readable. Check bucket public access/IAM settings.`);
    }

    private async isPublicUrlReachable(url: string): Promise<boolean> {
        try {
            const response = await requestUrl({ url, method: "HEAD", throw: false });
            if (response.status >= 200 && response.status < 300) return true;
            if (response.status !== 405) return false;
        } catch (error) {
            logger.flowWarn("S3agleAutomation", "upload:public-head-failed", {
                message: String((error as Error)?.message || error),
            });
        }

        try {
            const response = await requestUrl({
                url,
                method: "GET",
                headers: { Range: "bytes=0-0" },
                throw: false,
            });
            return response.status >= 200 && response.status < 300;
        } catch (error) {
            logger.flowWarn("S3agleAutomation", "upload:public-get-failed", {
                message: String((error as Error)?.message || error),
            });
            return false;
        }
    }

    private shouldUploadAttachment(file: TFile, rule: S3agleAttachmentAutomationSettings): boolean {
        const extension = file.extension.toLowerCase();
        if (!extension) return rule.allowedAttachmentExtensions.length === 0;
        const ignored = new Set(rule.ignoredAttachmentExtensions.map((ext) => ext.toLowerCase()));
        if (ignored.has(extension)) return false;
        const allowed = new Set(rule.allowedAttachmentExtensions.map((ext) => ext.toLowerCase()));
        return allowed.size === 0 || allowed.has(extension);
    }

    async runBucketArchiveIfDue(nowMs = Date.now()): Promise<S3BucketArchiveResult | null> {
        const rule = this.getRule();
        if (!rule.archiveUnreferencedBucketObjects) {
            logger.flow("S3BucketArchive", "due:disabled");
            return null;
        }
        const intervalMs = Math.max(1, rule.bucketArchiveCheckIntervalMinutes) * 60 * 1000;
        const lastRunAt = Number(rule.bucketArchiveLastRunAt || 0);
        if (lastRunAt > 0 && nowMs - lastRunAt < intervalMs) {
            logger.flow("S3BucketArchive", "due:not-yet", { lastRunAt, intervalMs });
            return null;
        }
        return this.runBucketArchiveNow(nowMs);
    }

    async runBucketArchiveNow(nowMs = Date.now()): Promise<S3BucketArchiveResult> {
        if (this.activeBucketArchiveRun) {
            logger.flow("S3BucketArchive", "run:join-active");
            return this.activeBucketArchiveRun;
        }
        const run = this.executeBucketArchiveNow(nowMs);
        this.activeBucketArchiveRun = run;
        try {
            return await run;
        } finally {
            if (this.activeBucketArchiveRun === run) {
                this.activeBucketArchiveRun = null;
            }
        }
    }

    private async executeBucketArchiveNow(nowMs: number): Promise<S3BucketArchiveResult> {
        if (!this.isController()) {
            logger.flowWarn("S3BucketArchive", "run:skip-not-controller");
            return { archivedCount: 0, skippedCount: 0 };
        }
        const rule = this.getRule();
        if (!this.hasUploadConfiguration(rule)) {
            logger.flowWarn("S3BucketArchive", "run:skip-not-configured");
            const message = "S3 bucket archive settings are incomplete. Configure the endpoint, bucket, and device-local credential secrets.";
            this.reportCredentialFailure("bucket-archive", "incomplete-settings", message, false);
            return { archivedCount: 0, skippedCount: 0, lastError: message };
        }
        const credentials = this.resolveExecutionCredentials("bucket-archive", false);
        if (!credentials) {
            return {
                archivedCount: 0,
                skippedCount: 0,
                lastError: "S3 bucket archive could not read its device-local credentials.",
            };
        }

        const manifest = await this.readUploadManifest();
        const activeEntries = manifest.filter((entry) => !entry.archivedAt && entry.key && entry.url);
        const referencedUrls = await this.collectReferencedS3Urls(activeEntries.map((entry) => entry.url));
        const delayMs = Math.max(0, rule.bucketArchiveOrphanDelayMinutes) * 60 * 1000;
        let archivedCount = 0;
        let skippedCount = 0;
        let lastError: string | undefined;
        let lastSkipReason: string | undefined;
        let changed = false;

        logger.flow("S3BucketArchive", "run:start", {
            entries: manifest.length,
            activeEntries: activeEntries.length,
            referencedUrls: referencedUrls.size,
            delayMinutes: rule.bucketArchiveOrphanDelayMinutes,
        });

        for (const entry of activeEntries) {
            if (referencedUrls.has(entry.url)) {
                entry.lastSeenAt = nowMs;
                changed = true;
                lastSkipReason = "still referenced";
                continue;
            }
            const ageBase = Math.max(Number(entry.lastSeenAt || 0), Number(entry.uploadedAt || 0));
            if (ageBase > 0 && nowMs - ageBase < delayMs) {
                skippedCount += 1;
                lastSkipReason = "orphan delay not reached";
                continue;
            }
            if (await this.isUrlReferencedInVault(entry.url)) {
                entry.lastSeenAt = nowMs;
                changed = true;
                lastSkipReason = "still referenced";
                continue;
            }
            const archivedKey = this.buildBucketArchiveKey(entry.key, nowMs);
            if (!archivedKey || archivedKey === entry.key) {
                skippedCount += 1;
                lastSkipReason = "archive key matches source key";
                continue;
            }
            try {
                await this.moveBucketObject(entry.key, archivedKey, credentials);
                entry.archivedAt = nowMs;
                entry.archivedKey = archivedKey;
                archivedCount += 1;
                changed = true;
            } catch (error) {
                skippedCount += 1;
                lastError = String((error as Error)?.message || error);
                logger.flowError("S3BucketArchive", "object:archive-failed", error, { key: entry.key, archivedKey });
            }
        }

        if (changed) await this.writeUploadManifest(manifest);
        const settings = this.getSettings();
        const previousLastRunAt = settings.s3agleAttachmentAutomation.bucketArchiveLastRunAt;
        settings.s3agleAttachmentAutomation.bucketArchiveLastRunAt = nowMs;
        try {
            await this.saveSettings();
        } catch (error) {
            if (settings.s3agleAttachmentAutomation.bucketArchiveLastRunAt === nowMs) {
                settings.s3agleAttachmentAutomation.bucketArchiveLastRunAt = previousLastRunAt;
            }
            throw error;
        }
        logger.flow("S3BucketArchive", "run:done", { archivedCount, skippedCount });
        return { archivedCount, skippedCount, lastError, lastSkipReason };
    }

    getBucketArchiveCheckIntervalMs(): number {
        return Math.max(1, this.getRule().bucketArchiveCheckIntervalMinutes) * 60 * 1000;
    }

    private async moveBucketObject(sourceKey: string, targetKey: string, credentials: S3ExecutionCredentials): Promise<void> {
        const rule = this.getRule();
        const client = this.createS3Client(credentials);
        const copySource = `${rule.bucket}/${sourceKey.split("/").map((part) => encodeURIComponent(part)).join("/")}`;
        try {
            await client.send(new CopyObjectCommand({
                Bucket: rule.bucket,
                CopySource: copySource,
                Key: targetKey,
            }));
        } catch (error) {
            logger.flowWarn("S3BucketArchive", "object:copy-fallback", {
                key: sourceKey,
                archivedKey: targetKey,
                message: String((error as Error)?.message || error),
            });
            const object = await client.send(new GetObjectCommand({
                Bucket: rule.bucket,
                Key: sourceKey,
            }));
            const body = await this.readS3ObjectBody(object.Body);
            await client.send(new PutObjectCommand({
                Bucket: rule.bucket,
                Key: targetKey,
                Body: body,
                ContentType: object.ContentType,
            }));
        }
        await client.send(new DeleteObjectCommand({
            Bucket: rule.bucket,
            Key: sourceKey,
        }));
    }

    private async readS3ObjectBody(body: any): Promise<Uint8Array> {
        if (!body) return new Uint8Array();
        if (body instanceof Uint8Array) return body;
        if (typeof body.transformToByteArray === "function") return body.transformToByteArray();
        const chunks: Uint8Array[] = [];
        for await (const chunk of body) {
            chunks.push(chunk instanceof Uint8Array ? chunk : Buffer.from(chunk));
        }
        return Buffer.concat(chunks);
    }

    private async collectReferencedS3Urls(urls: string[]): Promise<Set<string>> {
        const candidates = Array.from(new Set(urls.filter(Boolean))).sort();
        const referenced = new Set<string>();
        if (!candidates.length) return referenced;
        const files = this.app.vault.getMarkdownFiles()
            .filter((file) => !this.isInIgnoredSystemPath(file.path))
            .sort((left, right) => left.path.localeCompare(right.path));
        for (const file of files) {
            const content = await this.app.vault.cachedRead(file);
            for (const url of candidates) {
                if (!referenced.has(url) && content.includes(url)) referenced.add(url);
            }
            if (referenced.size === candidates.length) break;
        }
        return referenced;
    }

    private async isUrlReferencedInVault(url: string): Promise<boolean> {
        if (!url) return false;
        const referenced = await this.collectReferencedS3Urls([url]);
        return referenced.has(url);
    }

    private buildBucketArchiveKey(sourceKey: string, nowMs: number): string {
        const prefix = this.expandFolderTemplateAt(this.getRule().bucketArchivePrefix, new Date(nowMs)).replace(/^\/+|\/+$/g, "");
        const normalizedSource = normalizePath(String(sourceKey || "").replace(/^\/+/, ""));
        return prefix ? `${prefix}/${normalizedSource}` : normalizedSource;
    }

    private createS3Client(credentials: S3ExecutionCredentials): S3Client {
        const rule = this.getRule();
        return new S3Client({
            region: rule.region || "us-east-1",
            endpoint: rule.endpoint || undefined,
            forcePathStyle: !rule.useBucketSubdomain,
            requestHandler: new NodeHttpHandler(),
            credentials,
        });
    }

    private async recordUploadedObject(entry: S3UploadManifestEntry): Promise<void> {
        const manifest = await this.readUploadManifest();
        const existing = manifest.find((item) => item.key === entry.key && item.url === entry.url);
        if (existing) {
            existing.notePath = entry.notePath;
            existing.sourcePath = entry.sourcePath;
            existing.lastSeenAt = entry.lastSeenAt;
            existing.archivedAt = undefined;
            existing.archivedKey = undefined;
        } else {
            manifest.push(entry);
        }
        await this.writeUploadManifest(manifest);
    }

    private async readUploadManifest(): Promise<S3UploadManifestEntry[]> {
        try {
            const content = await this.app.vault.adapter.read(this.manifestPath);
            const parsed = JSON.parse(content || "[]");
            return Array.isArray(parsed)
                ? parsed.map((entry) => this.normalizeManifestEntry(entry)).filter((entry): entry is S3UploadManifestEntry => !!entry)
                : [];
        } catch (error: any) {
            if (typeof error?.message === "string" && error.message.toLowerCase().includes("not found")) return [];
            logger.flowWarn("S3BucketArchive", "manifest:read-failed", { message: String(error?.message || error) });
            return [];
        }
    }

    private async writeUploadManifest(entries: S3UploadManifestEntry[]): Promise<void> {
        await this.ensureAdapterFolderExists(this.manifestPath.substring(0, this.manifestPath.lastIndexOf("/")));
        const normalized = entries
            .map((entry) => this.normalizeManifestEntry(entry))
            .filter((entry): entry is S3UploadManifestEntry => !!entry)
            .sort((left, right) => left.key.localeCompare(right.key));
        await this.app.vault.adapter.write(this.manifestPath, `${JSON.stringify(normalized, null, 2)}\n`);
    }

    private normalizeManifestEntry(raw: any): S3UploadManifestEntry | null {
        const key = String(raw?.key || "").trim();
        const url = String(raw?.url || "").trim();
        if (!key || !url) return null;
        const entry: S3UploadManifestEntry = {
            key,
            url,
            notePath: normalizePath(String(raw?.notePath || "")),
            sourcePath: normalizePath(String(raw?.sourcePath || "")),
            uploadedAt: Number(raw?.uploadedAt || 0),
            lastSeenAt: Number(raw?.lastSeenAt || raw?.uploadedAt || 0),
        };
        if (Number(raw?.archivedAt || 0) > 0) entry.archivedAt = Number(raw.archivedAt);
        if (raw?.archivedKey) entry.archivedKey = String(raw.archivedKey);
        return entry;
    }

    private async ensureAdapterFolderExists(folderPath: string): Promise<void> {
        const normalized = normalizePath(String(folderPath || "").trim().replace(/^\/+|\/+$/g, ""));
        if (!normalized) return;
        if (await this.app.vault.adapter.exists(normalized)) return;
        const parent = normalized.substring(0, normalized.lastIndexOf("/"));
        if (parent) await this.ensureAdapterFolderExists(parent);
        try {
            await this.app.vault.adapter.mkdir(normalized);
        } catch (error: any) {
            if (!(typeof error?.message === "string" && error.message.toLowerCase().includes("already exists"))) throw error;
        }
    }

    private buildObjectKey(file: TFile, body: ArrayBuffer): string {
        const rule = this.getRule();
        const folder = this.expandFolderTemplate(rule.folder).replace(/^\/+|\/+$/g, "");
        const fileName = rule.hashFileName ? this.hashFileName(file.name, body, rule.hashSeed) : this.sanitizeFileName(file.name);
        return folder ? `${folder}/${fileName}` : fileName;
    }

    private buildPublicUrl(key: string): string {
        const rule = this.getRule();
        const base = (rule.contentUrl || rule.endpoint).replace(/\/+$/g, "");
        const endpoint = base || "https://s3.amazonaws.com";
        const withoutProtocol = endpoint.replace(/^https?:\/\//i, "");
        const protocol = endpoint.startsWith("http://") ? "http://" : "https://";
        const encodedKey = key.split("/").map((part) => encodeURIComponent(part)).join("/");
        if (rule.useBucketSubdomain) return `${protocol}${rule.bucket}.${withoutProtocol}/${encodedKey}`;
        return `${protocol}${withoutProtocol}/${rule.bucket}/${encodedKey}`;
    }

    private buildReplacement(reference: string, url: string): string {
        const markdownEmbed = reference.match(/^!\[([^\]]*)\]\(/);
        if (markdownEmbed) return `![${markdownEmbed[1]}](${url})`;
        if (reference.startsWith("!")) return `![](${url})`;
        return `[${url}](${url})`;
    }

    private sanitizeFileName(fileName: string): string {
        return fileName.replace(/\s+/g, "_").replace(/[^\w.-]/g, "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    }

    private hashFileName(fileName: string, body: ArrayBuffer, seed: number): string {
        const seedBuffer = new ArrayBuffer(4);
        new DataView(seedBuffer).setUint32(0, Number(seed) || 0, true);
        const hash = createHash("sha256");
        hash.update(Buffer.from(seedBuffer));
        hash.update(Buffer.from(body));
        const extension = fileName.includes(".") ? fileName.slice(fileName.lastIndexOf(".") + 1) : "";
        return extension ? `${hash.digest("hex")}.${extension}` : hash.digest("hex");
    }

    private expandFolderTemplate(folder: string): string {
        return this.expandFolderTemplateAt(folder, new Date());
    }

    private expandFolderTemplateAt(folder: string, now: Date): string {
        return normalizePath(String(folder || "")
            .replace(/\{YYYY\}/g, String(now.getFullYear()))
            .replace(/\{MM\}/g, String(now.getMonth() + 1).padStart(2, "0"))
            .replace(/\{DD\}/g, String(now.getDate()).padStart(2, "0")));
    }

    private getMimeType(extension: string): string {
        const ext = extension.toLowerCase();
        const types: Record<string, string> = {
            png: "image/png",
            jpg: "image/jpeg",
            jpeg: "image/jpeg",
            gif: "image/gif",
            webp: "image/webp",
            svg: "image/svg+xml",
            avif: "image/avif",
            heic: "image/heic",
            heif: "image/heif",
            pdf: "application/pdf",
            mp4: "video/mp4",
            mov: "video/quicktime",
            mp3: "audio/mpeg",
            wav: "audio/wav",
            canvas: "application/json",
            md: "text/markdown",
        };
        return types[ext] || "application/octet-stream";
    }

    private async handleUploadedSources(
        notePath: string,
        uploadedPaths: string[],
        automatic: boolean,
    ): Promise<{ archivedCount: number; skippedArchiveCount: number }> {
        if (!uploadedPaths.length) return { archivedCount: 0, skippedArchiveCount: 0 };
        let mutationAuthority: TFile | null = null;
        if (automatic) {
            const note = this.app.vault.getAbstractFileByPath(notePath);
            if (!(note instanceof TFile)
                || !(await this.canAutomaticallyMutateNote(note, "archive-uploaded-sources", "mutation-boundary"))) {
                return { archivedCount: 0, skippedArchiveCount: uploadedPaths.length };
            }
            mutationAuthority = note;
        }
        if (this.isController()) {
            return this.archiveUploadedSourcePaths(uploadedPaths, mutationAuthority, "archive-uploaded-sources");
        }
        await this.requestControllerArchive(notePath, uploadedPaths);
        logger.flow("S3agleAutomation", "controller-archive:requested", { notePath, sourcePaths: uploadedPaths });
        return { archivedCount: 0, skippedArchiveCount: 0 };
    }

    private async archiveControllerRequestedSources(
        request: S3agleArchiveRequest,
    ): Promise<{ archivedCount: number; skippedArchiveCount: number }> {
        const notePath = normalizePath(String(request?.notePath || ""));
        const sourcePaths = Array.isArray(request?.sourcePaths)
            ? Array.from(new Set(request.sourcePaths.map((path) => normalizePath(String(path || ""))).filter(Boolean))).sort()
            : [];
        if (!notePath || !sourcePaths.length) return { archivedCount: 0, skippedArchiveCount: 0 };

        const note = this.app.vault.getAbstractFileByPath(notePath);
        if (!(note instanceof TFile)) {
            logger.flowWarn("S3agleAutomation", "controller-archive:skip-missing-note", { notePath, sourcePaths });
            return { archivedCount: 0, skippedArchiveCount: sourcePaths.length };
        }

        if (!(await this.canAutomaticallyMutateNote(note, "controller-archive-request", "preflight"))) {
            return { archivedCount: 0, skippedArchiveCount: sourcePaths.length };
        }

        const content = await this.app.vault.cachedRead(note);
        if (!this.canAutomaticallyMutateNoteSource(content, note, "controller-archive-request")) {
            return { archivedCount: 0, skippedArchiveCount: sourcePaths.length };
        }
        const remainingPaths = new Set(this.extractLocalAttachmentReferences(content, note.path).map((ref) => ref.path));
        const confirmedPaths = sourcePaths.filter((path) => !remainingPaths.has(path));
        const skippedReferenced = sourcePaths.length - confirmedPaths.length;
        const result = await this.archiveUploadedSourcePaths(confirmedPaths, note, "controller-archive-request");
        return {
            archivedCount: result.archivedCount,
            skippedArchiveCount: result.skippedArchiveCount + skippedReferenced,
        };
    }

    private async archiveUploadedSourcePaths(
        sourcePaths: string[],
        mutationAuthority: TFile | null = null,
        reason = "manual",
    ): Promise<{ archivedCount: number; skippedArchiveCount: number }> {
        const archiveFolder = this.getArchiveFolder();
        if (!archiveFolder) {
            logger.flowWarn("S3agleAutomation", "archive:skip-no-archive-folder");
            return { archivedCount: 0, skippedArchiveCount: sourcePaths.length };
        }

        let archivedCount = 0;
        let skippedArchiveCount = 0;
        const uniquePaths = Array.from(new Set(sourcePaths.map((path) => normalizePath(path)).filter(Boolean))).sort();
        for (const path of uniquePaths) {
            const source = this.app.vault.getAbstractFileByPath(path);
            if (!(source instanceof TFile)) {
                skippedArchiveCount += 1;
                continue;
            }
            if (this.isInFolder(source.path, archiveFolder)) {
                skippedArchiveCount += 1;
                continue;
            }

            const targetPath = await this.getAvailableArchivePath(source, archiveFolder);
            await this.ensureFolderExists(targetPath.substring(0, targetPath.lastIndexOf("/")));
            try {
                if (mutationAuthority
                    && !(await this.canAutomaticallyMutateNote(mutationAuthority, reason, "mutation-boundary"))) {
                    skippedArchiveCount += 1;
                    continue;
                }
                await this.app.vault.rename(source, targetPath);
                archivedCount += 1;
            } catch (error) {
                skippedArchiveCount += 1;
                logger.flowError("S3agleAutomation", "archive:failed", error, { path: source.path, targetPath });
            }
        }

        return { archivedCount, skippedArchiveCount };
    }

    private async canAutomaticallyMutateNote(
        file: TFile,
        reason: string,
        stage: "preflight" | "upload-boundary" | "mutation-boundary",
    ): Promise<boolean> {
        const allowed = await canAutomaticallyMutateViaGcm(this.app, file);
        if (!allowed) {
            logger.flowWarn("S3agleAutomation", "run:skip-template-protected", {
                path: file.path,
                reason,
                stage,
            });
        }
        return allowed;
    }

    private canAutomaticallyMutateNoteSource(content: string, file: TFile, reason: string): boolean {
        const allowed = canAutomaticallyMutateSourceViaGcm(this.app, content);
        if (!allowed) {
            logger.flowWarn("S3agleAutomation", "run:skip-template-protected", {
                path: file.path,
                reason,
                stage: "mutation-boundary",
            });
        }
        return allowed;
    }

    private extractLocalAttachmentReferences(content: string, sourcePath: string): LocalAttachmentReference[] {
        const references: LocalAttachmentReference[] = [];
        const seen = new Set<string>();
        const addReference = (reference: string, target: string) => {
            if (!target) return;
            if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return;
            const resolved = this.resolveLocalFile(target, sourcePath);
            if (!(resolved instanceof TFile)) return;
            if (resolved.extension.toLowerCase() === "md") return;
            const key = `${reference}\n${resolved.path}`;
            if (seen.has(key)) return;
            seen.add(key);
            references.push({ reference, path: resolved.path });
        };

        const wikiRegex = /!\[\[([^\]]+)\]\]/g;
        let wikiMatch: RegExpExecArray | null;
        while ((wikiMatch = wikiRegex.exec(content)) !== null) {
            const rawTarget = String(wikiMatch[1] || "").split("#")[0].split("|")[0].trim();
            addReference(wikiMatch[0], rawTarget);
        }

        const markdownRegex = /!\[[^\]]*\]\(([^)]+)\)/g;
        let markdownMatch: RegExpExecArray | null;
        while ((markdownMatch = markdownRegex.exec(content)) !== null) {
            const rawTarget = decodeURIComponent(String(markdownMatch[1] || "").trim()).replace(/^file:\/\//, "");
            addReference(markdownMatch[0], rawTarget);
        }

        return references;
    }

    private resolveLocalFile(target: string, sourcePath: string): TFile | null {
        const cleaned = normalizePath(target.replace(/^\/+/, ""));
        const direct = this.app.vault.getAbstractFileByPath(cleaned);
        if (direct instanceof TFile) return direct;
        const linked = this.app.metadataCache.getFirstLinkpathDest(cleaned, sourcePath);
        if (linked instanceof TFile) return linked;
        return null;
    }

    private getRule(): S3agleAttachmentAutomationSettings {
        const defaults: S3agleAttachmentAutomationSettings = {
            enabled: false,
            runOnActiveNoteOpen: true,
            runOnActiveNoteModify: true,
            runOnPaste: true,
            runAfterCommandIds: [],
            debounceSeconds: 10,
            cooldownMinutes: 10,
            archiveUploadedSources: true,
            allowedAttachmentExtensions: [],
            ignoredAttachmentExtensions: [],
            makeUploadedObjectsPublic: true,
            accessKeySecretName: "tps-controller-s3-access-key",
            secretKeySecretName: "tps-controller-s3-secret-key",
            region: "us-east-1",
            bucket: "",
            folder: "",
            endpoint: "",
            useBucketSubdomain: false,
                contentUrl: "",
                hashFileName: false,
                hashSeed: 0,
                archiveUnreferencedBucketObjects: false,
                bucketArchivePrefix: "_archive/s3/{YYYY}/{MM}/{DD}",
                bucketArchiveCheckIntervalMinutes: 60,
                bucketArchiveOrphanDelayMinutes: 60,
                bucketArchiveLastRunAt: 0,
        };
        const raw = this.getSettings().s3agleAttachmentAutomation || defaults;
        const debounceSeconds = Number(raw.debounceSeconds);
        const cooldownMinutes = Number(raw.cooldownMinutes);
        const hashSeed = Number(raw.hashSeed);
        const bucketArchiveCheckIntervalMinutes = Number(raw.bucketArchiveCheckIntervalMinutes);
        const bucketArchiveOrphanDelayMinutes = Number(raw.bucketArchiveOrphanDelayMinutes);
        const bucketArchiveLastRunAt = Number(raw.bucketArchiveLastRunAt);
        return {
            enabled: raw.enabled === true,
            runOnActiveNoteOpen: raw.runOnActiveNoteOpen !== false,
            runOnActiveNoteModify: raw.runOnActiveNoteModify !== false,
            runOnPaste: raw.runOnPaste !== false,
            runAfterCommandIds: Array.isArray(raw.runAfterCommandIds)
                ? raw.runAfterCommandIds.map((id) => String(id || "").trim()).filter(Boolean)
                : [],
            debounceSeconds: Number.isFinite(debounceSeconds) ? Math.max(1, debounceSeconds) : defaults.debounceSeconds,
            cooldownMinutes: Number.isFinite(cooldownMinutes) ? Math.max(1, cooldownMinutes) : defaults.cooldownMinutes,
            archiveUploadedSources: raw.archiveUploadedSources !== false,
            allowedAttachmentExtensions: this.normalizeExtensionList(raw.allowedAttachmentExtensions),
            ignoredAttachmentExtensions: this.normalizeExtensionList(raw.ignoredAttachmentExtensions),
            makeUploadedObjectsPublic: raw.makeUploadedObjectsPublic !== false,
            accessKeySecretName: String(raw.accessKeySecretName || "").trim(),
            secretKeySecretName: String(raw.secretKeySecretName || "").trim(),
            region: String(raw.region || defaults.region),
            bucket: String(raw.bucket || ""),
            folder: String(raw.folder || ""),
            endpoint: String(raw.endpoint || ""),
            useBucketSubdomain: raw.useBucketSubdomain === true,
                contentUrl: String(raw.contentUrl || ""),
                hashFileName: raw.hashFileName === true,
                hashSeed: Number.isFinite(hashSeed) ? hashSeed : defaults.hashSeed,
                archiveUnreferencedBucketObjects: raw.archiveUnreferencedBucketObjects === true,
                bucketArchivePrefix: String(raw.bucketArchivePrefix || defaults.bucketArchivePrefix),
                bucketArchiveCheckIntervalMinutes: Number.isFinite(bucketArchiveCheckIntervalMinutes)
                    ? Math.max(1, bucketArchiveCheckIntervalMinutes)
                    : defaults.bucketArchiveCheckIntervalMinutes,
                bucketArchiveOrphanDelayMinutes: Number.isFinite(bucketArchiveOrphanDelayMinutes)
                    ? Math.max(5, bucketArchiveOrphanDelayMinutes)
                    : defaults.bucketArchiveOrphanDelayMinutes,
                bucketArchiveLastRunAt: Number.isFinite(bucketArchiveLastRunAt) ? bucketArchiveLastRunAt : defaults.bucketArchiveLastRunAt,
            };
    }

    private hasUploadConfiguration(rule = this.getRule()): boolean {
        return !!(
            rule.accessKeySecretName
            && rule.secretKeySecretName
            && rule.bucket
            && rule.endpoint
        );
    }

    private resolveExecutionCredentials(operation: "upload" | "bucket-archive", forceNotice: boolean): S3ExecutionCredentials | null {
        try {
            return resolveS3Credentials(this.getRule(), this.readSecret);
        } catch (error) {
            const code = error instanceof S3CredentialConfigurationError ? error.code : "secret-storage-unavailable";
            const message = error instanceof S3CredentialConfigurationError
                ? error.message
                : "S3 credentials could not be read from device-local SecretStorage.";
            this.reportCredentialFailure(operation, code, message, forceNotice);
            return null;
        }
    }

    private reportCredentialFailure(operation: string, code: string, message: string, forceNotice: boolean): void {
        logger.flowWarn("S3agleAutomation", "credentials:unavailable", { operation, code });
        const now = Date.now();
        if (!forceNotice && now - this.lastCredentialNoticeAt < 5 * 60 * 1000) return;
        this.lastCredentialNoticeAt = now;
        new Notice(message, 12000);
    }

    private normalizeExtensionList(value: unknown): string[] {
        const items = Array.isArray(value)
            ? value
            : String(value || "").split(",");
        return Array.from(new Set(items
            .map((item) => String(item || "").trim().toLowerCase().replace(/^\./, ""))
            .filter(Boolean)))
            .sort();
    }

    private isCoolingDown(path: string, rule: S3agleAttachmentAutomationSettings): boolean {
        const lastRun = this.lastRunByPath.get(path) || 0;
        return Date.now() - lastRun < Math.max(1, rule.cooldownMinutes) * 60 * 1000;
    }

    private getArchiveFolder(): string {
        return normalizePath(String(this.getSettings().archiveFolder || "Archive").trim().replace(/^\/+|\/+$/g, ""));
    }

    private isInIgnoredSystemPath(path: string): boolean {
        const normalized = normalizePath(path).toLowerCase();
        return normalized.startsWith(".obsidian/") || normalized.startsWith(".tps/") || normalized.startsWith(".trash/");
    }

    private isInFolder(filePath: string, folderPath: string): boolean {
        const file = normalizePath(filePath).toLowerCase();
        const folder = normalizePath(folderPath).toLowerCase().replace(/\/+$/g, "");
        return !!folder && (file === folder || file.startsWith(`${folder}/`));
    }

    private async getAvailableArchivePath(file: TFile, archiveFolder: string): Promise<string> {
        const target = normalizePath(`${archiveFolder}/${file.path}`);
        const extension = target.includes(".") ? target.slice(target.lastIndexOf(".")) : "";
        const withoutExtension = extension ? target.slice(0, -extension.length) : target;
        let candidate = target;
        let counter = 1;
        while (this.app.vault.getAbstractFileByPath(candidate)) {
            candidate = `${withoutExtension} ${counter}${extension}`;
            counter += 1;
        }
        return candidate;
    }

    private async ensureFolderExists(folderPath: string): Promise<void> {
        const normalized = normalizePath(String(folderPath || "").trim().replace(/^\/+|\/+$/g, ""));
        if (!normalized) return;
        if (this.app.vault.getAbstractFileByPath(normalized)) return;
        const parent = normalized.substring(0, normalized.lastIndexOf("/"));
        if (parent) await this.ensureFolderExists(parent);
        try {
            await this.app.vault.createFolder(normalized);
        } catch (error: any) {
            if (!(typeof error?.message === "string" && error.message.toLowerCase().includes("already exists"))) {
                throw error;
            }
        }
    }
}
