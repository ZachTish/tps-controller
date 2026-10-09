import { App, TFile } from "obsidian";
import type { TPSControllerSettings } from "../types";
import { resolveInlineTaskReminderMode } from "./reminder-runtime-policy";

const TASK_LINE_PATTERN = /^\s*(?:[-*+]|\d+[.)])\s+\[[^\]]?]\s+/;
const INLINE_PROPERTY_PATTERN = /\[([^\[\]:]+)::\s*([^\]]+)\]/g;
const FENCED_CODE_BLOCK_PATTERN = /^\s*(```|~~~)/;

function hasReminderFrontmatter(frontmatter: Record<string, unknown> | undefined, reminderProperties: Set<string>): boolean {
    if (!frontmatter) return false;

    for (const key of Object.keys(frontmatter)) {
        if (reminderProperties.has(key.trim().toLowerCase())) return true;
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
    settings: TPSControllerSettings,
    reminderProperties: string[],
    options: { includeUnknownMetadata?: boolean; files?: readonly TFile[] } = {},
): Promise<{ files: TFile[] }> {
    const properties = reminderProperties.map((property) => String(property || "").trim()).filter(Boolean);
    if (!properties.length) return { files: [] };

    const propertySet = new Set(properties.map((property) => property.toLowerCase()));
    const includeInlineTasks = resolveInlineTaskReminderMode(app, settings) !== "none";
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
        if (includeInlineTasks && await hasReminderInlineTaskProperty(file, app, propertySet)) {
            files.push(file);
        }
    }

    return { files };
}
