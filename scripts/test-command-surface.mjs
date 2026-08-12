import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

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
const settingsTabSource = await readFile(
  fileURLToPath(new URL("../src/settings-tab.ts", import.meta.url)),
  "utf8",
);
const settingsStylesSource = await readFile(
  fileURLToPath(new URL("../styles-ui.css", import.meta.url)),
  "utf8",
);
const settingsPersistenceBundle = await build({
  entryPoints: [fileURLToPath(new URL("../src/services/settings-persistence.ts", import.meta.url))],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  logLevel: "silent",
});
const {
  CoalescedSettingsSaveQueue,
  fillMissingLegacyPluginSettings,
  mergeSettingsChangeSet,
  normalizeExternalCalendarsInPlace,
} = await import(`data:text/javascript;base64,${Buffer.from(settingsPersistenceBundle.outputFiles[0].text).toString("base64")}`);

test("external calendar normalization preserves live settings-editor references across every keystroke", () => {
  const capturedCalendar = { id: "calendar-a", url: "", enabled: true };
  const capturedCalendars = [capturedCalendar];

  for (const value of ["h", "ht", "htt", "http", "https://calendar.example/feed.ics"]) {
    capturedCalendar.url = value;
    const normalized = normalizeExternalCalendarsInPlace(capturedCalendars, (path) => path.trim());
    assert.strictEqual(normalized, capturedCalendars);
    assert.strictEqual(normalized[0], capturedCalendar);
    assert.equal(normalized[0].url, value);
  }
});

test("external calendar normalization preserves settings-editor reorder and delete operations", () => {
  const first = { id: "first", url: "first.ics" };
  const second = { id: "second", url: "second.ics" };
  const third = { id: "third", url: "third.ics" };
  const capturedCalendars = [first, second, third];

  [capturedCalendars[0], capturedCalendars[2]] = [capturedCalendars[2], capturedCalendars[0]];
  normalizeExternalCalendarsInPlace(capturedCalendars, (path) => path);
  assert.deepEqual(capturedCalendars.map((calendar) => calendar.id), ["third", "second", "first"]);
  assert.strictEqual(capturedCalendars[0], third);

  capturedCalendars.splice(1, 1);
  normalizeExternalCalendarsInPlace(capturedCalendars, (path) => path);
  assert.deepEqual(capturedCalendars.map((calendar) => calendar.id), ["third", "first"]);
  assert.strictEqual(capturedCalendars[1], first);
});

test("legacy plugin migration fills only keys absent from the raw Controller payload", () => {
  const settings = {
    pollMinutes: 0,
    enableLogging: false,
    globalIgnoreTags: [],
    archiveFolder: "",
    externalCalendars: [],
  };
  const rawControllerSettings = {
    pollMinutes: 0,
    enableLogging: false,
    globalIgnoreTags: [],
    archiveFolder: "",
    externalCalendars: [],
  };
  const migratedFields = fillMissingLegacyPluginSettings(
    settings,
    rawControllerSettings,
    {
      pollMinutes: 15,
      enableLogging: true,
      ignoreTags: ["legacy-tag"],
      snoozeProperty: "legacySnooze",
    },
    {
      archiveFolder: "Legacy Archive",
      externalCalendars: [{ id: "legacy" }],
      uidKey: "legacyUid",
    },
  );

  assert.equal(migratedFields, 2);
  assert.equal(settings.pollMinutes, 0);
  assert.equal(settings.enableLogging, false);
  assert.deepEqual(settings.globalIgnoreTags, []);
  assert.equal(settings.archiveFolder, "");
  assert.deepEqual(settings.externalCalendars, []);
  assert.equal(settings.snoozeProperty, "legacySnooze");
  assert.equal(settings.uidKey, "legacyUid");
});

