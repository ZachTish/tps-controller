import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/services/reminder-delivery-status.ts', import.meta.url))],
  bundle: true,
  platform: 'browser',
  format: 'esm',
  write: false,
  logLevel: 'silent',
});
const { buildReminderDeliveryStatusText } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
);

const [settingsSource, viewSource, stylesSource] = await Promise.all([
  readFile(new URL('../src/settings-tab.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/views/notification-view.ts', import.meta.url), 'utf8'),
  readFile(new URL('../styles-ui.css', import.meta.url), 'utf8'),
]);

const publishedAt = '2026-09-10T14:03:05.000Z';
const client = (changes = {}) => ({
  device: 'QA MacBook',
  nativeNotificationState: 'ready',
  nativeNotificationItemCount: 128,
  nativeNotificationPublishedAt: publishedAt,
  nativeNotificationReason: null,
  ...changes,
});
const status = (changes = {}) => ({
  remindersEnabled: true,
  notificationDeliveryProvider: 'tishos',
  localDeliveryMode: null,
  tishOSNativeNotificationsSupported: true,
  commandBridge: { available: true, clients: [client()] },
  ...changes,
});

test('verified reminder delivery notice retains each device, item count, and publication time', () => {
  assert.equal(
    buildReminderDeliveryStatusText(status()),
    `Verified local TishOS schedule · QA MacBook: 128 items, updated ${new Date(publishedAt).toLocaleString()}.`,
  );
  const text = buildReminderDeliveryStatusText(status({
    commandBridge: {
      available: true,
      clients: [client({ nativeNotificationItemCount: 1 }), client({ device: 'QA iPad', nativeNotificationItemCount: 0 })],
    },
  }));
  assert.match(text, /^Verified local TishOS schedules ·/);
  assert.match(text, /QA MacBook: 1 item, updated/);
  assert.match(text, /QA iPad: 0 items, updated/);
  assert.doesNotMatch(text, /1 items/);
});

test('pending delivery remains pending and preserves the last verified publication', () => {
  const text = buildReminderDeliveryStatusText(status({
    commandBridge: {
      available: true,
      clients: [client({ nativeNotificationState: 'pending', nativeNotificationReason: 'metadata-index-not-ready' })],
    },
  }));
  assert.match(text, /^Local TishOS schedule pending · QA MacBook: metadata-index-not-ready/);
  assert.ok(text.includes(`last verified 128 items at ${new Date(publishedAt).toLocaleString()}`));
  assert.doesNotMatch(text, /^Verified local/);
});

test('pending delivery without prior verification never claims a verified empty schedule', () => {
  const text = buildReminderDeliveryStatusText(status({
    commandBridge: {
      available: true,
      clients: [client({
        nativeNotificationState: 'pending',
        nativeNotificationItemCount: null,
        nativeNotificationPublishedAt: null,
      })],
    },
  }));
  assert.match(text, /^Local TishOS schedule pending · QA MacBook: awaiting-refresh/);
  assert.doesNotMatch(text, /last verified|0 items|Invalid Date/);
});

test('disabled reminders override any old verified publication and provider route', () => {
  assert.equal(
    buildReminderDeliveryStatusText(status({ remindersEnabled: false, localDeliveryMode: 'local-obsidian' })),
    'Reminder delivery is off. No reminder is being published.',
  );
});

test('local Obsidian fallback describes its open-app delivery behavior', () => {
  const text = buildReminderDeliveryStatusText(status({
    localDeliveryMode: 'local-obsidian',
    tishOSNativeNotificationsSupported: false,
  }));
  assert.match(text, /TishOS is unavailable on this platform/);
  assert.match(text, /Local Obsidian notices are active while Obsidian is open/);
  assert.doesNotMatch(text, /Verified local TishOS/);
});

test('ntfy notices describe the current device route without referring to notification rows', () => {
  const desktop = buildReminderDeliveryStatusText(status({ notificationDeliveryProvider: 'ntfy', localDeliveryMode: 'ntfy' }));
  assert.match(desktop, /ntfy is selected/);
  assert.match(desktop, /TishOS receives an empty schedule/);
  assert.match(desktop, /desktop Controller/);
  const otherDevice = buildReminderDeliveryStatusText(status({ notificationDeliveryProvider: 'ntfy' }));
  assert.match(otherDevice, /ntfy delivery does not run on this mobile\/User device/);
  assert.doesNotMatch(`${desktop} ${otherDevice}`, /rows below|Verified local TishOS/);
});

test('unavailable pairing state and an unpaired device remain distinct', () => {
  assert.match(
    buildReminderDeliveryStatusText(status({ commandBridge: { available: false, clients: [] } })),
    /pairing state could not be read/,
  );
  assert.match(
    buildReminderDeliveryStatusText(status({ commandBridge: { available: true, clients: [] } })),
    /this Obsidian device is not paired with TishOS/,
  );
});

test('delivery diagnostics appear above reminder settings and are absent from the notification view', () => {
  const page = settingsSource.slice(
    settingsSource.indexOf('private renderReminderSettingsPage'),
    settingsSource.indexOf('private renderReminderRules'),
  );
  const notice = page.indexOf('this.renderReminderDeliveryNotice(container)');
  assert.ok(notice >= 0 && notice < page.indexOf("'Rules'"), 'delivery notice should precede the Rules section');
  const renderer = settingsSource.slice(
    settingsSource.indexOf('private renderReminderDeliveryNotice'),
    settingsSource.indexOf('private renderReminderSettingsPage'),
  );
  assert.match(renderer, /buildReminderDeliveryStatusText\(this\.plugin\.getReminderDeliveryAuditStatus\(\)\)/);
  assert.match(renderer, /role: 'status'/);
  assert.match(renderer, /'aria-live': 'polite'/);
  assert.ok(/\.tps-controller-reminder-delivery-status\s*\{[^}]*overflow-wrap:\s*anywhere/s.test(stylesSource));
  assert.ok(!/deliveryAuditStatus|buildDeliveryStatusText|tps-notification-delivery-status|getReminderDeliveryAuditStatus/.test(viewSource));
  assert.ok(/const nextSignature = buildNotificationItemsSignature\(nextItems\);/.test(viewSource));
});

test('settings status polling is read-only and clears when hiding or rerendering settings', () => {
  const hide = settingsSource.slice(settingsSource.indexOf('hide(): void'), settingsSource.indexOf('display(): void'));
  const display = settingsSource.slice(settingsSource.indexOf('display(): void'), settingsSource.indexOf("containerEl.createEl('h2'"));
  assert.match(hide, /clearInterval\(this\.reminderDeliveryStatusTimer\)/);
  assert.match(hide, /this\.reminderDeliveryStatusTimer = null/);
  assert.match(display, /this\.hide\(\)/);
  const notice = settingsSource.slice(
    settingsSource.indexOf('private renderReminderDeliveryNotice'),
    settingsSource.indexOf('private renderReminderSettingsPage'),
  );
  assert.match(notice, /setInterval\([^;]*30_?000\)/s);
  assert.doesNotMatch(notice, /saveSettings\(|refreshTishOSCommandBridgeCatalogs\(|runReminderCheck\(|\.display\(/);
});
