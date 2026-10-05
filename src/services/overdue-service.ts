import { App, MarkdownView, Notice, TFile, WorkspaceLeaf, getFrontMatterInfo, moment, parseYaml } from "obsidian";
import { NOTIFICATION_VIEW_TYPE } from "../views/notification-view";
import * as logger from "../logger";
import type { TPSControllerSettings, OverdueItem } from "../types";
import {
    parseDate, parseTimeRange, parseDuration, getEffectiveEndTime,
    formatTemplate, checkStopCondition, hasRequiredStatus, hasRequiredCheckboxState,
    shouldIgnoreForReminder, isAllDayEvent, hasExplicitTimeInValue,
    getReminderTriggerBase, getReminderCancellationStatuses,
} from "../utils/time-calculation-service";
import {
    buildReminderTargetsForFile,
    buildEffectiveReminderContextForTarget,
    buildReminderDisplayName,
    getReminderTagsForTarget,
} from "./reminder-target-service";
import { getReminderCandidateFiles } from "./reminder-candidate-service";
import {
    getFileReminderLiveWindowMs,
    shouldSkipStaleOneShotReminder,
} from "./reminder-delivery-window";
import { TPS_EVENTS, TPS_LEGACY_EVENTS } from "../tps-contracts";
import { emitFilesUpdated } from "../tps-gcm-api";

/**
 * Handles overdue reminder detection, the notification sidebar view,
 * and file-level actions (snooze, open, mark complete/won't-do).
 */
export class OverdueService {
    constructor(
        private app: App,
        private getSettings: () => TPSControllerSettings,
    ) {
    }

    async openNotificationModal(): Promise<void> {
        const started = performance.now();
        const { workspace } = this.app;
        const existingCount = workspace.getLeavesOfType(NOTIFICATION_VIEW_TYPE).length;
        logger.flow("NotificationView", "open:start", {
            existingLeaves: existingCount,
        });
        workspace.detachLeavesOfType(NOTIFICATION_VIEW_TYPE);
        const leaf = await workspace.ensureSideLeaf(NOTIFICATION_VIEW_TYPE, "right", {
            active: true,
            state: {},
        });
        await workspace.revealLeaf(leaf);
        workspace.setActiveLeaf(leaf, { focus: true });
        void workspace.requestSaveLayout();
        logger.flow("NotificationView", "open:done", {
            durationMs: Math.round(performance.now() - started),
        });
    }

