import { App, TFile, Notice, normalizePath } from "obsidian";
import * as logger from "../logger";
import { getGcmApi } from "../tps-gcm-api";
import { parseCalendarRecordId } from "./calendar-record-identity";

export class SyncConflictWatcher {
    private app: App;
    private eventDisposers: Array<() => void> = [];
    private startupSweepTimerId: number | null = null;
    private startupSweepGeneration = 0;
    private archiveFolder: string = "System/Archive";
    private eventIdKey: string = "externalEventId";
    private isSweeping = false;

    constructor(app: App) {
        this.app = app;
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

    public start() {
        logger.flow("SyncConflictWatcher", "start", {
            archiveFolder: this.archiveFolder,
            duplicateFolder: this.getDuplicateArchiveFolder(),
            eventIdKey: this.eventIdKey,
        });
        // 1. Listen for new files being created or renamed by Sync
        const createRef = this.app.vault.on("create", async (file) => {
            if (file instanceof TFile && file.extension === "md") {
                await this.checkAndArchiveIfConflict(file, "vault-create");
            }
        });
        this.eventDisposers.push(() => this.app.vault.offref(createRef));
        const renameRef = this.app.vault.on("rename", async (file) => {
            if (file instanceof TFile && file.extension === "md") {
                await this.checkAndArchiveIfConflict(file, "vault-rename");
            }
        });
        this.eventDisposers.push(() => this.app.vault.offref(renameRef));
        const metadataChangedRef = this.app.metadataCache.on("changed", async (file) => {
            if (file instanceof TFile && file.extension === "md") {
                await this.checkAndArchiveIfConflict(file, "metadata-changed");
            }
        });
        this.eventDisposers.push(() => this.app.metadataCache.offref(metadataChangedRef));

        // 2. Do an initial sweep to catch any created while Obsidian was closed.
        // Must wait for metadataCache to be fully populated: hasCalendarIdentity()
        // calls getFileCache(), which returns null before 'resolved' fires.
        // If it returns false early, a meeting note that happens to have a
        // conflict-style name would bypass the guard and be incorrectly archived.
        const startupSweepGeneration = ++this.startupSweepGeneration;
        let startupSweepDone = false;
        const runStartupSweep = () => {
            if (startupSweepDone || startupSweepGeneration !== this.startupSweepGeneration) return;
            startupSweepDone = true;
            this.clearStartupSweepTimer();
            logger.flow("SyncConflictWatcher", "startup-sweep:scheduled");
            void this.sweepVaultForConflicts();
        };
        const resolvedRef = this.app.metadataCache.on("resolved", runStartupSweep);
        this.eventDisposers.push(() => this.app.metadataCache.offref(resolvedRef));
        // Fallback: if the vault was already fully resolved before we registered
        // the event (common on subsequent loads), fire after a generous delay.
        this.startupSweepTimerId = window.setTimeout(runStartupSweep, 8000);
    }

    public stop() {
        this.startupSweepGeneration++;
        this.clearStartupSweepTimer();
        const removedListeners = this.eventDisposers.length;
        for (const dispose of this.eventDisposers) dispose();
        this.eventDisposers = [];
        logger.flow("SyncConflictWatcher", "stop", { removedListeners });
    }

    private clearStartupSweepTimer(): void {
        if (this.startupSweepTimerId === null) return;
        window.clearTimeout(this.startupSweepTimerId);
        this.startupSweepTimerId = null;
    }

    /**
     * Scans the entire vault ONCE at startup to catch any offline sync conflicts.
     */
    public async sweepVaultForConflicts() {
        if (this.isSweeping) {
            logger.flow("SyncConflictWatcher", "sweep:skip-already-running");
            return;
        }
        this.isSweeping = true;
        const duplicateFolder = this.getDuplicateArchiveFolder();
        let scanned = 0;
        let conflictNamed = 0;
        let archivedCount = 0;
        try {
            const files = this.app.vault.getMarkdownFiles();
            logger.flow("SyncConflictWatcher", "sweep:start", {
                files: files.length,
                duplicateFolder,
            });

            for (const file of files) {
                // Quick ignore for our own archive folder
                if (this.isInDuplicateArchiveFolder(file.path)) continue;
                scanned++;
                if (this.isConflictName(file.basename)) conflictNamed++;

                const archived = await this.checkAndArchiveIfConflict(file, "startup-sweep");
                if (archived) archivedCount++;
            }

            if (archivedCount > 0) {
                new Notice(`Controller: Archived ${archivedCount} sync conflicts on startup.`);
            }
            logger.flow("SyncConflictWatcher", "sweep:done", {
                scanned,
                conflictNamed,
                archived: archivedCount,
                duplicateFolder,
            });
        } finally {
            this.isSweeping = false;
        }
    }

    /**
     * Checks if a file has a conflict-style name and if its canonical parent exists.
     * If so, safely archives it.
     */
    private async checkAndArchiveIfConflict(file: TFile, cause: "vault-create" | "vault-rename" | "metadata-changed" | "startup-sweep"): Promise<boolean> {
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

        // Skip files that have a TPS identity in frontmatter. Calendar records
        // now use only tpsId; the configured event-id key remains a read-only
        // compatibility fallback for older meeting notes.
        // These are auto-created meeting notes — let AutoCreateService manage them.
        // Archiving them here would cause delete+recreate loops.
        const calendarIdentity = this.hasCalendarIdentity(file);
        if (calendarIdentity === null) {
            logger.flow("SyncConflictWatcher", "check:defer-metadata", { cause, path: file.path });
            return false;
        }
        if (calendarIdentity) {
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
            return await this.archiveDuplicate(file, cause, expectedCanonicalPath);
        }

        logger.flow("SyncConflictWatcher", "check:skip-missing-canonical", {
            cause,
            path: file.path,
            expectedCanonicalPath,
        });
        return false;
    }

    /** Check if a file has a canonical or legacy calendar identity. */
    private hasCalendarIdentity(file: TFile): boolean | null {
        const cache = this.app.metadataCache.getFileCache(file);
        if (!cache) return null;
        const fm = cache.frontmatter;
        if (!fm) return false;

        const inspected = getGcmApi(this.app)?.nativeRecords?.inspect?.(fm);
        if (inspected?.kind === "calendar-event" && !!inspected.id) return true;

        const read = (key: string): string => {
            const normalized = key.trim().toLowerCase();
            const actual = Object.keys(fm).find((candidate) => candidate.trim().toLowerCase() === normalized);
            return actual ? String(fm[actual] ?? "").trim() : "";
        };
        if (parseCalendarRecordId(read("tpsId"))) return true;
        if (read(this.eventIdKey)) return true;
        return read("externalId").startsWith("calendar:");
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
        cause: "vault-create" | "vault-rename" | "metadata-changed" | "startup-sweep",
        expectedCanonicalPath: string,
    ): Promise<boolean> {
        const dupFolder = this.getDuplicateArchiveFolder();
        const originalPath = file.path;
        try {
            await this.ensureFolderExists(dupFolder);
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

            logger.flow("SyncConflictWatcher", "archive:start", {
                cause,
                path: originalPath,
                expectedCanonicalPath,
                targetPath: newPath,
                collisionCount: counter - 1,
            });
            await this.app.vault.rename(file, newPath);
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

    private async ensureFolderExists(folderPath: string): Promise<void> {
        if (!folderPath || folderPath === "/") return;
        const normalizedPath = normalizePath(folderPath);
        const folder = this.app.vault.getAbstractFileByPath(normalizedPath);
        if (!folder) {
            const parent = normalizedPath.substring(0, normalizedPath.lastIndexOf("/"));
            if (parent) {
                await this.ensureFolderExists(parent);
            }
            try {
                await this.app.vault.createFolder(normalizedPath);
                logger.flow("SyncConflictWatcher", "folder:created", { path: normalizedPath });
            } catch (e: any) {
                if (!(typeof e.message === "string" && e.message.toLowerCase().includes("already exists"))) {
                    throw e;
                }
                logger.flow("SyncConflictWatcher", "folder:create-raced", { path: normalizedPath });
            }
        }
    }
}
