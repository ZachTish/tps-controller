import { Plugin, Notice, Platform, TFile, WorkspaceLeaf, moment, normalizePath } from "obsidian";
import { DeviceRoleManager, DeviceRole } from "./device-role-manager";
import { TPSControllerSettings, DEFAULT_CONTROLLER_SETTINGS } from "./types";
import { AutoCreateService } from "./services/auto-create-service";
import { ExternalCalendarService } from "./services/external-calendar-service";
import { ReminderEngine, PendingNotification } from "./services/reminder-engine";
import { SyncRequestService } from "./services/sync-request-service";
import { executeSyncRequestGeneration, joinSyncRequestFulfillment } from "./services/sync-request-contract";
import { SyncConflictWatcher } from "./services/sync-conflict-watcher";
import { TPSControllerSettingTab } from "./settings-tab";
import * as logger from "./logger";
import { getPluginById, isPluginEnabled } from "./core";
import { NotificationView, NOTIFICATION_VIEW_TYPE } from "./views/notification-view";
import type { AlertState, OverdueItem } from "./types";
import { OverdueService } from "./services/overdue-service";
import { CalendarAutomationService } from "./services/calendar-automation";
import { migrateSettingsFromPlugins } from "./services/migration-service";
import { TwoStageArchiveService } from "./services/two-stage-archive-service";
import { TPS_EVENTS } from "./tps-events";
import { shouldDeferCalendarSyncSettlementForPath } from "./services/calendar-sync-settlement-filter";
import { normalizeReminderSettingsInPlace } from "./services/reminder-settings-service";
import {
    migrateLegacyS3Credentials,
    takeRetainedLegacyS3Credentials,
    withRetainedLegacyS3Credentials,
    type RetainedLegacyS3Credentials,
    type S3CredentialMigrationResult,
} from "./services/s3-credential-service";

