export interface ReminderDeliveryAuditStatus {
    remindersEnabled: boolean;
    notificationDeliveryProvider: 'tishos' | 'ntfy';
    localDeliveryMode: 'local-obsidian' | 'ntfy' | null;
    tishOSNativeNotificationsSupported: boolean;
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

/** Read-only delivery notice shown above the reminder settings. */
export function buildReminderDeliveryStatusText(status: ReminderDeliveryAuditStatus | null): string {
    if (!status) return '';
    if (!status.remindersEnabled) {
        return 'Reminder delivery is off. No reminder is being published.';
    }
    if (status.localDeliveryMode === 'local-obsidian') {
        return 'TishOS is unavailable on this platform. Local Obsidian notices are active while Obsidian is open.';
    }
    if (status.notificationDeliveryProvider === 'ntfy') {
        return status.localDeliveryMode === 'ntfy'
            ? 'ntfy is selected. TishOS receives an empty schedule; this desktop Controller delivers reminders through ntfy.'
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
