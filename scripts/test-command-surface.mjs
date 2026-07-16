import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const mainSource = await readFile(
  fileURLToPath(new URL("../src/main.ts", import.meta.url)),
  "utf8",
);
const loggerSource = await readFile(
  fileURLToPath(new URL("../src/logger.ts", import.meta.url)),
  "utf8",
);
const calendarAutomationSource = await readFile(
  fileURLToPath(new URL("../src/services/calendar-automation.ts", import.meta.url)),
  "utf8",
);
const autoCreateSource = await readFile(
  fileURLToPath(new URL("../src/services/auto-create-service.ts", import.meta.url)),
  "utf8",
);
const twoStageArchiveSource = await readFile(
  fileURLToPath(new URL("../src/services/two-stage-archive-service.ts", import.meta.url)),
  "utf8",
);
const overdueServiceSource = await readFile(
  fileURLToPath(new URL("../src/services/overdue-service.ts", import.meta.url)),
  "utf8",
);
const externalEventModalSource = await readFile(
  fileURLToPath(new URL("../src/services/external-event-modal.ts", import.meta.url)),
  "utf8",
);
const reminderEngineSource = await readFile(
  fileURLToPath(new URL("../src/services/reminder-engine.ts", import.meta.url)),
  "utf8",
);
const syncConflictWatcherSource = await readFile(
  fileURLToPath(new URL("../src/services/sync-conflict-watcher.ts", import.meta.url)),
  "utf8",
);
const syncRequestServiceSource = await readFile(
  fileURLToPath(new URL("../src/services/sync-request-service.ts", import.meta.url)),
  "utf8",
);
const externalCalendarServiceSource = await readFile(
  fileURLToPath(new URL("../src/services/external-calendar-service.ts", import.meta.url)),
  "utf8",
);
const iCalParserServiceSource = await readFile(
  fileURLToPath(new URL("../src/services/ical-parser-service.ts", import.meta.url)),
  "utf8",
);

test("command palette only exposes controller actions that are user-facing and complete", () => {
  for (const id of [
    "force-calendar-sync",
    "run-two-stage-archive-now",
    "force-reminder-check",
    "open-notifications",
  ]) {
    assert.match(mainSource, new RegExp(`id: "${id}"`));
  }

  for (const id of [
    "set-device-role-controller",
    "set-device-role-user",
    "backfill-past-calendar-events",
    "cleanup-duplicate-external-calendar-notes",
    "review-calendar-sync-quarantine",
    "reset-reminder-delivery-state",
    "open-overdue-items",
    "force-parent-child-reconcile",
  ]) {
    assert.doesNotMatch(mainSource, new RegExp(`id: "${id}"`));
  }

  assert.doesNotMatch(mainSource, /ExternalCalendarDuplicateCleanupService/);
  assert.doesNotMatch(mainSource, /OverdueItemsModal/);
});

