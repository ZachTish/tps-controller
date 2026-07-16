import { App, TFile, normalizePath } from "obsidian";
import * as logger from "../logger";
import {
    acknowledgeSyncRequest,
    createSyncRequestId,
    mergeSyncRequests,
    normalizeSyncRequest,
    parseSyncRequestContent,
    serializeSyncRequest,
    type S3agleArchiveRequest,
    type SyncRequest,
} from "./sync-request-contract";

export type { S3agleArchiveRequest, SyncRequest } from "./sync-request-contract";

/**
 * File-based sync request mechanism for user → controller communication.
 *
 * Replicas write a request file into the shared vault; the controller's
 * periodic sync loop picks it up and fulfills it.
 */

export class SyncRequestService {
    private app: App;
    private requestPath: string;

    constructor(app: App, pluginDir: string) {
        this.app = app;
        this.requestPath = normalizePath(`${pluginDir}/.sync-request.json`);
        logger.flow("SyncRequest", "service:initialized", { requestPath: this.requestPath });
    }

    /** Write a sync request (called by users). */
    async writeRequest(scope: SyncRequest["scope"], extras: Pick<SyncRequest, "s3agleArchiveRequests"> = {}): Promise<void> {
        const requestedAt = Date.now();
        const request = normalizeSyncRequest({
            requestId: createSyncRequestId(requestedAt),
            requestedAt,
            requestedBy: this.app.vault.getName(),
            scope,
            ...extras,
        });
        if (!request || !request.scope.length) throw new Error("Sync request requires at least one supported scope.");

        const existing = this.app.vault.getAbstractFileByPath(this.requestPath);
        logger.flow("SyncRequest", "write:start", {
            requestPath: this.requestPath,
            requestId: request.requestId,
            scope: request.scope,
            requestedBy: request.requestedBy,
            route: existing instanceof TFile ? "merge-existing" : "create-new",
        });
        let mergedScope = request.scope;
        let mergedArchiveRequests = request.s3agleArchiveRequests?.length || 0;
        if (existing instanceof TFile) {
            const merged = await this.mergeIntoExistingFile(existing, request);
            mergedScope = merged.scope;
            mergedArchiveRequests = merged.s3agleArchiveRequests?.length || 0;
        } else {
            try {
                await this.app.vault.create(this.requestPath, serializeSyncRequest(request));
            } catch (e) {
                if (this.isAlreadyExistsError(e)) {
                    // Race: another process created the file between the check and create.
                    const nowExisting = this.app.vault.getAbstractFileByPath(this.requestPath);
                    if (!(nowExisting instanceof TFile)) throw e;
                    const merged = await this.mergeIntoExistingFile(nowExisting, request);
                    mergedScope = merged.scope;
                    mergedArchiveRequests = merged.s3agleArchiveRequests?.length || 0;
                    logger.flow("SyncRequest", "write:create-raced", {
                        requestPath: this.requestPath,
                        requestId: request.requestId,
                        scope: mergedScope,
                        requestedBy: request.requestedBy,
                    });
                } else {
                    throw e;
                }
            }
        }

        logger.flow("SyncRequest", "write:done", {
            requestPath: this.requestPath,
            requestId: request.requestId,
            scope: mergedScope,
            archiveRequests: mergedArchiveRequests,
            requestedBy: request.requestedBy,
        });
    }

    async writeS3agleArchiveRequest(notePath: string, sourcePaths: string[]): Promise<void> {
        const normalizedPaths = Array.from(new Set(sourcePaths.map((path) => normalizePath(path)).filter(Boolean))).sort();
        if (!normalizedPaths.length) return;
        await this.writeRequest(["s3agle-archive"], {
            s3agleArchiveRequests: [{
                notePath: normalizePath(notePath),
                sourcePaths: normalizedPaths,
                requestedAt: Date.now(),
            }],
        });
    }

    /** Read pending request (called by controller). Returns null if none. */
    async readRequest(): Promise<SyncRequest | null> {
        const file = this.app.vault.getAbstractFileByPath(this.requestPath);
        if (!(file instanceof TFile)) return null;

        try {
            const content = await this.app.vault.read(file);
            const parsed = parseSyncRequestContent(content);
            if (parsed?.scope.length) {
                logger.flow("SyncRequest", "read:done", {
                    requestPath: this.requestPath,
                    requestId: parsed.requestId,
                    scope: parsed.scope,
                    requestedBy: parsed.requestedBy || "",
                    ageMs: Date.now() - Number(parsed.requestedAt),
                });
                return parsed;
            }
            if (parsed) {
                logger.flow("SyncRequest", "read:acknowledged", {
                    requestPath: this.requestPath,
                    requestId: parsed.requestId,
                });
                return null;
            }
            logger.flowWarn("SyncRequest", "read:invalid-shape", {
                requestPath: this.requestPath,
                contentLength: content.length,
            });
        } catch (e) {
            logger.flowWarn("SyncRequest", "read:parse-failed", {
                requestPath: this.requestPath,
                error: logger.errorSummary(e),
            });
        }

        return null;
    }

    /** Atomically acknowledge only the request generation that was fulfilled. */
    async acknowledgeRequest(expected: SyncRequest): Promise<boolean> {
        const file = this.app.vault.getAbstractFileByPath(this.requestPath);
        if (!(file instanceof TFile)) {
            logger.flow("SyncRequest", "ack:none", { requestPath: this.requestPath, requestId: expected.requestId });
            return false;
        }
        logger.flow("SyncRequest", "ack:start", {
            requestPath: this.requestPath,
            requestId: expected.requestId,
        });
        let acknowledged = false;
        let currentRequestId = "";
        let invalidCurrent = false;
        try {
            await this.app.vault.process(file, (content) => {
                const current = parseSyncRequestContent(content);
                if (!current) {
                    invalidCurrent = true;
                    return content;
                }
                currentRequestId = current.requestId;
                const result = acknowledgeSyncRequest(
                    current,
                    expected,
                    Date.now(),
                    this.app.vault.getName(),
                );
                acknowledged = result.acknowledged;
                return acknowledged ? serializeSyncRequest(result.request) : content;
            });
        } catch (error) {
            logger.flowError("SyncRequest", "ack:failed", error, {
                requestPath: this.requestPath,
                requestId: expected.requestId,
            });
            return false;
        }
        if (acknowledged) {
            logger.flow("SyncRequest", "ack:done", {
                requestPath: this.requestPath,
                requestId: expected.requestId,
            });
            return true;
        }
        logger.flowWarn("SyncRequest", invalidCurrent ? "ack:invalid-current" : "ack:stale-generation", {
            requestPath: this.requestPath,
            expectedRequestId: expected.requestId,
            currentRequestId,
        });
        return false;
    }

    private async mergeIntoExistingFile(file: TFile, incoming: SyncRequest): Promise<SyncRequest> {
        let merged = incoming;
        await this.app.vault.process(file, (content) => {
            merged = mergeSyncRequests(parseSyncRequestContent(content), incoming);
            return serializeSyncRequest(merged);
        });
        return merged;
    }

    private isAlreadyExistsError(error: unknown): boolean {
        return (error instanceof Error ? error.message : String(error || ""))
            .toLowerCase()
            .includes("already exists");
    }
}
