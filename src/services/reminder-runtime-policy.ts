export type ReminderDeliveryMode = "controller" | "local-only";

export interface ReminderRuntimePolicyInput {
    enableReminders: unknown;
    enableLocalReminderNoticesOnUserDevices: unknown;
    isController: boolean;
    isMobile: boolean;
}

/**
 * Controller delivery remains desktop-only. Every other loaded instance is
 * eligible for the opt-in local-only lane, including a mobile instance whose
 * device-local role is still set to Controller.
 */
export function resolveReminderDeliveryMode(
    input: ReminderRuntimePolicyInput,
): ReminderDeliveryMode | null {
    if (input.enableReminders !== true) return null;
    if (input.isController && !input.isMobile) return "controller";
    return input.enableLocalReminderNoticesOnUserDevices === true ? "local-only" : null;
}
