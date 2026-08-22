export type NotificationDeliveryProvider = "tishos" | "ntfy";

export interface NotificationDeliveryProviderOption {
    id: NotificationDeliveryProvider;
    label: string;
    description: string;
}

export const NOTIFICATION_DELIVERY_PROVIDERS: readonly NotificationDeliveryProviderOption[] = [
    {
        id: "tishos",
        label: "TishOS",
        description: "Apple native notifications and actions through the paired TishOS app.",
    },
    {
        id: "ntfy",
        label: "ntfy",
        description: "Remote delivery through TPS Messager/Notifier and its configured ntfy service.",
    },
];

export const DEFAULT_NOTIFICATION_DELIVERY_PROVIDER: NotificationDeliveryProvider = "tishos";

export function isNotificationDeliveryProvider(value: unknown): value is NotificationDeliveryProvider {
    return NOTIFICATION_DELIVERY_PROVIDERS.some((provider) => provider.id === value);
}

/**
 * Existing desktop Controller data predates a single-provider setting and
 * delivered through Messager/Notifier. Preserve that route only where it can
 * actually run. Mobile and User-role devices cannot own ntfy delivery, so a
 * legacy missing-provider payload must select the local TishOS publisher.
 */
export function resolveNotificationDeliveryProvider(
    value: unknown,
    hasPersistedControllerSettings: boolean,
    canUseLegacyNtfyDelivery = true,
): NotificationDeliveryProvider {
    if (isNotificationDeliveryProvider(value)) return value;
    if (value === undefined && hasPersistedControllerSettings && canUseLegacyNtfyDelivery) return "ntfy";
    return DEFAULT_NOTIFICATION_DELIVERY_PROVIDER;
}
