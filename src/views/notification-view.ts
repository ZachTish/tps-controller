import { App, ItemView, WorkspaceLeaf, TFile, IconName, MarkdownRenderer, Menu, Modal, Notice, setIcon, debounce, moment } from 'obsidian';
import type { OverdueItem } from '../types';
import { SnoozeModal } from '../modals/snooze-modal';
import * as logger from '../logger';
import { TPS_EVENTS, TPS_LEGACY_EVENTS } from '../tps-contracts';
import { emitFilesUpdated } from '../tps-gcm-api';
import { buildNotificationItemsSignature } from './notification-view-signature';

export const NOTIFICATION_VIEW_TYPE = 'tps-notification-view';

interface ReminderDeliveryAuditStatus {
    remindersEnabled: boolean;
    notificationDeliveryProvider: 'tishos' | 'ntfy';
    localDeliveryMode: 'ntfy' | null;
    commandBridge: {
        available: boolean;
        clients: Array<{
            device: string;
            nativeNotificationState: 'ready' | 'pending';
            nativeNotificationItemCount: number | null;
            nativeNotificationPublishedAt: string | null;
            nativeNotificationReason: string | null;
        }>;
    };
}

// Minimal interface so the view stays decoupled from the full plugin class.
export interface TPSControllerRemindersAPI {
    settings: { snoozeOptions?: { label: string; minutes: number }[] };
    getOverdueItems(): Promise<OverdueItem[]>;
    snoozeFile(file: TFile, minutes: number): Promise<void>;
    snoozeOverdueItem?(item: OverdueItem, minutes: number): Promise<void>;
    openFile(file: TFile): void;
    openOverdueItem?(item: OverdueItem): Promise<void>;
    markFileComplete(file: TFile): Promise<void>;
    markFileWontDo(file: TFile): Promise<void>;
    markOverdueItemComplete?(item: OverdueItem): Promise<void>;
    markOverdueItemWontDo?(item: OverdueItem): Promise<void>;
    setOverdueItemStatus?(item: OverdueItem, status: string | null): Promise<void>;
    resolveOverdueTaskReminder?(item: OverdueItem): Promise<boolean>;
    getReminderDeliveryAuditStatus?(): ReminderDeliveryAuditStatus;
}

export class NotificationView extends ItemView {
    plugin: TPSControllerRemindersAPI;
    items: OverdueItem[] = [];
    private refreshDebounced: () => void;
    private isRefreshing = false;
    private refreshPending = false;
    private lastRenderedSignature = '\u0000';
    private deliveryAuditStatus: ReminderDeliveryAuditStatus | null = null;

    constructor(leaf: WorkspaceLeaf, plugin: TPSControllerRemindersAPI) {
        super(leaf);
        this.plugin = plugin;
        this.refreshDebounced = debounce(() => {
            void this.refresh();
        }, 750, false);
    }

    private getGcmApi(): any {
        const plugins = (this.app as any)?.plugins;
        const plugin =
            plugins?.getPlugin?.('tps-global-context-menu') ||
            plugins?.plugins?.['tps-global-context-menu'] ||
            plugins?.getPlugin?.('TPS-Global-Context-Menu (Dev)') ||
            plugins?.plugins?.['TPS-Global-Context-Menu (Dev)'];
        return plugin?.api || plugin || null;
    }

    private getGcmServices(): any {
        const gcm = this.getGcmApi();
        return gcm?.services || gcm?.sharedServices || null;
    }

    getViewType() { return NOTIFICATION_VIEW_TYPE; }
    getDisplayText() { return "Notifications"; }
    getIcon(): IconName { return "bell"; }

