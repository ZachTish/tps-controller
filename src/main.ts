
import { NoteRuleRunner } from "./services/note-rule-runner";
import { NoteRulePreviewModal } from "./services/note-rule-ui";
﻿import { App, Plugin, Notice, Platform, TFile, normalizePath } from "obsidian";
import { DeviceRoleManager, DeviceRole } from "./device-role-manager";
import { TPSControllerSettings, DEFAULT_CONTROLLER_SETTINGS } from "./types";
import { TPSControllerSettingTab, type ControllerSettingsPage } from "./settings-tab";
import * as logger from "./logger";
import { NotificationView, NOTIFICATION_VIEW_TYPE } from "./views/notification-view";
import type { OverdueItem } from "./types";
import { OverdueService } from "./services/overdue-service";
import { TwoStageArchiveService } from "./services/two-stage-archive-service";
import { TPS_EVENTS } from "./tps-events";
import { normalizeReminderSettingsInPlace } from "./services/reminder-settings-service";
import {
    CoalescedSettingsSaveQueue,
    mergeSettingsChangeSet,
} from "./services/settings-persistence";
import { portableVaultNamesMatch } from "./services/vault-name";

interface ControllerSettingsSaveSnapshot {
    persisted: Record<string, unknown>;
    comparable: Record<string, unknown>;
    changedKeys: string[];
    summary: Record<string, unknown>;
}

// ============================================================================
// Controller Plugin
// ============================================================================

export default class TPSControllerPlugin extends Plugin {
    settings: TPSControllerSettings;
    private readonly settingsSaveQueue = new CoalescedSettingsSaveQueue<ControllerSettingsSaveSnapshot>(
        () => this.captureSettingsSaveSnapshot(),
        (snapshot) => this.persistSettingsSnapshot(snapshot),
        () => this.finishSettingsSaveBatch(),
    );
    deviceRoleManager: DeviceRoleManager;
    private statusBarEl: HTMLElement;

    // Feature services
    private overdueService: OverdueService;
    private twoStageArchiveService: TwoStageArchiveService;
    private unloading = false;
    private persistedSettingsSnapshot: Record<string, unknown> | null = null;
    private readonly uncertainSettingsSaveKeys = new Set<string>();
    private settingsSaveBatchChanged = false;
    private settingsTab: TPSControllerSettingTab | null = null;

    noteRuleRunner: NoteRuleRunner;

