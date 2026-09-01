import { moment, getAllTags, TFile } from 'obsidian';
import type { PropertyReminder } from '../types';
import { matchesExclusionPattern, matchesRequiredPath, normalizeComparablePath } from '../utils';

// ============================================================================
// Date/Time Parsing
// ============================================================================

function isDateOnlyMidnightValue(value: string): boolean {
    return /^\d{4}-\d{2}-\d{2}(?:[ T]00:00(?::00(?:\.000)?)?(?:Z|[+-]00:00)?)?$/.test(value);
}

const CANONICAL_ISO_TIMESTAMP_PATTERN =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

function parseCanonicalIsoTimestamp(value: string): number | null {
    if (!CANONICAL_ISO_TIMESTAMP_PATTERN.test(value)) return null;
    const parsed = moment(value, moment.ISO_8601, true);
    return parsed.isValid() ? parsed.valueOf() : null;
}

export function parseDate(input: any): number | null {
    if (!input) return null;
    let raw = Array.isArray(input) ? input[0] : input;
    if (!raw) return null;
    raw = String(raw).replace(/[\[\]]/g, '').trim();

    // Native records use canonical ISO-8601 instants. Parse those before the
    // permissive embedded-date path below can discard the `T` time and zone.
    const directCanonicalTimestamp = parseCanonicalIsoTimestamp(raw);
    if (directCanonicalTimestamp !== null) return directCanonicalTimestamp;

    // Handle property ranges - extract START only
    if (typeof raw === 'string') {
        let split = raw.split(/\s+[-–]\s+/);
        if (split.length > 1) {
            raw = split[0].trim();
        } else {
            const compactMatch = raw.match(/(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})/);
            if (compactMatch) {
                raw = compactMatch[1];
            }
        }

        // A range may contain a canonical timestamp as its first value.
        const rangeCanonicalTimestamp = parseCanonicalIsoTimestamp(raw);
        if (rangeCanonicalTimestamp !== null) return rangeCanonicalTimestamp;

        // Extract date from strings
        const dateTimeMatch = raw.match(/(\d{4}-\d{2}-\d{2})(?:\s+(\d{1,2}:\d{2}(?:\s*[AP]M?)?))?/i);
        if (dateTimeMatch) {
            raw = dateTimeMatch[0];
        }
    }

    if (typeof raw === 'string') {
        raw = raw.replace(/\b(\d{1,2}:\d{2})([AP]M?)\b/ig, '$1 $2');
    }

    const formats = [
        'YYYY-MM-DD HH:mm',
        'YYYY-MM-DD H:mm',
        'YYYY-MM-DD HH:mm A',
        'YYYY-MM-DD h:mm A',
        'YYYY-MM-DD HH:mma',
        'YYYY-MM-DD h:mma',
        'YYYY-MM-DDTHH:mm:ss',
        'YYYY-MM-DDTHH:mm',
        'YYYY-MM-DD',
        'HH:mm',
        'H:mm',
        'hh:mm A',
        'h:mm A',
        'hh:mma',
        'h:mma',
        moment.ISO_8601
    ];

    const m = moment(raw, formats, true);
    if (m.isValid()) {
        return m.valueOf();
    }

    if (/\d{4}[-\/]\d{1,2}[-\/]\d{1,2}/.test(raw) || /\d{1,2}:\d{2}/.test(raw)) {
        const originalSuppress = moment.suppressDeprecationWarnings;
        moment.suppressDeprecationWarnings = true;
        let fallback;
        try {
            fallback = moment(raw);
        } finally {
            moment.suppressDeprecationWarnings = originalSuppress;
        }
        return fallback.isValid() ? fallback.valueOf() : null;
    }

    return null;
}

