import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const settings = readFileSync(new URL('../src/settings-tab.ts', import.meta.url), 'utf8');
test('calendar importer and vault sync-request transport have no executable owner', () => {
  assert.doesNotMatch(main, /CalendarAutomationService|NativeCalendarRecordService|AutoCreateService|SyncRequestService|runCalendarSync|requestSync|fulfillOneSyncRequest|startSyncRequestLoop|calendarSyncSettledAt/);
  assert.doesNotMatch(main, /force-calendar-sync|force-reminder-check/);
  assert.doesNotMatch(settings, /plugin\.runCalendarSync/);
  for (const file of ['auto-create-service', 'external-calendar-duplicate-cleanup-service', 'native-calendar-record-service', 'calendar-automation', 'sync-request-service', 'sync-request-contract', 'calendar-sync-settlement-filter']) {
    assert.equal(existsSync(new URL(`../src/services/${file}.ts`, import.meta.url)), false, file);
  }
});

test('retired calendar template editor is absent', () => {
  const source = readFileSync(new URL('../src/settings-tab.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /new Setting\(acContent\)\s*\.setName\("Template"\)/u);
  assert.doesNotMatch(source, /\.setName\("Create as"\)/u);
});

test('retained note mappings exclude retired calendar-only controls', () => {
  const source = readFileSync(new URL('../src/settings-tab.ts', import.meta.url), 'utf8');
  assert.match(source, /key: 'endProperty', label: 'Duration Property'/u);
  assert.doesNotMatch(source, /key: '(?:calendarEndDateTimeProperty|previousStatusKey)'/u);
  assert.match(source, /Note field names/u);
  assert.match(source, /api\.changeKey\('tps-controller', fk\.key, value\)/u);
});

test('overview does not advertise a retired calendar polling interval', () => {
  assert.doesNotMatch(settings, /sync every|settings\.syncIntervalMinutes/);
  assert.match(settings, /Retired · saved feed settings remain unchanged/);
});
