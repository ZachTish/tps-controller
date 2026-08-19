import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

function loadModule(url, requireImpl) {
  const sourceText = readFileSync(url, 'utf8');
  const compiled = ts.transpileModule(sourceText, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  const module = { exports: {} };
  new Function('module', 'exports', 'require', compiled.outputText)(module, module.exports, requireImpl);
  return module.exports;
}

const taskNotes = loadModule(
  new URL('../src/services/external-calendar-task-note.ts', import.meta.url),
  (specifier) => {
    if (specifier === 'obsidian') {
      return { normalizePath: (value) => String(value).replace(/\\/g, '/').replace(/\/{2,}/g, '/') };
    }
    if (specifier === '../utils') {
      return { normalizeCalendarUrl: (value) => String(value || '').trim().replace(/\/+$/, '') };
    }
    throw new Error(`Unexpected require: ${specifier}`);
  },
);

function event(overrides = {}) {
  return {
    id: 'series-uid-20260818T090000',
    uid: 'series-uid',
    title: 'Team standup',
    description: '',
    startDate: new Date(2026, 7, 18, 9, 0, 0),
    endDate: new Date(2026, 7, 18, 9, 30, 0),
    sourceUrl: 'https://calendar.example/team.ics/',
    isAllDay: false,
    ...overrides,
  };
}

test('occurrence-day links are deterministic per scheduled day and source identity', () => {
  const first = taskNotes.buildExternalCalendarTaskNoteLink(event(), 'occurrence-day', 'Calendar Events');
  const repeated = taskNotes.buildExternalCalendarTaskNoteLink(event(), 'occurrence-day', 'Calendar Events');
  const nextDay = taskNotes.buildExternalCalendarTaskNoteLink(event({
    id: 'series-uid-20260819T090000',
    startDate: new Date(2026, 7, 19, 9, 0, 0),
    endDate: new Date(2026, 7, 19, 9, 30, 0),
  }), 'occurrence-day', 'Calendar Events');

  assert.deepEqual(first, repeated);
  assert.match(first.notePath, /^Calendar Events\/2026-08-18\/Calendar event--[a-f0-9]{8}\.md$/);
  assert.notEqual(first.notePath, nextDay.notePath);
  assert.equal(first.markdown, `[[${first.notePath.slice(0, -3)}|Team standup]]`);
});

test('series links remain shared across recurring occurrence dates', () => {
  const first = taskNotes.buildExternalCalendarTaskNoteLink(event(), 'series', 'External Events');
  const nextDay = taskNotes.buildExternalCalendarTaskNoteLink(event({
    id: 'series-uid-20260819T090000',
    startDate: new Date(2026, 7, 19, 9, 0, 0),
    endDate: new Date(2026, 7, 19, 9, 30, 0),
  }), 'series', 'External Events');

  assert.equal(first.notePath, nextDay.notePath);
  assert.match(first.notePath, /^External Events\/Series\/Calendar event--[a-f0-9]{8}\.md$/);
  const renamed = taskNotes.buildExternalCalendarTaskNoteLink(event({
    title: 'Renamed standup',
  }), 'series', 'External Events');
  assert.equal(renamed.notePath, first.notePath);
  assert.match(renamed.markdown, /\|Renamed standup\]\]$/u);
});

test('source identity prevents equal-titled feeds from sharing a note', () => {
  const left = taskNotes.buildExternalCalendarTaskNoteLink(event(), 'series', 'Calendar Events');
  const right = taskNotes.buildExternalCalendarTaskNoteLink(event({
    sourceUrl: 'https://other.example/team.ics',
  }), 'series', 'Calendar Events');
  assert.notEqual(left.notePath, right.notePath);
});

test('existing association paths win and aliases are escaped without unsafe filenames', () => {
  const link = taskNotes.buildExternalCalendarTaskNoteLink(event({
    title: 'Planning | review ] #next',
  }), 'series', '/Calendar Events/', 'Existing/Canonical meeting.md');

  assert.equal(link.notePath, 'Existing/Canonical meeting.md');
  assert.equal(link.markdown, '[[Existing/Canonical meeting|Planning \\| review \\] #next]]');
});

test('occurrence-day reschedules replace an association from the prior day', () => {
  const link = taskNotes.buildExternalCalendarTaskNoteLink(
    event({ startDate: new Date(2026, 7, 19, 9, 0, 0) }),
    'occurrence-day',
    'Calendar Events',
    'Calendar Events/2026-08-18/Team standup--deadbeef.md',
  );
  assert.match(link.notePath, /^Calendar Events\/2026-08-19\//u);
  assert.doesNotMatch(link.notePath, /deadbeef/u);
});

test('invalid strategies and empty folders normalize to safe defaults', () => {
  assert.equal(taskNotes.normalizeExternalCalendarTaskNoteStrategy('unknown'), 'occurrence-day');
  assert.equal(taskNotes.normalizeExternalCalendarTaskNoteStrategy('series'), 'series');
  assert.equal(taskNotes.normalizeExternalCalendarTaskNoteFolder(''), 'Calendar Events');
});