export function parseTimeRange(input: any): { start: number | null, end: number | null } {
    if (!input) return { start: null, end: null };
    let raw = Array.isArray(input) ? input[0] : input;
    if (!raw) return { start: null, end: null };
    raw = String(raw).replace(/[\[\]]/g, '');

    let startRaw = raw;
    let endRaw = null;

    if (typeof raw === 'string') {
        const split = raw.split(/\s+[-–]\s+/);
        if (split.length > 1) {
            startRaw = split[0].trim();
            endRaw = split[split.length - 1].trim();
        } else {
            const compactMatch = raw.match(/\b(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})\b/);
            if (compactMatch) {
                endRaw = compactMatch[2];
            }
        }
    }

    const start = parseDate(startRaw);
    if (!start) return { start: null, end: null };

    let end = null;
    if (endRaw) {
        if (/^\d{1,2}:\d{2}(?:\s*[AP]M?)?$/i.test(endRaw)) {
            const normalizedEndRaw = endRaw.replace(/\b(\d{1,2}:\d{2})([AP]M?)\b/ig, '$1 $2');
            end = moment(start).set({
                hour: moment(normalizedEndRaw, ['H:mm', 'HH:mm', 'h:mm A', 'h:mma'], true).hour(),
                minute: moment(normalizedEndRaw, ['H:mm', 'HH:mm', 'h:mm A', 'h:mma'], true).minute()
            }).valueOf();

            if (end < start) {
                end = moment(end).add(1, 'day').valueOf();
            }
        } else {
            end = parseDate(endRaw);
        }
    }

    return { start, end };
}

// ============================================================================
// Duration Parsing
// ============================================================================

export function parseDuration(input: any): number {
    if (typeof input === 'number') return input; // Assume minutes
    if (!input) return 0;

    const str = String(input).trim().toLowerCase();

    const hoursMatch = str.match(/(\d+(?:\.\d+)?)h/);
    const minsMatch = str.match(/(\d+(?:\.\d+)?)m/);

    let minutes = 0;
    if (hoursMatch) minutes += parseFloat(hoursMatch[1]) * 60;
    if (minsMatch) minutes += parseFloat(minsMatch[1]);

    if (minutes > 0) return minutes;

    const num = parseFloat(str);
    if (!isNaN(num)) return num;

    return 0;
}

export function getEffectiveEndTime(propertyTime: number, rangeEndTime: number | null, fm: any): number | null {
    if (rangeEndTime) return rangeEndTime;

    // Prefer duration-like fields (duration, timeEstimate)
    const durationCandidates = [fm?.duration, fm?.timeEstimate];
    for (const candidate of durationCandidates) {
        const durationMins = parseDuration(candidate);
        if (durationMins > 0) {
            return propertyTime + (durationMins * 60 * 1000);
        }
    }

    // Fallback to explicit End/EndTime
    const endProp = fm?.end || fm?.endTime;
    if (endProp) {
        const parsedEnd = parseDate(endProp);
        if (parsedEnd) return parsedEnd;
        if (/^\d{1,2}:\d{2}(?:\s*[AP]M?)?$/i.test(endProp)) {
            const normalizedEndProp = String(endProp).replace(/\b(\d{1,2}:\d{2})([AP]M?)\b/ig, '$1 $2');
            let effectiveEndTime = moment(propertyTime).set({
                hour: moment(normalizedEndProp, ['H:mm', 'HH:mm', 'h:mm A', 'h:mma'], true).hour(),
                minute: moment(normalizedEndProp, ['H:mm', 'HH:mm', 'h:mm A', 'h:mma'], true).minute()
            }).valueOf();
            if (effectiveEndTime < propertyTime) {
                effectiveEndTime = moment(effectiveEndTime).add(1, 'day').valueOf();
            }
            return effectiveEndTime;
        }
    }

    if (String(fm?.allDay ?? '').toLowerCase() === 'true') {
        return propertyTime + (24 * 60 * 60 * 1000);
    }

    return null;
}

export function applyAllDayBaseTime(baseTime: number, allDayBaseTime?: string): number {
    if (!allDayBaseTime) return baseTime;
    const match = allDayBaseTime.match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return baseTime;

    return moment(baseTime).set({
        hour: parseInt(match[1], 10),
        minute: parseInt(match[2], 10),
        second: 0,
        millisecond: 0,
    }).valueOf();
}