test("Controller settings persistence changes only local keys in the newest payload", () => {
  const merged = mergeSettingsChangeSet(
    { pollMinutes: 30, archiveFolder: "Synced Archive", futureField: { keep: true } },
    { pollMinutes: 15, archiveFolder: "Stale Archive", enableLogging: false },
    ["pollMinutes", "enableLogging"],
  );

  assert.deepEqual(merged, {
    pollMinutes: 15,
    archiveFolder: "Synced Archive",
    futureField: { keep: true },
    enableLogging: false,
  });
  assert.throws(() => mergeSettingsChangeSet([], {}, []), /must be an object/);
});

test("an uncertain Controller write forces a same-as-baseline revert on retry", () => {
  let disk = { value: "old", synchronized: "keep" };
  // Model a filesystem/provider error reported after the first payload landed.
  disk = mergeSettingsChangeSet(disk, { value: "new", synchronized: "keep" }, ["value"]);
  const retried = mergeSettingsChangeSet(
    disk,
    { value: "old", synchronized: "stale" },
    ["value"],
  );
  assert.deepEqual(retried, { value: "old", synchronized: "keep" });
  assert.match(mainSource, /uncertainSettingsSaveKeys/);
  assert.match(mainSource, /for \(const key of snapshot\.changedKeys\) this\.uncertainSettingsSaveKeys\.add\(key\)/);
});

test("settings save queue persists follow-up edits and unload waits without enqueueing stale state", async () => {
  let releaseFirstSave;
  const firstSaveGate = new Promise((resolve) => {
    releaseFirstSave = resolve;
  });
  let markFirstStarted;
  const firstStarted = new Promise((resolve) => {
    markFirstStarted = resolve;
  });
  let currentValue = "first";
  const persisted = [];
  let captureCount = 0;
  const queue = new CoalescedSettingsSaveQueue(
    () => {
      captureCount += 1;
      return currentValue;
    },
    async (snapshot) => {
      persisted.push(snapshot);
      if (snapshot === "first") {
        markFirstStarted();
        await firstSaveGate;
      }
    },
  );

  const firstRequest = queue.requestSave();
  await firstStarted;
  currentValue = "second";
  const secondRequest = queue.requestSave();
  assert.strictEqual(secondRequest, firstRequest);
  releaseFirstSave();
  await Promise.all([firstRequest, secondRequest]);

  assert.deepEqual(persisted, ["first", "second"]);
  assert.equal(captureCount, 2);

  currentValue = "stale-unrequested-unload-state";
  await queue.waitForIdle();
  assert.deepEqual(persisted, ["first", "second"]);
  assert.equal(captureCount, 2);
});

test("a newer Controller settings request supersedes a failed in-flight write", async () => {
  let releaseFirstSave;
  const firstSaveGate = new Promise((resolve) => {
    releaseFirstSave = resolve;
  });
  let markFirstStarted;
  const firstStarted = new Promise((resolve) => {
    markFirstStarted = resolve;
  });
  let currentValue = "first";
  const persisted = [];
  const queue = new CoalescedSettingsSaveQueue(
    () => currentValue,
    async (snapshot) => {
      if (snapshot === "first") {
        markFirstStarted();
        await firstSaveGate;
        throw new Error("first write failed");
      }
      persisted.push(snapshot);
    },
  );

  const firstRequest = queue.requestSave();
  await firstStarted;
  currentValue = "newest";
  const newestRequest = queue.requestSave();
  releaseFirstSave();
  await Promise.all([firstRequest, newestRequest]);

  assert.deepEqual(persisted, ["newest"]);
});

test("a Controller request queued at drain completion starts a new durable drain", async () => {
  let currentValue = "first";
  let completionWindowRequest;
  const persisted = [];
  let queue;
  queue = new CoalescedSettingsSaveQueue(
    () => currentValue,
    async (snapshot) => {
      persisted.push(snapshot);
      if (snapshot === "first") {
        queueMicrotask(() => queueMicrotask(() => {
          currentValue = "newest";
          completionWindowRequest = queue.requestSave();
        }));
      }
    },
  );

  await queue.requestSave();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await completionWindowRequest;

  assert.deepEqual(persisted, ["first", "newest"]);
  await queue.waitForIdle();
});

