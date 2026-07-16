import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../src/tps-contracts.ts', import.meta.url), 'utf8');

function hasExportedValue(key, value) {
  const pattern = new RegExp(`${key}:\\s*["']${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`);
  return pattern.test(source);
}

test('shared TPS contract exports stable namespaced events', () => {
  assert.equal(hasExportedValue('CONTROLLER_SETTINGS_CHANGED', 'tps:controller-settings-changed'), true);
  assert.equal(hasExportedValue('CALENDAR_SYNC_COMPLETED', 'tps:calendar-sync-completed'), true);
  assert.equal(hasExportedValue('FILES_UPDATED', 'tps:files-updated'), true);
  assert.equal(hasExportedValue('GCM_EXPLICIT_ACTION', 'tps:gcm-explicit-action'), true);
  assert.equal(hasExportedValue('CALENDAR_EXPLICIT_REFRESH', 'tps:calendar-explicit-refresh'), true);
});

test('shared TPS contract keeps legacy aliases for migration', () => {
  assert.equal(hasExportedValue('GCM_FILES_UPDATED', 'tps-gcm-files-updated'), true);
  assert.equal(hasExportedValue('GCM_EXPLICIT_ACTION', 'tps-gcm-explicit-action'), true);
  assert.equal(hasExportedValue('CALENDAR_SETTINGS_CHANGED', 'tps-calendar-settings-changed'), true);
  assert.equal(hasExportedValue('CALENDAR_EXPLICIT_REFRESH', 'tps-calendar-explicit-refresh'), true);
});

test('shared notifier API includes non-sending dry-run preparation', () => {
  assert.match(source, /dryRunMessage\?: \(text: string, file\?: unknown, title\?: string\) => unknown/);
});
