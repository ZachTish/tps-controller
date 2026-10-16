import { App, normalizePath, moment } from "obsidian";
import type { TPSControllerSettings, TwoStageArchiveRule } from "../types";
import * as logger from "../logger";

export interface TwoStageArchiveResult {
    movedCount: number;
    skippedCount: number;
    runKey: string;
    sourceFolder: string;
    destinationFolder: string;
}

export class TwoStageArchiveService {
    constructor(
        private readonly app: App,
        private readonly getSettings: () => TPSControllerSettings,
        private readonly saveSettings: () => Promise<void>,
    ) {}

    async runNow(
        nowMs = Date.now(),
    ): Promise<TwoStageArchiveResult> {
        const rule = this.getRule();
        const runKey = this.getRunKey(rule, nowMs);
        const sourceFolder = rule.sourceFolder;
        const destinationFolder = rule.destinationFolder;
        logger.flow("TwoStageArchive", "run:resolved", {
            runKey,
            sourceFolder,
            destinationFolder,
            cadence: rule.cadence,
            lastRunKey: rule.lastRunKey || "",
        });

        if (!sourceFolder || !destinationFolder || sourceFolder === destinationFolder) {
            logger.flowWarn("TwoStageArchive", "run:invalid-folders", { sourceFolder, destinationFolder, runKey });
            return { movedCount: 0, skippedCount: 0, runKey, sourceFolder, destinationFolder };
        }

        await this.ensureFolderExists(destinationFolder);

        let movedCount = 0;
        let skippedCount = 0;
        let destinationSkipCount = 0;
        const sourcePrefix = `${sourceFolder}/`;
        const destinationPrefix = `${destinationFolder}/`;
        const files = this.app.vault.getFiles()
            .filter((file) => {
                const filePath = normalizePath(file.path);
                if (!filePath.startsWith(sourcePrefix)) return false;
                if (filePath.startsWith(destinationPrefix)) {
                    destinationSkipCount += 1;
                    return false;
                }
                return true;
            })
            .sort((left, right) => left.path.localeCompare(right.path));

        if (destinationSkipCount > 0) {
            skippedCount += destinationSkipCount;
            logger.flow("TwoStageArchive", "run:destination-skip", { destinationSkipCount, destinationFolder });
        }
        logger.flow("TwoStageArchive", "run:candidates", {
            files: files.length,
            destinationSkipCount,
            sourceFolder,
            destinationFolder,
        });

        for (const file of files) {
            const relativePath = file.path.slice(sourceFolder.length + 1);
            if (!relativePath || relativePath.startsWith("../")) {
                skippedCount += 1;
                logger.flowWarn("TwoStageArchive", "file:invalid-relative-path", { path: file.path, relativePath });
                continue;
            }


            const targetPath = await this.getAvailableTargetPath(
                normalizePath(`${destinationFolder}/${relativePath}`),
            );
            await this.ensureFolderExists(targetPath.substring(0, targetPath.lastIndexOf("/")));

            try {
                await this.app.vault.rename(file, targetPath);
                movedCount += 1;
            } catch (error) {
                skippedCount += 1;
                logger.flowError("TwoStageArchive", "file:move-failed", error, { path: file.path, targetPath });
            }
        }

        rule.lastRunKey = runKey;
        await this.saveSettings();
        logger.flow("TwoStageArchive", "run:done", {
            movedCount,
            skippedCount,
            runKey,
            sourceFolder,
            destinationFolder,
        });
        return { movedCount, skippedCount, runKey, sourceFolder, destinationFolder };
    }

    getRunKey(rule: TwoStageArchiveRule, nowMs = Date.now()): string {
        const now = moment(nowMs);
        if (rule.cadence === "daily") return now.format("YYYY-MM-DD");
        if (rule.cadence === "weekly") return now.format("GGGG-[W]WW");
        return now.format("YYYY-MM");
    }

    private getRule(): TwoStageArchiveRule {
        const settings = this.getSettings();
        settings.twoStageArchive = this.normalizeRule(settings.twoStageArchive);
        return settings.twoStageArchive;
    }

    private normalizeRule(rule: Partial<TwoStageArchiveRule> | undefined): TwoStageArchiveRule {
        return {
            enabled: rule?.enabled === true,
            sourceFolder: this.normalizeFolder(rule?.sourceFolder || "Archive"),
            destinationFolder: this.normalizeFolder(rule?.destinationFolder || "_archive"),
            cadence: rule?.cadence === "daily" || rule?.cadence === "weekly" || rule?.cadence === "monthly-end"
                ? rule.cadence
                : "monthly-end",
            checkIntervalMinutes: Math.max(1, Number(rule?.checkIntervalMinutes || 60)),
            weeklyDay: this.normalizeWeeklyDay(rule?.weeklyDay),
            runTime: this.normalizeRunTime(rule?.runTime || "23:55"),
            lastRunKey: String(rule?.lastRunKey || ""),
        };
    }

    private normalizeFolder(value: string): string {
        return normalizePath(String(value || "").trim().replace(/^\/+|\/+$/g, ""));
    }

    private async getAvailableTargetPath(targetPath: string): Promise<string> {
        const extension = targetPath.includes(".") ? targetPath.slice(targetPath.lastIndexOf(".")) : "";
        const withoutExtension = extension ? targetPath.slice(0, -extension.length) : targetPath;
        let candidate = targetPath;
        let counter = 1;
        while (this.app.vault.getAbstractFileByPath(candidate)) {
            candidate = `${withoutExtension} ${counter}${extension}`;
            counter += 1;
        }
        if (candidate !== targetPath) {
            logger.flow("TwoStageArchive", "target:collision-resolved", { targetPath, candidate });
        }
        return candidate;
    }

    private async ensureFolderExists(folderPath: string): Promise<void> {
        if (!folderPath) return;
        const normalizedPath = this.normalizeFolder(folderPath);
        if (!normalizedPath) return;
        if (this.app.vault.getAbstractFileByPath(normalizedPath)) return;

        const parent = normalizedPath.substring(0, normalizedPath.lastIndexOf("/"));
        if (parent) await this.ensureFolderExists(parent);

        try {
            await this.app.vault.createFolder(normalizedPath);
        } catch (error: any) {
            if (!(typeof error?.message === "string" && error.message.toLowerCase().includes("already exists"))) {
                throw error;
            }
        }
    }

    private normalizeWeeklyDay(value: unknown): number {
        const day = Number(value);
        return Number.isInteger(day) && day >= 0 && day <= 6 ? day : 0;
    }

    private normalizeRunTime(value: string): string {
        const [hour, minute] = this.parseRunTime(value);
        return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    }

    private parseRunTime(value: string): [number, number] {
        const match = String(value || "").trim().match(/^(\d{1,2}):(\d{2})$/);
        if (!match) return [23, 55];
        const hour = Math.min(23, Math.max(0, Number(match[1])));
        const minute = Math.min(59, Math.max(0, Number(match[2])));
        return [hour, minute];
    }
}
