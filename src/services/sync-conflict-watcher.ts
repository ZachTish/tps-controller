import { App, TFile, Notice, normalizePath } from "obsidian";
import * as logger from "../logger";

type SyncConflictCause = "vault-create" | "vault-rename" | "startup-sweep";

type WatcherTimerHost = {
    setTimeout(callback: () => void, delayMs: number): number;
    clearTimeout(id: number): void;
};

export class SyncConflictWatcher {
    private app: App;
    private timerHost: WatcherTimerHost;
    private eventDisposers: Array<() => void> = [];
    private archiveFolder: string = "System/Archive";
    private eventIdKey: string = "externalEventId";
    private active = false;
    private lifecycleGeneration = 0;
    private startupSweepTimer: { generation: number; id: number } | null = null;
    private activeSweep: { generation: number; promise: Promise<void> } | null = null;
    private candidateTail: Promise<void> = Promise.resolve();

    constructor(app: App, timerHost: WatcherTimerHost = window) {
        this.app = app;
        this.timerHost = timerHost;
    }

    public updateConfig(archiveFolder: string, eventIdKey?: string) {
        this.archiveFolder = (archiveFolder || "System/Archive").trim();
        if (eventIdKey) this.eventIdKey = eventIdKey;
        logger.flow("SyncConflictWatcher", "config:updated", {
            archiveFolder: this.archiveFolder,
            duplicateFolder: this.getDuplicateArchiveFolder(),
            eventIdKey: this.eventIdKey,
        });
    }

    private getDuplicateArchiveFolder(): string {
        const base = normalizePath((this.archiveFolder || "System/Archive").trim());
        if (!base) return "System/Archive/Duplicates";
        if (base.toLowerCase().endsWith("/duplicates")) {
            return base;
        }
        return normalizePath(`${base}/Duplicates`);
    }

    private isInDuplicateArchiveFolder(filePath: string): boolean {
        const normalizedPath = normalizePath(filePath).toLowerCase();
        const duplicateFolder = this.getDuplicateArchiveFolder().toLowerCase();
        return normalizedPath === duplicateFolder || normalizedPath.startsWith(`${duplicateFolder}/`);
    }

    public start(): void {
        if (this.active) {
            logger.flow("SyncConflictWatcher", "start:already-active", {
                generation: this.lifecycleGeneration,
            });
            return;
        }
        this.active = true;
        const generation = ++this.lifecycleGeneration;
        logger.flow("SyncConflictWatcher", "start", {
            generation,
            archiveFolder: this.archiveFolder,
            duplicateFolder: this.getDuplicateArchiveFolder(),
            eventIdKey: this.eventIdKey,
        });
        // 1. Listen for new files being created or renamed by Sync
        const createRef = this.app.vault.on("create", (file) => {
            if (!this.isActiveGeneration(generation) || !(file instanceof TFile) || file.extension !== "md") return;
            void this.enqueueCandidate(file, "vault-create", generation).catch((error) => {
                logger.flowError("SyncConflictWatcher", "candidate:failed", error, {
                    cause: "vault-create",
                    path: file.path,
                    generation,
                });
            });
        });
        this.eventDisposers.push(() => this.app.vault.offref(createRef));

        const renameRef = this.app.vault.on("rename", (file) => {
            if (!this.isActiveGeneration(generation) || !(file instanceof TFile) || file.extension !== "md") return;
            void this.enqueueCandidate(file, "vault-rename", generation).catch((error) => {
                logger.flowError("SyncConflictWatcher", "candidate:failed", error, {
                    cause: "vault-rename",
                    path: file.path,
                    generation,
                });
            });
        });
        this.eventDisposers.push(() => this.app.vault.offref(renameRef));

        // 2. Do an initial sweep to catch any created while Obsidian was closed.
        // Must wait for metadataCache to be fully populated: hasCalendarIdentity()
        // calls getFileCache(), which returns null before 'resolved' fires.
        // If it returns false early, a meeting note that happens to have a
        // conflict-style name would bypass the guard and be incorrectly archived.
        let startupSweepDone = false;
        const runStartupSweep = () => {
            if (startupSweepDone || !this.isActiveGeneration(generation)) return;
            startupSweepDone = true;
            this.clearStartupSweepTimer(generation);
            logger.flow("SyncConflictWatcher", "startup-sweep:scheduled", { generation });
            void this.requestSweep(generation).catch((error) => {
                logger.flowError("SyncConflictWatcher", "startup-sweep:failed", error, { generation });
            });
        };
        // Fallback: if the vault was already fully resolved before we registered
        // the event (common on subsequent loads), fire after a generous delay.
        const timerId = this.timerHost.setTimeout(runStartupSweep, 8000);
        this.startupSweepTimer = { generation, id: timerId };

        const resolvedRef = this.app.metadataCache.on("resolved", runStartupSweep);
        this.eventDisposers.push(() => this.app.metadataCache.offref(resolvedRef));
    }

