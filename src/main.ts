import { Plugin, Notice, Platform, TFile, WorkspaceLeaf, moment, normalizePath } from "obsidian";
import { DeviceRoleManager, DeviceRole } from "./device-role-manager";
import { TPSControllerSettings, DEFAULT_CONTROLLER_SETTINGS } from "./types";
import { AutoCreateService } from "./services/auto-create-service";
import { ExternalCalendarService } from "./services/external-calendar-service";
import { ReminderEngine, PendingNotification } from "./services/reminder-engine";
import { SyncRequestService } from "./services/sync-request-service";
import { SyncConflictWatcher } from "./services/sync-conflict-watcher";
import { TPSControllerSettingTab } from "./settings-tab";
import * as logger from "./logger";
import { getPluginById, isPluginEnabled } from "./core";
import { NotificationView, NOTIFICATION_VIEW_TYPE } from "./views/notification-view";
import { OverdueItemsModal } from "./modals/overdue-modal";
import type { AlertState, OverdueItem } from "./types";
import { OverdueService } from "./services/overdue-service";
import { CalendarAutomationService } from "./services/calendar-automation";
import { migrateSettingsFromPlugins } from "./services/migration-service";
import { ExternalCalendarDuplicateCleanupService } from "./services/external-calendar-duplicate-cleanup-service";
import { TPS_EVENTS } from "./tps-events";
import { shouldDeferCalendarSyncSettlementForPath } from "./services/calendar-sync-settlement-filter";

const normalizeTaskTargetPathSetting = (value: string): string => {
    const normalized = normalizePath(String(value || "").trim().replace(/^\[\[|\]\]$/g, "").replace(/^\/+/, ""));
    if (!normalized) return "";
    return normalized.toLowerCase().endsWith(".md") ? normalized : `${normalized}.md`;
};

// ============================================================================
// Plugin API Types
// ============================================================================

interface CalendarPluginAPI {
    getSettings?(): any;
}

interface NotifierPluginAPI {
    sendNotification?(title: string, body: string, file?: TFile): Promise<void>;
    sendMessage?(text: string, file?: TFile, title?: string): Promise<void>;
}

interface ReminderNotificationBatch {
    title: string;
    body: string;
    file?: TFile;
    items: PendingNotification[];
}

interface GcmTimeTrackingSession {
    id: string;
    title: string;
    start: string;
    sourcePath?: string;
    targetPath?: string;
}

interface GcmPluginAPI {
    settings?: Record<string, any>;
    services?: any;
    timeTracking?: {
        getActiveTimers?(): Promise<GcmTimeTrackingSession[]>;
    };
    bulkEditService?: {
        checkMissingRecurrences?: () => Promise<void>;
        reconcileParentChildLinksForParent?: (parentFile: TFile) => Promise<number>;
        ensureParentSelfLinkForParent?: (parentFile: TFile) => Promise<boolean>;
    };
}

// ============================================================================
// Controller Plugin
// ============================================================================

export default class TPSControllerPlugin extends Plugin {
    settings: TPSControllerSettings;
    deviceRoleManager: DeviceRoleManager;
    private statusBarEl: HTMLElement;
    private readonly reminderStateSaveCooldownMs = 5 * 60 * 1000;
    private reminderStateNextSaveAt = 0;
    private reminderStateFlushTimer: number | null = null;
    private reminderStateSaveDirty = false;

    // Core services
    private autoCreateService: AutoCreateService;
    private externalCalendarService: ExternalCalendarService;
    private reminderEngine: ReminderEngine;
    private syncRequestService: SyncRequestService;
    private syncConflictWatcher: SyncConflictWatcher;

    // Feature services
    private overdueService: OverdueService;
    private calendarAutomation: CalendarAutomationService;
    private externalCalendarDuplicateCleanup: ExternalCalendarDuplicateCleanupService;

    // Reminder interval
    private reminderIntervalId: number | null = null;
    private reminderStartupTimeoutId: number | null = null;
    private timeTrackingReminderIntervalId: number | null = null;
    private timeTrackingReminderStartupTimeoutId: number | null = null;
    private syncRequestIntervalId: number | null = null;
    private parentChildMaintenanceIntervalId: number | null = null;
    private parentChildBootstrapIntervalId: number | null = null;
    private parentChildStartupResolvedHandled = false;
    private parentChildMaintenanceActivated = false;
    private metadataIndexResolved = false;
    private calendarSyncSettledAt = Date.now() + 20_000;
    private readonly calendarSyncSettleWindowMs = 20_000;
    private controllerReloadIntervalId: number | null = null;
    private controllerReloadInProgress = false;
    private readonly controllerReloadIntervalMs = 15 * 60 * 1000;