    async getOverdueItems(): Promise<OverdueItem[]> {
        const started = performance.now();
        const settings = this.getSettings();
        const now = Date.now();
        const overdueItems: OverdueItem[] = [];
        if (settings.enableReminders === false) {
            logger.flow("OverdueItems", "scan:reminders-disabled");
            return overdueItems;
        }
        const reminders = settings.reminders || [];
        if (!reminders.length) {
            logger.flow("OverdueItems", "scan:no-rules");
            return overdueItems;
        }

        const ignorePaths = settings.globalIgnorePaths || [];
        const ignoreTags = settings.globalIgnoreTags || [];
        const ignoreStatuses = settings.globalIgnoreStatuses || [];
        const ignoreCheckboxStates = settings.globalIgnoreCheckboxStates || [];
        const snoozeKey = settings.snoozeProperty || "reminderSnooze";
        const liveWindowMs = getFileReminderLiveWindowMs(settings.pollMinutes);
        const candidateResult = await getReminderCandidateFiles(
            this.app,
            settings,
            reminders.filter((reminder) => reminder.enabled).map((reminder) => reminder.property),
        );
        const files = candidateResult.files;
        let targetCount = 0;
        let matchedBeforeDedupe = 0;
        let staleOneShotHidden = 0;

        for (const file of files) {
            const cache = this.app.metadataCache.getFileCache(file);
            const fm = (cache?.frontmatter || {}) as Record<string, unknown>;
            const targets = await buildReminderTargetsForFile(this.app, file, fm, settings);
            targetCount += targets.length;

            for (const target of targets) {
                for (const reminder of reminders) {
                    if (!reminder.enabled) continue;
                    if (!this.reminderIncludesSource(reminder, target.sourceType)) continue;

                    const ctx = buildEffectiveReminderContextForTarget(target, fm, reminder.property, settings);
                    if (!ctx) continue;
                    const effectiveFm = ctx.frontmatter;
                    const propertyValue = ctx.propertyValue;

                    if (shouldIgnoreForReminder(file, cache, effectiveFm, reminder, ignorePaths, ignoreTags, ignoreStatuses, ignoreCheckboxStates, getReminderTagsForTarget(target), getReminderCancellationStatuses(effectiveFm, settings.canceledStatusValue, settings.nativeCalendarCancellationState))) continue;
                    if (!hasRequiredStatus(effectiveFm, reminder)) continue;
                    if (!hasRequiredCheckboxState(effectiveFm, reminder)) continue;

                    let snoozedUntil: number | undefined;
                    const snoozeVal = effectiveFm[snoozeKey];
                    if (snoozeVal) {
                        const snoozeTime = parseDate(snoozeVal);
                        if (snoozeTime && now < snoozeTime) snoozedUntil = snoozeTime;
                    }

                    const { start: propertyTime, end: rangeEndTime } = parseTimeRange(propertyValue);
                    if (!propertyTime) continue;
                    const effectiveEndTime = getEffectiveEndTime(propertyTime, rangeEndTime, effectiveFm);
                    if (reminder.mode === "timeblock" && effectiveEndTime && !reminder.triggerAtEnd && now > effectiveEndTime) {
                        continue;
                    }

                    const stopped = reminder.stopConditions.some((cond) => checkStopCondition(effectiveFm, cond));
                    if (stopped) continue;

                    const isAllDaySafe = isAllDayEvent(propertyValue, effectiveFm) &&
                        (!hasExplicitTimeInValue(propertyValue) || String(effectiveFm?.allDay ?? '').toLowerCase() === 'true');

                    // Respect allDayFilter — must match event's all-day nature before continuing.
                    if (reminder.allDayFilter && reminder.allDayFilter !== 'any') {
                        if (reminder.allDayFilter === 'true' && !isAllDaySafe) continue;
                        if (reminder.allDayFilter === 'false' && isAllDaySafe) continue;
                    }
                    const effectiveAllDayBaseTime = reminder.allDayBaseTime || settings.defaultAllDayBaseTime;
                    const finalTriggerBase = getReminderTriggerBase(
                        propertyTime,
                        effectiveEndTime,
                        isAllDaySafe,
                        reminder.triggerAtEnd,
                        effectiveAllDayBaseTime,
                    );
                    if (!finalTriggerBase) continue;

                    let offsetMs = reminder.offsetMinutes * 60 * 1000;
                    if (reminder.useSmartOffset && reminder.smartOffsetProperty) {
                        const durationMins = parseDuration(effectiveFm[reminder.smartOffsetProperty]);
                        const smartMs = durationMins * 60 * 1000;
                        offsetMs = reminder.smartOffsetOperator === "subtract" ? -smartMs : smartMs;
                    }

                    const triggerTime = finalTriggerBase + offsetMs;
                    // Never show items before their trigger time — applies to both timed and all-day events.
                    if (now < triggerTime) continue;
                    if (reminder.repeatEndAt === "trigger-base" && now > finalTriggerBase) continue;
                    if (shouldSkipStaleOneShotReminder(
                        now,
                        triggerTime,
                        reminder.repeatUntilComplete,
                        liveWindowMs,
                    )) {
                        staleOneShotHidden++;
                        continue;
                    }

                    const diff = this.formatTimeDiff(now - finalTriggerBase);
                    const vars: Record<string, string> = {
                        filename: buildReminderDisplayName(file, target),
                        time: moment(finalTriggerBase).format("HH:mm"),
                        remaining: diff,
                        duration: String(effectiveFm["duration"] ?? ""),
                    };
                    matchedBeforeDedupe++;
                    overdueItems.push({
                        file,
                        reminder,
                        propertyTime: finalTriggerBase,
                        diff,
                        id: reminder.id,
                        sourceKey: target.sourceKey,
                        sourceType: target.sourceType,
                        targetKind: target.targetKind || (target.sourceType === "external-event" ? "external-event" : "note"),
                        taskTitle: target.taskTitle,
                        taskRawLine: target.taskRawLine,
                        taskLine: target.taskLine,
                        taskPropertyKeys: target.taskPropertyKeys,
                        reminderTags: target.reminderTags,
                        suppressInheritedDailyNoteSchedule: target.suppressInheritedDailyNoteSchedule,
                        reminderProperty: reminder.property,
                        reminderPropertySource: this.getReminderPropertySource(target, reminder.property),
                        noteTitle: target.noteTitle,
                        title: formatTemplate(reminder.title, vars),
                        body: formatTemplate(reminder.body, vars),
                        snoozedUntil,
                        isAllDay: isAllDaySafe,
                        status: String(effectiveFm[this.getSettings().statusKey] ?? effectiveFm['status'] ?? ''),
                        icon: String(effectiveFm["icon"] ?? ""),
                        color: effectiveFm['color'] ? String(effectiveFm['color']) : '',
                    });
                }
            }
        }

        const sortDirection = this.getSettings().notificationSortDirection === "desc" ? -1 : 1;
        overdueItems.sort((a, b) => {
            const delta = a.propertyTime - b.propertyTime;
            if (delta !== 0) return delta * sortDirection;
            return String(a.sourceKey || a.file.path).localeCompare(String(b.sourceKey || b.file.path)) * sortDirection;
        });

        const seenKeys = new Set<string>();
        const deduplicated: OverdueItem[] = [];
        const taskBackedReminderKeys = new Set(
            overdueItems
                .filter((item) => item.targetKind === "task")
                .map((item) => `${item.file.path}::${item.reminder.id}`),
        );
        const visibleOverdueItems = overdueItems.filter((item) => {
            if (item.targetKind !== "note") return true;
            return !taskBackedReminderKeys.has(`${item.file.path}::${item.reminder.id}`);
        });

        for (const item of visibleOverdueItems) {
            const key = item.sourceKey || item.file.path;
            if (seenKeys.has(key)) continue;
            seenKeys.add(key);
            deduplicated.push(item);
        }

        // Annotate each deduplicated item with its next upcoming trigger time.
        // Two-phase approach:
        // 1. First check if the CURRENT reminder (that created this item) will fire again
        // 2. If not, show when the next DIFFERENT reminder will start
        for (const item of deduplicated) {
            const cache = this.app.metadataCache.getFileCache(item.file);
            const fm = (cache?.frontmatter || {}) as Record<string, unknown>;
            
            const currentReminderId = item.reminder.id;
            const currentReminderLabel = item.reminder.label || item.reminder.id;
            
            let nextTime: number | undefined;
            let nextLabel: string | undefined;
            let isRepeatingCurrent = false;
            let intervalMins: number | undefined;

            const target: import('./reminder-target-service').ReminderEvaluationTarget = {
                sourceKey: item.sourceKey || item.file.path,
                sourceType: item.sourceType || 'file',
                targetKind: item.targetKind,
                taskTitle: item.taskTitle,
                taskRawLine: item.taskRawLine,
                taskLine: item.taskLine,
                taskPropertyKeys: item.taskPropertyKeys,
                reminderTags: item.reminderTags,
                suppressInheritedDailyNoteSchedule: item.suppressInheritedDailyNoteSchedule,
                noteTitle: item.noteTitle,
                taskFrontmatter: item.targetKind === "task" ? {
                    ...fm,
                    status: item.status || fm.status,
                    checkboxStatus: item.status || fm.status,
                    checkboxState: this.getTaskCheckboxState(item.taskRawLine),
                    taskCheckboxState: this.getTaskCheckboxState(item.taskRawLine),
                } : undefined,
            };

            // PHASE 1: Check if the CURRENT reminder will fire again
            const currentReminder = reminders.find(r => r.id === currentReminderId);
            if (currentReminder?.enabled) {
                const reminder = currentReminder;
                const ctx = buildEffectiveReminderContextForTarget(target, fm, reminder.property, settings);
                if (ctx && 
                    !shouldIgnoreForReminder(item.file, cache, ctx.frontmatter, reminder, ignorePaths, ignoreTags, ignoreStatuses, ignoreCheckboxStates, getReminderTagsForTarget(target), getReminderCancellationStatuses(ctx.frontmatter, settings.canceledStatusValue, settings.nativeCalendarCancellationState)) &&
                    hasRequiredStatus(ctx.frontmatter, reminder) &&
                    hasRequiredCheckboxState(ctx.frontmatter, reminder) &&
                    !reminder.stopConditions.some((cond) => checkStopCondition(ctx.frontmatter, cond))) {
                    
                    const { start: pt, end: ret } = parseTimeRange(ctx.propertyValue);
                    if (pt) {
                        const eet = getEffectiveEndTime(pt, ret, ctx.frontmatter);
                        const isAllDayCtx = isAllDayEvent(ctx.propertyValue, ctx.frontmatter) &&
                            (!hasExplicitTimeInValue(ctx.propertyValue) || String(ctx.frontmatter?.allDay ?? '').toLowerCase() === 'true');
                        const effectiveBase = reminder.allDayBaseTime || settings.defaultAllDayBaseTime;
                        const base = getReminderTriggerBase(pt, eet, isAllDayCtx, reminder.triggerAtEnd, effectiveBase);
                        if (!base) continue;
                        if (reminder.allDayFilter && reminder.allDayFilter !== 'any') {
                            if ((reminder.allDayFilter === 'true' && !isAllDayCtx) ||
                                (reminder.allDayFilter === 'false' && isAllDayCtx)) {
                                // Skip
                            } else {
                                let offMs = reminder.offsetMinutes * 60 * 1000;
                                if (reminder.useSmartOffset && reminder.smartOffsetProperty) {
                                    const dm = parseDuration(ctx.frontmatter[reminder.smartOffsetProperty]);
                                    const sm = dm * 60 * 1000;
                                    offMs = reminder.smartOffsetOperator === 'subtract' ? -sm : sm;
                                }
                                const tTime = base + offMs;
                                const isRepeating = !!(reminder.repeatUntilComplete && reminder.repeatIntervalMinutes > 0);
                                
                                if (isRepeating) {
                                    // Repeating reminder - compute next occurrence
                                    const intervalMs = (reminder.repeatIntervalMinutes || 0) * 60 * 1000;
                                    let nextRepeat = tTime;
                                    if (intervalMs > 0 && nextRepeat <= now) {
                                        const elapsed = now - nextRepeat;
                                        const cycles = Math.floor(elapsed / intervalMs) + 1;
                                        nextRepeat = nextRepeat + cycles * intervalMs;
                                    }
                                    nextTime = nextRepeat;
                                    nextLabel = currentReminderLabel;
                                    isRepeatingCurrent = true;
                                    intervalMins = reminder.repeatIntervalMinutes;
                                    logger.flow("OverdueItems", "next-trigger:current-repeat", {
                                        path: item.file.path,
                                        reminderId: currentReminderId,
                                        nextTriggerTime: nextRepeat,
                                        intervalMins,
                                    });
                                } else if (now < tTime) {
                                    // Future non-repeating trigger
                                    nextTime = tTime;
                                    nextLabel = currentReminderLabel;
                                    logger.flow("OverdueItems", "next-trigger:current-future", {
                                        path: item.file.path,
                                        reminderId: currentReminderId,
                                        nextTriggerTime: tTime,
                                    });
                                }
                            }
                        } else {
                            // No allDayFilter restriction
                            let offMs = reminder.offsetMinutes * 60 * 1000;
                            if (reminder.useSmartOffset && reminder.smartOffsetProperty) {
                                const dm = parseDuration(ctx.frontmatter[reminder.smartOffsetProperty]);
                                const sm = dm * 60 * 1000;
                                offMs = reminder.smartOffsetOperator === 'subtract' ? -sm : sm;
                            }
                            const tTime = base + offMs;
                            const isRepeating = !!(reminder.repeatUntilComplete && reminder.repeatIntervalMinutes > 0);
                            
                            if (isRepeating) {
                                // Repeating reminder - compute next occurrence
                                const intervalMs = (reminder.repeatIntervalMinutes || 0) * 60 * 1000;
                                let nextRepeat = tTime;
                                if (intervalMs > 0 && nextRepeat <= now) {
                                    const elapsed = now - nextRepeat;
                                    const cycles = Math.floor(elapsed / intervalMs) + 1;
                                    nextRepeat = nextRepeat + cycles * intervalMs;
                                }
                                nextTime = nextRepeat;
                                nextLabel = currentReminderLabel;
                                isRepeatingCurrent = true;
                                intervalMins = reminder.repeatIntervalMinutes;
                                logger.flow("OverdueItems", "next-trigger:current-repeat", {
                                    path: item.file.path,
                                    reminderId: currentReminderId,
                                    nextTriggerTime: nextRepeat,
                                    intervalMins,
                                });
                            } else if (now < tTime) {
                                // Future non-repeating trigger
                                nextTime = tTime;
                                nextLabel = currentReminderLabel;
                                logger.flow("OverdueItems", "next-trigger:current-future", {
                                    path: item.file.path,
                                    reminderId: currentReminderId,
                                    nextTriggerTime: tTime,
                                });
                            }
                        }
                    }
                }
            }

            // PHASE 2: If current reminder won't fire again, look for next DIFFERENT reminder
            if (nextTime === undefined) {
                for (const reminder of reminders) {
                    if (!reminder.enabled) continue;
                    // Skip the current reminder - we want to see what's NEXT
                    if (reminder.id === currentReminderId) continue;
                    const ctx = buildEffectiveReminderContextForTarget(target, fm, reminder.property, settings);
                    if (!ctx) continue;
                    if (shouldIgnoreForReminder(item.file, cache, ctx.frontmatter, reminder, ignorePaths, ignoreTags, ignoreStatuses, ignoreCheckboxStates, getReminderTagsForTarget(target), getReminderCancellationStatuses(ctx.frontmatter, settings.canceledStatusValue, settings.nativeCalendarCancellationState))) continue;
                    if (!hasRequiredStatus(ctx.frontmatter, reminder)) continue;
                    if (!hasRequiredCheckboxState(ctx.frontmatter, reminder)) continue;
                    if (reminder.stopConditions.some((cond) => checkStopCondition(ctx.frontmatter, cond))) continue;
                    const { start: pt, end: ret } = parseTimeRange(ctx.propertyValue);
                    if (!pt) continue;
                    const eet = getEffectiveEndTime(pt, ret, ctx.frontmatter);
                    const isAllDayCtx = isAllDayEvent(ctx.propertyValue, ctx.frontmatter) &&
                        (!hasExplicitTimeInValue(ctx.propertyValue) || String(ctx.frontmatter?.allDay ?? '').toLowerCase() === 'true');
                    if (reminder.allDayFilter && reminder.allDayFilter !== 'any') {
                        if (reminder.allDayFilter === 'true' && !isAllDayCtx) continue;
                        if (reminder.allDayFilter === 'false' && isAllDayCtx) continue;
                    }
                    const effectiveBase = reminder.allDayBaseTime || settings.defaultAllDayBaseTime;
                    const base = getReminderTriggerBase(pt, eet, isAllDayCtx, reminder.triggerAtEnd, effectiveBase);
                    if (!base) continue;
                    let offMs = reminder.offsetMinutes * 60 * 1000;
                    if (reminder.useSmartOffset && reminder.smartOffsetProperty) {
                        const dm = parseDuration(ctx.frontmatter[reminder.smartOffsetProperty]);
                        const sm = dm * 60 * 1000;
                        offMs = reminder.smartOffsetOperator === 'subtract' ? -sm : sm;
                    }
                    const tTime = base + offMs;
                    
                    // Only consider FUTURE triggers (not currently firing)
                    if (now < tTime) {
                        if (nextTime === undefined || tTime < nextTime) {
                            nextTime = tTime;
                            nextLabel = reminder.label || reminder.id;
                            logger.flow("OverdueItems", "next-trigger:different-reminder", {
                                path: item.file.path,
                                reminderId: reminder.id,
                                nextTriggerTime: tTime,
                            });
                        }
                    }
                }
            }
            
            // Set the annotation fields
            if (nextTime !== undefined) {
                item.nextTriggerTime = nextTime;
                item.nextRuleLabel = nextLabel;
                item.isRepeating = isRepeatingCurrent;
                if (isRepeatingCurrent) {
                    item.nextReminderIntervalMinutes = intervalMins;
                }
            }
        }

        logger.flow("OverdueItems", "scan:done", {
            files: files.length,
            targets: targetCount,
            matchedBeforeDedupe,
            staleOneShotHidden,
            visibleBeforeDedupe: visibleOverdueItems.length,
            deduplicated: deduplicated.length,
            durationMs: Math.round(performance.now() - started),
            sortDirection: this.getSettings().notificationSortDirection === "desc" ? "desc" : "asc",
        });
        return deduplicated;
    }

