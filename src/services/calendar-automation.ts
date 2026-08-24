import { App, Notice, normalizePath } from "obsidian";
import { AutoCreateService } from "./auto-create-service";
import { ExternalCalendarService } from "./external-calendar-service";
import type { TPSControllerSettings, ExternalCalendarConfig } from "../types";
import { normalizeCalendarUrl, normalizeCalendarTag } from "../utils";
import * as logger from "../logger";
import { TPS_EVENTS } from "../tps-events";
import { NativeCalendarRecordService } from "./native-calendar-record-service";

interface CalendarPluginAPI {
    getSettings?(): any;
}

/**
 * Manages the calendar sync interval loop, calendar event fetching,
 * and orphan/quarantine review. Holds its own interval ID.
 */
export class CalendarAutomationService {
    private calendarSyncIntervalId: number | null = null;
    private activeSyncPromise: Promise<void> | null = null;

    constructor(
        private app: App,
        private autoCreateService: AutoCreateService,
        private externalCalendarService: ExternalCalendarService,
        private nativeCalendarRecordService: NativeCalendarRecordService,
        private getSettings: () => TPSControllerSettings,
        private getCalendarPlugin: () => CalendarPluginAPI | null,
        private onSyncComplete: () => Promise<void>,
        private getSyncReadiness: () => { ready: boolean; reason: string }
    ) {}

    start(): void {
        this.stop();

        const settings = this.getSettings();
        const initialScanRoots = this.buildScanRoots(settings.externalCalendars || [], settings.archiveFolder);
        this.autoCreateService.updateConfig({
            allowAutoCreate: true,
            noLossSyncMode: settings.noLossSyncMode ?? true,
            eventIdKey: settings.eventIdKey,
            uidKey: settings.uidKey,
            titleKey: settings.titleKey,
            statusKey: settings.statusKey,
            previousStatusKey: settings.previousStatusKey,
            startProperty: settings.startProperty,
            endProperty: settings.endProperty,
            syncOnEventDelete: settings.syncOnEventDelete,
            archiveFolder: settings.archiveFolder,
            globalIgnorePaths: settings.globalIgnorePaths || [],
            canceledStatusValue: settings.canceledStatusValue,
            scanRootFolders: initialScanRoots,
        });

        // Defer the first sync until after the workspace and metadata cache are
        // ready. Calling runSync() during onload() means getFileCache() returns
        // null for almost every file, byEventId is empty, and the service tries
        // to create notes that already exist → "File already exists" errors.
        this.app.workspace.onLayoutReady(() => {
            void this.runSync();
        });

        const minutes = Math.max(1, settings.syncIntervalMinutes || 5);
        const intervalMs = minutes * 60 * 1000;
        logger.flow("CalendarSync", "loop:start", {
            intervalMinutes: minutes,
            scanRoots: initialScanRoots.length,
            calendars: settings.externalCalendars?.length || 0,
        });
        this.calendarSyncIntervalId = window.setInterval(() => {
            logger.flow("CalendarSync", "loop:tick");
            void this.runSync();
        }, intervalMs);
    }

    stop(): void {
        if (this.calendarSyncIntervalId !== null) {
            window.clearInterval(this.calendarSyncIntervalId);
            this.calendarSyncIntervalId = null;
            logger.flow("CalendarSync", "loop:stopped");
        }
    }

    runSync(force = false, options: { backfillPastEvents?: boolean } = {}): Promise<void> {
        const backfillPastEvents = options.backfillPastEvents === true;
        if (this.activeSyncPromise) {
            logger.flow("CalendarSync", "run:join-active", { force, backfillPastEvents });
            return this.activeSyncPromise;
        }

        const run = Promise.resolve().then(() => this.executeSync(force, { backfillPastEvents }));
        this.activeSyncPromise = run;
        const clearActiveRun = () => {
            if (this.activeSyncPromise === run) this.activeSyncPromise = null;
        };
        void run.then(clearActiveRun, clearActiveRun);
        return run;
    }

