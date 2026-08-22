import type { App } from "obsidian";

/**
 * A late-enabled plugin can miss MetadataCache's one initial `resolved` event.
 * In that case, a complete non-empty Markdown cache snapshot is equivalent
 * evidence: Obsidian returns an empty CachedMetadata object even for an
 * indexed plain note with no frontmatter, links, or tasks.
 */
export function hasCompleteMarkdownMetadataSnapshot(
    app: Pick<App, "metadataCache" | "vault">,
): boolean {
    try {
        const files = app.vault.getMarkdownFiles();
        return files.length > 0
            && files.every((file) => app.metadataCache.getFileCache(file) !== null);
    } catch {
        return false;
    }
}
