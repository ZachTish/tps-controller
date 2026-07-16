import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../src/services/reminder-engine.ts', import.meta.url), 'utf8');
const mainSource = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const overdueSource = readFileSync(new URL('../src/services/overdue-service.ts', import.meta.url), 'utf8');
const reminderCandidateSource = readFileSync(new URL('../src/services/reminder-candidate-service.ts', import.meta.url), 'utf8');
const reminderTargetSource = readFileSync(new URL('../src/services/reminder-target-service.ts', import.meta.url), 'utf8');
const reminderSettingsSource = readFileSync(new URL('../src/services/reminder-settings-service.ts', import.meta.url), 'utf8');
const reminderDeliveryWindowSource = readFileSync(new URL('../src/services/reminder-delivery-window.ts', import.meta.url), 'utf8');
const timeCalculationSource = readFileSync(new URL('../src/utils/time-calculation-service.ts', import.meta.url), 'utf8');
const notificationViewSource = readFileSync(new URL('../src/views/notification-view.ts', import.meta.url), 'utf8');
const notificationSignatureSource = readFileSync(new URL('../src/views/notification-view-signature.ts', import.meta.url), 'utf8');
const overdueModalSource = readFileSync(new URL('../src/modals/overdue-modal.ts', import.meta.url), 'utf8');
const settingsTabSource = readFileSync(new URL('../src/settings-tab.ts', import.meta.url), 'utf8');
const typesSource = readFileSync(new URL('../src/types.ts', import.meta.url), 'utf8');

function loadReminderTargetModule() {
  const compiled = ts.transpileModule(reminderTargetSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018 },
  });
  const module = { exports: {} };
  const requireStub = (id) => {
    if (id === '../tps-gcm-api') return { buildCalendarExternalId: () => 'calendar:test' };
    if (id === 'obsidian') return {};
    throw new Error(`Unexpected require: ${id}`);
  };
  const load = new Function('module', 'exports', 'require', compiled.outputText);
  load(module, module.exports, requireStub);
  return module.exports;
}

function loadReminderSettingsModule() {
  const compiled = ts.transpileModule(reminderSettingsSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018 },
  });
  const module = { exports: {} };
  const requireStub = (id) => {
    throw new Error(`Unexpected require: ${id}`);
  };
  const load = new Function('module', 'exports', 'require', compiled.outputText);
  load(module, module.exports, requireStub);
  return module.exports;
}

function loadReminderDeliveryWindowModule() {
  const compiled = ts.transpileModule(reminderDeliveryWindowSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018 },
  });
  const module = { exports: {} };
  const requireStub = (id) => {
    throw new Error(`Unexpected require: ${id}`);
  };
  const load = new Function('module', 'exports', 'require', compiled.outputText);
  load(module, module.exports, requireStub);
  return module.exports;
}

function loadNotificationSignatureModule() {
  const compiled = ts.transpileModule(notificationSignatureSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018 },
  });
  const module = { exports: {} };
  const requireStub = (id) => {
    throw new Error(`Unexpected require: ${id}`);
  };
  const load = new Function('module', 'exports', 'require', compiled.outputText);
  load(module, module.exports, requireStub);
  return module.exports;
}

test('all-day task reminders can repeat until their stop condition', () => {
  assert.match(source, /reminder\.repeatUntilComplete\s*&&\s*\(!reminder\.mode \|\| reminder\.mode === "task"\)/);
  assert.doesNotMatch(source, /reminder\.repeatUntilComplete\s*&&[\s\S]{0,160}!isAllDaySafe/);
});

test('reminder scheduler wakes at the shortest active repeat interval', () => {
  assert.match(mainSource, /const activeRepeatMs = \(this\.settings\.reminders \|\| \[\]\)/);
  assert.match(mainSource, /Math\.min\(pollMs, \.\.\.activeRepeatMs\)/);
});