test("controller logging keeps command and mutation flows traceable", () => {
  assert.match(loggerSource, /export async function timeAsync/);
  assert.match(mainSource, /private traceCommand\(commandId: string/);
  assert.match(mainSource, /logger\.timeAsync\("Command", commandId/);
  assert.match(mainSource, /force-calendar-sync:controller-run/);
  assert.match(mainSource, /force-calendar-sync:replica-request/);
  assert.match(mainSource, /force-reminder-check:controller-run/);
  assert.match(mainSource, /force-reminder-check:replica-request/);
  assert.match(mainSource, /two-stage-archive:manual-result/);
});

test("controller automation never forces a periodic Obsidian reload", () => {
  assert.match(mainSource, /private enterControllerMode\(\)[\s\S]*?this\.startAllAutomation\(\)/);
  assert.doesNotMatch(mainSource, /controllerReloadInterval/);
  assert.doesNotMatch(mainSource, /reloadControllerAppWithoutSaving/);
  assert.doesNotMatch(mainSource, /executeCommandById\(["']app:reload["']\)/);
  assert.doesNotMatch(mainSource, /window\.location\.reload\(\)/);
});

test("controller logging records settings causes and concise runtime outcomes", () => {
  assert.match(mainSource, /persistedSettingsSnapshot/);
  assert.match(mainSource, /getChangedSettingKeys/);
  assert.match(mainSource, /logger\.flow\("Settings", "save:start"/);
  assert.match(mainSource, /logger\.flow\("Settings", "save:done"/);
  assert.match(mainSource, /logger\.flow\("Automation", "start-all"/);
  assert.match(mainSource, /logger\.flow\("ReminderEngine", "check:result"/);
  assert.match(mainSource, /logger\.flow\("ReminderEngine", "delivery:prepared"/);
  assert.match(mainSource, /logger\.flow\("ParentChildMaintenance", "candidates:resolved"/);
});

test("calendar sync and auto-create logging records causes and resulting counts", () => {
  assert.match(calendarAutomationSource, /logger\.flow\("CalendarSync", "readiness"/);
  assert.match(calendarAutomationSource, /logger\.flow\("CalendarSync", "calendars:resolved"/);
  assert.match(calendarAutomationSource, /logger\.flow\("CalendarSync", "scan-roots:resolved"/);
  assert.match(calendarAutomationSource, /logger\.flow\("CalendarSync", "auto-create-configs"/);
  assert.match(autoCreateSource, /logger\.flow\("AutoCreate", "sync:start"/);
  assert.match(autoCreateSource, /logger\.flow\("AutoCreate", "fetch-events:result"/);
  assert.match(autoCreateSource, /logger\.flow\("AutoCreate", "vault-index:result"/);
  assert.match(autoCreateSource, /logger\.flow\("AutoCreate", "sync:done"/);
});

test("two-stage archive logging records due checks, inputs, and outcomes", () => {
  assert.match(twoStageArchiveSource, /logger\.flow\("TwoStageArchive", "due:checked"/);
  assert.match(twoStageArchiveSource, /logger\.flow\("TwoStageArchive", "run:resolved"/);
  assert.match(twoStageArchiveSource, /logger\.flow\("TwoStageArchive", "run:candidates"/);
  assert.match(twoStageArchiveSource, /logger\.flow\("TwoStageArchive", "run:done"/);
  assert.match(twoStageArchiveSource, /logger\.flow\("TwoStageArchive", "target:collision-resolved"/);
});

test("notification and overdue action logging records scan and mutation routes", () => {
  assert.match(overdueServiceSource, /logger\.flow\("NotificationView", "open:start"/);
  assert.match(overdueServiceSource, /logger\.flow\("OverdueItems", "scan:done"/);
  assert.match(overdueServiceSource, /logger\.flow\("OverdueAction", "status:set-start"/);
  assert.match(overdueServiceSource, /route: "task-line"/);
  assert.match(overdueServiceSource, /route: "gcm-set-status"/);
  assert.match(overdueServiceSource, /logger\.flow\("OverdueAction", "snooze:done"/);
  assert.match(overdueServiceSource, /logger\.flow\("OverdueAction", "resolve-reminder:done"/);
  assert.match(overdueServiceSource, /logger\.flow\("OverdueAction", "task-line:update-done"/);
  assert.match(overdueServiceSource, /logger\.flow\("OverdueAction", "move-task:done"/);
  assert.match(overdueServiceSource, /logger\.flow\("OverdueAction", "open-file:route"/);
});

test("external event note creation logging records reuse, creation, and recovery routes", () => {
  assert.match(externalEventModalSource, /logger\.flow\("CreateMeetingNote", "start"/);
  assert.match(externalEventModalSource, /logger\.flow\("CreateMeetingNote", "template:resolved"/);
  assert.match(externalEventModalSource, /logger\.flow\("CreateMeetingNote", "reuse:external-id"/);
  assert.match(externalEventModalSource, /logger\.flow\("CreateMeetingNote", "reuse:legacy-event-id"/);
  assert.match(externalEventModalSource, /logger\.flow\("CreateMeetingNote", "reuse:uid-date"/);
  assert.match(externalEventModalSource, /logger\.flow\("CreateMeetingNote", "reuse:title-day"/);
  assert.match(externalEventModalSource, /logger\.flow\("CreateMeetingNote", "create:attempt"/);
  assert.match(externalEventModalSource, /logger\.flow\("CreateMeetingNote", "create:done"/);
  assert.match(externalEventModalSource, /logger\.flow\("CreateMeetingNote", "frontmatter:applied"/);
  assert.match(externalEventModalSource, /logger\.flow\("CreateMeetingNote", "templater:done"/);
  assert.match(externalEventModalSource, /logger\.flow\("CreateMeetingNote", "parent-link:done"/);
});

test("reminder evaluation logging records scan causes, skip reasons, and queued outcomes", () => {
  assert.match(reminderEngineSource, /interface ReminderEvaluationStats/);
  assert.match(reminderEngineSource, /logger\.flow\("ReminderEngine", "scan:start"/);
  assert.match(reminderEngineSource, /logger\.flow\("ReminderEngine", "scan:done"/);
  assert.match(reminderEngineSource, /summarizeSkipReasons\(stats\.skipReasons\)/);
  assert.match(reminderEngineSource, /this\.countSkip\(params\.stats, "missing-property"\)/);
  assert.match(reminderEngineSource, /this\.countSkip\(params\.stats, "future-trigger"\)/);
  assert.match(reminderEngineSource, /this\.countSkip\(params\.stats, "already-sent"\)/);
  assert.match(reminderEngineSource, /logger\.flow\("ReminderEngine", "notification:queued"/);
  assert.match(reminderEngineSource, /logger\.flow\("ReminderEngine", "external-fetch:start"/);
  assert.match(reminderEngineSource, /logger\.flow\("ReminderEngine", "external-fetch:done"/);
  assert.match(reminderEngineSource, /logger\.flowWarn\("ReminderEngine", "external-fetch:failed"/);
  assert.match(reminderEngineSource, /logger\.flowError\("ReminderEngine", "file:error"/);
});

test("sync request and conflict logging records cross-device causes and mutation outcomes", () => {
  assert.match(syncRequestServiceSource, /logger\.flow\("SyncRequest", "write:start"/);
  assert.match(syncRequestServiceSource, /logger\.flow\("SyncRequest", "write:done"/);
  assert.match(syncRequestServiceSource, /logger\.flow\("SyncRequest", "write:create-raced"/);
  assert.match(syncRequestServiceSource, /logger\.flow\("SyncRequest", "read:done"/);
  assert.match(syncRequestServiceSource, /logger\.flowWarn\("SyncRequest", "read:invalid-shape"/);
  assert.match(syncRequestServiceSource, /logger\.flowWarn\("SyncRequest", "read:parse-failed"/);
  assert.match(syncRequestServiceSource, /logger\.flow\("SyncRequest", "ack:start"/);
  assert.match(syncRequestServiceSource, /logger\.flow\("SyncRequest", "ack:done"/);
  assert.match(syncRequestServiceSource, /"ack:stale-generation"/);

  assert.match(syncConflictWatcherSource, /logger\.flow\("SyncConflictWatcher", "start"/);
  assert.match(syncConflictWatcherSource, /logger\.flow\("SyncConflictWatcher", "sweep:start"/);
  assert.match(syncConflictWatcherSource, /logger\.flow\("SyncConflictWatcher", "sweep:done"/);
  assert.match(syncConflictWatcherSource, /logger\.flow\("SyncConflictWatcher", "check:start"/);
  assert.match(syncConflictWatcherSource, /logger\.flow\("SyncConflictWatcher", "check:skip-calendar-identity"/);
  assert.match(syncConflictWatcherSource, /logger\.flow\("SyncConflictWatcher", "check:canonical-resolved"/);
  assert.match(syncConflictWatcherSource, /logger\.flow\("SyncConflictWatcher", "archive:start"/);
  assert.match(syncConflictWatcherSource, /logger\.flowWarn\("SyncConflictWatcher", "archive:done"/);
  assert.match(syncConflictWatcherSource, /logger\.flowError\("SyncConflictWatcher", "archive:failed"/);
});

test("external calendar fetch and parser logging records provider and event-shape outcomes", () => {
  assert.match(externalCalendarServiceSource, /logger\.flowWarn\("ExternalCalendar", "fetch:invalid-url"/);
  assert.match(externalCalendarServiceSource, /logger\.flow\("ExternalCalendar", "fetch:cache-hit"/);
  assert.match(externalCalendarServiceSource, /logger\.flow\("ExternalCalendar", "fetch:start"/);
  assert.match(externalCalendarServiceSource, /logger\.flowError\("ExternalCalendar", "fetch:bad-status"/);
  assert.match(externalCalendarServiceSource, /logger\.flow\("ExternalCalendar", "fetch:done"/);
  assert.match(externalCalendarServiceSource, /logger\.flowError\("ExternalCalendar", "fetch:failed"/);
  assert.match(externalCalendarServiceSource, /logger\.flow\("ExternalCalendar", "cache:cleared"/);

  assert.match(iCalParserServiceSource, /interface ICalParseStats/);
  assert.match(iCalParserServiceSource, /logger\.flowWarn\("ICalParser", "parse:invalid-input"/);
  assert.match(iCalParserServiceSource, /logger\.flowWarn\("ICalParser", "parse:not-calendar"/);
  assert.match(iCalParserServiceSource, /logger\.flow\("ICalParser", "parse:start"/);
  assert.match(iCalParserServiceSource, /logger\.flow\("ICalParser", "parse:done"/);
  assert.match(iCalParserServiceSource, /logger\.flowError\("ICalParser", "parse:failed"/);
  assert.match(iCalParserServiceSource, /logger\.flowWarn\("ICalParser", "event:parse-failed"/);
  assert.match(iCalParserServiceSource, /logger\.flowWarn\("ICalParser", "timezone:zone-unavailable"/);
  assert.match(iCalParserServiceSource, /outOfRangeSkipped/);
});
