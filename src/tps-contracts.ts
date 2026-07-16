export const TPS_EVENTS = {
  CONTROLLER_ROLE_CHANGED: "tps:controller-role-changed",
  CONTROLLER_SETTINGS_CHANGED: "tps:controller-settings-changed",
  CALENDAR_SETTINGS_CHANGED: "tps:calendar-settings-changed",
  CALENDAR_SYNC_STARTED: "tps:calendar-sync-started",
  CALENDAR_SYNC_COMPLETED: "tps:calendar-sync-completed",
  REMINDERS_UPDATED: "tps:reminders-updated",
  FILES_UPDATED: "tps:files-updated",
  GCM_EXPLICIT_ACTION: "tps:gcm-explicit-action",
  CALENDAR_EXPLICIT_REFRESH: "tps:calendar-explicit-refresh",
} as const;

export const TPS_LEGACY_EVENTS = {
  CALENDAR_SETTINGS_CHANGED: "tps-calendar-settings-changed",
  GCM_FILES_UPDATED: "tps-gcm-files-updated",
  GCM_EXPLICIT_ACTION: "tps-gcm-explicit-action",
  CALENDAR_EXPLICIT_REFRESH: "tps-calendar-explicit-refresh",
  GCM_DELETE_COMPLETE: "tps-gcm-delete-complete",
} as const;

export type TPSEventName = typeof TPS_EVENTS[keyof typeof TPS_EVENTS];
export type TPSLegacyEventName = typeof TPS_LEGACY_EVENTS[keyof typeof TPS_LEGACY_EVENTS];

export interface TPSEventPayload {
  sourcePluginId: string;
  timestamp: number;
}

export interface TPSFilesUpdatedPayload extends TPSEventPayload {
  paths: string[];
}

export interface TPSControllerRoleChangedPayload extends TPSEventPayload {
  role: "controller" | "user";
}

export interface TPSCalendarSettingsSnapshot<TExternalCalendarConfig = unknown> {
  externalCalendars: TExternalCalendarConfig[];
  externalCalendarFilter: string;
}

export interface TPSControllerApi<TSettings = unknown, TExternalCalendarConfig = unknown> {
  isController?: () => boolean;
  getRole?: () => "controller" | "user";
  getSettings?: () => TSettings;
  getCalendarSettingsSnapshot?: () => TPSCalendarSettingsSnapshot<TExternalCalendarConfig> | Promise<TPSCalendarSettingsSnapshot<TExternalCalendarConfig>>;
}

export interface TPSNotifierApi {
  sendNotification?: (title: string, body: string, file?: unknown) => Promise<void>;
  sendMessage?: (text: string, file?: unknown, title?: string) => Promise<void>;
  dryRunMessage?: (text: string, file?: unknown, title?: string) => unknown;
}