export function getReminderTriggerBase(
    propertyTime: number,
    effectiveEndTime: number | null,
    isAllDay: boolean,
    triggerAtEnd: boolean | undefined,
    allDayBaseTime?: string,
): number | null {
    let baseTime = propertyTime;
    if (triggerAtEnd) {
        if (effectiveEndTime) {
            baseTime = effectiveEndTime;
        } else if (isAllDay) {
            baseTime = moment(propertyTime).add(1, 'day').valueOf();
        } else {
            return null;
        }
    }

    if (isAllDay && allDayBaseTime) {
        return applyAllDayBaseTime(baseTime, allDayBaseTime);
    }
    return baseTime;
}

// ============================================================================
// Formatting
// ============================================================================

export function formatTemplate(template: string, vars: Record<string, any>): string {
    let result = template;
    for (const key in vars) {
        result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), String(vars[key] ?? ''));
    }
    return result;
}

export function formatRemaining(ms: number): string {
    const absMs = Math.abs(ms);
    const minutes = Math.round(absMs / 60000);

    if (minutes < 60) {
        const label = minutes === 1 ? 'minute' : 'minutes';
        return ms >= 0 ? `in ${minutes} ${label}` : `${minutes} ${label} ago`;
    }

    const hours = Math.round(minutes / 60);
    const label = hours === 1 ? 'hour' : 'hours';
    return ms >= 0 ? `in ${hours} ${label}` : `${hours} ${label} ago`;
}

// ============================================================================
// Frontmatter Condition Checks
// ============================================================================

export function checkStopCondition(fm: any, condition: string): boolean {
    const parts = condition.split(':');
    if (parts.length < 2) return false;

    const key = parts[0].trim();
    const expectedValue = parts.slice(1).join(':').trim().toLowerCase();
    const actualValue = fm[key];

    if (actualValue === undefined || actualValue === null) return false;
    return String(actualValue).toLowerCase() === expectedValue;
}

export function normalizeStatus(value: unknown): string {
    return String(value ?? '').trim().toLowerCase();
}

export function getStatuses(fm: any): string[] {
    const rawStatus = fm?.status;
    if (Array.isArray(rawStatus)) {
        return rawStatus.map((s) => normalizeStatus(s)).filter(Boolean);
    }
    const single = normalizeStatus(rawStatus);
    return single ? [single] : [];
}

export function hasRequiredStatus(fm: any, reminder: PropertyReminder): boolean {
    if (!reminder.requiredStatuses || reminder.requiredStatuses.length === 0) return true;
    const required = reminder.requiredStatuses.map((s) => normalizeStatus(s)).filter(Boolean);
    if (required.length === 0) return true;
    const statuses = getStatuses(fm);
    return statuses.some((s) => required.includes(s));
}

export function normalizeCheckboxState(value: unknown): string {
    const raw = String(value ?? "").trim().toLowerCase();
    if (!raw || raw === "space" || raw === "blank" || raw === "empty" || raw === "open" || raw === "todo") {
        return " ";
    }
    if (raw === "complete" || raw === "completed" || raw === "done") return "x";
    if (raw === "working" || raw === "in-progress" || raw === "inprogress") return "/";
    if (raw === "holding" || raw === "hold" || raw === "waiting") return "?";
    if (raw === "wont-do" || raw === "wontdo" || raw === "cancelled" || raw === "canceled") return "-";
    if (raw === "migrated") return ">";
    return raw;
}

export function getCheckboxStates(fm: any): string[] {
    const candidates = [
        fm?.checkboxState,
        fm?.taskCheckboxState,
        fm?.checkbox,
        fm?.taskCheckbox,
    ];
    return [...new Set(candidates
        .filter((value) => value !== undefined && value !== null)
        .map((value) => normalizeCheckboxState(value))
        .filter((value) => value === " " || !!value))];
}