test('stale one-shot reminders expire without blocking repeat-until-complete rules', () => {
  const {
    getFileReminderLiveWindowMs,
    shouldSkipStaleOneShotReminder,
  } = loadReminderDeliveryWindowModule();
  const triggerTime = Date.UTC(2026, 6, 12, 12, 0, 0);
  const liveWindowMs = getFileReminderLiveWindowMs(0.5);

  assert.equal(liveWindowMs, 60 * 1000);
  assert.equal(shouldSkipStaleOneShotReminder(triggerTime + liveWindowMs, triggerTime, false, liveWindowMs), false);
  assert.equal(shouldSkipStaleOneShotReminder(triggerTime + liveWindowMs + 1, triggerTime, false, liveWindowMs), true);
  assert.equal(shouldSkipStaleOneShotReminder(triggerTime + (3 * 24 * 60 * 60 * 1000), triggerTime, false, liveWindowMs), true);
  assert.equal(shouldSkipStaleOneShotReminder(triggerTime + (3 * 24 * 60 * 60 * 1000), triggerTime, true, liveWindowMs), false);
  assert.equal(getFileReminderLiveWindowMs(60), 5 * 60 * 1000);
  assert.match(source, /shouldSkipStaleOneShotReminder\([\s\S]{0,180}reminder\.repeatUntilComplete/);
  assert.match(source, /notification:skipped-stale/);
  assert.match(source, /stale-one-shot/);
  assert.match(overdueSource, /getFileReminderLiveWindowMs\(settings\.pollMinutes\)/);
  assert.match(overdueSource, /shouldSkipStaleOneShotReminder\([\s\S]{0,180}reminder\.repeatUntilComplete/);
  assert.match(overdueSource, /staleOneShotHidden/);
});

test('reminder settings normalization preserves live editor objects across rapid text input', () => {
  const { normalizeReminderSettingsInPlace } = loadReminderSettingsModule();
  const reminders = [{
    requiredStatuses: [],
    sourceTypes: ['file', 'invalid'],
  }];
  const editorRule = reminders[0];

  for (const value of ['t', 'to', 'tod', 'todo']) {
    editorRule.requiredStatuses = [value];
    normalizeReminderSettingsInPlace(reminders);
    assert.equal(reminders[0], editorRule);
  }

  assert.deepEqual(reminders[0].requiredStatuses, ['todo']);
  assert.deepEqual(reminders[0].sourceTypes, ['file']);
  assert.deepEqual(reminders[0].ignoreCheckboxStates, []);
  assert.deepEqual(reminders[0].requiredCheckboxStates, []);
  assert.match(mainSource, /normalizeReminderSettingsInPlace\(this\.settings\.reminders \|\| \[\]\)/);
  assert.doesNotMatch(mainSource, /const normalizedReminder = \{ \.\.\.reminder \}/);
});

test('triggered reminders show local system notices even without the sidebar or notifier', () => {
  assert.match(mainSource, /this\.showLocalReminderNotices\(batches\);/);
  assert.match(mainSource, /private showLocalReminderNotices/);
  assert.match(mainSource, /new Notice\(this\.buildLocalReminderNoticeFragment\(batch\), 10000\)/);
  assert.match(mainSource, /private buildLocalReminderNoticeFragment/);
  assert.match(mainSource, /items\.slice\(0, 5\)/);
  assert.match(mainSource, /Click to open note/);
  assert.match(mainSource, /private async openReminderNoticeTarget/);
  assert.match(mainSource, /private async openReminderFile/);
  assert.match(mainSource, /await leaf\.openFile\(file\)/);
  assert.match(mainSource, /await this\.overdueService\.openNotificationModal\(\)/);
  assert.match(mainSource, /TPS Notifier plugin not found\. Local system notices were shown\./);
  assert.match(mainSource, /Notifier plugin has no send API\. Local system notices were shown\./);
  assert.doesNotMatch(mainSource, /this\.restoreAlertStateAfterDeliveryFailure\(alertStateBeforeRun, "TPS Notifier plugin not found\."/);
  assert.doesNotMatch(mainSource, /this\.restoreAlertStateAfterDeliveryFailure\(alertStateBeforeRun, "Notifier plugin has no send API\."/);
});

test('overdue reminder status writes delegate to GCM bulk edit guards when available', () => {
  assert.match(overdueSource, /private getGcmBulkEditService\(\): any \| null/);
  assert.match(overdueSource, /bulkEditService\.setStatus\(\[item\.file\], resolvedStatus\)/);
  assert.match(overdueSource, /bulkEditService\.updateFrontmatter\(\[item\.file\], \{ \[statusKey\]: null \}\)/);
});

test('status and snooze clear actions delete only their configured properties', () => {
  assert.match(overdueSource, /const isStatusClear = status == null \|\| String\(status\)\.trim\(\) === ""/);
  assert.match(overdueSource, /if \(existingStatusKey\) delete fm\[existingStatusKey\]/);
  assert.match(overdueSource, /if \(snoozeTimeStr\) \{[\s\S]*fm\[existingSnoozeKey \|\| snoozeKey\] = snoozeTimeStr;[\s\S]*delete fm\[existingSnoozeKey\]/);
  assert.doesNotMatch(overdueSource, /fm\[snoozeKey\] = snoozeTimeStr/);
  assert.match(notificationViewSource, /const isStatusClear = newStatus == null \|\| String\(newStatus\)\.trim\(\) === ''/);
  assert.match(notificationViewSource, /if \(existingStatusKey\) delete fm\[existingStatusKey\]/);
  assert.doesNotMatch(notificationViewSource, /fm\[statusKey\] = ''/);
});

test('notification command expands and focuses the sidebar view leaf', () => {
  assert.match(overdueSource, /workspace\.detachLeavesOfType\(NOTIFICATION_VIEW_TYPE\)/);
  assert.match(overdueSource, /ensureSideLeaf\(NOTIFICATION_VIEW_TYPE, "right"/);
  assert.match(overdueSource, /workspace\.getRightLeaf\(true\)/);
  assert.match(overdueSource, /await leaf\.setViewState\(\{ type: NOTIFICATION_VIEW_TYPE, state: \{\}, active: true \}\)/);
  assert.doesNotMatch(overdueSource, /getViewState\(\)\.type !== NOTIFICATION_VIEW_TYPE/);
  assert.match(overdueSource, /private activateLeafTab\(leaf: WorkspaceLeaf\): void/);
  assert.match(overdueSource, /parent\.selectTabIndex\(tabIndex\)/);
  assert.match(overdueSource, /parent\.currentTab = tabIndex/);
  assert.match(overdueSource, /rightSplit\?\.\s*expand\?\.\(\)/);
  assert.match(overdueSource, /logger\.flow\("NotificationView", "open:leaf-ready"/);
  assert.match(overdueSource, /await workspace\.revealLeaf\(leaf\)/);
  assert.match(overdueSource, /workspace\.setActiveLeaf\(leaf, \{ focus: true \} as any\)/);
  assert.match(overdueSource, /await leaf\.loadIfDeferred\?\.\(\)/);
  assert.match(overdueSource, /await \(leaf\.view as any\)\?\.refresh\?\.\(\)/);
  assert.match(overdueSource, /requestSaveLayout\?\.\(\)/);
});

test('reminder candidate discovery includes task-line reminder entities without parent frontmatter', () => {
  assert.match(reminderCandidateSource, /function hasReminderFrontmatter\(file: TFile, app: App, reminderProperties: Set<string>\): boolean/);
  assert.match(reminderCandidateSource, /async function hasReminderInlineTaskProperty\(file: TFile, app: App, reminderProperties: Set<string>\): Promise<boolean>/);
  assert.equal(reminderCandidateSource.includes('const TASK_LINE_PATTERN = /^\\s*(?:[-*+]|\\d+[.)])\\s+\\[[^\\]]?]\\s+/;'), true);
  assert.equal(reminderCandidateSource.includes('const INLINE_PROPERTY_PATTERN = /\\[([^\\[\\]:]+)::\\s*([^\\]]+)\\]/g;'), true);
  assert.match(reminderCandidateSource, /if \(hasReminderFrontmatter\(file, app, propertySet\)\) \{/);
  assert.match(reminderCandidateSource, /await app\.vault\.cachedRead\(file\)/);
  assert.match(reminderCandidateSource, /if \(!TASK_LINE_PATTERN\.test\(line\)\) continue;/);
  assert.match(reminderCandidateSource, /if \(key && reminderProperties\.has\(key\)\) return true;/);
  assert.match(source, /discoverReminderCandidateFiles\(this\.app, settings, properties\)/);
  assert.match(overdueSource, /getReminderCandidateFiles\(\s*this\.app,/);
});

test('reminder task parsing ignores task examples inside fenced code blocks', () => {
  assert.match(reminderCandidateSource, /const FENCED_CODE_BLOCK_PATTERN = \/\^\\s\*\(```\|~~~\)\//);
  assert.match(reminderTargetSource, /const FENCED_CODE_BLOCK_PATTERN = \/\^\\s\*\(```\|~~~\)\//);
  assert.match(reminderCandidateSource, /let inFencedCodeBlock = false/);
  assert.match(reminderTargetSource, /let inFencedCodeBlock = false/);
  assert.match(reminderCandidateSource, /if \(FENCED_CODE_BLOCK_PATTERN\.test\(line\)\) \{/);
  assert.match(reminderTargetSource, /if \(FENCED_CODE_BLOCK_PATTERN\.test\(lines\[index\]\)\) \{/);
  assert.match(reminderCandidateSource, /if \(inFencedCodeBlock\) continue;\s+if \(!TASK_LINE_PATTERN\.test\(line\)\) continue;/);
  assert.match(reminderTargetSource, /if \(inFencedCodeBlock\) continue;\s+const parsed = parseTaskReminderLine\(lines\[index\]\)/);
});

test('reminder target builder does not create task targets from fenced markdown examples', async () => {
  const { buildReminderTargetsForFile } = loadReminderTargetModule();
  const content = [
    'Before',
    '```md',
    '- [ ] [[Contract Summary|Draft contract summary]] [scheduled:: 2026-06-23]',
    '```',
    '- [ ] [[Real Task]] [scheduled:: 2026-06-24]',
  ].join('\n');
  const app = { vault: { cachedRead: async () => content } };
  const file = { path: 'Notes/TPS System Contract.md', basename: 'TPS System Contract', extension: 'md' };
  const targets = await buildReminderTargetsForFile(app, file, {}, {});
  const taskTargets = targets.filter((target) => target.targetKind === 'task');

  assert.equal(taskTargets.length, 1);
  assert.equal(taskTargets[0].taskTitle, '[[Real Task]]');
  assert.equal(taskTargets[0].taskLine, 4);
});

test('task-level reminder targets preserve task title and containing note', () => {
  assert.match(reminderTargetSource, /parseTaskReminderLine/);
  assert.match(reminderTargetSource, /sourceKey: `\$\{file\.path\}::task:\$\{index\}`/);
  assert.match(reminderTargetSource, /targetKind: "task"/);
  assert.match(reminderTargetSource, /taskTitle: parsed\.title/);
  assert.match(reminderTargetSource, /taskRawLine: lines\[index\]/);
  assert.match(reminderTargetSource, /noteTitle: buildNoteDisplayName\(file\)/);
  assert.match(reminderTargetSource, /props\[key\.toLowerCase\(\)\] = value/);
  assert.match(overdueSource, /taskTitle: target\.taskTitle/);
  assert.match(overdueSource, /taskRawLine: target\.taskRawLine/);
  assert.match(overdueSource, /taskLine: target\.taskLine/);
  assert.match(overdueSource, /item\.targetKind === "task" && typeof item\.taskLine === "number"/);
  assert.match(overdueSource, /updateTaskLineProperties/);
  assert.match(overdueSource, /applyInlinePropertyPatch/);
  assert.match(notificationViewSource, /item\.targetKind === 'task' && item\.taskTitle/);
  assert.match(notificationViewSource, /getItemNoteSubtitle/);
  assert.match(notificationViewSource, /tps-notification-note-title/);
});

test('notification sidebar uses task icons for task reminder rows', () => {
  assert.match(notificationViewSource, /private getItemIcon\(item: OverdueItem\): \{ icon: string; color: string \}/);
  assert.match(notificationViewSource, /if \(item\.targetKind === 'task'\) \{/);
  assert.match(notificationViewSource, /return \{ icon: 'check-square', color: 'var\(--text-muted\)' \}/);
  assert.match(notificationViewSource, /const \{ icon: iconName, color: iconColor \} = this\.getItemIcon\(item\)/);
  assert.doesNotMatch(notificationViewSource, /const iconName = rawIcon\.includes\(': '\)/);
});

test('notification sidebar titles can extend under row action buttons', () => {
  assert.match(notificationViewSource, /row\.style\.position = 'relative'/);
  assert.match(notificationViewSource, /content\.style\.minWidth = '0'/);
  assert.match(notificationViewSource, /actions\.style\.position = 'absolute'/);
  assert.match(notificationViewSource, /actions\.style\.right = '12px'/);
  assert.match(notificationViewSource, /actions\.style\.transform = 'translateY\(-50%\)'/);
});

test('notification view redraw signature includes visible row and action fields', () => {
  const { buildNotificationItemsSignature } = loadNotificationSignatureModule();
  const base = {
    file: { path: 'Inbox/Reminder.md', basename: 'Reminder' },
    reminder: { id: 'scheduled', property: 'scheduled' },
    propertyTime: 0,
    diff: 'Due now',
    id: '1',
    sourceKey: 'Inbox/Reminder.md::task:3',
    sourceType: 'file',
    targetKind: 'task',
    taskTitle: 'Original task',
    noteTitle: 'Reminder',
    taskLine: 3,
    taskRawLine: '- [ ] Original task [scheduled:: 2026-07-04]',
    reminderProperty: 'scheduled',
    reminderPropertySource: 'task',
    status: 'open',
    icon: 'file-text',
    color: '#4c76ae',
    isAllDay: false,
  };
  const signature = (patch) => buildNotificationItemsSignature([{ ...base, ...patch }]);

  assert.notEqual(signature({}), signature({ taskTitle: 'Renamed task' }));
  assert.notEqual(signature({}), signature({ noteTitle: 'Different source note' }));
  assert.notEqual(signature({}), signature({ icon: 'calendar', color: '#ff0000' }));
  assert.notEqual(signature({}), signature({ reminderPropertySource: 'note' }));
  assert.notEqual(signature({}), signature({ sourceType: 'external-event', targetKind: 'external-event' }));
  assert.notEqual(signature({}), signature({ diff: 'Snoozed until 14:00' }));
  assert.notEqual(signature({}), signature({ taskRawLine: '- [ ] Updated task [scheduled:: 2026-07-04]' }));
});

test('notification item opens use the GCM pinned-safe file opener', () => {
  assert.match(overdueSource, /plugins\?\.plugins\?\.\["tps-global-context-menu"\]/);
  assert.match(overdueSource, /gcm\.openFileInLeaf\(file, false, \(\) => this\.app\.workspace\.getLeaf\(false\), \{/);
  assert.match(overdueSource, /active: true/);
  assert.match(overdueSource, /revealLeaf: true/);
  assert.match(overdueSource, /this\.findOpenMarkdownLeaf\(file\) \?\? this\.app\.workspace\.activeLeaf/);
  assert.match(overdueSource, /this\.app\.workspace\.getLeaf\(true\)/);
  assert.match(overdueSource, /this\.app\.workspace\.setActiveLeaf\(leaf, \{ focus: true \} as any\)/);
  assert.match(overdueSource, /private findOpenMarkdownLeaf\(file: TFile\): WorkspaceLeaf \| null/);
});

test('reminder external task matching reads hidden inline metadata comments', () => {
  assert.match(source, /\(\?:tpsinlineprops\|tps-inline-props\|data-tps-inline-props\|\\\[\\\^tps-inline:\)/);
  assert.match(source, /private parseHiddenInlineMetadata\(line: string, encoded\?: string\): Record<string, unknown>/);
  assert.match(source, /%%\\s\*tps-inline-props:\(\[\\s\\S]\*\?\)\\s\*%%/);
  assert.match(source, /this\.mergeInlineMetadata\(hiddenProps, raw, !hiddenMatch\[1]\)/);
});

test('notification view renders reminder titles as clickable markdown links', () => {
  assert.match(notificationViewSource, /MarkdownRenderer/);
  assert.match(notificationViewSource, /private renderInlineMarkdownTitle/);
  assert.match(notificationViewSource, /MarkdownRenderer\.renderMarkdown\(source, container, sourcePath, this\)/);
  assert.match(notificationViewSource, /tps-notification-title/);
  assert.match(notificationViewSource, /a\.internal-link, a\.external-link/);
  assert.match(notificationViewSource, /a\.internal-link, a\[href\^="app:\/\/obsidian\.md\/"\]/);
  assert.match(notificationViewSource, /tps-notification-title-link/);
  assert.match(notificationViewSource, /private resolveRenderedInternalLink/);
  assert.match(notificationViewSource, /private getRenderedInternalLinkResolutionTarget/);
  assert.match(notificationViewSource, /replace\(\/#\.\*\/, ''\)/);
  assert.match(notificationViewSource, /getFirstLinkpathDest\(resolutionTarget, sourcePath\)/);
  assert.match(notificationViewSource, /link\.replaceWith\(document\.createTextNode\(link\.textContent \|\| ''\)\)/);
  assert.match(notificationViewSource, /private openRenderedTitleLink/);
  assert.match(notificationViewSource, /event\.stopPropagation\(\)/);
  assert.match(notificationViewSource, /this\.app\.workspace\.openLinkText\(normalized, sourcePath, false\)/);
  assert.doesNotMatch(notificationViewSource, /createEl\('span', \{ text: this\.getItemDisplayTitle\(item\) \}\)/);
});

test('task reminder entity status is derived from checkbox marker, not parent note status', () => {
  assert.match(reminderTargetSource, /const noteStatus = getFrontmatterValueCaseInsensitive\(frontmatter, "status"\)/);
  assert.match(reminderTargetSource, /noteStatus,/);
  assert.match(reminderTargetSource, /const parsedStatus = typeof properties\.status === "string" \? properties\.status\.trim\(\) : properties\.status/);
  assert.match(reminderTargetSource, /if \(parsedStatus\) properties\.inlineStatus = parsedStatus/);
  assert.match(reminderTargetSource, /properties\.status = markerStatus/);
  assert.match(reminderTargetSource, /properties\.checkboxStatus = markerStatus/);
  assert.match(reminderTargetSource, /properties\.checkboxState = checkboxState/);
  assert.match(reminderTargetSource, /properties\.taskCheckboxState = checkboxState/);
  assert.match(reminderTargetSource, /properties\.taskStatus = markerStatus/);
  assert.match(reminderTargetSource, /if \(marker === "x"\) return "complete"/);
  assert.match(reminderTargetSource, /if \(marker === "-" \|\| marker === "~"\) return "wont-do"/);
  assert.match(reminderTargetSource, /props\[key] = value/);
  assert.match(reminderTargetSource, /props\[key\.toLowerCase\(\)] = value/);
  assert.match(reminderTargetSource, /\.\.\.frontmatter,\s+\.\.\.parsed\.properties,\s+noteStatus,/);
  assert.doesNotMatch(reminderTargetSource, /properties\.status = markerStatus !== "todo" \|\| !parsedStatus \? markerStatus : parsedStatus/);
});

test('reminder rules evaluate checkbox states separately from statuses', () => {
  assert.match(typesSource, /ignoreCheckboxStates\?: string\[\]/);
  assert.match(typesSource, /requiredCheckboxStates\?: string\[\]/);
  assert.match(typesSource, /globalIgnoreCheckboxStates: string\[\]/);
  assert.match(typesSource, /globalIgnoreCheckboxStates: \["x", "-"\]/);
  assert.match(timeCalculationSource, /export function normalizeCheckboxState\(value: unknown\): string/);
  assert.match(timeCalculationSource, /raw === "space" \|\| raw === "blank" \|\| raw === "empty" \|\| raw === "open" \|\| raw === "todo"/);
  assert.match(timeCalculationSource, /export function hasRequiredCheckboxState\(fm: any, reminder: PropertyReminder\): boolean/);
  assert.match(timeCalculationSource, /const states = getCheckboxStates\(fm\)/);
  assert.match(timeCalculationSource, /if \(states\.length === 0\) return false/);
  assert.match(timeCalculationSource, /globalIgnoreCheckboxStates: string\[\] = \[\]/);
  assert.match(timeCalculationSource, /const ignoreCheckboxStates = Array\.isArray\(reminder\.ignoreCheckboxStates\)/);
  assert.match(timeCalculationSource, /const checkboxStates = new Set<string>\(getCheckboxStates\(fm\)\)/);
  assert.match(source, /hasRequiredStatus, hasRequiredCheckboxState, shouldIgnoreForReminder/);
  assert.match(source, /settings\.globalIgnoreStatuses,\s+settings\.globalIgnoreCheckboxStates,/);
  assert.match(source, /if \(!hasRequiredCheckboxState\(effectiveFm, reminder\)\) \{\s+this\.countSkip\(params\.stats, "checkbox-filter"\);\s+continue;\s+\}/);
  assert.match(overdueSource, /hasRequiredStatus, hasRequiredCheckboxState,/);
  assert.match(overdueSource, /const ignoreCheckboxStates = settings\.globalIgnoreCheckboxStates \|\| \[\]/);
  assert.match(overdueSource, /ignoreStatuses, ignoreCheckboxStates/);
  assert.match(settingsTabSource, /Ignore Checkbox States/);
  assert.match(settingsTabSource, /Required Checkbox States/);
  assert.match(reminderSettingsSource, /if \(!Array\.isArray\(reminder\.ignoreCheckboxStates\)\) reminder\.ignoreCheckboxStates = \[\]/);
  assert.match(reminderSettingsSource, /if \(!Array\.isArray\(reminder\.requiredCheckboxStates\)\) reminder\.requiredCheckboxStates = \[\]/);
});

test('open checklist reminders surface task rows instead of parent note rows', () => {
  assert.doesNotMatch(
    reminderTargetSource,
    /some\(\(key\) => \["scheduled", "due", "date", "start"\]\.includes\(key\.toLowerCase\(\)\)\)/,
  );
  assert.match(reminderTargetSource, /properties\.status = markerStatus/);
  assert.match(overdueSource, /const taskBackedReminderKeys = new Set/);
  assert.match(overdueSource, /filter\(\(item\) => item\.targetKind === "task"\)/);
  assert.match(overdueSource, /item\.targetKind !== "note"/);
  assert.match(overdueSource, /taskBackedReminderKeys\.has\(`\$\{item\.file\.path\}::\$\{item\.reminder\.id\}`\)/);
  assert.match(source, /const fileNotifications: PendingNotification\[\] = \[\]/);
  assert.match(source, /suppressNoteNotificationsBackedByTaskNotifications\(fileNotifications, alertState\)/);
  assert.match(source, /notification\.sourceKey\.includes\("::task:"\)/);
  assert.match(source, /notification\.sourceKey !== notification\.file\.path/);
  assert.match(source, /state\.triggered = false/);
  assert.match(source, /state\.lastTriggerKey = undefined/);
});

test('task reminder rows resolve schedule instead of showing a status pill', () => {
  assert.match(reminderTargetSource, /taskPropertyKeys\?: string\[\]/);
  assert.match(reminderTargetSource, /taskPropertyKeys: Object\.keys\(parsed\.properties\)/);
  assert.match(overdueSource, /reminderPropertySource: this\.getReminderPropertySource\(target, reminder\.property\)/);
  assert.match(overdueSource, /async resolveTaskReminder\(item: OverdueItem\): Promise<boolean>/);
  assert.match(overdueSource, /item\.reminderPropertySource === "task"/);
  assert.match(overdueSource, /private async clearFileReminderProperty\(file: TFile, property: string\): Promise<void>/);
  assert.match(overdueSource, /await this\.updateTaskLineProperties\(item, \{ \[property\]: null \}, "clear-task-reminder"\)/);
  assert.match(overdueSource, /return this\.moveTaskToFile\(item, targetFile\)/);
  assert.match(notificationViewSource, /resolveOverdueTaskReminder\?\(item: OverdueItem\): Promise<boolean>/);
  assert.match(notificationViewSource, /item\.sourceType !== 'external-event' && !!item\.reminder\.property/);
  assert.match(notificationViewSource, /const shouldMoveTask = item\.targetKind === 'task' && item\.reminderPropertySource !== 'task'/);
  assert.match(notificationViewSource, /const changed = this\.plugin\.resolveOverdueTaskReminder/);
  assert.match(notificationViewSource, /if \(changed\) this\.removeItemOptimistically\(item\)/);
  assert.match(notificationViewSource, /new Notice\('Could not move or clear the reminder task\.'\)/);
  assert.match(notificationViewSource, /new ConfirmClearScheduledModal\(this\.app, item/);
  assert.match(notificationViewSource, /class ConfirmClearScheduledModal extends Modal/);
  assert.match(notificationViewSource, /text: 'Clear scheduled'/);
  assert.match(notificationViewSource, /this\.refreshDebounced\(\)/);
  assert.doesNotMatch(notificationViewSource, /window\.setTimeout\(\(\): void => void this\.refresh\(\), 100\)/);
  assert.match(mainSource, /resolveOverdueTaskReminder\(item: OverdueItem\): Promise<boolean>/);
});

test('notification task moves resolve stale daily-note line numbers safely', () => {
  assert.match(overdueSource, /private findCurrentTaskLineIndex\(lines: string\[\], item: OverdueItem\): number/);
  assert.match(overdueSource, /this\.isSameTaskLine\(lines\[preferredIndex\] \|\| "", item\)/);
  assert.match(overdueSource, /const rawLine = String\(item\.taskRawLine \|\| ""\)/);
  assert.match(overdueSource, /lines\.findIndex\(\(line\) => line === rawLine && this\.isTaskLine\(line \|\| ""\)\)/);
  assert.match(overdueSource, /private isSameTaskLine\(line: string, item: OverdueItem\): boolean/);
  assert.match(overdueSource, /this\.normalizeTaskText\(this\.cleanTaskLineTitle\(line \|\| ""\)\) === normalizedTitle/);
  assert.match(overdueSource, /const resolvedIndex = this\.findCurrentTaskLineIndex\(lines, item\)/);
  assert.match(overdueSource, /item\.taskLine = resolvedIndex/);
  assert.match(overdueSource, /item\.taskRawLine = lines\[resolvedIndex\]/);
  assert.match(overdueSource, /logger\.flowWarn\("OverdueAction", "move-task:source-not-found"/);
  assert.match(overdueSource, /return removed;/);
  assert.match(overdueSource, /this\.isDailyNoteSourceFile\(sourceFile\)/);
  assert.match(overdueSource, /this\.buildDailyNoteScratchpadMovedTaskBlock\(block\)/);
  assert.match(overdueSource, /kept a checked scratchpad copy/);
  assert.match(overdueSource, /completedDate: "null"/);
  assert.match(overdueSource, /private didSettle = false/);
  assert.match(overdueSource, /window\.setTimeout\(\(\) => \{/);
  assert.match(overdueSource, /if \(!this\.didChoose\) this\.settle\(null\)/);
  assert.match(overdueSource, /private settle\(file: TFile \| null\): void/);
  assert.doesNotMatch(overdueSource, /preferredIndex >= 0 && this\.isTaskLine\(lines\[preferredIndex\] \|\| ""\)\) return preferredIndex/);
});

test('notification sort direction can be reversed from settings', () => {
  assert.match(typesSource, /notificationSortDirection: "asc" \| "desc"/);
  assert.match(typesSource, /notificationSortDirection: "asc"/);
  assert.match(settingsTabSource, /Notification Sort Direction/);
  assert.match(settingsTabSource, /\.addOption\('asc', 'Oldest first'\)/);
  assert.match(settingsTabSource, /\.addOption\('desc', 'Newest first'\)/);
  assert.match(settingsTabSource, /this\.plugin\.settings\.notificationSortDirection = value === 'desc' \? 'desc' : 'asc'/);
  assert.match(settingsTabSource, /this\.plugin\.refreshNotificationViews\(\)/);
  assert.match(mainSource, /refreshNotificationViews\(\): void/);
  assert.match(overdueSource, /const sortDirection = this\.getSettings\(\)\.notificationSortDirection === "desc" \? -1 : 1/);
  assert.match(overdueSource, /return delta \* sortDirection/);
});

test('overdue modal complete actions are single-click and preserve list position', () => {
  assert.match(overdueModalSource, /private suppressedItemKeys = new Set<string>\(\)/);
  assert.match(overdueModalSource, /this\.suppressedItemKeys\.add\(key\)/);
  assert.match(overdueModalSource, /nextItems\.filter\(\(item\) => !this\.suppressedItemKeys\.has\(this\.getItemKey\(item\)\)\)/);
  assert.match(overdueModalSource, /const previousScrollTop = this\.container\.scrollTop/);
  assert.match(overdueModalSource, /this\.container\.scrollTop = previousScrollTop/);
  assert.match(overdueModalSource, /if \(button\.disabled\) return/);
  assert.match(overdueModalSource, /button\.disabled = true/);
  assert.match(overdueModalSource, /this\.refreshDebounced\(\)/);
  assert.match(overdueModalSource, /this\.suppressedItemKeys\.delete\(this\.getItemKey\(item\)\)/);
  assert.doesNotMatch(overdueModalSource, /window\.setTimeout\(\(\): void => void this\.refresh\(\), 100\)/);
});

test('notification sidebar refreshes are coalesced to avoid action lag', () => {
  assert.match(notificationViewSource, /private isRefreshing = false/);
  assert.match(notificationViewSource, /private refreshPending = false/);
  assert.match(notificationViewSource, /private lastRenderedSignature = '\\u0000'/);
  assert.match(notificationViewSource, /}, 750, false\)/);
  assert.match(notificationViewSource, /window\.setInterval\(\(\) => this\.refreshDebounced\(\), 30000\)/);
  assert.match(notificationViewSource, /if \(this\.isRefreshing\) \{/);
  assert.match(notificationViewSource, /this\.refreshPending = true/);
  assert.match(notificationViewSource, /buildNotificationItemsSignature\(nextItems\)/);
  assert.match(notificationViewSource, /nextSignature !== this\.lastRenderedSignature/);
  assert.match(notificationViewSource, /\[NotificationView\] slow refresh/);
});
