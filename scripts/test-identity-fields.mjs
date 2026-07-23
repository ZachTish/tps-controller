import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

function loadTypeScriptModule(url) {
  const sourceText = readFileSync(url, 'utf8');
  const compiled = ts.transpileModule(sourceText, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018 },
  });
  const module = { exports: {} };
  new Function('module', 'exports', compiled.outputText)(module, module.exports);
  return module.exports;
}

const source = readFileSync(new URL('../src/services/reminder-target-service.ts', import.meta.url), 'utf8');
const createSource = readFileSync(new URL('../src/services/external-event-modal.ts', import.meta.url), 'utf8');
const autoCreateSource = readFileSync(new URL('../src/services/auto-create-service.ts', import.meta.url), 'utf8');
const inlineTaskHelper = loadTypeScriptModule(new URL('../src/services/external-calendar-inline-task.ts', import.meta.url));
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
  assert.match(mainSource, /normalizeExternalCalendarsInPlace\([\s\S]*normalizeTaskTargetPathSetting/);
  assert.match(settingsTabSource, /normalized === "\.md"/);
  assert.match(calendarAutomationSource, /normalized === "\.md"/);
  assert.match(mainSource, /normalized === "\.md"/);
});

test('task-mode calendar sync stores external identity in hidden comment metadata', () => {
  assert.match(autoCreateSource, /%% tps-inline-props:\$\{JSON\.stringify\(hiddenProps\)\} %%/);
  assert.doesNotMatch(autoCreateSource, /\[tpsInlineProps:: \$\{encodeURIComponent\(JSON\.stringify\(hiddenProps\)\)\}]/);
  assert.match(autoCreateSource, /this\.mergeEncodedInlineMetadata\(props, hiddenMatch\[1] \|\| hiddenMatch\[2] \|\| hiddenMatch\[3] \|\| "", !hiddenMatch\[1]\)/);
});

