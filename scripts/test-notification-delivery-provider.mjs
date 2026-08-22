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
const metadataReadiness = await importBundled("../src/services/metadata-index-readiness.ts");
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

test("provider migration uses TishOS for legacy mobile/User devices and preserves desktop Controller ntfy", () => {
  const migrate = ({ value, persisted, isMobile, role }) => providers.resolveNotificationDeliveryProvider(
    value,
    persisted,
    !isMobile && role === "controller",
  );

  assert.equal(migrate({ value: undefined, persisted: false, isMobile: false, role: "user" }), "tishos");
  assert.equal(migrate({ value: undefined, persisted: true, isMobile: true, role: "controller" }), "tishos");
  assert.equal(migrate({ value: undefined, persisted: true, isMobile: false, role: "user" }), "tishos");
  assert.equal(migrate({ value: undefined, persisted: true, isMobile: false, role: undefined }), "tishos");
  assert.equal(migrate({ value: undefined, persisted: true, isMobile: false, role: "controller" }), "ntfy");
  assert.equal(providers.resolveNotificationDeliveryProvider("tishos", true), "tishos");
  assert.equal(providers.resolveNotificationDeliveryProvider("ntfy", false), "ntfy");
  assert.equal(providers.resolveNotificationDeliveryProvider("invalid", true), "tishos");
});

test("layout readiness cannot substitute for a resolved or complete metadata snapshot", () => {
  const markdownFile = { path: "Inbox/Reminder.md" };
  const app = (files, cacheForFile) => ({
    workspace: { layoutReady: true },
    vault: { getMarkdownFiles: () => files },
    metadataCache: { getFileCache: cacheForFile },
  });

  assert.equal(
    metadataReadiness.hasCompleteMarkdownMetadataSnapshot(app([markdownFile], () => null)),
    false,
    "layoutReady=true with an unindexed Markdown file must remain blocked",
  );
  assert.equal(
    metadataReadiness.hasCompleteMarkdownMetadataSnapshot(app([markdownFile], () => ({}))),
    true,
    "an indexed metadata-free note has a non-null empty CachedMetadata object",
  );
  assert.equal(
    metadataReadiness.hasCompleteMarkdownMetadataSnapshot(app([], () => null)),
    false,
    "an empty early vault snapshot must not become a vacuous readiness proof",
  );
  assert.equal(
    metadataReadiness.hasCompleteMarkdownMetadataSnapshot(app(
      [markdownFile, { path: "Inbox/Still Indexing.md" }],
      (file) => file.path === markdownFile.path ? {} : null,
    )),
    false,
  );
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
  assert.match(mainSource, /!Platform\.isMobile[\s\S]*tps-device-role-[\s\S]*=== "controller"/);
  assert.match(mainSource, /notificationScheduleReadiness:[\s\S]*metadata-index-not-ready/);
  assert.match(mainSource, /scheduleTishOSNativeNotificationRefresh\("metadata-resolved"\)/);
  assert.doesNotMatch(mainSource, /metadataIndexResolved\s*=\s*this\.app\.workspace\.layoutReady/);
  assert.match(mainSource, /hasCompleteMarkdownMetadataSnapshot\(this\.app\)/);
  assert.ok(
    mainSource.indexOf('this.app.metadataCache.on("resolved"') < mainSource.indexOf("await this.loadSettings()"),
    "metadata readiness must be registered before asynchronous settings migration can yield",
  );
  assert.match(mainSource, /metadata-resolved-post-active/);
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