    private getItemDisplayTitle(item: OverdueItem): string {
        if (item.targetKind === 'task' && item.taskTitle) return item.taskTitle;
        const title = String(item.title || '').trim();
        if (title) return title;
        let displayName = item.file.basename;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(displayName)) {
            displayName = displayName.replace(/ \d{4}-\d{2}-\d{2}$/, '');
        }
        return displayName;
    }

    private getItemNoteSubtitle(item: OverdueItem): string {
        if (item.targetKind !== 'task') return '';
        return item.noteTitle || item.file.basename;
    }

    private getItemIcon(item: OverdueItem): { icon: string; color: string } {
        if (item.targetKind === 'task') {
            return { icon: 'check-square', color: 'var(--text-muted)' };
        }

        const rawIcon = (item.icon && item.icon.trim()) ? item.icon.trim() : '';
        const icon = rawIcon.includes(':') ? rawIcon.split(':').pop()! : (rawIcon || 'file-text');
        const color = (item.color && item.color.trim() && item.color.trim() !== 'undefined')
            ? item.color.trim()
            : 'var(--text-muted)';
        return { icon, color };
    }

    private itemKey(item: OverdueItem): string {
        return item.sourceKey || `${item.file.path}::${item.id || item.reminder?.id || ''}`;
    }

    private removeItemOptimistically(item: OverdueItem): void {
        const key = this.itemKey(item);
        this.items = this.items.filter((candidate) => this.itemKey(candidate) !== key);
        this.draw();
    }

    private statusHidesItem(item: OverdueItem, status: string | null, doneStatuses: Set<string>): boolean {
        const normalized = String(status || '').trim().toLowerCase();
        if (!normalized) return false;
        if (doneStatuses.has(normalized)) return true;
        const ignored = (item.reminder.ignoreStatuses || []).map((s) => String(s || '').trim().toLowerCase());
        if (ignored.includes(normalized)) return true;
        return (item.reminder.stopConditions || []).some((condition) => {
            const parts = String(condition || '').split(':');
            if (parts.length < 2) return false;
            return parts[0].trim().toLowerCase() === 'status'
                && parts.slice(1).join(':').trim().toLowerCase() === normalized;
        });
    }

    async onOpen() {
        this.addAction('refresh-cw', 'Refresh Notifications', async () => {
            await this.refresh();
        });

        this.registerEvent(
            this.app.metadataCache.on('changed', (file) => {
                if (!(file instanceof TFile)) return;
                if (this.items.some((item) => item.file.path === file.path)) {
                    this.refreshDebounced();
                }
            })
        );

        this.registerEvent(
            this.app.vault.on('delete', (file) => {
                if (!(file instanceof TFile)) return;
                if (this.items.some((item) => item.file.path === file.path)) {
                    this.refreshDebounced();
                }
            })
        );

        this.registerEvent(
            this.app.vault.on('rename', (file) => {
                if (!(file instanceof TFile)) return;
                this.refreshDebounced();
            })
        );

        this.registerEvent(
            (this.app.workspace as any).on(TPS_LEGACY_EVENTS.GCM_FILES_UPDATED, (paths: string[] | undefined) => {
                if (!Array.isArray(paths) || paths.length === 0) return;
                const pathSet = new Set(paths);
                if (this.items.some((item) => pathSet.has(item.file.path))) {
                    this.refreshDebounced();
                }
            })
        );
        this.registerEvent(
            (this.app.workspace as any).on(TPS_EVENTS.FILES_UPDATED, (payload: { paths?: string[] } | string[] | undefined) => {
                const paths = Array.isArray(payload) ? payload : payload?.paths;
                if (!Array.isArray(paths) || paths.length === 0) return;
                const pathSet = new Set(paths);
                if (this.items.some((item) => pathSet.has(item.file.path))) {
                    this.refreshDebounced();
                }
            })
        );

        await this.refresh();
        this.registerInterval(window.setInterval(() => this.refreshDebounced(), 30000));
    }

    async refresh() {
        if (this.isRefreshing) {
            this.refreshPending = true;
            return;
        }

        this.isRefreshing = true;
        const started = performance.now();
        try {
            const nextItems = await this.plugin.getOverdueItems();
            const deliveryAuditStatus = this.plugin.getReminderDeliveryAuditStatus?.() || null;
            const nextSignature = `${buildNotificationItemsSignature(nextItems)}\u0000${JSON.stringify(deliveryAuditStatus)}`;
            if (nextSignature !== this.lastRenderedSignature) {
                this.items = nextItems;
                this.deliveryAuditStatus = deliveryAuditStatus;
                this.lastRenderedSignature = nextSignature;
                this.draw();
            } else {
                this.items = nextItems;
                this.deliveryAuditStatus = deliveryAuditStatus;
            }
            const elapsed = performance.now() - started;
            if (elapsed > 250) {
                logger.warn('[NotificationView] slow refresh', {
                    elapsedMs: Math.round(elapsed),
                    itemCount: nextItems.length,
                });
            }
        } finally {
            this.isRefreshing = false;
            if (this.refreshPending) {
                this.refreshPending = false;
                this.refreshDebounced();
            }
        }
    }

    draw() {
        const container = this.contentEl;
        container.empty();
        container.addClass('tps-notification-view');

        const list = container.createDiv({ cls: 'tps-notification-list' });
        list.style.display = 'flex';
        list.style.flexDirection = 'column';
        list.style.height = '100%';
        list.style.overflowY = 'auto';

        const deliveryStatusText = this.buildDeliveryStatusText();
        if (deliveryStatusText) {
            list.createDiv({
                cls: 'tps-notification-delivery-status',
                text: deliveryStatusText,
            });
        }

        if (this.items.length === 0) {
            const emptyState = list.createDiv({ cls: 'tps-empty-state' });
            emptyState.style.display = 'flex';
            emptyState.style.flexDirection = 'column';
            emptyState.style.alignItems = 'center';
            emptyState.style.justifyContent = 'center';
            emptyState.style.height = '100%';
            emptyState.style.color = 'var(--text-muted)';
            emptyState.style.padding = '20px';
            const icon = emptyState.createDiv();
            setIcon(icon, 'check-circle');
            icon.style.marginBottom = '8px';
            icon.style.opacity = '0.5';
            emptyState.createDiv({ text: 'All caught up!' });
            return;
        }

        for (const item of this.items) {
            const row = list.createDiv({ cls: 'tps-notification-item' });
            row.dataset.path = item.file.path;
            row.dataset.tpsNotificationPath = item.file.path;
            row.style.display = 'flex';
            row.style.alignItems = 'center';
            row.style.justifyContent = 'space-between';
            row.style.position = 'relative';
            row.style.padding = '8px 12px';
            row.style.borderBottom = '1px solid var(--background-modifier-border)';
            row.style.cursor = 'pointer';
            row.style.gap = '12px';
            row.style.transition = 'background-color 0.1s ease';

            row.addEventListener('mouseenter', () => {
                row.style.backgroundColor = 'var(--background-modifier-hover)';
            });
            row.addEventListener('mouseleave', () => {
                row.style.backgroundColor = 'transparent';
            });

            row.addEventListener('click', (e) => {
                if ((e.target as HTMLElement).closest('.tps-notification-actions')) return;
                if ((e.target as HTMLElement).closest('a.internal-link, a.external-link')) return;
                if (this.plugin.openOverdueItem) void this.plugin.openOverdueItem(item);
                else this.plugin.openFile(item.file);
            });

            row.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.showContextMenu(e, item);
            });

            // Entity icon (left of content)
            const noteIconEl = row.createDiv({ cls: 'tps-notification-icon' });
            noteIconEl.style.display = 'flex';
            noteIconEl.style.alignItems = 'center';
            noteIconEl.style.flexShrink = '0';
            noteIconEl.style.fontSize = '16px';
            noteIconEl.style.lineHeight = '1';
            const { icon: iconName, color: iconColor } = this.getItemIcon(item);
            noteIconEl.setAttribute('title', iconName);
            noteIconEl.style.color = iconColor;
            setIcon(noteIconEl, iconName);

            // Left Content
            const content = row.createDiv({ cls: 'tps-notification-content' });
            content.style.display = 'flex';
            content.style.flexDirection = 'column';
            content.style.flex = '1';
            content.style.minWidth = '0';
            content.style.overflow = 'hidden';

            const topRow = content.createDiv({ cls: 'tps-notification-top' });
            topRow.style.display = 'flex';
            topRow.style.marginBottom = '2px';

            const title = topRow.createDiv({ cls: 'tps-notification-title' });
            title.style.fontWeight = '600';
            title.style.color = 'var(--text-normal)';
            title.style.fontSize = '0.82em';
            title.style.whiteSpace = 'nowrap';
            title.style.overflow = 'hidden';
            title.style.textOverflow = 'ellipsis';
            title.style.minWidth = '0';
            title.style.flex = '1';
            this.renderInlineMarkdownTitle(title, this.getItemDisplayTitle(item), item.file.path);

            const noteSubtitleText = this.getItemNoteSubtitle(item);
            if (noteSubtitleText) {
                const noteSubtitle = content.createEl('span', { text: noteSubtitleText, cls: 'tps-notification-note-title' });
                noteSubtitle.style.fontSize = '0.68em';
                noteSubtitle.style.color = 'var(--text-faint)';
                noteSubtitle.style.whiteSpace = 'nowrap';
                noteSubtitle.style.overflow = 'hidden';
                noteSubtitle.style.textOverflow = 'ellipsis';
                noteSubtitle.style.marginTop = '1px';
            }

            const timeText = item.snoozedUntil
                ? `Snoozed until ${moment(item.snoozedUntil).format('HH:mm')}`
                : (item.isAllDay ? 'All day' : item.diff);
            const time = content.createEl('span', { text: timeText, cls: 'tps-notification-time' });
            time.style.fontSize = '0.68em';
            time.style.color = item.snoozedUntil ? 'var(--text-accent)' : 'var(--text-muted)';
            time.style.whiteSpace = 'nowrap';
            time.style.overflow = 'hidden';
            time.style.textOverflow = 'ellipsis';
            time.style.marginTop = '1px';

            // Next-reminder subtitle
            if (item.nextTriggerTime !== undefined && item.nextRuleLabel) {
                const now2 = Date.now();
                let nextStr: string;
                if (item.isRepeating) {
                    const intervalMins = item.nextReminderIntervalMinutes ?? item.reminder.repeatIntervalMinutes ?? 1;
                    logger.log(`[TPS Subtitle] ${item.file.basename} repeating: nextTime=${item.nextTriggerTime} (${new Date(item.nextTriggerTime).toLocaleTimeString()}), nextReminderIntervalMinutes=${item.nextReminderIntervalMinutes}, reminderRepeatInterval=${item.reminder.repeatIntervalMinutes}, intervalMins=${intervalMins}, isRepeating=${item.isRepeating}`);
                    // Prefer showing the concrete next trigger time when available,
                    // falling back to the generic "every X min" wording.
                    if (item.nextTriggerTime !== undefined) {
                        const msUntil = item.nextTriggerTime - now2;
                        const minsUntil = Math.round(msUntil / 60000);
                        if (minsUntil <= 60) {
                            nextStr = `in ${minsUntil} min — repeats every ${intervalMins} min — ${item.nextRuleLabel}`;
                        } else {
                            nextStr = `${moment(item.nextTriggerTime).format('h:mm A')} — repeats every ${intervalMins} min — ${item.nextRuleLabel}`;
                        }
                    } else {
                        nextStr = `every ${intervalMins} min — ${item.nextRuleLabel}`;
                    }
                } else {
                    const msUntil = item.nextTriggerTime - now2;
                    const minsUntil = Math.round(msUntil / 60000);
                    if (minsUntil <= 60) {
                        nextStr = `in ${minsUntil} min — ${item.nextRuleLabel}`;
                    } else {
                        nextStr = `${moment(item.nextTriggerTime).format('h:mm A')} — ${item.nextRuleLabel}`;
                    }
                }
                const subtitle = content.createDiv({ cls: 'tps-notification-subtitle', text: nextStr });
                subtitle.style.fontSize = '0.68em';
                subtitle.style.color = 'var(--text-faint)';
                subtitle.style.whiteSpace = 'nowrap';
                subtitle.style.overflow = 'hidden';
                subtitle.style.textOverflow = 'ellipsis';
                subtitle.style.marginTop = '1px';
            }

            if (item.snoozedUntil) {
                row.style.opacity = '0.5';
            }

            // Right Actions
            const actions = row.createDiv({ cls: 'tps-notification-actions' });
            actions.style.display = 'flex';
            actions.style.alignItems = 'center';
            actions.style.gap = '4px';
            actions.style.position = 'absolute';
            actions.style.right = '12px';
            actions.style.top = '50%';
            actions.style.transform = 'translateY(-50%)';
            actions.style.zIndex = '2';

            const createIconBtn = (icon: string, label: string, onClick: (e: MouseEvent) => void) => {
                const btn = actions.createDiv({ cls: 'tps-icon-btn' });
                setIcon(btn, icon);
                btn.setAttribute('aria-label', label);
                btn.setAttribute('title', label);
                btn.style.padding = '6px';
                btn.style.borderRadius = '4px';
                btn.style.color = 'var(--text-muted)';
                btn.style.display = 'flex';
                btn.style.alignItems = 'center';
                btn.addEventListener('mouseenter', () => {
                    btn.style.backgroundColor = 'var(--background-modifier-hover)';
                    btn.style.color = 'var(--text-normal)';
                });
                btn.addEventListener('mouseleave', () => {
                    btn.style.backgroundColor = 'transparent';
                    btn.style.color = 'var(--text-muted)';
                });
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    onClick(e);
                });
                return btn;
            };

            if (item.sourceType !== 'external-event' && !!item.reminder.property) {
                const shouldMoveTask = item.targetKind === 'task' && item.reminderPropertySource !== 'task';
                const resolveLabel = shouldMoveTask
                    ? 'Move task to note'
                    : `Clear ${item.reminderProperty || item.reminder.property || 'scheduled'}`;
                createIconBtn(shouldMoveTask ? 'folder-input' : 'calendar-x', resolveLabel, (_e) => {
                    const runResolve = async (): Promise<void> => {
                        try {
                            const changed = this.plugin.resolveOverdueTaskReminder
                                ? await this.plugin.resolveOverdueTaskReminder(item)
                                : false;
                            if (changed) this.removeItemOptimistically(item);
                            this.refreshDebounced();
                        } catch (error) {
                            logger.flowError('NotificationView', 'resolve-task-reminder-failed', error, {
                                path: item.file?.path || '',
                                sourceType: item.sourceType || '',
                            });
                            new Notice('Could not move or clear the reminder task.');
                            this.refreshDebounced();
                        }
                    };
                    if (shouldMoveTask) {
                        void runResolve();
                        return;
                    }
                    new ConfirmClearScheduledModal(this.app, item, () => {
                        void runResolve();
                    }).open();
                });
            } else {
                // Clickable status pill — always visible for non-task reminders.
                const gcmApi = this.getGcmApi();
                const gcmServices = this.getGcmServices();
                const statusOptions: string[] = gcmServices?.status?.getStatusOptions?.()
                    ?? gcmApi?.settings?.properties
                    ?.find((p: any) => p.key === 'status')?.options
                    ?? ['open', 'working', 'blocked', 'wont-do', 'complete'];

                const currentStatus = item.status || '';
                const statusPill = actions.createDiv({ cls: 'tps-status-pill', text: currentStatus || '—' });
                statusPill.style.cursor = 'pointer';
                statusPill.style.padding = '2px 8px';
                statusPill.style.borderRadius = '10px';
                statusPill.style.fontSize = '0.72em';
                statusPill.style.background = 'var(--background-secondary)';
                statusPill.style.color = currentStatus ? 'var(--text-normal)' : 'var(--text-faint)';
                statusPill.style.border = '1px solid var(--background-modifier-border)';
                statusPill.style.whiteSpace = 'nowrap';
                statusPill.addEventListener('mouseenter', () => {
                    statusPill.style.background = 'var(--background-modifier-hover)';
                });
                statusPill.addEventListener('mouseleave', () => {
                    statusPill.style.background = 'var(--background-secondary)';
                });
                statusPill.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const menu = new Menu();
                    const doneStatuses = new Set<string>(
                        (gcmServices?.status?.getDoneStatuses?.()
                            ?? gcmApi?.settings?.recurrenceCompletionStatuses
                            ?? ['complete', 'wont-do'])
                            .map((s: string) => String(s || '').trim().toLowerCase()),
                    );
                    const nowStamp = () => (window as any).moment
                        ? (window as any).moment().format('YYYY-MM-DD HH:mm:ss')
                        : new Date().toISOString().replace('T', ' ').slice(0, 19);
                    const writeStatus = async (newStatus: string | null) => {
                        const isStatusClear = newStatus == null || String(newStatus).trim() === '';
                        const resolvedStatus = isStatusClear ? null : newStatus;
                        if (this.plugin.setOverdueItemStatus) {
                            await this.plugin.setOverdueItemStatus(item, resolvedStatus);
                            return;
                        }
                        const statusService = gcmServices?.status;
                        if (!isStatusClear && typeof statusService?.setFileStatus === 'function') {
                            await statusService.setFileStatus(item.file, resolvedStatus);
                            return;
                        }
                        if (isStatusClear && typeof gcmServices?.frontmatter?.process === 'function') {
                            const statusKey = statusService?.getStatusPropertyKey?.() || 'status';
                            await gcmServices.frontmatter.process(item.file, (fm: Record<string, unknown>) => {
                                const existingStatusKey = Object.keys(fm).find((key) => key.trim().toLowerCase() === statusKey.trim().toLowerCase());
                                if (existingStatusKey) delete fm[existingStatusKey];
                                const cdKey = Object.keys(fm).find((k) => k.toLowerCase() === 'completeddate');
                                if (cdKey) delete fm[cdKey];
                            });
                            this.triggerFilesUpdated([item.file.path]);
                            return;
                        }
                        await this.app.fileManager.processFrontMatter(item.file, (fm) => {
                            const statusKey = statusService?.getStatusPropertyKey?.() || 'status';
                            const existingStatusKey = Object.keys(fm).find((key) => key.trim().toLowerCase() === statusKey.trim().toLowerCase());
                            if (isStatusClear) {
                                if (existingStatusKey) delete fm[existingStatusKey];
                                const cdKey = Object.keys(fm).find((k) => k.toLowerCase() === 'completeddate');
                                if (cdKey) delete fm[cdKey];
                            } else {
                                fm[existingStatusKey || statusKey] = resolvedStatus;
                                if (doneStatuses.has(String(resolvedStatus).trim().toLowerCase())) {
                                    fm.completedDate = nowStamp();
                                } else {
                                    const cdKey = Object.keys(fm).find((k) => k.toLowerCase() === 'completeddate');
                                    if (cdKey) delete fm[cdKey];
                                }
                            }
                        });
                        this.triggerFilesUpdated([item.file.path]);
                    };
                    const applyStatus = async (newStatus: string | null) => {
                        const shouldHide = this.statusHidesItem(item, newStatus, doneStatuses);
                        if (shouldHide) this.removeItemOptimistically(item);
                        else {
                            item.status = String(newStatus || '');
                            this.draw();
                        }
                        try {
                            await writeStatus(newStatus);
                            this.refreshDebounced();
                        } catch (error) {
                            logger.flowError('NotificationView', 'update-overdue-status-failed', error, {
                                path: item.file?.path || '',
                                status: newStatus || '',
                            });
                            this.refreshDebounced();
                        }
                    };
                    menu.addItem((i) => i.setTitle('(none)').setChecked(!currentStatus).onClick(() => {
                        void applyStatus(null);
                    }));
                    menu.addItem((i) => i.setTitle('(empty)').setChecked(currentStatus === '').onClick(() => {
                        void applyStatus('');
                    }));
                    statusOptions.forEach((opt) => {
                        menu.addItem((i) => i.setTitle(opt).setChecked(currentStatus === opt).onClick(() => {
                            void applyStatus(opt);
                        }));
                    });
                    menu.showAtMouseEvent(e);
                });
            }

            createIconBtn('clock', 'Snooze', (_e) => {
                new SnoozeModal(this.app, async (minutes) => {
                    if (this.plugin.snoozeOverdueItem) await this.plugin.snoozeOverdueItem(item, minutes);
                    else await this.plugin.snoozeFile(item.file, minutes);
                    this.refreshDebounced();
                }, this.plugin.settings.snoozeOptions || []).open();
            });

            createIconBtn('check', 'Complete', (_e) => {
                this.removeItemOptimistically(item);
                void (async () => {
                    try {
                        if (this.plugin.markOverdueItemComplete) await this.plugin.markOverdueItemComplete(item);
                        else await this.plugin.markFileComplete(item.file);
                        this.refreshDebounced();
                    } catch (error) {
                        logger.flowError('NotificationView', 'complete-overdue-item-failed', error, {
                            path: item.file?.path || '',
                            sourceType: item.sourceType || '',
                        });
                        this.refreshDebounced();
                    }
                })();
            });

            createIconBtn('minus', 'Wont do', (_e) => {
                this.removeItemOptimistically(item);
                void (async () => {
                    try {
                        if (this.plugin.markOverdueItemWontDo) await this.plugin.markOverdueItemWontDo(item);
                        else await this.plugin.markFileWontDo(item.file);
                        this.refreshDebounced();
                    } catch (error) {
                        logger.flowError('NotificationView', 'wont-do-overdue-item-failed', error, {
                            path: item.file?.path || '',
                            sourceType: item.sourceType || '',
                        });
                        this.refreshDebounced();
                    }
                })();
            });
        }
    }

    private buildDeliveryStatusText(): string {
        const status = this.deliveryAuditStatus;
        if (!status) return '';
        if (!status.remindersEnabled) {
            return 'Reminder delivery is off. No reminder is being published.';
        }
        if (status.notificationDeliveryProvider === 'ntfy') {
            return status.localDeliveryMode === 'ntfy'
                ? 'ntfy is selected. TishOS receives an empty schedule; the rows below use this desktop Controller’s ntfy route.'
                : 'ntfy is selected, but ntfy delivery does not run on this mobile/User device. TishOS receives an empty schedule.';
        }
        if (!status.commandBridge.available) {
            return 'Local TishOS publication is unavailable because this device’s pairing state could not be read.';
        }
        if (status.commandBridge.clients.length === 0) {
            return 'TishOS is selected, but this Obsidian device is not paired with TishOS.';
        }
        const pending = status.commandBridge.clients.filter((client) => client.nativeNotificationState === 'pending');
        if (pending.length > 0) {
            const details = pending.map((client) => {
                const prior = client.nativeNotificationItemCount === null
                    ? ''
                    : `; last verified ${client.nativeNotificationItemCount} item${client.nativeNotificationItemCount === 1 ? '' : 's'}${client.nativeNotificationPublishedAt
                        ? ` at ${new Date(client.nativeNotificationPublishedAt).toLocaleString()}`
                        : ''}`;
                return `${client.device}: ${client.nativeNotificationReason || 'awaiting-refresh'}${prior}`;
            });
            return `Local TishOS schedule pending · ${details.join(' · ')}.`;
        }
        const schedules = status.commandBridge.clients.map((client) => {
            const itemCount = client.nativeNotificationItemCount || 0;
            const updated = client.nativeNotificationPublishedAt
                ? `, updated ${new Date(client.nativeNotificationPublishedAt).toLocaleString()}`
                : '';
            return `${client.device}: ${itemCount} item${itemCount === 1 ? '' : 's'}${updated}`;
        });
        return `Verified local TishOS schedule${schedules.length === 1 ? '' : 's'} · ${schedules.join(' · ')}.`;
    }

    private renderInlineMarkdownTitle(container: HTMLElement, markdown: string, sourcePath: string): void {
        const source = String(markdown || '').trim();
        if (!source) return;
        void MarkdownRenderer.renderMarkdown(source, container, sourcePath, this).then(() => {
            container.querySelectorAll<HTMLElement>('p').forEach((paragraph) => {
                paragraph.style.display = 'inline';
                paragraph.style.margin = '0';
            });
            container.querySelectorAll<HTMLElement>('a.internal-link, a[href^="app://obsidian.md/"]').forEach((link) => {
                if (!this.resolveRenderedInternalLink(link, sourcePath)) {
                    link.replaceWith(document.createTextNode(link.textContent || ''));
                }
            });
            container.querySelectorAll<HTMLElement>('a.internal-link, a.external-link').forEach((link) => {
                link.addClass('tps-notification-title-link');
                link.addEventListener('click', (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    this.openRenderedTitleLink(link, sourcePath);
                });
            });
        });
    }

    private resolveRenderedInternalLink(link: HTMLElement, sourcePath: string): TFile | null {
        const rawTarget = link.getAttribute('data-href') || link.getAttribute('href') || '';
        const resolutionTarget = this.getRenderedInternalLinkResolutionTarget(rawTarget);
        if (!resolutionTarget) return null;
        return this.app.metadataCache.getFirstLinkpathDest(resolutionTarget, sourcePath)
            || this.app.metadataCache.getFirstLinkpathDest(resolutionTarget.replace(/\.md$/i, ''), sourcePath)
            || null;
    }

    private getRenderedInternalLinkResolutionTarget(rawTarget: string): string {
        return this.normalizeRenderedInternalLink(rawTarget)
            .replace(/#.*/, '')
            .trim();
    }

    private normalizeRenderedInternalLink(rawTarget: string): string {
        const withoutScheme = String(rawTarget || '').replace(/^app:\/\/obsidian\.md\//, '').trim();
        if (!withoutScheme) return '';
        try {
            return decodeURIComponent(withoutScheme);
        } catch {
            return withoutScheme;
        }
    }

    private openRenderedTitleLink(link: HTMLElement, sourcePath: string): void {
        const linkText = link.getAttribute('data-href') || link.getAttribute('href') || link.textContent || '';
        const normalized = this.normalizeRenderedInternalLink(linkText);
        if (!normalized) return;
        if (link.hasClass('external-link') || /^[a-z][a-z0-9+.-]*:/i.test(normalized)) {
            window.open(normalized);
            return;
        }
        void this.app.workspace.openLinkText(normalized, sourcePath, false);
    }

    private showContextMenu(e: MouseEvent, item: OverdueItem) {
        const menu = new Menu();
        this.app.workspace.trigger('file-menu', menu, item.file, 'tps-notification-view', this.leaf);
        menu.showAtMouseEvent(e);
    }

    private triggerFilesUpdated(paths: string[]): void {
        emitFilesUpdated(this.app, paths, "tps-controller");
    }
}

class ConfirmClearScheduledModal extends Modal {
    constructor(
        app: App,
        private item: OverdueItem,
        private onConfirm: () => void,
    ) {
        super(app);
    }

    onOpen(): void {
      this.modalEl.addClass("tps-keyboard-aware-modal");
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h2', { text: 'Clear scheduled?' });
        contentEl.createEl('p', {
            text: `Remove the scheduled reminder from "${this.item.taskTitle || this.item.title || this.item.file.basename}"?`,
        });

        const actions = contentEl.createDiv({ cls: 'tps-confirm-clear-actions' });
        actions.style.display = 'flex';
        actions.style.justifyContent = 'flex-end';
        actions.style.gap = '8px';
        actions.style.marginTop = '16px';

        const cancel = actions.createEl('button', { text: 'Cancel' });
        cancel.addEventListener('click', () => this.close());

        const confirm = actions.createEl('button', { text: 'Clear scheduled', cls: 'mod-warning' });
        confirm.addEventListener('click', () => {
            this.close();
            this.onConfirm();
        });
        confirm.focus();
    }

    onClose(): void {
        this.contentEl.empty();
    }
}
