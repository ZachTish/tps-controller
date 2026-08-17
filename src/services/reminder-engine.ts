/**
 * ReminderEngine - Extracted from TPS-Notifier's runReminders() logic.
 * Evaluates reminder rules against vault files and produces notification payloads.
 * Does NOT send notifications directly — the Controller calls the Notifier's API for dispatch.
 */
import { App, TFile, moment, normalizePath } from "obsidian";
import * as logger from "../logger";
import type { ExternalCalendarEvent, PropertyReminder, TPSControllerSettings } from "../types";
import { normalizeCalendarUrl, parseFrontmatterDate } from "../utils";
import {
    parseDate, parseTimeRange, parseDuration, getEffectiveEndTime,
    formatTemplate, formatRemaining, checkStopCondition,
    normalizeStatus, getStatuses, hasRequiredStatus, hasRequiredCheckboxState, shouldIgnoreForReminder,
    isAllDayEvent, hasExplicitTimeInValue, getReminderTriggerBase,
} from "../utils/time-calculation-service";
import {
    buildReminderTargetsForFile,
    buildEffectiveReminderContextForTarget,
    buildReminderDisplayName,
    type ReminderEvaluationTarget,
} from "./reminder-target-service";
import { ExternalCalendarService } from "./external-calendar-service";
import { getReminderCandidateFiles as discoverReminderCandidateFiles } from "./reminder-candidate-service";
import {
    getFileReminderLiveWindowMs,
    shouldSkipStaleOneShotReminder,
} from "./reminder-delivery-window";

export interface PendingNotification {
    title: string;
    body: string;
    file?: TFile;
    isAllDay: boolean;
    reminderId: string;
    sourceKey?: string;
    sourceType?: "file" | "external-event";
}

export interface ReminderRunResult {
    notifications: PendingNotification[];
    stateChanged: boolean;
}

export interface ScheduledNativeNotification {
    title: string;
    body: string;
    fireAt: number;
    sourcePath?: string;
    reminderId: string;
    sourceKey: string;
}

interface ReminderFileLike {
    path: string;
    basename: string;
}

interface LocalEventMatchIndex {
    eventIds: Set<string>;
    uidStartKeys: Set<string>;
    titleDayKeys: Set<string>;
    terminalTitleKeys: Set<string>;
}

interface ReminderEvaluationStats {
    candidateFiles: number;
    activeFiles: number;
    archivedFiles: number;
    activeRules: number;
    filesProcessed: number;
    fileErrors: number;
    targetsBuilt: number;
    targetsEvaluated: number;
    suppressedNoteRows: number;
    externalUrls: number;
    externalEventsFetched: number;
    externalHidden: number;
    externalMatchedLocal: number;
    externalDuplicate: number;
    externalTargets: number;
    externalFetchErrors: number;
    notificationsQueued: number;
    skipReasons: Record<string, number>;
}

export class ReminderEngine {
    private app: App;
    private externalCalendarService: ExternalCalendarService;

    constructor(app: App, externalCalendarService: ExternalCalendarService) {
        this.app = app;
        this.externalCalendarService = externalCalendarService;
    }

    async evaluateReminders(settings: TPSControllerSettings): Promise<ReminderRunResult> {
        const now = Date.now();
        const alertState = settings.alertState;
        let stateChanged = false;
        const pendingNotifications: PendingNotification[] = [];

        const files = await this.getReminderCandidateFiles(settings);
        const activeFiles = files.filter((file) => !this.isArchivedFile(file, settings.archiveFolder));
        const activeRules = settings.reminders.filter((r) => r.enabled).length;
        const needsExternalEvents = settings.reminders.some(
            (reminder) => reminder.enabled && this.reminderIncludesSource(reminder, "external-event"),
        );
        const stats: ReminderEvaluationStats = {
            candidateFiles: files.length,
            activeFiles: activeFiles.length,
            archivedFiles: files.length - activeFiles.length,
            activeRules,
            filesProcessed: 0,
            fileErrors: 0,
            targetsBuilt: 0,
            targetsEvaluated: 0,
            suppressedNoteRows: 0,
            externalUrls: 0,
            externalEventsFetched: 0,
            externalHidden: 0,
            externalMatchedLocal: 0,
            externalDuplicate: 0,
            externalTargets: 0,
            externalFetchErrors: 0,
            notificationsQueued: 0,
            skipReasons: {},
        };

        if (settings.enableLogging) {
            logger.flow("ReminderEngine", "scan:start", {
                candidateFiles: stats.candidateFiles,
                activeFiles: stats.activeFiles,
                archivedFiles: stats.archivedFiles,
                activeRules: stats.activeRules,
                includeExternalEvents: needsExternalEvents,
            });
        }

        for (const file of activeFiles) {
            try {
                stats.filesProcessed++;
                const cache = this.app.metadataCache.getFileCache(file);
                const fm = (cache?.frontmatter || {}) as Record<string, unknown>;
                const targets = await buildReminderTargetsForFile(this.app, file, fm, settings);
                stats.targetsBuilt += targets.length;
                const fileNotifications: PendingNotification[] = [];

                for (const target of targets) {
                    const result = this.evaluateTarget({
                        target,
                        fileRef: file,
                        cache,
                        baseFrontmatter: fm,
                        settings,
                        now,
                        alertState,
                        stats,
                    });
                    fileNotifications.push(...result.notifications);
                    stateChanged = stateChanged || result.stateChanged;
                }
                const suppression = this.suppressNoteNotificationsBackedByTaskNotifications(fileNotifications, alertState);
                stats.suppressedNoteRows += Math.max(0, fileNotifications.length - suppression.notifications.length);
                pendingNotifications.push(...suppression.notifications);
                stateChanged = stateChanged || suppression.stateChanged;
            } catch (err) {
                stats.fileErrors++;
                logger.flowError("ReminderEngine", "file:error", err, { path: file.path });
            }
        }

        if (needsExternalEvents) {
            const externalTargets = await this.buildUnmatchedExternalReminderTargets(files, settings, stats);
            stats.externalTargets = externalTargets.length;
            for (const target of externalTargets) {
                const event = target.externalEvent;
                if (!event) continue;
                const syntheticFile = this.buildSyntheticExternalFile(event);
                const result = this.evaluateTarget({
                    target,
                    fileRef: syntheticFile,
                    cache: null,
                    baseFrontmatter: {},
                    settings,
                    now,
                    alertState,
                    reminderFilter: (reminder) => this.reminderIncludesSource(reminder, "external-event"),
                    stats,
                });
                pendingNotifications.push(...result.notifications);
                stateChanged = stateChanged || result.stateChanged;
            }
        }

        if (settings.enableLogging) {
            stats.notificationsQueued = pendingNotifications.length;
            logger.flow("ReminderEngine", "scan:done", {
                ...stats,
                stateChanged,
                skipReasons: this.summarizeSkipReasons(stats.skipReasons),
            });
        }

        return { notifications: pendingNotifications, stateChanged };
    }

