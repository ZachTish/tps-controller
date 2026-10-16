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
const twoStageArchiveSource = await readFile(
  fileURLToPath(new URL("../src/services/two-stage-archive-service.ts", import.meta.url)),
  "utf8",
);
const overdueServiceSource = await readFile(
  fileURLToPath(new URL("../src/services/overdue-service.ts", import.meta.url)),
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
  mergeSettingsChangeSet,
} = await import(`data:text/javascript;base64,${Buffer.from(settingsPersistenceBundle.outputFiles[0].text).toString("base64")}`);

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

  const cancellationState = { "calendar:v1:source:event": { appliedStatus: "cancelled" } };
  assert.deepEqual(
    mergeSettingsChangeSet(
      { synchronized: "newer", nativeCalendarCancellationState: {} },
      { synchronized: "stale", nativeCalendarCancellationState: cancellationState },
      ["nativeCalendarCancellationState"],
    ),
    { synchronized: "newer", nativeCalendarCancellationState: cancellationState },
  );
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
    mainSource.indexOf("async loadSettings()"),
  );
  assert.doesNotMatch(mainSource, /normalizeExternalCalendarsInPlace\(/);
  assert.doesNotMatch(mainSource, /migrateSettingsFromPlugins/);
  assert.match(unloadSource, /settingsSaveQueue\.waitForIdle\(\)/);
  assert.doesNotMatch(unloadSource, /this\.saveSettings\(\)/);
  assert.doesNotMatch(settingsTabSource, /\bdebouncedSave\b/);
  assert.doesNotMatch(settingsTabSource, /import\s*\{[^}]*\bdebounce\b/);
});
test('Controller settings keep accessible routes and retirement information', () => {
for(const label of ['Overview','Connections','Calendar rules','Note rules','Reminders','Automations','Advanced'])assert.ok(settingsTabSource.includes("label: '"+label+"'"),label);
assert.match(settingsTabSource,/aria-pressed/);assert.match(settingsTabSource,/navigateToPage/);assert.match(settingsTabSource,/Reminders retired/);
assert.doesNotMatch(settingsTabSource,/renderReminderRules|Enable Reminders/);
});


test("TishOS notification settings handoff is explicit, scoped, and non-mutating", () => {
  assert.match(mainSource, /registerObsidianProtocolHandler\('tps-controller-settings'/);
  assert.match(mainSource, /params\.action !== 'tps-controller-settings'/);
  assert.match(mainSource, /params\.v !== '1'/);
  assert.match(mainSource, /params\.section !== 'reminders'/);
  assert.match(mainSource, /!portableVaultNamesMatch\(params\.targetVault, this\.app\.vault\.getName\(\)\)/);
  assert.match(mainSource, /this\.openSettingsPage\('reminders'\)/);
  assert.match(mainSource, /settingManager\.openTabById\(this\.manifest\.id\)/);
  assert.doesNotMatch(
    mainSource.slice(
      mainSource.indexOf("registerObsidianProtocolHandler('tps-controller'"),
      mainSource.indexOf('    async onunload()'),
    ),
    /saveSettings\(|enableReminders\s*=|notificationDeliveryProvider\s*=/,
  );
});

test("command palette only exposes controller actions that are user-facing and complete", () => {
  for (const id of [
    "run-two-stage-archive-now",
    "open-notifications",
  ]) {
    assert.match(mainSource, new RegExp(`id: "${id}"`));
  }

  for (const id of [
    "force-calendar-sync",
    "force-reminder-check",
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
  assert.match(mainSource, /two-stage-archive:manual-result/);
});

test("Controller has no automatic reload command or preference control", () => {
  assert.doesNotMatch(mainSource, /PeriodicReload|PeriodicControllerReload|app:reload|window\.location\.reload/);
  assert.doesNotMatch(settingsTabSource, /Reload Controller every 15 minutes/);
});

test("controller logging records settings causes and concise runtime outcomes", () => {
  assert.match(mainSource, /persistedSettingsSnapshot/);
  assert.match(mainSource, /getChangedSettingKeys/);
  assert.match(mainSource, /logger\.flow\("Settings", "save:start"/);
  assert.match(mainSource, /logger\.flow\("Settings", "save:done"/);
  assert.doesNotMatch(mainSource, /ParentChildMaintenance/);
});

test("explicit archive logging records inputs and outcomes", () => {
  assert.doesNotMatch(twoStageArchiveSource, /due:checked|runIfDue/);
  assert.match(twoStageArchiveSource, /logger\.flow\("TwoStageArchive", "run:resolved"/);
  assert.match(twoStageArchiveSource, /logger\.flow\("TwoStageArchive", "run:candidates"/);
  assert.match(twoStageArchiveSource, /logger\.flow\("TwoStageArchive", "run:done"/);
  assert.match(twoStageArchiveSource, /logger\.flow\("TwoStageArchive", "target:collision-resolved"/);
});

test("notification and overdue action logging records scan and mutation routes", () => {
  assert.match(overdueServiceSource, /logger\.flow\("NotificationView", "open:start"/);
  assert.match(overdueServiceSource, /logger\.flow\("OverdueItems", "scan:done"/);
  assert.match(overdueServiceSource, /logger\.flow\("OverdueAction", "status:set-start"/);
  assert.doesNotMatch(overdueServiceSource, /route: "task-line"/);
  assert.match(overdueServiceSource, /route: "gcm-set-status"/);
  assert.match(overdueServiceSource, /logger\.flow\("OverdueAction", "snooze:done"/);
  assert.match(overdueServiceSource, /logger\.flow\("OverdueAction", "resolve-reminder:done"/);
  assert.match(overdueServiceSource, /logger\.flowWarn\("OverdueAction", "task-line:status-disabled"/);
  assert.match(overdueServiceSource, /logger\.flowWarn\("OverdueAction", "task-line:snooze-disabled"/);
  assert.match(overdueServiceSource, /logger\.flowWarn\("OverdueAction", "task-line:resolve-disabled"/);
  assert.match(overdueServiceSource, /logger\.flow\("OverdueAction", "open-file:route"/);
});
