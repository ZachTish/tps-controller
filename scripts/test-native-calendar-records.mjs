import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

async function loadModule() {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('../src/services/native-calendar-record-service.ts', import.meta.url))],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
    plugins: [{
      name: 'obsidian-stub',
      setup(builder) {
        builder.onResolve({ filter: /^obsidian$/u }, () => ({ path: 'obsidian', namespace: 'native-calendar-test' }));
        builder.onLoad({ filter: /.*/, namespace: 'native-calendar-test' }, () => ({
          loader: 'js',
          contents: `export class App {} export class TFile { constructor(path) { this.path = path; this.name = path.split('/').pop(); this.basename = this.name.replace(/\\.md$/u, ''); this.extension = 'md'; } }`,
        }));
      },
    }],
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}

const { NativeCalendarRecordService } = await loadModule();

function futureDate(days, hour = 9) {
  const value = new Date();
  value.setHours(hour, 0, 0, 0);
  value.setDate(value.getDate() + days);
  return value;
}

function event(overrides = {}) {
  const startDate = overrides.startDate || futureDate(2);
  const endDate = overrides.endDate || new Date(startDate.getTime() + 30 * 60_000);
  return {
    id: 'uid-1-20260826T090000',
    uid: 'uid-1',
    occurrenceIdentity: 'uid-1',
    isRecurring: false,
    title: 'Standup',
    description: '',
    startDate,
    endDate,
    sourceUrl: 'https://calendar.example/team.ics',
    isAllDay: false,
    ...overrides,
  };
}

function harness(initialEvents = [], options = {}) {
  const files = new Map();
  const frontmatters = new Map();
  let events = initialEvents;
  let fetchOk = true;
  const api = {
    version: options.apiVersion || 1,
    isEnabled: () => true,
    async create(kind, properties, options = {}) {
      const id = String(options.id);
      const file = { path: `_records/calendar-events/${id}.md`, name: `${id}.md`, basename: id, extension: 'md' };
      const frontmatter = { ...properties, tpsId: id, tpsSchemaVersion: 1, kind, createdDate: new Date().toISOString(), modifiedDate: new Date().toISOString() };
      files.set(file.path, file);
      frontmatters.set(file.path, frontmatter);
      return { file, path: file.path, id, kind, frontmatter };
    },
    async update(reference, updates) {
      const path = typeof reference === 'string' ? reference : reference.path;
      const file = files.get(path);
      if (!file) return null;
      const frontmatter = { ...frontmatters.get(path), ...updates, modifiedDate: new Date().toISOString() };
      frontmatters.set(path, frontmatter);
      return { file, path, id: frontmatter.tpsId, kind: frontmatter.kind, frontmatter };
    },
    async archive(reference) {
      return this.update(reference, { archived: true, archivedDate: new Date().toISOString() });
    },
    inspect(frontmatter) {
      const identityTag = Array.isArray(frontmatter?.tags)
        ? frontmatter.tags.find((tag) => String(tag).startsWith('tps/record/v1/'))
        : null;
      if (!identityTag) return null;
      const [, , , kind, ...idParts] = String(identityTag).split('/');
      const id = idParts.join('/');
      return id && kind
        ? { id, kind, schemaVersion: 1, frontmatter: { ...frontmatter, tpsId: id, tpsSchemaVersion: 1, kind } }
        : null;
    },
  };
  const settings = { calendarStorageMode: 'native-records', syncOnEventDelete: 'nothing' };
  const app = {
    plugins: { getPlugin: (id) => id === 'tps-global-context-menu' ? { api: { nativeRecords: api } } : null },
    vault: {
      getMarkdownFiles: () => [...files.values()],
      on: () => ({}),
    },
    metadataCache: {
      getFileCache: (file) => ({ frontmatter: frontmatters.get(file.path) }),
      on: () => ({}),
    },
  };
  const external = {
    async fetchEventsWithStatus() {
      return { ok: fetchOk, events: fetchOk ? events : [], normalizedUrl: 'https://calendar.example/team.ics', fromCache: false };
    },
  };
  const service = new NativeCalendarRecordService(app, external, () => settings);
  service.setup(() => {});
  return {
    service,
    settings,
    files,
    frontmatters,
    api,
    setEvents: (value) => { events = value; },
    setFetchOk: (value) => { fetchOk = value; },
  };
}