    /**
     * Builds a read-only future schedule from the same Controller reminder
     * rules used by evaluateReminders(). It never mutates alert state and does
     * not depend on a Base view. The signed TishOS publisher applies the final
     * wire bounds and stable identifiers.
     */
    async projectScheduledNotifications(
        settings: TPSControllerSettings,
        now = Date.now(),
        horizonMs = 60 * 24 * 60 * 60 * 1000,
    ): Promise<ScheduledNativeNotification[]> {
        if (!settings.enableReminders || horizonMs <= 0) return [];
        const horizonEnd = now + horizonMs;
        const projected: ScheduledNativeNotification[] = [];
        const files = await this.getReminderCandidateFiles(settings);
        const activeFiles = files.filter((file) => !this.isArchivedFile(file, settings.archiveFolder));

        for (const file of activeFiles) {
            try {
                const cache = this.app.metadataCache.getFileCache(file);
                const frontmatter = (cache?.frontmatter || {}) as Record<string, unknown>;
                const targets = await buildReminderTargetsForFile(this.app, file, frontmatter, settings);
                for (const target of targets) {
                    projected.push(...this.projectTarget({
                        target,
                        fileRef: file,
                        cache,
                        baseFrontmatter: frontmatter,
                        settings,
                        now,
                        horizonEnd,
                    }));
                }
            } catch (error) {
                logger.flowError("ReminderEngine", "native-projection:file-error", error, { path: file.path });
            }
        }

        const needsExternalEvents = settings.reminders.some(
            (reminder) => reminder.enabled && this.reminderIncludesSource(reminder, "external-event"),
        );
        if (needsExternalEvents) {
            const targets = await this.buildUnmatchedExternalReminderTargets(files, settings);
            for (const target of targets) {
                const event = target.externalEvent;
                if (!event) continue;
                projected.push(...this.projectTarget({
                    target,
                    fileRef: this.buildSyntheticExternalFile(event),
                    cache: null,
                    baseFrontmatter: {},
                    settings,
                    now,
                    horizonEnd,
                    reminderFilter: (reminder) => this.reminderIncludesSource(reminder, "external-event"),
                }));
            }
        }

        const unique = new Map<string, ScheduledNativeNotification>();
        for (const item of projected) {
            const key = `${item.sourceKey}\u0000${item.reminderId}\u0000${item.fireAt}`;
            if (!unique.has(key)) unique.set(key, item);
        }
        return [...unique.values()].sort((left, right) =>
            left.fireAt - right.fireAt
            || left.sourceKey.localeCompare(right.sourceKey)
            || left.reminderId.localeCompare(right.reminderId),
        );
    }

