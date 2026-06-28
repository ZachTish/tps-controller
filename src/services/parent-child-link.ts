import { App, TFile, normalizePath } from "obsidian";
import * as logger from "../logger";
import { mergeTagInputs, parseTagInput } from "../utils/tag-utils";
import { getPluginSettings, getPluginById } from "../core";

/**
 * Tracks in-progress frontmatter operations to prevent race conditions
 * Key format: "filePath" -> Promise of the operation
 */
const pendingOperations = new Map<string, Promise<void>>();

type ParentLinkFormat = "wikilink" | "markdown-title";

function getGlobalContextMenuSettings(app: App): Record<string, any> {
    // Try both legacy plugin ID and current (Dev) folder name
    const plugin = getPluginById(app, 'tps-global-context-menu')
                || getPluginById(app, 'TPS-Global-Context-Menu (Dev)');
    return (plugin as any)?.settings || {};
}

function getParentLinkFormat(app: App): ParentLinkFormat {
    const format = getGlobalContextMenuSettings(app)?.parentLinkFormat;
    return format === "markdown-title" ? "markdown-title" : "wikilink";
}

function getParentTagOnChildLink(app: App): string[] {
    const raw = getGlobalContextMenuSettings(app)?.parentTagOnChildLink;
    return parseTagInput(raw);
}

function normalizeFrontmatterKey(key: string): string {
    return String(key || "").trim().toLowerCase();
}

function findFrontmatterKeyCaseInsensitive(target: Record<string, any>, key: string): string | null {
    const normalized = normalizeFrontmatterKey(key);
    if (!normalized) return null;
    const direct = Object.keys(target || {}).find((candidate) => normalizeFrontmatterKey(candidate) === normalized);
    return direct ?? null;
}

function getFrontmatterValueCaseInsensitive(target: Record<string, any>, key: string): any {
    const existing = findFrontmatterKeyCaseInsensitive(target, key);
    return existing ? target[existing] : undefined;
}

function setFrontmatterValueCaseInsensitive(target: Record<string, any>, key: string, value: any): void {
    const normalized = normalizeFrontmatterKey(key);
    if (!normalized) return;
    for (const candidate of Object.keys(target || {})) {
        if (normalizeFrontmatterKey(candidate) === normalized) {
            delete target[candidate];
        }
    }
    target[key] = value;
}

function deleteFrontmatterValueCaseInsensitive(target: Record<string, any>, key: string): void {
    const normalized = normalizeFrontmatterKey(key);
    if (!normalized) return;
    for (const candidate of Object.keys(target || {})) {
        if (normalizeFrontmatterKey(candidate) === normalized) {
            delete target[candidate];
        }
    }
}

function resolveDisplayNameForTarget(app: App, targetFile: TFile): string {
    const cache = app.metadataCache.getFileCache(targetFile);
    const frontmatter = (cache?.frontmatter || {}) as Record<string, any>;
    const rawTitle = getFrontmatterValueCaseInsensitive(frontmatter, "title");
    const preferred =
        typeof rawTitle === "string" && rawTitle.trim()
            ? rawTitle.trim()
            : targetFile.basename;
    const cleaned = preferred
        .replace(/\r?\n/g, " ")
        .replace(/[|[\]]/g, "")
        .trim();
    return cleaned || targetFile.basename;
}

function resolveLinkTargetForSource(app: App, targetFile: TFile, sourcePath: string): string {
    const generated = app.fileManager.generateMarkdownLink(
        targetFile,
        sourcePath,
        undefined,
        targetFile.basename,
    );
    const candidate = extractLinkTarget(generated)
        ?? app.metadataCache.fileToLinktext(targetFile, sourcePath, true)
        ?? targetFile.path;
    return normalizeLinkTarget(candidate) ?? normalizeLinkTarget(targetFile.path) ?? targetFile.path;
}

function buildLink(app: App, sourcePath: string, targetFile: TFile): string {
    const displayName = resolveDisplayNameForTarget(app, targetFile);
    const target = resolveLinkTargetForSource(app, targetFile, sourcePath);

    if (getParentLinkFormat(app) === "wikilink") {
        return `[[${target}|${displayName}]]`;
    }

    return `[${displayName}](${encodeLinkTarget(target)})`;
}

function extractLinkTarget(value: any): string | null {
    if (value === null || value === undefined) return null;
    const raw = String(value).trim();
    if (!raw) return null;

    const markdownMatch = raw.match(/^!?\[[^\]]*]\(([^)]+)\)$/);
    if (markdownMatch) {
        return normalizeLinkTarget(markdownMatch[1]);
    }
    const wikiMatch = raw.match(/^!?\[\[([^[\]]+)]]$/);
    if (wikiMatch) {
        return normalizeLinkTarget(wikiMatch[1]);
    }
    return normalizeLinkTarget(raw);
}