    async onload() {
        logger.log(" TPS-Controller loading...");
        try {
            const cssPath = `${this.manifest.dir}/styles-ui.css`;
            const cssContent = await this.app.vault.adapter.read(cssPath);
            this.register(() => document.head.querySelector('style#tps-controller-ui-styles')?.remove());
            const styleEl = document.head.createEl('style', { attr: { id: 'tps-controller-ui-styles' } });
            styleEl.textContent = cssContent;
        } catch (e) {
            console.warn("[TPS-Controller] Failed to load styles-ui.css", e);
        }

        await this.loadSettings();
        this.statusBarEl = this.addStatusBarItem();
        this.deviceRoleManager = new DeviceRoleManager(this.app, (role) => this.onRoleChanged(role));
        this.updateStatusBar(this.deviceRoleManager.role);

        // Core services
        this.autoCreateService = new AutoCreateService(this.app);
        this.externalCalendarService = new ExternalCalendarService();
        this.reminderEngine = new ReminderEngine(this.app, this.externalCalendarService);
        this.syncRequestService = new SyncRequestService(this.app, this.manifest.dir);
        this.syncConflictWatcher = new SyncConflictWatcher(this.app);

        // Feature services
        this.overdueService = new OverdueService(this.app, () => this.settings);
        this.calendarAutomation = new CalendarAutomationService(
            this.app,
            this.autoCreateService,
            this.externalCalendarService,
            () => this.settings,
            () => this.getCalendarPlugin(),
            () => this.runRecurrenceMaintenanceTick(),
            () => this.getCalendarSyncReadiness()
        );
        this.externalCalendarDuplicateCleanup = new ExternalCalendarDuplicateCleanupService(this.app, () => this.settings);

        // Commands
        this.addCommand({ id: "set-device-role-controller", name: "Set as Controller (Automation Source)", callback: () => { this.deviceRoleManager.setRole("controller"); new Notice("Device set to CONTROLLER."); } });
        this.addCommand({ id: "set-device-role-user", name: "Set as Replica (Passive)", callback: () => { this.deviceRoleManager.setRole("user"); new Notice("Device set to REPLICA."); } });
        this.addCommand({ id: "force-calendar-sync", name: "Force Calendar Sync Now", callback: () => { if (this.deviceRoleManager.isController()) void this.calendarAutomation.runSync(true); else void this.requestSync(["calendar"]); } });
        this.addCommand({ id: "backfill-past-calendar-events", name: "Backfill Past Calendar Events", callback: () => { if (this.deviceRoleManager.isController()) void this.calendarAutomation.runSync(true, { backfillPastEvents: true }); else new Notice("Past calendar backfill must be run on the controller device."); } });
        this.addCommand({
            id: "cleanup-duplicate-external-calendar-notes",
            name: "Clean Duplicate External Calendar Notes",
            callback: async () => {
                const result = await this.externalCalendarDuplicateCleanup.run();
                new Notice(`Calendar duplicate cleanup: archived ${result.archivedCount}, skipped ${result.skippedWithContent} with body content, found ${result.groupsFound} duplicate groups.`);
            },
        });
        this.addCommand({ id: "review-calendar-sync-quarantine", name: "Review Calendar Sync Quarantine", callback: () => { void this.calendarAutomation.reviewQuarantine(); } });
        this.addCommand({ id: "force-reminder-check", name: "Run Reminder Check Now", callback: () => { if (this.deviceRoleManager.isController()) void this.runReminderCheck(); else void this.requestSync(["reminders"]); } });
        this.addCommand({
            id: "reset-reminder-delivery-state",
            name: "Reset Reminder Delivery State",
            callback: () => {
                this.settings.alertState = {};
                this.persistAlertStateToLocalStorage(this.settings.alertState);
                this.reminderStateSaveDirty = false;
                new Notice("Reminder delivery state reset.");
            },
        });
        this.addCommand({ id: "open-notifications", name: "View Notifications", callback: () => { void this.overdueService.openNotificationModal(); } });
        this.addCommand({ id: "open-overdue-items", name: "View Overdue Items (Modal)", callback: () => { new OverdueItemsModal(this.app, this).open(); } });
        this.addCommand({
            id: "force-parent-child-reconcile",
            name: "Run Parent/Child Link Reconcile Now",
            callback: () => {
                if (this.deviceRoleManager.isController()) {
                    void this.runParentChildMaintenanceTick();
                } else {
                    new Notice("Parent/child reconcile runs on the Controller device.");
                }
            },
        });

        // View + Ribbon
        this.registerView(NOTIFICATION_VIEW_TYPE, (leaf) => new NotificationView(leaf, this));
        this.addRibbonIcon('bell', 'View Notifications', () => { void this.overdueService.openNotificationModal(); });

        // API
        (this as any).api = {
            isController: (): boolean => this.deviceRoleManager.isController(),
            getRole: (): DeviceRole => this.deviceRoleManager.role,
            getSettings: (): TPSControllerSettings => this.settings,
            getCalendarSettingsSnapshot: () => ({
                externalCalendars: Array.isArray(this.settings.externalCalendars) ? [...this.settings.externalCalendars] : [],
                externalCalendarFilter: this.settings.externalCalendarFilter || "",
            }),
            getReminders: () => this.settings.reminders || [],
            getOverdueItems: () => this.getOverdueItems(),
            snoozeFile: (file: TFile, minutes: number) => this.snoozeFile(file, minutes),
        };
        (window as any).TPS = { controller: (this as any).api };

        this.addSettingTab(new TPSControllerSettingTab(this.app, this));

        if (this.deviceRoleManager.isController()) {
            this.enterControllerMode();
        } else {
            if (!Platform.isMobile) {
                void this.requestSync(["calendar"]);
            } else {
                logger.log("Skipping automatic startup sync request on mobile replica.");
            }
        }

        // Ensure parent/child reconciliation runs once after initial metadata indexing on vault load.
        this.registerEvent(
            this.app.metadataCache.on("resolved", () => {
                this.metadataIndexResolved = true;
                this.deferCalendarSyncSettlement("metadata cache resolved");
                if (!this.deviceRoleManager.isController()) return;
                if (this.parentChildStartupResolvedHandled) return;
                this.parentChildStartupResolvedHandled = true;
                window.setTimeout(() => {
                    void this.runParentChildMaintenanceTick();
                }, 5000);
            })
        );

        this.registerEvent(this.app.vault.on("create", (file) => this.deferCalendarSyncSettlementForFile(file, "file create")));
        this.registerEvent(this.app.vault.on("modify", (file) => this.deferCalendarSyncSettlementForFile(file, "file modify")));
        this.registerEvent(this.app.vault.on("delete", (file) => this.deferCalendarSyncSettlementForFile(file, "file delete")));
        this.registerEvent(this.app.vault.on("rename", (file) => this.deferCalendarSyncSettlementForFile(file, "file rename")));

        logger.log(" TPS-Controller loaded");
    }

    async onunload() {
        this.stopControllerReloadLoop();
        this.stopAllAutomation();
        await this.saveSettings();
        await this.flushReminderStateNow();
        this.stopReminderStateFlushTimer();
        delete (this as any).api;
        delete (window as any).TPS;
    }

    // ========================================================================
    // Settings
    // ========================================================================

    async loadSettings() {
        const data = await this.loadData();
        this.settings = {
            ...DEFAULT_CONTROLLER_SETTINGS,
            ...(data || {}),
        };
        this.cleanLegacySettings();
        if (!this.settings._migratedFromPlugins) {
            await migrateSettingsFromPlugins(this.app, this.settings, () => this.saveSettings());
            this.cleanLegacySettings();
        }
        const localAlertState = this.loadAlertStateFromLocalStorage();
        if (this.hasAlertStateEntries(localAlertState)) {
            this.settings.alertState = localAlertState;
        } else if (this.hasAlertStateEntries(this.settings.alertState)) {
            this.persistAlertStateToLocalStorage(this.settings.alertState);
        } else {
            this.settings.alertState = {};
        }
        this.sanitizeFrontmatterKeySettings();
        logger.setLoggingEnabled(this.settings.enableLogging);
    }