export function hasRequiredCheckboxState(fm: any, reminder: PropertyReminder): boolean {
    if (!reminder.requiredCheckboxStates || reminder.requiredCheckboxStates.length === 0) return true;
    const required = reminder.requiredCheckboxStates.map((s) => normalizeCheckboxState(s)).filter((s) => s === " " || !!s);
    if (required.length === 0) return true;
    const states = getCheckboxStates(fm);
    if (states.length === 0) return false;
    return states.some((s) => required.includes(s));
}

/**
 * Check if a file/reminder should be ignored based on per-reminder or global settings.
 * Pass the global fallback arrays from settings for when the reminder doesn't have its own.
 */
export function shouldIgnoreForReminder(
    file: Pick<TFile, "path" | "basename">,
    cache: any,
    fm: any,
    reminder: PropertyReminder,
    globalIgnorePaths: string[],
    globalIgnoreTags: string[],
    globalIgnoreStatuses: string[],
    globalIgnoreCheckboxStates: string[] = [],
    targetTags?: string[],
    canceledStatusValue?: unknown | unknown[],
): boolean {
    // Always merge global paths with per-reminder paths so global protections
    // (vault root, _ folders, etc.) apply even when a reminder overrides the list.
    const globalPaths = Array.isArray(globalIgnorePaths) ? globalIgnorePaths : [];
    const ignorePaths = Array.isArray(reminder.ignorePaths)
        ? [...new Set([...reminder.ignorePaths, ...globalPaths])]
        : globalPaths;
    const globalTags = Array.isArray(globalIgnoreTags) ? globalIgnoreTags : [];
    const ignoreTags = Array.isArray(reminder.ignoreTags)
        ? [...new Set([...reminder.ignoreTags, ...globalTags])]
        : globalTags;
    const globalStatuses = Array.isArray(globalIgnoreStatuses) ? globalIgnoreStatuses : [];
    const ignoreStatuses = Array.isArray(reminder.ignoreStatuses)
        ? [...new Set([...reminder.ignoreStatuses, ...globalStatuses])]
        : globalStatuses;
    const globalCheckboxStates = Array.isArray(globalIgnoreCheckboxStates) ? globalIgnoreCheckboxStates : [];
    const ignoreCheckboxStates = Array.isArray(reminder.ignoreCheckboxStates)
        ? [...new Set([...reminder.ignoreCheckboxStates, ...globalCheckboxStates])]
        : globalCheckboxStates;

    const normPath = normalizeComparablePath(file.path);
    const normBase = normalizeComparablePath(file.basename);

    if (ignorePaths.some(p => p && matchesExclusionPattern(normPath, normBase, p))) {
        return true;
    }

    // Required paths: if specified, file must be inside at least one of these folders.
    const requiredPaths = Array.isArray(reminder.requiredPaths) ? reminder.requiredPaths.filter(Boolean) : [];
    if (requiredPaths.length > 0 && !requiredPaths.some(p => matchesRequiredPath(file.path, p))) {
        return true;
    }

    const statuses = new Set<string>(getStatuses(fm));
    const checkboxStates = new Set<string>(getCheckboxStates(fm));
    if (statuses.has("migrated") || checkboxStates.has(">")) {
        return true;
    }
    // A configured cancellation status is terminal for every reminder
    // surface. Treat it as an implicit global ignore so custom and
    // recommended rules cannot accidentally notify for cancelled calendar
    // records merely because their own ignore/stop lists omit that value.
    const cancellationStatuses = Array.isArray(canceledStatusValue)
        ? canceledStatusValue
        : [canceledStatusValue];
    const normalizedIgnoreStatuses = [...ignoreStatuses, ...cancellationStatuses]
        .map(s => normalizeStatus(s))
        .filter(Boolean);
    if (normalizedIgnoreStatuses.some(s => statuses.has(s))) {
        return true;
    }

    const normalizedIgnoreCheckboxStates = ignoreCheckboxStates
        .map(s => normalizeCheckboxState(s))
        .filter(s => s === " " || !!s);
    if (normalizedIgnoreCheckboxStates.some(s => checkboxStates.has(s))) {
        return true;
    }

    const tags = targetTags !== undefined
        ? targetTags
        : ((cache ? getAllTags(cache) : []) || []);
    const hasIgnoredTag = tags.some(tag => {
        const pureTag = tag.replace('#', '').toLowerCase();
        return ignoreTags.some(ignored => {
            const cleanIgnored = String(ignored).toLowerCase().replace('#', '').trim();
            if (!cleanIgnored) return false;
            return pureTag === cleanIgnored || pureTag.startsWith(cleanIgnored + '/');
        });
    });
    if (hasIgnoredTag) {
        return true;
    }

    return false;
}

