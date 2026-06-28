import { App } from "obsidian";
import { getPluginById } from "../core";
import * as logger from "../logger";
import type { TPSControllerSettings } from "../types";

/**
 * One-time migration: reads settings from legacy TPS-Calendar and TPS-Notifier
 * plugins and copies automation-related fields into Controller settings.
 */
export async function migrateSettingsFromPlugins(
    app: App,
    settings: TPSControllerSettings,
    saveSettings: () => Promise<void>
): Promise<void> {
    logger.log("Running first-time settings migration...");
    let migrated = false;

    try {
        // Migrate from Notifier
        const notifierPlugin = getPluginById(app, "tps-messager")
                            || getPluginById(app, "tps-notifier");
        const ns = (notifierPlugin as any)?.settings;
        if (ns) {
            if (Array.isArray(ns.reminders) && (!Array.isArray(settings.reminders) || settings.reminders.length === 0)) {
                settings.reminders = JSON.parse(JSON.stringify(ns.reminders));
                migrated = true;
            }
            if (typeof ns.pollMinutes === 'number') settings.pollMinutes = ns.pollMinutes;
            if (ns.alertState) settings.alertState = JSON.parse(JSON.stringify(ns.alertState));
            if (typeof ns.batchNotifications === 'boolean') settings.batchNotifications = ns.batchNotifications;
            if (typeof ns.snoozeProperty === 'string') settings.snoozeProperty = ns.snoozeProperty;
            if (Array.isArray(ns.ignorePaths)) settings.globalIgnorePaths = [...ns.ignorePaths];
            if (Array.isArray(ns.ignoreTags)) settings.globalIgnoreTags = [...ns.ignoreTags];
            if (Array.isArray(ns.ignoreStatuses)) settings.globalIgnoreStatuses = [...ns.ignoreStatuses];
            if (typeof ns.enableLogging === 'boolean') settings.enableLogging = ns.enableLogging;
            logger.log("Migrated settings from Notifier.");
        }

        // Migrate from Calendar
        const calendarPlugin = getPluginById(app, "tps-calendar-base")
                            || getPluginById(app, "TPS-Calendar-Base (Dev)");
        const cs = (calendarPlugin as any)?.settings;
        if (cs) {
            if (typeof cs.syncIntervalMinutes === 'number') settings.syncIntervalMinutes = cs.syncIntervalMinutes;
            if (cs.syncOnEventDelete) settings.syncOnEventDelete = cs.syncOnEventDelete;
            if (typeof cs.archiveFolder === 'string') settings.archiveFolder = cs.archiveFolder;
            if (typeof cs.externalCalendarFilter === 'string') settings.externalCalendarFilter = cs.externalCalendarFilter;
            if (typeof cs.startProperty === 'string') settings.startProperty = cs.startProperty;
            if (typeof cs.endProperty === 'string') settings.endProperty = cs.endProperty;
            if (typeof cs.eventIdKey === 'string') settings.eventIdKey = cs.eventIdKey;
            if (typeof cs.uidKey === 'string') settings.uidKey = cs.uidKey;
            if (typeof cs.titleKey === 'string') settings.titleKey = cs.titleKey;
            if (typeof cs.statusKey === 'string') settings.statusKey = cs.statusKey;
            if (typeof cs.previousStatusKey === 'string') settings.previousStatusKey = cs.previousStatusKey;
            if (typeof cs.canceledStatusValue === 'string') settings.canceledStatusValue = cs.canceledStatusValue;
            if (Array.isArray(cs.externalCalendars) && cs.externalCalendars.length > 0) {
                if (!settings.externalCalendars || settings.externalCalendars.length === 0) {
                    settings.externalCalendars = JSON.parse(JSON.stringify(cs.externalCalendars));
                }
            }
            migrated = true;
            logger.log("Migrated settings from Calendar.");
        }
    } catch (e) {
        logger.error("Error during settings migration:", e);
    }

    settings._migratedFromPlugins = true;
    await saveSettings();
    logger.log(migrated ? "Settings migration complete." : "No source plugins found for migration. Using defaults.");
}
