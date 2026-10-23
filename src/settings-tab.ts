import { nativeSettingsSearch, focusSettingsSearchResult, type SettingsSearchEntry } from "./native-settings-search";
import { SETTINGS_SEARCH_ENTRIES, SETTINGS_SEARCH_ROUTES } from "./settings-search-catalog";
import { CONNECTION_SECTIONS, ConnectionSection, connectionSection, mountConnectionSettings } from "./services/connection-settings";
import { validateNoteRules } from "./services/note-rules";
import { NoteRuleEditor, NoteRulePreviewModal } from "./services/note-rule-ui";
import { renderFinanceImportRetirement, renderWalletSetupEntry } from "./services/finance-relay-settings";
import { App, Notice, PluginSettingTab, Setting, normalizePath } from 'obsidian';
import type TPSControllerPlugin from './main';

const createCalendarId = () => `calendar-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
export type ControllerSettingsPage = 'overview' | 'calendar' | 'reminders' | 'automations' | 'advanced' | 'note-rules' | 'connections';

const CONTROLLER_SETTINGS_DESTINATIONS: Array<{
    id: ControllerSettingsPage;
    label: string;
    description: string;
}> = [
    { id: 'overview', label: 'Overview', description: 'Device role and quick links.' },
    { id: 'connections', label: 'Connections', description: 'Banks, Wallet, AI, and food databases.' },
    { id: 'calendar', label: 'Calendar rules', description: 'Feeds, destinations, and sync safety.' },
    { id: 'note-rules', label: 'Note rules', description: 'Preview and apply rules with a command.' },
    { id: 'reminders', label: 'Reminders', description: 'Retired reminder integration information.' },
    { id: 'automations', label: 'Automations', description: 'Manual archive actions.' },
    { id: 'advanced', label: 'Advanced', description: 'Field names and troubleshooting.' },
];

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
  private searchContentEl: HTMLElement | null = null;
  private get settingsContentEl(): HTMLElement {
    return this.searchContentEl?.isConnected ? this.searchContentEl : this.containerEl;
  }

  getSettingDefinitions() {
    return nativeSettingsSearch(SETTINGS_SEARCH_ENTRIES, SETTINGS_SEARCH_ROUTES,
      container => {
        this.searchContentEl = container;
        this.display();
        return () => { this.hide(); if (this.searchContentEl === container) this.searchContentEl = null; };
      }, entry => this.openSearchResult(entry));
  }

  private openSearchResult(entry: SettingsSearchEntry): void {
    this.activePage = entry.route as ControllerSettingsPage;
    const manager = (this.app as App & { setting?: { openTabById?: (id: string) => void } }).setting;
    manager?.openTabById?.(this.plugin.manifest.id);
    this.display();
    if (!focusSettingsSearchResult(this.settingsContentEl, entry.name)) {
      const message = this.settingsContentEl.createDiv({
        text: `“${entry.name}” is in this area. Its control appears when the relevant feature or saved item is selected.`,
        attr: { role: 'status', tabindex: '-1' },
      });
      this.settingsContentEl.prepend(message);
      message.focus();
      message.scrollIntoView({ block: 'start' });
    }
  }

    plugin: TPSControllerPlugin;
    private activePage: ControllerSettingsPage = 'overview';
    private activeConnection: ConnectionSection = 'finance';
    private connectionDispose: (() => void) | null = null;
    private noteRuleEditor: NoteRuleEditor | null = null;

    openPlaidSettings(): void {
        this.openConnectionSettings('finance');
    }

    openConnectionSettings(section?: unknown): void {
        this.activeConnection = connectionSection(section);
        this.activePage = 'connections';
        this.display();
    }

    constructor(app: App, plugin: TPSControllerPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    openPage(destination: ControllerSettingsPage): void {
        this.activePage = destination;
        this.display();
    }

    hide(): void {
        this.connectionDispose?.();
        this.connectionDispose = null;
    }

    display(): void {
        this.hide();
        const containerEl = this.settingsContentEl;
        containerEl.empty();

        containerEl.createEl('h2', { text: 'TPS Controller Settings' });
        this.renderSettingsDestinationHub(containerEl);

        if (this.activePage === 'overview') {
            this.renderPageHeading(
                containerEl,
                'Overview',
                'See what this device owns, then jump directly to the rules or automation you want to change.'
            );
        renderWalletSetupEntry(containerEl);
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
                    Calendar imports and reminder delivery are retired. Device role still applies to retained manual operations and remaining integrations.
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
            'Retired · saved feed settings remain unchanged',
            'Open calendar rules',
            'calendar'
        );
        this.renderOverviewCard(
            overviewCards,
            'Reminder rules',
            'Retired · saved rules remain unchanged',
            'View retirement information',
            'reminders'
        );

        this.renderOverviewCard(
            overviewCards,
            'Automations',
            'Manual archive only',
            'Open automations',
            'automations'
        );
        }

        // ── External Calendars ─────────────────────────────────────
        if (this.activePage === 'connections') {
            this.renderPageHeading(containerEl, 'Connections', '');
            const selector = containerEl.createDiv({ cls: 'tps-controller-connections-selector', attr: { role: 'group', 'aria-label': 'Connection type' } });
            for (const section of CONNECTION_SECTIONS) {
                const button = selector.createEl('button', { text: section.label, attr: { type: 'button', 'aria-pressed': String(this.activeConnection === section.id) } });
                button.addEventListener('click', () => {
                    this.activeConnection = section.id;
                    this.display();
                    this.settingsContentEl.querySelector<HTMLElement>('.tps-controller-connections-selector [aria-pressed="true"]')?.focus({ preventScroll: true });
                });
            }
            const content = containerEl.createDiv({ cls: 'tps-controller-connections-content' });
            if (this.activeConnection === 'finance') {
                renderWalletSetupEntry(content);
                renderFinanceImportRetirement(content);
            } else if (this.activeConnection === 'tishos') {
                this.renderTishOSConnections(content);
            } else {
                this.connectionDispose = mountConnectionSettings(this.app, content, this.activeConnection);
            }
            new Setting(containerEl).setName('Other connections')
                .addButton(button => button.setButtonText('Calendar feeds').onClick(() => this.navigateToPage('calendar')));
        }

        if (this.activePage === 'calendar') { this.renderPageHeading(containerEl, 'Calendar imports retired', 'TPS Controller no longer imports calendar events. Existing notes and saved feed settings are unchanged.'); }

        // ── Two-Stage Archive ─────────────────────────────────────
        if (this.activePage === 'automations') {
        this.renderPageHeading(
            containerEl,
            'Automations',
            'Run archive actions explicitly. Automatic archiving and attachment syncing are retired.'
        );

        {
        const twoStageArchiveSection = createSettingsSection(
            containerEl,
            'Archive files',
            'Move files into a cold archive only when you choose Run Now.'
        );

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

        }

        // ── Calendar Sync Rules ────────────────────────────────────


        if (this.activePage === 'note-rules') {
            if (!this.noteRuleEditor) this.noteRuleEditor = new NoteRuleEditor(
                () => this.plugin.settings.noteRules,
                async (rules) => {
                    const previous = this.plugin.settings.noteRules;
                    if (JSON.stringify((await this.plugin.loadData())?.noteRules) !== JSON.stringify(previous)) throw new Error('Saved rules changed on disk. Reload saved rules first.');
                    this.plugin.settings.noteRules = rules;
                    try { await this.plugin.saveSettings(); }
                    catch (error) { this.plugin.settings.noteRules = previous; throw error; }
                },
                () => new NoteRulePreviewModal(this.app, this.plugin.noteRuleRunner, { kind: 'note', path: this.app.workspace.getActiveFile()?.path || '' }).open(),
                async () => {
                    const saved = (await this.plugin.loadData())?.noteRules;
                    validateNoteRules(saved);
                    this.plugin.settings.noteRules = saved;
                },
            );
            this.noteRuleEditor.render(containerEl.createDiv());
        }

        if (this.activePage === 'advanced') {
        this.renderPageHeading(
            containerEl,
            'Advanced',
            'Configure fields used by retained note operations or enable diagnostic logging.'
        );
        const fmContent = createSettingsSection(
            containerEl,
            'Note field names',
            'Fields used by retained note operations. The shared record ID property is configured in GCM.'
        );

        new Setting(fmContent).setName('Shared integration property names').addButton(button => button
            .setButtonText('Open GCM settings').onClick(() => {
                const manager = (this.app as App & { setting?: { open?: () => void; openTabById?: (id: string) => void } }).setting;
                manager?.open?.(); manager?.openTabById?.('tps-global-context-menu');
            }));

        const fmKeys: { key: keyof typeof this.plugin.settings; label: string; placeholder: string }[] = [
            { key: 'titleKey', label: 'Title Key', placeholder: 'title' },
            { key: 'statusKey', label: 'Status Key', placeholder: 'status' },
            { key: 'startProperty', label: 'Start Property', placeholder: 'scheduled' },
            { key: 'endProperty', label: 'Duration Property', placeholder: 'timeEstimate' },
        ];

        for (const fk of fmKeys) {
            let value = String((this.plugin.settings as any)[fk.key] || fk.placeholder);
            new Setting(fmContent).setName(fk.label)
                .setDesc('Apply previews existing notes and asks before updating their properties.')
                .addText(text => {
                  text.setValue(value).onChange(next => { value = next.trim(); });
                  text.inputEl.setAttribute('aria-label', fk.label);
                  text.inputEl.dataset.tpsMappingKey = String(fk.key);
                  text.inputEl.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); (text.inputEl.closest('.setting-item')?.querySelector('button') as HTMLButtonElement)?.click(); } });
                })
                .addButton(button => button.setButtonText('Apply').onClick(async () => {
                    button.setDisabled(true);
                    try {
                        const api = (this.app as any).plugins?.plugins?.['tps-global-context-menu']?.api?.propertyMappings;
                        if (!api?.changeKey) throw new Error('Update and enable TPS GCM to review this mapping change.');
                        const scrollTop = this.containerEl.scrollTop;
                        if (await api.changeKey('tps-controller', fk.key, value)) {
                            this.display();
                            this.containerEl.scrollTop = scrollTop;
                            this.settingsContentEl.querySelector<HTMLInputElement>(`[data-tps-mapping-key="${String(fk.key)}"]`)?.focus({preventScroll:true});
                        }
                    } catch (error) { new Notice(error instanceof Error ? error.message : String(error)); }
                    finally { button.setDisabled(false); }
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
            'Diagnostic logging.'
        );

        new Setting(debugSection)
            .setName('Enable Logging')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableLogging)
                .onChange(async (value) => {
                    this.plugin.settings.enableLogging = value;
                    await this.plugin.saveSettings();
                }));


        }
    }

    // ========================================================================
    // Helpers
    // ========================================================================

    private renderTishOSConnections(containerEl: HTMLElement): void {
        createSettingsSection(containerEl, 'TishOS file bridges retired', 'Controller no longer publishes command catalogs or notification schedules. Saved pairing state and existing files are unchanged.');
    }

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
        const heading = this.settingsContentEl.querySelector<HTMLElement>('.tps-settings-page-heading h2');
        heading?.focus({ preventScroll: false });
    }

    private redisplayPreservingScroll(focusSelector?: string): void {
        const scrollTop = this.containerEl.scrollTop;
        this.display();
        this.containerEl.scrollTop = scrollTop;
        if (focusSelector) {
            this.settingsContentEl.querySelector<HTMLElement>(focusSelector)?.focus({ preventScroll: true });
        }
    }

    private renderReminderSettingsPage(container: HTMLElement): void {
        this.renderPageHeading(container, 'Reminders retired', '');
        container.createEl('p', { text: 'Controller no longer automatically evaluates or delivers reminders. Saved rules and historical state are unchanged. Configure reminders in your separate app.' });
    }
}