    private cleanLegacySettings(): void {
        const legacyTopLevelKeys = [
            "kanbanTaskReminders",
            "lineItemSourceTaskFiles",
            "archiveNotePath",
            "orphanArchiveGraceCycles",
            "syncBackfillDays",
            "scheduledDateProperty",
            "scheduledStartProperty",
            "scheduledEndProperty",
            "notificationPresentationMode",
            "editorDropLinkEnabled",
            "editorDropLinkHeadingLevel",
            "editorDropLinkTemplate",
            "autoCreateConfigs",
            "companionStartupScanEnabled",
            "companionStartupDelayMs",
            "companionUpstreamPropagation",
        ];
        for (const key of legacyTopLevelKeys) {
            delete (this.settings as any)[key];
        }

        this.settings.externalCalendars = (this.settings.externalCalendars || []).map((calendar: any) => {
            const {
                autoCreateTaskListPath,
                autoCreateTaskListHeading,
                autoCreateKanbanRemoteDeletedLane,
                autoCreateKanbanCancelledLane,
                ...rest
            } = calendar || {};
            const legacyMode = rest.autoCreateMode === "task-list" || rest.autoCreateMode === "kanban-board";
            const mode = rest.autoCreateMode === "task" ? "task" : "note";
            return {
                ...rest,
                autoCreateMode: mode,
                autoCreateTaskDestination: rest.autoCreateTaskDestination === "event-note" ? "event-note" : "daily-note",
                autoCreateTaskTargetPath: typeof rest.autoCreateTaskTargetPath === "string" ? normalizeTaskTargetPathSetting(rest.autoCreateTaskTargetPath) : "",
                autoCreateEnabled: legacyMode ? false : rest.autoCreateEnabled,
            };
        });

        this.settings.reminders = (this.settings.reminders || []).map((reminder: any) => {
            if (!Array.isArray(reminder.sourceTypes)) {
                return reminder;
            }
            const sourceTypes = reminder.sourceTypes.filter((sourceType: unknown) =>
                sourceType === "file" || sourceType === "external-event"
            );
            if (sourceTypes.length) {
                return { ...reminder, sourceTypes };
            }
            const { sourceTypes: _sourceTypes, ...rest } = reminder;
            return rest;
        });
    }

    async saveSettings() {
        this.cleanLegacySettings();
        this.persistAlertStateToLocalStorage(this.settings.alertState);
        const persisted = {
            ...this.settings,
            alertState: {},
        };
        await this.saveData(persisted);
        logger.setLoggingEnabled(this.settings.enableLogging);
        this.app.workspace.trigger(TPS_EVENTS.CONTROLLER_SETTINGS_CHANGED as any, {
            sourcePluginId: this.manifest.id,
            timestamp: Date.now(),
        });
    }

    private sanitizeFrontmatterKeySettings(): void {
        const normalizeKey = (value: unknown, fallback: string): string => {
            const raw = String(value ?? "").trim();
            if (!raw) return fallback;
            return /^[A-Za-z0-9_-]+$/.test(raw) ? raw : fallback;
        };
        const s = this.settings;
        const d = DEFAULT_CONTROLLER_SETTINGS;
        s.eventIdKey = normalizeKey(s.eventIdKey, d.eventIdKey);
        s.uidKey = normalizeKey(s.uidKey, d.uidKey);
        s.titleKey = normalizeKey(s.titleKey, d.titleKey);
        s.statusKey = normalizeKey(s.statusKey, d.statusKey);
        s.previousStatusKey = normalizeKey(s.previousStatusKey, d.previousStatusKey);
        s.startProperty = normalizeKey(s.startProperty, d.startProperty);
        s.endProperty = normalizeKey(s.endProperty, d.endProperty);

        const identity = new Set([s.eventIdKey.toLowerCase(), s.uidKey.toLowerCase()]);
        const ensureNotIdentity = (v: string, fb: string) => identity.has(v.toLowerCase()) ? fb : v;
        s.titleKey = ensureNotIdentity(s.titleKey, d.titleKey);
        s.statusKey = ensureNotIdentity(s.statusKey, d.statusKey);
        s.previousStatusKey = ensureNotIdentity(s.previousStatusKey, d.previousStatusKey);
        s.startProperty = ensureNotIdentity(s.startProperty, d.startProperty);
        s.endProperty = ensureNotIdentity(s.endProperty, d.endProperty);

    }

    // ========================================================================
    // Role Management
    // ========================================================================

    private onRoleChanged(role: DeviceRole) {
        this.updateStatusBar(role);
        this.app.workspace.trigger(TPS_EVENTS.CONTROLLER_ROLE_CHANGED as any, {
            sourcePluginId: this.manifest.id,
            timestamp: Date.now(),
            role,
        });
        this.parentChildStartupResolvedHandled = false;
        this.parentChildMaintenanceActivated = false;
        if (role === "controller") void this.enterControllerMode();
        else void this.exitControllerMode();
    }

    private enterControllerMode() {
        if (Platform.isMobile) {
            this.stopControllerReloadLoop();
            this.stopAllAutomation();
            new Notice("Controller automation is disabled on mobile. This device will behave as a passive user device.", 4000);
            logger.warn("Controller role is set, but mobile devices do not run background automation.");
            return;
        }
        this.startControllerReloadLoop();
        new Notice("Controller mode activated. Running background automation.", 3000);
        this.startAllAutomation();
    }

    private exitControllerMode() {
        this.stopControllerReloadLoop();
        this.stopAllAutomation();
        new Notice("User mode activated.", 3000);
    }

    private updateStatusBar(role: DeviceRole) {
        if (role === "controller") {
            this.statusBarEl.setText("TPS: Controller");
            this.statusBarEl.addClass("mod-tps-controller");
        } else {
            this.statusBarEl.setText("TPS: User");
            this.statusBarEl.removeClass("mod-tps-controller");
        }
    }

    // ========================================================================
    // Automation Control
    // ========================================================================

