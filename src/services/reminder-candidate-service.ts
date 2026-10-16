import { App, TFile } from "obsidian";
import type { TPSControllerSettings } from "../types";

function hasReminderFrontmatter(frontmatter: Record<string, unknown> | undefined, reminderProperties: Set<string>): boolean {
    if (!frontmatter) return false;

    for (const key of Object.keys(frontmatter)) {
        if (reminderProperties.has(key.trim().toLowerCase())) return true;
    }
    return false;
}

export async function getReminderCandidateFiles(
    app: App,
    _settings: TPSControllerSettings,
    reminderProperties: string[],
    options: { includeUnknownMetadata?: boolean; files?: readonly TFile[] } = {},
): Promise<{ files: TFile[] }> {
    const properties = reminderProperties.map((property) => String(property || "").trim()).filter(Boolean);
    if (!properties.length) return { files: [] };

    const propertySet = new Set(properties.map((property) => property.toLowerCase()));
    const files: TFile[] = [];
    const markdownFiles = [...(options.files ?? app.vault.getMarkdownFiles())]
        .sort((a, b) => a.path.localeCompare(b.path));

    for (const file of markdownFiles) {
        const cache = app.metadataCache.getFileCache(file);
        const frontmatter = cache?.frontmatter;
        const unknownMetadata = !cache || !frontmatter || typeof frontmatter !== "object"
            || Array.isArray(frontmatter) || ![Object.prototype, null].includes(Object.getPrototypeOf(frontmatter));
        if (options.includeUnknownMetadata && unknownMetadata) {
            files.push(file);
            continue;
        }
        if (hasReminderFrontmatter(frontmatter, propertySet)) {
            files.push(file);
            continue;
        }
    }

    return { files };
}
