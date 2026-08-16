import type { NotificationDeliveryProvider } from "./notification-delivery-provider";

export type ReminderDeliveryMode = "ntfy";

export interface ReminderRuntimePolicyInput {
    enableReminders: unknown;
    notificationDeliveryProvider: NotificationDeliveryProvider;
    isController: boolean;
    isMobile: boolean;
}

/**
 * Direct ntfy delivery remains Controller-owned and desktop-only. TishOS is a
 * schedule-publication provider, so it never starts the consuming reminder
 * loop on another loaded Obsidian instance.
 */
export function resolveReminderDeliveryMode(
    input: ReminderRuntimePolicyInput,
): ReminderDeliveryMode | null {
    if (input.enableReminders !== true) return null;
    if (input.notificationDeliveryProvider !== "ntfy") return null;
    return input.isController && !input.isMobile ? "ntfy" : null;
}
