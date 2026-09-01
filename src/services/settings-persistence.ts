import type {
    ExternalCalendarConfig,
    NativeCalendarCancellationState,
    TPSControllerSettings,
} from "../types";
import {
    normalizeExternalCalendarTaskNoteFolder,
    normalizeExternalCalendarTaskNoteStrategy,
} from "./external-calendar-task-note";
import { parseCalendarRecordId } from "./calendar-record-identity";
import { normalizeCalendarUrl } from "../utils";

type SettingsRecord = Record<string, unknown>;

const hasOwn = (record: SettingsRecord, key: string): boolean =>
    Object.prototype.hasOwnProperty.call(record, key);

const cloneSettingValue = <T>(value: T): T => {
    if (value === undefined || value === null) return value;
    return JSON.parse(JSON.stringify(value)) as T;
};

export function countExternalCalendarsMissingId(value: unknown): number {
    if (!Array.isArray(value)) return 0;
    return value.filter((candidate) => {
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return true;
        return !String((candidate as SettingsRecord).id || "").trim();
    }).length;
}

/** Keep only durable, well-formed Controller cancellation ownership entries. */
export function normalizeNativeCalendarCancellationState(
    value: unknown,
): Record<string, NativeCalendarCancellationState> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const normalized: Record<string, NativeCalendarCancellationState> = {};
    const claimedIds = new Set<string>();
    for (const [rawId, candidate] of Object.entries(value as SettingsRecord)) {
        const id = rawId.trim();
        const identityKey = id.toLocaleLowerCase();
        if (!parseCalendarRecordId(id)
            || claimedIds.has(identityKey)
            || !candidate
            || typeof candidate !== "object"
            || Array.isArray(candidate)) continue;
        const entry = candidate as SettingsRecord;
        const appliedStatus = typeof entry.appliedStatus === "string" ? entry.appliedStatus : "";
        if (!appliedStatus) continue;
        const previousStatus = entry.previousStatus === null || typeof entry.previousStatus === "string"
            ? entry.previousStatus
            : null;
        normalized[id] = {
            appliedStatus,
            previousStatusPresent: entry.previousStatusPresent === true,
            previousStatus,
            canRestore: entry.canRestore === true,
            pendingApplication: entry.pendingApplication === true,
        };
        claimedIds.add(identityKey);
    }
    return normalized;
}

/** Reproduce Controller's pre-canonical-ID fallback so existing records migrate. */
export function legacyCalendarConfigIdForUrl(value: unknown): string {
    const normalizedUrl = normalizeCalendarUrl(String(value || ""));
    return normalizedUrl ? `calendar-${legacyCalendarHash(normalizedUrl)}` : "";
}

/**
 * Normalize legacy calendar fields without replacing the array or valid calendar
 * objects. Settings controls retain these references while the panel is open.
 */
export function normalizeExternalCalendarsInPlace(
    value: unknown,
    normalizeTaskTargetPath: (value: string) => string,
): ExternalCalendarConfig[] {
    if (!Array.isArray(value)) return [];

    const claimedIds = new Set(value
        .map((candidate) => candidate && typeof candidate === "object" && !Array.isArray(candidate)
            ? String((candidate as SettingsRecord).id || "").trim()
            : "")
        .filter(Boolean));

    value.forEach((candidate, index) => {
        const calendar = candidate && typeof candidate === "object" && !Array.isArray(candidate)
            ? candidate as ExternalCalendarConfig & SettingsRecord
            : {} as ExternalCalendarConfig & SettingsRecord;
        if (calendar !== candidate) value[index] = calendar;

        const existingId = String(calendar.id || "").trim();
        if (existingId) {
            calendar.id = existingId;
        } else {
            const historicalId = legacyCalendarConfigIdForUrl(calendar.url);
            const base = historicalId || `calendar-legacy-${stableSettingsHexHash(`empty\u0000${index}`)}`;
            let id = base;
            let suffix = 2;
            while (claimedIds.has(id)) id = `${base}-${suffix++}`;
            calendar.id = id;
            claimedIds.add(id);
        }

        const rawModeValue = (calendar as SettingsRecord).autoCreateMode;
        const rawMode = typeof rawModeValue === "string" ? rawModeValue : "";
        const legacyMode = rawMode === "task-list" || rawMode === "kanban-board";
        const taskTarget = typeof calendar.autoCreateTaskTargetPath === "string"
            ? normalizeTaskTargetPath(calendar.autoCreateTaskTargetPath)
            : "";

        delete calendar.autoCreateTaskListPath;
        delete calendar.autoCreateTaskListHeading;
        delete calendar.autoCreateKanbanRemoteDeletedLane;
        delete calendar.autoCreateKanbanCancelledLane;

        calendar.autoCreateMode = rawMode === "task" ? "task" : "note";
        calendar.autoCreateTaskDestination = calendar.autoCreateTaskDestination === "event-note"
            ? "event-note"
            : "daily-note";
        calendar.autoCreateTaskTargetPath = taskTarget;
        calendar.autoCreateTaskNoteStrategy = normalizeExternalCalendarTaskNoteStrategy(
            calendar.autoCreateTaskNoteStrategy,
        );
        calendar.autoCreateTaskNoteFolder = normalizeExternalCalendarTaskNoteFolder(
            calendar.autoCreateTaskNoteFolder,
        );
        if (legacyMode) calendar.autoCreateEnabled = false;
    });

    return value as ExternalCalendarConfig[];
}

function legacyCalendarHash(value: string): string {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
        hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
    }
    return (hash >>> 0).toString(36);
}

