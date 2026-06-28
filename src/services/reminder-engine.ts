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
    normalizeStatus, getStatuses, hasRequiredStatus, shouldIgnoreForReminder,
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
        const needsExternalEvents = settings.reminders.some(
            (reminder) => reminder.enabled && this.reminderIncludesSource(reminder, "external-event"),
        );

        if (settings.enableLogging) {
            logger.log(`[ReminderEngine] Checking ${activeFiles.length} files${needsExternalEvents ? " + unmatched external events" : ""}...`);
        }

        for (const file of activeFiles) {
            try {
                const cache = this.app.metadataCache.getFileCache(file);
                const fm = (cache?.frontmatter || {}) as Record<string, unknown>;
                const targets = await buildReminderTargetsForFile(this.app, file, fm, settings);
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
                    });
                    fileNotifications.push(...result.notifications);
                    stateChanged = stateChanged || result.stateChanged;
                }
                const suppression = this.suppressNoteNotificationsBackedByTaskNotifications(fileNotifications, alertState);
                pendingNotifications.push(...suppression.notifications);
                stateChanged = stateChanged || suppression.stateChanged;
            } catch (err) {
                logger.error(`[ReminderEngine] Error processing reminders for ${file.path}:`, err);
            }
        }

        if (needsExternalEvents) {
            const externalTargets = await this.buildUnmatchedExternalReminderTargets(files, settings);
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
                });
                pendingNotifications.push(...result.notifications);
                stateChanged = stateChanged || result.stateChanged;
            }
        }

        if (settings.enableLogging) {
            const notifSummary = pendingNotifications.length > 0
                ? `${pendingNotifications.length} notification(s) queued`
                : "no notifications triggered";
            const activeRules = settings.reminders.filter((r) => r.enabled).length;
            logger.log(`[ReminderEngine] Scan complete: ${notifSummary} (${activeFiles.length} files, ${activeRules} active rule(s))`);
        }

        return { notifications: pendingNotifications, stateChanged };
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
            )) {
                continue;
            }

            const { start: propTime, end: rangeEndTime } = parseTimeRange(propValue);
            if (!propTime) continue;
            if (!hasRequiredStatus(effectiveFm, reminder)) continue;

            let offsetMs = reminder.offsetMinutes * 60 * 1000;
            const normalizedPropValue = this.normalizeReminderPropertyValue(propValue);
            const hasExplicitTime = hasExplicitTimeInValue(propValue);
            const isAllDaySafe = isAllDayEvent(propValue, effectiveFm) &&
                (!hasExplicitTime || String(effectiveFm?.allDay ?? "").toLowerCase() === "true");
            const effectiveEndTime = getEffectiveEndTime(propTime, rangeEndTime, effectiveFm);
            if (reminder.mode === "timeblock" && !reminder.triggerAtEnd && effectiveEndTime && now > effectiveEndTime) {
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
            if (!finalTriggerBase) continue;

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
                if (snoozeTime && now < snoozeTime) continue;
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
                if (reminder.allDayFilter === "true" && !isAllDaySafe) continue;
                if (reminder.allDayFilter === "false" && isAllDaySafe) continue;
            }

            if (effectiveEndTime) {
                const isWorking = getStatuses(effectiveFm).includes("working");
                if (isWorking && now < effectiveEndTime) {
                    const requiresWorking = reminder.requiredStatuses?.some((s) => normalizeStatus(s) === "working");
                    if (!requiresWorking) continue;
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
                continue;
            }

            let shouldNotify = false;
            if (!state.triggered) {
                if (!reminder.repeatUntilComplete && state.lastTriggerKey === triggerKey && state.lastSent) continue;
                if (isExternalEvent) {
                    const staleMs = this.getExternalEventLiveFireWindowMs(settings, isAllDaySafe);
                    if (params.now - triggerTime > staleMs) {
                        state.triggered = true;
                        state.repeatCount = 0;
                        state.lastTriggerKey = triggerKey;
                        state.lastSent = params.now;
                        stateChanged = true;
                        continue;
                    }
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
                if (repeatEndsAtTriggerBase && params.now >= finalTriggerBase) continue;
                if (!hasRequiredStatus(effectiveFm, reminder)) continue;
                const repeatMs = reminder.repeatIntervalMinutes * 60 * 1000;
                const timeSinceLastSent = state.lastSent ? (params.now - state.lastSent) : Infinity;
                if (timeSinceLastSent >= repeatMs && (reminder.maxRepeats === -1 || state.repeatCount < reminder.maxRepeats)) {
                    shouldNotify = true;
                    state.repeatCount++;
                    stateChanged = true;
                }
            }

            if (!shouldNotify) continue;

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
                logger.log(`[ReminderEngine] Firing notification: "${title}" for ${fileRef.basename} (rule: "${reminder.label || reminder.id}")`);
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
    ): Promise<ReminderEvaluationTarget[]> {
        const calendars = (settings.externalCalendars || []).filter((calendar) => calendar.enabled !== false);
        const urls = Array.from(new Set(calendars.map((calendar) => normalizeCalendarUrl(calendar.url)).filter(Boolean)));
        if (!urls.length) return [];

        const localIndex = await this.buildLocalEventMatchIndex(files, settings);
        const rangeStart = moment().startOf("day").toDate();
        const rangeEnd = moment().add(60, "days").endOf("day").toDate();
        const seen = new Set<string>();
        const targets: ReminderEvaluationTarget[] = [];

        for (const url of urls) {
            try {
                const events = await this.externalCalendarService.fetchEvents(url, rangeStart, rangeEnd, false, false);
                for (const event of events) {
                    if (event.isCancelled) continue;
                    if (this.isExternalEventHiddenByCalendarPlugin(event, url)) continue;
                    if (this.matchesLocalEvent(localIndex, event)) continue;

                    const sourceUrl = normalizeCalendarUrl(event.sourceUrl || url);
                    const dedupeKey = `${sourceUrl}::${event.id}`;
                    if (seen.has(dedupeKey)) continue;
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
            } catch (error) {
                logger.warn(`[ReminderEngine] Failed fetching external reminder events for ${url}`, error);
            }
        }

        return targets;
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