/** Resolve only this native record's current and historically applied cancellation labels. */
export function getReminderCancellationStatuses(
    frontmatter: Record<string, unknown> | null | undefined,
    configuredStatus: unknown,
    cancellationState: unknown,
): unknown[] {
    const statuses: unknown[] = [String(configuredStatus ?? "").trim() || "cancelled"];
    if (!frontmatter || !cancellationState || typeof cancellationState !== "object" || Array.isArray(cancellationState)) {
        return statuses;
    }
    const idKey = Object.keys(frontmatter).find((key) => key.trim().toLocaleLowerCase() === "tpsid");
    const id = idKey ? String(frontmatter[idKey] || "").trim() : "";
    if (!id) return statuses;
    const stateKey = Object.keys(cancellationState as Record<string, unknown>)
        .find((key) => key.trim().toLocaleLowerCase() === id.toLocaleLowerCase());
    if (!stateKey) return statuses;
    const entry = (cancellationState as Record<string, unknown>)[stateKey];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return statuses;
    const appliedStatus = (entry as Record<string, unknown>).appliedStatus;
    if (typeof appliedStatus === "string" && appliedStatus) statuses.push(appliedStatus);
    return statuses;
}

// ============================================================================
// All-Day Detection
// ============================================================================

/**
 * Returns true if a reminder property value represents an all-day event.
 *
 * An event is treated as all-day if EITHER:
 *   1. The note has `allDay: true` in its frontmatter, OR
 *   2. The raw property value is a date-only string with no time component (YYYY-MM-DD).
 *
 * This ensures reminders with an `allDayBaseTime` are anchored to that time
 * instead of defaulting to midnight (00:00), which would fire them immediately.
 */
export function isAllDayEvent(rawPropertyValue: any, fm: any): boolean {
    // 1. Explicit frontmatter flag
    const allDayFm = fm['allDay'];
    if (allDayFm === true || String(allDayFm ?? '').toLowerCase() === 'true') {
        return true;
    }
    if (String(allDayFm ?? '').toLowerCase() === 'false') {
        return false;
    }

    // 2. Date-only property value: matches YYYY-MM-DD exactly (no time, no T, no offset)
    if (!rawPropertyValue) return false;
    const raw = String(Array.isArray(rawPropertyValue) ? rawPropertyValue[0] : rawPropertyValue)
        .replace(/[\[\]]/g, '')
        .trim();
    // Obsidian stores date-only properties as midnight strings in metadata.
    // Treat those as all-day unless the note explicitly opts out with allDay: false.
    return isDateOnlyMidnightValue(raw);
}

/**
 * Returns true if the raw property value contains an explicit time component (HH:mm or h:mm AM/PM).
 * Handles arrays (picks first element) and strips Obsidian link brackets.
 */
export function hasExplicitTimeInValue(rawValue: unknown): boolean {
    const raw = Array.isArray(rawValue) ? rawValue[0] : rawValue;
    const value = String(raw ?? '').replace(/[\[\]]/g, '').trim();
    if (!value) return false;
    if (isDateOnlyMidnightValue(value)) return false;
    if (/[T ]\d{1,2}:\d{2}/.test(value)) return true;
    if (/\b\d{1,2}:\d{2}\s*(AM|PM)\b/i.test(value)) return true;
    return false;
}
