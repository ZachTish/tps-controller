import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

async function importBundled(entryPoint) {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(entryPoint, import.meta.url))],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    logLevel: "silent",
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

const providers = await importBundled("../src/services/notification-delivery-provider.ts");
const policy = await importBundled("../src/services/reminder-runtime-policy.ts");
const mainSource = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");
const settingsSource = await readFile(new URL("../src/settings-tab.ts", import.meta.url), "utf8");
const typesSource = await readFile(new URL("../src/types.ts", import.meta.url), "utf8");

test("notification provider registry is explicit and extensible", () => {
  assert.deepEqual(
    providers.NOTIFICATION_DELIVERY_PROVIDERS.map(({ id, label }) => ({ id, label })),
    [
      { id: "tishos", label: "TishOS" },
      { id: "ntfy", label: "ntfy" },
    ],
  );
  assert.equal(providers.DEFAULT_NOTIFICATION_DELIVERY_PROVIDER, "tishos");
  assert.equal(providers.isNotificationDeliveryProvider("tishos"), true);
  assert.equal(providers.isNotificationDeliveryProvider("ntfy"), true);
  assert.equal(providers.isNotificationDeliveryProvider("none"), false);
});

test("provider migration preserves established ntfy installs and defaults fresh installs to TishOS", () => {
  assert.equal(providers.resolveNotificationDeliveryProvider(undefined, false), "tishos");
  assert.equal(providers.resolveNotificationDeliveryProvider(undefined, true), "ntfy");
  assert.equal(providers.resolveNotificationDeliveryProvider("tishos", true), "tishos");
  assert.equal(providers.resolveNotificationDeliveryProvider("ntfy", false), "ntfy");
  assert.equal(providers.resolveNotificationDeliveryProvider("invalid", true), "tishos");
});

test("only the selected direct provider can consume reminder state", () => {
  const resolve = (overrides = {}) => policy.resolveReminderDeliveryMode({
    enableReminders: true,
    notificationDeliveryProvider: "ntfy",
    isController: true,
    isMobile: false,
    ...overrides,
  });

  assert.equal(resolve(), "ntfy");
  assert.equal(resolve({ notificationDeliveryProvider: "tishos" }), null);
  assert.equal(resolve({ isController: false }), null);
  assert.equal(resolve({ isMobile: true }), null);
  assert.equal(resolve({ enableReminders: false }), null);
  assert.equal(resolve({ enableReminders: "true" }), null);
});

test("Controller persists one provider, gates both routes, and clears the retired TishOS schedule", () => {
  assert.match(typesSource, /notificationDeliveryProvider: NotificationDeliveryProvider/);
  assert.match(typesSource, /notificationDeliveryProvider: "tishos"/);
  assert.doesNotMatch(typesSource, /enableLocalReminderNoticesOnUserDevices/);
  assert.match(mainSource, /notificationScheduleProvider: \(\) => this\.settings\.notificationDeliveryProvider === "tishos"[\s\S]*Promise\.resolve\(\[\]\)/);
  assert.match(mainSource, /notificationDeliveryProvider === "tishos"[\s\S]*refreshCatalogs\("manual-reminder-check"\)/);
  assert.match(mainSource, /this\.settings\.notificationDeliveryProvider !== "ntfy"[\s\S]*TimeTrackingReminder/);
  assert.match(mainSource, /delete \(this\.settings as unknown as Record<string, unknown>\)\.enableLocalReminderNoticesOnUserDevices/);
});

test("Reminder settings expose a provider picker rather than competing delivery toggles", () => {
  const page = settingsSource.slice(
    settingsSource.indexOf("private renderReminderSettingsPage"),
    settingsSource.indexOf("private renderReminderRules"),
  );
  assert.match(page, /\.setName\('Notification Service'\)/);
  assert.match(page, /for \(const provider of NOTIFICATION_DELIVERY_PROVIDERS\)/);
  assert.match(page, /this\.plugin\.settings\.notificationDeliveryProvider = value/);
  assert.match(page, /await this\.plugin\.saveSettings\(\);[\s\S]*await this\.plugin\.refreshTishOSCommandBridgeCatalogs\(\);[\s\S]*restartReminderLoop\(\)/);
  assert.match(page, /selectedProvider\.id === 'tishos'/);
  assert.match(page, /selectedProvider\.id === 'ntfy'/);
  assert.doesNotMatch(page, /Local Notices on User Devices/);
  assert.doesNotMatch(page, /enabling both delivery routes/);
});
