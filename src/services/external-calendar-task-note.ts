import type { ExternalCalendarEvent } from "../types";

export type ExternalCalendarTaskNoteStrategy = "occurrence-day" | "series";

export interface ExternalCalendarTaskNoteLink {
    alias: string;
    linkTarget: string;
    markdown: string;
    notePath: string;
    occurrenceDay: string;
    seriesKey: string;
}

export function normalizeExternalCalendarTaskNoteStrategy(
    value: unknown,
): ExternalCalendarTaskNoteStrategy {
    return value === "series" ? "series" : "occurrence-day";
}

export function normalizeExternalCalendarTaskNoteFolder(value: unknown): string {
    const normalized = normalizePathValue(String(value || "Calendar Events").trim().replace(/^\/+|\/+$/gu, ""));
    if (!normalized || normalized === ".") return "Calendar Events";
    return normalized;
}

export function buildExternalCalendarTaskNoteLink(
    event: ExternalCalendarEvent,
    strategy: ExternalCalendarTaskNoteStrategy,
    rawFolder: unknown,
    existingPath?: string | null,
): ExternalCalendarTaskNoteLink {
    const alias = normalizeAlias(event.title) || "External calendar event";
    const occurrenceDay = formatLocalDay(event.startDate);
    const sourceUrl = normalizeCalendarUrlValue(event.sourceUrl || "");
    const uid = String(event.uid || extractUid(event.id) || event.id || "external-event").trim();
    const seriesKey = `${sourceUrl}#${uid}`;
    const identityKey = strategy === "series" ? seriesKey : `${seriesKey}#${occurrenceDay}`;
    const normalizedExisting = normalizeExistingPath(existingPath);
    const existing = strategy === "series"
        ? normalizedExisting
        : normalizedExisting?.split("/").includes(occurrenceDay)
            ? normalizedExisting
            : null;
    const notePath = existing || buildNotePath(rawFolder, strategy, occurrenceDay, identityKey);
    const linkTarget = notePath.replace(/\.md$/iu, "");
    return {
        alias,
        linkTarget,
        markdown: `[[${escapeWikiTarget(linkTarget)}|${escapeWikiAlias(alias)}]]`,
        notePath,
        occurrenceDay,
        seriesKey,
    };
}

function buildNotePath(
    rawFolder: unknown,
    strategy: ExternalCalendarTaskNoteStrategy,
    occurrenceDay: string,
    identityKey: string,
): string {
    const folder = normalizeExternalCalendarTaskNoteFolder(rawFolder);
    const subfolder = strategy === "series" ? "Series" : occurrenceDay;
    return normalizePathValue(`${folder}/${subfolder}/Calendar event--${stableHash(identityKey)}.md`);
}

function normalizeExistingPath(value: unknown): string | null {
    const normalized = normalizePathValue(String(value || "").trim().replace(/^\/+|\/+$/gu, ""));
    if (!normalized || normalized === ".") return null;
    return normalized.toLowerCase().endsWith(".md") ? normalized : `${normalized}.md`;
}

function normalizeAlias(value: unknown): string {
    return String(value || "").replace(/[\r\n]+/gu, " ").replace(/\s+/gu, " ").trim();
}

function escapeWikiTarget(value: string): string {
    return value.replace(/([#^|\]])/gu, "\\$1");
}

function escapeWikiAlias(value: string): string {
    return value.replace(/([|\]])/gu, "\\$1");
}

function formatLocalDay(date: Date): string {
    if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return "undated";
    return [
        String(date.getFullYear()).padStart(4, "0"),
        String(date.getMonth() + 1).padStart(2, "0"),
        String(date.getDate()).padStart(2, "0"),
    ].join("-");
}

function extractUid(id: unknown): string | null {
    const value = String(id || "");
    const match = value.match(/[-_](?:dup[-_])?(?:\d{8}T\d{6}|\d{13,})$/u);
    return match?.index && match.index > 0 ? value.slice(0, match.index) : null;
}

function stableHash(value: string): string {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
}

function normalizePathValue(value: string): string {
    return String(value || "")
        .replace(/\\/gu, "/")
        .replace(/\/{2,}/gu, "/")
        .replace(/^\/+|\/+$/gu, "");
}

function normalizeCalendarUrlValue(value: string): string {
    const trimmed = String(value || "").trim();
    if (trimmed.toLowerCase().startsWith("webcal://")) {
        return `https://${trimmed.slice("webcal://".length)}`;
    }
    return trimmed;
}