    public stop(): void {
        const stoppedGeneration = this.lifecycleGeneration;
        const wasActive = this.active;
        this.active = false;
        this.lifecycleGeneration += 1;
        const clearedStartupTimer = this.clearStartupSweepTimer();
        const disposers = this.eventDisposers.splice(0);
        disposers.forEach((dispose, index) => {
            try {
                dispose();
            } catch (error) {
                logger.flowError("SyncConflictWatcher", "stop:listener-cleanup-failed", error, { index });
            }
        });
        logger.flow("SyncConflictWatcher", "stop", {
            wasActive,
            stoppedGeneration,
            invalidatedByGeneration: this.lifecycleGeneration,
            removedListeners: disposers.length,
            clearedStartupTimer,
            activeSweepGeneration: this.activeSweep?.generation ?? null,
        });
    }

    /**
     * Scans the entire vault ONCE at startup to catch any offline sync conflicts.
     */
    public sweepVaultForConflicts(): Promise<void> {
        return this.requestSweep(this.lifecycleGeneration);
    }

    private requestSweep(generation: number): Promise<void> {
        if (!this.isActiveGeneration(generation)) {
            logger.flow("SyncConflictWatcher", "sweep:skip-inactive", { generation });
            return Promise.resolve();
        }

        const activeSweep = this.activeSweep;
        if (activeSweep) {
            if (activeSweep.generation === generation) {
                logger.flow("SyncConflictWatcher", "sweep:skip-already-running", { generation });
                return activeSweep.promise;
            }
            logger.flow("SyncConflictWatcher", "sweep:wait-prior-generation", {
                generation,
                priorGeneration: activeSweep.generation,
            });
            return activeSweep.promise.then(
                () => this.isActiveGeneration(generation) ? this.requestSweep(generation) : undefined,
                () => this.isActiveGeneration(generation) ? this.requestSweep(generation) : undefined,
            );
        }

        let trackedPromise: Promise<void>;
        trackedPromise = this.runSweep(generation).finally(() => {
            if (this.activeSweep?.promise === trackedPromise) {
                this.activeSweep = null;
            }
        });
        this.activeSweep = { generation, promise: trackedPromise };
        return trackedPromise;
    }

    private async runSweep(generation: number): Promise<void> {
        const pendingCandidates = this.candidateTail;
        await pendingCandidates;
        if (!this.isActiveGeneration(generation)) {
            logger.flow("SyncConflictWatcher", "sweep:cancelled", { generation, stage: "before-start" });
            return;
        }
        const duplicateFolder = this.getDuplicateArchiveFolder();
        let scanned = 0;
        let conflictNamed = 0;
        let archivedCount = 0;
        const files = this.app.vault.getMarkdownFiles();
        logger.flow("SyncConflictWatcher", "sweep:start", {
            generation,
            files: files.length,
            duplicateFolder,
        });

        for (const file of files) {
            if (!this.isActiveGeneration(generation)) {
                logger.flow("SyncConflictWatcher", "sweep:cancelled", {
                    generation,
                    stage: "before-file",
                    scanned,
                    conflictNamed,
                    archived: archivedCount,
                });
                return;
            }
            // Quick ignore for our own archive folder
            if (this.isInDuplicateArchiveFolder(file.path)) continue;
            scanned++;
            if (this.isConflictName(file.basename)) conflictNamed++;

            const archived = await this.enqueueCandidate(file, "startup-sweep", generation);
            if (!this.isActiveGeneration(generation)) {
                logger.flow("SyncConflictWatcher", "sweep:cancelled", {
                    generation,
                    stage: "after-file",
                    scanned,
                    conflictNamed,
                    archived: archivedCount,
                });
                return;
            }
            if (archived) archivedCount++;
        }

        if (!this.isActiveGeneration(generation)) {
            logger.flow("SyncConflictWatcher", "sweep:cancelled", {
                generation,
                stage: "before-completion",
                scanned,
                conflictNamed,
                archived: archivedCount,
            });
            return;
        }
        if (archivedCount > 0) {
            new Notice(`Controller: Archived ${archivedCount} sync conflicts on startup.`);
        }
        logger.flow("SyncConflictWatcher", "sweep:done", {
            generation,
            scanned,
            conflictNamed,
            archived: archivedCount,
            duplicateFolder,
        });
    }