    private projectTarget(params: {
        target: ReminderEvaluationTarget;
        fileRef: ReminderFileLike;
        cache: unknown;
        baseFrontmatter: Record<string, unknown>;
        settings: TPSControllerSettings;
        now: number;
        horizonEnd: number;
        reminderFilter?: (reminder: PropertyReminder) => boolean;
    }): ScheduledNativeNotification[] {
        const { target, fileRef, cache, baseFrontmatter, settings, now, horizonEnd, reminderFilter } = params;
        const items: ScheduledNativeNotification[] = [];
        const sourceState = settings.alertState[target.sourceKey] || {};

        for (const reminder of settings.reminders) {
            if (!reminder.enabled) continue;
            if (reminderFilter && !reminderFilter(reminder)) continue;
            if (!this.reminderIncludesSource(reminder, target.sourceType)) continue;
            const ctx = buildEffectiveReminderContextForTarget(target, baseFrontmatter, reminder.property, settings);
            if (!ctx) continue;
            const effectiveFm = ctx.frontmatter;
            const propValue = ctx.propertyValue;
            if (shouldIgnoreForReminder(
                fileRef,
                cache,
                effectiveFm,
                reminder,
                settings.globalIgnorePaths,
                settings.globalIgnoreTags,
                settings.globalIgnoreStatuses,
                settings.globalIgnoreCheckboxStates,
                target.reminderTags,
            )) continue;
            const { start: propTime, end: rangeEndTime } = parseTimeRange(propValue);
            if (!propTime || !hasRequiredStatus(effectiveFm, reminder) || !hasRequiredCheckboxState(effectiveFm, reminder)) {
                continue;
            }
            const normalizedPropValue = this.normalizeReminderPropertyValue(propValue);
            const hasExplicitTime = hasExplicitTimeInValue(propValue);
            const isAllDaySafe = isAllDayEvent(propValue, effectiveFm)
                && (!hasExplicitTime || String(effectiveFm?.allDay ?? "").toLowerCase() === "true");
            const effectiveEndTime = getEffectiveEndTime(propTime, rangeEndTime, effectiveFm);
            if (reminder.mode === "timeblock" && !reminder.triggerAtEnd && effectiveEndTime && now > effectiveEndTime) {
                continue;
            }
            const finalTriggerBase = getReminderTriggerBase(
                propTime,
                effectiveEndTime,
                isAllDaySafe,
                reminder.triggerAtEnd,
                reminder.allDayBaseTime || settings.defaultAllDayBaseTime,
            );
            if (!finalTriggerBase) continue;

            let offsetMs = reminder.offsetMinutes * 60 * 1000;
            if (reminder.useSmartOffset && reminder.smartOffsetProperty) {
                const durationMins = parseDuration(effectiveFm[reminder.smartOffsetProperty]);
                if (durationMins > 0) {
                    const smartMs = durationMins * 60 * 1000;
                    offsetMs = reminder.smartOffsetOperator === "subtract" ? -smartMs : smartMs;
                }
            }
            const triggerTime = finalTriggerBase + offsetMs;
            const baseTriggerKey = this.buildTriggerKey(triggerTime, isAllDaySafe, hasExplicitTime, normalizedPropValue);
            const state = sourceState[reminder.id];
            if (state?.lastTriggerKey && state.lastTriggerKey !== baseTriggerKey && state.triggered) {
                // The property changed after the stored delivery. Treat the new
                // trigger as unsent without mutating Controller state.
            }
            if (reminder.allDayFilter === "true" && !isAllDaySafe) continue;
            if (reminder.allDayFilter === "false" && isAllDaySafe) continue;
            if (effectiveEndTime) {
                const isWorking = getStatuses(effectiveFm).includes("working");
                const requiresWorking = reminder.requiredStatuses?.some((status) => normalizeStatus(status) === "working");
                if (isWorking && now < effectiveEndTime && !requiresWorking) continue;
            }
            if (reminder.stopConditions.some((condition) => checkStopCondition(effectiveFm, condition))) continue;

            let fireAt = triggerTime;
            const snoozeValue = effectiveFm[settings.snoozeProperty || "reminderSnooze"];
            const snoozeTime = snoozeValue ? parseDate(snoozeValue) : null;
            if (snoozeTime && snoozeTime > now) fireAt = snoozeTime;
            else if (fireAt <= now) {
                const effectiveTriggerKey = snoozeTime
                    ? `${baseTriggerKey}|snooze:${snoozeTime}`
                    : baseTriggerKey;
                const sameTrigger = state?.lastTriggerKey === effectiveTriggerKey;
                if (reminder.repeatUntilComplete && state?.triggered && sameTrigger && state.lastSent) {
                    if (reminder.maxRepeats !== -1 && state.repeatCount >= reminder.maxRepeats) continue;
                    const repeatMs = Math.max(1, reminder.repeatIntervalMinutes) * 60 * 1000;
                    fireAt = state.lastSent + repeatMs;
                    while (fireAt <= now) fireAt += repeatMs;
                } else {
                    // The Reminder modal deliberately keeps a file reminder
                    // visible for one bounded polling window after it becomes
                    // due. Preserve that original logical occurrence in the
                    // signed schedule so TishOS can deliver it immediately
                    // with the same stable digest instead of losing it at the
                    // strict future-time boundary. External-event catch-up has
                    // a much wider policy and remains future-only here.
                    const liveWindowMs = getFileReminderLiveWindowMs(settings.pollMinutes);
                    if (target.sourceType !== "file") continue;
                    if (now - fireAt > liveWindowMs) {
                        if (!reminder.repeatUntilComplete) continue;
                        const repeatMs = Math.max(1, reminder.repeatIntervalMinutes) * 60 * 1000;
                        const nextRepeatOrdinal = Math.floor((now - fireAt) / repeatMs) + 1;
                        if (reminder.maxRepeats !== -1 && nextRepeatOrdinal > reminder.maxRepeats) continue;
                        fireAt += nextRepeatOrdinal * repeatMs;
                    }
                }
            }
            if (fireAt > horizonEnd) continue;
            if (reminder.repeatEndAt === "trigger-base" && fireAt > finalTriggerBase) continue;

            const remaining = formatRemaining(propTime - fireAt);
            const time = moment(propTime).format("h:mm A");
            const displayName = buildReminderDisplayName(fileRef, target);
            items.push({
                title: formatTemplate(reminder.title, { filename: displayName, time, remaining }),
                body: formatTemplate(reminder.body, { filename: displayName, time, remaining }),
                fireAt,
                sourcePath: fileRef instanceof TFile ? fileRef.path : undefined,
                reminderId: reminder.id,
                sourceKey: target.sourceKey,
            });
        }
        return items;
    }

