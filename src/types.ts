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

export interface TwoStageArchiveRule {
    enabled: boolean;
    sourceFolder: string;
    destinationFolder: string;
    cadence: "daily" | "weekly" | "monthly-end";
    checkIntervalMinutes: number;
    weeklyDay: number;
    runTime: string;
    lastRunKey: string;
}

export interface S3agleAttachmentAutomationSettings {
    enabled: boolean;
    runOnActiveNoteOpen: boolean;
    runOnActiveNoteModify: boolean;
    runOnPaste: boolean;
    runAfterCommandIds: string[];
    debounceSeconds: number;
    cooldownMinutes: number;
    archiveUploadedSources: boolean;
    allowedAttachmentExtensions: string[];
    ignoredAttachmentExtensions: string[];
    makeUploadedObjectsPublic: boolean;
    accessKeySecretName: string;
    secretKeySecretName: string;
    region: string;
    bucket: string;
    folder: string;
    endpoint: string;
    useBucketSubdomain: boolean;
    contentUrl: string;
    hashFileName: boolean;
    hashSeed: number;
    archiveUnreferencedBucketObjects: boolean;
    bucketArchivePrefix: string;
    bucketArchiveCheckIntervalMinutes: number;
    bucketArchiveOrphanDelayMinutes: number;
    bucketArchiveLastRunAt: number;
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
    ignoreCheckboxStates?: string[];
    useSmartOffset?: boolean;
    smartOffsetProperty?: string;
    smartOffsetOperator?: "add" | "subtract";
    requiredStatuses?: string[];
    requiredCheckboxStates?: string[];
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
    twoStageArchive: TwoStageArchiveRule;
    s3agleAttachmentAutomation: S3agleAttachmentAutomationSettings;


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
    globalIgnoreCheckboxStates: string[];
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
    twoStageArchive: {
        enabled: false,
        sourceFolder: "Archive",
        destinationFolder: "_archive",
        cadence: "monthly-end",
        checkIntervalMinutes: 60,
        weeklyDay: 0,
        runTime: "23:55",
        lastRunKey: "",
    },
    s3agleAttachmentAutomation: {
        enabled: false,
        runOnActiveNoteOpen: true,
        runOnActiveNoteModify: true,
        runOnPaste: true,
        runAfterCommandIds: [],
        debounceSeconds: 10,
        cooldownMinutes: 10,
        archiveUploadedSources: true,
        allowedAttachmentExtensions: [],
        ignoredAttachmentExtensions: [],
        makeUploadedObjectsPublic: true,
        accessKeySecretName: "tps-controller-s3-access-key",
        secretKeySecretName: "tps-controller-s3-secret-key",
        region: "us-east-1",
        bucket: "",
        folder: "",
        endpoint: "",
        useBucketSubdomain: false,
        contentUrl: "",
        hashFileName: false,
        hashSeed: 0,
        archiveUnreferencedBucketObjects: false,
        bucketArchivePrefix: "_archive/s3/{YYYY}/{MM}/{DD}",
        bucketArchiveCheckIntervalMinutes: 60,
        bucketArchiveOrphanDelayMinutes: 60,
        bucketArchiveLastRunAt: 0,
    },


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
    globalIgnoreCheckboxStates: ["x", "-"],
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