function normalizeLinkTarget(rawTarget: string): string | null {
    let target = String(rawTarget || "").trim();
    if (!target) return null;
    if (target.startsWith("<") && target.endsWith(">")) {
        target = target.slice(1, -1).trim();
    }
    if (target.includes("|")) {
        target = target.split("|")[0].trim();
    }
    if (target.includes("#")) {
        target = target.split("#")[0].trim();
    }
    target = target.replace(/^\.\/+/, "").trim();
    if (!target) return null;
    try {
        target = decodeURI(target);
    } catch {
        // keep original
    }
    return target || null;
}

function encodeLinkTarget(target: string): string {
    const trimmed = String(target || "").trim();
    if (!trimmed) return trimmed;
    let decoded = trimmed;
    try {
        decoded = decodeURI(trimmed);
    } catch {
        decoded = trimmed;
    }
    return encodeURI(decoded);
}

function resolveLinkToFile(app: App, value: any, sourcePath: string): TFile | null {
    const target = extractLinkTarget(value);
    if (!target) return null;

    const noMd = target.replace(/\.md$/i, "");
    const viaCache =
        app.metadataCache.getFirstLinkpathDest(target, sourcePath)
        || app.metadataCache.getFirstLinkpathDest(noMd, sourcePath);
    if (viaCache instanceof TFile) return viaCache;

    const normalized = normalizePath(target);
    const direct = app.vault.getAbstractFileByPath(normalized);
    if (direct instanceof TFile) return direct;

    const withMd = normalized.endsWith(".md") ? normalized : `${normalized}.md`;
    const directMd = app.vault.getAbstractFileByPath(withMd);
    if (directMd instanceof TFile) return directMd;
    return null;
}

function linkReferencesFile(app: App, value: any, sourcePath: string, target: TFile): boolean {
    const resolved = resolveLinkToFile(app, value, sourcePath);
    return resolved ? resolved.path === target.path : false;
}

function extractLinkTargetBasename(value: any): string | null {
    const target = extractLinkTarget(value);
    if (!target) return null;
    const normalized = normalizePath(target);
    const segment = normalized.split("/").pop() || normalized;
    const basename = segment.replace(/\.md$/i, "").trim();
    return basename || null;
}

function applyParentTagsToFrontmatter(fm: Record<string, any>, tagsToAdd: string[]): boolean {
    if (!tagsToAdd.length) return false;
    const existingRaw = getFrontmatterValueCaseInsensitive(fm, "tags");
    const existingTags = parseTagInput(existingRaw);
    const mergedTags = mergeTagInputs(existingRaw, tagsToAdd);
    const unchanged =
        existingTags.length === mergedTags.length
        && existingTags.every((tag, index) => tag === mergedTags[index]);
    if (unchanged) return false;
    setFrontmatterValueCaseInsensitive(fm, "tags", mergedTags);
    return true;
}

/**
 * Waits for any pending operation on the file, then executes the new operation
 * This prevents race conditions when multiple operations target the same file
 */
async function withFileLock(filePath: string, operation: () => Promise<void>): Promise<void> {
    const existing = pendingOperations.get(filePath);
    if (existing) {
        await existing.catch(() => {
            // Ignore errors from previous operations, we'll retry
        });
    }

    const promise = operation();
    pendingOperations.set(filePath, promise);

    try {
        await promise;
    } finally {
        if (pendingOperations.get(filePath) === promise) {
            pendingOperations.delete(filePath);
        }
    }
}

/**
 * Creates a bidirectional link between a child note (calendar event) and a parent note
 * @param app Obsidian app instance
 * @param childFile The child note file (calendar event)
 * @param parentFile The parent note file
 * @param parentLinkKey Frontmatter key in child pointing to parent
 * @param childLinkKey Frontmatter key in parent listing children
 */