    private suppressNoteNotificationsBackedByTaskNotifications(
        notifications: PendingNotification[],
        alertState: TPSControllerSettings["alertState"],
    ): ReminderRunResult {
        const taskBackedReminderKeys = new Set(
            notifications
                .filter((notification) =>
                    notification.sourceType === "file" &&
                    typeof notification.sourceKey === "string" &&
                    notification.sourceKey.includes("::task:") &&
                    notification.file instanceof TFile
                )
                .map((notification) => `${notification.file!.path}::${notification.reminderId}`),
        );
        if (taskBackedReminderKeys.size === 0) return { notifications, stateChanged: false };

        let stateChanged = false;
        const visibleNotifications = notifications.filter((notification) => {
            if (
                notification.sourceType !== "file" ||
                !(notification.file instanceof TFile) ||
                notification.sourceKey !== notification.file.path
            ) {
                return true;
            }

            const key = `${notification.file.path}::${notification.reminderId}`;
            if (!taskBackedReminderKeys.has(key)) return true;

            const state = alertState[notification.file.path]?.[notification.reminderId];
            if (state?.triggered || state?.lastSent || state?.lastTriggerKey || state?.repeatCount) {
                state.triggered = false;
                state.repeatCount = 0;
                state.lastSent = undefined;
                state.lastTriggerKey = undefined;
                stateChanged = true;
            }
            return false;
        });

        return { notifications: visibleNotifications, stateChanged };
    }

    private async getReminderCandidateFiles(settings: TPSControllerSettings): Promise<TFile[]> {
        const properties = (settings.reminders || [])
            .filter((reminder) => reminder.enabled)
            .map((reminder) => reminder.property);
        const result = await discoverReminderCandidateFiles(this.app, settings, properties);
        return result.files;
    }

