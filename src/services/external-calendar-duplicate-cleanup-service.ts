import { App, TFile, normalizePath } from "obsidian";
import type { TPSControllerSettings } from "../types";
import * as logger from "../logger";

type DuplicateCandidate = {
    file: TFile;
    body: string;
    hasProtectedBodyContent: boolean;
    isOrphanCandidate: boolean;
};

export type ExternalCalendarDuplicateCleanupResult = {
    groupsFound: number;
    archivedCount: number;
    skippedWithContent: number;
};

export class ExternalCalendarDuplicateCleanupService {
    constructor(
        private readonly app: App,
        private readonly getSettings: () => TPSControllerSettings,
    ) {}

    async run(): Promise<ExternalCalendarDuplicateCleanupResult> {
        const groups = await this.collectDuplicateGroups();
        let archivedCount = 0;
        let skippedWithContent = 0;

        for (const group of groups) {
            const protectedCandidates = group.filter((candidate) => candidate.hasProtectedBodyContent);
            const keeper = (protectedCandidates[0] ?? group[0])?.file;
            if (!keeper) continue;

            if (protectedCandidates.length > 1) {
                skippedWithContent += protectedCandidates.length - 1;
            }

            for (const candidate of group) {
                if (candidate.file.path === keeper.path) continue;
                if (candidate.hasProtectedBodyContent) continue;

                const archived = await this.archiveDuplicate(candidate.file, keeper.basename);
                if (archived) {
                    archivedCount += 1;
                }
            }
        }

        return {
            groupsFound: groups.length,
            archivedCount,
            skippedWithContent,
        };
    }

    private async collectDuplicateGroups(): Promise<DuplicateCandidate[][]> {
        const grouped = new Map<string, DuplicateCandidate[]>();
        const settings = this.getSettings();

        for (const file of this.app.vault.getMarkdownFiles()) {
            if (this.shouldSkipFile(file, settings)) continue;

            const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
            if (!frontmatter) continue;

            const externalId = this.findStringCaseInsensitive(frontmatter, "externalId");
            const eventId = this.findStringCaseInsensitive(frontmatter, settings.eventIdKey);
            const sourceUrl = this.normalizeCalendarSourceUrl(this.findStringCaseInsensitive(frontmatter, "tpsCalendarSourceUrl"));

            const normalizedGroupKey = externalId
                ? `external:${externalId}`
                : eventId && sourceUrl
                    ? `legacy-source-event:${sourceUrl}#${eventId}`
                    : "";
            if (!normalizedGroupKey) continue;

            const content = await this.app.vault.cachedRead(file);
            const body = this.stripFrontmatter(content);
            const candidate: DuplicateCandidate = {
                file,
                body,
                hasProtectedBodyContent: this.hasProtectedBodyContent(body),
                isOrphanCandidate: this.isOrphanCandidate(frontmatter),
            };

            const existing = grouped.get(normalizedGroupKey) ?? [];
            existing.push(candidate);
            grouped.set(normalizedGroupKey, existing);
        }

        return Array.from(grouped.values())
            .filter((group) => group.length > 1)
            .map((group) => group.sort((left, right) => {
                if (left.hasProtectedBodyContent !== right.hasProtectedBodyContent) {
                    return left.hasProtectedBodyContent ? -1 : 1;
                }
                if (left.isOrphanCandidate !== right.isOrphanCandidate) {
                    return left.isOrphanCandidate ? 1 : -1;
                }
                return left.file.path.localeCompare(right.file.path);
            }));
    }

    private shouldSkipFile(file: TFile, settings: TPSControllerSettings): boolean {
        const normalizedPath = normalizePath(file.path).toLowerCase();
        if (normalizedPath.startsWith(".trash")) return true;
        if (this.isInDuplicateArchiveFolder(file.path, settings.archiveFolder)) return true;

        const archiveFolder = normalizePath((settings.archiveFolder || "").trim()).toLowerCase();
        if (archiveFolder && (normalizedPath === archiveFolder || normalizedPath.startsWith(`${archiveFolder}/`))) {
            return true;
        }

        return false;
    }

    private findStringCaseInsensitive(frontmatter: Record<string, any>, key: string): string {
        const normalizedKey = String(key || "").trim().toLowerCase();
        if (!normalizedKey) return "";
        for (const [candidateKey, value] of Object.entries(frontmatter || {})) {
            if (candidateKey.toLowerCase() !== normalizedKey) continue;
            const normalizedValue = String(value ?? "").trim();
            return normalizedValue;
        }
        return "";
    }

    private normalizeCalendarSourceUrl(value: unknown): string {
        return String(value ?? "").trim().replace(/\/+$/, "");
    }

    private stripFrontmatter(content: string): string {
        return String(content || "").replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n)?/, "");
    }

    private hasProtectedBodyContent(body: string): boolean {
        return String(body || "").replace(/\r\n/g, "\n").trim().length > 0;
    }

    private isOrphanCandidate(frontmatter: Record<string, any>): boolean {
        return Object.keys(frontmatter || {}).some(
            (key) => String(key).trim().toLowerCase() === "tpscalendarorphancandidateat",
        );
    }

    private getDuplicateArchiveFolder(archiveFolder: string): string {
        const base = normalizePath((archiveFolder || "System/Archive").trim());
        if (!base) return "System/Archive/Duplicates";
        if (base.toLowerCase().endsWith("/duplicates")) {
            return base;
        }
        return normalizePath(`${base}/Duplicates`);
    }

    private isInDuplicateArchiveFolder(filePath: string, archiveFolder: string): boolean {
        const normalizedPath = normalizePath(filePath).toLowerCase();
        const duplicateFolder = this.getDuplicateArchiveFolder(archiveFolder).toLowerCase();
        return normalizedPath === duplicateFolder || normalizedPath.startsWith(`${duplicateFolder}/`);
    }

    private async archiveDuplicate(file: TFile, preferredBaseName: string): Promise<boolean> {
        const dupFolder = this.getDuplicateArchiveFolder(this.getSettings().archiveFolder);
        try {
            await this.ensureFolderExists(dupFolder);
            const safeBase = preferredBaseName.replace(/[\\/:*?"<>|]/g, "").trim() || file.basename;

            let newPath = normalizePath(`${dupFolder}/${safeBase} duplicate.${file.extension}`);
            let counter = 1;
            while (this.app.vault.getAbstractFileByPath(newPath)) {
                if (this.app.vault.getAbstractFileByPath(newPath) === file) return true;
                newPath = normalizePath(`${dupFolder}/${safeBase} duplicate ${counter}.${file.extension}`);
                counter += 1;
            }

            await this.app.vault.rename(file, newPath);
            logger.warn(`[ExternalCalendarDuplicateCleanup] Archived duplicate ${file.path} -> ${newPath}`);
            return true;
        } catch (error) {
            logger.error(`[ExternalCalendarDuplicateCleanup] Failed to archive duplicate ${file.path}`, error);
            return false;
        }
    }

    private async ensureFolderExists(folderPath: string): Promise<void> {
        if (!folderPath || folderPath === "/") return;
        const normalizedPath = normalizePath(folderPath);
        const folder = this.app.vault.getAbstractFileByPath(normalizedPath);
        if (folder) return;

        const parent = normalizedPath.substring(0, normalizedPath.lastIndexOf("/"));
        if (parent) {
            await this.ensureFolderExists(parent);
        }

        try {
            await this.app.vault.createFolder(normalizedPath);
        } catch (error: any) {
            if (!(typeof error?.message === "string" && error.message.toLowerCase().includes("already exists"))) {
                throw error;
            }
        }
    }
}
