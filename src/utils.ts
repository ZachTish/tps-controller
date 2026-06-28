/**
 * Utility functions needed by auto-create-service.
 * Subset of Calendar-Base's utils.ts, containing only what the Controller needs.
 */

export function formatDateTimeForFrontmatter(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    const seconds = String(date.getSeconds()).padStart(2, "0");
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

/**
 * Parse a frontmatter date string ("YYYY-MM-DD HH:mm:ss") deterministically
 * as LOCAL time. This avoids `new Date(string)` which is engine-dependent
 * (some engines treat space-separated dates as UTC, others as local).
 *
 * Returns null if the string doesn't match the expected format.
 */
export function parseFrontmatterDate(value: string): Date | null {
    if (!value || typeof value !== 'string') return null;
    const trimmed = value.trim();

    // Match "YYYY-MM-DD HH:mm:ss" or "YYYY-MM-DD HH:mm" or "YYYY-MM-DD"
    const match = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?$/);
    if (!match) {
        // Fallback for other date formats (ISO, etc.)
        const fallback = new Date(trimmed);
        return Number.isFinite(fallback.getTime()) ? fallback : null;
    }

    const y = parseInt(match[1], 10);
    const m = parseInt(match[2], 10) - 1; // JS months are 0-indexed
    const d = parseInt(match[3], 10);
    const h = match[4] ? parseInt(match[4], 10) : 0;
    const min = match[5] ? parseInt(match[5], 10) : 0;
    const s = match[6] ? parseInt(match[6], 10) : 0;

    const date = new Date(y, m, d, h, min, s);
    return Number.isFinite(date.getTime()) ? date : null;
}

export const normalizeCalendarUrl = (url: string | null | undefined): string => {
    if (!url) return "";
    const trimmed = url.trim();
    if (!trimmed) return "";
    if (trimmed.toLowerCase().startsWith("webcal://")) {
        return `https://${trimmed.slice("webcal://".length)}`;
    }
    return trimmed;
};

export const normalizeCalendarTag = (tag: string | null | undefined): string => {
    const raw = typeof tag === "string" ? tag.trim() : "";
    if (!raw) return "";
    return raw.replace(/^#+/, "").trim().toLowerCase();
};

export function normalizeComparablePath(value: string | undefined | null): string {
    if (!value || typeof value !== 'string') return '';
    return value.trim()
        .replace(/^\/+/, '')
        .replace(/\/+$/, '')
        .toLowerCase();
}

export function matchesWildcard(pattern: string, value: string): boolean {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`^${escaped.replace(/\*/g, '.*')}$`, 'i');
    return regex.test(value);
}

export function matchesExclusionPattern(
    normalizedPath: string,
    normalizedBasename: string,
    rawPattern: string
): boolean {
    const pattern = String(rawPattern || '').trim();
    if (!pattern) return false;

    const asLower = pattern.toLowerCase();

    if (asLower.startsWith('re:')) {
        const source = pattern.slice(3).trim();
        if (!source) return false;
        try {
            const regex = new RegExp(source, 'i');
            return regex.test(normalizedPath) || regex.test(normalizedBasename);
        } catch {
            return false;
        }
    }

    if (asLower.startsWith('name:')) {
        const target = String(pattern.slice(5) || '').trim().toLowerCase();
        if (!target) return false;
        return matchesWildcard(target, normalizedBasename);
    }

    const pathTarget = asLower.startsWith('path:')
        ? pattern.slice(5).trim()
        : pattern;
    const hasTrailingSlash = /[\/\\]$/.test(pathTarget);
    const normalizedTarget = normalizeComparablePath(pathTarget);
    if (!normalizedTarget) return false;

    if (normalizedTarget.includes('*')) {
        // Prepend '/' so patterns like '*/Folder/*' also match vault-root paths
        // where normalizedPath has no leading slash (e.g. 'archive/file.md').
        const slashedPath = '/' + normalizedPath;
        return matchesWildcard(normalizedTarget, slashedPath) || matchesWildcard(normalizedTarget, normalizedBasename);
    }

    if (hasTrailingSlash) {
        return normalizedPath === normalizedTarget || normalizedPath.startsWith(`${normalizedTarget}/`);
    }

    if (normalizedPath === normalizedTarget || normalizedPath.startsWith(`${normalizedTarget}/`)) {
        return true;
    }

    return normalizedBasename === normalizedTarget;
}

/**
 * Returns true if `filePath` is inside `requiredFolder`.
 * Comparison is normalised and case-insensitive, so a value like "Action Items"
 * correctly matches "Markdown/Action Items/Sub/file.md" regardless of any
 * leading vault folders in the actual path.
 */
export function matchesRequiredPath(filePath: string, requiredFolder: string): boolean {
    const normFile = normalizeComparablePath(filePath);
    const normFolder = normalizeComparablePath(requiredFolder);
    if (!normFolder) return false;
    return (
        normFile === normFolder ||
        normFile.startsWith(`${normFolder}/`) ||
        normFile.includes(`/${normFolder}/`)
    );
}
