import { Modal, App, TFile, debounce, setIcon, moment, Menu } from 'obsidian';
import type TPSControllerPlugin from '../main';
import type { OverdueItem } from '../types';

export class OverdueItemsModal extends Modal {
    plugin: TPSControllerPlugin;
    items: OverdueItem[] = [];
    container: HTMLDivElement;
    refreshDebounced: () => void;
    private suppressedItemKeys = new Set<string>();

    constructor(app: App, plugin: TPSControllerPlugin) {
        super(app);
        this.plugin = plugin;
        this.refreshDebounced = debounce(this.refresh.bind(this), 300, true);
    }

    async onOpen() {
        const { contentEl, titleEl } = this;
        titleEl.setText('Overdue Items');

        this.container = contentEl.createDiv() as HTMLDivElement;
        this.container.style.maxHeight = '400px';
        this.container.style.overflowY = 'auto';

        await this.refresh();

        this.plugin.registerEvent(
            this.app.metadataCache.on('changed', (_file: TFile) => {
                this.refreshDebounced();
            })
        );
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }

    async refresh() {
        const nextItems = await this.plugin.getOverdueItems();
        const nextKeys = new Set(nextItems.map((item) => this.getItemKey(item)));
        for (const key of Array.from(this.suppressedItemKeys)) {
            if (!nextKeys.has(key)) this.suppressedItemKeys.delete(key);
        }
        this.items = nextItems.filter((item) => !this.suppressedItemKeys.has(this.getItemKey(item)));
        this.render();
    }

    private getItemDisplayTitle(item: OverdueItem): string {
        const title = String(item.title || '').trim();
        if (title) return title;
        return item.file.basename;
    }

    private getItemKey(item: OverdueItem): string {
        return item.sourceKey || `${item.file.path}::${item.id || item.reminder?.id || ''}`;
    }

    private removeItemOptimistically(item: OverdueItem): void {
        const key = this.getItemKey(item);
        this.suppressedItemKeys.add(key);
        this.items = this.items.filter((candidate) => this.getItemKey(candidate) !== key);
        this.render();
    }

    render() {
        const previousScrollTop = this.container.scrollTop;
        this.container.empty();
        this.titleEl.setText(`Overdue Items (${this.items.length})`);

        if (this.items.length === 0) {
            this.container.createEl('div', { text: 'No overdue items.', cls: 'tps-overdue-empty' });
            this.container.scrollTop = previousScrollTop;
            return;
        }

        for (const item of this.items) {
            const row = this.container.createDiv({ cls: 'tps-overdue-item' });
            row.style.padding = '8px';
            row.style.borderBottom = '1px solid var(--background-modifier-border)';
            row.style.cursor = 'pointer';

            if (item.snoozedUntil) {
                row.style.opacity = '0.5';
            }

            const titleRow = row.createDiv();
            titleRow.style.display = 'flex';
            titleRow.style.alignItems = 'center';
            titleRow.style.gap = '8px';

            const rawIcon = item.icon && item.icon.trim() ? item.icon.trim() : '';
            if (rawIcon) {
                const iconEl = titleRow.createDiv({ cls: 'tps-overdue-icon' });
                const iconName = rawIcon.includes(':') ? rawIcon.split(':').pop()! : rawIcon;
                iconEl.style.display = 'flex';
                iconEl.style.alignItems = 'center';
                iconEl.style.color = item.color && item.color.trim() ? item.color.trim() : 'var(--text-muted)';
                setIcon(iconEl, iconName);
            }

            const title = titleRow.createEl('div', { text: this.getItemDisplayTitle(item) });
            title.style.fontWeight = '600';

            const isAllDay = Boolean(item.isAllDay);
            const detailsText = item.snoozedUntil
                ? `Snoozed until ${moment(item.snoozedUntil).format('HH:mm')}`
                : (isAllDay ? 'All day' : item.diff);

            const details = row.createEl('div', { text: detailsText });
            details.style.fontSize = '0.85em';
            details.style.color = item.snoozedUntil ? 'var(--text-accent)' : 'var(--text-muted)';

            const actions = row.createDiv({ cls: 'tps-overdue-actions' });
            actions.style.display = 'flex';
            actions.style.gap = '8px';
            actions.style.marginTop = '4px';
            actions.style.alignItems = 'center';

            const createIconButton = (icon: string, label: string, onClick: () => Promise<void>): HTMLButtonElement => {
                const button = actions.createEl('button', { cls: 'clickable-icon tps-overdue-action-button' });
                button.setAttribute('aria-label', label);
                button.setAttribute('title', label);
                button.style.display = 'flex';
                button.style.alignItems = 'center';
                button.style.justifyContent = 'center';
                button.style.width = '30px';
                button.style.height = '30px';
                button.style.padding = '0';
                setIcon(button, icon);
                button.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (button.disabled) return;
                    button.disabled = true;
                    this.removeItemOptimistically(item);
                    void (async () => {
                        try {
                            await onClick();
                            this.refreshDebounced();
                        } catch (error) {
                            this.suppressedItemKeys.delete(this.getItemKey(item));
                            console.error(`[TPS Controller] Failed reminder action: ${label}`, error);
                            await this.refresh();
                        }
                    })();
                });
                return button;
            };

            createIconButton('check', 'Complete', async () => {
                await this.plugin.markOverdueItemComplete(item);
            });

            createIconButton('x', 'Wont-do', async () => {
                await this.plugin.markOverdueItemWontDo(item);
            });

            const openBtn = actions.createEl('button', { text: 'Open Note' });
            openBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                void this.plugin.openOverdueItem(item);
            });

            row.addEventListener('click', (e) => {
                if ((e.target as HTMLElement).closest('.tps-overdue-actions')) return;
                void this.plugin.openOverdueItem(item);
            });

            row.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const menu = new Menu();
                this.app.workspace.trigger('file-menu', menu, item.file, 'tps-overdue-modal');
                menu.showAtMouseEvent(e);
            });
        }
        this.container.scrollTop = previousScrollTop;
    }
}