export async function createBidirectionalLink(
    app: App,
    childFile: TFile,
    parentFile: TFile,
    parentLinkKey: string,
    childLinkKey: string
): Promise<void> {
    try {
        const parentKey = String(parentLinkKey || "childOf").trim() || "childOf";
        const childKey = String(childLinkKey || "parentOf").trim() || "parentOf";
        const tagsToAdd = getParentTagOnChildLink(app);

        await withFileLock(childFile.path, async () => {
            await app.fileManager.processFrontMatter(childFile, (fm) => {
                const parentLink = buildLink(app, childFile.path, parentFile);
                setFrontmatterValueCaseInsensitive(fm, parentKey, parentLink);
                setFrontmatterValueCaseInsensitive(fm, "folderPath", childFile.parent?.path || "/");
                logger.log(`[ParentChildLink] Added parent link to ${childFile.path}: ${parentKey} = ${parentLink}`);
            });
        });

        await withFileLock(parentFile.path, async () => {
            await app.fileManager.processFrontMatter(parentFile, (fm) => {
                const childLink = buildLink(app, parentFile.path, childFile);
                const existingRaw = getFrontmatterValueCaseInsensitive(fm, childKey);
                let children: string[] = [];
                if (Array.isArray(existingRaw)) {
                    children = existingRaw.map(String);
                } else if (typeof existingRaw === "string" && existingRaw.trim()) {
                    children = [existingRaw];
                }

                if (!children.some((existing) => linkReferencesFile(app, existing, parentFile.path, childFile))) {
                    children.push(childLink);
                    setFrontmatterValueCaseInsensitive(fm, childKey, children);
                    logger.log(`[ParentChildLink] Added child link to ${parentFile.path}: ${childKey} now has ${children.length} items`);
                } else {
                    logger.log(`[ParentChildLink] Child link already exists in ${parentFile.path}`);
                }

                if (applyParentTagsToFrontmatter(fm, tagsToAdd)) {
                    logger.log(`[ParentChildLink] Tagged parent note with ${tagsToAdd.map((tag) => `#${tag}`).join(", ")}`);
                }
            });
        });

        logger.log(`[ParentChildLink] ✓ Bidirectional link created: ${childFile.basename} ↔ ${parentFile.basename}`);
    } catch (error) {
        logger.error(`[ParentChildLink] Failed to create bidirectional link:`, error);
        throw error;
    }
}

/**
 * Removes a bidirectional link between a child note and a parent note
 * @param app Obsidian app instance
 * @param childFile The child note file
 * @param parentFile The parent note file
 * @param parentLinkKey Frontmatter key in child pointing to parent
 * @param childLinkKey Frontmatter key in parent listing children
 */
export async function removeBidirectionalLink(
    app: App,
    childFile: TFile,
    parentFile: TFile,
    parentLinkKey: string,
    childLinkKey: string
): Promise<void> {
    try {
        await withFileLock(childFile.path, async () => {
            await app.fileManager.processFrontMatter(childFile, (fm) => {
                const parentValue = getFrontmatterValueCaseInsensitive(fm, parentLinkKey);
                if (parentValue === undefined) return;
                deleteFrontmatterValueCaseInsensitive(fm, parentLinkKey);
                logger.log(`[ParentChildLink] Removed parent link from ${childFile.path}`);
            });
        });

        await withFileLock(parentFile.path, async () => {
            await app.fileManager.processFrontMatter(parentFile, (fm) => {
                const existingRaw = getFrontmatterValueCaseInsensitive(fm, childLinkKey);
                if (Array.isArray(existingRaw)) {
                    const filtered = existingRaw.filter((link: any) => !linkReferencesFile(app, link, parentFile.path, childFile));
                    if (filtered.length > 0) {
                        setFrontmatterValueCaseInsensitive(fm, childLinkKey, filtered);
                    } else {
                        deleteFrontmatterValueCaseInsensitive(fm, childLinkKey);
                    }
                    logger.log(`[ParentChildLink] Removed child link from ${parentFile.path}`);
                    return;
                }

                if (linkReferencesFile(app, existingRaw, parentFile.path, childFile)) {
                    deleteFrontmatterValueCaseInsensitive(fm, childLinkKey);
                    logger.log(`[ParentChildLink] Removed child link from ${parentFile.path}`);
                }
            });
        });

        logger.log(`[ParentChildLink] ✓ Bidirectional link removed: ${childFile.basename} ↔ ${parentFile.basename}`);
    } catch (error) {
        logger.error(`[ParentChildLink] Failed to remove bidirectional link:`, error);
        throw error;
    }
}

/**
 * Removes a child link from a parent note (used when child note is deleted)
 * @param app Obsidian app instance
 * @param childBasename The basename of the child note (without extension)
 * @param parentFile The parent note file
 * @param childLinkKey Frontmatter key in parent listing children
 */
export async function removeChildLinkFromParent(
    app: App,
    childBasename: string,
    parentFile: TFile,
    childLinkKey: string
): Promise<void> {
    try {
        await withFileLock(parentFile.path, async () => {
            await app.fileManager.processFrontMatter(parentFile, (fm) => {
                const existingRaw = getFrontmatterValueCaseInsensitive(fm, childLinkKey);
                if (Array.isArray(existingRaw)) {
                    const filtered = existingRaw.filter((link: any) => {
                        const linkBasename = extractLinkTargetBasename(link);
                        return !linkBasename || linkBasename.toLowerCase() !== childBasename.toLowerCase();
                    });
                    if (filtered.length !== existingRaw.length) {
                        if (filtered.length > 0) {
                            setFrontmatterValueCaseInsensitive(fm, childLinkKey, filtered);
                        } else {
                            deleteFrontmatterValueCaseInsensitive(fm, childLinkKey);
                        }
                        logger.log(`[ParentChildLink] Removed detached child link '${childBasename}' from ${parentFile.path}`);
                    }
                    return;
                }

                const linkBasename = extractLinkTargetBasename(existingRaw);
                if (!linkBasename || linkBasename.toLowerCase() !== childBasename.toLowerCase()) return;
                deleteFrontmatterValueCaseInsensitive(fm, childLinkKey);
                logger.log(`[ParentChildLink] Removed detached child link '${childBasename}' from ${parentFile.path}`);
            });
        });
    } catch (error) {
        logger.error(`[ParentChildLink] Failed to remove child link from parent:`, error);
        throw error;
    }
}