    private evaluateTarget(params: {
        target: ReminderEvaluationTarget;
        fileRef: ReminderFileLike;
        cache: unknown;
        baseFrontmatter: Record<string, unknown>;
        settings: TPSControllerSettings;
        now: number;
        alertState: TPSControllerSettings["alertState"];
        reminderFilter?: (reminder: PropertyReminder) => boolean;
        stats?: ReminderEvaluationStats;
    }): ReminderRunResult {
        const {
            target,
            fileRef,
            cache,
            baseFrontmatter,
            settings,
            now,
            alertState,
            reminderFilter,
        } = params;
        const notifications: PendingNotification[] = [];
        let stateChanged = false;

        if (!alertState[target.sourceKey]) alertState[target.sourceKey] = {};

        for (const reminder of settings.reminders) {
            if (!reminder.enabled) continue;
            if (reminderFilter && !reminderFilter(reminder)) continue;
            if (!this.reminderIncludesSource(reminder, target.sourceType)) continue;

            if (params.stats) params.stats.targetsEvaluated++;
            const ctx = buildEffectiveReminderContextForTarget(target, baseFrontmatter, reminder.property, settings);
            if (!ctx) {
                this.countSkip(params.stats, "missing-property");
                continue;
            }
            const effectiveFm = ctx.frontmatter;
            const propValue = ctx.propertyValue;

            if (shouldIgnoreForReminder(
                fileRef,
                cache,
                effectiveFm,
                reminder,
                settings.globalIgnorePaths,
                settings.globalIgnoreTags,
                settings.globalIgnoreStatuses,
                settings.globalIgnoreCheckboxStates,
                target.reminderTags,
            )) {
                this.countSkip(params.stats, "ignored");
                continue;
            }

            const { start: propTime, end: rangeEndTime } = parseTimeRange(propValue);
            if (!propTime) {
                this.countSkip(params.stats, "invalid-time");
                continue;
            }
            if (!hasRequiredStatus(effectiveFm, reminder)) {
                this.countSkip(params.stats, "status-filter");
                continue;
            }
            if (!hasRequiredCheckboxState(effectiveFm, reminder)) {
                this.countSkip(params.stats, "checkbox-filter");
                continue;
            }

            let offsetMs = reminder.offsetMinutes * 60 * 1000;
            const normalizedPropValue = this.normalizeReminderPropertyValue(propValue);
            const hasExplicitTime = hasExplicitTimeInValue(propValue);
            const isAllDaySafe = isAllDayEvent(propValue, effectiveFm) &&
                (!hasExplicitTime || String(effectiveFm?.allDay ?? "").toLowerCase() === "true");
            const effectiveEndTime = getEffectiveEndTime(propTime, rangeEndTime, effectiveFm);
            if (reminder.mode === "timeblock" && !reminder.triggerAtEnd && effectiveEndTime && now > effectiveEndTime) {
                this.countSkip(params.stats, "timeblock-ended");
                continue;
            }

            const effectiveAllDayBaseTime = reminder.allDayBaseTime || settings.defaultAllDayBaseTime;
            const finalTriggerBase = getReminderTriggerBase(
                propTime,
                effectiveEndTime,
                isAllDaySafe,
                reminder.triggerAtEnd,
                effectiveAllDayBaseTime,
            );
            if (!finalTriggerBase) {
                this.countSkip(params.stats, "missing-trigger-base");
                continue;
            }

            if (reminder.useSmartOffset && reminder.smartOffsetProperty) {
                const durationMins = parseDuration(effectiveFm[reminder.smartOffsetProperty]);
                if (durationMins > 0) {
                    const smartMs = durationMins * 60 * 1000;
                    offsetMs = reminder.smartOffsetOperator === "subtract" ? -smartMs : smartMs;
                }
            }

            const triggerTime = finalTriggerBase + offsetMs;
            const baseTriggerKey = this.buildTriggerKey(triggerTime, isAllDaySafe, hasExplicitTime, normalizedPropValue);
            if (!alertState[target.sourceKey][reminder.id]) {
                alertState[target.sourceKey][reminder.id] = {
                    triggered: false,
                    repeatCount: 0,
                    lastSent: undefined,
                    lastTriggerKey: undefined,
                };
            }
            const state = alertState[target.sourceKey][reminder.id];

            let triggerKey = baseTriggerKey;
            if (state.lastTriggerKey && state.lastTriggerKey !== triggerKey && state.triggered) {
                state.triggered = false;
                state.repeatCount = 0;
                state.lastSent = undefined;
                stateChanged = true;
            }

            const snoozeVal = effectiveFm[settings.snoozeProperty || "reminderSnooze"];
            if (snoozeVal) {
                const snoozeTime = parseDate(snoozeVal);
                if (snoozeTime && now < snoozeTime) {
                    this.countSkip(params.stats, "snoozed");
                    continue;
                }
                if (snoozeTime) {
                    triggerKey = `${baseTriggerKey}|snooze:${snoozeTime}`;
                }
            }

            if (state.lastTriggerKey && state.lastTriggerKey !== triggerKey && state.triggered) {
                state.triggered = false;
                state.repeatCount = 0;
                state.lastSent = undefined;
                stateChanged = true;
            }

            if (reminder.allDayFilter && reminder.allDayFilter !== "any") {
                if (reminder.allDayFilter === "true" && !isAllDaySafe) {
                    this.countSkip(params.stats, "all-day-filter");
                    continue;
                }
                if (reminder.allDayFilter === "false" && isAllDaySafe) {
                    this.countSkip(params.stats, "all-day-filter");
                    continue;
                }
            }

            if (effectiveEndTime) {
                const isWorking = getStatuses(effectiveFm).includes("working");
                if (isWorking && now < effectiveEndTime) {
                    const requiresWorking = reminder.requiredStatuses?.some((s) => normalizeStatus(s) === "working");
                    if (!requiresWorking) {
                        this.countSkip(params.stats, "working-until-end");
                        continue;
                    }
                }
            }

            const shouldStop = reminder.stopConditions.some((cond) => checkStopCondition(effectiveFm, cond));
            if (shouldStop) {
                if (state.triggered) {
                    state.triggered = false;
                    state.repeatCount = 0;
                    state.lastSent = undefined;
                    state.lastTriggerKey = undefined;
                    stateChanged = true;
                }
                this.countSkip(params.stats, "stop-condition");
                continue;
            }

            const isExternalEvent = target.sourceType === "external-event";
            const repeatEndsAtTriggerBase = reminder.repeatEndAt === "trigger-base";
            if (params.now < triggerTime) {
                if (state.triggered && reminder.repeatUntilComplete) {
                    state.triggered = false;
                    state.repeatCount = 0;
                    stateChanged = true;
                }
                this.countSkip(params.stats, "future-trigger");
                continue;
            }

            if (repeatEndsAtTriggerBase && params.now > finalTriggerBase) {
                if (!state.triggered || state.lastTriggerKey !== triggerKey) {
                    state.triggered = true;
                    state.repeatCount = 0;
                    state.lastTriggerKey = triggerKey;
                    state.lastSent = params.now;
                    stateChanged = true;
                }
                this.countSkip(params.stats, "repeat-ended-at-base");
                continue;
            }

            let shouldNotify = false;
            if (!state.triggered) {
                if (!reminder.repeatUntilComplete && state.lastTriggerKey === triggerKey && state.lastSent) {
                    this.countSkip(params.stats, "already-sent");
                    continue;
                }
                const liveWindowMs = isExternalEvent
                    ? this.getExternalEventLiveFireWindowMs(settings, isAllDaySafe)
                    : getFileReminderLiveWindowMs(settings.pollMinutes);
                if (shouldSkipStaleOneShotReminder(
                    params.now,
                    triggerTime,
                    reminder.repeatUntilComplete,
                    liveWindowMs,
                )) {
                    state.triggered = true;
                    state.repeatCount = 0;
                    state.lastTriggerKey = triggerKey;
                    state.lastSent = undefined;
                    stateChanged = true;
                    this.countSkip(params.stats, isExternalEvent ? "stale-external" : "stale-one-shot");
                    if (settings.enableLogging) {
                        logger.flow("ReminderEngine", "notification:skipped-stale", {
                            path: fileRef.path,
                            sourceKey: target.sourceKey,
                            sourceType: target.sourceType,
                            targetKind: target.targetKind,
                            reminderId: reminder.id,
                            reminderLabel: reminder.label || "",
                            triggerTime,
                            evaluatedAt: params.now,
                            lateByMs: params.now - triggerTime,
                            liveWindowMs,
                            repeatUntilComplete: false,
                        });
                    }
                    continue;
                }
                shouldNotify = true;
                state.triggered = true;
                state.repeatCount = 0;
                state.lastTriggerKey = triggerKey;
                stateChanged = true;
            } else if (
                reminder.repeatUntilComplete &&
                (!reminder.mode || reminder.mode === "task")
            ) {
                if (repeatEndsAtTriggerBase && params.now >= finalTriggerBase) {
                    this.countSkip(params.stats, "repeat-ended-at-base");
                    continue;
                }
                if (!hasRequiredStatus(effectiveFm, reminder)) {
                    this.countSkip(params.stats, "status-filter");
                    continue;
                }
                if (!hasRequiredCheckboxState(effectiveFm, reminder)) {
                    this.countSkip(params.stats, "checkbox-filter");
                    continue;
                }
                const repeatMs = reminder.repeatIntervalMinutes * 60 * 1000;
                const timeSinceLastSent = state.lastSent ? (params.now - state.lastSent) : Infinity;
                if (timeSinceLastSent >= repeatMs && (reminder.maxRepeats === -1 || state.repeatCount < reminder.maxRepeats)) {
                    shouldNotify = true;
                    state.repeatCount++;
                    stateChanged = true;
                } else {
                    this.countSkip(params.stats, timeSinceLastSent < repeatMs ? "repeat-not-due" : "max-repeats");
                    continue;
                }
            }

            if (!shouldNotify) {
                this.countSkip(params.stats, "not-due");
                continue;
            }

            const remaining = formatRemaining(propTime - params.now);
            const timeStr = moment(propTime).format("h:mm A");
            const displayName = buildReminderDisplayName(fileRef, target);
            const title = formatTemplate(reminder.title, { filename: displayName, time: timeStr, remaining });
            const body = formatTemplate(reminder.body, { filename: displayName, time: timeStr, remaining });

            notifications.push({
                title,
                body,
                file: fileRef instanceof TFile ? fileRef : undefined,
                isAllDay: isAllDaySafe,
                reminderId: reminder.id,
                sourceKey: target.sourceKey,
                sourceType: target.sourceType,
            });
            state.lastSent = params.now;
            state.lastTriggerKey = triggerKey;
            stateChanged = true;

            if (settings.enableLogging) {
                logger.flow("ReminderEngine", "notification:queued", {
                    path: fileRef.path,
                    sourceKey: target.sourceKey,
                    sourceType: target.sourceType,
                    targetKind: target.targetKind,
                    reminderId: reminder.id,
                    reminderLabel: reminder.label || "",
                    title,
                    triggerTime,
                    isAllDay: isAllDaySafe,
                    repeatCount: state.repeatCount,
                });
            }

            break;
        }

        return { notifications, stateChanged };
    }

