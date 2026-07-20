import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const mainSource = await readFile(
  fileURLToPath(new URL("../src/main.ts", import.meta.url)),
  "utf8",
);
const settingsSource = await readFile(
  fileURLToPath(new URL("../src/settings-tab.ts", import.meta.url)),
  "utf8",
);

function methodBody(name, nextName) {
  const start = mainSource.indexOf(name);
  const end = mainSource.indexOf(nextName, start + name.length);
  assert.notEqual(start, -1, `${name} must exist`);
  assert.notEqual(end, -1, `${nextName} must follow ${name}`);
  return mainSource.slice(start, end);
}

test("Controller owns the generated Notifier client lifecycle", () => {
  assert.match(mainSource, /new TPSNotifierClient<TFile>\(this\.app, this\.manifest\.id\)/);
  assert.match(mainSource, /this\.notifierClient\.start\(\(eventRef\) => this\.registerEvent\(eventRef\)\)/);
  assert.match(mainSource, /async onunload\(\)[\s\S]*?this\.notifierClient\?\.dispose\(\)/);
  assert.match(mainSource, /async onunload\(\)[\s\S]*?this\.notifierDeliveryLedger\?\.close\(\)/);
  assert.match(mainSource, /try \{\s*notifierStorage = window\.localStorage/);
  assert.match(mainSource, /new NotifierDeliveryLedger\([\s\S]*?this\.getTimeTrackingReminderStateStorageKey\(\)/);
});

test("hourly checks are single-flight and contain their own failures", () => {
  const wrapper = methodBody(
    "private runTimeTrackingReminderCheck(): Promise<void>",
    "private async performTimeTrackingReminderCheck(expectedEpoch: number): Promise<void>",
  );
  assert.match(wrapper, /if \(this\.timeTrackingReminderCheckPromise\) return this\.timeTrackingReminderCheckPromise/);
  assert.match(wrapper, /this\.performTimeTrackingReminderCheck\(expectedEpoch\)/);
  assert.match(wrapper, /\.catch\(\(error\) => logger\.flowError/);
  assert.match(wrapper, /this\.timeTrackingReminderCheckPromise = null/);
});

test("hourly delivery uses the durable coordinator and no private Notifier lookup or route fallback", () => {
  const hourly = methodBody(
    "private async performTimeTrackingReminderCheck(expectedEpoch: number): Promise<void>",
    "private parseTimeTrackingSessionDate(value: string): Date | null",
  );
  assert.match(hourly, /this\.notifierDeliveryLedger\.pruneResolvedBefore\(cutoff\)/);
  assert.match(hourly, /this\.notifierDeliveryLedger\.getRecord\(dedupeKey\)/);
  assert.match(hourly, /withOperationDeadline\(/);
  assert.match(hourly, /expectedEpoch !== this\.timeTrackingReminderEpoch/);
  assert.match(hourly, /const dedupeKey = `v2:\$\{encodeURIComponent\(session\.id\)\}:\$\{epochHour\}`/);
  assert.match(hourly, /existingRecord && existingRecord\.state !== "not-attempted"/);
  assert.match(hourly, /this\.notifierDeliveryCoordinator\.deliver\(dedupeKey,[\s\S]*?retryNotAttempted: true/);
  assert.doesNotMatch(hourly, /getNotifierPlugin/);
  assert.doesNotMatch(hourly, /sendNotification|sendMessage/);
  assert.doesNotMatch(hourly, /localStorage/);
  assert.doesNotMatch(hourly, /vault\.(?:modify|process|create|delete|rename)/);
  assert.doesNotMatch(mainSource, /loadTimeTrackingReminderState|persistTimeTrackingReminderState/);
});

test("general reminders remain deliberately isolated on the unresolved legacy delivery path", () => {
  const reminder = methodBody(
    "private async runReminderCheck(): Promise<void>",
    "private buildReminderNotificationBatches(",
  );
  assert.match(reminder, /const notifier = this\.getNotifierPlugin\(\)/);
  assert.match(reminder, /restoreAlertStateAfterDeliveryFailure/);
  assert.doesNotMatch(reminder, /notifierDeliveryCoordinator/);
});

test("disabling hourly reminders invalidates in-flight pre-send work before settings persistence", () => {
  const toggleStart = settingsSource.indexOf(".setName('Hourly Time Tracking Reminders')");
  const toggleEnd = settingsSource.indexOf("if (!(this.plugin.settings.enableReminders", toggleStart);
  assert.notEqual(toggleStart, -1);
  assert.notEqual(toggleEnd, -1);
  const toggle = settingsSource.slice(toggleStart, toggleEnd);
  const assignment = toggle.indexOf("this.plugin.settings.enableTimeTrackingHourlyReminders = value");
  const invalidation = toggle.indexOf("this.plugin.restartTimeTrackingReminderLoop()");
  const persistence = toggle.indexOf("await this.plugin.saveSettings()");
  assert.ok(assignment >= 0 && invalidation > assignment && persistence > invalidation);
  assert.match(mainSource, /private stopTimeTrackingReminderLoop\(\): void \{\s*this\.timeTrackingReminderEpoch \+= 1/);
});

test("hourly automation remains disabled on mobile and runtime ledger blocks are user-visible once", () => {
  assert.match(mainSource, /restartTimeTrackingReminderLoop\(\): void \{\s*if \(!Platform\.isMobile && this\.deviceRoleManager\.isController\(\)\)/);
  const startLoop = methodBody(
    "private startTimeTrackingReminderLoop(): void",
    "private stopTimeTrackingReminderLoop(): void",
  );
  assert.match(startLoop, /if \(Platform\.isMobile\) \{/);
  assert.match(mainSource, /private surfaceTimeTrackingReminderLedgerBlock\(\): void \{[\s\S]*?timeTrackingReminderLedgerWarningShown[\s\S]*?new Notice\(/);
  assert.match(mainSource, /if \(!this\.notifierDeliveryLedger\.ready\) this\.surfaceTimeTrackingReminderLedgerBlock\(\)/);
});
