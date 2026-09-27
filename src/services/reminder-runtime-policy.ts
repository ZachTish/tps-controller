import type { NotificationDeliveryProvider } from "./notification-delivery-provider";
import type { TPSControllerSettings } from "../types";

/** Keep candidate discovery and target construction on the same configured scope. */
export function resolveInlineTaskReminderMode(
    app: unknown,
    settings: Pick<TPSControllerSettings, "inlineTaskReminders">,
): TPSControllerSettings["inlineTaskReminders"] {
    if (settings.inlineTaskReminders !== "gcm") return settings.inlineTaskReminders;
    const gcm = (app as any)?.plugins?.getPlugin?.("tps-global-context-menu")
        || (app as any)?.plugins?.plugins?.["tps-global-context-menu"];
    return gcm?.settings?.dataArchitectureMode === "legacy" ? "scheduled" : "none";
}

export type ReminderDeliveryMode = "local-obsidian" | "ntfy";

export interface ReminderNotificationPlatform {
    isDesktopApp: boolean;
    isIosApp: boolean;
    isMacOS: boolean;
}

export interface ReminderRuntimePolicyInput {
    enableReminders: unknown;
    notificationDeliveryProvider: NotificationDeliveryProvider;
    isController: boolean;
    isMobile: boolean;
    supportsTishOSNativeNotifications: boolean;
}

/**
 * TishOS currently has native clients on macOS, iPhone, and iPad. Windows,
 * Linux, and Android therefore use a local in-app Obsidian fallback when the
 * synced provider remains TishOS. The fallback is role-agnostic and exists
 * only while Obsidian is loaded.
 */
export function supportsTishOSNotificationDelivery(
    platform: ReminderNotificationPlatform,
): boolean {
    return platform.isIosApp || (platform.isDesktopApp && platform.isMacOS);
}

/** Direct ntfy delivery remains Controller-owned and desktop-only. */
export function resolveReminderDeliveryMode(
    input: ReminderRuntimePolicyInput,
): ReminderDeliveryMode | null {
    if (input.enableReminders !== true) return null;
    if (input.notificationDeliveryProvider === "tishos") {
        return input.supportsTishOSNativeNotifications ? null : "local-obsidian";
    }
    return input.isController && !input.isMobile ? "ntfy" : null;
}