    private enqueueCandidate(file: TFile, cause: SyncConflictCause, generation: number): Promise<boolean> {
        const candidate = this.candidateTail.then(() => {
            if (!this.isActiveGeneration(generation)) return false;
            return this.checkAndArchiveIfConflict(file, cause, generation);
        });
        this.candidateTail = candidate.then(
            () => undefined,
            () => undefined,
        );
        return candidate;
    }

    /**
     * Checks if a file has a conflict-style name and if its canonical parent exists.
     * If so, safely archives it.
     */
    private async checkAndArchiveIfConflict(file: TFile, cause: SyncConflictCause, generation: number): Promise<boolean> {
        if (!this.isActiveGeneration(generation)) return false;
        // Must match standard Sync conflict patterns
        if (!this.isConflictName(file.basename)) return false;
        logger.flow("SyncConflictWatcher", "check:start", {
            cause,
            path: file.path,
            basename: file.basename,
        });

        // Prevent recursive archiving of the archive itself
        if (this.isInDuplicateArchiveFolder(file.path)) {
            logger.flow("SyncConflictWatcher", "check:skip-duplicate-folder", { cause, path: file.path });
            return false;
        }

        // Skip files that have a calendar event identity key in frontmatter.
        // These are auto-created meeting notes — let AutoCreateService manage them.
        // Archiving them here would cause delete+recreate loops.
        if (this.hasCalendarIdentity(file)) {
            logger.flow("SyncConflictWatcher", "check:skip-calendar-identity", {
                cause,
                path: file.path,
                eventIdKey: this.eventIdKey,
            });
            return false;
        }

        const canonicalBaseName = this.getCanonicalBaseName(file.basename);
        if (!canonicalBaseName) {
            logger.flow("SyncConflictWatcher", "check:skip-no-canonical-name", { cause, path: file.path });
            return false;
        }

        const parentPath = file.parent?.path || "";
        const expectedCanonicalPath = normalizePath(parentPath === "/" ? `${canonicalBaseName}.md` : `${parentPath}/${canonicalBaseName}.md`);

        const canonicalFile = this.app.vault.getAbstractFileByPath(expectedCanonicalPath);
        logger.flow("SyncConflictWatcher", "check:canonical-resolved", {
            cause,
            path: file.path,
            expectedCanonicalPath,
            canonicalExists: canonicalFile instanceof TFile,
        });

        // Only archive this conflict IF the canonical note is still safely in the vault
        if (canonicalFile && canonicalFile instanceof TFile) {
            if (!this.isActiveGeneration(generation)) return false;
            return await this.archiveDuplicate(file, cause, expectedCanonicalPath, generation);
        }

        logger.flow("SyncConflictWatcher", "check:skip-missing-canonical", {
            cause,
            path: file.path,
            expectedCanonicalPath,
        });
        return false;
    }

    /** Check if a file has a calendar event identity key in its frontmatter. */
    private hasCalendarIdentity(file: TFile): boolean {
        const cache = this.app.metadataCache.getFileCache(file);
        const fm = cache?.frontmatter;
        if (!fm) return false;

        const key = this.eventIdKey.toLowerCase();
        return Object.keys(fm).some(k => k.toLowerCase() === key && fm[k]);
    }