    private reminderIncludesSource(reminder: PropertyReminder, sourceType: ReminderEvaluationTarget["sourceType"]): boolean {
        const configured = Array.isArray(reminder.sourceTypes) ? reminder.sourceTypes.filter(Boolean) : [];
        if (configured.length > 0) return configured.includes(sourceType);
        if (sourceType === "external-event") return !!reminder.includeUnmatchedExternalEvents;
        return sourceType === "file";
    }

    private async buildUnmatchedExternalReminderTargets(
        files: TFile[],
        settings: TPSControllerSettings,
        stats?: ReminderEvaluationStats,
    ): Promise<ReminderEvaluationTarget[]> {
        const calendars = (settings.externalCalendars || []).filter((calendar) => calendar.enabled !== false);
        const urls = Array.from(new Set(calendars.map((calendar) => normalizeCalendarUrl(calendar.url)).filter(Boolean)));
        if (stats) stats.externalUrls = urls.length;
        if (!urls.length) return [];

        const localIndex = await this.buildLocalEventMatchIndex(files, settings);
        const rangeStart = moment().startOf("day").toDate();
        const rangeEnd = moment().add(60, "days").endOf("day").toDate();
        const seen = new Set<string>();
        const targets: ReminderEvaluationTarget[] = [];

        for (const url of urls) {
            try {
                const targetsBeforeFetch = targets.length;
                logger.flow("ReminderEngine", "external-fetch:start", {
                    url,
                    rangeStart: rangeStart.toISOString(),
                    rangeEnd: rangeEnd.toISOString(),
                });
                const events = await this.externalCalendarService.fetchEvents(url, rangeStart, rangeEnd, false, false);
                if (stats) stats.externalEventsFetched += events.length;
                for (const event of events) {
                    if (event.isCancelled) continue;
                    if (this.isExternalEventHiddenByCalendarPlugin(event, url)) {
                        if (stats) stats.externalHidden++;
                        continue;
                    }
                    if (this.matchesLocalEvent(localIndex, event)) {
                        if (stats) stats.externalMatchedLocal++;
                        continue;
                    }

                    const sourceUrl = normalizeCalendarUrl(event.sourceUrl || url);
                    const dedupeKey = `${sourceUrl}::${event.id}`;
                    if (seen.has(dedupeKey)) {
                        if (stats) stats.externalDuplicate++;
                        continue;
                    }
                    seen.add(dedupeKey);

                    targets.push({
                        sourceKey: `external-event::${sourceUrl}::${event.id}`,
                        sourceType: "external-event",
                        externalEvent: {
                            ...event,
                            sourceUrl,
                        },
                    });
                }
                logger.flow("ReminderEngine", "external-fetch:done", {
                    url,
                    events: events.length,
                    targets: targets.length - targetsBeforeFetch,
                    hidden: stats?.externalHidden ?? 0,
                    matchedLocal: stats?.externalMatchedLocal ?? 0,
                    duplicates: stats?.externalDuplicate ?? 0,
                });
            } catch (error) {
                if (stats) stats.externalFetchErrors++;
                logger.flowWarn("ReminderEngine", "external-fetch:failed", { url, error: logger.errorSummary(error) });
            }
        }

        return targets;
    }

    private countSkip(stats: ReminderEvaluationStats | undefined, reason: string): void {
        if (!stats) return;
        stats.skipReasons[reason] = (stats.skipReasons[reason] || 0) + 1;
    }

    private summarizeSkipReasons(skipReasons: Record<string, number>): Record<string, number> {
        return Object.fromEntries(
            Object.entries(skipReasons)
                .filter(([, count]) => count > 0)
                .sort(([, a], [, b]) => b - a)
                .slice(0, 12),
        );
    }

    private isExternalEventHiddenByCalendarPlugin(event: ExternalCalendarEvent, fallbackUrl: string): boolean {
        const calendarPlugin =
            (this.app as any)?.plugins?.getPlugin?.("tps-calendar-base") ||
            (this.app as any)?.plugins?.plugins?.["tps-calendar-base"] ||
            (this.app as any)?.plugins?.getPlugin?.("TPS-Calendar-Base (Dev)") ||
            (this.app as any)?.plugins?.plugins?.["TPS-Calendar-Base (Dev)"];
        const hiddenByBase = calendarPlugin?.settings?.hiddenExternalEventsByBase;
        if (!hiddenByBase || typeof hiddenByBase !== "object") return false;

        const sourceUrl = normalizeCalendarUrl(event.sourceUrl || fallbackUrl);
        const eventKey = `${sourceUrl}::${event.id}`;
        return Object.values(hiddenByBase).some((entries) =>
            Array.isArray(entries) && entries.some((entry) => String(entry) === eventKey),
        );
    }

