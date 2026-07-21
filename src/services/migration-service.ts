import { App } from "obsidian";
import { getPluginById } from "../core";
import * as logger from "../logger";
import type { TPSControllerSettings } from "../types";
import { fillMissingLegacyPluginSettings } from "./settings-persistence";

/**
 * One-time migration: reads settings from legacy TPS-Calendar and TPS-Notifier
 * plugins and copies automation-related fields into Controller settings.
 */
export async function migrateSettingsFromPlugins(
    app: App,
    settings: TPSControllerSettings,
    rawControllerSettings: Record<string, unknown>,
    saveSettings: () => Promise<void>
): Promise<void> {
    logger.log("Running first-time settings migration...");
    let migratedFields = 0;

    try {
        const notifierPlugin = getPluginById(app, "tps-messager")
                            || getPluginById(app, "tps-notifier");
        const calendarPlugin = getPluginById(app, "tps-calendar-base")
                            || getPluginById(app, "TPS-Calendar-Base (Dev)");
        const notifierSettings = (notifierPlugin as any)?.settings as Record<string, unknown> | undefined;
        const calendarSettings = (calendarPlugin as any)?.settings as Record<string, unknown> | undefined;
        migratedFields = fillMissingLegacyPluginSettings(
            settings,
            rawControllerSettings,
            notifierSettings,
            calendarSettings,
        );
    } catch (e) {
        logger.error("Error during settings migration:", e);
    }

    settings._migratedFromPlugins = true;
    await saveSettings();
    logger.log(migratedFields > 0
        ? `Settings migration complete (${migratedFields} missing field${migratedFields === 1 ? "" : "s"} filled).`
        : "No missing Controller settings were available to migrate.");
}
