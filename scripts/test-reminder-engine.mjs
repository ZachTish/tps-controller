import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../src/services/reminder-engine.ts', import.meta.url), 'utf8');
const mainSource = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const overdueSource = readFileSync(new URL('../src/services/overdue-service.ts', import.meta.url), 'utf8');
const reminderCandidateSource = readFileSync(new URL('../src/services/reminder-candidate-service.ts', import.meta.url), 'utf8');
const reminderTargetSource = readFileSync(new URL('../src/services/reminder-target-service.ts', import.meta.url), 'utf8');
const notificationViewSource = readFileSync(new URL('../src/views/notification-view.ts', import.meta.url), 'utf8');
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

test('all-day task reminders can repeat until their stop condition', () => {
  assert.match(source, /reminder\.repeatUntilComplete\s*&&\s*\(!reminder\.mode \|\| reminder\.mode === "task"\)/);
  assert.doesNotMatch(source, /reminder\.repeatUntilComplete\s*&&[\s\S]{0,160}!isAllDaySafe/);
});

test('reminder scheduler wakes at the shortest active repeat interval', () => {
  assert.match(mainSource, /const activeRepeatMs = \(this\.settings\.reminders \|\| \[\]\)/);
  assert.match(mainSource, /Math\.min\(pollMs, \.\.\.activeRepeatMs\)/);
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
  assert.match(overdueSource, /bulkEditService\.setStatus\(\[item\.file\], status\)/);
  assert.match(overdueSource, /bulkEditService\.updateFrontmatter\(\[item\.file\], \{ status: null \}\)/);
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
  assert.match(notificationViewSource, /tps-notification-title-link/);
  assert.match(notificationViewSource, /private openRenderedTitleLink/);
  assert.match(notificationViewSource, /event\.stopPropagation\(\)/);
  assert.match(notificationViewSource, /this\.app\.workspace\.openLinkText\(decodeURIComponent\(normalized\), sourcePath, false\)/);
  assert.doesNotMatch(notificationViewSource, /createEl\('span', \{ text: this\.getItemDisplayTitle\(item\) \}\)/);
});

test('task reminder entity status is derived from checkbox marker, not parent note status', () => {
  assert.match(reminderTargetSource, /const noteStatus = getFrontmatterValueCaseInsensitive\(frontmatter, "status"\)/);
  assert.match(reminderTargetSource, /noteStatus,/);
  assert.match(reminderTargetSource, /const parsedStatus = typeof properties\.status === "string" \? properties\.status\.trim\(\) : properties\.status/);
  assert.match(reminderTargetSource, /if \(parsedStatus\) properties\.inlineStatus = parsedStatus/);
  assert.match(reminderTargetSource, /properties\.status = markerStatus/);
  assert.match(reminderTargetSource, /properties\.checkboxStatus = markerStatus/);
  assert.match(reminderTargetSource, /properties\.taskStatus = markerStatus/);
  assert.match(reminderTargetSource, /if \(marker === "x"\) return "complete"/);
  assert.match(reminderTargetSource, /if \(marker === "-" \|\| marker === "~"\) return "wont-do"/);
  assert.match(reminderTargetSource, /props\[key] = value/);
  assert.match(reminderTargetSource, /props\[key\.toLowerCase\(\)] = value/);
  assert.match(reminderTargetSource, /\.\.\.frontmatter,\s+\.\.\.parsed\.properties,\s+noteStatus,/);
  assert.doesNotMatch(reminderTargetSource, /properties\.status = markerStatus !== "todo" \|\| !parsedStatus \? markerStatus : parsedStatus/);
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
  assert.match(overdueSource, /await this\.updateTaskLineProperties\(item, \{ \[property\]: null \}\)/);
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
  assert.match(overdueSource, /logger\.warn\("\[NotificationMove\] task line move source not found"/);
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
  assert.match(notificationViewSource, /private lastRenderedSignature = ''/);
  assert.match(notificationViewSource, /}, 750, false\)/);
  assert.match(notificationViewSource, /window\.setInterval\(\(\) => this\.refreshDebounced\(\), 30000\)/);
  assert.match(notificationViewSource, /if \(this\.isRefreshing\) \{/);
  assert.match(notificationViewSource, /this\.refreshPending = true/);
  assert.match(notificationViewSource, /buildItemsSignature/);
  assert.match(notificationViewSource, /nextSignature !== this\.lastRenderedSignature/);
  assert.match(notificationViewSource, /\[NotificationView\] slow refresh/);
});