    async onload() {
        logger.flow("Lifecycle", "load", {
            id: this.manifest.id,
            version: this.manifest.version,
            isMobile: Platform.isMobile,
        });

        await this.loadSettings();
        if (this.unloading) return;
        this.noteRuleRunner = new NoteRuleRunner(this.app, () => this.settings, async () => (await this.loadData())?.noteRules);
        this.register(() => this.noteRuleRunner.dispose());
        this.statusBarEl = this.addStatusBarItem();
        this.deviceRoleManager = new DeviceRoleManager(this.app, (role) => this.onRoleChanged(role));
        this.updateStatusBar(this.deviceRoleManager.role);

        // Feature services
        this.overdueService = new OverdueService(this.app, () => this.settings);
        this.twoStageArchiveService = new TwoStageArchiveService(this.app, () => this.settings, () => this.saveSettings());

        // Commands
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
            id: "open-notifications",
            name: "View Notifications",
            callback: () => this.traceCommand("open-notifications", () => this.overdueService.openNotificationModal()),
        });

        this.addCommand({
            id: "run-note-rules-current-note", name: "Preview Note Rules on Current Note",
            checkCallback: (checking) => {
                const file = this.app.workspace.getActiveFile();
                if (!file || file.extension !== "md") return false;
                if (!checking) new NoteRulePreviewModal(this.app, this.noteRuleRunner, { kind: "note", path: file.path }).open();
                return true;
            },
        });
        this.addCommand({
            id: "run-note-rules", name: "Preview Note Rules on Notes",
            callback: () => new NoteRulePreviewModal(this.app, this.noteRuleRunner, { kind: "folder", path: this.app.workspace.getActiveFile()?.parent?.path || "" }).open(),
        });

        // View + Ribbon
        this.registerView(NOTIFICATION_VIEW_TYPE, (leaf) => new NotificationView(leaf, this));
        this.addRibbonIcon('bell', 'View Notifications', () => { void this.overdueService.openNotificationModal(); });
        (this as any).api = {
            openConnectionSettings: (section?: unknown) => {
                const settings = (this.app as any).setting;
                settings?.open(); settings?.openTabById(this.manifest.id);
                this.settingsTab?.openConnectionSettings(section);
            },
            openPlaidSettings: () => {
                const settings = (this.app as any).setting;
                settings?.open(); settings?.openTabById(this.manifest.id);
                this.settingsTab?.openPlaidSettings();
            },
            isController: (): boolean => this.deviceRoleManager.isController(),
            getRole: (): DeviceRole => this.deviceRoleManager.role,
            getSettings: (): TPSControllerSettings => this.settings,
            getCalendarSettingsSnapshot: () => ({
                calendarStorageMode: this.settings.calendarStorageMode,
                externalCalendars: Array.isArray(this.settings.externalCalendars) ? [...this.settings.externalCalendars] : [],
                externalCalendarFilter: this.settings.externalCalendarFilter || "",
            }),
            getReminders: () => this.settings.reminders || [],
            getOverdueItems: () => this.getOverdueItems(),
            snoozeFile: (file: TFile, minutes: number) => this.snoozeFile(file, minutes),
        };
        (window as any).TPS = { controller: (this as any).api };

        this.settingsTab = new TPSControllerSettingTab(this.app, this);
        this.addSettingTab(this.settingsTab);
        this.registerObsidianProtocolHandler('tps-controller-settings', (params) => {
            if (
                params.action !== 'tps-controller-settings'
                || params.v !== '1'
                || params.section !== 'reminders'
                || !portableVaultNamesMatch(params.targetVault, this.app.vault.getName())
            ) {
                logger.flowWarn('TishOSIntegration', 'settings-handoff:rejected', {
                    action: params.action,
                    version: params.v ?? null,
                    section: params.section ?? null,
                    vaultMatches: portableVaultNamesMatch(
                        params.targetVault,
                        this.app.vault.getName(),
                    ),
                });
                return;
            }
            new Notice('Opening Controller reminder retirement information…');
            this.openSettingsPage('reminders');
        });
        this.registerObsidianProtocolHandler('tps-controller-command-bridge-pair', () => {
            new Notice('Controller reminder and command bridges are retired. No action was performed.');
        });
        this.registerObsidianProtocolHandler('tps-controller-run-command', () => {
            new Notice('Controller reminder and command bridges are retired. No action was performed.');
        });
        this.registerObsidianProtocolHandler('tps-controller-command-bridge-revoke', () => {
            new Notice('Controller reminder and command bridges are retired. No action was performed.');
        });
        this.registerObsidianProtocolHandler('tps-controller-native-notification-action', () => {
            new Notice('Controller reminder and command bridges are retired. No action was performed.');
        });

        logger.flow("Lifecycle", "loaded", {
            role: this.deviceRoleManager.role,
            isController: this.deviceRoleManager.isController(),
            remindersEnabled: this.settings.enableReminders,
            calendarCount: this.settings.externalCalendars?.length || 0,
        });
    }

    private openSettingsPage(page: ControllerSettingsPage): void {
        const settingManager = (this.app as App & {
            setting?: {
                open?: () => void;
                openTabById?: (id: string) => void;
            };
        }).setting;
        if (!settingManager?.open || !settingManager.openTabById || !this.settingsTab) {
            logger.flowWarn('TishOSIntegration', 'controller-settings:unavailable', { page });
            new Notice('Open Settings → Community plugins → TPS Controller → Reminder rules.');
            return;
        }
        this.settingsTab.openPage(page);
        settingManager.open();
        settingManager.openTabById(this.manifest.id);
        this.settingsTab.openPage(page);
        logger.flow('TishOSIntegration', 'controller-settings:opened', { page });
    }

    private traceCommand(commandId: string, action: () => Promise<void>): void {
        void logger.timeAsync("Command", commandId, {
            role: this.deviceRoleManager?.role || "unknown",
            isController: this.deviceRoleManager?.isController?.() === true,
            isMobile: Platform.isMobile,
        }, action);
    }

    async onunload() {
        this.unloading = true;
        delete (this as any).api;
        delete (window as any).TPS;
        logger.flow("Lifecycle", "unload");
        await this.settingsSaveQueue.waitForIdle();
    }

    async loadSettings() {
        logger.flow("Settings", "load:start");
        const loaded = await this.loadData();
        const data = loaded && typeof loaded === "object" && !Array.isArray(loaded)
            ? loaded as Record<string, unknown>
            : {};
        this.settings = { ...DEFAULT_CONTROLLER_SETTINGS, ...data };
        this.settings.reminders = normalizeReminderSettingsInPlace(this.settings.reminders || []);
        this.sanitizeFrontmatterKeySettings();
        this.sanitizeTwoStageArchiveSettings();
        this.persistedSettingsSnapshot = this.snapshotSettingsForDiff();
        logger.setLoggingEnabled(this.settings.enableLogging);
        logger.flow("Settings", "load:done", this.summarizeSettingsForLog());
    }

    async saveSettings() {
        this.sanitizeTwoStageArchiveSettings();
        await this.settingsSaveQueue.requestSave();
    }

    private captureSettingsSaveSnapshot(): ControllerSettingsSaveSnapshot {
        const comparable = this.snapshotSettingsForDiff();
        const persisted = {
            ...JSON.parse(JSON.stringify(this.settings)),
        } as Record<string, unknown>;
        const changedKeys = new Set(this.getChangedSettingKeys(comparable));
        for (const key of this.uncertainSettingsSaveKeys) changedKeys.add(key);
        return {
            persisted,
            comparable,
            changedKeys: [...changedKeys].sort(),
            summary: this.summarizeSettingsForLog(),
        };
    }

    private async persistSettingsSnapshot(snapshot: ControllerSettingsSaveSnapshot): Promise<void> {
        if (snapshot.changedKeys.length === 0) return;
        logger.flow("Settings", "save:start", {
            changedKeys: snapshot.changedKeys,
            ...snapshot.summary,
        });
        const latest = await this.loadData();
        const merged = mergeSettingsChangeSet(latest, snapshot.persisted, snapshot.changedKeys);
        try {
            await this.saveData(merged);
        } catch (error) {
            for (const key of snapshot.changedKeys) this.uncertainSettingsSaveKeys.add(key);
            throw error;
        }
        for (const key of snapshot.changedKeys) this.uncertainSettingsSaveKeys.delete(key);
        this.persistedSettingsSnapshot = snapshot.comparable;
        this.settingsSaveBatchChanged = true;
        logger.flow("Settings", "save:done", { changedKeys: snapshot.changedKeys });
    }

    private finishSettingsSaveBatch(): void {
        if (!this.settingsSaveBatchChanged) return;
        this.settingsSaveBatchChanged = false;
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
                }));
        } catch {
            return {};
        }
    }

    private getChangedSettingKeys(current = this.snapshotSettingsForDiff()): string[] {
        const previous = this.persistedSettingsSnapshot || {};
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
            notificationDeliveryProvider: this.settings.notificationDeliveryProvider,
            externalCalendars: this.settings.externalCalendars?.length || 0,
            enabledExternalCalendars: (this.settings.externalCalendars || []).filter((calendar) => calendar.enabled !== false).length,
            noLossSyncMode: this.settings.noLossSyncMode !== false,
            syncOnEventDelete: this.settings.syncOnEventDelete,
            archiveFolder: this.settings.archiveFolder || "",
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
        s.calendarEndDateTimeProperty = normalizeKey(s.calendarEndDateTimeProperty, d.calendarEndDateTimeProperty);

        const identity = new Set([s.eventIdKey.toLowerCase(), s.uidKey.toLowerCase()]);
        const ensureNotIdentity = (v: string, fb: string) => identity.has(v.toLowerCase()) ? fb : v;
        s.titleKey = ensureNotIdentity(s.titleKey, d.titleKey);
        s.statusKey = ensureNotIdentity(s.statusKey, d.statusKey);
        s.previousStatusKey = ensureNotIdentity(s.previousStatusKey, d.previousStatusKey);
        s.startProperty = ensureNotIdentity(s.startProperty, d.startProperty);
        s.endProperty = ensureNotIdentity(s.endProperty, d.endProperty);
        s.calendarEndDateTimeProperty = ensureNotIdentity(s.calendarEndDateTimeProperty, d.calendarEndDateTimeProperty);

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

    async runTwoStageArchiveNow() {
        return logger.timeAsync("TwoStageArchive", "manual-run", {}, () => this.twoStageArchiveService.runNow());
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
    async markOverdueItemComplete(item: OverdueItem): Promise<void> { await this.overdueService.markItemComplete(item); }
    async markOverdueItemWontDo(item: OverdueItem): Promise<void> { return this.overdueService.markItemWontDo(item); }
    async setOverdueItemStatus(item: OverdueItem, status: string | null): Promise<void> { return this.overdueService.setItemStatus(item, status); }
    async resolveOverdueTaskReminder(item: OverdueItem): Promise<boolean> { return this.overdueService.resolveTaskReminder(item); }
    refreshNotificationViews(): void {
        for (const leaf of this.app.workspace.getLeavesOfType(NOTIFICATION_VIEW_TYPE)) {
            const view = leaf.view as NotificationView;
            void view.refresh?.();
        }
    }

}