    private startAllAutomation() {
        if (Platform.isMobile) {
            this.stopAllAutomation();
            logger.warn("Skipping automation startup on mobile.");
            return;
        }
        void this.checkAndFulfillSyncRequests();
        this.startSyncRequestLoop();
        this.calendarAutomation.start();
        this.startReminderLoop();
        this.startTimeTrackingReminderLoop();
        this.startParentChildMaintenanceLoop();
        this.syncConflictWatcher.updateConfig(this.settings.archiveFolder, this.settings.eventIdKey);
        this.syncConflictWatcher.start();
        logger.log(" ALL AUTOMATION STARTED");
    }

    private stopAllAutomation() {
        this.calendarAutomation.stop();
        this.stopSyncRequestLoop();
        this.stopReminderLoop();
        this.stopTimeTrackingReminderLoop();
        this.stopParentChildMaintenanceLoop();
        this.syncConflictWatcher.stop();
    }

    private startControllerReloadLoop(): void {
        this.stopControllerReloadLoop();
        if (Platform.isMobile) return;

        this.controllerReloadIntervalId = window.setInterval(() => {
            this.reloadControllerAppWithoutSaving();
        }, this.controllerReloadIntervalMs);
        logger.log("Controller hard reload loop started.");
    }

    private stopControllerReloadLoop(): void {
        if (this.controllerReloadIntervalId !== null) {
            window.clearInterval(this.controllerReloadIntervalId);
            this.controllerReloadIntervalId = null;
        }
        this.controllerReloadInProgress = false;
    }

    private reloadControllerAppWithoutSaving(): void {
        if (this.controllerReloadInProgress) return;
        if (Platform.isMobile) return;
        if (!this.deviceRoleManager?.isController?.()) return;

        this.controllerReloadInProgress = true;
        logger.warn("Controller hard reload interval reached. Reloading Obsidian without saving Controller settings.");

        try {
            const commands = (this.app as any).commands;
            if (typeof commands?.executeCommandById === "function") {
                try {
                    commands.executeCommandById("app:reload");
                    return;
                } catch (error) {
                    logger.warn("Obsidian app reload command failed; falling back to window reload.", error);
                }
            }

            window.setTimeout(() => {
                window.location.reload();
            }, 0);
        } catch (error) {
            this.controllerReloadInProgress = false;
            logger.error("Failed to trigger Controller hard reload.", error);
        }
    }

    private deferCalendarSyncSettlement(reason: string): void {
        const nextReadyAt = Date.now() + this.calendarSyncSettleWindowMs;
        if (nextReadyAt > this.calendarSyncSettledAt) {
            this.calendarSyncSettledAt = nextReadyAt;
        }
        logger.log(`Calendar sync settlement deferred (${reason}).`);
    }

    private deferCalendarSyncSettlementForFile(file: unknown, reason: string): void {
        if (file instanceof TFile && !shouldDeferCalendarSyncSettlementForPath(file.path)) return;
        this.deferCalendarSyncSettlement(reason);
    }

    private getCalendarSyncReadiness(): { ready: boolean; reason: string } {
        if (!this.metadataIndexResolved) {
            return { ready: false, reason: "metadata cache/index not resolved yet" };
        }
        const remainingMs = this.calendarSyncSettledAt - Date.now();
        if (remainingMs > 0) {
            const remainingSec = Math.ceil(remainingMs / 1000);
            return { ready: false, reason: `vault sync not settled yet (${remainingSec}s remaining)` };
        }
        return { ready: true, reason: "ready" };
    }

    // ========================================================================
    // Sync Requests
    // ========================================================================

    async runCalendarSync(force = true): Promise<void> {
        if (this.deviceRoleManager?.isController?.()) {
            await this.calendarAutomation.runSync(force);
            return;
        }
        await this.requestSync(["calendar"]);
    }

    private async requestSync(scope: ("calendar" | "reminders")[]) {
        await this.syncRequestService.writeRequest(scope);
        new Notice(`Sync requested (${scope.join(", ")}). Will be processed by Controller.`);
    }

    private async checkAndFulfillSyncRequests(): Promise<void> {
        const request = await this.syncRequestService.readRequest();
        if (!request) return;
        logger.log(`Fulfilling sync request: ${request.scope.join(", ")}`);
        if (request.scope.includes("calendar")) await this.calendarAutomation.runSync();
        if (request.scope.includes("reminders")) await this.runReminderCheck();
        await this.syncRequestService.clearRequest();
    }

    private startSyncRequestLoop() {
        this.stopSyncRequestLoop();
        // Keep request fulfillment responsive for user-device manual sync commands.
        this.syncRequestIntervalId = window.setInterval(() => {
            void this.checkAndFulfillSyncRequests();
        }, 4000);
    }

    private stopSyncRequestLoop() {
        if (this.syncRequestIntervalId !== null) {
            window.clearInterval(this.syncRequestIntervalId);
            this.syncRequestIntervalId = null;
        }
    }

    // ========================================================================
    // Reminder Loop
    // ========================================================================

    restartTimeTrackingReminderLoop(): void {
        if (this.deviceRoleManager.isController()) this.startTimeTrackingReminderLoop();
        else this.stopTimeTrackingReminderLoop();
    }

    private startReminderLoop() {
        this.stopReminderLoop();
        if (!this.settings.enableReminders) return;
        this.reminderStartupTimeoutId = window.setTimeout(() => {
            this.reminderStartupTimeoutId = null;
            void this.runReminderCheck();
        }, 10000);
        const pollMs = Math.max(30000, this.settings.pollMinutes * 60 * 1000);
        const activeRepeatMs = (this.settings.reminders || [])
            .filter((reminder) => reminder.enabled && reminder.repeatUntilComplete && Number(reminder.repeatIntervalMinutes) > 0)
            .map((reminder) => Number(reminder.repeatIntervalMinutes) * 60 * 1000);
        const ms = Math.max(30000, Math.min(pollMs, ...activeRepeatMs));
        this.reminderIntervalId = window.setInterval(() => { void this.runReminderCheck(); }, ms);
    }

    private stopReminderLoop() {
        if (this.reminderStartupTimeoutId !== null) {
            window.clearTimeout(this.reminderStartupTimeoutId);
            this.reminderStartupTimeoutId = null;
        }
        if (this.reminderIntervalId !== null) {
            window.clearInterval(this.reminderIntervalId);
            this.reminderIntervalId = null;
        }
    }

