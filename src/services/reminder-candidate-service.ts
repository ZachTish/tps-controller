import { App, TFile } from "obsidian";
import type { TPSControllerSettings } from "../types";

const TASK_LINE_PATTERN = /^\s*(?:[-*+]|\d+[.)])\s+\[[^\]]?]\s+/;
const INLINE_PROPERTY_PATTERN = /\[([^\[\]:]+)::\s*([^\]]+)\]/g;
const FENCED_CODE_BLOCK_PATTERN = /^\s*(```|~~~)/;

function hasReminderFrontmatter(file: TFile, app: App, reminderProperties: Set<string>): boolean {
    const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
    if (!frontmatter) return false;

    const keys = new Set(Object.keys(frontmatter).map((key) => key.trim().toLowerCase()));
    for (const property of reminderProperties) {
        if (keys.has(property)) return true;
    }
    return false;
}

async function hasReminderInlineTaskProperty(file: TFile, app: App, reminderProperties: Set<string>): Promise<boolean> {
    let content = "";
    try {
        content = await app.vault.cachedRead(file);
    } catch {
        return false;
    }

    let inFencedCodeBlock = false;
    for (const line of content.split(/\r?\n/)) {
        if (FENCED_CODE_BLOCK_PATTERN.test(line)) {
            inFencedCodeBlock = !inFencedCodeBlock;
            continue;
        }
        if (inFencedCodeBlock) continue;
        if (!TASK_LINE_PATTERN.test(line)) continue;

        INLINE_PROPERTY_PATTERN.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = INLINE_PROPERTY_PATTERN.exec(line)) !== null) {
            const key = String(match[1] || "").trim().toLowerCase();
            if (key && reminderProperties.has(key)) return true;
        }
    }
    return false;
}

export async function getReminderCandidateFiles(
    app: App,
    _settings: TPSControllerSettings,
    reminderProperties: string[],
): Promise<{ files: TFile[] }> {
    const properties = reminderProperties.map((property) => String(property || "").trim()).filter(Boolean);
    if (!properties.length) return { files: [] };

    const propertySet = new Set(properties.map((property) => property.toLowerCase()));
    const files: TFile[] = [];
    const markdownFiles = app.vault
        .getMarkdownFiles()
        .sort((a, b) => a.path.localeCompare(b.path));

    for (const file of markdownFiles) {
        if (hasReminderFrontmatter(file, app, propertySet)) {
            files.push(file);
            continue;
        }
        if (await hasReminderInlineTaskProperty(file, app, propertySet)) {
            files.push(file);
        }
    }

    return { files };
}
