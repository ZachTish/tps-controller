import { App, Notice, PluginSettingTab, Setting, debounce, normalizePath } from 'obsidian';
import type TPSControllerPlugin from './main';
import type { PropertyReminder, ExternalCalendarConfig } from './types';
import { normalizeCalendarUrl } from './utils';
import { renderListWithControls } from './utils/list-renderer';

const createCalendarId = () => `calendar-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
const normalizeTaskTargetNotePath = (value: string): string => {
    const normalized = normalizePath(String(value || "")
        .trim()
        .replace(/^\[\[|\]\]$/g, "")
        .replace(/^\/+/, ""));
    if (!normalized) return "";
    return normalized.toLowerCase().endsWith(".md") ? normalized : `${normalized}.md`;
};
const createCollapsibleSection = (
    parent: HTMLElement,
    title: string,
    description?: string,
    defaultOpen = false
): HTMLElement => {
    const details = parent.createEl('details', { cls: 'tps-collapsible-section' });
    if (defaultOpen) {
        details.setAttr('open', 'true');
    }

    const summary = details.createEl('summary', { cls: 'tps-collapsible-section-summary' });
    summary.createSpan({ cls: 'tps-collapsible-section-title', text: title });

    if (description) {
        details.createEl('p', {
            cls: 'tps-collapsible-section-description',
            text: description
        });
    }

    return details.createDiv({ cls: 'tps-collapsible-section-content' });
};

// ============================================================================
// Controller Settings Tab
// ============================================================================

export class TPSControllerSettingTab extends PluginSettingTab {
    plugin: TPSControllerPlugin;
    private settingsViewState = new Map<string, boolean>();
    private reminderRuleViewState = new Map<string, boolean>();
    private reminderRuleFilterQuery = '';
    private settingsScrollTop = 0;
    private hasRenderedSettings = false;

    constructor(app: App, plugin: TPSControllerPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        this.captureSettingsViewState(containerEl);
        containerEl.empty();

        const debouncedSave = debounce(() => this.plugin.saveSettings(), 300);

        containerEl.createEl('h2', { text: 'TPS Controller Settings' });
        containerEl.createEl('p', {
            text: 'This is the suite-level owner for background automation, calendar sync, reminders, and shared calendar field mappings. Other TPS plugins should stay focused on UI and local interaction.',
            cls: 'setting-item-description'
        });

        const createMainCategory = (title: 'Features' | 'Rules' | 'Interaction' | 'UI Display', defaultOpen = true): HTMLElement => {
            const details = containerEl.createEl('details', { cls: 'tps-settings-main-category' });
            if (defaultOpen) details.setAttr('open', 'true');
            const summary = details.createEl('summary', { cls: 'tps-settings-main-summary' });
            summary.createEl('h3', { text: title });
            return details.createDiv({ cls: 'tps-settings-main-content' });
        };

        const featuresCategory = createMainCategory('Features');
        const rulesCategory = createMainCategory('Rules');
        const interactionCategory = createMainCategory('Interaction');
        const uiDisplayCategory = createMainCategory('UI Display');

        // ── Device Role ─────────────────────────────────────────────
        const roleSection = createCollapsibleSection(
            featuresCategory,
            'Device Role',
            'Choose whether this device runs suite-level automation or stays in normal user mode.',
            false
        );

        const roleDesc = roleSection.createDiv({ cls: 'tps-controller-role-desc' });
        const updateRoleDesc = (role: string) => {
            const isCtrl = role === 'controller';
            roleDesc.innerHTML = `
                <strong>Current Role:</strong>
                <span class="${isCtrl ? 'tps-role-controller' : 'tps-role-user'}">
                    ${isCtrl ? '🟢 Controller (Background Automation)' : '⚪ User (Normal Use)'}
                </span>
                <br><small class="tps-role-hint">
                    ${isCtrl ? 'This device runs automation (calendar sync, reminders, and maintenance). UI is locked down.' : 'This device is in normal user mode — no automation runs.'}
                </small>
            `;
        };
        const currentRole = this.plugin.deviceRoleManager?.role || 'user';
        updateRoleDesc(currentRole);

        new Setting(roleSection)
            .setName('Set Device Role')
            .addDropdown(drop => drop
                .addOption('controller', 'Controller (Background Automation)')
                .addOption('user', 'User (Normal Use)')
                .setValue(currentRole)
                .onChange(async (value) => {
                    this.plugin.deviceRoleManager.setRole(value as any);
                    updateRoleDesc(value);
                    new Notice(`Device set to ${value === 'controller' ? 'CONTROLLER' : 'USER'} mode.`);
                }));

        // ── External Calendars ─────────────────────────────────────
        const extCalSection = createCollapsibleSection(
            featuresCategory,
            'External Calendars',
            'Calendar sources and auto-create destinations. These are the controller settings most users will change first.',
            false
        );
        const calendarsContainer = extCalSection.createDiv();
        this.renderExternalCalendars(calendarsContainer);

        new Setting(extCalSection)
            .setName('Add New Calendar')
            .setDesc('Add an external iCal feed (Google, Outlook, etc).')
            .addButton((btn) => btn
                .setIcon('plus')
                .setButtonText('Add Calendar')
                .setCta()
                .onClick(async () => {
                    this.plugin.settings.externalCalendars.push({
                        id: createCalendarId(),
                        url: "",
                        color: "#3b82f6",
                        enabled: true,
                        autoCreateEnabled: true,
                        autoCreateMode: "note",
                        autoCreateTaskDestination: "daily-note",
                        autoCreateTaskTargetPath: "",
                        autoCreateTypeFolder: "",
                        autoCreateFolder: "",
                        autoCreateTag: "",
                        autoCreateTemplate: "",
                    });
                    await this.plugin.saveSettings();
                    this.renderExternalCalendars(calendarsContainer);
                }));

        new Setting(extCalSection)
            .setName('Sync External Calendars')
            .setDesc('Run external calendar sync immediately.')
            .addButton(btn => btn
                .setButtonText('Sync Now')
                .setCta()
                .onClick(async () => {
                    btn.setButtonText('Syncing...');
                    btn.setDisabled(true);
                    try {
                        await this.plugin.runCalendarSync(true);
                        new Notice('Calendar sync complete.');
                    } catch (e) {
                        new Notice('Sync failed: ' + (e as Error).message);
                    }
                    btn.setButtonText('Sync Now');
                    btn.setDisabled(false);
                }));

        // ── Calendar Sync Rules ────────────────────────────────────
        const calSection = createCollapsibleSection(
            rulesCategory,
            'Calendar Sync Rules',
            'Global sync behavior for external calendars.',
            false
        );

        new Setting(calSection)
            .setName('Sync Interval (minutes)')
            .setDesc('How often to sync external calendars.')
            .addSlider(slider => slider
                .setLimits(1, 60, 1)
                .setValue(this.plugin.settings.syncIntervalMinutes)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.syncIntervalMinutes = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(calSection)
            .setName('No-Loss Sync Mode')
            .setDesc('Prevents inferred deletes from remote absence. Orphans are quarantined for manual review; explicit cancellations can archive.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.noLossSyncMode ?? true)
                .onChange(async (value) => {
                    this.plugin.settings.noLossSyncMode = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(calSection)
            .setName('On Event Deletion')
            .setDesc('What to do when an external event is removed from the feed. In No-Loss mode, "Delete note" is treated as archive-safe behavior.')
            .addDropdown(drop => drop
                .addOption('nothing', 'Do nothing')
                .addOption('archive', 'Move to archive folder')
                .addOption('delete', 'Delete note')
                .setValue(this.plugin.settings.syncOnEventDelete)
                .onChange(async (value) => {
                    this.plugin.settings.syncOnEventDelete = value as any;
                    await this.plugin.saveSettings();
                }));

        new Setting(calSection)
            .setName('Archive Folder')
            .setDesc('Folder to move archived event notes to.')
            .addText(text => text
                .setPlaceholder('System/Archive')
                .setValue(this.plugin.settings.archiveFolder)
                .onChange((value) => {
                    this.plugin.settings.archiveFolder = value;
                    void debouncedSave();
                }));

        new Setting(calSection)
            .setName('Calendar Filter')
            .setDesc('Regex or keyword to filter out external events (e.g. "Canceled").')
            .addText(text => text
                .setPlaceholder('Canceled')
                .setValue(this.plugin.settings.externalCalendarFilter)
                .onChange((value) => {
                    this.plugin.settings.externalCalendarFilter = value;
                    void debouncedSave();
                }));

        new Setting(calSection)
            .setName('Canceled Status Value')
            .setDesc('The status value to set when an event is canceled.')
            .addText(text => text
                .setPlaceholder('cancelled')
                .setValue(this.plugin.settings.canceledStatusValue)
                .onChange((value) => {
                    this.plugin.settings.canceledStatusValue = value;
                    void debouncedSave();
                }));

        const fmContent = createCollapsibleSection(
            calSection,
            'Frontmatter Keys',
            'Controller-owned calendar sync fields. Shared identity is managed by TPS Global Context Menu as tpsId and externalId.',
            false
        );

        const fmKeys: { key: keyof typeof this.plugin.settings; label: string; placeholder: string }[] = [
            { key: 'titleKey', label: 'Title Key', placeholder: 'title' },
            { key: 'statusKey', label: 'Status Key', placeholder: 'status' },
            { key: 'previousStatusKey', label: 'Previous Status Key', placeholder: 'tpsCalendarPrevStatus' },
            { key: 'startProperty', label: 'Start Property', placeholder: 'scheduled' },
            { key: 'endProperty', label: 'Duration Property', placeholder: 'timeEstimate' },
        ];

        for (const fk of fmKeys) {
            new Setting(fmContent)
                .setName(fk.label)
                .addText(text => text
                    .setPlaceholder(fk.placeholder)
                    .setValue(String((this.plugin.settings as any)[fk.key] || ''))
                    .onChange(async (value) => {
                        (this.plugin.settings as any)[fk.key] = value;
                        await this.plugin.saveSettings();
                    }));
        }

        // ── Reminder Rules ──────────────────────────────────────────
        const remSection = createCollapsibleSection(
            rulesCategory,
            'Reminder Rules',
            'Polling, ignore lists, and per-rule reminders.',
            false
        );

        const reminderConfigContent = remSection.createDiv({ cls: 'tps-reminder-config-content' });

        new Setting(remSection)
            .setName('Enable Reminders')
            .setDesc('Master toggle for reminder evaluation and notifications.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableReminders ?? true)
                .onChange(async (value) => {
                    this.plugin.settings.enableReminders = value;
                    await this.plugin.saveSettings();
                    this.display();
                }));

        new Setting(remSection)
            .setName('Hourly Time Tracking Reminders')
            .setDesc('When this device is the Controller, send a TPS Notifier reminder on the hour for each active time tracking session.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableTimeTrackingHourlyReminders !== false)
                .onChange(async (value) => {
                    this.plugin.settings.enableTimeTrackingHourlyReminders = value;
                    await this.plugin.saveSettings();
                    this.plugin.restartTimeTrackingReminderLoop();
                }));

        if (!(this.plugin.settings.enableReminders ?? true)) {
            remSection.createEl('p', {
                text: 'Reminders are disabled. Enable the master toggle to show reminder configuration.',
                cls: 'setting-item-description'
            });
        } else {

        new Setting(reminderConfigContent)
            .setName('Check Interval (minutes)')
            .setDesc('How often to evaluate reminder rules.')
            .addSlider(slider => slider
                .setLimits(0.25, 10, 0.25)
                .setValue(this.plugin.settings.pollMinutes)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.pollMinutes = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(reminderConfigContent)
            .setName('Batch Notifications')
            .setDesc('Send one combined notification for multiple triggers.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.batchNotifications)
                .onChange(async (value) => {
                    this.plugin.settings.batchNotifications = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(reminderConfigContent)
            .setName('Notification Sort Direction')
            .setDesc('Controls whether the notification sidebar and reminder modal show oldest due items first or newest due items first.')
            .addDropdown(dropdown => dropdown
                .addOption('asc', 'Oldest first')
                .addOption('desc', 'Newest first')
                .setValue(this.plugin.settings.notificationSortDirection === 'desc' ? 'desc' : 'asc')
                .onChange(async (value: 'asc' | 'desc') => {
                    this.plugin.settings.notificationSortDirection = value === 'desc' ? 'desc' : 'asc';
                    await this.plugin.saveSettings();
                    this.plugin.refreshNotificationViews();
                }));

        new Setting(reminderConfigContent)
            .setName('Default All-Day Base Time')
            .setDesc('Time of day (HH:MM) used as the trigger base for all-day events when a reminder has no per-rule "All-Day Base Time" set. Without this, all-day events default to midnight and notifications fire at the start of the day.')
            .addText(text => text
                .setPlaceholder('09:00')
                .setValue(this.plugin.settings.defaultAllDayBaseTime || '09:00')
                .onChange(async (value) => {
                    this.plugin.settings.defaultAllDayBaseTime = value.trim();
                    await this.plugin.saveSettings();
                }));

        let rulesContainer: HTMLElement | null = null;
        const presetSection = createCollapsibleSection(
            reminderConfigContent,
            'Recommended Reminder Setup',
            'Adds the three common rules: timed scheduled notes/tasks, unmatched external calendar events, and all-day scheduled notes/events.',
            true
        );
        const presetSummary = presetSection.createDiv({ cls: 'tps-reminder-preset-summary' });
        this.renderRecommendedReminderSummary(presetSummary);
        new Setting(presetSection)
            .setName('Install recommended rules')
            .setDesc('Adds any missing standard rules without deleting your custom rules.')
            .addButton(btn => btn
                .setButtonText('Add Missing Rules')
                .setCta()
                .onClick(async () => {
                    const added = this.addMissingRecommendedReminderRules();
                    await this.plugin.saveSettings();
                    this.renderRecommendedReminderSummary(presetSummary);
                    if (rulesContainer) this.renderReminderRules(rulesContainer);
                    new Notice(added > 0 ? `Added ${added} reminder rule${added === 1 ? '' : 's'}.` : 'Recommended reminder rules are already present.');
                }));
        new Setting(presetSection)
            .setName('Reset to recommended rules')
            .setDesc('Replaces the current reminder rule list with the standard three-rule setup.')
            .addButton(btn => btn
                .setButtonText('Replace Rules')
                .setWarning()
                .onClick(async () => {
                    this.plugin.settings.reminders = this.getRecommendedReminderRules();
                    await this.plugin.saveSettings();
                    this.renderRecommendedReminderSummary(presetSummary);
                    if (rulesContainer) this.renderReminderRules(rulesContainer);
                    new Notice('Reminder rules reset to the recommended setup.');
                }));

        const ignoreContent = createCollapsibleSection(
            reminderConfigContent,
            'Global Ignore Lists',
            'Shared filters applied before individual reminder rules.',
            false
        );

        new Setting(ignoreContent)
            .setName('Ignore Paths')
            .setDesc('Comma-separated ignore paths. Supports glob wildcards (*/Templates/*) and regex (re:^System/).')
            .addText(text => text
                .setPlaceholder('System, Notes')
                .setValue((this.plugin.settings.globalIgnorePaths || []).join(', '))
                .onChange(async (value) => {
                    this.plugin.settings.globalIgnorePaths = value.split(',').map(s => s.trim()).filter(Boolean);
                    await this.plugin.saveSettings();
                }));

        new Setting(ignoreContent)
            .setName('Ignore Tags')
            .setDesc('Comma-separated tags to ignore.')
            .addText(text => text
                .setPlaceholder('archive, template')
                .setValue((this.plugin.settings.globalIgnoreTags || []).join(', '))
                .onChange(async (value) => {
                    this.plugin.settings.globalIgnoreTags = value.split(',').map(s => s.trim()).filter(Boolean);
                    await this.plugin.saveSettings();
                }));

        new Setting(ignoreContent)
            .setName('Ignore Statuses')
            .setDesc('Comma-separated status values to ignore.')
            .addText(text => text
                .setPlaceholder('complete, wont-do')
                .setValue((this.plugin.settings.globalIgnoreStatuses || []).join(', '))
                .onChange(async (value) => {
                    this.plugin.settings.globalIgnoreStatuses = value.split(',').map(s => s.trim()).filter(Boolean);
                    await this.plugin.saveSettings();
                }));

        // Individual reminder rules
        rulesContainer = reminderConfigContent.createDiv({ cls: 'tps-controller-reminder-rules' });
        this.renderReminderRules(rulesContainer);

        new Setting(reminderConfigContent)
            .addButton(btn => btn
                .setButtonText('Add Reminder Rule')
                .setCta()
                .onClick(async () => {
                    this.plugin.settings.reminders.push(this.createDefaultReminder());
                    await this.plugin.saveSettings();
                    this.renderReminderRules(rulesContainer);
                }));

        new Setting(reminderConfigContent)
            .setName('Run Reminder Check')
            .setDesc('Evaluate all reminder rules now.')
            .addButton(btn => btn
                .setButtonText('Check Now')
                .onClick(async () => {
                    btn.setButtonText('Checking…');
                    btn.setDisabled(true);
                    try {
                        await (this.plugin as any).runReminderCheck();
                        new Notice('Reminder check complete.');
                    } catch (e) {
                        new Notice('Reminder check failed.');
                    }
                    btn.setButtonText('Check Now');
                    btn.setDisabled(false);
                }));
        }

        // ── Snooze ─────────────────────────────────────────────────
        const snoozeSection = createCollapsibleSection(
            rulesCategory,
            'Snooze',
            'Reminder snooze field configuration and presets.',
            false
        );

        new Setting(snoozeSection)
            .setName('Snooze Property')
            .setDesc('Frontmatter property name for snooze time (e.g., reminderSnooze)')
            .addText(text => text
                .setPlaceholder('reminderSnooze')
                .setValue(this.plugin.settings.snoozeProperty || 'reminderSnooze')
                .onChange((value) => {
                    this.plugin.settings.snoozeProperty = value.trim() || 'reminderSnooze';
                    void debouncedSave();
                }));

        const snoozePresetsEl = createCollapsibleSection(
            snoozeSection,
            'Snooze Presets',
            'Quick snooze durations shown in the reminder UI.',
            false
        );
        this.renderSnoozeOptions(snoozePresetsEl);
        new Setting(snoozePresetsEl)
            .addButton((btn) =>
                btn.setButtonText('Add Preset').setCta().onClick(async () => {
                    if (!Array.isArray(this.plugin.settings.snoozeOptions)) this.plugin.settings.snoozeOptions = [];
                    this.plugin.settings.snoozeOptions.push({ label: '15 Minutes', minutes: 15 });
                    await this.plugin.saveSettings();
                    this.renderSnoozeOptions(snoozePresetsEl);
                })
            );

        // ── Debug ───────────────────────────────────────────────────
        const debugSection = createCollapsibleSection(
            interactionCategory,
            'Debug',
            'Low-frequency troubleshooting controls.',
            false
        );

        new Setting(debugSection)
            .setName('Enable Logging')
            .setDesc('Print detailed logs to console.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableLogging)
                .onChange(async (value) => {
                    this.plugin.settings.enableLogging = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(debugSection)
            .setName('Reset Alert State')
            .setDesc('Clear all stored alert tracking (will re-trigger all reminders).')
            .addButton(btn => btn
                .setButtonText('Reset')
                .setWarning()
                .onClick(async () => {
                    this.plugin.settings.alertState = {};
                    await this.plugin.saveSettings();
                    new Notice('Alert state cleared.');
                }));

        this.restoreSettingsViewState(containerEl);
    }

    // ========================================================================
    // Helpers
    // ========================================================================
    private captureSettingsViewState(containerEl: HTMLElement): void {
        this.settingsScrollTop = containerEl.scrollTop;
        this.settingsViewState.clear();
        const detailsEls = Array.from(containerEl.querySelectorAll('details'));
        detailsEls.forEach((detailsEl, index) => {
            const details = detailsEl as HTMLDetailsElement;
            const summaryText = details.querySelector('summary')?.textContent?.trim() || '';
            const key = `${index}:${summaryText}`;
            this.settingsViewState.set(key, details.open);
        });
    }

    private restoreSettingsViewState(containerEl: HTMLElement): void {
        const detailsEls = Array.from(containerEl.querySelectorAll('details'));
        if (!this.hasRenderedSettings) {
            detailsEls.forEach((detailsEl) => {
                const details = detailsEl as HTMLDetailsElement;
                if (details.classList.contains('tps-settings-main-category')) {
                    details.setAttr('open', 'true');
                } else {
                    details.removeAttribute('open');
                }
            });
            this.hasRenderedSettings = true;
            containerEl.scrollTop = 0;
            return;
        }
        detailsEls.forEach((detailsEl, index) => {
            const details = detailsEl as HTMLDetailsElement;
            const summaryText = details.querySelector('summary')?.textContent?.trim() || '';
            const key = `${index}:${summaryText}`;
            const isOpen = this.settingsViewState.get(key);
            if (isOpen) details.setAttr('open', 'true');
            else details.removeAttribute('open');
        });
        containerEl.scrollTop = this.settingsScrollTop;
    }


    private createDefaultReminder(): PropertyReminder {
        return {
            id: `reminder-${Date.now()}`,
            label: 'New Reminder',
            property: 'scheduled',
            enabled: true,
            offsetMinutes: -15,
            repeatUntilComplete: false,
            repeatIntervalMinutes: 5,
            maxRepeats: -1,
            stopConditions: ['status: complete', 'status: wont-do'],
            title: 'Reminder: {filename}',
            body: 'At {time} ({remaining})',
            ignorePaths: [],
            ignoreTags: [],
            ignoreStatuses: [],
            allDayFilter: 'any',
            includeUnmatchedExternalEvents: false,
            sourceTypes: ['file'],
        };
    }

    private getRecommendedReminderRules(): PropertyReminder[] {
        const stopConditions = ['status: complete', 'status: wont-do'];
        const base: Omit<PropertyReminder, 'id' | 'label' | 'allDayFilter' | 'includeUnmatchedExternalEvents'> = {
            property: 'scheduled',
            enabled: true,
            offsetMinutes: -15,
            mode: 'task' as const,
            repeatUntilComplete: false,
            repeatIntervalMinutes: 5,
            maxRepeats: -1,
            stopConditions,
            ignorePaths: [],
            ignoreTags: [],
            ignoreStatuses: [],
            requiredStatuses: [],
            requiredPaths: [],
            title: 'Reminder: {filename}',
            body: 'At {time} ({remaining})',
            triggerAtEnd: false,
            sourceTypes: ['file', 'external-event'],
        };

        return [
            {
                ...base,
                id: 'reminder-standard-timed-scheduled',
                label: 'Timed scheduled things',
                allDayFilter: 'false',
                includeUnmatchedExternalEvents: true,
            },
            {
                ...base,
                id: 'reminder-standard-all-day',
                label: 'All-day scheduled notes and events',
                offsetMinutes: 0,
                sourceTypes: ['file', 'external-event'],
                allDayFilter: 'true',
                includeUnmatchedExternalEvents: true,
                title: 'Today: {filename}',
                body: 'All-day reminder at {time}',
            },
        ];
    }

    private addMissingRecommendedReminderRules(): number {
        const existingIds = new Set((this.plugin.settings.reminders || []).map((rule) => rule.id));
        const recommended = this.getRecommendedReminderRules();
        const missing = recommended.filter((rule) => !existingIds.has(rule.id));
        if (!this.plugin.settings.reminders) this.plugin.settings.reminders = [];
        this.plugin.settings.reminders.push(...missing.map((rule) => JSON.parse(JSON.stringify(rule))));
        return missing.length;
    }

    private renderRecommendedReminderSummary(container: HTMLElement): void {
        container.empty();
        const existingIds = new Set((this.plugin.settings.reminders || []).map((rule) => rule.id));
        const rows = this.getRecommendedReminderRules();
        for (const rule of rows) {
            const row = container.createDiv({ cls: 'tps-reminder-preset-row' });
            const present = existingIds.has(rule.id);
            row.createSpan({ cls: present ? 'tps-reminder-preset-present' : 'tps-reminder-preset-missing', text: present ? 'Configured' : 'Missing' });
            row.createSpan({ cls: 'tps-reminder-preset-label', text: rule.label || rule.id });
            row.createSpan({ cls: 'tps-reminder-preset-desc', text: this.buildRuleDesc(rule) });
        }
    }

    private getReminderSourceTypes(rem: PropertyReminder): Set<'file' | 'external-event'> {
        const configured = Array.isArray(rem.sourceTypes) ? rem.sourceTypes.filter(Boolean) : [];
        if (configured.length > 0) return new Set(configured as ('file' | 'external-event')[]);
        return new Set([
            'file',
            ...(rem.includeUnmatchedExternalEvents ? ['external-event' as const] : []),
        ]);
    }

    private renderSourceTypeControls(
        container: HTMLElement,
        rem: PropertyReminder,
        onChange: () => Promise<void>,
    ): void {
        const sources = [
            { value: 'file' as const, label: 'Whole notes', desc: 'Notes with frontmatter scheduled dates.' },
            { value: 'external-event' as const, label: 'External events', desc: 'Calendar events that do not have a local note yet.' },
        ];
        const selected = this.getReminderSourceTypes(rem);
        const grid = container.createDiv({ cls: 'tps-reminder-source-grid' });

        const persist = async () => {
            rem.sourceTypes = sources
                .map((source) => source.value)
                .filter((source) => selected.has(source));
            rem.includeUnmatchedExternalEvents = selected.has('external-event');
            await onChange();
        };

        for (const source of sources) {
            const label = grid.createEl('label', { cls: 'tps-reminder-source-option' });
            const checkbox = label.createEl('input', { type: 'checkbox' });
            checkbox.checked = selected.has(source.value);
            const text = label.createSpan({ cls: 'tps-reminder-source-text' });
            text.createSpan({ cls: 'tps-reminder-source-label', text: source.label });
            text.createSpan({ cls: 'tps-reminder-source-desc', text: source.desc });
            checkbox.addEventListener('change', async () => {
                if (checkbox.checked) selected.add(source.value);
                else selected.delete(source.value);
                if (selected.size === 0) {
                    selected.add(source.value);
                    checkbox.checked = true;
                    new Notice('A reminder needs at least one source.');
                    return;
                }
                await persist();
            });
        }
    }

    private renderReminderRules(container: HTMLElement): void {
        const existingRuleDetails = Array.from(
            container.querySelectorAll('details.tps-controller-reminder-rule')
        ) as HTMLDetailsElement[];
        existingRuleDetails.forEach((detailsEl) => {
            const ruleId = detailsEl.dataset.ruleId;
            if (ruleId) {
                this.reminderRuleViewState.set(ruleId, detailsEl.open);
            }
        });

        container.empty();
        const reminders = this.plugin.settings.reminders || [];

        if (reminders.length === 0) {
            const empty = container.createDiv({ cls: 'tps-empty-state' });
            empty.textContent = 'No reminder rules configured.';
            return;
        }

        const reminderToolbar = container.createDiv({ cls: 'tps-reminder-rules-toolbar' });
        const filterInput = reminderToolbar.createEl('input', {
            cls: 'tps-reminder-rules-filter',
            type: 'text',
            placeholder: 'Filter rules by label, property, folder, or status'
        });
        filterInput.value = this.reminderRuleFilterQuery;
        filterInput.addEventListener('input', () => {
            this.reminderRuleFilterQuery = filterInput.value;
            this.renderReminderRules(container);
        });

        const toolbarActions = reminderToolbar.createDiv({ cls: 'tps-reminder-rules-toolbar-actions' });
        const expandAllBtn = toolbarActions.createEl('button', { text: 'Expand All' });
        expandAllBtn.addEventListener('click', () => {
            reminders.forEach((rem, index) => {
                const ruleId = rem.id || `rule-${index}`;
                this.reminderRuleViewState.set(ruleId, true);
            });
            this.renderReminderRules(container);
        });

        const collapseAllBtn = toolbarActions.createEl('button', { text: 'Collapse All' });
        collapseAllBtn.addEventListener('click', () => {
            reminders.forEach((rem, index) => {
                const ruleId = rem.id || `rule-${index}`;
                this.reminderRuleViewState.set(ruleId, false);
            });
            this.renderReminderRules(container);
        });

        const normalizedQuery = this.reminderRuleFilterQuery.trim().toLowerCase();
        const visibleRules = reminders
            .map((rem, index) => ({ rem, index }))
            .filter(({ rem, index }) => {
                if (!normalizedQuery) return true;
                const searchBlob = [
                    rem.label,
                    rem.property,
                    (rem.requiredStatuses || []).join(' '),
                    (rem.requiredPaths || []).join(' '),
                    (rem.ignoreStatuses || []).join(' '),
                    (rem.ignoreTags || []).join(' '),
                    (rem.stopConditions || []).join(' '),
                    `rule ${index + 1}`
                ]
                    .join(' ')
                    .toLowerCase();
                return searchBlob.includes(normalizedQuery);
            });

        if (visibleRules.length === 0) {
            const emptyFiltered = container.createDiv({ cls: 'tps-empty-state' });
            emptyFiltered.textContent = 'No reminder rules match the current filter.';
            return;
        }

        visibleRules.forEach(({ rem, index }) => {
            const ruleId = rem.id || `rule-${index}`;
            const ruleEl = container.createEl('details', { cls: 'tps-controller-reminder-rule' });
            ruleEl.dataset.ruleId = ruleId;

            if (this.reminderRuleViewState.get(ruleId)) {
                ruleEl.setAttr('open', 'true');
            }
            ruleEl.addEventListener('toggle', () => {
                this.reminderRuleViewState.set(ruleId, ruleEl.open);
            });

            const ruleHeader = ruleEl.createEl('summary', { cls: 'tps-rule-summary-row' });
            const ruleSummaryMain = ruleHeader.createDiv({ cls: 'tps-rule-summary-main' });
            const labelSpan = ruleSummaryMain.createSpan({ cls: 'tps-rule-label' });
            labelSpan.textContent = `${rem.enabled ? '🟢' : '⚫'} ${rem.label || `Rule ${index + 1}`}`;
            const descSpan = ruleSummaryMain.createSpan({ cls: 'tps-rule-desc' });
            descSpan.textContent = this.buildRuleDesc(rem);

            const summaryActions = ruleHeader.createDiv({ cls: 'tps-rule-summary-actions' });
            const createHeaderAction = (label: string, tooltip: string, action: () => Promise<void>) => {
                const btn = summaryActions.createEl('button', { cls: 'tps-rule-summary-btn', text: label });
                btn.setAttr('aria-label', tooltip);
                btn.setAttr('title', tooltip);
                btn.addEventListener('click', async (evt) => {
                    evt.preventDefault();
                    evt.stopPropagation();
                    await action();
                });
            };

            createHeaderAction('↑', 'Move rule up', async () => {
                if (index === 0) return;
                [this.plugin.settings.reminders[index - 1], this.plugin.settings.reminders[index]] = [this.plugin.settings.reminders[index], this.plugin.settings.reminders[index - 1]];
                await this.plugin.saveSettings();
                this.renderReminderRules(container);
            });

            createHeaderAction('↓', 'Move rule down', async () => {
                if (index >= this.plugin.settings.reminders.length - 1) return;
                [this.plugin.settings.reminders[index + 1], this.plugin.settings.reminders[index]] = [this.plugin.settings.reminders[index], this.plugin.settings.reminders[index + 1]];
                await this.plugin.saveSettings();
                this.renderReminderRules(container);
            });

            createHeaderAction('⧉', 'Duplicate rule', async () => {
                const duplicated: PropertyReminder = {
                    ...rem,
                    id: `reminder-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
                    label: rem.label ? `${rem.label} Copy` : `Rule ${index + 1} Copy`,
                    stopConditions: [...(rem.stopConditions || [])],
                    ignorePaths: [...(rem.ignorePaths || [])],
                    ignoreTags: [...(rem.ignoreTags || [])],
                    ignoreStatuses: [...(rem.ignoreStatuses || [])],
                    requiredStatuses: [...(rem.requiredStatuses || [])],
                    requiredPaths: [...(rem.requiredPaths || [])],
                    sourceTypes: [...(rem.sourceTypes || [])],
                };
                this.plugin.settings.reminders.splice(index + 1, 0, duplicated);
                this.reminderRuleViewState.set(duplicated.id, true);
                await this.plugin.saveSettings();
                this.renderReminderRules(container);
            });

            createHeaderAction('×', 'Delete rule', async () => {
                this.plugin.settings.reminders.splice(index, 1);
                this.reminderRuleViewState.delete(ruleId);
                await this.plugin.saveSettings();
                this.renderReminderRules(container);
            });

            const ruleContent = ruleEl.createDiv({ cls: 'tps-rule-content' });
            const createRuleGroup = (title: string, defaultOpen = false): HTMLElement => {
                const group = ruleContent.createEl('details', { cls: 'tps-rule-group' });
                if (defaultOpen) group.setAttr('open', 'true');
                group.createEl('summary', { text: title });
                return group.createDiv({ cls: 'tps-rule-group-content' });
            };

            // ── Rule ─────────────────────────────────────────────────────────
            const generalGroup = createRuleGroup('Rule');

            new Setting(generalGroup)
                .setName('Label')
                .addText(text => text
                    .setValue(rem.label || '')
                    .onChange(async (value) => {
                        rem.label = value;
                        await this.plugin.saveSettings();
                        labelSpan.textContent = `${rem.enabled ? '🟢' : '⚫'} ${value || `Rule ${index + 1}`}`;
                        descSpan.textContent = this.buildRuleDesc(rem);
                    }));

            new Setting(generalGroup)
                .setName('Enabled')
                .addToggle(toggle => toggle
                    .setValue(rem.enabled)
                    .onChange(async (value) => {
                        rem.enabled = value;
                        await this.plugin.saveSettings();
                        labelSpan.textContent = `${value ? '🟢' : '⚫'} ${rem.label || `Rule ${index + 1}`}`;
                    }));

            // ── When & How ───────────────────────────────────────────────────
            const triggerGroup = createRuleGroup('When & How', true);

            new Setting(triggerGroup)
                .setName('Property')
                .setDesc('Frontmatter date/time property to trigger on.')
                .addText(text => text
                    .setValue(rem.property)
                    .onChange(async (value) => {
                        rem.property = value;
                        await this.plugin.saveSettings();
                        descSpan.textContent = this.buildRuleDesc(rem);
                    }));

            let offsetMagnitude = Math.abs(rem.offsetMinutes || 0);
            let offsetRelation: 'before' | 'at' | 'after' =
                rem.offsetMinutes < 0 ? 'before' : rem.offsetMinutes > 0 ? 'after' : 'at';
            const applyOffset = async () => {
                rem.offsetMinutes = offsetRelation === 'at'
                    ? 0
                    : offsetRelation === 'before'
                        ? -Math.abs(offsetMagnitude)
                        : Math.abs(offsetMagnitude);
                await this.plugin.saveSettings();
                descSpan.textContent = this.buildRuleDesc(rem);
            };
            new Setting(triggerGroup)
                .setName('Fire')
                .setDesc('When the reminder starts relative to the scheduled time.')
                .addText(text => text
                    .setPlaceholder('5')
                    .setValue(String(offsetMagnitude))
                    .onChange(async (value) => {
                        const num = parseInt(value, 10);
                        if (!isNaN(num) && num >= 0) {
                            offsetMagnitude = num;
                            await applyOffset();
                        }
                    }))
                .addDropdown(drop => drop
                    .addOption('before', 'minutes before')
                    .addOption('at', 'at scheduled time')
                    .addOption('after', 'minutes after')
                    .setValue(offsetRelation)
                    .onChange(async (value) => {
                        offsetRelation = value as 'before' | 'at' | 'after';
                        await applyOffset();
                    }));

            new Setting(triggerGroup)
                .setName('Repeat')
                .setDesc('Optional follow-up notifications after the first trigger.')
                .addDropdown(drop => drop
                    .addOption('off', 'Do not repeat')
                    .addOption('trigger-base', 'Repeat until scheduled time')
                    .addOption('stop-condition', 'Repeat until stopped or complete')
                    .setValue(!rem.repeatUntilComplete ? 'off' : (rem.repeatEndAt || 'stop-condition'))
                    .onChange(async (value) => {
                        rem.repeatUntilComplete = value !== 'off';
                        rem.repeatEndAt = value === 'off' ? undefined : value as 'trigger-base' | 'stop-condition';
                        repeatWrapper.style.display = value === 'off' ? 'none' : '';
                        await this.plugin.saveSettings();
                        descSpan.textContent = this.buildRuleDesc(rem);
                    }));

            // Repeat interval/maxRepeats — shown/hidden without full re-render
            const repeatWrapper = triggerGroup.createDiv();
            repeatWrapper.style.display = rem.repeatUntilComplete ? '' : 'none';

            new Setting(repeatWrapper)
                .setName('Every (minutes)')
                .setDesc('How often to repeat while the repeat condition is still active.')
                .addText(text => text
                    .setValue(String(rem.repeatIntervalMinutes))
                    .onChange(async (value) => {
                        const num = parseInt(value, 10);
                        if (!isNaN(num) && num > 0) {
                            rem.repeatIntervalMinutes = num;
                            await this.plugin.saveSettings();
                            descSpan.textContent = this.buildRuleDesc(rem);
                        }
                    }));

            new Setting(repeatWrapper)
                .setName('Max Repeats')
                .setDesc('Maximum number of repeat notifications. -1 = unlimited.')
                .addText(text => text
                    .setValue(String(rem.maxRepeats ?? -1))
                    .onChange(async (value) => {
                        const num = parseInt(value, 10);
                        if (!isNaN(num) && (num === -1 || num > 0)) {
                            rem.maxRepeats = num;
                            await this.plugin.saveSettings();
                        }
                    }));

            new Setting(triggerGroup)
                .setName('Stop Repeating When')
                .setDesc('Stop repeating when any condition matches. Format: "property: value" (e.g. status: complete). Comma-separated.')
                .addText(text => text
                    .setValue((rem.stopConditions || []).join(', '))
                    .onChange(async (value) => {
                        rem.stopConditions = value.split(',').map(s => s.trim()).filter(Boolean);
                        await this.plugin.saveSettings();
                    }));

            new Setting(triggerGroup)
                .setName('Mode')
                .setDesc('Task reminders can repeat. Timeblock reminders skip firing once the event end time has passed.')
                .addDropdown(drop => drop
                    .addOption('task', 'Task/reminder')
                    .addOption('timeblock', 'Timeblock/event')
                    .setValue(rem.mode || 'task')
                    .onChange(async (value) => {
                        rem.mode = value as 'task' | 'timeblock';
                        await this.plugin.saveSettings();
                        descSpan.textContent = this.buildRuleDesc(rem);
                    }));

            new Setting(triggerGroup)
                .setName('Use End Time')
                .setDesc('Use the event end time (start + duration) as the trigger base instead of the start time.')
                .addToggle(toggle => toggle
                    .setValue(!!rem.triggerAtEnd)
                    .onChange(async (value) => {
                        rem.triggerAtEnd = value;
                        await this.plugin.saveSettings();
                        descSpan.textContent = this.buildRuleDesc(rem);
                    }));

            // Duration offset — shown/hidden without full re-render
            const durationOffsetWrapper = triggerGroup.createDiv();
            durationOffsetWrapper.style.display = rem.useSmartOffset ? '' : 'none';

            new Setting(triggerGroup)
                .setName('Use Duration Offset')
                .setDesc('Replace the fixed offset with a duration read from a frontmatter property (e.g. timeEstimate: "30m"). Falls back to Fixed Offset if the property is missing.')
                .addToggle(toggle => toggle
                    .setValue(!!rem.useSmartOffset)
                    .onChange(async (value) => {
                        rem.useSmartOffset = value;
                        durationOffsetWrapper.style.display = value ? '' : 'none';
                        await this.plugin.saveSettings();
                        descSpan.textContent = this.buildRuleDesc(rem);
                    }));

            new Setting(durationOffsetWrapper)
                .setName('Duration Property')
                .setDesc('Frontmatter property containing the duration value (e.g. timeEstimate).')
                .addText(text => text
                    .setPlaceholder('timeEstimate')
                    .setValue(rem.smartOffsetProperty || '')
                    .onChange(async (value) => {
                        rem.smartOffsetProperty = value;
                        await this.plugin.saveSettings();
                        descSpan.textContent = this.buildRuleDesc(rem);
                    }));

            new Setting(durationOffsetWrapper)
                .setName('Direction')
                .setDesc('"After" fires duration-time after the trigger base. "Before" fires duration-time before.')
                .addDropdown(drop => drop
                    .addOption('add', 'After (base + duration)')
                    .addOption('subtract', 'Before (base − duration)')
                    .setValue(rem.smartOffsetOperator || 'add')
                    .onChange(async (value) => {
                        rem.smartOffsetOperator = value as any;
                        await this.plugin.saveSettings();
                    }));

            // ── Which Notes & Events ────────────────────────────────────────
            const allDayGroup = createRuleGroup('Which Notes & Events', true);
            const sourceHelp = allDayGroup.createDiv({ cls: 'setting-item-description' });
            sourceHelp.textContent = 'Choose which scheduled things this rule can see. One rule can cover whole notes, checklist lines, and external calendar events.';
            this.renderSourceTypeControls(allDayGroup, rem, async () => {
                await this.plugin.saveSettings();
                descSpan.textContent = this.buildRuleDesc(rem);
            });

            new Setting(allDayGroup)
                .setName('Date type')
                .setDesc('Timed means a scheduled value with a time. All-day means date-only or allDay: true.')
                .addDropdown(drop => drop
                    .addOption('any', 'Timed and all-day')
                    .addOption('true', 'All-day events only')
                    .addOption('false', 'Timed events only')
                    .setValue(rem.allDayFilter || 'any')
                    .onChange(async (value) => {
                        rem.allDayFilter = value as any;
                        await this.plugin.saveSettings();
                    }));

            new Setting(allDayGroup)
                .setName('All-day base time')
                .setDesc('Time of day (HH:MM) used as the trigger base for all-day events. Leave blank to use the global default.')
                .addText(text => text
                    .setPlaceholder('(uses global default)')
                    .setValue(rem.allDayBaseTime || '')
                    .onChange(async (value) => {
                        rem.allDayBaseTime = value.trim();
                        await this.plugin.saveSettings();
                    }));

            // ── Notification ────────────────────────────────────────────────
            const notificationGroup = createRuleGroup('What It Says', true);

            new Setting(notificationGroup)
                .setName('Title')
                .setDesc('Supports {filename}, {time}, {remaining}.')
                .addText(text => text
                    .setValue(rem.title)
                    .onChange(async (value) => {
                        rem.title = value;
                        await this.plugin.saveSettings();
                    }));

            new Setting(notificationGroup)
                .setName('Body')
                .setDesc('Supports {filename}, {time}, {remaining}.')
                .addText(text => text
                    .setValue(rem.body)
                    .onChange(async (value) => {
                        rem.body = value;
                        await this.plugin.saveSettings();
                    }));

            // ── Filtering ────────────────────────────────────────────────────
            const filteringGroup = createRuleGroup('More Filters');

            new Setting(filteringGroup)
                .setName('Required Statuses')
                .setDesc('Only trigger for files with one of these statuses. Comma-separated (e.g. scheduled, in-progress).')
                .addText(text => text
                    .setValue((rem.requiredStatuses || []).join(', '))
                    .onChange(async (value) => {
                        rem.requiredStatuses = value.split(',').map(s => s.trim()).filter(Boolean);
                        await this.plugin.saveSettings();
                        descSpan.textContent = this.buildRuleDesc(rem);
                    }));

            new Setting(filteringGroup)
                .setName('Required Folders')
                .setDesc('Only trigger for files inside these folders. Comma-separated prefixes. Empty = all folders.')
                .addText(text => text
                    .setPlaceholder('Action Items, Markdown/Projects')
                    .setValue((rem.requiredPaths || []).join(', '))
                    .onChange(async (value) => {
                        rem.requiredPaths = value.split(',').map(s => s.trim()).filter(Boolean);
                        await this.plugin.saveSettings();
                    }));

            new Setting(filteringGroup)
                .setName('Ignore Paths')
                .setDesc('Skip matching files. Comma-separated. Supports wildcards (*/Trash/*) and regex (re:^System/).')
                .addText(text => text
                    .setValue((rem.ignorePaths || []).join(', '))
                    .onChange(async (value) => {
                        rem.ignorePaths = value.split(',').map(s => s.trim()).filter(Boolean);
                        await this.plugin.saveSettings();
                    }));

            new Setting(filteringGroup)
                .setName('Ignore Tags')
                .setDesc('Skip files with these tags. Comma-separated.')
                .addText(text => text
                    .setValue((rem.ignoreTags || []).join(', '))
                    .onChange(async (value) => {
                        rem.ignoreTags = value.split(',').map(s => s.trim()).filter(Boolean);
                        await this.plugin.saveSettings();
                    }));

            new Setting(filteringGroup)
                .setName('Ignore Statuses')
                .setDesc('Skip files with these statuses. Comma-separated.')
                .addText(text => text
                    .setValue((rem.ignoreStatuses || []).join(', '))
                    .onChange(async (value) => {
                        rem.ignoreStatuses = value.split(',').map(s => s.trim()).filter(Boolean);
                        await this.plugin.saveSettings();
                    }));

            // ── Actions ──────────────────────────────────────────────────────
            new Setting(ruleContent)
                .addButton(btn => btn
                    .setButtonText('Delete Rule')
                    .setWarning()
                    .onClick(async () => {
                        this.plugin.settings.reminders.splice(index, 1);
                        await this.plugin.saveSettings();
                        this.renderReminderRules(container);
                    }));
        });
    }

    private buildRuleDesc(rem: PropertyReminder): string {
        const parts: string[] = [rem.property];
        if (rem.useSmartOffset && rem.smartOffsetProperty) {
            const dir = rem.smartOffsetOperator === 'subtract' ? '−' : '+';
            parts.push(`${dir}${rem.smartOffsetProperty}`);
        } else {
            parts.push(`${rem.offsetMinutes >= 0 ? '+' : ''}${rem.offsetMinutes}min`);
        }
        if (rem.requiredStatuses?.length) parts.push(rem.requiredStatuses.join('/'));
        if (rem.triggerAtEnd) parts.push('at end');
        if (rem.mode && rem.mode !== 'task') parts.push(rem.mode);
        if (rem.allDayFilter === 'true') parts.push('all-day only');
        if (rem.allDayFilter === 'false') parts.push('timed only');
        const sources = this.getReminderSourceTypes(rem);
        if (sources.has('external-event')) parts.push('external');
        if (rem.repeatUntilComplete) {
            parts.push(rem.repeatEndAt === 'trigger-base'
                ? `repeat ${rem.repeatIntervalMinutes}min until scheduled`
                : `repeat ${rem.repeatIntervalMinutes}min until stopped`);
        }
        return parts.join(' • ');
    }


    private renderExternalCalendars(container: HTMLElement) {
        container.empty();
        const calendars = this.plugin.settings.externalCalendars || [];

        if (!calendars.length) {
            const empty = container.createEl("p", { text: "No external calendars added." });
            empty.style.color = "var(--text-muted)";
            empty.style.marginBottom = "12px";
            return;
        }

        const save = async (rerender = false) => {
            await this.plugin.saveSettings();
            if (rerender) this.renderExternalCalendars(container);
        };

        calendars.forEach((calendar, index) => {
            const card = container.createDiv();
            card.style.border = "1px solid var(--background-modifier-border)";
            card.style.borderRadius = "8px";
            card.style.padding = "12px";
            card.style.marginBottom = "12px";
            card.style.background = "var(--background-primary-alt)";

            const header = card.createDiv();
            header.style.display = "flex";
            header.style.alignItems = "center";
            header.style.gap = "10px";
            header.style.marginBottom = "10px";

            // Title / Toggle
            const toggle = header.createEl("input", { type: "checkbox" });
            toggle.checked = calendar.enabled !== false;
            toggle.addEventListener("change", async () => {
                calendar.enabled = toggle.checked;
                await save();
            });

            const title = header.createEl("strong", {
                text: calendar.url ? `Calendar ${index + 1}` : "New Calendar"
            });
            title.style.flex = "1";

            // Move Up/Down?
            const move = (from: number, to: number) => {
                const temp = calendars[from];
                calendars[from] = calendars[to];
                calendars[to] = temp;
            };

            const upBtn = header.createEl("button", { text: "↑" });
            upBtn.disabled = index === 0;
            upBtn.addEventListener("click", async () => {
                if (index === 0) return;
                move(index, index - 1);
                await save(true);
            });

            const downBtn = header.createEl("button", { text: "↓" });
            downBtn.disabled = index === calendars.length - 1;
            downBtn.addEventListener("click", async () => {
                if (index >= calendars.length - 1) return;
                move(index, index + 1);
                await save(true);
            });

            // Delete
            const delBtn = header.createEl("button", { text: "Delete" });
            delBtn.classList.add("mod-warning");
            delBtn.addEventListener("click", async () => {
                calendars.splice(index, 1);
                await save(true);
            });

            // Fields
            new Setting(card)
                .setName("iCal URL")
                .addText(text => text
                    .setPlaceholder("https://...")
                    .setValue(calendar.url)
                    .onChange(async (val) => {
                        calendar.url = val.trim();
                        await save();
                    }));

            new Setting(card)
                .setName("Color")
                .addColorPicker(picker => picker
                    .setValue(calendar.color || "#3b82f6")
                    .onChange(async (val) => {
                        calendar.color = val;
                        await save();
                    }));

            const acContent = card.createDiv();
            acContent.style.marginTop = "8px";
            acContent.style.border = "1px solid var(--background-modifier-border)";
            acContent.style.padding = "8px";
            acContent.style.borderRadius = "4px";
            acContent.createEl("h5", { text: "Auto-Create Settings" });

            new Setting(acContent)
                .setName("Enable Auto-Create")
                .addToggle(t => t
                    .setValue(calendar.autoCreateEnabled !== false)
                    .onChange(async (val) => {
                        calendar.autoCreateEnabled = val;
                        await save();
                    }));

            new Setting(acContent)
                .setName("Create as")
                .setDesc("Choose whether synced external events become event notes or inline task items.")
                .addDropdown(drop => drop
                    .addOption("note", "Note")
                    .addOption("task", "Task item")
                    .setValue(calendar.autoCreateMode || "note")
                    .onChange(async (val: "note" | "task") => {
                        calendar.autoCreateMode = val;
                        await save(true);
                    }));

            if ((calendar.autoCreateMode || "note") === "task") {
                new Setting(acContent)
                    .setName("Task destination")
                    .setDesc("Daily note creates one inline task on the scheduled day. Single task note appends all synced events into one note.")
                    .addDropdown(drop => drop
                        .addOption("daily-note", "Daily note")
                        .addOption("event-note", "Single task note")
                        .setValue(calendar.autoCreateTaskDestination || "daily-note")
                        .onChange(async (val: "daily-note" | "event-note") => {
                            calendar.autoCreateTaskDestination = val;
                            await save();
                        }));

                new Setting(acContent)
                    .setName("Task target note")
                    .setDesc("Note path for synced task items. Defaults to Calendar.md for Single task note.")
                    .addText(t => {
                        const commit = async () => {
                            const normalized = normalizeTaskTargetNotePath(t.getValue());
                            if ((calendar.autoCreateTaskTargetPath || "") === normalized) return;
                            calendar.autoCreateTaskTargetPath = normalized;
                            t.setValue(normalized);
                            await save();
                        };
                        t.setValue(calendar.autoCreateTaskTargetPath || "")
                            .setPlaceholder("Areas/Calendar.md")
                            .onChange(() => {
                                // Keep typing local. Saving on each keystroke rebuilds this settings
                                // panel and can persist only the first character on mobile/desktop.
                            });
                        t.inputEl.addEventListener("blur", () => {
                            void commit();
                        });
                        t.inputEl.addEventListener("keydown", (event) => {
                            if (event.key !== "Enter") return;
                            event.preventDefault();
                            t.inputEl.blur();
                            void commit();
                        });
                    });
            }

            new Setting(acContent)
                .setName("Type Folder")
                .setDesc("High-level folder categorization (optional).")
                .addText(t => t
                    .setValue(calendar.autoCreateTypeFolder || "")
                    .setPlaceholder("Meetings/External")
                    .onChange(async (val) => {
                        calendar.autoCreateTypeFolder = val;
                        await save();
                    }));

            new Setting(acContent)
                .setName("Folder")
                .setDesc("Where to create notes (e.g. 01 Action Items/Meetings)")
                .addText(t => t
                    .setValue(calendar.autoCreateFolder || "")
                    .setPlaceholder("Folder/Path")
                    .onChange(async (val) => {
                        calendar.autoCreateFolder = val;
                        await save();
                    }));

            new Setting(acContent)
                .setName("Tag")
                .setDesc("Tag to append (e.g. #meeting)")
                .addText(t => t
                    .setValue(calendar.autoCreateTag || "")
                    .setPlaceholder("#tag")
                    .onChange(async (val) => {
                        calendar.autoCreateTag = val;
                        await save();
                    }));

            new Setting(acContent)
                .setName("Template")
                .setDesc("Path to template file")
                .addText(t => t
                    .setValue(calendar.autoCreateTemplate || "")
                    .setPlaceholder("Templates/Meeting.md")
                    .onChange(async (val) => {
                        calendar.autoCreateTemplate = val;
                        await save();
                    }));
        });
    }

    renderSnoozeOptions(container: HTMLElement): void {
        container.empty();
        const options = this.plugin.settings.snoozeOptions || [];
        options.forEach((opt, index) => {
            new Setting(container)
                .setName(`Preset ${index + 1}`)
                .addText(text => text
                    .setPlaceholder('Label')
                    .setValue(opt.label)
                    .onChange(async (value) => {
                        opt.label = value;
                        await this.plugin.saveSettings();
                    }))
                .addText(text => text
                    .setPlaceholder('Minutes')
                    .setValue(String(opt.minutes))
                    .onChange(async (value) => {
                        const num = parseInt(value);
                        if (!isNaN(num) && num > 0) {
                            opt.minutes = num;
                            await this.plugin.saveSettings();
                        }
                    }))
                .addExtraButton(btn =>
                    btn.setIcon('trash').setTooltip('Remove').onClick(async () => {
                        options.splice(index, 1);
                        await this.plugin.saveSettings();
                        this.renderSnoozeOptions(container);
                    }));
        });
    }
}