    private startTimeTrackingReminderLoop(): void {
        this.stopTimeTrackingReminderLoop();
        if (this.settings.enableTimeTrackingHourlyReminders === false) return;

        this.timeTrackingReminderStartupTimeoutId = window.setTimeout(() => {
            this.timeTrackingReminderStartupTimeoutId = null;
            void this.runTimeTrackingReminderCheck();
        }, 10000);
        this.timeTrackingReminderIntervalId = window.setInterval(() => {
            void this.runTimeTrackingReminderCheck();
        }, 60000);
    }

    private stopTimeTrackingReminderLoop(): void {
        if (this.timeTrackingReminderStartupTimeoutId !== null) {
            window.clearTimeout(this.timeTrackingReminderStartupTimeoutId);
            this.timeTrackingReminderStartupTimeoutId = null;
        }
        if (this.timeTrackingReminderIntervalId !== null) {
            window.clearInterval(this.timeTrackingReminderIntervalId);
            this.timeTrackingReminderIntervalId = null;
        }
    }

    private async runTimeTrackingReminderCheck(): Promise<void> {
        if (!this.deviceRoleManager.isController()) return;
        if (this.settings.enableTimeTrackingHourlyReminders === false) return;

        const now = new Date();
        if (now.getMinutes() > 2) return;

        const hourStart = new Date(now);
        hourStart.setMinutes(0, 0, 0);
        const hourKey = moment(hourStart).format("YYYY-MM-DDTHH");

        const gcm = this.getGcmPlugin();
        const timeTracking = gcm?.timeTracking;
        if (typeof timeTracking?.getActiveTimers !== "function") return;

        const messager = this.getNotifierPlugin();
        if (!messager?.sendNotification && !messager?.sendMessage) return;

        let activeSessions: GcmTimeTrackingSession[] = [];
        try {
            activeSessions = await timeTracking.getActiveTimers();
        } catch (error) {
            logger.warn("Failed to read active time tracking sessions for hourly reminders.", error);
            return;
        }

        if (!activeSessions.length) return;

        const state = this.loadTimeTrackingReminderState();
        const cutoff = Date.now() - 48 * 60 * 60 * 1000;
        let changed = false;
        for (const key of Object.keys(state)) {
            if (state[key] < cutoff) {
                delete state[key];
                changed = true;
            }
        }

        for (const session of activeSessions) {
            const start = this.parseTimeTrackingSessionDate(session.start);
            if (!start || start.getTime() >= hourStart.getTime()) continue;

            const dedupeKey = `${session.id}:${hourKey}`;
            if (state[dedupeKey]) continue;

            const title = String(session.title || "this note").trim() || "this note";
            const file = this.resolveTimeTrackingSessionFile(session);
            try {
                const body = `Still working "${title}"?`;
                if (messager.sendNotification) {
                    await messager.sendNotification("Time tracking reminder", body, file ?? undefined);
                } else if (messager.sendMessage) {
                    await messager.sendMessage(body, file ?? undefined, "Time tracking reminder");
                }
                state[dedupeKey] = Date.now();
                changed = true;
            } catch (error) {
                logger.warn(`Failed to send time tracking reminder for ${title}.`, error);
            }
        }

        if (changed) this.persistTimeTrackingReminderState(state);
    }

    private parseTimeTrackingSessionDate(value: string): Date | null {
        const raw = String(value || "").trim();
        if (!raw) return null;
        const parsed = moment(raw, [moment.ISO_8601, "YYYY-MM-DD HH:mm:ss", "YYYY-MM-DD HH:mm"], true);
        if (parsed.isValid()) return parsed.toDate();
        const fallback = new Date(raw);
        return Number.isFinite(fallback.getTime()) ? fallback : null;
    }

    private resolveTimeTrackingSessionFile(session: GcmTimeTrackingSession): TFile | null {
        const candidates = [session.targetPath, session.sourcePath]
            .map((path) => String(path || "").trim())
            .filter(Boolean);
        for (const path of candidates) {
            const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
            if (file instanceof TFile) return file;
        }
        return null;
    }

    private getTimeTrackingReminderStateStorageKey(): string {
        return `tps-controller-time-tracking-reminder-state-${this.app.vault.getName()}`;
    }

    private loadTimeTrackingReminderState(): Record<string, number> {
        try {
            const raw = window.localStorage.getItem(this.getTimeTrackingReminderStateStorageKey());
            if (!raw) return {};
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
            const output: Record<string, number> = {};
            for (const [key, value] of Object.entries(parsed)) {
                const timestamp = Number(value);
                if (key && Number.isFinite(timestamp)) output[key] = timestamp;
            }
            return output;
        } catch (error) {
            logger.warn("Failed to read local time tracking reminder state; resetting state.", error);
            return {};
        }
    }

    private persistTimeTrackingReminderState(state: Record<string, number>): void {
        try {
            window.localStorage.setItem(this.getTimeTrackingReminderStateStorageKey(), JSON.stringify(state || {}));
        } catch (error) {
            logger.warn("Failed to persist local time tracking reminder state.", error);
        }
    }

    private startParentChildMaintenanceLoop() {
        this.stopParentChildMaintenanceLoop();
        this.parentChildBootstrapIntervalId = window.setInterval(() => {
            if (this.parentChildMaintenanceActivated) {
                this.stopParentChildBootstrapLoop();
                return;
            }
            void this.runParentChildMaintenanceTick();
        }, 15000);
        const minutes = Math.max(1, this.settings.syncIntervalMinutes || 5);
        const intervalMs = minutes * 60 * 1000;
        this.parentChildMaintenanceIntervalId = window.setInterval(() => {
            void this.runParentChildMaintenanceTick();
        }, intervalMs);
    }

    private stopParentChildMaintenanceLoop() {
        this.stopParentChildBootstrapLoop();
        if (this.parentChildMaintenanceIntervalId !== null) {
            window.clearInterval(this.parentChildMaintenanceIntervalId);
            this.parentChildMaintenanceIntervalId = null;
        }
    }

    private stopParentChildBootstrapLoop() {
        if (this.parentChildBootstrapIntervalId !== null) {
            window.clearInterval(this.parentChildBootstrapIntervalId);
            this.parentChildBootstrapIntervalId = null;
        }
    }