    private isConflictName(basename: string): boolean {
        // Matches: "Note duplicate", "Note duplicate 2", "Note (Sync conflict 2026-02-20)"
        // REMOVED `\s+\d+$` because it dangerously matched normal numbered files like "Project Phase 2"
        return /\s+\(\s*Sync conflict[^)]+\)/i.test(basename) ||
            /\s+duplicate(\s+\d+)?$/i.test(basename) ||
            /\s+\(\d+\)$/i.test(basename); // Catches "Note (1)" style OS conflicts
    }

    private getCanonicalBaseName(basename: string): string {
        return basename
            .replace(/\s+\(\s*Sync conflict[^)]+\)/i, "")
            .replace(/\s+duplicate(\s+\d+)?$/i, "")
            .replace(/\s+\(\d+\)$/i, "")
            .trim();
    }

    private async archiveDuplicate(
        file: TFile,
        cause: SyncConflictCause,
        expectedCanonicalPath: string,
        generation: number,
    ): Promise<boolean> {
        if (!this.isActiveGeneration(generation)) return false;
        const dupFolder = this.getDuplicateArchiveFolder();
        const originalPath = file.path;
        try {
            await this.ensureFolderExists(dupFolder, generation);
            if (!this.isActiveGeneration(generation)) {
                logger.flow("SyncConflictWatcher", "archive:cancelled", {
                    cause,
                    path: originalPath,
                    generation,
                    stage: "after-folder",
                });
                return false;
            }
            const baseName = this.getCanonicalBaseName(file.basename);

            let newPath = normalizePath(`${dupFolder}/${baseName} duplicate.${file.extension}`);
            let counter = 1;
            while (this.app.vault.getAbstractFileByPath(newPath)) {
                if (this.app.vault.getAbstractFileByPath(newPath) === file) {
                    logger.flow("SyncConflictWatcher", "archive:already-target", { cause, path: file.path, newPath });
                    return true;
                }
                newPath = normalizePath(`${dupFolder}/${baseName} duplicate ${counter}.${file.extension}`);
                counter++;
            }

            if (!this.isActiveGeneration(generation)) {
                logger.flow("SyncConflictWatcher", "archive:cancelled", {
                    cause,
                    path: originalPath,
                    generation,
                    stage: "before-rename",
                });
                return false;
            }

            logger.flow("SyncConflictWatcher", "archive:start", {
                cause,
                path: originalPath,
                expectedCanonicalPath,
                targetPath: newPath,
                collisionCount: counter - 1,
            });
            await this.app.vault.rename(file, newPath);
            if (!this.isActiveGeneration(generation)) {
                logger.flowWarn("SyncConflictWatcher", "archive:completed-after-stop", {
                    cause,
                    originalPath,
                    targetPath: newPath,
                    expectedCanonicalPath,
                    generation,
                });
                return false;
            }
            logger.flowWarn("SyncConflictWatcher", "archive:done", {
                cause,
                originalPath,
                targetPath: newPath,
                expectedCanonicalPath,
                collisionCount: counter - 1,
            });
            return true;
        } catch (error) {
            logger.flowError("SyncConflictWatcher", "archive:failed", error, {
                cause,
                path: originalPath,
                expectedCanonicalPath,
                duplicateFolder: dupFolder,
            });
            return false;
        }
    }

    private async ensureFolderExists(folderPath: string, generation: number): Promise<void> {
        if (!this.isActiveGeneration(generation)) return;
        if (!folderPath || folderPath === "/") return;
        const normalizedPath = normalizePath(folderPath);
        const folder = this.app.vault.getAbstractFileByPath(normalizedPath);
        if (!folder) {
            const parent = normalizedPath.substring(0, normalizedPath.lastIndexOf("/"));
            if (parent) {
                await this.ensureFolderExists(parent, generation);
            }
            if (!this.isActiveGeneration(generation)) return;
            try {
                if (!this.isActiveGeneration(generation)) return;
                await this.app.vault.createFolder(normalizedPath);
                if (!this.isActiveGeneration(generation)) {
                    logger.flow("SyncConflictWatcher", "folder:created-after-stop", {
                        path: normalizedPath,
                        generation,
                    });
                    return;
                }
                logger.flow("SyncConflictWatcher", "folder:created", { path: normalizedPath });
            } catch (e: any) {
                if (!(typeof e.message === "string" && e.message.toLowerCase().includes("already exists"))) {
                    throw e;
                }
                logger.flow("SyncConflictWatcher", "folder:create-raced", { path: normalizedPath });
            }
        }
    }

    private isActiveGeneration(generation: number): boolean {
        return this.active && generation === this.lifecycleGeneration;
    }

    private clearStartupSweepTimer(generation?: number): boolean {
        const timer = this.startupSweepTimer;
        if (!timer || (generation !== undefined && timer.generation !== generation)) return false;
        this.timerHost.clearTimeout(timer.id);
        this.startupSweepTimer = null;
        return true;
    }
}
