import { TFile } from "obsidian";

// ============================================================================
// Device Role (Existing)
// ============================================================================

export type DeviceRole = "controller" | "user";

// ============================================================================
// Calendar Sync Types (Moved from Calendar-Base)
// ============================================================================

export interface ExternalCalendarEvent {
    id: string;
    uid: string;
    title: string;
    description: string;
    startDate: Date;
    endDate: Date;
    sourceUrl?: string;
    location?: string;
    organizer?: string;
    attendees?: string[];
    isAllDay: boolean;
    url?: string;
    isCancelled?: boolean;
}

export interface ExternalCalendarConfig {
    id: string;
    url: string;
    color?: string;
    enabled?: boolean;
    autoCreateEnabled?: boolean;
    autoCreateMode?: "note" | "task";
    autoCreateTaskDestination?: "daily-note" | "event-note";
    autoCreateTaskTargetPath?: string;
    autoCreateTypeFolder?: string;
    autoCreateFolder?: string;
    autoCreateTag?: string;
    autoCreateTemplate?: string;
}



// ============================================================================
// Notification Types (Moved from Notifier)
// ============================================================================

export interface PropertyReminder {
    id: string;
    label?: string;
    property: string;
    enabled: boolean;
    offsetMinutes: number;
    mode?: "task" | "timeblock";
    repeatUntilComplete: boolean;
    repeatIntervalMinutes: number;
    maxRepeats: number;
    stopConditions: string[];
    title: string;
    body: string;
    ignorePaths?: string[];
    ignoreTags?: string[];
    ignoreStatuses?: string[];
    useSmartOffset?: boolean;
    smartOffsetProperty?: string;
    smartOffsetOperator?: "add" | "subtract";
    requiredStatuses?: string[];
    requiredPaths?: string[];
    allDayFilter?: "any" | "true" | "false";
    allDayBaseTime?: string;
    triggerAtEnd?: boolean;
    includeUnmatchedExternalEvents?: boolean;
    sourceTypes?: ("file" | "external-event")[];
    repeatEndAt?: "stop-condition" | "trigger-base";
}

export interface AlertState {
    [filePath: string]: {
        [reminderId: string]: {
            triggered: boolean;
            repeatCount: number;
            lastSent?: number;
            lastTriggerKey?: string;
        };
    };
}

export interface OverdueItem {
    file: TFile;
    reminder: PropertyReminder;
    propertyTime: number;
    diff: string;
    id: string;
    sourceKey?: string;
    sourceType?: "file" | "external-event";
    targetKind?: "note" | "task" | "external-event";
    taskTitle?: string;
    taskRawLine?: string;
    taskLine?: number;
    reminderProperty?: string;
    reminderPropertySource?: "task" | "note" | "external-event";
    noteTitle?: string;
    title?: string;
    body?: string;
    snoozedUntil?: number;
    isAllDay?: boolean;
    status?: string;
    icon?: string;
    color?: string;
    nextTriggerTime?: number;
    nextRuleLabel?: string;
    isRepeating?: boolean;
    nextReminderIntervalMinutes?: number;
}

// ============================================================================
// Controller Settings
// ============================================================================

export interface TPSControllerSettings {
    // Calendar Sync
    syncIntervalMinutes: number;
    noLossSyncMode: boolean;
    syncOnEventDelete: "delete" | "archive" | "nothing";
    archiveFolder: string;
    canceledStatusValue: string;
    externalCalendarFilter: string;
    externalCalendars: ExternalCalendarConfig[];


    // Frontmatter Key Names (shared with Calendar for sync)
    eventIdKey: string;
    uidKey: string;
    titleKey: string;
    statusKey: string;
    previousStatusKey: string;
    startProperty: string;
    endProperty: string;

    // Notification Rules
    pollMinutes: number;
    enableReminders: boolean;
    enableTimeTrackingHourlyReminders: boolean;
    reminders: PropertyReminder[];
    alertState: AlertState;
    batchNotifications: boolean;
    globalIgnorePaths: string[];
    globalIgnoreTags: string[];
    globalIgnoreStatuses: string[];
    snoozeProperty: string;
    snoozeOptions: { label: string; minutes: number }[];
    notificationSortDirection: "asc" | "desc";
    /** Fallback base time (HH:MM) used for all-day events when no per-reminder allDayBaseTime is set. */
    defaultAllDayBaseTime: string;
    // Debug
    enableLogging: boolean;

    // Migration flag
    _migratedFromPlugins: boolean;
}

export const DEFAULT_CONTROLLER_SETTINGS: TPSControllerSettings = {
    // Calendar Sync
    syncIntervalMinutes: 5,
    noLossSyncMode: true,
    syncOnEventDelete: "nothing",
    archiveFolder: "",
    canceledStatusValue: "cancelled",
    externalCalendarFilter: "",
    externalCalendars: [],


    // Frontmatter Keys
    eventIdKey: "externalEventId",
    uidKey: "tpsCalendarUid",
    titleKey: "title",
    statusKey: "status",
    previousStatusKey: "tpsCalendarPrevStatus",
    startProperty: "scheduled",
    endProperty: "timeEstimate",

    // Notification Rules
    pollMinutes: 0.5,
    enableReminders: true,
    enableTimeTrackingHourlyReminders: true,
    reminders: [],
    alertState: {},
    batchNotifications: true,
    globalIgnorePaths: ["System/"],
    globalIgnoreTags: ["archive", "template"],
    globalIgnoreStatuses: ["complete", "wont-do"],
    snoozeProperty: "reminderSnooze",
    notificationSortDirection: "asc",
    defaultAllDayBaseTime: "09:00",
    snoozeOptions: [
        { label: '15 Minutes', minutes: 15 },
        { label: '1 Hour', minutes: 60 },
        { label: '4 Hours', minutes: 240 },
        { label: '1 Day', minutes: 1440 },
    ],

    // Debug
    enableLogging: false,

    // Migration
    _migratedFromPlugins: false,
};
