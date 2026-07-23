import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

function loadTypeScriptModule(url) {
  const source = readFileSync(url, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018 },
  });
  const module = { exports: {} };
  new Function('module', 'exports', compiled.outputText)(module, module.exports);
  return module.exports;
}

const helper = loadTypeScriptModule(new URL('../src/services/external-calendar-cancellation.ts', import.meta.url));
const parserSource = readFileSync(new URL('../src/services/ical-parser-service.ts', import.meta.url), 'utf8');
const autoCreateSource = readFileSync(new URL('../src/services/auto-create-service.ts', import.meta.url), 'utf8');

test('recognizes Outlook cancellation summary prefixes without false positives', () => {
  for (const title of [
    'Canceled: Leadership Book Club',
    'Cancelled: Leadership Book Club',
    '  CANCELED : Leadership Book Club',
  ]) {
    assert.equal(helper.isCancelledCalendarTitle(title), true, title);
  }
  for (const title of ['Cancel: Leadership Book Club', 'Canceled appointment follow-up', '', null]) {
    assert.equal(helper.isCancelledCalendarTitle(title), false, String(title));
  }
});

test('cancels only open inline task checkboxes', () => {
  assert.equal(helper.cancelOpenInlineTaskLine('- [ ] Canceled: Event [scheduled:: 2026-08-19]'), '- [-] Canceled: Event [scheduled:: 2026-08-19]');
  assert.equal(helper.cancelOpenInlineTaskLine('- [x] Already completed'), null);
  assert.equal(helper.cancelOpenInlineTaskLine('- [-] Already cancelled'), null);
});

test('parser and auto-create reconciliation route use the cancellation helpers', () => {
  assert.match(parserSource, /isCancelledCalendarTitle\(summary\)/);
  assert.match(autoCreateSource, /match\.isInlineTask/);
  assert.match(autoCreateSource, /markInlineTaskCancelled\(match, event\)/);
  assert.match(autoCreateSource, /mutateExternalTaskLineContent\(/);
  assert.match(autoCreateSource, /cancelOpenInlineTaskLine\(line\) \|\| line/);
  assert.match(autoCreateSource, /event:cancelled-inline-task-skipped/);
});
