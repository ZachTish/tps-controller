import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../src/services/reminder-target-service.ts', import.meta.url), 'utf8');
const createSource = readFileSync(new URL('../src/services/external-event-modal.ts', import.meta.url), 'utf8');
const autoCreateSource = readFileSync(new URL('../src/services/auto-create-service.ts', import.meta.url), 'utf8');
const duplicateCleanupSource = readFileSync(new URL('../src/services/external-calendar-duplicate-cleanup-service.ts', import.meta.url), 'utf8');
const settingsTabSource = readFileSync(new URL('../src/settings-tab.ts', import.meta.url), 'utf8');
const calendarAutomationSource = readFileSync(new URL('../src/services/calendar-automation.ts', import.meta.url), 'utf8');
const mainSource = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const parentChildSource = readFileSync(new URL('../src/services/parent-child-link.ts', import.meta.url), 'utf8');

test('external reminder synthetic frontmatter uses externalId instead of legacy calendar identity triplet', () => {
  assert.match(source, /externalId: buildCalendarExternalId\(null, event\)/);
  assert.doesNotMatch(source, /externalEventId: event\.id/);
  assert.doesNotMatch(source, /tpsCalendarUid: event\.uid/);
  assert.doesNotMatch(source, /tpsCalendarSourceUrl: event\.sourceUrl/);
});

test('Controller external event note creation writes tpsId and externalId instead of legacy identity triplet', () => {
  assert.match(createSource, /ensureInternalIdInFrontmatter\(app, frontmatter\)/);
  assert.match(createSource, /const externalId = buildCalendarExternalId\(app, event\)/);
  assert.match(createSource, /frontmatter\.externalId = externalId/);
  assert.match(createSource, /if \(event\.isAllDay\) \{\s*frontmatter\["allDay"\] = true;/);
  assert.doesNotMatch(createSource, /frontmatter\["allDay"\] = !!event\.isAllDay/);
  assert.doesNotMatch(createSource, /setFrontmatterValueCaseInsensitive\(fm, "folderPath"/);
  assert.doesNotMatch(createSource, /frontmatter\[eventIdKey\] = event\.id/);
  assert.doesNotMatch(createSource, /frontmatter\[uidKey\] = event\.uid/);
  assert.doesNotMatch(createSource, /frontmatter\[sourceUrlKey\] = event\.sourceUrl/);
});

test('Controller auto-create repair writes externalId and removes legacy identity fields', () => {
  assert.match(autoCreateSource, /const externalId = getExternalId\(this\.app, fm\)/);
  assert.match(autoCreateSource, /fm\.externalId = expectedExternalId/);
  assert.match(autoCreateSource, /deleteLegacyCalendarIdentityFields/);
  assert.match(autoCreateSource, /this\.deleteFrontmatterKeyIfPresent\(obj, "externalEventId"\)/);
  assert.match(autoCreateSource, /this\.deleteFrontmatterKeyIfPresent\(obj, "tpsCalendarUid"\)/);
  assert.match(autoCreateSource, /this\.deleteFrontmatterKeyIfPresent\(obj, "tpsCalendarSourceUrl"\)/);
  assert.doesNotMatch(autoCreateSource, /fm\[this\.config\.eventIdKey\] = event\.id/);
  assert.doesNotMatch(autoCreateSource, /fm\[this\.config\.sourceUrlKey\] = normalizedSourceUrl/);
  assert.match(autoCreateSource, /if \(event\.isAllDay\) \{[\s\S]*fm\[allDayKey\] = true;[\s\S]*this\.deleteFrontmatterKeyIfPresent\(fm, "allDay"\)/);
  assert.doesNotMatch(autoCreateSource, /fm\.allDay = event\.isAllDay/);
});

test('Controller parent-child linking does not duplicate the child folder in frontmatter', () => {
  assert.match(parentChildSource, /setFrontmatterValueCaseInsensitive\(fm, parentKey, parentLink\)/);
  assert.doesNotMatch(parentChildSource, /setFrontmatterValueCaseInsensitive\(fm, "folderPath"/);
});

test('Controller duplicate cleanup groups only by externalId or source-scoped legacy event id', () => {
  assert.match(duplicateCleanupSource, /const externalId = this\.findStringCaseInsensitive\(frontmatter, "externalId"\)/);
  assert.match(duplicateCleanupSource, /legacy-source-event:\$\{sourceUrl\}#\$\{eventId\}/);
  assert.doesNotMatch(duplicateCleanupSource, /uidstart:/);
  assert.doesNotMatch(duplicateCleanupSource, /parseFrontmatterDate/);
});

test('external calendar task target note setting commits full normalized paths', () => {
  const targetSettingSource = settingsTabSource.slice(
    settingsTabSource.indexOf('.setName("Task target note")'),
    settingsTabSource.indexOf('.setName("Type Folder")'),
  );

  assert.match(settingsTabSource, /const normalizeTaskTargetNotePath = \(value: string\): string/);
  assert.match(targetSettingSource, /const commit = async \(\) =>/);
  assert.match(targetSettingSource, /calendar\.autoCreateTaskTargetPath = normalized/);
  assert.match(targetSettingSource, /t\.inputEl\.addEventListener\("blur"/);
  assert.match(targetSettingSource, /event\.key !== "Enter"/);
  assert.doesNotMatch(targetSettingSource, /\.onChange\(async \(val\) => \{\s*calendar\.autoCreateTaskTargetPath = val\.trim\(\);\s*await save\(\);/);
  assert.match(calendarAutomationSource, /private normalizeTaskTargetPath\(value: string\): string/);
  assert.match(calendarAutomationSource, /this\.normalizeTaskTargetPath\(calendar\.autoCreateTaskTargetPath\)/);
  assert.doesNotMatch(calendarAutomationSource, /Calendar\.md/);
  assert.match(mainSource, /const normalizeTaskTargetPathSetting = \(value: string\): string/);
  assert.match(mainSource, /normalizeTaskTargetPathSetting\(rest\.autoCreateTaskTargetPath\)/);
  assert.match(settingsTabSource, /normalized === "\.md"/);
  assert.match(calendarAutomationSource, /normalized === "\.md"/);
  assert.match(mainSource, /normalized === "\.md"/);
});

test('task-mode calendar sync stores external identity in hidden comment metadata', () => {
  assert.match(autoCreateSource, /%% tps-inline-props:\$\{JSON\.stringify\(hiddenProps\)\} %%/);
  assert.doesNotMatch(autoCreateSource, /\[tpsInlineProps:: \$\{encodeURIComponent\(JSON\.stringify\(hiddenProps\)\)\}]/);
  assert.match(autoCreateSource, /this\.mergeEncodedInlineMetadata\(props, hiddenMatch\[1] \|\| hiddenMatch\[2] \|\| hiddenMatch\[3] \|\| "", !hiddenMatch\[1]\)/);
});
