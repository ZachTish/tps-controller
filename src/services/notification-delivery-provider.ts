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
 * Existing Controller data predates a single-provider setting and delivered
 * through Messager/Notifier. Keep that established route on upgrade; fresh
 * installs default to the native TishOS path.
 */
export function resolveNotificationDeliveryProvider(
    value: unknown,
    hasPersistedControllerSettings: boolean,
): NotificationDeliveryProvider {
    if (isNotificationDeliveryProvider(value)) return value;
    if (value === undefined && hasPersistedControllerSettings) return "ntfy";
    return DEFAULT_NOTIFICATION_DELIVERY_PROVIDER;
}