test('calendar task tag reconciliation never targets a frontmatter delimiter', () => {
  const externalId = 'calendar:https://calendar.example/feed#event-123';
  const metadata = `%% tps-inline-props:${JSON.stringify({ externalId })} %%`;

  for (const marker of [' ', 'x', '/', '?', '-']) {
    const taskLine = `- [${marker}] ServiceCentral Flash Office Hours [scheduled:: 2026-07-23 09:00:00] ${metadata}`;
    const content = [
      '---',
      'scheduled: 2026-07-23 00:00:00',
      'tags:',
      '  - context/scheduled',
      'kind: dailynote',
      '---',
      taskLine,
      '',
    ].join('\r\n');
    const result = inlineTaskHelper.mutateExternalTaskLineContent(
      content,
      (line) => line.includes(externalId),
      (line) => inlineTaskHelper.addTagToInlineTaskLine(line, 'hca'),
    );

    assert.equal(result.outcome, 'changed', marker);
    assert.match(result.content, /\r\n---\r\n- \[[ x/?-]\] ServiceCentral/u);
    assert.doesNotMatch(result.content, /^---+\s+#hca$/mu);
    assert.match(result.content, /09:00:00\] #hca %% tps-inline-props:/u);
    assert.equal(result.content.endsWith('\r\n'), true);
  }

  assert.doesNotMatch(autoCreateSource, /hiddenIndex\s*-\s*1/);
  assert.match(autoCreateSource, /mutateExternalTaskLineContent\(/);
  assert.match(autoCreateSource, /isMarkdownCheckboxTaskLine\(line\)/);
});

test('orphan calendar metadata fails closed instead of tagging the preceding YAML fence', () => {
  const externalId = 'calendar:https://calendar.example/feed#orphan';
  const content = [
    '---',
    'kind: dailynote',
    '---',
    `%% tps-inline-props:${JSON.stringify({ externalId })} %%`,
    '- [/] Unrelated task',
    '',
  ].join('\n');
  const result = inlineTaskHelper.mutateExternalTaskLineContent(
    content,
    (line) => line.includes(externalId),
    (line) => inlineTaskHelper.addTagToInlineTaskLine(line, 'hca'),
  );

  assert.equal(result.outcome, 'not-found');
  assert.equal(result.content, content);
  assert.match(result.content, /^---$/mu);
  assert.doesNotMatch(result.content, /^---+\s+#hca$/mu);
});

test('inline calendar event changes patch the task record without touching note frontmatter', () => {
  const externalId = 'calendar:https://calendar.example/feed#event-update';
  const content = [
    '---',
    'scheduled: 2026-07-23 00:00:00',
    'kind: dailynote',
    '---',
    `- [/] Event [scheduled:: 2026-07-23 09:00:00] [timeEstimate:: 30] %% tps-inline-props:${JSON.stringify({ externalId, allDay: true })} %%`,
    '',
  ].join('\n');
  const result = inlineTaskHelper.mutateExternalTaskLineContent(
    content,
    (line) => line.includes(externalId),
    (line) => {
      let next = inlineTaskHelper.setInlineTaskFieldValue(line, 'scheduled', '2026-07-23 10:00:00');
      next = inlineTaskHelper.setInlineTaskFieldValue(next, 'timeEstimate', 60);
      next = inlineTaskHelper.patchCanonicalInlineTaskMetadata(next, { allDay: null }).line;
      return next;
    },
  );

  assert.equal(result.outcome, 'changed');
  assert.match(result.content, /^scheduled: 2026-07-23 00:00:00$/mu);
  assert.match(result.content, /\[scheduled:: 2026-07-23 10:00:00\] \[timeEstimate:: 60\]/u);
  assert.doesNotMatch(result.content, /"allDay"/u);
  assert.match(autoCreateSource, /if \(match\.isInlineTask\) \{[\s\S]*updateExistingInlineTask/);
});

test('calendar task mutation ignores checkbox-shaped YAML and fails closed on unterminated frontmatter', () => {
  const externalId = 'calendar:https://calendar.example/feed#yaml-scalar';
  const yamlCheckbox = `  - [ ] not a task %% tps-inline-props:${JSON.stringify({ externalId })} %%`;
  const content = [
    '---',
    'example: |',
    yamlCheckbox,
    '---',
    '- [ ] Actual task',
    '',
  ].join('\n');
  const skipped = inlineTaskHelper.mutateExternalTaskLineContent(
    content,
    (line) => line.includes(externalId),
    (line) => inlineTaskHelper.addTagToInlineTaskLine(line, 'hca'),
  );
  assert.equal(skipped.outcome, 'not-found');
  assert.equal(skipped.content, content);

  const malformed = ['---', 'example: |', yamlCheckbox, '- [ ] Actual task', ''].join('\n');
  const unsafe = inlineTaskHelper.mutateExternalTaskLineContent(
    malformed,
    (line) => line.includes(externalId),
    (line) => inlineTaskHelper.addTagToInlineTaskLine(line, 'hca'),
  );
  assert.equal(unsafe.outcome, 'unsafe-frontmatter');
  assert.equal(unsafe.content, malformed);

  const indentedFenceExternalId = 'calendar:https://calendar.example/feed#indented-fence';
  const indentedFence = [
    '---',
    'example: |',
    '  ---',
    `  - [ ] hidden %% tps-inline-props:${JSON.stringify({ externalId: indentedFenceExternalId })} %%`,
    'kind: dailynote',
    '---',
    '- [ ] Actual task',
    '',
  ].join('\n');
  const scalarResult = inlineTaskHelper.mutateExternalTaskLineContent(
    indentedFence,
    (line) => line.includes(indentedFenceExternalId),
    (line) => inlineTaskHelper.addTagToInlineTaskLine(line, 'hca'),
  );
  assert.equal(scalarResult.outcome, 'not-found');
  assert.equal(scalarResult.content, indentedFence);
});

test('calendar task mutation ignores checkbox examples inside fenced code blocks', () => {
  const externalId = 'calendar:https://calendar.example/feed#code-example';
  const example = `- [ ] example %% tps-inline-props:${JSON.stringify({ externalId })} %%`;
  const content = ['~~~markdown', example, '~~~', '- [ ] Actual task', ''].join('\n');
  const result = inlineTaskHelper.mutateExternalTaskLineContent(
    content,
    (line) => line.includes(externalId),
    (line) => inlineTaskHelper.addTagToInlineTaskLine(line, 'hca'),
  );
  assert.equal(result.outcome, 'not-found');
  assert.equal(result.content, content);
});

test('calendar task mutation preserves mixed line separators and nested task whitespace', () => {
  const externalId = 'calendar:https://calendar.example/feed#mixed-lines';
  const metadata = `%% tps-inline-props:${JSON.stringify({
    externalId,
    location: 'Room [scheduled:: decoy]',
  })} %%`;
  const task = `    - [/]  Event   [scheduled:: old]   ${metadata}  `;
  const content = `---\r\nkind: dailynote\n---\r\n${task}\nTail\r`;
  const result = inlineTaskHelper.mutateExternalTaskLineContent(
    content,
    (line) => line.includes(externalId),
    (line) => inlineTaskHelper.setInlineTaskFieldValue(line, 'scheduled', '2026-07-23 10:00:00'),
  );

  assert.equal(result.outcome, 'changed');
  assert.equal(
    result.content,
    `---\r\nkind: dailynote\n---\r\n    - [/]  Event   [scheduled:: 2026-07-23 10:00:00]   ${metadata}  \nTail\r`,
  );
  assert.match(result.content, /"location":"Room \[scheduled:: decoy\]"/u);
});

test('calendar task insertion preserves nested blocks, headings, and existing separators', () => {
  const oldExternalId = 'calendar:https://calendar.example/feed#old';
  const newExternalId = 'calendar:https://calendar.example/feed#new';
  const oldTask = `- [/] Existing event %% tps-inline-props:${JSON.stringify({ externalId: oldExternalId })} %%`;
  const newTask = `- [ ] New event %% tps-inline-props:${JSON.stringify({ externalId: newExternalId })} %%`;
  const content = [
    '---',
    'kind: dailynote',
    '---',
    oldTask,
    '  - [ ] Nested child',
    '    continuation',
    '# Agenda',
    '- [ ] Unrelated',
    '',
  ].join('\r');
  const result = inlineTaskHelper.insertTaskLineAfterLeadingTaskBlocks(
    content,
    newTask,
    (line) => line.includes(oldExternalId),
  );

  assert.equal(result.inserted, true);
  assert.equal(result.unsafeFrontmatter, false);
  assert.equal(result.lineIndex, 6);
  assert.equal(
    result.content,
    [
      '---',
      'kind: dailynote',
      '---',
      oldTask,
      '  - [ ] Nested child',
      '    continuation',
      newTask,
      '# Agenda',
      '- [ ] Unrelated',
      '',
    ].join('\r'),
  );
});

test('calendar task insertion keeps loose-list continuations with their parent', () => {
  const externalId = 'calendar:https://calendar.example/feed#loose-parent';
  const oldTask = `- [/] Existing event %% tps-inline-props:${JSON.stringify({ externalId })} %%`;
  const newTask = '- [ ] New event %% tps-inline-props:{"externalId":"calendar:test#new"} %%';
  const content = [
    '---',
    '---',
    oldTask,
    '  first continuation',
    '',
    '  later continuation',
    '# Agenda',
    '',
  ].join('\n');
  const result = inlineTaskHelper.insertTaskLineAfterLeadingTaskBlocks(
    content,
    newTask,
    (line) => line.includes(externalId),
  );
  assert.equal(
    result.content,
    [
      '---',
      '---',
      oldTask,
      '  first continuation',
      '',
      '  later continuation',
      newTask,
      '# Agenda',
      '',
    ].join('\n'),
  );
});

test('calendar task insertion preserves mixed separators and rejects malformed frontmatter', () => {
  const task = '- [ ] Event %% tps-inline-props:{"externalId":"calendar:test#insert"} %%';
  const mixed = '---\r\nkind: dailynote\n---\rBody';
  const inserted = inlineTaskHelper.insertTaskLineAfterLeadingTaskBlocks(
    mixed,
    task,
    () => false,
  );
  assert.equal(inserted.content, `---\r\nkind: dailynote\n---\r${task}\rBody`);

  const malformed = '---\rkind: dailynote\rBody';
  const unsafe = inlineTaskHelper.insertTaskLineAfterLeadingTaskBlocks(
    malformed,
    task,
    () => false,
  );
  assert.equal(unsafe.unsafeFrontmatter, true);
  assert.equal(unsafe.inserted, false);
  assert.equal(unsafe.content, malformed);
});

test('visible inline property parsing excludes field-shaped text inside hidden JSON', () => {
  const line = '- [ ] Event [scheduled:: 2026-07-23 09:00:00] %% tps-inline-props:{"location":"Room [scheduled:: decoy]"} %%';
  const visible = inlineTaskHelper.getVisibleInlineTaskText(line);
  assert.match(visible, /\[scheduled:: 2026-07-23 09:00:00\]/u);
  assert.doesNotMatch(visible, /decoy/u);
  assert.match(autoCreateSource, /const visibleLine = getVisibleInlineTaskText\(line\);/u);
  assert.match(autoCreateSource, /regex\.exec\(visibleLine\)/u);
});

test('calendar task mutation is idempotent and refuses duplicate identities', () => {
  const externalId = 'calendar:https://calendar.example/feed#duplicate';
  const metadata = `%% tps-inline-props:${JSON.stringify({ externalId })} %%`;
  const tagged = `- [ ] Event #hca ${metadata}`;
  const idempotent = inlineTaskHelper.mutateExternalTaskLineContent(
    tagged,
    (line) => line.includes(externalId),
    (line) => inlineTaskHelper.addTagToInlineTaskLine(line, 'hca'),
  );
  assert.equal(idempotent.outcome, 'unchanged');
  assert.equal(idempotent.content, tagged);

  const duplicate = `${tagged}\n- [?] Event copy ${metadata}\n`;
  const ambiguous = inlineTaskHelper.mutateExternalTaskLineContent(
    duplicate,
    (line) => line.includes(externalId),
    (line) => inlineTaskHelper.addTagToInlineTaskLine(line, 'calendar'),
  );
  assert.equal(ambiguous.outcome, 'ambiguous');
  assert.equal(ambiguous.content, duplicate);
});

test('canonical inline metadata patches case-insensitive duplicates and rejects multiple blocks', () => {
  const line = '- [ ] Event %% tps-inline-props:{"externalId":"old","ExternalID":"duplicate","source":"feed"} %%';
  const patched = inlineTaskHelper.patchCanonicalInlineTaskMetadata(line, {
    externalId: 'new',
    allDay: true,
  });
  assert.equal(patched.patched, true);
  const parsed = JSON.parse(patched.line.match(/%% tps-inline-props:(.*?) %%/u)[1]);
  assert.equal(
    Object.keys(parsed).filter((key) => key.toLowerCase() === 'externalid').length,
    1,
  );
  assert.equal(parsed.externalId, 'new');
  assert.equal(parsed.allDay, true);

  const duplicateBlocks = `${line} %% tps-inline-props:{"externalId":"other"} %%`;
  const refused = inlineTaskHelper.patchCanonicalInlineTaskMetadata(duplicateBlocks, { externalId: 'new' });
  assert.equal(refused.patched, false);
  assert.equal(refused.line, duplicateBlocks);
});

test('title repair supports metadata immediately after the checkbox', () => {
  const metadata = '%% tps-inline-props:{"externalId":"calendar:test#title"} %%';
  assert.equal(
    inlineTaskHelper.ensureInlineTaskTitle(`- [ ] ${metadata}`, 'Recovered title'),
    `- [ ] Recovered title ${metadata}`,
  );
});

test('inline temporal values keep all-day dates and honor duration versus end-time mode', () => {
  const common = {
    allDayStart: '2026-07-23',
    timedStart: '2026-07-23 09:00:00',
    timedEnd: '2026-07-23 10:30:00',
    durationMinutes: 90,
  };
  assert.deepEqual(
    inlineTaskHelper.resolveInlineTaskTemporalValues({
      ...common,
      isAllDay: true,
      useEndDuration: true,
    }),
    { start: '2026-07-23', end: '' },
  );
  assert.deepEqual(
    inlineTaskHelper.resolveInlineTaskTemporalValues({
      ...common,
      isAllDay: false,
      useEndDuration: true,
    }),
    { start: '2026-07-23 09:00:00', end: 90 },
  );
  assert.deepEqual(
    inlineTaskHelper.resolveInlineTaskTemporalValues({
      ...common,
      isAllDay: false,
      useEndDuration: false,
    }),
    { start: '2026-07-23 09:00:00', end: '2026-07-23 10:30:00' },
  );
});

test('Controller uses atomic, task-scoped writes for upsert and cancellation', () => {
  const createStart = autoCreateSource.indexOf('private async createTaskInTaskNote');
  const createEnd = autoCreateSource.indexOf('private async ensureTaskTargetFile', createStart);
  const createTaskSource = autoCreateSource.slice(createStart, createEnd);
  assert.match(createTaskSource, /this\.app\.vault\.process\(file,/u);
  assert.doesNotMatch(createTaskSource, /content\.includes\(externalId\)/u);
  assert.doesNotMatch(createTaskSource, /this\.app\.vault\.modify/u);

  const cancelStart = autoCreateSource.indexOf('private async markInlineTaskCancelled');
  const cancelEnd = autoCreateSource.indexOf('private async markCancelledWithoutDelete', cancelStart);
  const cancelSource = autoCreateSource.slice(cancelStart, cancelEnd);
  assert.match(cancelSource, /mutateExternalTaskLineContent\(/u);
  assert.match(cancelSource, /this\.app\.vault\.process\(note\.file,/u);
  assert.doesNotMatch(cancelSource, /this\.app\.vault\.modify/u);

  assert.match(autoCreateSource, /Inline events share a note with unrelated content/u);
  assert.match(autoCreateSource, /if \(!metadataPatch\.patched\) \{[\s\S]*return line;/u);
});