function stableSettingsHexHash(value: string): string {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Copy legacy plugin settings only when the Controller data file never contained
 * the corresponding key. Explicit false, empty strings, and empty arrays win.
 */
export function fillMissingLegacyPluginSettings(
    settings: TPSControllerSettings,
    rawControllerSettings: SettingsRecord,
    notifierSettings: SettingsRecord | null | undefined,
    calendarSettings: SettingsRecord | null | undefined,
): number {
    let migrated = 0;

    const copyMissing = (key: keyof TPSControllerSettings, value: unknown, accepts: boolean): void => {
        if (!accepts || hasOwn(rawControllerSettings, String(key))) return;
        (settings as unknown as SettingsRecord)[String(key)] = cloneSettingValue(value);
        migrated += 1;
    };

    if (notifierSettings) {
        copyMissing("reminders", notifierSettings.reminders, Array.isArray(notifierSettings.reminders));
        copyMissing("pollMinutes", notifierSettings.pollMinutes, typeof notifierSettings.pollMinutes === "number");
        copyMissing("alertState", notifierSettings.alertState, !!notifierSettings.alertState && typeof notifierSettings.alertState === "object");
        copyMissing("batchNotifications", notifierSettings.batchNotifications, typeof notifierSettings.batchNotifications === "boolean");
        copyMissing("snoozeProperty", notifierSettings.snoozeProperty, typeof notifierSettings.snoozeProperty === "string");
        copyMissing("globalIgnorePaths", notifierSettings.ignorePaths, Array.isArray(notifierSettings.ignorePaths));
        copyMissing("globalIgnoreTags", notifierSettings.ignoreTags, Array.isArray(notifierSettings.ignoreTags));
        copyMissing("globalIgnoreStatuses", notifierSettings.ignoreStatuses, Array.isArray(notifierSettings.ignoreStatuses));
        copyMissing("enableLogging", notifierSettings.enableLogging, typeof notifierSettings.enableLogging === "boolean");
    }

    if (calendarSettings) {
        copyMissing("syncIntervalMinutes", calendarSettings.syncIntervalMinutes, typeof calendarSettings.syncIntervalMinutes === "number");
        copyMissing("syncOnEventDelete", calendarSettings.syncOnEventDelete, typeof calendarSettings.syncOnEventDelete === "string");
        copyMissing("archiveFolder", calendarSettings.archiveFolder, typeof calendarSettings.archiveFolder === "string");
        copyMissing("externalCalendarFilter", calendarSettings.externalCalendarFilter, typeof calendarSettings.externalCalendarFilter === "string");
        copyMissing("startProperty", calendarSettings.startProperty, typeof calendarSettings.startProperty === "string");
        copyMissing("endProperty", calendarSettings.endProperty, typeof calendarSettings.endProperty === "string");
        copyMissing("eventIdKey", calendarSettings.eventIdKey, typeof calendarSettings.eventIdKey === "string");
        copyMissing("uidKey", calendarSettings.uidKey, typeof calendarSettings.uidKey === "string");
        copyMissing("titleKey", calendarSettings.titleKey, typeof calendarSettings.titleKey === "string");
        copyMissing("statusKey", calendarSettings.statusKey, typeof calendarSettings.statusKey === "string");
        copyMissing("previousStatusKey", calendarSettings.previousStatusKey, typeof calendarSettings.previousStatusKey === "string");
        copyMissing("canceledStatusValue", calendarSettings.canceledStatusValue, typeof calendarSettings.canceledStatusValue === "string");
        copyMissing(
            "externalCalendars",
            calendarSettings.externalCalendars,
            Array.isArray(calendarSettings.externalCalendars) && calendarSettings.externalCalendars.length > 0,
        );
    }

    return migrated;
}

export function requireSettingsRecord(value: unknown): SettingsRecord {
    if (value == null) return {};
    if (typeof value === "object" && !Array.isArray(value)) return value as SettingsRecord;
    throw new Error("TPS Controller settings data must be an object.");
}

/** Apply only locally changed top-level fields to the newest data.json payload. */
export function mergeSettingsChangeSet(
    latest: unknown,
    local: SettingsRecord,
    changedKeys: readonly string[],
): SettingsRecord {
    const merged: SettingsRecord = { ...requireSettingsRecord(latest) };
    for (const key of changedKeys) {
        if (hasOwn(local, key)) merged[key] = cloneSettingValue(local[key]);
        else delete merged[key];
    }
    return merged;
}

/** Serializes snapshots and makes every requester await its save or a newer one. */
export class CoalescedSettingsSaveQueue<T> {
    private activePromise: Promise<void> | null = null;
    private saveRequested = false;

    constructor(
        private readonly capture: () => T,
        private readonly persist: (snapshot: T) => Promise<void>,
        private readonly afterDrain?: () => void | Promise<void>,
    ) {}

    requestSave(): Promise<void> {
        this.saveRequested = true;
        if (!this.activePromise) this.startDrain();
        return this.activePromise!;
    }

    async waitForIdle(): Promise<void> {
        while (this.activePromise) {
            await this.activePromise;
        }
    }

    private async drain(): Promise<void> {
        try {
            while (true) {
                do {
                    this.saveRequested = false;
                    try {
                        await this.persist(this.capture());
                    } catch (error) {
                        // A newer requested snapshot is allowed to supersede a failed
                        // in-flight write. Without one, every waiter observes failure.
                        if (!this.saveRequested) throw error;
                    }
                } while (this.saveRequested);

                await this.afterDrain?.();
                if (!this.saveRequested) return;
            }
        } finally {
            this.activePromise = null;
        }
    }

    private startDrain(): void {
        // Install the field before drain() can settle. drain() clears it
        // synchronously, so a completion-window request starts a fresh drain.
        this.activePromise = Promise.resolve().then(() => this.drain());
    }
}