    private getTaskCheckboxState(rawLine: unknown): string | undefined {
        const match = String(rawLine || "").match(/^\s*(?:[-*+]|\d+[.)])\s+\[([^\]]?)]\s+/);
        if (!match) return undefined;
        return String(match[1] || "").trim().toLowerCase() || " ";
    }

    private reminderIncludesSource(
        reminder: TPSControllerSettings["reminders"][number],
        sourceType: "file" | "external-event",
    ): boolean {
        const configured = Array.isArray(reminder.sourceTypes) ? reminder.sourceTypes.filter(Boolean) : [];
        if (configured.length > 0) return configured.includes(sourceType);
        if (sourceType === "external-event") return !!reminder.includeUnmatchedExternalEvents;
        return sourceType === "file";
    }

    private getReminderPropertySource(
        target: import('./reminder-target-service').ReminderEvaluationTarget,
        reminderProperty: string,
    ): OverdueItem["reminderPropertySource"] {
        if (target.sourceType === "external-event") return "external-event";
        if (target.targetKind !== "task") return "note";
        const normalizedReminderProperty = String(reminderProperty || "").trim().toLowerCase();
        const taskKeys = new Set((target.taskPropertyKeys || []).map((key) => String(key || "").trim().toLowerCase()));
        return normalizedReminderProperty && taskKeys.has(normalizedReminderProperty) ? "task" : "note";
    }

    private formatTimeDiff(diffMs: number): string {
        const diffMins = Math.floor(diffMs / 60000);
        if (diffMins < 0) {
            const absM = Math.abs(diffMins);
            if (absM < 60) return `in ${absM} min`;
            if (absM < 1440) return `in ${Math.floor(absM / 60)}h ${absM % 60}m`;
            const d = Math.floor(absM / 1440);
            return `in ${d}d ${Math.floor((absM % 1440) / 60)}h ${absM % 60}m`;
        }
        if (diffMins < 60) return `${diffMins} min ago`;
        if (diffMins < 1440) return `${Math.floor(diffMins / 60)}h ${diffMins % 60}m ago`;
        const d = Math.floor(diffMins / 1440);
        return `${d}d ${Math.floor((diffMins % 1440) / 60)}h ${diffMins % 60}m ago`;
    }

    private getGcmBulkEditService(): any | null {
        const plugins = (this.app as any)?.plugins;
        const plugin =
            plugins?.getPlugin?.("tps-global-context-menu") ||
            plugins?.plugins?.["tps-global-context-menu"] ||
            plugins?.getPlugin?.("TPS-Global-Context-Menu (Dev)") ||
            plugins?.plugins?.["TPS-Global-Context-Menu (Dev)"];
        return plugin?.bulkEditService || plugin?.api?.bulkEditService || null;
    }

    private async requireGcmStatusResult(
        file: TFile,
        statusKey: string,
        status: string | null,
        changed: unknown,
    ): Promise<void> {
        if (typeof changed === "number" && Number.isSafeInteger(changed) && changed > 0) return;
        // GCM returns zero for both refused/failed writes and genuine no-ops.
        // Confirm a no-op from the exact current note, never stale metadata or
        // another file that has since occupied its former path.
        const path = file.path;
        if (changed === 0 && this.app.vault.getAbstractFileByPath(path) === file) {
            const content = await this.app.vault.read(file);
            if (file.path === path && this.app.vault.getAbstractFileByPath(path) === file) {
                const info = getFrontMatterInfo(content);
                if (!info.exists && /^\ufeff?---(?:\r?\n|$)/u.test(content)) {
                    throw new Error("Reminder frontmatter is incomplete.");
                }
                const hasYamlValue = info.frontmatter.split(/\r?\n/u).some(line => line.trim() && !line.trim().startsWith("#"));
                const fm = info.exists && hasYamlValue ? parseYaml(info.frontmatter) : {};
                if (fm && typeof fm === "object" && !Array.isArray(fm)
                    && [Object.prototype, null].includes(Object.getPrototypeOf(fm))) {
                    const keys = Object.keys(fm).filter(key => key.trim().toLowerCase() === statusKey.trim().toLowerCase());
                    if (status === null && keys.length === 0) return;
                    if (status !== null && keys.length === 1 && typeof fm[keys[0]] === "string"
                        && fm[keys[0]].trim().toLowerCase() === status.trim().toLowerCase()) return;
                }
            }
        }
        throw new Error("The reminder status change was not applied. Review the note and try again.");
    }

    async setItemStatus(item: OverdueItem, status: string | null): Promise<void> {
        if (item.targetKind === "task") {
            logger.flowWarn("OverdueAction", "task-line:status-disabled", { path: item.file.path });
            return;
        }
        const statusKey = this.getSettings().statusKey || "status";
        const isStatusClear = status == null || String(status).trim() === "";
        const resolvedStatus = isStatusClear ? null : status;
        logger.flow("OverdueAction", "status:set-start", {
            path: item.file.path,
            targetKind: item.targetKind || "note",
            taskLine: typeof item.taskLine === "number" ? item.taskLine : -1,
            status: resolvedStatus || "",
        });
        const bulkEditService = this.getGcmBulkEditService();
        if (bulkEditService) {
            if (isStatusClear) {
                if (typeof bulkEditService.updateFrontmatter === "function") {
                    const changed = await bulkEditService.updateFrontmatter([item.file], { [statusKey]: null });
                    await this.requireGcmStatusResult(item.file, statusKey, null, changed);
                    this.triggerFilesUpdated([item.file.path]);
                    logger.flow("OverdueAction", "status:set-done", { route: "gcm-update-frontmatter-clear", path: item.file.path });
                    return;
                }
            } else if (typeof bulkEditService.setStatus === "function") {
                const changed = await bulkEditService.setStatus([item.file], resolvedStatus);
                await this.requireGcmStatusResult(item.file, statusKey, resolvedStatus, changed);
                this.triggerFilesUpdated([item.file.path]);
                logger.flow("OverdueAction", "status:set-done", { route: "gcm-set-status", path: item.file.path, status: resolvedStatus });
                return;
            } else if (typeof bulkEditService.updateFrontmatter === "function") {
                const changed = await bulkEditService.updateFrontmatter([item.file], { [statusKey]: resolvedStatus });
                await this.requireGcmStatusResult(item.file, statusKey, resolvedStatus, changed);
                this.triggerFilesUpdated([item.file.path]);
                logger.flow("OverdueAction", "status:set-done", { route: "gcm-update-frontmatter", path: item.file.path, status: resolvedStatus });
                return;
            }
        }

        const now = (window as any).moment
            ? (window as any).moment().format('YYYY-MM-DD HH:mm:ss')
            : new Date().toISOString().replace('T', ' ').slice(0, 19);
        const normalized = String(resolvedStatus || "").trim().toLowerCase();
        const isDone = normalized === "complete" || normalized === "wont-do";

        await this.app.fileManager.processFrontMatter(item.file, (fm) => {
            const existingStatusKey = Object.keys(fm).find((key) => key.trim().toLowerCase() === statusKey.trim().toLowerCase());
            if (isStatusClear) {
                if (existingStatusKey) delete fm[existingStatusKey];
            } else {
                fm[existingStatusKey || statusKey] = resolvedStatus;
            }
            const cdKey = Object.keys(fm).find((k) => k.toLowerCase() === 'completeddate');
            if (isDone) {
                fm[cdKey || "completedDate"] = now;
            } else if (cdKey) {
                delete fm[cdKey];
            }
        });
        this.triggerFilesUpdated([item.file.path]);
        logger.flow("OverdueAction", "status:set-done", {
            route: "frontmatter",
            path: item.file.path,
            status: resolvedStatus || "",
            completedDate: isDone,
        });
    }

    async snoozeItem(item: OverdueItem, minutes: number): Promise<void> {
        if (item.targetKind === "task") {
            logger.flowWarn("OverdueAction", "task-line:snooze-disabled", { path: item.file.path });
            return;
        }
        logger.flow("OverdueAction", "snooze:start", {
            path: item.file.path,
            targetKind: item.targetKind || "note",
            minutes,
        });
        await this.snoozeFile(item.file, minutes);
        logger.flow("OverdueAction", "snooze:done", {
            route: "frontmatter",
            path: item.file.path,
            minutes,
        });
    }

    async markItemComplete(item: OverdueItem): Promise<void> {
        await this.setItemStatus(item, "complete");
    }

    async completeItemFromNativeNotification(item: OverdueItem): Promise<boolean> {
        if (item.targetKind === "task") return false;
        await this.setItemStatus(item, "complete");
        return true;
    }

    async snoozeItemFromNativeNotification(item: OverdueItem, minutes: number): Promise<boolean> {
        if (item.targetKind === "task") return false;
        await this.snoozeFile(item.file, minutes);
        return true;
    }

    async markItemWontDo(item: OverdueItem): Promise<void> {
        await this.setItemStatus(item, "wont-do");
    }

    async resolveTaskReminder(item: OverdueItem): Promise<boolean> {
        if (item.targetKind === "task") {
            logger.flowWarn("OverdueAction", "task-line:resolve-disabled", { path: item.file?.path || "" });
            return false;
        }
        const property = item.reminderProperty || item.reminder.property || this.getSettings().startProperty || "scheduled";
        logger.flow("OverdueAction", "resolve-reminder:start", {
            path: item.file?.path,
            targetKind: item.targetKind,
            taskLine: item.taskLine,
            taskTitle: item.taskTitle,
            reminderPropertySource: item.reminderPropertySource,
            property,
        });
        await this.clearFileReminderProperty(item.file, property);
        new Notice(`Cleared ${property}.`);
        logger.flow("OverdueAction", "resolve-reminder:done", {
            route: "note-clear",
            path: item.file.path,
            property,
        });
        return true;
    }

    private async clearFileReminderProperty(file: TFile, property: string): Promise<void> {
        const normalized = String(property || "").trim().toLowerCase();
        await this.app.fileManager.processFrontMatter(file, (fm) => {
            const key = Object.keys(fm).find((candidate) => candidate.trim().toLowerCase() === normalized) || property;
            delete fm[key];
        });
        this.triggerFilesUpdated([file.path]);
        logger.flow("OverdueAction", "reminder-property:cleared", { path: file.path, property });
    }

    async snoozeFile(file: TFile, minutes: number): Promise<void> {
        const snoozeKey = this.getSettings().snoozeProperty || "reminderSnooze";
        const snoozeTimeStr = minutes > 0
            ? moment().add(minutes, "minutes").format("YYYY-MM-DD HH:mm")
            : "";
        logger.flow("OverdueAction", "snooze-file:start", { path: file.path, minutes, snoozeKey });
        await this.app.fileManager.processFrontMatter(file, (fm) => {
            const existingSnoozeKey = Object.keys(fm).find((key) => key.trim().toLowerCase() === snoozeKey.trim().toLowerCase());
            if (snoozeTimeStr) {
                fm[existingSnoozeKey || snoozeKey] = snoozeTimeStr;
            } else if (existingSnoozeKey) {
                delete fm[existingSnoozeKey];
            }
        });
        logger.flow("OverdueAction", "snooze-file:done", { path: file.path, minutes, cleared: !snoozeTimeStr });
    }

    openFile(file: TFile): void {
        logger.flow("OverdueAction", "open-file", { path: file.path });
        void this.openFileAtLine(file);
    }

    async openItem(item: OverdueItem): Promise<void> {
        logger.flow("OverdueAction", "open-item", {
            path: item.file.path,
            targetKind: item.targetKind || "note",
            taskLine: typeof item.taskLine === "number" ? item.taskLine : -1,
        });
        await this.openFileAtLine(item.file, item.taskLine);
    }

    private async openFileAtLine(file: TFile, lineNumber?: number): Promise<void> {
        const safeLine = typeof lineNumber === "number" && Number.isFinite(lineNumber)
            ? Math.max(0, Math.floor(lineNumber))
            : undefined;
        const gcm = (this.app as any).plugins?.plugins?.["tps-global-context-menu"] as
            | { openFileInLeaf?: (file: TFile, context: false, getLeaf: () => WorkspaceLeaf | null, options?: { revealLeaf?: boolean; active?: boolean }) => Promise<boolean> }
            | undefined;

        let leaf: WorkspaceLeaf | null = null;
        const opened = gcm?.openFileInLeaf
            ? await gcm.openFileInLeaf(file, false, () => this.app.workspace.getLeaf(false), {
                active: true,
                revealLeaf: true,
            })
            : false;
        logger.flow("OverdueAction", "open-file:route", {
            path: file.path,
            line: safeLine ?? -1,
            route: opened ? "gcm-open-file-in-leaf" : "workspace-open-file",
        });

        if (opened) {
            leaf = this.findOpenMarkdownLeaf(file) ?? this.app.workspace.activeLeaf;
        } else {
            leaf = this.app.workspace.getLeaf(true);
            if (!leaf) {
                logger.flowWarn("OverdueAction", "open-file:no-leaf", { path: file.path });
                return;
            }
            await leaf.openFile(file, {
                active: true,
                eState: safeLine !== undefined ? { line: safeLine } : undefined,
            });
            this.app.workspace.setActiveLeaf(leaf, { focus: true } as any);
            this.app.workspace.revealLeaf(leaf);
        }

        if (!leaf) {
            logger.flowWarn("OverdueAction", "open-file:no-open-leaf", { path: file.path });
            return;
        }
        if (safeLine !== undefined) {
            await this.revealEditorLine(leaf, safeLine);
        }
        logger.flow("OverdueAction", "open-file:done", { path: file.path, line: safeLine ?? -1 });
    }

    private findOpenMarkdownLeaf(file: TFile): WorkspaceLeaf | null {
        let match: WorkspaceLeaf | null = null;
        this.app.workspace.iterateAllLeaves((leaf) => {
            if (match) return;
            const viewFile = (leaf.view as any)?.file;
            if (viewFile instanceof TFile && viewFile.path === file.path) {
                match = leaf;
            }
        });
        return match;
    }

    private async revealEditorLine(leaf: WorkspaceLeaf, lineNumber: number): Promise<void> {
        for (let attempt = 0; attempt < 6; attempt++) {
            const view = leaf.view;
            const editor = view instanceof MarkdownView ? view.editor : (view as any)?.editor;
            if (editor) {
                const safeLine = Math.max(0, Math.min(lineNumber, Math.max(0, editor.lineCount() - 1)));
                const lineText = editor.getLine(safeLine) || "";
                const from = { line: safeLine, ch: 0 };
                const to = { line: safeLine, ch: Math.max(0, lineText.length) };
                editor.focus();
                editor.setSelection(from, to);
                editor.scrollIntoView({ from, to }, true);
                if (view instanceof MarkdownView) this.flashEditorLine(view, safeLine);
                return;
            }
            await new Promise((resolve) => window.setTimeout(resolve, 50));
        }
    }

    private flashEditorLine(view: MarkdownView, lineNumber: number): void {
        const editorView = (view.editor as any)?.cm;
        if (!editorView?.state?.doc || typeof editorView.domAtPos !== "function") return;

        const run = () => {
            try {
                const docLine = editorView.state.doc.line(Math.max(1, lineNumber + 1));
                const domAtLine = editorView.domAtPos(docLine.from);
                const node = domAtLine?.node;
                const element = node instanceof HTMLElement ? node : node?.parentElement;
                const lineEl =
                    element?.closest?.(".cm-line") ||
                    view.contentEl.querySelector<HTMLElement>(".cm-line.cm-active");
                if (!(lineEl instanceof HTMLElement)) return;

                const previous = {
                    backgroundColor: lineEl.style.backgroundColor,
                    boxShadow: lineEl.style.boxShadow,
                    borderRadius: lineEl.style.borderRadius,
                    transition: lineEl.style.transition,
                };

                lineEl.style.transition = "background-color 220ms ease, box-shadow 220ms ease";
                lineEl.style.backgroundColor = "color-mix(in srgb, var(--interactive-accent) 24%, transparent)";
                lineEl.style.boxShadow = "inset 3px 0 0 var(--interactive-accent)";
                lineEl.style.borderRadius = "4px";

                window.setTimeout(() => {
                    lineEl.style.backgroundColor = previous.backgroundColor;
                    lineEl.style.boxShadow = previous.boxShadow;
                    lineEl.style.borderRadius = previous.borderRadius;
                    lineEl.style.transition = previous.transition;
                }, 1400);
            } catch {
                // Ignore stale editor positions while Obsidian is changing leaves.
            }
        };

        window.requestAnimationFrame(() => window.requestAnimationFrame(run));
    }

    async markFileComplete(file: TFile): Promise<void> {
        logger.flow("OverdueAction", "mark-file-complete:start", { path: file.path });
        const statusKey = this.getSettings().statusKey || "status";
        const bulkEditService = this.getGcmBulkEditService();
        if (typeof bulkEditService?.setStatus === "function") {
            const changed = await bulkEditService.setStatus([file], "complete");
            await this.requireGcmStatusResult(file, statusKey, "complete", changed);
            this.triggerFilesUpdated([file.path]);
            logger.flow("OverdueAction", "mark-file-complete:done", { path: file.path, route: "gcm-set-status" });
            return;
        }

        const now = (window as any).moment
            ? (window as any).moment().format('YYYY-MM-DD HH:mm:ss')
            : new Date().toISOString().replace('T', ' ').slice(0, 19);
        await this.app.fileManager.processFrontMatter(file, (fm) => {
            const statusKey = this.getSettings().statusKey || 'status';
            const existing = Object.keys(fm).find(key => key.toLowerCase() === statusKey.toLowerCase());
            fm[existing || statusKey] = 'complete';
            fm.completedDate = now;
        });
        this.triggerFilesUpdated([file.path]);
        logger.flow("OverdueAction", "mark-file-complete:done", { path: file.path, route: "frontmatter" });
    }

    async markFileWontDo(file: TFile): Promise<void> {
        logger.flow("OverdueAction", "mark-file-wont-do:start", { path: file.path });
        const now = (window as any).moment
            ? (window as any).moment().format('YYYY-MM-DD HH:mm:ss')
            : new Date().toISOString().replace('T', ' ').slice(0, 19);
        await this.app.fileManager.processFrontMatter(file, (fm) => {
            const statusKey = this.getSettings().statusKey || 'status';
            const existing = Object.keys(fm).find(key => key.toLowerCase() === statusKey.toLowerCase());
            fm[existing || statusKey] = 'wont-do';
            fm.completedDate = now;
        });
        this.triggerFilesUpdated([file.path]);
        logger.flow("OverdueAction", "mark-file-wont-do:done", { path: file.path, route: "frontmatter" });
    }

    private triggerFilesUpdated(paths: string[]): void {
        emitFilesUpdated(this.app, paths, "tps-controller");
    }
}
