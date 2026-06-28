import { App, TFile, Notice, normalizePath, EventRef } from "obsidian";
import * as logger from "../logger";

export class SyncConflictWatcher {
    private app: App;
    private events: EventRef[] = [];
    private archiveFolder: string = "System/Archive";
    private eventIdKey: string = "externalEventId";
    private isSweeping = false;

    constructor(app: App) {
        this.app = app;
    }

    public updateConfig(archiveFolder: string, eventIdKey?: string) {
        this.archiveFolder = (archiveFolder || "System/Archive").trim();
        if (eventIdKey) this.eventIdKey = eventIdKey;
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
        // 1. Listen for new files being created or renamed by Sync
        this.events.push(
            this.app.vault.on("create", async (file) => {
                if (file instanceof TFile && file.extension === "md") {
                    await this.checkAndArchiveIfConflict(file);
                }
            })
        );
        this.events.push(
            this.app.vault.on("rename", async (file) => {
                if (file instanceof TFile && file.extension === "md") {
                    await this.checkAndArchiveIfConflict(file);
                }
            })
        );

        logger.log("🔍 SyncConflictWatcher: Started listening for file conflicts.");

        // 2. Do an initial sweep to catch any created while Obsidian was closed.
        // Must wait for metadataCache to be fully populated: hasCalendarIdentity()
        // calls getFileCache(), which returns null before 'resolved' fires.
        // If it returns false early, a meeting note that happens to have a
        // conflict-style name would bypass the guard and be incorrectly archived.
        let startupSweepDone = false;
        const runStartupSweep = () => {
            if (startupSweepDone) return;
            startupSweepDone = true;
            void this.sweepVaultForConflicts();
        };
        this.events.push(
            this.app.metadataCache.on("resolved", runStartupSweep),
        );
        // Fallback: if the vault was already fully resolved before we registered
        // the event (common on subsequent loads), fire after a generous delay.
        setTimeout(runStartupSweep, 8000);
    }

    public stop() {
        this.events.forEach(e => this.app.vault.offref(e));
        this.events = [];
        logger.log("🔍 SyncConflictWatcher: Stopped.");
    }

    /**
     * Scans the entire vault ONCE at startup to catch any offline sync conflicts.
     */
    public async sweepVaultForConflicts() {
        if (this.isSweeping) return;
        this.isSweeping = true;
        try {
            const files = this.app.vault.getMarkdownFiles();
            let archivedCount = 0;

            for (const file of files) {
                // Quick ignore for our own archive folder
                if (this.isInDuplicateArchiveFolder(file.path)) continue;

                const archived = await this.checkAndArchiveIfConflict(file);
                if (archived) archivedCount++;
            }

            if (archivedCount > 0) {
                new Notice(`Controller: Archived ${archivedCount} sync conflicts on startup.`);
                logger.warn(`🔍 SyncConflictWatcher: Swept and archived ${archivedCount} offline conflicts.`);
            }
        } finally {
            this.isSweeping = false;
        }
    }

    /**
     * Checks if a file has a conflict-style name and if its canonical parent exists.
     * If so, safely archives it.
     */
    private async checkAndArchiveIfConflict(file: TFile): Promise<boolean> {
        // Must match standard Sync conflict patterns
        if (!this.isConflictName(file.basename)) return false;

        // Prevent recursive archiving of the archive itself
        if (this.isInDuplicateArchiveFolder(file.path)) return false;

        // Skip files that have a calendar event identity key in frontmatter.
        // These are auto-created meeting notes — let AutoCreateService manage them.
        // Archiving them here would cause delete+recreate loops.
        if (this.hasCalendarIdentity(file)) {
            logger.log(`🔍 SyncConflictWatcher: Skipping conflict-named file with calendar identity: ${file.path}`);
            return false;
        }

        const canonicalBaseName = this.getCanonicalBaseName(file.basename);
        if (!canonicalBaseName) return false;

        const parentPath = file.parent?.path || "";
        const expectedCanonicalPath = normalizePath(parentPath === "/" ? `${canonicalBaseName}.md` : `${parentPath}/${canonicalBaseName}.md`);

        const canonicalFile = this.app.vault.getAbstractFileByPath(expectedCanonicalPath);

        // Only archive this conflict IF the canonical note is still safely in the vault
        if (canonicalFile && canonicalFile instanceof TFile) {
            return await this.archiveDuplicate(file);
        }

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

    private async archiveDuplicate(file: TFile): Promise<boolean> {
        const dupFolder = this.getDuplicateArchiveFolder();
        try {
            await this.ensureFolderExists(dupFolder);
            const baseName = this.getCanonicalBaseName(file.basename);

            let newPath = normalizePath(`${dupFolder}/${baseName} duplicate.${file.extension}`);
            let counter = 1;
            while (this.app.vault.getAbstractFileByPath(newPath)) {
                if (this.app.vault.getAbstractFileByPath(newPath) === file) return true; // Already here
                newPath = normalizePath(`${dupFolder}/${baseName} duplicate ${counter}.${file.extension}`);
                counter++;
            }

            await this.app.vault.rename(file, newPath);
            logger.warn(`🔍 SyncConflictWatcher: Archived conflict ${file.name} -> ${newPath}`);
            return true;
        } catch (error) {
            logger.error(`🔍 SyncConflictWatcher: Failed to archive duplicate ${file.path}`, error);
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
            } catch (e: any) {
                if (!(typeof e.message === "string" && e.message.toLowerCase().includes("already exists"))) {
                    throw e;
                }
            }
        }
    }
}
