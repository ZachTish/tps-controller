import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const settings = readFileSync(new URL('../src/settings-tab.ts', import.meta.url), 'utf8');

test('periodic reload owner and all lifecycle hooks are deleted', () => {
  assert.equal(existsSync(new URL('../src/services/controller-periodic-reload-service.ts', import.meta.url)), false);
  assert.doesNotMatch(main, /controllerPeriodicReload|PeriodicControllerReload|ControllerPeriodicReload/);
  assert.doesNotMatch(main, /app:reload|openTextViews|TextFileView/);
});

test('retired reload setting cannot read, enable, or erase the device preference', () => {
  assert.doesNotMatch(settings, /Reload Controller every 15 minutes|PeriodicControllerReload/);
  assert.doesNotMatch(main + settings, /tps-controller-periodic-reload-/);
});