test("Controller settings integration awaits saves and unload only drains requested writes", () => {
  const unloadSource = mainSource.slice(
    mainSource.indexOf("async onunload()"),
    mainSource.indexOf("// Settings"),
  );
  assert.match(mainSource, /normalizeExternalCalendarsInPlace\(/);
  assert.match(mainSource, /migrateSettingsFromPlugins\(this\.app, this\.settings, data,/);
  assert.match(unloadSource, /settingsSaveQueue\.waitForIdle\(\)/);
  assert.doesNotMatch(unloadSource, /this\.saveSettings\(\)/);
  assert.doesNotMatch(settingsTabSource, /\bdebouncedSave\b/);
  assert.doesNotMatch(settingsTabSource, /import\s*\{[^}]*\bdebounce\b/);
});

test("Controller settings use one routed page with an explicit five-destination hub", () => {
  const displaySource = settingsTabSource.slice(
    settingsTabSource.indexOf("display(): void"),
    settingsTabSource.indexOf("// Helpers"),
  );
  const reminderPageSource = settingsTabSource.slice(
    settingsTabSource.indexOf("private renderReminderSettingsPage"),
    settingsTabSource.indexOf("private createDefaultReminder"),
  );
  const calendarEditorStart = settingsTabSource.indexOf("private renderExternalCalendars");
  const calendarEditorSource = settingsTabSource.slice(
    calendarEditorStart,
    settingsTabSource.indexOf("renderSnoozeOptions(container", calendarEditorStart),
  );

  assert.match(settingsTabSource, /private activePage: ControllerSettingsPage = 'overview'/);
  assert.match(settingsTabSource, /private activeAutomation: ControllerAutomationPage = 'archive'/);
  assert.match(settingsTabSource, /Choose what to configure/);
  assert.match(settingsTabSource, /setAttr\('aria-pressed', String\(this\.activePage === destination\.id\)\)/);
  for (const destination of ["Overview", "Calendar rules", "Reminder rules", "Automations", "Advanced"]) {
    assert.match(settingsTabSource, new RegExp(`label: '${destination}'`));
  }
  assert.equal((settingsTabSource.match(/\{ id: '(?:overview|calendar|reminders|automations|advanced)'/g) || []).length, 5);
  assert.doesNotMatch(displaySource, /createEl\(['"]details['"]/);
  assert.match(settingsTabSource, /createEl\('details', \{ cls: 'tps-controller-reminder-rule' \}\)/);
  assert.match(settingsTabSource, /private navigateToPage[\s\S]*heading\?\.focus\(\{ preventScroll: false \}\)/);
  assert.match(settingsTabSource, /private redisplayPreservingScroll\(focusSelector\?: string\)[\s\S]*this\.containerEl\.scrollTop = scrollTop[\s\S]*focus\(\{ preventScroll: true \}\)/);

  for (const shortcut of ["Open calendar rules", "Open reminder rules", "Open automations"]) {
    assert.match(settingsTabSource, new RegExp(`'${shortcut}'`));
  }

  assert.ok(
    displaySource.indexOf(".setName('Calendar actions')") < displaySource.indexOf("this.renderExternalCalendars(calendarsContainer)"),
    "calendar actions should render before feed cards",
  );
  assert.match(calendarEditorSource, /this\.selectedCalendarId !== calendar\.id\) return/);
  assert.match(calendarEditorSource, /toggle\.setAttr\('aria-label', `Enable \$\{this\.buildCalendarDisplayName/);
  assert.match(calendarEditorSource, /configureBtn\.setAttr\('aria-expanded'/);
  assert.match(calendarEditorSource, /configureBtn\.setAttr\('aria-controls', editorId\)/);
  assert.match(calendarEditorSource, /configureBtn\.dataset\.calendarAction = 'configure'/);
  assert.match(calendarEditorSource, /editor\.id = editorId/);
  assert.match(calendarEditorSource, /drop\.selectEl\.dataset\.calendarAction = 'create-mode'/);
  assert.match(calendarEditorSource, /focusCalendarControl\(container, calendarId, 'configure'\)/);
  assert.match(calendarEditorSource, /save\(true, \{ calendarId, action: 'create-mode' \}\)/);
  assert.match(calendarEditorSource, /nextCalendarId[\s\S]*focusCalendarControl\(container, nextCalendarId, 'configure'\)/);
  assert.match(calendarEditorSource, /if \(\(calendar\.autoCreateMode \|\| "note"\) === "task"\)/);
  assert.match(calendarEditorSource, /\} else \{\s*new Setting\(acContent\)\s*\.setName\("Type Folder"\)/);
  assert.match(calendarEditorSource, /if \(\(calendar\.autoCreateMode \|\| "note"\) === "note"\) \{\s*new Setting\(acContent\)\s*\.setName\("Template"\)/);

  assert.ok(
    reminderPageSource.indexOf(".setName('Rule actions')") < reminderPageSource.indexOf("this.renderReminderRules(rulesContainer)"),
    "reminder actions should render before the rule list",
  );
  assert.ok(
    reminderPageSource.indexOf("this.renderReminderRules(rulesContainer)") < reminderPageSource.indexOf("'Reminder defaults'"),
    "the rule list should render before shared defaults",
  );
  const disabledCallout = reminderPageSource.indexOf('Reminder evaluation is off');
  const ruleActions = reminderPageSource.indexOf(".setName('Rule actions')");
  const ruleList = reminderPageSource.indexOf('this.renderReminderRules(rulesContainer)');
  const reminderDefaults = reminderPageSource.indexOf("'Reminder defaults'");
  assert.ok(disabledCallout >= 0);
  assert.ok(ruleActions > disabledCallout, 'rule actions should remain reachable while reminder evaluation is off');
  assert.ok(ruleList > ruleActions, 'the rule list should remain reachable while reminder evaluation is off');
  assert.ok(reminderDefaults > ruleList, 'shared defaults should remain reachable while reminder evaluation is off');
  assert.doesNotMatch(reminderPageSource.slice(disabledCallout, ruleActions), /\}\s*else\s*\{/);
  assert.ok(
    reminderPageSource.indexOf("'Snooze defaults'") > disabledCallout,
    "snooze defaults should remain reachable after the disabled-reminders branch",
  );
  assert.match(reminderPageSource, /if \(presetSummary\) this\.renderRecommendedReminderSummary\(presetSummary\)/);

  assert.match(displaySource, /this\.renderAutomationSelector\(containerEl\)/);
  assert.match(displaySource, /if \(this\.activeAutomation === 'archive'\)/);
  assert.match(displaySource, /if \(this\.activeAutomation === 'attachments'\)/);
  assert.match(settingsTabSource, /role', 'group'/);
  assert.match(settingsTabSource, /aria-label', 'Controller settings pages'/);
  assert.match(settingsTabSource, /data-automation/);
  assert.match(settingsStylesSource, /\.tps-settings-destination-hub \{[\s\S]*position: sticky/);
  assert.match(settingsStylesSource, /\.tps-settings-inline-selector-button\[aria-pressed="true"\]/);
  assert.match(settingsStylesSource, /\.tps-settings-destination-button:focus-visible/);
  assert.match(settingsStylesSource, /\.tps-settings-destination-button \{[\s\S]*\n  height: auto;/);
  assert.match(settingsStylesSource, /@media \(max-width: 900px\)[\s\S]*grid-template-columns: repeat\(5, minmax\(132px, 1fr\)\)[\s\S]*overflow-x: auto/);
  assert.match(settingsStylesSource, /@media \(max-width: 520px\)[\s\S]*\.tps-settings-destination-description \{[\s\S]*display: none/);
});

test("local User-device notices are explicit, default-off, and restart their active-instance loop", () => {
  const reminderPageSource = settingsTabSource.slice(
    settingsTabSource.indexOf("private renderReminderSettingsPage"),
    settingsTabSource.indexOf("private renderReminderRules"),
  );
  const localNoticeSetting = reminderPageSource.indexOf(".setName('Local Notices on User Devices')");
  const deliverySection = reminderPageSource.indexOf("'Delivery'");
  const reminderDefaults = reminderPageSource.indexOf("'Reminder defaults'");
  const sortDirection = reminderPageSource.indexOf(".setName('Notification Sort Direction')");

  assert.ok(localNoticeSetting > deliverySection);
  assert.ok(localNoticeSetting < reminderDefaults);
  assert.ok(localNoticeSetting < sortDirection);
  assert.match(
    reminderPageSource,
    /This does not use TPS Messager and cannot notify while Obsidian is closed\./,
  );
  assert.match(
    reminderPageSource,
    /setValue\(this\.plugin\.settings\.enableLocalReminderNoticesOnUserDevices === true\)/,
  );
  assert.match(
    reminderPageSource,
    /this\.plugin\.settings\.enableLocalReminderNoticesOnUserDevices = value;[\s\S]*await this\.plugin\.saveSettings\(\);[\s\S]*this\.plugin\.restartReminderLoop\(\)/,
  );
  assert.match(
    reminderPageSource,
    /this\.plugin\.settings\.enableReminders = value;[\s\S]*await this\.plugin\.saveSettings\(\);[\s\S]*this\.plugin\.restartReminderLoop\(\)/,
  );
  assert.match(
    reminderPageSource,
    /this\.plugin\.settings\.pollMinutes = value;[\s\S]*await this\.plugin\.saveSettings\(\);[\s\S]*this\.plugin\.restartReminderLoop\(\)/,
  );
  assert.match(
    settingsTabSource,
    /rem\.enabled = value;[\s\S]*await this\.plugin\.saveSettings\(\);[\s\S]*this\.plugin\.restartReminderLoop\(\)/,
  );
  assert.match(
    settingsTabSource,
    /rem\.repeatIntervalMinutes = num;[\s\S]*await this\.plugin\.saveSettings\(\);[\s\S]*this\.plugin\.restartReminderLoop\(\)/,
  );
  assert.match(settingsTabSource, /optional local reminder notices can run when Obsidian is open/);
  assert.match(settingsTabSource, /await this\.plugin\.resetReminderDeliveryState\(\)/);
});

test("TishOS notification settings handoff is explicit, scoped, and non-mutating", () => {
  const reminderPageSource = settingsTabSource.slice(
    settingsTabSource.indexOf("private renderReminderSettingsPage"),
    settingsTabSource.indexOf("private renderReminderRules"),
  );

  assert.match(reminderPageSource, /'Delivery'/);
  assert.match(reminderPageSource, /\.setName\('Apple Native Notifications'\)/);
  assert.match(reminderPageSource, /enabling both delivery routes can produce two alerts/);
  assert.match(reminderPageSource, /this\.plugin\.openTishOSNativeNotificationSettings\(\)/);
  assert.match(mainSource, /tishos:\/\/settings\?section=native-notifications/);
  assert.match(mainSource, /registerObsidianProtocolHandler\('tps-controller-settings'/);
  assert.match(mainSource, /params\.action !== 'tps-controller-settings'/);
  assert.match(mainSource, /params\.v !== '1'/);
  assert.match(mainSource, /params\.section !== 'reminders'/);
  assert.match(mainSource, /params\.targetVault !== this\.app\.vault\.getName\(\)/);
  assert.match(mainSource, /this\.openSettingsPage\('reminders'\)/);
  assert.match(mainSource, /settingManager\.openTabById\(this\.manifest\.id\)/);
  assert.doesNotMatch(
    mainSource.slice(
      mainSource.indexOf("registerObsidianProtocolHandler('tps-controller'"),
      mainSource.indexOf('this.startS3agleAttachmentAutomation()'),
    ),
    /saveSettings\(|enableReminders\s*=|enableLocalReminderNoticesOnUserDevices\s*=/,
  );
});

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