    private async runReminderCheck(): Promise<void> {
        if (!this.settings.enableReminders) return;
        const alertStateBeforeRun = this.cloneAlertState(this.settings.alertState);
        const result = await this.reminderEngine.evaluateReminders(this.settings);
        if (result.stateChanged) this.scheduleReminderStateSave();
        this.app.workspace.trigger(TPS_EVENTS.REMINDERS_UPDATED as any, {
            sourcePluginId: this.manifest.id,
            timestamp: Date.now(),
            notificationCount: result.notifications.length,
            stateChanged: result.stateChanged,
        });
        if (!result.notifications.length) return;

        const externalNotifications = result.notifications.filter((n) => n.sourceType === "external-event");
        const allDayNotifications = result.notifications.filter((n) => n.isAllDay && n.sourceType !== "external-event");
        const nonAllDayNotifications = result.notifications.filter((n) => !n.isAllDay && n.sourceType !== "external-event");
        const batches = this.buildReminderNotificationBatches(nonAllDayNotifications, allDayNotifications, externalNotifications);

        this.showLocalReminderNotices(batches);

        const notifier = this.getNotifierPlugin();
        if (!notifier) {
            logger.warn("[ReminderEngine] TPS Notifier plugin not found. Local system notices were shown.");
            return;
        }
        if (!notifier.sendNotification && !notifier.sendMessage) {
            logger.warn("[ReminderEngine] Notifier plugin has no send API. Local system notices were shown.");
            return;
        }

        try {
            for (const batch of batches) {
                if (notifier.sendNotification) await notifier.sendNotification(batch.title, batch.body, batch.file);
                else if (notifier.sendMessage) await notifier.sendMessage(batch.body, batch.file, batch.title);
            }
        } catch (error) {
            this.restoreAlertStateAfterDeliveryFailure(alertStateBeforeRun, "Reminder delivery failed.", error);
        }
    }

    private buildReminderNotificationBatches(
        nonAllDayNotifications: PendingNotification[],
        allDayNotifications: PendingNotification[],
        externalNotifications: PendingNotification[],
    ): ReminderNotificationBatch[] {
        const notifications = [
            ...nonAllDayNotifications,
            ...allDayNotifications,
            ...externalNotifications,
        ];

        if (this.settings.batchNotifications && notifications.length > 1) {
            const count = notifications.length;
            const items = notifications.slice(0, 8);
            let body = items.map((p: PendingNotification) => ` ${p.title}`).join('\n');
            if (count > 8) body += `\n...and ${count - 8} more`;
            return [{ title: `${count} Reminder${count === 1 ? "" : "s"}`, body, items: notifications }];
        }

        return notifications.map((p) => ({ title: p.title, body: p.body, file: p.file, items: [p] }));
    }

    private showLocalReminderNotices(batches: ReminderNotificationBatch[]): void {
        for (const batch of batches) {
            const notice = new Notice(this.buildLocalReminderNoticeFragment(batch), 10000);
            notice.messageEl.classList.add("tps-controller-reminder-notice");
            notice.messageEl.style.cursor = "pointer";
            notice.messageEl.addEventListener("click", () => {
                void this.openReminderNoticeTarget(batch);
                notice.hide();
            });
        }
    }

    private buildLocalReminderNoticeFragment(batch: ReminderNotificationBatch): DocumentFragment {
        const fragment = document.createDocumentFragment();
        const container = document.createElement("div");
        container.className = "tps-controller-reminder-notice-content";
        container.style.display = "flex";
        container.style.flexDirection = "column";
        container.style.gap = "4px";
        fragment.appendChild(container);

        const title = document.createElement("div");
        title.className = "tps-controller-reminder-notice-title";
        title.textContent = String(batch.title || "TPS Reminder").trim() || "TPS Reminder";
        title.style.fontWeight = "600";
        container.appendChild(title);

        const items = batch.items || [];
        if (items.length > 1) {
            const list = document.createElement("div");
            list.className = "tps-controller-reminder-notice-list";
            list.style.display = "flex";
            list.style.flexDirection = "column";
            list.style.gap = "2px";
            container.appendChild(list);

            for (const item of items.slice(0, 5)) {
                const row = document.createElement("div");
                row.className = "tps-controller-reminder-notice-row";
                row.textContent = `• ${String(item.title || item.file?.basename || "Reminder").trim()}`;
                row.style.whiteSpace = "nowrap";
                row.style.overflow = "hidden";
                row.style.textOverflow = "ellipsis";
                if (item.file) {
                    row.style.textDecoration = "underline";
                    row.addEventListener("click", (event) => {
                        event.stopPropagation();
                        void this.openReminderFile(item.file);
                    });
                }
                list.appendChild(row);
            }

            if (items.length > 5) {
                const more = document.createElement("div");
                more.className = "tps-controller-reminder-notice-more";
                more.textContent = `+${items.length - 5} more`;
                more.style.color = "var(--text-muted)";
                list.appendChild(more);
            }
        } else {
            const body = String(batch.body || "").trim();
            if (body) {
                const detail = document.createElement("div");
                detail.className = "tps-controller-reminder-notice-detail";
                detail.textContent = body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 2).join(" · ");
                detail.style.color = "var(--text-muted)";
                detail.style.whiteSpace = "nowrap";
                detail.style.overflow = "hidden";
                detail.style.textOverflow = "ellipsis";
                container.appendChild(detail);
            }
        }

        const hint = document.createElement("div");
        hint.className = "tps-controller-reminder-notice-hint";
        hint.textContent = batch.file ? "Click to open note" : "Click to view notifications";
        hint.style.color = "var(--text-faint)";
        hint.style.fontSize = "var(--font-ui-smaller)";
        container.appendChild(hint);