const normalizeTaskTargetPathSetting = (value: string): string => {
    const normalized = normalizePath(String(value || "").trim().replace(/^\[\[|\]\]$/g, "").replace(/^\/+/, ""));
    if (!normalized || normalized === "." || normalized === ".md" || normalized.endsWith("/.md")) return "";
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

interface S3AttachmentAutomationAPI {
    start(): void;
    stop(): void;
    restart(): void;
    runActiveNoteNow(): Promise<{ notePath: string; uploadedCount: number; archivedCount: number; skippedArchiveCount: number } | null>;
    fulfillArchiveRequests(requests: any[] | undefined): Promise<{ archivedCount: number; skippedArchiveCount: number }>;
    runBucketArchiveIfDue(nowMs?: number): Promise<{ archivedCount: number; skippedCount: number; lastError?: string; lastSkipReason?: string } | null>;
    runBucketArchiveNow(nowMs?: number): Promise<{ archivedCount: number; skippedCount: number; lastError?: string; lastSkipReason?: string }>;
    getBucketArchiveCheckIntervalMs(): number;
}

class DisabledS3AttachmentAutomationService implements S3AttachmentAutomationAPI {
    start(): void {
        logger.flow("S3agleAutomation", "start:mobile-disabled");
    }

    stop(): void {}

    restart(): void {
        this.start();
    }

    async runActiveNoteNow(): Promise<null> {
        new Notice("S3 attachment upload is not available on mobile. Use a desktop Controller instance.");
        return null;
    }

    async fulfillArchiveRequests(): Promise<{ archivedCount: number; skippedArchiveCount: number }> {
        return { archivedCount: 0, skippedArchiveCount: 0 };
    }

    async runBucketArchiveIfDue(): Promise<null> {
        return null;
    }

    async runBucketArchiveNow(): Promise<{ archivedCount: number; skippedCount: number; lastSkipReason: string }> {
        new Notice("S3 bucket archive is not available on mobile. Use the desktop Controller device.");
        return { archivedCount: 0, skippedCount: 0, lastSkipReason: "mobile disabled" };
    }

    getBucketArchiveCheckIntervalMs(): number {
        return 60 * 60 * 1000;
    }
}

// ============================================================================
// Controller Plugin
// ============================================================================

export default class TPSControllerPlugin extends Plugin {
    settings: TPSControllerSettings;
    private settingsSavePromise: Promise<void> | null = null;
    private settingsSavePending = false;
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
    private twoStageArchiveService: TwoStageArchiveService;
    private s3agleAttachmentAutomationService: S3AttachmentAutomationAPI;

    // Reminder interval
    private reminderIntervalId: number | null = null;
    private reminderStartupTimeoutId: number | null = null;
    private timeTrackingReminderIntervalId: number | null = null;
    private timeTrackingReminderStartupTimeoutId: number | null = null;
    private syncRequestIntervalId: number | null = null;
    private syncRequestFulfillmentPromise: Promise<void> | null = null;
    private parentChildMaintenanceIntervalId: number | null = null;
    private twoStageArchiveIntervalId: number | null = null;
    private s3BucketArchiveIntervalId: number | null = null;
    private parentChildBootstrapIntervalId: number | null = null;
    private parentChildStartupResolvedHandled = false;
    private parentChildMaintenanceActivated = false;
    private metadataIndexResolved = false;
    private calendarSyncSettledAt = Date.now() + 20_000;
    private readonly calendarSyncSettleWindowMs = 20_000;
    private notebookNavigatorOpenPatchInstalled = false;
    private notebookNavigatorInteractionUntil = 0;
    private notebookNavigatorPendingOpenRedirect = false;
    private persistedSettingsSnapshot: Record<string, unknown> | null = null;
    private retainedLegacyS3Credentials: RetainedLegacyS3Credentials = {};

    async onload() {
        logger.flow("Lifecycle", "load", {
            id: this.manifest.id,
            version: this.manifest.version,
            isMobile: Platform.isMobile,
        });

        await this.loadSettings();
        this.app.workspace.onLayoutReady(() => this.installNotebookNavigatorOpenPatch());
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
        this.twoStageArchiveService = new TwoStageArchiveService(this.app, () => this.settings, () => this.saveSettings());
        this.s3agleAttachmentAutomationService = await this.createS3AttachmentAutomationService();

        // Commands
        this.addCommand({
            id: "force-calendar-sync",
            name: "Force Calendar Sync Now",
            callback: () => this.traceCommand("force-calendar-sync", async () => {
                if (this.deviceRoleManager.isController()) {
                    logger.flow("Command", "force-calendar-sync:controller-run", { force: true });
                    await this.calendarAutomation.runSync(true);
                } else {
                    logger.flow("Command", "force-calendar-sync:replica-request", { scope: ["calendar"] });
                    await this.requestSync(["calendar"]);
                }
            }),
        });
        this.addCommand({
            id: "run-two-stage-archive-now",
            name: "Run Two-Stage Archive Now",
            callback: () => this.traceCommand("run-two-stage-archive-now", async () => {
                if (!this.deviceRoleManager.isController()) {
                    logger.flowWarn("Command", "two-stage-archive:replica-blocked");
                    new Notice("Two-stage archive runs on the Controller device.");
                    return;
                }
                const result = await this.runTwoStageArchiveNow();
                logger.flow("Command", "two-stage-archive:manual-result", {
                    moved: result.movedCount,
                    skipped: result.skippedCount,
                    sourceFolder: result.sourceFolder,
                    destinationFolder: result.destinationFolder,
                    runKey: result.runKey,
                });
                new Notice(`Two-stage archive: moved ${result.movedCount}, skipped ${result.skippedCount}.`);
            }),
        });
        this.addCommand({
            id: "force-reminder-check",
            name: "Run Reminder Check Now",
            callback: () => this.traceCommand("force-reminder-check", async () => {
                if (this.deviceRoleManager.isController()) {
                    logger.flow("Command", "force-reminder-check:controller-run");
                    await this.runReminderCheck();
                } else {
                    logger.flow("Command", "force-reminder-check:replica-request", { scope: ["reminders"] });
                    await this.requestSync(["reminders"]);
                }
            }),
        });
        this.addCommand({
            id: "open-notifications",
            name: "View Notifications",
            callback: () => this.traceCommand("open-notifications", () => this.overdueService.openNotificationModal()),
        });
        this.addCommand({
            id: "run-s3agle-attachment-automation-now",
            name: "Run S3 Attachment Upload Now",
            callback: () => this.traceCommand("run-s3agle-attachment-automation-now", async () => {
                await this.s3agleAttachmentAutomationService.runActiveNoteNow();
            }),
        });
        this.addCommand({
            id: "run-s3-bucket-archive-now",
            name: "Run S3 Bucket Archive Now",
            callback: () => this.traceCommand("run-s3-bucket-archive-now", async () => {
                if (!this.deviceRoleManager.isController()) {
                    new Notice("S3 bucket archive runs on the Controller device.");
                    return;
                }
                const result = await this.s3agleAttachmentAutomationService.runBucketArchiveNow();
                const suffix = result.lastError
                    ? ` Last error: ${result.lastError}`
                    : result.lastSkipReason
                        ? ` Last skip: ${result.lastSkipReason}`
                        : "";
                new Notice(`S3 bucket archive: moved ${result.archivedCount}, skipped ${result.skippedCount}.${suffix}`);
            }),
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
        this.startS3agleAttachmentAutomation();

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

        logger.flow("Lifecycle", "loaded", {
            role: this.deviceRoleManager.role,
            isController: this.deviceRoleManager.isController(),
            remindersEnabled: this.settings.enableReminders,
            calendarCount: this.settings.externalCalendars?.length || 0,
        });
    }

    private traceCommand(commandId: string, action: () => Promise<void>): void {
        void logger.timeAsync("Command", commandId, {
            role: this.deviceRoleManager?.role || "unknown",
            isController: this.deviceRoleManager?.isController?.() === true,
            isMobile: Platform.isMobile,
        }, action);
    }

    private installNotebookNavigatorOpenPatch(): void {
        if (this.notebookNavigatorOpenPatchInstalled) return;

        const workspace = this.app.workspace as any;
        const originalGetLeaf = workspace.getLeaf;
        if (typeof originalGetLeaf !== "function") return;
        const originalLeafOpenFile = WorkspaceLeaf.prototype.openFile;
        const originalLeafSetViewState = WorkspaceLeaf.prototype.setViewState;

        const plugin = this;
        const redirectedNotebookNavigatorLeaves = new WeakSet<WorkspaceLeaf>();
        const getLeafTargetPath = (leaf: WorkspaceLeaf): string | null => {
            const viewFile = (leaf.view as any)?.file;
            if (viewFile instanceof TFile) return viewFile.path;
            const state = leaf.getViewState?.()?.state as Record<string, unknown> | undefined;
            if (typeof state?.file === "string") return state.file;
            if (typeof state?.path === "string") return state.path;
            return null;
        };
        const getViewStateTargetPath = (viewState: unknown): string | null => {
            if (!viewState || typeof viewState !== "object") return null;
            const state = (viewState as Record<string, unknown>).state;
            if (!state || typeof state !== "object") return null;
            const record = state as Record<string, unknown>;
            if (typeof record.file === "string") return record.file;
            if (typeof record.path === "string") return record.path;
            return null;
        };
        const focusRedirectedLeafIfStillTarget = (leaf: WorkspaceLeaf, filePath: string | null) => {
            const leafPath = getLeafTargetPath(leaf);
            if (filePath && leafPath && leafPath !== filePath) return;
            workspace.setActiveLeaf?.(leaf, { focus: true });
            workspace.revealLeaf?.(leaf);
        };
        const markNotebookNavigatorInteraction = (evt: Event) => {
            const target = evt.target;
            if (!(target instanceof Element)) return;
            if (!target.closest(".notebook-navigator")) return;
            plugin.notebookNavigatorInteractionUntil = Date.now() + 500;
            plugin.notebookNavigatorPendingOpenRedirect = true;
        };
        document.addEventListener("pointerdown", markNotebookNavigatorInteraction, true);
        document.addEventListener("keydown", markNotebookNavigatorInteraction, true);
        document.addEventListener("contextmenu", markNotebookNavigatorInteraction, true);

        const patchedGetLeaf = function patchedGetLeaf(this: any, newLeaf?: unknown, ...args: unknown[]) {
            if (newLeaf === false && plugin.isNotebookNavigatorOpenRequest()) {
                const leaf = originalGetLeaf.call(this, true, ...args);
                if (leaf) {
                    redirectedNotebookNavigatorLeaves.add(leaf);
                    logger.log("[Notebook Navigator] Redirected same-tab file open to a new tab.");
                }
                return leaf;
            }

            return originalGetLeaf.call(this, newLeaf, ...args);
        };
        workspace.getLeaf = patchedGetLeaf;

        const patchedNotebookNavigatorOpenFile = function patchedNotebookNavigatorOpenFile(this: WorkspaceLeaf, ...args: Parameters<WorkspaceLeaf["openFile"]>) {
            const shouldFocusAfterOpen = redirectedNotebookNavigatorLeaves.has(this);
            if (shouldFocusAfterOpen) redirectedNotebookNavigatorLeaves.delete(this);

            if (shouldFocusAfterOpen) {
                const options = args[1];
                args[1] = { ...(options && typeof options === "object" ? options : {}), active: true } as Parameters<WorkspaceLeaf["openFile"]>[1];
            }

            const result = originalLeafOpenFile.apply(this, args);
            if (!shouldFocusAfterOpen) return result;

            return Promise.resolve(result).then((value) => {
                const file = args[0] instanceof TFile ? args[0].path : null;
                const focusIfStillTarget = () => {
                    focusRedirectedLeafIfStillTarget(this, file);
                };
                focusIfStillTarget();
                window.setTimeout(focusIfStillTarget, 100);
                window.setTimeout(focusIfStillTarget, 350);
                logger.log("[Notebook Navigator] Focused redirected file tab after open.", { file });
                return value;
            }) as ReturnType<WorkspaceLeaf["openFile"]>;
        } as typeof WorkspaceLeaf.prototype.openFile;
        WorkspaceLeaf.prototype.openFile = patchedNotebookNavigatorOpenFile;

        const patchedNotebookNavigatorSetViewState = function patchedNotebookNavigatorSetViewState(this: WorkspaceLeaf, ...args: Parameters<WorkspaceLeaf["setViewState"]>) {
            const shouldFocusAfterSetViewState = redirectedNotebookNavigatorLeaves.has(this);
            if (shouldFocusAfterSetViewState) redirectedNotebookNavigatorLeaves.delete(this);

            const result = originalLeafSetViewState.apply(this, args);
            if (!shouldFocusAfterSetViewState) return result;

            return Promise.resolve(result).then((value) => {
                const file = getViewStateTargetPath(args[0]);
                const focusIfStillTarget = () => {
                    focusRedirectedLeafIfStillTarget(this, file);
                };
                focusIfStillTarget();
                window.setTimeout(focusIfStillTarget, 100);
                window.setTimeout(focusIfStillTarget, 350);
                logger.log("[Notebook Navigator] Focused redirected view tab after setViewState.", { file });
                return value;
            }) as ReturnType<WorkspaceLeaf["setViewState"]>;
        } as typeof WorkspaceLeaf.prototype.setViewState;
        WorkspaceLeaf.prototype.setViewState = patchedNotebookNavigatorSetViewState;

        this.notebookNavigatorOpenPatchInstalled = true;
        this.register(() => {
            if (workspace.getLeaf === patchedGetLeaf) {
                workspace.getLeaf = originalGetLeaf;
            }
            if (WorkspaceLeaf.prototype.openFile === patchedNotebookNavigatorOpenFile) {
                WorkspaceLeaf.prototype.openFile = originalLeafOpenFile;
            }
            if (WorkspaceLeaf.prototype.setViewState === patchedNotebookNavigatorSetViewState) {
                WorkspaceLeaf.prototype.setViewState = originalLeafSetViewState;
            }
        });
        this.register(() => {
            document.removeEventListener("pointerdown", markNotebookNavigatorInteraction, true);
            document.removeEventListener("keydown", markNotebookNavigatorInteraction, true);
            document.removeEventListener("contextmenu", markNotebookNavigatorInteraction, true);
        });
    }

    private isNotebookNavigatorOpenRequest(): boolean {
        const stack = new Error().stack || "";
        if (stack.includes("notebook-navigator")) return true;
        if (!this.notebookNavigatorPendingOpenRedirect) return false;
        if (Date.now() > this.notebookNavigatorInteractionUntil) {
            this.notebookNavigatorPendingOpenRedirect = false;
            return false;
        }
        this.notebookNavigatorPendingOpenRedirect = false;
        return true;
    }

    async onunload() {
        logger.flow("Lifecycle", "unload");
        this.stopS3agleAttachmentAutomation();
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
        logger.flow("Settings", "load:start");
        const data = await this.loadData();
        this.settings = {
            ...DEFAULT_CONTROLLER_SETTINGS,
            ...(data || {}),
        };
        this.cleanLegacySettings();
        const importedS3agleSettings = await this.migrateS3agleSettingsIfNeeded(data || {});
        const s3CredentialMigration = this.migrateS3CredentialsFromSettings();
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
        this.sanitizeTwoStageArchiveSettings();
        this.sanitizeS3agleAttachmentAutomationSettings();
        logger.setLoggingEnabled(this.settings.enableLogging);
        this.persistedSettingsSnapshot = this.snapshotSettingsForDiff();
        if (importedS3agleSettings || s3CredentialMigration.changed) {
            try {
                await this.saveSettings();
            } catch (error) {
                logger.flowError("S3AttachmentAutomation", "credentials:migration-save-failed", error, {
                    retainedLegacyFields: Object.keys(this.retainedLegacyS3Credentials).length,
                });
                new Notice("TPS Controller could not finish saving the S3 credential migration. Legacy values were retained and the migration will retry.", 12000);
            }
        }
        logger.flow("Settings", "load:done", this.summarizeSettingsForLog());
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

        this.settings.reminders = normalizeReminderSettingsInPlace(this.settings.reminders || []);
        if (!Array.isArray(this.settings.globalIgnoreCheckboxStates)) {
            this.settings.globalIgnoreCheckboxStates = [...DEFAULT_CONTROLLER_SETTINGS.globalIgnoreCheckboxStates];
        }
    }

    async saveSettings() {
        this.cleanLegacySettings();
        this.sanitizeTwoStageArchiveSettings();
        this.sanitizeS3agleAttachmentAutomationSettings();
        this.retryRetainedS3CredentialMigration();
        this.persistAlertStateToLocalStorage(this.settings.alertState);
        if (this.settingsSavePromise) {
            this.settingsSavePending = true;
            logger.flow("Settings", "save:coalesced", { changedKeys: this.getChangedSettingKeys() });
            await this.settingsSavePromise;
            return;
        }

        do {
            this.settingsSavePending = false;
            const persisted = {
                ...JSON.parse(JSON.stringify(this.settings)),
                alertState: {},
            };
            (persisted as any).s3agleAttachmentAutomation = withRetainedLegacyS3Credentials(
                (persisted as any).s3agleAttachmentAutomation || {},
                this.retainedLegacyS3Credentials,
            );
            const changedKeys = this.getChangedSettingKeys();
            logger.flow("Settings", "save:start", {
                changedKeys,
                pending: this.settingsSavePending,
                ...this.summarizeSettingsForLog(),
            });
            this.settingsSavePromise = this.saveData(persisted);
            try {
                await this.settingsSavePromise;
                this.persistedSettingsSnapshot = this.snapshotSettingsForDiff();
                logger.flow("Settings", "save:done", {
                    changedKeys,
                    pendingAgain: this.settingsSavePending,
                });
            } finally {
                this.settingsSavePromise = null;
            }
        } while (this.settingsSavePending);

        logger.setLoggingEnabled(this.settings.enableLogging);
        this.app.workspace.trigger(TPS_EVENTS.CONTROLLER_SETTINGS_CHANGED as any, {
            sourcePluginId: this.manifest.id,
            timestamp: Date.now(),
        });
    }

    private snapshotSettingsForDiff(): Record<string, unknown> {
        try {
            return JSON.parse(JSON.stringify({
                ...this.settings,
                alertState: {},
            }));
        } catch {
            return {};
        }
    }

    private getChangedSettingKeys(): string[] {
        const previous = this.persistedSettingsSnapshot || {};
        const current = this.snapshotSettingsForDiff();
        const keys = new Set([...Object.keys(previous), ...Object.keys(current)]);
        const changed: string[] = [];
        for (const key of keys) {
            if (JSON.stringify(previous[key]) !== JSON.stringify(current[key])) changed.push(key);
        }
        return changed.sort();
    }

    private summarizeSettingsForLog(): Record<string, unknown> {
        return {
            role: this.deviceRoleManager?.role || "unknown",
            enableLogging: this.settings.enableLogging === true,
            enableReminders: this.settings.enableReminders === true,
            externalCalendars: this.settings.externalCalendars?.length || 0,
            enabledExternalCalendars: (this.settings.externalCalendars || []).filter((calendar) => calendar.enabled !== false).length,
            noLossSyncMode: this.settings.noLossSyncMode !== false,
            syncOnEventDelete: this.settings.syncOnEventDelete,
            archiveFolder: this.settings.archiveFolder || "",
            twoStageArchiveEnabled: this.settings.twoStageArchive?.enabled === true,
            s3agleAttachmentAutomationEnabled: this.settings.s3agleAttachmentAutomation?.enabled === true,
        };
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

    private sanitizeTwoStageArchiveSettings(): void {
        const defaults = DEFAULT_CONTROLLER_SETTINGS.twoStageArchive;
        const raw = this.settings.twoStageArchive || defaults;
        const normalizeFolder = (value: unknown, fallback: string): string => {
            const normalized = normalizePath(String(value || "").trim().replace(/^\/+|\/+$/g, ""));
            return normalized || fallback;
        };
        const cadence = raw.cadence === "daily" || raw.cadence === "weekly" || raw.cadence === "monthly-end"
            ? raw.cadence
            : defaults.cadence;
        const weeklyDay = Number(raw.weeklyDay);
        const checkIntervalMinutes = Number(raw.checkIntervalMinutes);
        this.settings.twoStageArchive = {
            enabled: raw.enabled === true,
            sourceFolder: normalizeFolder(raw.sourceFolder, defaults.sourceFolder),
            destinationFolder: normalizeFolder(raw.destinationFolder, defaults.destinationFolder),
            cadence,
            checkIntervalMinutes: Number.isFinite(checkIntervalMinutes) && checkIntervalMinutes >= 1
                ? Math.floor(checkIntervalMinutes)
                : defaults.checkIntervalMinutes,
            weeklyDay: Number.isInteger(weeklyDay) && weeklyDay >= 0 && weeklyDay <= 6 ? weeklyDay : defaults.weeklyDay,
            runTime: /^\d{1,2}:\d{2}$/.test(String(raw.runTime || "")) ? String(raw.runTime) : defaults.runTime,
            lastRunKey: String(raw.lastRunKey || ""),
        };
    }

    private sanitizeS3agleAttachmentAutomationSettings(): void {
        const defaults = DEFAULT_CONTROLLER_SETTINGS.s3agleAttachmentAutomation;
        const raw = this.settings.s3agleAttachmentAutomation || defaults;
        const debounceSeconds = Number(raw.debounceSeconds);
        const cooldownMinutes = Number(raw.cooldownMinutes);
        const hashSeed = Number(raw.hashSeed);
        const bucketArchiveCheckIntervalMinutes = Number(raw.bucketArchiveCheckIntervalMinutes);
        const bucketArchiveOrphanDelayMinutes = Number(raw.bucketArchiveOrphanDelayMinutes);
        const bucketArchiveLastRunAt = Number(raw.bucketArchiveLastRunAt);
        const normalizeExtensionList = (value: unknown): string[] => {
            const items = Array.isArray(value)
                ? value
                : String(value || "").split(",");
            return Array.from(new Set(items
                .map((item) => String(item || "").trim().toLowerCase().replace(/^\./, ""))
                .filter(Boolean)))
                .sort();
        };
        this.settings.s3agleAttachmentAutomation = {
            enabled: raw.enabled === true,
            runOnActiveNoteOpen: raw.runOnActiveNoteOpen !== false,
            runOnActiveNoteModify: raw.runOnActiveNoteModify !== false,
            runOnPaste: raw.runOnPaste !== false,
            runAfterCommandIds: Array.isArray(raw.runAfterCommandIds)
                ? raw.runAfterCommandIds.map((id) => String(id || "").trim()).filter(Boolean)
                : [],
            debounceSeconds: Number.isFinite(debounceSeconds) && debounceSeconds >= 1
                ? Math.floor(debounceSeconds)
                : defaults.debounceSeconds,
            cooldownMinutes: Number.isFinite(cooldownMinutes) && cooldownMinutes >= 1
                ? Math.floor(cooldownMinutes)
                : defaults.cooldownMinutes,
            archiveUploadedSources: raw.archiveUploadedSources !== false,
            allowedAttachmentExtensions: normalizeExtensionList(raw.allowedAttachmentExtensions),
            ignoredAttachmentExtensions: normalizeExtensionList(raw.ignoredAttachmentExtensions),
            makeUploadedObjectsPublic: raw.makeUploadedObjectsPublic !== false,
            accessKeySecretName: typeof raw.accessKeySecretName === "string"
                ? raw.accessKeySecretName.trim()
                : defaults.accessKeySecretName,
            secretKeySecretName: typeof raw.secretKeySecretName === "string"
                ? raw.secretKeySecretName.trim()
                : defaults.secretKeySecretName,
            region: String(raw.region || defaults.region).trim() || defaults.region,
            bucket: String(raw.bucket || "").trim(),
            folder: normalizePath(String(raw.folder || "").trim().replace(/^\/+|\/+$/g, "")),
            endpoint: String(raw.endpoint || "").trim().replace(/\/+$/g, ""),
            useBucketSubdomain: raw.useBucketSubdomain === true,
            contentUrl: String(raw.contentUrl || "").trim().replace(/\/+$/g, ""),
            hashFileName: raw.hashFileName === true,
            hashSeed: Number.isFinite(hashSeed) ? Math.floor(hashSeed) : defaults.hashSeed,
            archiveUnreferencedBucketObjects: raw.archiveUnreferencedBucketObjects === true,
            bucketArchivePrefix: normalizePath(String(raw.bucketArchivePrefix || defaults.bucketArchivePrefix).trim().replace(/^\/+|\/+$/g, "")) || defaults.bucketArchivePrefix,
            bucketArchiveCheckIntervalMinutes: Number.isFinite(bucketArchiveCheckIntervalMinutes) && bucketArchiveCheckIntervalMinutes >= 1
                ? Math.floor(bucketArchiveCheckIntervalMinutes)
                : defaults.bucketArchiveCheckIntervalMinutes,
            bucketArchiveOrphanDelayMinutes: Number.isFinite(bucketArchiveOrphanDelayMinutes)
                ? Math.max(5, Math.floor(bucketArchiveOrphanDelayMinutes))
                : defaults.bucketArchiveOrphanDelayMinutes,
            bucketArchiveLastRunAt: Number.isFinite(bucketArchiveLastRunAt) && bucketArchiveLastRunAt > 0
                ? Math.floor(bucketArchiveLastRunAt)
                : defaults.bucketArchiveLastRunAt,
        };
    }

    private async migrateS3agleSettingsIfNeeded(rawControllerData: Record<string, unknown>): Promise<boolean> {
        const existing = (rawControllerData as any)?.s3agleAttachmentAutomation || {};
        if (existing.bucket || existing.endpoint) return false;
        try {
            const content = await this.app.vault.adapter.read(".obsidian/plugins/s3agle/data.json");
            const s3agle = JSON.parse(content || "{}");
            const migrated: Record<string, unknown> = {
                ...DEFAULT_CONTROLLER_SETTINGS.s3agleAttachmentAutomation,
                ...(this.settings.s3agleAttachmentAutomation || {}),
                region: String(s3agle.s3Region || DEFAULT_CONTROLLER_SETTINGS.s3agleAttachmentAutomation.region),
                bucket: String(s3agle.bucket || ""),
                folder: String(s3agle.s3Folder || ""),
                endpoint: String(s3agle.s3Url || ""),
                useBucketSubdomain: s3agle.useBucketSubdomain === true,
                contentUrl: String(s3agle.useCustomContentUrl && s3agle.customContentUrl ? s3agle.customContentUrl : ""),
                hashFileName: s3agle.hashFileName === true,
                hashSeed: Number(s3agle.hashSeed || 0),
            };
            if (existing.accessKey || s3agle.accessKey) migrated.accessKey = String(existing.accessKey || s3agle.accessKey || "");
            if (existing.secretKey || s3agle.secretKey) migrated.secretKey = String(existing.secretKey || s3agle.secretKey || "");
            this.settings.s3agleAttachmentAutomation = migrated as any;
            logger.flow("S3AttachmentAutomation", "settings:migrated-from-s3agle", {
                hasAccessKey: !!s3agle.accessKey,
                hasSecretKey: !!s3agle.secretKey,
                hasBucket: !!s3agle.bucket,
            });
            return true;
        } catch (error) {
            logger.flow("S3AttachmentAutomation", "settings:migrate-s3agle-skipped", {
                error: logger.errorSummary(error),
            });
            return false;
        }
    }

    private migrateS3CredentialsFromSettings(): S3CredentialMigrationResult {
        const rule = this.settings.s3agleAttachmentAutomation as unknown as Record<string, unknown>;
        const result = migrateLegacyS3Credentials(rule, this.app.secretStorage);
        this.retainedLegacyS3Credentials = takeRetainedLegacyS3Credentials(rule);
        logger.flow("S3AttachmentAutomation", "credentials:migration", {
            migrated: result.migrated,
            reusedExisting: result.reusedExisting,
            retainedLegacy: result.retainedLegacy,
            failedFields: result.failedFields.length,
        });
        if (result.failedFields.length) {
            new Notice("TPS Controller could not move all S3 credentials into device-local SecretStorage. Legacy values were retained; select populated secrets in settings and reload.", 12000);
        }
        return result;
    }

    private retryRetainedS3CredentialMigration(): void {
        if (!Object.keys(this.retainedLegacyS3Credentials).length) return;
        const rule: Record<string, unknown> = {
            ...(this.settings.s3agleAttachmentAutomation as unknown as Record<string, unknown>),
            ...this.retainedLegacyS3Credentials,
        };
        const result = migrateLegacyS3Credentials(rule, this.app.secretStorage);
        this.settings.s3agleAttachmentAutomation.accessKeySecretName = String(rule.accessKeySecretName || "").trim();
        this.settings.s3agleAttachmentAutomation.secretKeySecretName = String(rule.secretKeySecretName || "").trim();
        this.retainedLegacyS3Credentials = takeRetainedLegacyS3Credentials(rule);
        if (result.migrated || result.reusedExisting) {
            logger.flow("S3AttachmentAutomation", "credentials:migration-retry", {
                migrated: result.migrated,
                reusedExisting: result.reusedExisting,
                retainedLegacy: result.retainedLegacy,
            });
        }
    }

    // ========================================================================
    // Role Management
    // ========================================================================

    private onRoleChanged(role: DeviceRole) {
        logger.flow("DeviceRole", "changed", { role, isMobile: Platform.isMobile });
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
        logger.flow("Automation", "enter-controller-mode", { isMobile: Platform.isMobile });
        if (Platform.isMobile) {
            this.stopAllAutomation();
            new Notice("Controller automation is disabled on mobile. This device will behave as a passive user device.", 4000);
            logger.warn("Controller role is set, but mobile devices do not run background automation.");
            return;
        }
        new Notice("Controller mode activated. Running background automation.", 3000);
        this.startAllAutomation();
    }

    private exitControllerMode() {
        logger.flow("Automation", "exit-controller-mode");
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
        logger.flow("Automation", "start-all", {
            remindersEnabled: this.settings.enableReminders,
            timeTrackingRemindersEnabled: this.settings.enableTimeTrackingHourlyReminders !== false,
            twoStageArchiveEnabled: this.settings.twoStageArchive?.enabled === true,
            syncIntervalMinutes: this.settings.syncIntervalMinutes,
            calendarCount: this.settings.externalCalendars?.length || 0,
        });
        void this.checkAndFulfillSyncRequests("controller-startup");
        this.startSyncRequestLoop();
        this.calendarAutomation.start();
        this.startReminderLoop();
        this.startTimeTrackingReminderLoop();
        this.startParentChildMaintenanceLoop();
        this.startTwoStageArchiveLoop();
        this.startS3BucketArchiveLoop();
        this.syncConflictWatcher.updateConfig(this.settings.archiveFolder, this.settings.eventIdKey);
        this.syncConflictWatcher.start();
        logger.flow("Automation", "start-all:done");
    }

    private stopAllAutomation() {
        logger.flow("Automation", "stop-all");
        this.calendarAutomation.stop();
        this.stopSyncRequestLoop();
        this.stopReminderLoop();
        this.stopTimeTrackingReminderLoop();
        this.stopParentChildMaintenanceLoop();
        this.stopTwoStageArchiveLoop();
        this.stopS3BucketArchiveLoop();
        this.syncConflictWatcher.stop();
    }

    restartS3agleAttachmentAutomation(): void {
        this.startS3agleAttachmentAutomation();
    }

    async runS3agleAttachmentAutomationNow(): Promise<void> {
        await this.s3agleAttachmentAutomationService.runActiveNoteNow();
    }

    restartS3BucketArchiveLoop(): void {
        if (!this.deviceRoleManager?.isController?.()) return;
        this.startS3BucketArchiveLoop();
    }

    async runS3BucketArchiveNow() {
        return logger.timeAsync("S3BucketArchive", "manual-run", {}, () => this.s3agleAttachmentAutomationService.runBucketArchiveNow());
    }

    restartTwoStageArchiveLoop(): void {
        if (!this.deviceRoleManager?.isController?.()) return;
        this.startTwoStageArchiveLoop();
    }

    async runTwoStageArchiveNow() {
        return logger.timeAsync("TwoStageArchive", "manual-run", {}, () => this.twoStageArchiveService.runNow());
    }

    private startTwoStageArchiveLoop(): void {
        this.stopTwoStageArchiveLoop();
        if (!this.settings.twoStageArchive?.enabled) {
            logger.flow("TwoStageArchive", "loop:not-enabled");
            return;
        }
        logger.flow("TwoStageArchive", "loop:start", {
            checkIntervalMs: this.twoStageArchiveService.getCheckIntervalMs(),
            sourceFolder: this.settings.twoStageArchive.sourceFolder,
            destinationFolder: this.settings.twoStageArchive.destinationFolder,
            cadence: this.settings.twoStageArchive.cadence,
            runTime: this.settings.twoStageArchive.runTime,
        });

        const tick = () => {
            void this.twoStageArchiveService.runIfDue().catch((error) => {
                logger.flowError("TwoStageArchive", "scheduled-run:failed", error);
            });
        };
        tick();
        this.twoStageArchiveIntervalId = window.setInterval(tick, this.twoStageArchiveService.getCheckIntervalMs());
    }

    private stopTwoStageArchiveLoop(): void {
        if (this.twoStageArchiveIntervalId !== null) {
            window.clearInterval(this.twoStageArchiveIntervalId);
            this.twoStageArchiveIntervalId = null;
            logger.flow("TwoStageArchive", "loop:stopped");
        }
    }

    private startS3BucketArchiveLoop(): void {
        this.stopS3BucketArchiveLoop();
        if (Platform.isMobile) {
            logger.flow("S3BucketArchive", "loop:skip-mobile");
            return;
        }
        if (!this.settings.s3agleAttachmentAutomation?.archiveUnreferencedBucketObjects) {
            logger.flow("S3BucketArchive", "loop:not-enabled");
            return;
        }
        logger.flow("S3BucketArchive", "loop:start", {
            checkIntervalMs: this.s3agleAttachmentAutomationService.getBucketArchiveCheckIntervalMs(),
            archivePrefix: this.settings.s3agleAttachmentAutomation.bucketArchivePrefix,
            orphanDelayMinutes: this.settings.s3agleAttachmentAutomation.bucketArchiveOrphanDelayMinutes,
        });
        const tick = () => {
            void this.s3agleAttachmentAutomationService.runBucketArchiveIfDue().catch((error) => {
                logger.flowError("S3BucketArchive", "scheduled-run:failed", error);
            });
        };
        tick();
        this.s3BucketArchiveIntervalId = window.setInterval(tick, this.s3agleAttachmentAutomationService.getBucketArchiveCheckIntervalMs());
    }

    private stopS3BucketArchiveLoop(): void {
        if (this.s3BucketArchiveIntervalId !== null) {
            window.clearInterval(this.s3BucketArchiveIntervalId);
            this.s3BucketArchiveIntervalId = null;
            logger.flow("S3BucketArchive", "loop:stopped");
        }
    }

    private startS3agleAttachmentAutomation(): void {
        this.s3agleAttachmentAutomationService.start();
    }

    private stopS3agleAttachmentAutomation(): void {
        this.s3agleAttachmentAutomationService.stop();
    }

    private async createS3AttachmentAutomationService(): Promise<S3AttachmentAutomationAPI> {
        if (Platform.isMobile) {
            logger.flow("S3agleAutomation", "service:mobile-disabled");
            return new DisabledS3AttachmentAutomationService();
        }
        const module = await import("./services/s3agle-attachment-automation-service");
        return new module.S3agleAttachmentAutomationService(
            this.app,
            () => this.settings,
            () => this.deviceRoleManager?.isController?.() === true,
            (notePath, sourcePaths) => this.syncRequestService.writeS3agleArchiveRequest(notePath, sourcePaths),
            () => this.saveSettings(),
            (name) => this.app.secretStorage.getSecret(name),
        );
    }

    private deferCalendarSyncSettlement(reason: string): void {
        const nextReadyAt = Date.now() + this.calendarSyncSettleWindowMs;
        if (nextReadyAt > this.calendarSyncSettledAt) {
            this.calendarSyncSettledAt = nextReadyAt;
        }
        logger.flow("CalendarSync", "settlement:deferred", {
            reason,
            readyInMs: Math.max(0, this.calendarSyncSettledAt - Date.now()),
        });
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
            logger.flow("CalendarSync", "run-calendar-sync:controller", { force });
            await this.calendarAutomation.runSync(force);
            return;
        }
        logger.flow("CalendarSync", "run-calendar-sync:replica-request", { force, scope: ["calendar"] });
        await this.requestSync(["calendar"]);
    }

    private async requestSync(scope: ("calendar" | "reminders" | "s3agle-archive")[]) {
        logger.flow("SyncRequest", "write:start", { scope, role: this.deviceRoleManager?.role || "unknown" });
        await this.syncRequestService.writeRequest(scope);
        logger.flow("SyncRequest", "write:done", { scope });
        new Notice(`Sync requested (${scope.join(", ")}). Will be processed by Controller.`);
    }

    private checkAndFulfillSyncRequests(cause: "controller-startup" | "poll-interval"): Promise<void> {
        const flight = joinSyncRequestFulfillment(this.syncRequestFulfillmentPromise, () => (
            this.fulfillOneSyncRequest(cause).catch((error) => {
                logger.flowError("SyncRequest", "fulfill:failed", error, { cause });
            })
        ));
        if (flight.joined) {
            logger.flow("SyncRequest", "fulfill:join-active", { cause });
            return flight.promise;
        }
        const run = flight.promise;
        this.syncRequestFulfillmentPromise = run;
        void run.finally(() => {
            if (this.syncRequestFulfillmentPromise === run) this.syncRequestFulfillmentPromise = null;
        });
        return run;
    }

    private async fulfillOneSyncRequest(cause: "controller-startup" | "poll-interval"): Promise<void> {
        const request = await this.syncRequestService.readRequest();
        if (!request) return;
        await logger.timeAsync("SyncRequest", "fulfill", {
            cause,
            requestId: request.requestId,
            scope: request.scope,
        }, async () => {
            const acknowledged = await executeSyncRequestGeneration(async () => {
                if (request.scope.includes("calendar")) await this.calendarAutomation.runSync();
                if (request.scope.includes("reminders")) await this.runReminderCheck();
                if (request.scope.includes("s3agle-archive")) {
                    const result = await this.s3agleAttachmentAutomationService.fulfillArchiveRequests(request.s3agleArchiveRequests);
                    if (result.archivedCount > 0 || result.skippedArchiveCount > 0) {
                        new Notice(`S3agle archive: moved ${result.archivedCount}, skipped ${result.skippedArchiveCount}.`);
                    }
                }
            }, () => this.syncRequestService.acknowledgeRequest(request));
            logger.flow("SyncRequest", "fulfill:acknowledged", {
                requestId: request.requestId,
                acknowledged,
            });
        });
    }

    private startSyncRequestLoop() {
        this.stopSyncRequestLoop();
        // Keep request fulfillment responsive for user-device manual sync commands.
        this.syncRequestIntervalId = window.setInterval(() => {
            void this.checkAndFulfillSyncRequests("poll-interval");
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
        if (!this.settings.enableReminders) {
            logger.flow("ReminderLoop", "start:not-enabled");
            return;
        }
        this.reminderStartupTimeoutId = window.setTimeout(() => {
            this.reminderStartupTimeoutId = null;
            void this.runReminderCheck();
        }, 10000);
        const pollMs = Math.max(30000, this.settings.pollMinutes * 60 * 1000);
        const activeRepeatMs = (this.settings.reminders || [])
            .filter((reminder) => reminder.enabled && reminder.repeatUntilComplete && Number(reminder.repeatIntervalMinutes) > 0)
            .map((reminder) => Number(reminder.repeatIntervalMinutes) * 60 * 1000);
        const ms = Math.max(30000, Math.min(pollMs, ...activeRepeatMs));
        logger.flow("ReminderLoop", "start", {
            pollMs,
            intervalMs: ms,
            reminderRules: this.settings.reminders?.length || 0,
            activeRepeatingRules: activeRepeatMs.length,
        });
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
            logger.flow("ReminderLoop", "stopped");
        }
    }

    private startTimeTrackingReminderLoop(): void {
        this.stopTimeTrackingReminderLoop();
        if (this.settings.enableTimeTrackingHourlyReminders === false) {
            logger.flow("TimeTrackingReminder", "loop:not-enabled");
            return;
        }
        logger.flow("TimeTrackingReminder", "loop:start");

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
        if (!this.deviceRoleManager.isController()) {
            logger.flow("TimeTrackingReminder", "check:skip-role", { role: this.deviceRoleManager.role });
            return;
        }
        if (this.settings.enableTimeTrackingHourlyReminders === false) {
            logger.flow("TimeTrackingReminder", "check:skip-disabled");
            return;
        }

        const now = new Date();
        if (now.getMinutes() > 2) return;

        const hourStart = new Date(now);
        hourStart.setMinutes(0, 0, 0);
        const hourKey = moment(hourStart).format("YYYY-MM-DDTHH");

        const gcm = this.getGcmPlugin();
        const timeTracking = gcm?.timeTracking;
        if (typeof timeTracking?.getActiveTimers !== "function") {
            logger.flowWarn("TimeTrackingReminder", "check:no-gcm-timers");
            return;
        }

        const messager = this.getNotifierPlugin();
        if (!messager?.sendNotification && !messager?.sendMessage) {
            logger.flowWarn("TimeTrackingReminder", "check:no-notifier");
            return;
        }

        let activeSessions: GcmTimeTrackingSession[] = [];
        try {
            activeSessions = await timeTracking.getActiveTimers();
        } catch (error) {
            logger.warn("Failed to read active time tracking sessions for hourly reminders.", error);
            return;
        }

        logger.flow("TimeTrackingReminder", "check:sessions", { activeSessions: activeSessions.length, hourKey });
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

        logger.flow("TimeTrackingReminder", "check:done", { activeSessions: activeSessions.length, changed });
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
        if (!this.settings.enableReminders) {
            logger.flow("ReminderEngine", "check:skip-disabled");
            return;
        }
        const alertStateBeforeRun = this.cloneAlertState(this.settings.alertState);
        const result = await logger.timeAsync("ReminderEngine", "check", {
            rules: this.settings.reminders?.length || 0,
            batchNotifications: this.settings.batchNotifications === true,
        }, () => this.reminderEngine.evaluateReminders(this.settings));
        if (result.stateChanged) this.scheduleReminderStateSave();
        this.app.workspace.trigger(TPS_EVENTS.REMINDERS_UPDATED as any, {
            sourcePluginId: this.manifest.id,
            timestamp: Date.now(),
            notificationCount: result.notifications.length,
            stateChanged: result.stateChanged,
        });
        logger.flow("ReminderEngine", "check:result", {
            notifications: result.notifications.length,
            stateChanged: result.stateChanged,
        });
        if (!result.notifications.length) return;

        const externalNotifications = result.notifications.filter((n) => n.sourceType === "external-event");
        const allDayNotifications = result.notifications.filter((n) => n.isAllDay && n.sourceType !== "external-event");
        const nonAllDayNotifications = result.notifications.filter((n) => !n.isAllDay && n.sourceType !== "external-event");
        const batches = this.buildReminderNotificationBatches(nonAllDayNotifications, allDayNotifications, externalNotifications);
        logger.flow("ReminderEngine", "delivery:prepared", {
            notifications: result.notifications.length,
            batches: batches.length,
            nonAllDay: nonAllDayNotifications.length,
            allDay: allDayNotifications.length,
            external: externalNotifications.length,
        });

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
            logger.flow("ReminderEngine", "delivery:done", {
                batches: batches.length,
                route: notifier.sendNotification ? "sendNotification" : "sendMessage",
            });
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
        if (!this.deviceRoleManager.isController()) {
            logger.flow("Maintenance", "recurrence:skip-role", { role: this.deviceRoleManager.role });
            return;
        }
        const gcm = this.getGcmPlugin();
        const checkMissing = gcm?.services?.recurrence?.checkMissingRecurrences
            || gcm?.bulkEditService?.checkMissingRecurrences;
        if (typeof checkMissing !== "function") {
            logger.flowWarn("Maintenance", "recurrence:unavailable");
            return;
        }
        try {
            logger.flow("Maintenance", "recurrence:start");
            await checkMissing.call(gcm?.services?.recurrence || gcm?.bulkEditService);
            logger.flow("Maintenance", "recurrence:done");
        } catch (error) {
            logger.flowError("Maintenance", "recurrence:failed", error);
        }
    }

    private async runParentChildMaintenanceTick(): Promise<void> {
        if (!this.deviceRoleManager.isController()) {
            logger.flow("ParentChildMaintenance", "skip-role", { role: this.deviceRoleManager.role });
            return;
        }

        const gcm = this.getGcmPlugin();
        const reconcile = gcm?.bulkEditService?.reconcileParentChildLinksForParent;
        const ensureSelfLink = gcm?.bulkEditService?.ensureParentSelfLinkForParent;
        if (typeof reconcile !== "function" && typeof ensureSelfLink !== "function") {
            logger.flowWarn("ParentChildMaintenance", "skip-unavailable");
            return;
        }
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

        logger.flow("ParentChildMaintenance", "candidates:resolved", {
            files: files.length,
            candidates: parentCandidates.size,
            parentKey,
            childKey,
            hasReconcile: typeof reconcile === "function",
            hasEnsureSelfLink: typeof ensureSelfLink === "function",
        });
        if (!parentCandidates.size) return;

        let totalUpdates = 0;
        let failed = 0;
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
                failed++;
                logger.flowWarn("ParentChildMaintenance", "parent:failed", {
                    path: parentFile.path,
                    error: logger.errorSummary(error),
                });
            }
        }

        logger.flow("ParentChildMaintenance", "done", {
            candidates: parentCandidates.size,
            totalUpdates,
            failed,
        });
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
