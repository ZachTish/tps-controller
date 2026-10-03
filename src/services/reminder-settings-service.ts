import type { PropertyReminder } from "../types";

export function normalizeReminderSettingsInPlace(reminders: PropertyReminder[]): PropertyReminder[] {
    for (const reminder of reminders) {
        // Historical task-line filters cannot govern whole-note reminders.
        reminder.ignoreCheckboxStates = [];
        reminder.requiredCheckboxStates = [];

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
