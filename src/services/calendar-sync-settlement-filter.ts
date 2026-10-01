const INTERNAL_ROOTS = new Set([".obsidian", ".tps", ".trash"]);

export function normalizeCalendarSyncSettlementPath(path: unknown): string {
    return String(path ?? "")
        .trim()
        .replace(/\\/g, "/")
        .replace(/^\/+/, "")
        .replace(/\/+/g, "/");
}

export function shouldDeferCalendarSyncSettlementForPath(path: unknown, reason = "", isFile = true): boolean {
    const normalized = normalizeCalendarSyncSettlementPath(path);
    if (!normalized) return false;

    const lowerPath = normalized.toLowerCase();
    if (lowerPath.includes(".tps-line-bases--")) return false;
    // A folder/asset modify does not change any calendar note identity or
    // metadata. It must not extend the startup settlement window indefinitely.
    if (reason === "file modify" && (!isFile || !lowerPath.endsWith(".md"))) return false;

    const root = lowerPath.split("/", 1)[0];
    if (INTERNAL_ROOTS.has(root)) return false;

    return true;
}
