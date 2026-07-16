import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const typesSource = readFileSync(new URL('../src/types.ts', import.meta.url), 'utf8');
const mainSource = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const settingsTabSource = readFileSync(new URL('../src/settings-tab.ts', import.meta.url), 'utf8');
const serviceSource = readFileSync(new URL('../src/services/two-stage-archive-service.ts', import.meta.url), 'utf8');

test('two-stage archive has safe Archive to _archive defaults', () => {
  assert.match(typesSource, /export interface TwoStageArchiveRule/);
  assert.match(typesSource, /twoStageArchive: TwoStageArchiveRule/);
  assert.match(typesSource, /enabled:\s*false/);
  assert.match(typesSource, /sourceFolder:\s*"Archive"/);
  assert.match(typesSource, /destinationFolder:\s*"_archive"/);
  assert.match(typesSource, /cadence:\s*"monthly-end"/);
  assert.match(typesSource, /runTime:\s*"23:55"/);
});

test('two-stage archive runs only from Controller automation and can be triggered manually', () => {
  assert.match(mainSource, /new TwoStageArchiveService\(this\.app, \(\) => this\.settings, \(\) => this\.saveSettings\(\)\)/);
  assert.match(mainSource, /startTwoStageArchiveLoop\(\)/);
  assert.match(mainSource, /stopTwoStageArchiveLoop\(\)/);
  assert.match(mainSource, /run-two-stage-archive-now/);
  assert.match(mainSource, /Two-stage archive runs on the Controller device/);
  assert.match(mainSource, /this\.settings\.twoStageArchive\?\.enabled/);
  assert.match(mainSource, /this\.twoStageArchiveService\.runIfDue\(\)/);
  assert.match(mainSource, /this\.twoStageArchiveService\.getCheckIntervalMs\(\)/);
});

test('two-stage archive preserves folder structure and does not overwrite collisions', () => {
  assert.match(serviceSource, /isDue\(rule: TwoStageArchiveRule/);
  assert.match(serviceSource, /rule\.lastRunKey === runKey/);
  assert.match(serviceSource, /now\.date\(\) === now\.daysInMonth\(\)/);
  assert.match(serviceSource, /file\.path\.slice\(sourceFolder\.length \+ 1\)/);
  assert.match(serviceSource, /normalizePath\(`\$\{destinationFolder\}\/\$\{relativePath\}`\)/);
  assert.match(serviceSource, /getAvailableTargetPath/);
  assert.match(serviceSource, /while \(this\.app\.vault\.getAbstractFileByPath\(candidate\)\)/);
  assert.match(serviceSource, /candidate = `\$\{withoutExtension\} \$\{counter\}\$\{extension\}`/);
  assert.match(serviceSource, /rule\.lastRunKey = runKey/);
});

test('two-stage archive does not reprocess files already under a nested destination', () => {
  assert.match(serviceSource, /let destinationSkipCount = 0/);
  assert.match(serviceSource, /if \(!this\.isInFolder\(file\.path, sourceFolder\)\) return false/);
  assert.match(serviceSource, /if \(this\.isInFolder\(file\.path, destinationFolder\)\) \{/);
  assert.match(serviceSource, /destinationSkipCount \+= 1/);
  assert.match(serviceSource, /logger\.flow\("TwoStageArchive", "run:destination-skip"/);
});

test('two-stage archive settings expose the monthly Archive to _archive workflow', () => {
  assert.match(settingsTabSource, /Two-Stage Archive/);
  assert.match(settingsTabSource, /Enable Two-Stage Archive/);
  assert.match(settingsTabSource, /Source Folder/);
  assert.match(settingsTabSource, /Destination Folder/);
  assert.match(settingsTabSource, /End of month/);
  assert.match(settingsTabSource, /Run Two-Stage Archive Now/);
  assert.match(settingsTabSource, /Two-stage archive runs on the Controller device/);
  assert.match(settingsTabSource, /restartTwoStageArchiveLoop\(\)/);
});