test('Controller indexes API v2 tag-identified calendar records without physical ID/schema fields', () => {
  const h = harness([], { apiVersion: 2 });
  const file = { path: 'calendar-tagged.md', name: 'calendar-tagged.md', basename: 'calendar-tagged', extension: 'md' };
  h.service.indexFile(file, {
    tags: ['calendar', 'tps/record/v1/calendar-event/calendar-tagged'],
    title: 'Tagged event',
    calendarOccurrenceKey: 'work:uid:occurrence',
  });
  const indexed = h.service.recordsByPath.get(file.path);
  assert.equal(indexed?.id, 'calendar-tagged');
  assert.equal(indexed?.occurrenceKey, 'work:uid:occurrence');
});

const calendar = {
  id: 'work-calendar',
  url: 'https://calendar.example/team.ics',
  enabled: true,
  autoCreateEnabled: true,
  autoCreateTaskNoteStrategy: 'occurrence-day',
  autoCreateTaskNoteFolder: 'Calendar Events',
};

test('single calendar occurrence is idempotent and reschedules the same record', async () => {
  const firstEvent = event();
  const h = harness([firstEvent]);
  const first = await h.service.sync([calendar], '', true, false);
  assert.equal(first.created, 1);
  assert.equal(h.files.size, 1);
  const [path] = h.files.keys();
  const original = { ...h.frontmatters.get(path) };
  assert.match(original.title, /^\[\[Calendar Events\//u);
  assert.equal(original.eventTitle, 'Standup');
  const second = await h.service.sync([calendar], '', true, false);
  assert.equal(second.unchanged, 1);
  assert.equal(h.files.size, 1);

  const movedStart = futureDate(3, 11);
  h.setEvents([event({ startDate: movedStart, endDate: new Date(movedStart.getTime() + 45 * 60_000) })]);
  const moved = await h.service.sync([calendar], '', true, false);
  assert.equal(moved.updated, 1);
  assert.equal(h.files.size, 1, 'reschedule updates rather than duplicates');
  const current = h.frontmatters.get(path);
  assert.equal(current.scheduled, movedStart.toISOString());
  assert.notEqual(current.associatedNotePath, original.associatedNotePath, 'per-day note target follows the new day');
});

test('recurring occurrences remain separate while series note strategy shares one note', async () => {
  const left = event({
    id: 'uid-repeat-20260826T090000', uid: 'uid-repeat', occurrenceIdentity: 'uid-repeat-20260826T090000', isRecurring: true, startDate: futureDate(2),
  });
  const right = event({
    id: 'uid-repeat-20260827T090000', uid: 'uid-repeat', occurrenceIdentity: 'uid-repeat-20260827T090000', isRecurring: true, startDate: futureDate(3),
  });
  const h = harness([left, right]);
  const result = await h.service.sync([{ ...calendar, autoCreateTaskNoteStrategy: 'series' }], '', true, false);
  assert.equal(result.created, 2);
  const records = [...h.frontmatters.values()];
  assert.equal(new Set(records.map((value) => value.calendarOccurrenceKey)).size, 2);
  assert.equal(new Set(records.map((value) => value.associatedNotePath)).size, 1);
});

test('cancellations update in place and failed feeds never mark records missing', async () => {
  const h = harness([event()]);
  await h.service.sync([calendar], '', true, false);
  const [path] = h.files.keys();
  h.setEvents([event({ isCancelled: true })]);
  const cancelled = await h.service.sync([calendar], '', true, false);
  assert.equal(cancelled.cancelled, 1);
  assert.equal(h.frontmatters.get(path).status, 'cancelled');

  h.setFetchOk(false);
  h.setEvents([]);
  const failed = await h.service.sync([calendar], '', true, false);
  assert.equal(failed.failedFeeds, 1);
  assert.equal(h.frontmatters.get(path).calendarSyncState, 'cancelled');
  assert.equal(h.frontmatters.get(path).calendarMissingAt, undefined);
});

test('successful missing occurrence follows the authored archive policy', async () => {
  const h = harness([event()]);
  await h.service.sync([calendar], '', true, false);
  const [path] = h.files.keys();
  h.settings.syncOnEventDelete = 'archive';
  h.setEvents([]);
  const result = await h.service.sync([calendar], '', true, false);
  assert.equal(result.archived, 1);
  assert.equal(h.frontmatters.get(path).archived, true);
});