    private async executeSync(force: boolean, options: { backfillPastEvents: boolean }): Promise<void> {
        await logger.timeAsync("CalendarSync", "run", {
            force,
            backfillPastEvents: options.backfillPastEvents,
        }, async () => {
            this.app.workspace.trigger(TPS_EVENTS.CALENDAR_SYNC_STARTED as any, {
                sourcePluginId: "tps-controller",
                timestamp: Date.now(),
                force,
            });
            const readiness = this.getSyncReadiness();
            logger.flow("CalendarSync", "readiness", readiness);
            if (!readiness.ready) {
                logger.flowWarn("CalendarSync", "skip:not-ready", { reason: readiness.reason, force });
                if (force) new Notice(`Calendar Sync skipped: ${readiness.reason}`);
                return;
            }

            const settings = this.getSettings();

            let calendars: ExternalCalendarConfig[] = settings.externalCalendars || [];
            let calendarSource = "controller-settings";

            if (!calendars.length) {
                const calPlugin = this.getCalendarPlugin();
                if (calPlugin) {
                    const calSettings = calPlugin.getSettings?.();
                    if (calSettings?.externalCalendars?.length) {
                        calendars = calSettings.externalCalendars;
                        calendarSource = "calendar-plugin-fallback";
                        logger.flow("CalendarSync", "calendars:fallback", { calendars: calendars.length });
                    }
                }
            }

            const urls: string[] = Array.from(new Set(
                calendars
                    .filter((c) => c.enabled !== false)
                    .map((c) => normalizeCalendarUrl(c.url))
                    .filter(Boolean)
            ));
            logger.flow("CalendarSync", "calendars:resolved", {
                source: calendarSource,
                calendars: calendars.length,
                enabledUrls: urls.length,
            });

            if (!urls.length) {
                logger.flowWarn("CalendarSync", "skip:no-urls", { calendars: calendars.length, force });
                if (force) new Notice("Calendar Sync skipped: no calendar URLs are configured.");
                return;
            }

            if (settings.calendarStorageMode === "native-records") {
                const result = await this.nativeCalendarRecordService.sync(
                    calendars,
                    settings.externalCalendarFilter,
                    force,
                    options.backfillPastEvents,
                );
                await this.onSyncComplete();
                this.app.workspace.trigger(TPS_EVENTS.CALENDAR_SYNC_COMPLETED as any, {
                    sourcePluginId: "tps-controller",
                    timestamp: Date.now(),
                    force,
                    urlCount: urls.length,
                    storage: "native-records",
                });
                logger.flow("CalendarSync", "run:completed", {
                    force,
                    urlCount: urls.length,
                    storage: "native-records",
                    fetched: result.fetched,
                    created: result.created,
                    updated: result.updated,
                    failedFeeds: result.failedFeeds,
                });
                return;
            }

            const scanRoots = this.buildScanRoots(calendars, settings.archiveFolder);
            logger.flow("CalendarSync", "scan-roots:resolved", {
                scanRoots: scanRoots.length,
                archiveFolder: settings.archiveFolder || "",
            });
            if (!scanRoots.length) {
                logger.flowWarn("CalendarSync", "skip:no-scan-roots", { force });
                if (force) new Notice("Calendar Sync skipped: no calendar note folder is configured.");
                return;
            }

            const calendarConfigs: Record<string, any> = Object.fromEntries(
                calendars
                    .filter((c) => c.url)
                    .map((c) => [
                        normalizeCalendarUrl(c.url),
                        {
                            mode: c.autoCreateMode || "note",
                            taskDestination: c.autoCreateTaskDestination || "daily-note",
                            taskTargetPath: this.resolveTaskTargetPath(c),
                            taskNoteStrategy: c.autoCreateTaskNoteStrategy || "occurrence-day",
                            taskNoteFolder: c.autoCreateTaskNoteFolder || "Calendar Events",
                            typeFolder: c.autoCreateTypeFolder || "",
                            folder: c.autoCreateFolder || "",
                            tag: normalizeCalendarTag(c.autoCreateTag || ""),
                            template: c.autoCreateTemplate || "",
                            autoCreateEnabled: c.autoCreateEnabled !== false,
                        },
                    ])
            );
            logger.flow("CalendarSync", "auto-create-configs", {
                configs: Object.keys(calendarConfigs).length,
                noteMode: Object.values(calendarConfigs).filter((config: any) => config.mode !== "task").length,
                taskMode: Object.values(calendarConfigs).filter((config: any) => config.mode === "task").length,
                disabled: Object.values(calendarConfigs).filter((config: any) => config.autoCreateEnabled === false).length,
            });

            this.autoCreateService.updateConfig({
                allowAutoCreate: true,
                noLossSyncMode: settings.noLossSyncMode ?? true,
                eventIdKey: settings.eventIdKey,
                uidKey: settings.uidKey,
                titleKey: settings.titleKey,
                statusKey: settings.statusKey,
                previousStatusKey: settings.previousStatusKey,
                startProperty: settings.startProperty,
                endProperty: settings.endProperty,
                syncOnEventDelete: settings.syncOnEventDelete,
                archiveFolder: settings.archiveFolder,
                globalIgnorePaths: settings.globalIgnorePaths || [],
                canceledStatusValue: settings.canceledStatusValue,
                scanRootFolders: scanRoots,
            });

            await this.autoCreateService.checkAndCreateMeetingNotes(
                this.externalCalendarService,
                urls,
                settings.externalCalendarFilter,
                calendarConfigs,
                force,
                { backfillPastEvents: options.backfillPastEvents },
            );

            await this.onSyncComplete();
            this.app.workspace.trigger(TPS_EVENTS.CALENDAR_SYNC_COMPLETED as any, {
                sourcePluginId: "tps-controller",
                timestamp: Date.now(),
                force,
                urlCount: urls.length,
            });
            logger.flow("CalendarSync", "run:completed", { force, urlCount: urls.length, scanRoots: scanRoots.length });
        });
    }