    private async buildLocalEventMatchIndex(
        _files: TFile[],
        settings: TPSControllerSettings,
    ): Promise<LocalEventMatchIndex> {
        return this.buildLocalEventMatchIndexFromVault(this.app.vault.getMarkdownFiles(), settings);
    }

    private async buildLocalEventMatchIndexFromVault(
        files: TFile[],
        settings: TPSControllerSettings,
    ): Promise<LocalEventMatchIndex> {
        const eventIds = new Set<string>();
        const uidStartKeys = new Set<string>();
        const titleDayKeys = new Set<string>();
        const terminalTitleKeys = new Set<string>();

        for (const file of files) {
            const cache = this.app.metadataCache.getFileCache(file);
            const fm = (cache?.frontmatter || {}) as Record<string, unknown>;
            const eventId = this.normalizeIdentityValue(
                this.findKeyInsensitive(fm, settings.eventIdKey) ?? this.findKeyInsensitive(fm, "externalEventId"),
            );
            const uidValue = this.normalizeIdentityValue(
                this.findKeyInsensitive(fm, settings.uidKey) ?? this.findKeyInsensitive(fm, "tpsCalendarUid"),
            );
            const startValue = this.normalizeIdentityValue(
                this.findKeyInsensitive(fm, settings.startProperty) ?? this.findKeyInsensitive(fm, "scheduled"),
            );
            const titleValue = this.normalizeIdentityValue(
                this.findKeyInsensitive(fm, settings.titleKey) ?? file.basename,
            );

            if (eventId) eventIds.add(eventId);

            const startDate = startValue ? parseFrontmatterDate(startValue) : null;
            const uidForMatch = uidValue || (eventId ? this.extractUid(eventId) || eventId : null);
            const uidStartKey = this.buildUidStartKey(uidForMatch, startDate);
            if (uidStartKey) uidStartKeys.add(uidStartKey);

            const titleDayKey = this.buildTitleDayKey(titleValue, startDate);
            if (titleDayKey) titleDayKeys.add(titleDayKey);

            if (file.extension?.toLowerCase() === "md") {
                try {
                    const content = await this.app.vault.cachedRead(file);
                    for (const line of content.split(/\r?\n/)) {
                        const inline = this.extractInlineCalendarIdentity(line, settings);
                        if (!inline) continue;
                        if (inline.eventId) eventIds.add(inline.eventId);
                        const inlineStart = inline.start ? parseFrontmatterDate(inline.start) : null;
                        const inlineUid = inline.uid || (inline.eventId ? this.extractUid(inline.eventId) || inline.eventId : null);
                        const inlineUidStartKey = this.buildUidStartKey(inlineUid, inlineStart);
                        if (inlineUidStartKey) uidStartKeys.add(inlineUidStartKey);
                        const inlineTitleDayKey = this.buildTitleDayKey(inline.title, inlineStart);
                        if (inlineTitleDayKey) titleDayKeys.add(inlineTitleDayKey);
                    }
                } catch {
                    // Ignore unreadable files while building a best-effort external-event match index.
                }
            }
        }

        return { eventIds, uidStartKeys, titleDayKeys, terminalTitleKeys };
    }

