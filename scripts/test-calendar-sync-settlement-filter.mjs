import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../src/services/calendar-sync-settlement-filter.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018 },
});

const module = { exports: {} };
const load = new Function('module', 'exports', compiled.outputText);
load(module, module.exports);

const { shouldDeferCalendarSyncSettlementForPath } = module.exports;

test('calendar sync settlement ignores Obsidian/plugin/internal paths', () => {
  const ignoredPaths = [
    '.obsidian/plugins/TPS-Calendar-Base (Dev)/data.json',
    '.obsidian/plugins/tps-controller/data.json',
    '.obsidian/workspace.json',
    '.tps/sync-requests/calendar.json',
    '.trash/Calendar.md',
    'Work.tps-line-bases--L14--13addce9.line.md',
    'Folder/Work.tps-line-bases--L14--13addce9.line.md',
  ];

  for (const path of ignoredPaths) {
    assert.equal(shouldDeferCalendarSyncSettlementForPath(path), false, path);
  }
});

test('calendar sync settlement still defers for real vault content', () => {
  const contentPaths = [
    'Calendar.md',
    'Inbox/Wed, Jun 24 2026.md',
    'Areas/Calendar.md',
    '_attachments/event.ics',
    'Projects/Obsidian plugins.md',
  ];

  for (const path of contentPaths) {
    assert.equal(shouldDeferCalendarSyncSettlementForPath(path), true, path);
  }
});

test('unrelated folder and asset modifies cannot push manual calendar readiness back', () => {
  let readyAt = 1000;
  let deferred = 0;
  const onModify = (path, isFile) => {
    if (!shouldDeferCalendarSyncSettlementForPath(path, 'file modify', isFile)) return;
    readyAt = 5000;
    deferred += 1;
  };
  onModify('_assets', false);
  onModify('_assets/queued-image.png', false);
  onModify('_assets/queue.json', false);
  onModify('_assets/queued-image.png', true);
  onModify('_assets/queue.json', true);
  assert.equal(readyAt, 1000);
  assert.equal(deferred, 0);
  assert.equal(readyAt < 2000, true, 'a manual sync remains ready after unrelated asset activity');

  onModify('Calendar/Meeting.md', true);
  assert.equal(readyAt, 5000);
  assert.equal(deferred, 1, 'a candidate calendar note still extends settlement');
});