    private buildScanRoots(calendars: ExternalCalendarConfig[], archiveFolder: string): string[] {
        const roots = new Set<string>();
        const addRoot = (value: string | null | undefined) => {
            const normalized = this.normalizeScanRoot(value);
            if (normalized) roots.add(normalized);
        };

        addRoot(archiveFolder);
        for (const calendar of calendars || []) {
            if (calendar?.autoCreateEnabled === false) continue;
            const typeFolder = this.normalizeScanRoot(calendar?.autoCreateTypeFolder);
            const folder = this.normalizeScanRoot(calendar?.autoCreateFolder);
            const taskTargetFolder = this.normalizeScanRoot(this.getParentPath(this.resolveTaskTargetPath(calendar)));
            if (typeFolder || folder || taskTargetFolder) {
                if (typeFolder) roots.add(typeFolder);
                if (folder) roots.add(folder);
                if (taskTargetFolder) roots.add(taskTargetFolder);
            } else {
                roots.add("");
            }
        }

        return Array.from(roots);
    }

    private normalizeScanRoot(value: string | null | undefined): string | null {
        if (typeof value !== "string") return null;
        const normalized = normalizePath(value).replace(/^\/+|\/+$/g, "").trim();
        if (!normalized) return null;
        if (normalized === "." || normalized === "/") return null;
        return normalized;
    }

    private getParentPath(value: string | null | undefined): string | null {
        if (typeof value !== "string") return null;
        const normalized = normalizePath(value.trim().replace(/^\[\[|\]\]$/g, "").replace(/^\/+/, ""));
        const withExtension = normalized.toLowerCase().endsWith(".md") ? normalized : `${normalized}.md`;
        const index = withExtension.lastIndexOf("/");
        return index > 0 ? withExtension.slice(0, index) : "";
    }

    private resolveTaskTargetPath(calendar: ExternalCalendarConfig | null | undefined): string {
        if (!calendar || calendar.autoCreateMode !== "task") return "";
        const explicit = typeof calendar.autoCreateTaskTargetPath === "string"
            ? this.normalizeTaskTargetPath(calendar.autoCreateTaskTargetPath)
            : "";
        if (explicit) return explicit;
        return "";
    }

    private normalizeTaskTargetPath(value: string): string {
        const normalized = normalizePath(String(value || "")
            .trim()
            .replace(/^\[\[|\]\]$/g, "")
            .replace(/^\/+/, ""));
        if (!normalized || normalized === "." || normalized === ".md" || normalized.endsWith("/.md")) return "";
        return normalized.toLowerCase().endsWith(".md") ? normalized : `${normalized}.md`;
    }

    async reviewQuarantine(): Promise<void> {
        const candidates = await this.autoCreateService.getOrphanCandidateFiles();
        if (!candidates.length) {
            new Notice("No calendar quarantine candidates found.");
            return;
        }
        const first = candidates[0];
        const leaf = this.app.workspace.getLeaf(false);
        if (leaf) await leaf.openFile(first, { active: true });
        new Notice(`Calendar quarantine: ${candidates.length} candidate notes. Opened: ${first.basename}`);
    }
}