    private extractInlineCalendarIdentity(
        line: string,
        settings: TPSControllerSettings,
    ): { eventId: string | null; uid: string | null; start: string | null; title: string | null } | null {
        if (!/^\s*(?:[-*+]|\d+[.)])\s+\[[^\]]?]\s+/.test(line)) return null;
        if (!/(?:tpsinlineprops|tps-inline-props|data-tps-inline-props|\[\^tps-inline:)/i.test(line)) return null;

        const inlineProps = this.parseInlineProperties(line);
        const encoded = inlineProps.get("tpsinlineprops");
        const hiddenProps = this.parseHiddenInlineMetadata(line, encoded);

        const eventId = this.normalizeIdentityValue(
            hiddenProps[settings.eventIdKey]
            ?? hiddenProps.externalEventId
            ?? inlineProps.get(settings.eventIdKey.toLowerCase())
            ?? inlineProps.get("externaleventid"),
        );
        const externalId = this.normalizeIdentityValue(hiddenProps.externalId ?? inlineProps.get("externalid"));
        const uid = this.normalizeIdentityValue(
            hiddenProps[settings.uidKey]
            ?? hiddenProps.tpsCalendarUid
            ?? inlineProps.get(settings.uidKey.toLowerCase())
            ?? inlineProps.get("tpscalendaruid"),
        );
        const start = this.normalizeIdentityValue(
            inlineProps.get((settings.startProperty || "scheduled").toLowerCase()) ?? inlineProps.get("scheduled"),
        );
        const title = this.cleanInlineTaskTitle(line);

        const eventIdFromExternalId = externalId?.startsWith("calendar:")
            ? externalId.slice(externalId.lastIndexOf("#") + 1)
            : null;
        const resolvedEventId = eventId || this.normalizeIdentityValue(eventIdFromExternalId);
        if (!resolvedEventId && !uid && !title) return null;
        return { eventId: resolvedEventId, uid, start, title };
    }

    private parseHiddenInlineMetadata(line: string, encoded?: string): Record<string, unknown> {
        const hiddenProps: Record<string, unknown> = {};
        this.mergeInlineMetadata(hiddenProps, encoded || "");

        const hiddenRegex = /(?:<span\b[^>]*data-tps-inline-props="([^"]*)"[^>]*>\s*<\/span>|<!--\s*tps-inline-props:([\s\S]*?)\s*-->|\s*%%\s*tps-inline-props:([\s\S]*?)\s*%%)/g;
        let hiddenMatch: RegExpExecArray | null;
        while ((hiddenMatch = hiddenRegex.exec(line)) !== null) {
            const raw = hiddenMatch[1] || hiddenMatch[2] || hiddenMatch[3] || "";
            this.mergeInlineMetadata(hiddenProps, raw, !hiddenMatch[1]);
        }
        return hiddenProps;
    }

    private mergeInlineMetadata(target: Record<string, unknown>, raw: string, alreadyJson = false): void {
        if (!raw) return;
        try {
            const parsed = JSON.parse(alreadyJson ? raw.trim() : decodeURIComponent(raw.trim()));
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
            Object.assign(target, parsed);
        } catch {
            // Ignore malformed hidden inline metadata.
        }
    }

    private parseInlineProperties(line: string): Map<string, string> {
        const props = new Map<string, string>();
        const regex = /\[([^\[\]:]+)::\s*([^\]]+)\]/g;
        let match: RegExpExecArray | null;
        while ((match = regex.exec(line)) !== null) {
            const key = match[1].trim().toLowerCase();
            const value = match[2].trim();
            if (key) props.set(key, value);
        }
        return props;
    }

    private cleanInlineTaskTitle(line: string): string {
        return line
            .replace(/^\s*(?:[-*+]|\d+[.)])\s+\[[^\]]?]\s+/, "")
            .replace(/\[[^\[\]:]+::\s*[^\]]+\]/g, "")
            .replace(/#[A-Za-z0-9_/-]+/g, "")
            .replace(/\s+/g, " ")
            .trim();
    }

    private matchesLocalEvent(index: LocalEventMatchIndex, event: ExternalCalendarEvent): boolean {
        if (index.eventIds.has(event.id)) return true;

        const uidStartKey = this.buildUidStartKey(event.uid || this.extractUid(event.id) || event.id, event.startDate);
        if (uidStartKey && index.uidStartKeys.has(uidStartKey)) return true;

        const titleDayKey = this.buildTitleDayKey(event.title, event.startDate);
        if (titleDayKey && index.titleDayKeys.has(titleDayKey)) return true;

        return false;
    }

    private buildUidStartKey(uid: string | null | undefined, startDate: Date | null | undefined): string | null {
        const normalizedUid = this.normalizeIdentityValue(uid);
        if (!normalizedUid || !startDate || !Number.isFinite(startDate.getTime())) return null;
        const roundedMs = Math.round(startDate.getTime() / 60000) * 60000;
        return `${normalizedUid}|${roundedMs}`;
    }

    private buildTitleDayKey(title: string | null | undefined, startDate: Date | null | undefined): string | null {
        const normalizedTitle = this.normalizeIdentityValue(title)?.toLowerCase();
        if (!normalizedTitle || !startDate || !Number.isFinite(startDate.getTime())) return null;
        return `${normalizedTitle}|${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, "0")}-${String(startDate.getDate()).padStart(2, "0")}`;
    }

    private findKeyInsensitive(obj: Record<string, unknown>, key: string): unknown {
        const normalized = String(key || "").trim().toLowerCase();
        const found = Object.keys(obj).find((candidate) => candidate.trim().toLowerCase() === normalized);
        return found ? obj[found] : undefined;
    }

    private normalizeIdentityValue(value: unknown): string | null {
        if (typeof value !== "string") return null;
        const normalized = value.trim();
        if (!normalized) return null;
        const lower = normalized.toLowerCase();
        if (lower === "null" || lower === "undefined" || lower === "none" || lower === "n/a") {
            return null;
        }
        return normalized;
    }

    private extractUid(id: string): string | null {
        const suffixPattern = /[-_](?:dup[-_])?(?:\d{4}\d{2}\d{2}T\d{2}\d{2}\d{2}|\d{13,})$/;
        const match = id.match(suffixPattern);
        if (match && match.index && match.index > 0) {
            return id.substring(0, match.index);
        }
        return null;
    }

    private isArchivedFile(file: TFile, archiveFolder: string): boolean {
        const archive = normalizePath(String(archiveFolder || "").trim());
        if (!archive) return false;
        return file.path === archive || file.path.startsWith(`${archive}/`);
    }

    private buildSyntheticExternalFile(event: ExternalCalendarEvent): ReminderFileLike {
        const source = normalizeCalendarUrl(event.sourceUrl || "external-calendar") || "external-calendar";
        return {
            path: `external-calendars/${source}/${event.id}.ics`,
            basename: event.title || "External calendar event",
        };
    }

    private normalizeReminderPropertyValue(value: unknown): string {
        const raw = Array.isArray(value) ? value[0] : value;
        return String(raw ?? "").replace(/[\[\]]/g, "").trim();
    }

    private getExternalEventLiveFireWindowMs(settings: TPSControllerSettings, isAllDay: boolean): number {
        const pollMs = Math.max(30000, settings.pollMinutes * 60 * 1000);
        if (isAllDay) return Math.max(12 * 60 * 60 * 1000, pollMs * 3);
        return Math.max(60 * 60 * 1000, pollMs * 3);
    }

    private buildTriggerKey(
        triggerTime: number,
        isAllDay: boolean,
        hasExplicitTime: boolean,
        normalizedPropValue: string,
    ): string {
        return [
            String(triggerTime),
            isAllDay ? "all-day" : "timed",
            hasExplicitTime ? "datetime" : "date-or-implicit",
            normalizedPropValue || "",
        ].join("|");
    }
}
