import type { PropertyReminder } from "../types";

export function normalizeReminderSettingsInPlace(reminders: PropertyReminder[]): PropertyReminder[] {
    for (const reminder of reminders) {
        if (!Array.isArray(reminder.ignoreCheckboxStates)) reminder.ignoreCheckboxStates = [];
        if (!Array.isArray(reminder.requiredCheckboxStates)) reminder.requiredCheckboxStates = [];

        if (!Array.isArray(reminder.sourceTypes)) continue;
        const sourceTypes = reminder.sourceTypes.filter((sourceType) =>
            sourceType === "file" || sourceType === "external-event"
        );
        if (sourceTypes.length) {
            reminder.sourceTypes = sourceTypes;
        } else {
            delete reminder.sourceTypes;
        }
    }
    return reminders;
}