        return fragment;
    }

    private async openReminderNoticeTarget(batch: ReminderNotificationBatch): Promise<void> {
        if (batch.file) {
            await this.openReminderFile(batch.file);
            return;
        }

        const firstFile = (batch.items || []).map((item) => item.file).find((file): file is TFile => file instanceof TFile);
        if (firstFile && batch.items.length === 1) {
            await this.openReminderFile(firstFile);
            return;
        }

        await this.overdueService.openNotificationModal();
    }

    private async openReminderFile(file: TFile): Promise<void> {
        const leaf = this.app.workspace.getLeaf(false);
        await leaf.openFile(file);
    }

    private cloneAlertState(state: AlertState): AlertState {
        try {
            return JSON.parse(JSON.stringify(state || {})) as AlertState;
        } catch {
            return {};
        }
    }

    private restoreAlertStateAfterDeliveryFailure(previousState: AlertState, message: string, error?: unknown): void {
        logger.warn(`[ReminderEngine] ${message}`, error);
        new Notice(`TPS reminders not sent: ${message}`);
        this.settings.alertState = previousState;
        this.persistAlertStateToLocalStorage(this.settings.alertState);
        this.reminderStateSaveDirty = false;
    }

    private scheduleReminderStateSave(): void {
        this.reminderStateSaveDirty = true;
        const now = Date.now();
        if (now >= this.reminderStateNextSaveAt) {
            void this.flushReminderStateNow();
            return;
        }

        if (this.reminderStateFlushTimer !== null) {
            return;
        }

        const delay = Math.max(50, this.reminderStateNextSaveAt - now);
        this.reminderStateFlushTimer = window.setTimeout(() => {
            this.reminderStateFlushTimer = null;
            void this.flushReminderStateNow();
        }, delay);
    }

    private async flushReminderStateNow(): Promise<void> {
        if (!this.reminderStateSaveDirty) return;
        this.reminderStateSaveDirty = false;
        this.reminderStateNextSaveAt = Date.now() + this.reminderStateSaveCooldownMs;
        this.persistAlertStateToLocalStorage(this.settings.alertState);
    }

    private stopReminderStateFlushTimer(): void {
        if (this.reminderStateFlushTimer !== null) {
            window.clearTimeout(this.reminderStateFlushTimer);
            this.reminderStateFlushTimer = null;
        }
    }

    private getAlertStateStorageKey(): string {
        return `tps-controller-alert-state-${this.app.vault.getName()}`;
    }

    private hasAlertStateEntries(state: AlertState | null | undefined): boolean {
        return !!state && Object.keys(state).length > 0;
    }

    private loadAlertStateFromLocalStorage(): AlertState {
        try {
            const raw = window.localStorage.getItem(this.getAlertStateStorageKey());
            if (!raw) return {};
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
            return parsed as AlertState;
        } catch (error) {
            logger.warn("Failed to read local reminder alert state; resetting state.", error);
            return {};
        }
    }

    private persistAlertStateToLocalStorage(state: AlertState): void {
        try {
            window.localStorage.setItem(this.getAlertStateStorageKey(), JSON.stringify(state || {}));
        } catch (error) {
            logger.warn("Failed to persist local reminder alert state.", error);
        }
    }

    // ========================================================================
    // Overdue Items (delegates to OverdueService)
    // ========================================================================

    async openNotificationModal(): Promise<void> { return this.overdueService.openNotificationModal(); }
    async getOverdueItems(): Promise<OverdueItem[]> { return this.overdueService.getOverdueItems(); }
    async snoozeFile(file: TFile, minutes: number): Promise<void> { return this.overdueService.snoozeFile(file, minutes); }
    async snoozeOverdueItem(item: OverdueItem, minutes: number): Promise<void> { return this.overdueService.snoozeItem(item, minutes); }
    openFile(file: TFile): void { this.overdueService.openFile(file); }
    async openOverdueItem(item: OverdueItem): Promise<void> { return this.overdueService.openItem(item); }
    async markFileComplete(file: TFile): Promise<void> { return this.overdueService.markFileComplete(file); }
    async markFileWontDo(file: TFile): Promise<void> { return this.overdueService.markFileWontDo(file); }
    async markOverdueItemComplete(item: OverdueItem): Promise<void> { return this.overdueService.markItemComplete(item); }
    async markOverdueItemWontDo(item: OverdueItem): Promise<void> { return this.overdueService.markItemWontDo(item); }
    async setOverdueItemStatus(item: OverdueItem, status: string | null): Promise<void> { return this.overdueService.setItemStatus(item, status); }
    async resolveOverdueTaskReminder(item: OverdueItem): Promise<boolean> { return this.overdueService.resolveTaskReminder(item); }
    refreshNotificationViews(): void {
        for (const leaf of this.app.workspace.getLeavesOfType(NOTIFICATION_VIEW_TYPE)) {
            const view = leaf.view as NotificationView;
            void view.refresh?.();
        }
    }

    // ========================================================================
    // Plugin API Lookups
    // ========================================================================

    private getCalendarPlugin(): CalendarPluginAPI | null {
        const plugin = getPluginById(this.app, "tps-calendar-base")
                    || getPluginById(this.app, "TPS-Calendar-Base (Dev)");
        return (plugin as any)?.api || null;
    }

    private getNotifierPlugin(): NotifierPluginAPI | null {
        const plugin = getPluginById(this.app, "tps-messager")
                    || getPluginById(this.app, "tps-notifier");
        return (plugin as any)?.api || plugin || null;
    }

    private getGcmPlugin(): GcmPluginAPI | null {
        const enabled = isPluginEnabled(this.app, "tps-global-context-menu")
                     || isPluginEnabled(this.app, "TPS-Global-Context-Menu (Dev)");
        if (!enabled) return null;
        const plugin = (getPluginById(this.app, "tps-global-context-menu")
                    || getPluginById(this.app, "TPS-Global-Context-Menu (Dev)")) as any;
        if (!plugin) return null;
        const api = plugin.api || {};
        return {
            settings: plugin.settings ?? api.settings,
            services: api.services ?? plugin.sharedServices,
            timeTracking: api.timeTracking ?? api.services?.timeTracking ?? plugin.timeTrackingService,
            bulkEditService: plugin.bulkEditService ?? api.bulkEditService,
        } as GcmPluginAPI;
    }

    private async runRecurrenceMaintenanceTick(): Promise<void> {
        if (!this.deviceRoleManager.isController()) return;
        const gcm = this.getGcmPlugin();
        const checkMissing = gcm?.services?.recurrence?.checkMissingRecurrences
            || gcm?.bulkEditService?.checkMissingRecurrences;
        if (typeof checkMissing !== "function") return;
        try {
            await checkMissing.call(gcm?.services?.recurrence || gcm?.bulkEditService);
        } catch (error) {
            logger.error(" Recurrence maintenance tick failed", error);
        }
    }

    private async runParentChildMaintenanceTick(): Promise<void> {
        if (!this.deviceRoleManager.isController()) return;

        const gcm = this.getGcmPlugin();
        const reconcile = gcm?.bulkEditService?.reconcileParentChildLinksForParent;
        const ensureSelfLink = gcm?.bulkEditService?.ensureParentSelfLinkForParent;
        if (typeof reconcile !== "function" && typeof ensureSelfLink !== "function") return;
        this.parentChildMaintenanceActivated = true;

        const parentKey = String(gcm?.services?.parents?.getParentKey?.() || gcm?.settings?.parentLinkFrontmatterKey || "childOf").trim() || "childOf";
        const childKey = String(gcm?.settings?.childLinkFrontmatterKey || "parentOf").trim() || "parentOf";

        const parentCandidates = new Map<string, TFile>();
        const files = this.app.vault.getMarkdownFiles();
        for (const file of files) {
            const frontmatter = (this.app.metadataCache.getFileCache(file)?.frontmatter || {}) as Record<string, any>;
            if (!frontmatter || typeof frontmatter !== "object") continue;

            if (this.hasFrontmatterKeyCaseInsensitive(frontmatter, childKey)) {
                parentCandidates.set(file.path, file);
            }

            const parentRaw = this.getFrontmatterValueCaseInsensitive(frontmatter, parentKey);
            const targets = gcm?.services?.links?.extractTargetsFromValue?.(parentRaw, true)
                || this.extractLinkTargetsFromAny(parentRaw);
            for (const target of targets) {
                const parentFile = gcm?.services?.links?.resolveToFile?.(target, file.path)
                    || this.resolveLinkTargetToFile(target, file.path);
                if (parentFile) {
                    parentCandidates.set(parentFile.path, parentFile);
                }
            }
        }

        if (!parentCandidates.size) return;

        let totalUpdates = 0;
        for (const parentFile of parentCandidates.values()) {
            try {
                if (typeof reconcile === "function") {
                    const updated = await reconcile.call(gcm?.bulkEditService, parentFile);
                    if (typeof updated === "number") {
                        totalUpdates += updated;
                    }
                }
                if (typeof ensureSelfLink === "function") {
                    const selfUpdated = await ensureSelfLink.call(gcm?.bulkEditService, parentFile);
                    if (selfUpdated) {
                        totalUpdates += 1;
                    }
                }
            } catch (error) {
                logger.warn(` Parent/child maintenance failed for ${parentFile.path}`, error);
            }
        }

        if (totalUpdates > 0) {
            logger.log(` Parent/child maintenance applied ${totalUpdates} update(s) across ${parentCandidates.size} parent notes.`);
        }
    }

    private hasFrontmatterKeyCaseInsensitive(frontmatter: Record<string, any>, key: string): boolean {
        const normalized = String(key || "").trim().toLowerCase();
        if (!normalized) return false;
        return Object.keys(frontmatter || {}).some((candidate) => candidate.toLowerCase() === normalized);
    }

    private getFrontmatterValueCaseInsensitive(frontmatter: Record<string, any>, key: string): any {
        const normalized = String(key || "").trim().toLowerCase();
        if (!normalized) return undefined;
        const match = Object.keys(frontmatter || {}).find((candidate) => candidate.toLowerCase() === normalized);
        return match ? frontmatter[match] : undefined;
    }

    private extractLinkTargetsFromAny(value: any): string[] {
        const output = new Set<string>();
        const visited = new Set<any>();

        const consume = (candidate: any): void => {
            if (candidate == null) return;
            if (Array.isArray(candidate)) {
                if (visited.has(candidate)) return;
                visited.add(candidate);
                candidate.forEach((entry) => consume(entry));
                return;
            }
            if (typeof candidate === "object") {
                if (visited.has(candidate)) return;
                visited.add(candidate);
                Object.values(candidate).forEach((entry) => consume(entry));
                return;
            }
            if (typeof candidate !== "string" && typeof candidate !== "number" && typeof candidate !== "boolean") {
                return;
            }

            const text = String(candidate).trim();
            if (!text) return;
            for (const target of this.extractLinkTargetsFromText(text)) {
                output.add(target);
            }
        };

        consume(value);
        return Array.from(output.values());
    }

    private extractLinkTargetsFromText(rawText: string): string[] {
        const text = String(rawText || "").trim();
        if (!text) return [];
        const targets = new Set<string>();

        const add = (rawTarget: string) => {
            const normalized = this.normalizeLinkTarget(rawTarget);
            if (normalized) targets.add(normalized);
        };

        const wikiPattern = /!?\[\[([^[\]]+)\]\]/g;
        let wikiMatch: RegExpExecArray | null = null;
        while ((wikiMatch = wikiPattern.exec(text)) !== null) {
            add(wikiMatch[1]);
        }

        const markdownPattern = /!?\[[^\]]*]\(([^)]+)\)/g;
        let markdownMatch: RegExpExecArray | null = null;
        while ((markdownMatch = markdownPattern.exec(text)) !== null) {
            add(markdownMatch[1]);
        }

        if (targets.size === 0) {
            add(text);
        }

        return Array.from(targets.values());
    }

    private normalizeLinkTarget(rawTarget: string): string {
        let target = String(rawTarget || "").trim();
        if (!target) return "";

        if (target.startsWith("<") && target.endsWith(">")) {
            target = target.slice(1, -1).trim();
        }

        target = target.replace(/^['"]|['"]$/g, "").trim();

        const pipeIndex = target.indexOf("|");
        if (pipeIndex >= 0) {
            target = target.slice(0, pipeIndex).trim();
        }

        const hashIndex = target.indexOf("#");
        if (hashIndex >= 0) {
            target = target.slice(0, hashIndex).trim();
        }

        if (!target) return "";

        try {
            target = decodeURIComponent(target);
        } catch {
            // Keep raw value when malformed URI segments are present.
        }

        return target.replace(/^\/+/, "").trim();
    }

    private resolveLinkTargetToFile(rawTarget: string, sourcePath: string): TFile | null {
        const target = this.normalizeLinkTarget(rawTarget);
        if (!target) return null;

        const viaCache =
            this.app.metadataCache.getFirstLinkpathDest(target, sourcePath)
            || this.app.metadataCache.getFirstLinkpathDest(target.replace(/\.md$/i, ""), sourcePath);
        if (viaCache instanceof TFile) return viaCache;

        const normalized = normalizePath(target);
        const direct = this.app.vault.getAbstractFileByPath(normalized);
        if (direct instanceof TFile) return direct;

        if (!normalized.endsWith(".md")) {
            const withMd = this.app.vault.getAbstractFileByPath(`${normalized}.md`);
            if (withMd instanceof TFile) return withMd;
        }

        return null;
    }
}
