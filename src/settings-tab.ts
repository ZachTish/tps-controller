import { App, Notice, PluginSettingTab, SecretComponent, Setting, normalizePath } from 'obsidian';
import type TPSControllerPlugin from './main';
import type { PropertyReminder, ExternalCalendarConfig } from './types';
import { normalizeCalendarUrl } from './utils';
import { renderListWithControls } from './utils/list-renderer';

const createCalendarId = () => `calendar-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
export type ControllerSettingsPage = 'overview' | 'calendar' | 'reminders' | 'automations' | 'advanced';
type ControllerAutomationPage = 'archive' | 'attachments';

const CONTROLLER_SETTINGS_DESTINATIONS: Array<{
    id: ControllerSettingsPage;
    label: string;
    description: string;
}> = [
    { id: 'overview', label: 'Overview', description: 'Device role and quick links.' },
    { id: 'calendar', label: 'Calendar rules', description: 'Feeds, destinations, and sync safety.' },
    { id: 'reminders', label: 'Reminder rules', description: 'Notification timing, matching, and snooze defaults.' },
    { id: 'automations', label: 'Automations', description: 'Archive and attachment workflows.' },
    { id: 'advanced', label: 'Advanced', description: 'Field names and troubleshooting.' },
];

const normalizeTaskTargetNotePath = (value: string): string => {
    const normalized = normalizePath(String(value || "")
        .trim()
        .replace(/^\[\[|\]\]$/g, "")
        .replace(/^\/+/, ""));
    if (!normalized || normalized === "." || normalized === ".md" || normalized.endsWith("/.md")) return "";
    return normalized.toLowerCase().endsWith(".md") ? normalized : `${normalized}.md`;
};
const createSettingsSection = (
    parent: HTMLElement,
    title: string,
    description?: string
): HTMLElement => {
    const section = parent.createDiv({ cls: 'tps-settings-section' });
    section.createEl('h3', { cls: 'tps-settings-section-title', text: title });

    if (description) {
        section.createEl('p', {
            cls: 'tps-settings-section-description',
            text: description
        });
    }

    return section.createDiv({ cls: 'tps-settings-section-content' });
};

// ============================================================================
// Controller Settings Tab
// ============================================================================

export class TPSControllerSettingTab extends PluginSettingTab {
    plugin: TPSControllerPlugin;
    private activePage: ControllerSettingsPage = 'overview';
    private activeAutomation: ControllerAutomationPage = 'archive';
    private selectedCalendarId: string | null = null;
    private reminderRuleViewState = new Map<string, boolean>();
    private reminderRuleFilterQuery = '';

    constructor(app: App, plugin: TPSControllerPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    openPage(destination: ControllerSettingsPage): void {
        this.activePage = destination;
        this.display();
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl('h2', { text: 'TPS Controller Settings' });
        containerEl.createEl('p', {
            text: 'This is the suite-level owner for background automation, calendar sync, reminders, and shared calendar field mappings. Other TPS plugins should stay focused on UI and local interaction.',
            cls: 'setting-item-description'
        });
        this.renderSettingsDestinationHub(containerEl);

        if (this.activePage === 'overview') {
            this.renderPageHeading(
                containerEl,
                'Overview',
                'See what this device owns, then jump directly to the rules or automation you want to change.'
            );
        // ── Device Role ─────────────────────────────────────────────
        const roleSection = containerEl.createDiv({ cls: 'tps-settings-core' });
        new Setting(roleSection).setName('Device role').setHeading();

        const roleDesc = roleSection.createDiv({ cls: 'tps-controller-role-desc' });
        const updateRoleDesc = (role: string) => {
            const isCtrl = role === 'controller';
            roleDesc.innerHTML = `
                <strong>Current Role:</strong>
                <span class="${isCtrl ? 'tps-role-controller' : 'tps-role-user'}">
                    ${isCtrl ? '🟢 Controller (Background Automation)' : '⚪ User (Normal Use)'}
                </span>
                <br><small class="tps-role-hint">
                    ${isCtrl ? 'This device runs automation (calendar sync, reminders, and maintenance) while keeping the normal Obsidian UI available.' : 'This device is in normal user mode — Controller automation stays off, while optional local reminder notices can run when Obsidian is open.'}
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

        const overviewCards = containerEl.createDiv({ cls: 'tps-settings-overview-grid' });
        this.renderOverviewCard(
            overviewCards,
            'Calendar rules',
            `${this.plugin.settings.externalCalendars?.length || 0} configured feed${this.plugin.settings.externalCalendars?.length === 1 ? '' : 's'} · sync every ${this.plugin.settings.syncIntervalMinutes} minutes`,
            'Open calendar rules',
            'calendar'
        );
        this.renderOverviewCard(
            overviewCards,
            'Reminder rules',
            `${this.plugin.settings.enableReminders ? 'Enabled' : 'Disabled'} · ${this.plugin.settings.reminders?.length || 0} rule${this.plugin.settings.reminders?.length === 1 ? '' : 's'}`,
            'Open reminder rules',
            'reminders'
        );
        const enabledAutomationCount = Number(this.plugin.settings.twoStageArchive?.enabled === true)
            + Number(this.plugin.settings.s3agleAttachmentAutomation?.enabled === true);
        this.renderOverviewCard(
            overviewCards,
            'Automations',
            `${enabledAutomationCount} of 2 enabled`,
            'Open automations',
            'automations'
        );
        }

        // ── External Calendars ─────────────────────────────────────
        if (this.activePage === 'calendar') {
        this.renderPageHeading(
            containerEl,
            'Calendar rules',
            'Connect external feeds, choose what each feed creates, and control global sync safety.'
        );
        const extCalSection = createSettingsSection(
            containerEl,
            'External calendar feeds',
            'Add a source, then choose Configure on a feed to edit its destination rule.'
        );

        new Setting(extCalSection)
            .setName('Calendar actions')
            .setDesc('Add an iCal source or run the current rules immediately.')
            .addButton((btn) => {
                btn.buttonEl.dataset.tpsSettingsFocus = 'add-calendar';
                return btn
                    .setIcon('plus')
                    .setButtonText('Add Calendar')
                    .setCta()
                    .onClick(async () => {
                        const calendar: ExternalCalendarConfig = {
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
                        };
                        this.plugin.settings.externalCalendars.push(calendar);
                        this.selectedCalendarId = calendar.id;
                        await this.plugin.saveSettings();
                        this.renderExternalCalendars(calendarsContainer);
                        this.focusCalendarControl(calendarsContainer, calendar.id, 'configure');
                    });
            })
            .addButton(btn => btn
                .setButtonText('Sync Now')
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

        const calendarsContainer = extCalSection.createDiv({ cls: 'tps-calendar-feed-list' });
        this.renderExternalCalendars(calendarsContainer);
        }

        // ── Two-Stage Archive ─────────────────────────────────────
        if (this.activePage === 'automations') {
        this.renderPageHeading(
            containerEl,
            'Automations',
            'Configure background archive and attachment workflows without mixing them into calendar or reminder rules.'
        );
        this.renderAutomationSelector(containerEl);

        if (this.activeAutomation === 'archive') {
        const twoStageArchiveSection = createSettingsSection(
            containerEl,
            'Archive files',
            'Move files from an active archive folder into a deeper cold archive on a schedule.'
        );

        new Setting(twoStageArchiveSection)
            .setName('Enable Two-Stage Archive')
            .setDesc('When this device is Controller, periodically moves files from the source folder into the destination folder.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.twoStageArchive?.enabled === true)
                .onChange(async (value) => {
                    this.plugin.settings.twoStageArchive.enabled = value;
                    await this.plugin.saveSettings();
                    this.plugin.restartTwoStageArchiveLoop();
                }));

        new Setting(twoStageArchiveSection)
            .setName('Source Folder')
            .setDesc('Files under this folder are moved when the archive rule runs.')
            .addText(text => text
                .setPlaceholder('Archive')
                .setValue(this.plugin.settings.twoStageArchive.sourceFolder)
                .onChange(async (value) => {
                    this.plugin.settings.twoStageArchive.sourceFolder = normalizePath(value.trim().replace(/^\/+|\/+$/g, '')) || 'Archive';
                    await this.plugin.saveSettings();
                }));

        new Setting(twoStageArchiveSection)
            .setName('Destination Folder')
            .setDesc('Files are moved here, preserving their relative paths from the source folder.')
            .addText(text => text
                .setPlaceholder('_archive')
                .setValue(this.plugin.settings.twoStageArchive.destinationFolder)
                .onChange(async (value) => {
                    this.plugin.settings.twoStageArchive.destinationFolder = normalizePath(value.trim().replace(/^\/+|\/+$/g, '')) || '_archive';
                    await this.plugin.saveSettings();
                }));

        new Setting(twoStageArchiveSection)
            .setName('Cadence')
            .setDesc('Monthly end runs once on the last day of the month after the configured run time.')
            .addDropdown(drop => {
                drop.selectEl.dataset.tpsSettingsFocus = 'archive-cadence';
                return drop
                    .addOption('monthly-end', 'End of month')
                    .addOption('weekly', 'Weekly')
                    .addOption('daily', 'Daily')
                    .setValue(this.plugin.settings.twoStageArchive.cadence)
                    .onChange(async (value) => {
                        this.plugin.settings.twoStageArchive.cadence = value as any;
                        await this.plugin.saveSettings();
                        this.plugin.restartTwoStageArchiveLoop();
                        this.redisplayPreservingScroll('[data-tps-settings-focus="archive-cadence"]');
                    });
            });

        if (this.plugin.settings.twoStageArchive.cadence === 'weekly') {
        new Setting(twoStageArchiveSection)
            .setName('Weekly Day')
            .setDesc('Used only for weekly cadence.')
            .addDropdown(drop => drop
                .addOption('0', 'Sunday')
                .addOption('1', 'Monday')
                .addOption('2', 'Tuesday')
                .addOption('3', 'Wednesday')
                .addOption('4', 'Thursday')
                .addOption('5', 'Friday')
                .addOption('6', 'Saturday')
                .setValue(String(this.plugin.settings.twoStageArchive.weeklyDay ?? 0))
                .onChange(async (value) => {
                    this.plugin.settings.twoStageArchive.weeklyDay = Number(value);
                    await this.plugin.saveSettings();
                    this.plugin.restartTwoStageArchiveLoop();
                }));
        }

        new Setting(twoStageArchiveSection)
            .setName('Run Time')
            .setDesc('Local time in HH:mm. For your Archive to _archive flow, leave this near the end of the day.')
            .addText(text => text
                .setPlaceholder('23:55')
                .setValue(this.plugin.settings.twoStageArchive.runTime)
                .onChange(async (value) => {
                    this.plugin.settings.twoStageArchive.runTime = value.trim() || '23:55';
                    await this.plugin.saveSettings();
                }));

        new Setting(twoStageArchiveSection)
            .setName('Check Interval (minutes)')
            .setDesc('How often Controller checks whether the archive rule is due.')
            .addSlider(slider => slider
                .setLimits(1, 240, 1)
                .setValue(this.plugin.settings.twoStageArchive.checkIntervalMinutes)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.twoStageArchive.checkIntervalMinutes = value;
                    await this.plugin.saveSettings();
                    this.plugin.restartTwoStageArchiveLoop();
                }));

        new Setting(twoStageArchiveSection)
            .setName('Run Two-Stage Archive Now')
            .setDesc('Runs the folder move immediately on the Controller device.')
            .addButton(btn => btn
                .setButtonText('Run Now')
                .onClick(async () => {
                    if (!this.plugin.deviceRoleManager.isController()) {
                        new Notice('Two-stage archive runs on the Controller device.');
                        return;
                    }
                    btn.setDisabled(true);
                    btn.setButtonText('Running...');
                    try {
                        const result = await this.plugin.runTwoStageArchiveNow();
                        new Notice(`Two-stage archive: moved ${result.movedCount}, skipped ${result.skippedCount}.`);
                    } catch (error) {
                        new Notice(`Two-stage archive failed: ${(error as Error).message}`);
                    }
                    btn.setButtonText('Run Now');
                    btn.setDisabled(false);
                }));
        }

        // ── S3 Attachment Upload Automation ────────────────────────
        if (this.activeAutomation === 'attachments') {
        const s3agleSection = createSettingsSection(
            containerEl,
            'Upload attachments',
            'Upload active-note attachments to S3-compatible storage, rewrite links, and optionally archive replaced source files.'
        );

        new Setting(s3agleSection)
            .setName('Enable S3 Attachment Upload Automation')
            .setDesc('When enabled, this device watches the active note and uploads local attachment links directly to S3-compatible storage.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.s3agleAttachmentAutomation?.enabled === true)
                .onChange(async (value) => {
                    this.plugin.settings.s3agleAttachmentAutomation.enabled = value;
                    await this.plugin.saveSettings();
                    this.plugin.restartS3agleAttachmentAutomation();
                }));

        new Setting(s3agleSection)
            .setName('Run on Note Open')
            .setDesc('Checks the active note shortly after it is opened.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.s3agleAttachmentAutomation.runOnActiveNoteOpen !== false)
                .onChange(async (value) => {
                    this.plugin.settings.s3agleAttachmentAutomation.runOnActiveNoteOpen = value;
                    await this.plugin.saveSettings();
                    this.plugin.restartS3agleAttachmentAutomation();
                }));

        new Setting(s3agleSection)
            .setName('Run on Active Note Changes')
            .setDesc('Checks the active note after it is modified and the debounce delay has passed.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.s3agleAttachmentAutomation.runOnActiveNoteModify !== false)
                .onChange(async (value) => {
                    this.plugin.settings.s3agleAttachmentAutomation.runOnActiveNoteModify = value;
                    await this.plugin.saveSettings();
                    this.plugin.restartS3agleAttachmentAutomation();
                }));

        new Setting(s3agleSection)
            .setName('Run on Paste')
            .setDesc('Checks the active note shortly after a paste event so newly pasted attachments can be uploaded.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.s3agleAttachmentAutomation.runOnPaste !== false)
                .onChange(async (value) => {
                    this.plugin.settings.s3agleAttachmentAutomation.runOnPaste = value;
                    await this.plugin.saveSettings();
                    this.plugin.restartS3agleAttachmentAutomation();
                }));

        new Setting(s3agleSection)
            .setName('Run After Commands')
            .setDesc('Comma-separated command IDs that should trigger this after they run, such as a Linter command or another workflow command.')
            .addTextArea(text => text
                .setPlaceholder('obsidian-linter:lint-file')
                .setValue((this.plugin.settings.s3agleAttachmentAutomation.runAfterCommandIds || []).join(', '))
                .onChange(async (value) => {
                    this.plugin.settings.s3agleAttachmentAutomation.runAfterCommandIds = value
                        .split(',')
                        .map(id => id.trim())
                        .filter(Boolean);
                    await this.plugin.saveSettings();
                    this.plugin.restartS3agleAttachmentAutomation();
                }));

        new Setting(s3agleSection)
            .setName('S3 Endpoint')
            .setDesc('S3-compatible endpoint URL.')
            .addText(text => text
                .setPlaceholder('https://storage.googleapis.com')
                .setValue(this.plugin.settings.s3agleAttachmentAutomation.endpoint || '')
                .onChange(async (value) => {
                    this.plugin.settings.s3agleAttachmentAutomation.endpoint = value.trim();
                    await this.plugin.saveSettings();
                    this.plugin.restartS3agleAttachmentAutomation();
                }));

        new Setting(s3agleSection)
            .setName('S3 Bucket')
            .setDesc('Bucket used for uploaded attachments.')
            .addText(text => text
                .setValue(this.plugin.settings.s3agleAttachmentAutomation.bucket || '')
                .onChange(async (value) => {
                    this.plugin.settings.s3agleAttachmentAutomation.bucket = value.trim();
                    await this.plugin.saveSettings();
                    this.plugin.restartS3agleAttachmentAutomation();
                }));

        new Setting(s3agleSection)
            .setName('S3 Region')
            .setDesc('Region value passed to the S3-compatible client.')
            .addText(text => text
                .setValue(this.plugin.settings.s3agleAttachmentAutomation.region || '')
                .onChange(async (value) => {
                    this.plugin.settings.s3agleAttachmentAutomation.region = value.trim();
                    await this.plugin.saveSettings();
                }));

        new Setting(s3agleSection)
            .setName('S3 Folder')
            .setDesc('Optional object key prefix for uploaded attachments.')
            .addText(text => text
                .setValue(this.plugin.settings.s3agleAttachmentAutomation.folder || '')
                .onChange(async (value) => {
                    this.plugin.settings.s3agleAttachmentAutomation.folder = value.trim();
                    await this.plugin.saveSettings();
                }));

        new Setting(s3agleSection)
            .setName('Use Bucket Subdomain URLs')
            .setDesc('Build links as https://bucket.endpoint/key instead of https://endpoint/bucket/key.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.s3agleAttachmentAutomation.useBucketSubdomain === true)
                .onChange(async (value) => {
                    this.plugin.settings.s3agleAttachmentAutomation.useBucketSubdomain = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(s3agleSection)
            .setName('Content URL')
            .setDesc('Optional public/read endpoint for generated links. Leave blank to use the S3 endpoint.')
            .addText(text => text
                .setValue(this.plugin.settings.s3agleAttachmentAutomation.contentUrl || '')
                .onChange(async (value) => {
                    this.plugin.settings.s3agleAttachmentAutomation.contentUrl = value.trim();
                    await this.plugin.saveSettings();
                }));

        new Setting(s3agleSection)
            .setName('Access Key')
            .setDesc('Select or create a device-local Obsidian secret containing a scoped S3 access key.')
            .addComponent(element => new SecretComponent(this.app, element)
                .setValue(this.plugin.settings.s3agleAttachmentAutomation.accessKeySecretName || '')
                .onChange(async (value) => {
                    this.plugin.settings.s3agleAttachmentAutomation.accessKeySecretName = value.trim();
                    await this.plugin.saveSettings();
                    this.plugin.restartS3agleAttachmentAutomation();
                }));

        new Setting(s3agleSection)
            .setName('Secret Key')
            .setDesc('Select or create a separate device-local Obsidian secret containing the S3 secret key.')
            .addComponent(element => new SecretComponent(this.app, element)
                .setValue(this.plugin.settings.s3agleAttachmentAutomation.secretKeySecretName || '')
                .onChange(async (value) => {
                    this.plugin.settings.s3agleAttachmentAutomation.secretKeySecretName = value.trim();
                    await this.plugin.saveSettings();
                    this.plugin.restartS3agleAttachmentAutomation();
                }));

        new Setting(s3agleSection)
            .setName('Archive Uploaded Source Files')
            .setDesc('After a local attachment link is rewritten to S3, ask the controller device to move the source attachment file into the configured archive folder.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.s3agleAttachmentAutomation.archiveUploadedSources !== false)
                .onChange(async (value) => {
                    this.plugin.settings.s3agleAttachmentAutomation.archiveUploadedSources = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(s3agleSection)
            .setName('Make Uploaded Objects Public')
            .setDesc('Applies a public-read ACL before rewriting notes. Keep this on for Obsidian embeds unless the bucket is public by policy.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.s3agleAttachmentAutomation.makeUploadedObjectsPublic !== false)
                .onChange(async (value) => {
                    this.plugin.settings.s3agleAttachmentAutomation.makeUploadedObjectsPublic = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(s3agleSection)
            .setName('Allowed Attachment Extensions')
            .setDesc('Comma-separated extensions to upload. Leave blank to allow all except ignored extensions.')
            .addText(text => text
                .setPlaceholder('png, jpg, jpeg, gif, webp, svg, heic, heif')
                .setValue((this.plugin.settings.s3agleAttachmentAutomation.allowedAttachmentExtensions || []).join(', '))
                .onChange(async (value) => {
                    this.plugin.settings.s3agleAttachmentAutomation.allowedAttachmentExtensions = value
                        .split(',')
                        .map((item) => item.trim().toLowerCase().replace(/^\./, ''))
                        .filter(Boolean)
                        .sort();
                    await this.plugin.saveSettings();
                    this.plugin.restartS3agleAttachmentAutomation();
                }));

        new Setting(s3agleSection)
            .setName('Ignored Attachment Extensions')
            .setDesc('Comma-separated extensions to never upload. This wins over the allowed list.')
            .addText(text => text
                .setPlaceholder('pdf, mov, mp4')
                .setValue((this.plugin.settings.s3agleAttachmentAutomation.ignoredAttachmentExtensions || []).join(', '))
                .onChange(async (value) => {
                    this.plugin.settings.s3agleAttachmentAutomation.ignoredAttachmentExtensions = value
                        .split(',')
                        .map((item) => item.trim().toLowerCase().replace(/^\./, ''))
                        .filter(Boolean)
                        .sort();
                    await this.plugin.saveSettings();
                    this.plugin.restartS3agleAttachmentAutomation();
                }));

        new Setting(s3agleSection)
            .setName('Archive Unreferenced Bucket Objects')
            .setDesc('On the Controller device, move Controller-uploaded S3 objects into the bucket archive prefix after their generated URL is no longer found in vault notes.')
            .addToggle(toggle => {
                toggle.toggleEl.dataset.tpsSettingsFocus = 'bucket-archive-toggle';
                return toggle
                    .setValue(this.plugin.settings.s3agleAttachmentAutomation.archiveUnreferencedBucketObjects === true)
                    .onChange(async (value) => {
                        this.plugin.settings.s3agleAttachmentAutomation.archiveUnreferencedBucketObjects = value;
                        await this.plugin.saveSettings();
                        this.plugin.restartS3BucketArchiveLoop();
                        this.redisplayPreservingScroll('[data-tps-settings-focus="bucket-archive-toggle"]');
                    });
            });

        if (this.plugin.settings.s3agleAttachmentAutomation.archiveUnreferencedBucketObjects === true) {
        new Setting(s3agleSection)
            .setName('Bucket Archive Prefix')
            .setDesc('Object key prefix for unreferenced bucket objects. Supports {YYYY}, {MM}, and {DD}.')
            .addText(text => text
                .setPlaceholder('_archive/s3/{YYYY}/{MM}/{DD}')
                .setValue(this.plugin.settings.s3agleAttachmentAutomation.bucketArchivePrefix || '')
                .onChange(async (value) => {
                    this.plugin.settings.s3agleAttachmentAutomation.bucketArchivePrefix = value.trim();
                    await this.plugin.saveSettings();
                    this.plugin.restartS3BucketArchiveLoop();
                }));

        new Setting(s3agleSection)
            .setName('Bucket Archive Check Interval (minutes)')
            .setDesc('How often the Controller checks the manifest for uploaded S3 objects whose URLs are no longer referenced.')
            .addSlider(slider => slider
                .setLimits(5, 1440, 5)
                .setValue(this.plugin.settings.s3agleAttachmentAutomation.bucketArchiveCheckIntervalMinutes)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.s3agleAttachmentAutomation.bucketArchiveCheckIntervalMinutes = value;
                    await this.plugin.saveSettings();
                    this.plugin.restartS3BucketArchiveLoop();
                }));

        new Setting(s3agleSection)
            .setName('Bucket Archive Delay (minutes)')
            .setDesc('Minimum time after an uploaded URL was last seen before the Controller moves the object into the bucket archive prefix.')
            .addSlider(slider => slider
                .setLimits(5, 1440, 5)
                .setValue(this.plugin.settings.s3agleAttachmentAutomation.bucketArchiveOrphanDelayMinutes)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.s3agleAttachmentAutomation.bucketArchiveOrphanDelayMinutes = value;
                    await this.plugin.saveSettings();
                }));
        }

        new Setting(s3agleSection)
            .setName('Debounce (seconds)')
            .setDesc('How long to wait after opening or editing a note before uploading attachments.')
            .addSlider(slider => slider
                .setLimits(1, 60, 1)
                .setValue(this.plugin.settings.s3agleAttachmentAutomation.debounceSeconds)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.s3agleAttachmentAutomation.debounceSeconds = value;
                    await this.plugin.saveSettings();
                    this.plugin.restartS3agleAttachmentAutomation();
                }));

        new Setting(s3agleSection)
            .setName('Cooldown (minutes)')
            .setDesc('Minimum time before the same note is processed again.')
            .addSlider(slider => slider
                .setLimits(1, 60, 1)
                .setValue(this.plugin.settings.s3agleAttachmentAutomation.cooldownMinutes)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.s3agleAttachmentAutomation.cooldownMinutes = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(s3agleSection)
            .setName('Run S3 Upload Now')
            .setDesc('Uploads local attachments for the current active note.')
            .addButton(btn => btn
                .setButtonText('Run Now')
                .onClick(async () => {
                    btn.setDisabled(true);
                    btn.setButtonText('Running...');
                    try {
                        await this.plugin.runS3agleAttachmentAutomationNow();
                    } catch (error) {
                        new Notice(`S3 attachment upload failed: ${(error as Error).message}`);
                    }
                    btn.setButtonText('Run Now');
                    btn.setDisabled(false);
                }));

        new Setting(s3agleSection)
            .setName('Run S3 Bucket Archive Now')
            .setDesc('Controller-only: moves unreferenced Controller-uploaded S3 objects into the bucket archive prefix.')
            .addButton(btn => btn
                .setButtonText('Run Now')
                .onClick(async () => {
                    if (!this.plugin.deviceRoleManager.isController()) {
                        new Notice('S3 bucket archive runs on the Controller device.');
                        return;
                    }
                    btn.setDisabled(true);
                    btn.setButtonText('Running...');
                    try {
                        const result = await this.plugin.runS3BucketArchiveNow();
                        const suffix = result.lastError
                            ? ` Last error: ${result.lastError}`
                            : result.lastSkipReason
                                ? ` Last skip: ${result.lastSkipReason}`
                                : "";
                        new Notice(`S3 bucket archive: moved ${result.archivedCount}, skipped ${result.skippedCount}.${suffix}`);
                    } catch (error) {
                        new Notice(`S3 bucket archive failed: ${(error as Error).message}`);
                    }
                    btn.setButtonText('Run Now');
                    btn.setDisabled(false);
                }));
        }
        }

        // ── Calendar Sync Rules ────────────────────────────────────
        if (this.activePage === 'calendar') {
        const calSection = createSettingsSection(
            containerEl,
            'Sync and safety',
            'Global timing, deletion, filtering, and cancellation behavior for every external feed.'
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
                .onChange(async (value) => {
                    this.plugin.settings.archiveFolder = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(calSection)
            .setName('Calendar Filter')
            .setDesc('Regex or keyword to filter out external events (e.g. "Canceled").')
            .addText(text => text
                .setPlaceholder('Canceled')
                .setValue(this.plugin.settings.externalCalendarFilter)
                .onChange(async (value) => {
                    this.plugin.settings.externalCalendarFilter = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(calSection)
            .setName('Canceled Status Value')
            .setDesc('The status value to set when an event is canceled.')
            .addText(text => text
                .setPlaceholder('cancelled')
                .setValue(this.plugin.settings.canceledStatusValue)
                .onChange(async (value) => {
                    this.plugin.settings.canceledStatusValue = value;
                    await this.plugin.saveSettings();
                }));
        }

        if (this.activePage === 'advanced') {
        this.renderPageHeading(
            containerEl,
            'Advanced',
            'Change shared field names or use troubleshooting controls. Normal calendar and reminder rules do not require these options.'
        );
        const fmContent = createSettingsSection(
            containerEl,
            'Calendar field names',
            'Controller-owned calendar sync fields. Shared identity is managed by TPS Global Context Menu as tpsId and externalId.'
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
        }

        if (this.activePage === 'reminders') {
            this.renderReminderSettingsPage(containerEl);
        }

        // ── Debug ───────────────────────────────────────────────────
        if (this.activePage === 'advanced') {
        const debugSection = createSettingsSection(
            containerEl,
            'Troubleshooting',
            'Low-frequency diagnostics and reminder-state recovery controls.'
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
                    await this.plugin.resetReminderDeliveryState();
                    new Notice('Controller and local User alert state cleared.');
                }));
        }
    }

    // ========================================================================
    // Helpers
    // ========================================================================

    private renderSettingsDestinationHub(container: HTMLElement): void {
        const hub = container.createDiv({ cls: 'tps-settings-destination-hub' });
        hub.createEl('h3', { text: 'Choose what to configure', cls: 'tps-settings-destination-heading' });
        const buttons = hub.createDiv({ cls: 'tps-settings-destination-grid' });
        buttons.setAttr('role', 'group');
        buttons.setAttr('aria-label', 'Controller settings pages');

        for (const destination of CONTROLLER_SETTINGS_DESTINATIONS) {
            const button = buttons.createEl('button', { cls: 'tps-settings-destination-button' });
            button.setAttr('type', 'button');
            button.setAttr('aria-pressed', String(this.activePage === destination.id));
            button.createSpan({ cls: 'tps-settings-destination-label', text: destination.label });
            button.createSpan({ cls: 'tps-settings-destination-description', text: destination.description });
            button.addEventListener('click', () => {
                if (this.activePage === destination.id) return;
                this.navigateToPage(destination.id);
            });
        }
    }

    private renderPageHeading(container: HTMLElement, title: string, description: string): void {
        const heading = container.createDiv({ cls: 'tps-settings-page-heading' });
        const titleEl = heading.createEl('h2', { text: title });
        titleEl.setAttr('tabindex', '-1');
        heading.createEl('p', { text: description, cls: 'setting-item-description' });
    }

    private renderOverviewCard(
        container: HTMLElement,
        title: string,
        summary: string,
        buttonLabel: string,
        destination: ControllerSettingsPage
    ): void {
        const card = container.createDiv({ cls: 'tps-settings-overview-card' });
        card.createEl('h3', { text: title });
        card.createEl('p', { text: summary, cls: 'setting-item-description' });
        const button = card.createEl('button', { text: buttonLabel, cls: 'mod-cta' });
        button.setAttr('type', 'button');
        button.addEventListener('click', () => {
            this.navigateToPage(destination);
        });
    }

    private navigateToPage(destination: ControllerSettingsPage): void {
        this.activePage = destination;
        this.display();
        const heading = this.containerEl.querySelector<HTMLElement>('.tps-settings-page-heading h2');
        heading?.focus({ preventScroll: false });
    }

    private redisplayPreservingScroll(focusSelector?: string): void {
        const scrollTop = this.containerEl.scrollTop;
        this.display();
        this.containerEl.scrollTop = scrollTop;
        if (focusSelector) {
            this.containerEl.querySelector<HTMLElement>(focusSelector)?.focus({ preventScroll: true });
        }
    }

    private focusCalendarControl(
        container: HTMLElement,
        calendarId: string,
        action: 'configure' | 'create-mode'
    ): void {
        const card = Array.from(container.querySelectorAll<HTMLElement>('.tps-calendar-feed-card'))
            .find((element) => element.dataset.calendarId === calendarId);
        card?.querySelector<HTMLElement>(`[data-calendar-action="${action}"]`)
            ?.focus({ preventScroll: true });
    }

    private renderAutomationSelector(container: HTMLElement): void {
        const selector = container.createDiv({ cls: 'tps-settings-inline-selector' });
        selector.setAttr('role', 'group');
        selector.setAttr('aria-label', 'Choose an automation to configure');

        const destinations: Array<{ id: ControllerAutomationPage; label: string }> = [
            { id: 'archive', label: 'Archive files' },
            { id: 'attachments', label: 'Upload attachments' },
        ];

        for (const destination of destinations) {
            const button = selector.createEl('button', {
                cls: 'tps-settings-inline-selector-button',
                text: destination.label
            });
            button.setAttr('type', 'button');
            button.setAttr('data-automation', destination.id);
            button.setAttr('aria-pressed', String(this.activeAutomation === destination.id));
            button.addEventListener('click', () => {
                if (this.activeAutomation === destination.id) return;
                const scrollTop = this.containerEl.scrollTop;
                this.activeAutomation = destination.id;
                this.display();
                this.containerEl.scrollTop = scrollTop;
                this.containerEl
                    .querySelector<HTMLElement>(`[data-automation="${destination.id}"]`)
                    ?.focus({ preventScroll: true });
            });
        }
    }

    private renderReminderSettingsPage(container: HTMLElement): void {
        this.renderPageHeading(
            container,
            'Reminder rules',
            'Create and edit notification rules first, then adjust shared defaults, filters, and snooze choices.'
        );

        const rulesSection = createSettingsSection(
            container,
            'Rules',
            'Turn reminder evaluation on, then add or open a rule to control what fires and when.'
        );

        new Setting(rulesSection)
            .setName('Enable Reminders')
            .setDesc('Master toggle for reminder evaluation and notifications.')
            .addToggle(toggle => {
                toggle.toggleEl.dataset.tpsSettingsFocus = 'enable-reminders';
                return toggle
                    .setValue(this.plugin.settings.enableReminders ?? true)
                    .onChange(async (value) => {
                        this.plugin.settings.enableReminders = value;
                        await this.plugin.saveSettings();
                        this.plugin.restartReminderLoop();
                        this.redisplayPreservingScroll('[data-tps-settings-focus="enable-reminders"]');
                    });
            });

        new Setting(rulesSection)
            .setName('Hourly Time Tracking Reminders')
            .setDesc('When this device is the Controller, send a TPS Notifier reminder on the hour for each active time tracking session.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableTimeTrackingHourlyReminders !== false)
                .onChange(async (value) => {
                    this.plugin.settings.enableTimeTrackingHourlyReminders = value;
                    await this.plugin.saveSettings();
                    this.plugin.restartTimeTrackingReminderLoop();
                }));

        let rulesContainer: HTMLElement | null = null;
        let presetSummary: HTMLElement | null = null;
        if (!(this.plugin.settings.enableReminders ?? true)) {
            rulesSection.createEl('p', {
                text: 'Reminder evaluation is off. You can still add, edit, and review rules below before enabling notifications.',
                cls: 'setting-item-description'
            });
        }

        new Setting(rulesSection)
            .setName('Rule actions')
            .setDesc('Create a custom rule, install any missing recommended rules, or evaluate the current set now.')
            .addButton(btn => btn
                .setButtonText('Add Rule')
                .setCta()
                .onClick(async () => {
                    const reminder = this.createDefaultReminder();
                    this.plugin.settings.reminders.push(reminder);
                    this.reminderRuleViewState.set(reminder.id, true);
                    await this.plugin.saveSettings();
                    this.plugin.restartReminderLoop();
                    if (rulesContainer) this.renderReminderRules(rulesContainer);
                }))
            .addButton(btn => btn
                .setButtonText('Install Recommended')
                .onClick(async () => {
                    const added = this.addMissingRecommendedReminderRules();
                    await this.plugin.saveSettings();
                    if (added > 0) this.plugin.restartReminderLoop();
                    if (rulesContainer) this.renderReminderRules(rulesContainer);
                    if (presetSummary) this.renderRecommendedReminderSummary(presetSummary);
                    new Notice(added > 0
                        ? `Added ${added} reminder rule${added === 1 ? '' : 's'}.`
                        : 'Recommended reminder rules are already present.');
                }))
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

        rulesContainer = rulesSection.createDiv({ cls: 'tps-controller-reminder-rules' });
        this.renderReminderRules(rulesContainer);

        const deliverySection = createSettingsSection(
            container,
            'Delivery',
            'Choose where reminders appear. Controller owns reminder rules; TishOS owns Apple notification permission and native actions.'
        );

        new Setting(deliverySection)
            .setName('Local Notices on User Devices')
            .setDesc('Show an Obsidian notice on each active User device. This does not use TPS Messager and cannot notify while Obsidian is closed.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableLocalReminderNoticesOnUserDevices === true)
                .onChange(async (value) => {
                    this.plugin.settings.enableLocalReminderNoticesOnUserDevices = value;
                    await this.plugin.saveSettings();
                    this.plugin.restartReminderLoop();
                }));

        new Setting(deliverySection)
            .setName('Apple Native Notifications')
            .setDesc('Open TishOS at its Native Notifications controls. TishOS schedules from one selected Calendar Base view; enabling both delivery routes can produce two alerts for the same item.')
            .addButton(button => button
                .setButtonText('Open TishOS')
                .onClick(() => {
                    this.plugin.openTishOSNativeNotificationSettings();
                }));

        const defaultsSection = createSettingsSection(
            container,
            'Reminder defaults',
            'Shared evaluation and display behavior used by the rule list.'
        );

        new Setting(defaultsSection)
            .setName('Check Interval (minutes)')
            .setDesc('How often to evaluate reminder rules.')
            .addSlider(slider => slider
                .setLimits(0.25, 10, 0.25)
                .setValue(this.plugin.settings.pollMinutes)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.pollMinutes = value;
                    await this.plugin.saveSettings();
                    this.plugin.restartReminderLoop();
                }));

        new Setting(defaultsSection)
            .setName('Batch Notifications')
            .setDesc('Send one combined notification for multiple triggers.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.batchNotifications)
                .onChange(async (value) => {
                    this.plugin.settings.batchNotifications = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(defaultsSection)
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

        new Setting(defaultsSection)
            .setName('Default All-Day Base Time')
            .setDesc('Time of day (HH:MM) used for all-day reminders when a rule does not specify its own base time.')
            .addText(text => text
                .setPlaceholder('09:00')
                .setValue(this.plugin.settings.defaultAllDayBaseTime || '09:00')
                .onChange(async (value) => {
                    this.plugin.settings.defaultAllDayBaseTime = value.trim();
                    await this.plugin.saveSettings();
                }));

        const ignoreContent = createSettingsSection(
            container,
            'Global reminder filters',
            'Shared ignore filters applied before individual reminder rules.'
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
            .setDesc('Comma-separated frontmatter or semantic task status values to ignore.')
            .addText(text => text
                .setPlaceholder('complete, wont-do')
                .setValue((this.plugin.settings.globalIgnoreStatuses || []).join(', '))
                .onChange(async (value) => {
                    this.plugin.settings.globalIgnoreStatuses = value.split(',').map(s => s.trim()).filter(Boolean);
                    await this.plugin.saveSettings();
                }));

        new Setting(ignoreContent)
            .setName('Ignore Checkbox States')
            .setDesc('Comma-separated raw Markdown checkbox markers to ignore. Use blank/open/todo for unchecked tasks, or markers like x, -, /, ?.')
            .addText(text => text
                .setPlaceholder('x, -')
                .setValue((this.plugin.settings.globalIgnoreCheckboxStates || []).join(', '))
                .onChange(async (value) => {
                    this.plugin.settings.globalIgnoreCheckboxStates = value.split(',').map(s => s.trim()).filter(Boolean);
                    await this.plugin.saveSettings();
                }));

        const snoozeSection = createSettingsSection(
            container,
            'Snooze defaults',
            'Choose the property and quick durations shown in reminder interfaces.'
        );

        new Setting(snoozeSection)
            .setName('Snooze Property')
            .setDesc('Frontmatter property name for snooze time (e.g., reminderSnooze).')
            .addText(text => text
                .setPlaceholder('reminderSnooze')
                .setValue(this.plugin.settings.snoozeProperty || 'reminderSnooze')
                .onChange(async (value) => {
                    this.plugin.settings.snoozeProperty = value.trim() || 'reminderSnooze';
                    await this.plugin.saveSettings();
                }));

        const snoozeOptions = snoozeSection.createDiv({ cls: 'tps-snooze-options' });
        this.renderSnoozeOptions(snoozeOptions);
        new Setting(snoozeSection)
            .setName('Quick Snooze Durations')
            .setDesc('Add another duration to the reminder UI.')
            .addButton(btn => btn
                .setButtonText('Add Preset')
                .onClick(async () => {
                    if (!Array.isArray(this.plugin.settings.snoozeOptions)) this.plugin.settings.snoozeOptions = [];
                    this.plugin.settings.snoozeOptions.push({ label: '15 Minutes', minutes: 15 });
                    await this.plugin.saveSettings();
                    this.renderSnoozeOptions(snoozeOptions);
                }));

        const maintenanceSection = createSettingsSection(
            container,
            'Rule maintenance',
            'Review or replace the recommended baseline. Replacing rules deletes the current custom rule list.'
        );
        const maintenanceSummary = maintenanceSection.createDiv({ cls: 'tps-reminder-preset-summary' });
        presetSummary = maintenanceSummary;
        this.renderRecommendedReminderSummary(maintenanceSummary);
        new Setting(maintenanceSection)
            .setName('Reset to recommended rules')
            .setDesc('Replace every current rule with the standard recommended setup.')
            .addButton(btn => btn
                .setButtonText('Replace Rules')
                .setWarning()
                .onClick(async () => {
                    this.plugin.settings.reminders = this.getRecommendedReminderRules();
                    await this.plugin.saveSettings();
                    this.plugin.restartReminderLoop();
                    this.renderRecommendedReminderSummary(maintenanceSummary);
                    if (rulesContainer) this.renderReminderRules(rulesContainer);
                    new Notice('Reminder rules reset to the recommended setup.');
                }));
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
            ignoreCheckboxStates: [],
            requiredStatuses: [],
            requiredCheckboxStates: [],
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
            ignoreCheckboxStates: [],
            requiredStatuses: [],
            requiredCheckboxStates: [],
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
                    (rem.requiredCheckboxStates || []).join(' '),
                    (rem.requiredPaths || []).join(' '),
                    (rem.ignoreStatuses || []).join(' '),
                    (rem.ignoreCheckboxStates || []).join(' '),
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
                    ignoreCheckboxStates: [...(rem.ignoreCheckboxStates || [])],
                    requiredStatuses: [...(rem.requiredStatuses || [])],
                    requiredCheckboxStates: [...(rem.requiredCheckboxStates || [])],
                    requiredPaths: [...(rem.requiredPaths || [])],
                    sourceTypes: [...(rem.sourceTypes || [])],
                };
                this.plugin.settings.reminders.splice(index + 1, 0, duplicated);
                this.reminderRuleViewState.set(duplicated.id, true);
                await this.plugin.saveSettings();
                this.plugin.restartReminderLoop();
                this.renderReminderRules(container);
            });

            createHeaderAction('×', 'Delete rule', async () => {
                this.plugin.settings.reminders.splice(index, 1);
                this.reminderRuleViewState.delete(ruleId);
                await this.plugin.saveSettings();
                this.plugin.restartReminderLoop();
                this.renderReminderRules(container);
            });

            const ruleContent = ruleEl.createDiv({ cls: 'tps-rule-content' });
            const createRuleGroup = (title: string, _defaultOpen = false): HTMLElement => {
                const group = ruleContent.createDiv({ cls: 'tps-rule-group' });
                group.createEl('h5', { text: title, cls: 'tps-rule-group-heading' });
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
                        this.plugin.restartReminderLoop();
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
                        this.plugin.restartReminderLoop();
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
                            this.plugin.restartReminderLoop();
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
                .setDesc('Only trigger for notes/tasks with one of these semantic status values. Comma-separated (e.g. scheduled, in-progress).')
                .addText(text => text
                    .setValue((rem.requiredStatuses || []).join(', '))
                    .onChange(async (value) => {
                        rem.requiredStatuses = value.split(',').map(s => s.trim()).filter(Boolean);
                        await this.plugin.saveSettings();
                        descSpan.textContent = this.buildRuleDesc(rem);
                    }));

            new Setting(filteringGroup)
                .setName('Required Checkbox States')
                .setDesc('Only trigger for task rows with one of these raw checkbox markers. Use blank/open/todo for unchecked tasks, or markers like x, -, /, ?.')
                .addText(text => text
                    .setPlaceholder('blank, /')
                    .setValue((rem.requiredCheckboxStates || []).join(', '))
                    .onChange(async (value) => {
                        rem.requiredCheckboxStates = value.split(',').map(s => s.trim()).filter(Boolean);
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
                .setDesc('Skip notes/tasks with these semantic status values. Comma-separated.')
                .addText(text => text
                    .setValue((rem.ignoreStatuses || []).join(', '))
                    .onChange(async (value) => {
                        rem.ignoreStatuses = value.split(',').map(s => s.trim()).filter(Boolean);
                        await this.plugin.saveSettings();
                    }));

            new Setting(filteringGroup)
                .setName('Ignore Checkbox States')
                .setDesc('Skip task rows with these raw checkbox markers. Use blank/open/todo for unchecked tasks, or markers like x, -, /, ?.')
                .addText(text => text
                    .setPlaceholder('x, -')
                    .setValue((rem.ignoreCheckboxStates || []).join(', '))
                    .onChange(async (value) => {
                        rem.ignoreCheckboxStates = value.split(',').map(s => s.trim()).filter(Boolean);
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
        if (rem.requiredCheckboxStates?.length) parts.push(`checkbox ${rem.requiredCheckboxStates.join('/')}`);
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

        const save = async (
            rerender = false,
            focus?: { calendarId: string; action: 'configure' | 'create-mode' }
        ) => {
            await this.plugin.saveSettings();
            if (rerender) {
                this.renderExternalCalendars(container);
                if (focus) this.focusCalendarControl(container, focus.calendarId, focus.action);
            }
        };

        calendars.forEach((calendar, index) => {
            const calendarId = String(calendar.id || `calendar-index-${index}`);
            const card = container.createDiv({ cls: 'tps-calendar-feed-card' });
            card.dataset.calendarId = calendarId;
            const header = card.createDiv({ cls: 'tps-calendar-feed-header' });

            // Title / Toggle
            const toggle = header.createEl("input", { type: "checkbox" });
            toggle.setAttr('aria-label', `Enable ${this.buildCalendarDisplayName(calendar, index)}`);
            toggle.checked = calendar.enabled !== false;
            toggle.addEventListener("change", async () => {
                calendar.enabled = toggle.checked;
                summary.textContent = this.buildCalendarOutputSummary(calendar);
                await save();
            });

            const identity = header.createDiv({ cls: 'tps-calendar-feed-identity' });
            const title = identity.createEl("strong", {
                text: this.buildCalendarDisplayName(calendar, index)
            });
            const summary = identity.createSpan({
                cls: 'tps-calendar-feed-summary',
                text: this.buildCalendarOutputSummary(calendar)
            });

            const editorId = `tps-calendar-feed-editor-${String(calendar.id || index).replace(/[^A-Za-z0-9_-]/g, '-')}`;
            const configureBtn = header.createEl("button", {
                text: this.selectedCalendarId === calendar.id ? "Close" : "Configure"
            });
            configureBtn.setAttr('type', 'button');
            configureBtn.dataset.calendarAction = 'configure';
            configureBtn.setAttr('aria-expanded', String(this.selectedCalendarId === calendar.id));
            configureBtn.setAttr('aria-controls', editorId);
            configureBtn.addEventListener("click", () => {
                this.selectedCalendarId = this.selectedCalendarId === calendar.id ? null : calendar.id;
                this.renderExternalCalendars(container);
                this.focusCalendarControl(container, calendarId, 'configure');
            });

            const move = (from: number, to: number) => {
                const temp = calendars[from];
                calendars[from] = calendars[to];
                calendars[to] = temp;
            };

            const upBtn = header.createEl("button", { text: "↑" });
            upBtn.setAttr('aria-label', 'Move calendar up');
            upBtn.setAttr('title', 'Move calendar up');
            upBtn.disabled = index === 0;
            upBtn.addEventListener("click", async () => {
                if (index === 0) return;
                move(index, index - 1);
                await save(true, { calendarId, action: 'configure' });
            });

            const downBtn = header.createEl("button", { text: "↓" });
            downBtn.setAttr('aria-label', 'Move calendar down');
            downBtn.setAttr('title', 'Move calendar down');
            downBtn.disabled = index === calendars.length - 1;
            downBtn.addEventListener("click", async () => {
                if (index >= calendars.length - 1) return;
                move(index, index + 1);
                await save(true, { calendarId, action: 'configure' });
            });

            // Delete
            const delBtn = header.createEl("button", { text: "Delete" });
            delBtn.classList.add("mod-warning");
            delBtn.addEventListener("click", async () => {
                const nextCalendar = calendars[index + 1] || calendars[index - 1];
                const nextCalendarId = nextCalendar ? String(nextCalendar.id || '') : '';
                if (this.selectedCalendarId === calendar.id) this.selectedCalendarId = null;
                calendars.splice(index, 1);
                await save(true);
                if (nextCalendarId) {
                    this.focusCalendarControl(container, nextCalendarId, 'configure');
                } else {
                    this.containerEl
                        .querySelector<HTMLElement>('[data-tps-settings-focus="add-calendar"]')
                        ?.focus({ preventScroll: true });
                }
            });

            if (this.selectedCalendarId !== calendar.id) return;

            const editor = card.createDiv({ cls: 'tps-calendar-feed-editor' });
            editor.id = editorId;

            // Fields
            new Setting(editor)
                .setName("iCal URL")
                .addText(text => text
                    .setPlaceholder("https://...")
                    .setValue(calendar.url)
                    .onChange(async (val) => {
                        calendar.url = val.trim();
                        title.textContent = this.buildCalendarDisplayName(calendar, index);
                        toggle.setAttr('aria-label', `Enable ${this.buildCalendarDisplayName(calendar, index)}`);
                        await save();
                    }));

            new Setting(editor)
                .setName("Color")
                .addColorPicker(picker => picker
                    .setValue(calendar.color || "#3b82f6")
                    .onChange(async (val) => {
                        calendar.color = val;
                        await save();
                    }));

            const acContent = editor.createDiv({ cls: 'tps-calendar-feed-output' });
            acContent.createEl("h4", { text: "Creation rule" });

            new Setting(acContent)
                .setName("Enable Auto-Create")
                .addToggle(t => t
                    .setValue(calendar.autoCreateEnabled !== false)
                    .onChange(async (val) => {
                        calendar.autoCreateEnabled = val;
                        summary.textContent = this.buildCalendarOutputSummary(calendar);
                        await save();
                    }));

            new Setting(acContent)
                .setName("Create as")
                .setDesc("Choose whether synced external events become event notes or inline task items.")
                .addDropdown(drop => {
                    drop.selectEl.dataset.calendarAction = 'create-mode';
                    return drop
                        .addOption("note", "Note")
                        .addOption("task", "Task item")
                        .setValue(calendar.autoCreateMode || "note")
                        .onChange(async (val: "note" | "task") => {
                            calendar.autoCreateMode = val;
                            await save(true, { calendarId, action: 'create-mode' });
                        });
                });

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
                        summary.textContent = this.buildCalendarOutputSummary(calendar);
                        await save();
                    }));

                new Setting(acContent)
                    .setName("Task target note")
                    .setDesc("Optional note path for synced task items. Leave blank for daily-note task storage.")
                    .addText(t => {
                        const commit = async () => {
                            const normalized = normalizeTaskTargetNotePath(t.getValue());
                            if ((calendar.autoCreateTaskTargetPath || "") === normalized) return;
                            calendar.autoCreateTaskTargetPath = normalized;
                            t.setValue(normalized);
                            summary.textContent = this.buildCalendarOutputSummary(calendar);
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
            } else {
                new Setting(acContent)
                .setName("Type Folder")
                .setDesc("High-level folder categorization (optional).")
                .addText(t => t
                    .setValue(calendar.autoCreateTypeFolder || "")
                    .setPlaceholder("Meetings/External")
                    .onChange(async (val) => {
                        calendar.autoCreateTypeFolder = val;
                        summary.textContent = this.buildCalendarOutputSummary(calendar);
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
                        summary.textContent = this.buildCalendarOutputSummary(calendar);
                        await save();
                    }));
            }

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

            if ((calendar.autoCreateMode || "note") === "note") {
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
            }
        });
    }

    private buildCalendarDisplayName(calendar: ExternalCalendarConfig, index: number): string {
        const rawUrl = String(calendar.url || '').trim();
        if (!rawUrl) return `New calendar ${index + 1}`;
        try {
            const parsed = new URL(rawUrl);
            return parsed.hostname || `Calendar ${index + 1}`;
        } catch {
            return rawUrl.length > 44 ? `${rawUrl.slice(0, 41)}…` : rawUrl;
        }
    }

    private buildCalendarOutputSummary(calendar: ExternalCalendarConfig): string {
        const state = calendar.enabled === false ? 'Disabled' : 'Enabled';
        if (calendar.autoCreateEnabled === false) return `${state} · sync only`;
        if ((calendar.autoCreateMode || 'note') === 'task') {
            const destination = (calendar.autoCreateTaskDestination || 'daily-note') === 'daily-note'
                ? 'daily note'
                : calendar.autoCreateTaskTargetPath || 'single task note';
            return `${state} · Task → ${destination}`;
        }
        const destination = calendar.autoCreateFolder || calendar.autoCreateTypeFolder || 'default note folder';
        return `${state} · Note → ${destination}`;
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
