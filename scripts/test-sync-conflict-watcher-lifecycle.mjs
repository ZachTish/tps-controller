import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
test('automatic conflict sweep and event-driven archiver have no runtime owner', () => {
  assert.equal(existsSync(new URL('../src/services/sync-conflict-watcher.ts', import.meta.url)), false);
  assert.doesNotMatch(main, /SyncConflictWatcher|syncConflictWatcher|sweepVaultForConflicts|checkAndArchiveIfConflict/);
});
