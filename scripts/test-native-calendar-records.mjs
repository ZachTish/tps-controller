import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', { value: webcrypto });

async function loadModule() {
  const result = await build({
    stdin: { contents: "export * from './src/services/native-calendar-record-service.ts'; export * from './src/services/ical-parser-service.ts';", resolveDir: process.cwd(), loader: 'ts' },
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
          resolveDir: process.cwd(),
          contents: `export const moment = {}; import { load } from 'js-yaml'; export const parseYaml = load; export const normalizePath = value => value.replace(/\\\\/g, '/'); export class App {} export class TFile { static [Symbol.hasInstance](value) { return value?.extension === 'md' && typeof value.path === 'string'; } constructor(path) { this.path = path; this.name = path.split('/').pop(); this.basename = this.name.replace(/\\.md$/u, ''); this.extension = 'md'; } }`,
        }));
      },
    }],
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}

async function loadSettingsModule() {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('../src/services/settings-persistence.ts', import.meta.url))],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}

const {
  NativeCalendarRecordService,
  ICalParserService,
  REDUNDANT_CALENDAR_RECORD_PROPERTIES,
  buildNativeCalendarRecordFileName,
} = await loadModule();
const { legacyCalendarConfigIdForUrl, normalizeExternalCalendarsInPlace } = await loadSettingsModule();

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

const calendar = {
  id: 'work-calendar',
  url: 'https://calendar.example/team.ics',
  enabled: true,
  autoCreateEnabled: true,
  autoCreateTaskNoteStrategy: 'occurrence-day',
  autoCreateTaskNoteFolder: 'Calendar Events',
};

function canonicalId(configId, occurrenceIdentity) {
  const source = createHash('sha256').update(configId).digest().subarray(0, 12).toString('base64url');
  const occurrence = createHash('sha256').update(`${configId}\0${occurrenceIdentity}`).digest().subarray(0, 20).toString('base64url');
  return `calendar:v1:${source}:${occurrence}`;
}

function makeFile(path) {
  const name = path.split('/').pop();
  return {
    path,
    name,
    basename: name.replace(/\.md$/u, ''),
    extension: 'md',
    stat: { ctime: 1_700_000_000_000, mtime: 1_700_000_001_000 },
  };
}

function recordLink(path, alias) {
  const target = path.replace(/\.md$/u, '').replace(/([#^|\]])/gu, '\\$1');
  const label = alias.replace(/\|/gu, '\\|').replace(/\]/gu, '\\]');
  return `[[${target}|${label}]]`;
}

function harness(initialEvents = [], options = {}) {
  const files = new Map();
  const frontmatters = new Map();
  const bodies = new Map();
  const templates = new Map(Object.entries(options.templates || {}).map(([path, source]) => [path, { file: makeFile(path), source }]));
  const feedStates = new Map();
  const mutationLog = [];
  const preflightLog = [];
  const blockedIds = new Set((options.blockedIds || []).map((value) => value.toLocaleLowerCase()));
  const conflictingStorageKeys = new Set((options.conflictingStorageKeys || []).map((value) => value.toLocaleLowerCase()));
  const cacheNullPaths = new Set(options.cacheNullPaths || []);
  let authoritativeToken = 0;
  let mutationRevision = 0;
  let fetchHook = null;
  let afterSnapshotHook = null;
  let afterPreflightHook = null;
  let afterBatchEntryHook = null;
  let afterAuthoritativeRebuildHook = null;
  let metadataChangedListener = null;
  let settingsSaveCount = 0;
  let failSettingsSave = false;
  const settings = {
    calendarStorageMode: 'native-records',
    syncOnEventDelete: 'nothing',
    canceledStatusValue: 'cancelled',
    nativeCalendarCancellationState: {},
  };
  feedStates.set(calendar.url, { ok: true, events: initialEvents });

  const identity = (frontmatter) => {
    const propertyId = String(frontmatter?.tpsId || '').trim();
    if (propertyId) return { id: propertyId, kind: /^calendar:v1:[A-Za-z0-9_-]{16}:[A-Za-z0-9_-]{27}$/u.test(propertyId) ? 'calendar-event' : String(frontmatter.kind || ''), schemaVersion: 1 };
    const identityTag = Array.isArray(frontmatter?.tags)
      ? frontmatter.tags.find((tag) => String(tag).startsWith('tps/record/v1/'))
      : null;
    if (!identityTag) return null;
    const [, , , kind, ...idParts] = String(identityTag).split('/');
    const encodedId = idParts.join('/');
    const id = encodedId.startsWith('hex-')
      ? Buffer.from(encodedId.slice(4), 'hex').toString('utf8')
      : encodedId;
    return id && kind ? { id, kind, schemaVersion: 1 } : null;
  };

  const resolvePath = (reference) => {
    if (reference && typeof reference === 'object' && reference.path) return files.has(reference.path) ? reference.path : null;
    const raw = String(reference || '');
    if (files.has(raw)) return raw;
    const matches = [...frontmatters.entries()]
      .filter(([, frontmatter]) => identity(frontmatter)?.id.toLocaleLowerCase() === raw.toLocaleLowerCase())
      .map(([path]) => path);
    return matches.length === 1 ? matches[0] : null;
  };

  const toHandle = (path) => {
    const file = files.get(path);
    const frontmatter = frontmatters.get(path);
    const inspected = identity(frontmatter);
    return file && inspected
      ? {
        file,
        path,
        id: inspected.id,
        kind: inspected.kind,
        frontmatter: {
          ...frontmatter,
          tpsId: inspected.id,
          tpsSchemaVersion: 1,
          createdDate: new Date(file.stat.ctime).toISOString(),
          modifiedDate: new Date(file.stat.mtime).toISOString(),
        },
      }
      : null;
  };

  const isFreeIdentity = (nextId, sourcePath = null) => {
    if (!nextId || blockedIds.has(nextId.toLocaleLowerCase())) return false;
    const owners = [...frontmatters.entries()]
      .filter(([, frontmatter]) => identity(frontmatter)?.id.toLocaleLowerCase() === nextId.toLocaleLowerCase())
      .map(([path]) => path);
    return owners.length === 0 || (owners.length === 1 && owners[0] === sourcePath);
  };

  const authoritativeHandles = (kind) => {
    const handles = [...files.keys()]
      .map((path) => toHandle(path))
      .filter((handle) => handle && (!kind || handle.kind === kind));
    const owners = new Set();
    for (const handle of handles) {
      const key = handle.id.toLocaleLowerCase();
      if (owners.has(key)) throw new Error(`authoritative native-record list rejected duplicate identity ${handle.id}`);
      if (blockedIds.has(key)) throw new Error(`authoritative native-record list rejected blocked identity ${handle.id}`);
      owners.add(key);
    }
    return handles;
  };

  const payloadIsValid = (payload) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
    if (Object.keys(payload).some((key) => conflictingStorageKeys.has(key.toLocaleLowerCase()))) return false;
    const tags = Array.isArray(payload.tags) ? payload.tags : [payload.tags];
    return !tags.some((tag) => String(tag || '').replace(/^#+/u, '').toLocaleLowerCase().startsWith('tps/record/v1/'));
  };

  const validateIdentityEntries = (entries, snapshotToken) => {
    if (snapshotToken !== undefined && snapshotToken !== authoritativeToken) return false;
    const destinations = new Set();
    const sources = new Set();
    for (const entry of entries) {
      const nextId = String(entry?.nextId || '');
      const key = nextId.toLocaleLowerCase();
      if (!nextId || destinations.has(key)) return false;
      destinations.add(key);
      if (entry.operation === 'create') {
        if (entry.kind !== 'calendar-event' || !payloadIsValid(entry.properties) || !isFreeIdentity(nextId)) return false;
        continue;
      }
      const path = resolvePath(entry.reference);
      if (entry.operation !== 'reidentify'
        || !path
        || sources.has(path)
        || !Array.isArray(entry.updates)
        || entry.updates.some((updates) => !payloadIsValid(updates))
        || !isFreeIdentity(nextId, path)) return false;
      sources.add(path);
      const frontmatter = frontmatters.get(path) || {};
      for (const updates of entry.updates) {
        for (const updateKey of Object.keys(updates)) {
          const normalized = String(updateKey).trim().toLocaleLowerCase();
          const matches = Object.keys(frontmatter)
            .filter((sourceKey) => sourceKey.trim().toLocaleLowerCase() === normalized);
          if (matches.length > 1) return false;
        }
      }
    }
    return true;
  };

  const preferredRecordPath = (entry) => {
    const root = String(options.nativeRoot || '').replace(/^\/+|\/+$/gu, '');
    const segments = [root];
    if (options.nativeLayout === 'kind-folders') segments.push(entry.kind === 'calendar-event' ? 'calendar-events' : String(entry.kind || 'calendar-events'));
    let basename = String(entry.fileName || entry.nextId || '')
      .trim()
      .replace(/\.md$/iu, '')
      .replace(/\s+/gu, ' ')
      .replace(/[\\/:*?"<>|#^\[\]]+/gu, '-')
      .replace(/\.{2,}/gu, '-')
      .replace(/^[.\s-]+|[.\s-]+$/gu, '')
      .slice(0, 180);
    basename = options.resolveCreateBasename?.(basename) || basename;
    return [...segments.filter(Boolean), `${basename}.md`].join('/');
  };

  const allocatePath = (preferred, occupiedPaths) => {
    if (!occupiedPaths.has(preferred)) return preferred;
    const stem = preferred.replace(/\.md$/iu, '');
    for (let suffix = 2; suffix <= 999; suffix += 1) {
      const candidate = `${stem} (${suffix}).md`;
      if (!occupiedPaths.has(candidate)) return candidate;
    }
    throw new Error(`unable to allocate ${preferred}`);
  };

  const allocateIdentityPaths = (entries) => {
    const occupiedPaths = new Set(files.keys());
    const planned = [];
    for (const entry of entries) {
      if (entry.operation === 'create') {
        const expectedPath = allocatePath(preferredRecordPath(entry), occupiedPaths);
        occupiedPaths.add(expectedPath);
        planned.push({ operation: entry.operation, nextId: entry.nextId, expectedPath });
        continue;
      }
      const sourcePath = resolvePath(entry.reference);
      if (!sourcePath) return null;
      let expectedPath = sourcePath;
      if (entry.fileName !== undefined) {
        occupiedPaths.delete(sourcePath);
        const kind = identity(frontmatters.get(sourcePath))?.kind || 'calendar-event';
        const pathEntry = { ...entry, kind };
        expectedPath = allocatePath(preferredRecordPath(pathEntry), occupiedPaths);
      }
      occupiedPaths.add(expectedPath);
      planned.push({ operation: entry.operation, nextId: entry.nextId, expectedPath });
    }
    return planned;
  };

  const applyUpdates = (frontmatter, updates) => {
    const next = { ...frontmatter };
    for (const [key, value] of Object.entries(updates)) {
      const matches = Object.keys(next).filter((candidate) => candidate.toLocaleLowerCase() === key.toLocaleLowerCase());
      for (const match of matches) delete next[match];
      if (value !== null && value !== undefined) next[key] = structuredClone(value);
    }
    return next;
  };

  const canonicalizeEnvelope = (frontmatter, id, kind) => {
    const next = { ...frontmatter, tpsId: id };
    if (!/^calendar:v1:[A-Za-z0-9_-]{16}:[A-Za-z0-9_-]{27}$/u.test(id)) next.kind = kind;
    for (const key of Object.keys(next)) {
      if (['tpsschemaversion', 'createddate', 'modifieddate'].includes(key.toLocaleLowerCase())) delete next[key];
    }
    if (Array.isArray(next.tags)) {
      next.tags = next.tags.filter((tag) => !String(tag).replace(/^#+/u, '').toLocaleLowerCase().startsWith('tps/record/v1/'));
      if (!next.tags.length) delete next.tags;
    }
    return next;
  };

  const api = {
    version: Object.hasOwn(options, 'apiVersion') ? options.apiVersion : 6,
    capabilities: { calendarTemplateRecords: options.calendarTemplateRecords !== false },
    isEnabled: () => true,
    inspect(frontmatter) {
      const inspected = identity(frontmatter);
      return inspected?.id && inspected.kind && inspected.schemaVersion === 1
        ? {
          ...inspected,
          frontmatter: { ...frontmatter, tpsId: inspected.id, tpsSchemaVersion: 1 },
          profile: { identityTagPrefix: 'tps/record' },
        }
        : null;
    },
    async list(kind) {
      return authoritativeHandles(kind);
    },
    async snapshot() {
      const snapshot = { token: authoritativeToken, revision: mutationRevision, records: authoritativeHandles() };
      const hook = afterSnapshotHook;
      afterSnapshotHook = null;
      if (hook) await hook();
      return snapshot;
    },
    async resolve(reference) {
      const path = resolvePath(reference);
      return path ? toHandle(path) : null;
    },
    async canApplyIdentityPlan(entries, snapshotToken) {
      preflightLog.push({ entries: structuredClone(entries), snapshotToken });
      if (!validateIdentityEntries(entries, snapshotToken)) return false;
      const hook = afterPreflightHook;
      afterPreflightHook = null;
      if (hook) await hook();
      return true;
    },
    async planIdentityChanges(entries, snapshot) {
      preflightLog.push({
        entries: structuredClone(entries),
        snapshotToken: snapshot?.token,
        snapshotRevision: snapshot?.revision,
      });
      if (snapshot?.revision !== mutationRevision || !validateIdentityEntries(entries, snapshot?.token)) return null;
      const plannedEntries = allocateIdentityPaths(entries);
      if (!plannedEntries) return null;
      const planned = {
        token: snapshot.token,
        revision: snapshot.revision,
        entries: plannedEntries,
      };
      const hook = afterPreflightHook;
      afterPreflightHook = null;
      if (hook) await hook();
      return planned;
    },
    async applyIdentityChanges(plannedBatch, entries) {
      const failed = (handles, failedIndex, error) => ({ ok: false, handles, failedIndex, error });
      if (plannedBatch?.token !== authoritativeToken || plannedBatch?.revision !== mutationRevision) {
        return failed([], null, 'stale-plan');
      }
      if (!validateIdentityEntries(entries, plannedBatch.token)) return failed([], null, 'plan-revalidation-failed');
      const rebound = allocateIdentityPaths(entries);
      if (!rebound || JSON.stringify(rebound) !== JSON.stringify(plannedBatch.entries)) {
        return failed([], null, 'plan-revalidation-failed');
      }

      const nextFiles = new Map([...files.entries()].map(([path, file]) => [path, makeFile(file.path)]));
      const nextFrontmatters = new Map([...frontmatters.entries()].map(([path, frontmatter]) => [path, structuredClone(frontmatter)]));
      const pendingMutations = [];
      const handles = [];
      const commitPendingState = () => {
        files.clear();
        frontmatters.clear();
        for (const [path, file] of nextFiles) files.set(path, file);
        for (const [path, frontmatter] of nextFrontmatters) frontmatters.set(path, frontmatter);
        mutationLog.push(...pendingMutations.splice(0));
      };
      const interruptAfterCommittedEntry = async (index) => {
        const hook = afterBatchEntryHook;
        if (!hook) return null;
        afterBatchEntryHook = null;
        commitPendingState();
        await hook({ index, handle: handles[index] });
        mutationRevision += 1;
        return failed(handles, Math.min(index + 1, entries.length - 1), 'external-interruption');
      };
      const resolveNextPath = (reference) => {
        const raw = String(reference?.path || reference || '');
        if (nextFiles.has(raw)) return raw;
        const matches = [...nextFrontmatters.entries()]
          .filter(([, frontmatter]) => identity(frontmatter)?.id.toLocaleLowerCase() === raw.toLocaleLowerCase())
          .map(([path]) => path);
        return matches.length === 1 ? matches[0] : null;
      };
      for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index];
        const expectedPath = plannedBatch.entries[index].expectedPath;
        if (entry.operation === 'create') {
          const file = makeFile(expectedPath);
          const frontmatter = canonicalizeEnvelope(structuredClone(entry.properties), entry.nextId, entry.kind);
          nextFiles.set(expectedPath, file);
          nextFrontmatters.set(expectedPath, frontmatter);
          bodies.set(expectedPath, entry.body || '');
          pendingMutations.push({ type: 'create', id: entry.nextId, path: expectedPath });
          handles.push({ file, path: expectedPath, id: entry.nextId, kind: entry.kind, frontmatter: { ...frontmatter } });
          const interrupted = await interruptAfterCommittedEntry(index);
          if (interrupted) return interrupted;
          continue;
        }
        const sourcePath = resolveNextPath(entry.reference);
        if (!sourcePath) return failed(handles, index, 'reidentify-failed');
        const inspected = identity(nextFrontmatters.get(sourcePath));
        if (!inspected) return failed(handles, index, 'reidentify-failed');
        let frontmatter = { ...nextFrontmatters.get(sourcePath) };
        const priorId = inspected.id;
        let changed = priorId.toLocaleLowerCase() !== entry.nextId.toLocaleLowerCase();
        frontmatter = canonicalizeEnvelope(frontmatter, entry.nextId, inspected.kind);
        if (priorId.toLocaleLowerCase() !== entry.nextId.toLocaleLowerCase()) {
          pendingMutations.push({ type: 'reidentify', path: sourcePath, nextId: entry.nextId });
        }
        for (const updates of entry.updates) {
          if (!Object.keys(updates).length) continue;
          frontmatter = applyUpdates(frontmatter, updates);
          changed = true;
          pendingMutations.push({ type: 'update', path: sourcePath, updates: structuredClone(updates) });
        }
        if (sourcePath !== expectedPath) changed = true;
        const file = nextFiles.get(sourcePath);
        nextFiles.delete(sourcePath);
        nextFrontmatters.delete(sourcePath);
        Object.assign(file, makeFile(expectedPath));
        nextFiles.set(expectedPath, file);
        nextFrontmatters.set(expectedPath, frontmatter);
        if (sourcePath !== expectedPath && bodies.has(sourcePath)) {
          bodies.set(expectedPath, bodies.get(sourcePath));
          bodies.delete(sourcePath);
        }
        if (sourcePath !== expectedPath) pendingMutations.push({ type: 'rename', oldPath: sourcePath, nextPath: expectedPath });
        handles.push({ file, path: expectedPath, id: entry.nextId, kind: inspected.kind, frontmatter: { ...frontmatter } });
        const interrupted = await interruptAfterCommittedEntry(index);
        if (interrupted) return interrupted;
      }
      commitPendingState();
      mutationRevision += 1;
      return { ok: true, handles, failedIndex: null };
    },
    async canReidentify(reference, nextId) {
      const path = resolvePath(reference);
      preflightLog.push({ reference, nextId, path });
      return Boolean(path) && isFreeIdentity(String(nextId || ''), path);
    },
    async create(kind, properties, createOptions = {}) {
      const id = String(createOptions.id || '');
      if (!isFreeIdentity(id)) throw new Error('identity collision');
      mutationLog.push({ type: 'create', id: createOptions.id });
      const requestedBasename = String(createOptions.fileName || id);
      const basename = options.resolveCreateBasename?.(requestedBasename) || requestedBasename;
      const file = makeFile(`${basename}.md`);
      const frontmatter = canonicalizeEnvelope(properties, id, kind);
      files.set(file.path, file);
      frontmatters.set(file.path, frontmatter);
      authoritativeToken += 1;
      mutationRevision += 1;
      return toHandle(file.path);
    },
    async update(reference, updates) {
      const path = resolvePath(reference);
      if (!path) return null;
      mutationLog.push({ type: 'update', path, updates: { ...updates } });
      const frontmatter = { ...frontmatters.get(path) };
      for (const [key, value] of Object.entries(updates)) {
        const actual = Object.keys(frontmatter).find((candidate) => candidate.toLocaleLowerCase() === key.toLocaleLowerCase());
        if (value === null || value === undefined) {
          if (actual) delete frontmatter[actual];
        } else {
          frontmatter[actual || key] = value;
        }
      }
      frontmatters.set(path, frontmatter);
      authoritativeToken += 1;
      mutationRevision += 1;
      return toHandle(path);
    },
    async reidentify(reference, nextId) {
      const path = resolvePath(reference);
      if (!path || !isFreeIdentity(nextId, path)) return null;
      mutationLog.push({ type: 'reidentify', path, nextId });
      let frontmatter = { ...frontmatters.get(path) };
      const inspected = identity(frontmatter);
      frontmatter = canonicalizeEnvelope(frontmatter, nextId, inspected.kind);
      frontmatters.set(path, frontmatter);
      authoritativeToken += 1;
      mutationRevision += 1;
      return toHandle(path);
    },
    async rename(reference, fileName) {
      const oldPath = resolvePath(reference);
      if (!oldPath) return null;
      const file = files.get(oldPath);
      const frontmatter = frontmatters.get(oldPath);
      const resolvedBasename = options.resolveRenameBasename?.(fileName, oldPath) || fileName;
      const nextPath = `${resolvedBasename}.md`;
      if (nextPath === oldPath) return toHandle(oldPath);
      mutationLog.push({ type: 'rename', oldPath, nextPath });
      files.delete(oldPath);
      frontmatters.delete(oldPath);
      Object.assign(file, makeFile(nextPath));
      files.set(nextPath, file);
      frontmatters.set(nextPath, frontmatter);
      authoritativeToken += 1;
      mutationRevision += 1;
      return toHandle(nextPath);
    },
    async archive(reference) {
      const path = resolvePath(reference);
      if (!path) return null;
      mutationLog.push({ type: 'archive', path });
      const frontmatter = { ...frontmatters.get(path), archived: true, archivedDate: new Date().toISOString() };
      frontmatters.set(path, frontmatter);
      authoritativeToken += 1;
      mutationRevision += 1;
      return toHandle(path);
    },
  };

  const app = {
    plugins: {
      getPlugin: (id) => id === 'tps-global-context-menu'
        ? {
            api: {
              nativeRecords: api,
              templates: {
                version: 1,
                canAutomaticallyMutate: options.canAutomaticallyMutate || (() => true),
                prepareInstanceSource: options.prepareInstanceSource || ((source) => source),
              },
            },
          }
        : null,
    },
    vault: {
      getMarkdownFiles: () => [...files.values()],
      getAbstractFileByPath: (path) => files.get(path) || templates.get(path)?.file || null,
      getFileByPath: (path) => files.get(path) || null,
      read: async (file) => {
        if (!templates.has(file.path)) throw new Error('template-read-failed');
        return templates.get(file.path).source;
      },
      on: () => ({}),
    },
    metadataCache: {
      getFileCache: (file) => cacheNullPaths.has(file.path)
        ? null
        : { frontmatter: frontmatters.get(file.path) },
      getFirstLinkpathDest: (target) => files.get(target.endsWith('.md') ? target : `${target}.md`) || null,
      on: (eventName, listener) => {
        if (eventName === 'changed') metadataChangedListener = listener;
        return {};
      },
    },
  };
  const external = {
    async fetchEventsWithStatus(url) {
      if (fetchHook) return fetchHook(url);
      const state = feedStates.get(url) || { ok: true, events: [] };
      return { ok: state.ok, events: state.ok ? state.events : [], normalizedUrl: url, fromCache: false };
    },
  };
  const service = new NativeCalendarRecordService(app, external, () => settings, async () => {
    settingsSaveCount += 1;
    // Controller's real saveSettings() normalizes this map before persistence,
    // replacing its object reference even when the entries are unchanged.
    settings.nativeCalendarCancellationState = structuredClone(settings.nativeCalendarCancellationState);
    if (failSettingsSave) throw new Error('settings-save-failed');
  });
  service.setup(() => {});
  const rebuildFromHandles = service.rebuildFromHandles.bind(service);
  service.rebuildFromHandles = (handles) => {
    rebuildFromHandles(handles);
    const hook = afterAuthoritativeRebuildHook;
    afterAuthoritativeRebuildHook = null;
    if (hook) hook();
  };

  const seedRecord = (path, frontmatter) => {
    const file = makeFile(path);
    files.set(path, file);
    frontmatters.set(path, { ...frontmatter });
    authoritativeToken += 1;
    mutationRevision += 1;
    service.indexFile(file, frontmatters.get(path));
    return file;
  };
  const seedRecordOnDisk = (path, frontmatter) => {
    const file = makeFile(path);
    files.set(path, file);
    frontmatters.set(path, { ...frontmatter });
    authoritativeToken += 1;
    mutationRevision += 1;
    return file;
  };
  const seedPlainFile = (path) => {
    const file = makeFile(path);
    files.set(path, file);
    mutationRevision += 1;
    return file;
  };
  return {
    service,
    settings,
    files,
    frontmatters,
    bodies,
    mutationLog,
    preflightLog,
    api,
    get settingsSaveCount() { return settingsSaveCount; },
    seedRecord,
    seedRecordOnDisk,
    seedPlainFile,
    deleteRecord: (path) => {
      files.delete(path);
      frontmatters.delete(path);
      authoritativeToken += 1;
      mutationRevision += 1;
    },
    mutateBusinessFieldOnDisk: (path, updates) => {
      const frontmatter = frontmatters.get(path);
      if (!frontmatter) throw new Error(`missing frontmatter at ${path}`);
      frontmatters.set(path, applyUpdates(frontmatter, updates));
      mutationRevision += 1;
    },
    setFeed: (url, events, ok = true) => feedStates.set(url, { ok, events }),
    setEvents: (events) => feedStates.set(calendar.url, { ok: true, events }),
    setFetchOk: (ok) => feedStates.set(calendar.url, { ok, events: feedStates.get(calendar.url)?.events || [] }),
    setFetchHook: (hook) => { fetchHook = hook; },
    setAfterSnapshotHook: (hook) => { afterSnapshotHook = hook; },
    setAfterPreflightHook: (hook) => { afterPreflightHook = hook; },
    setAfterBatchEntryHook: (hook) => { afterBatchEntryHook = hook; },
    setAfterAuthoritativeRebuildHook: (hook) => { afterAuthoritativeRebuildHook = hook; },
    setFailSettingsSave: (value) => { failSettingsSave = value; },
    emitMetadataChanged: (path, frontmatter) => {
      const file = files.get(path);
      if (!file || !metadataChangedListener) throw new Error(`cannot emit MetadataCache changed for ${path}`);
      metadataChangedListener(file, '', { frontmatter: structuredClone(frontmatter) });
    },
  };
}

function legacyFrontmatter(overrides = {}) {
  const occurrenceIdentity = overrides.calendarOccurrenceIdentity || 'uid-1';
  const path = overrides.path || '2026-08-26 - Standup.md';
  return {
    tpsId: overrides.tpsId || 'calendar-old32bit',
    tpsSchemaVersion: 1,
    kind: 'calendar-event',
    title: recordLink(path, 'Standup'),
    eventTitle: 'Standup',
    status: 'complete',
    scheduled: futureDate(2).toISOString(),
    end: futureDate(2).toISOString(),
    durationMinutes: 30,
    allDay: false,
    description: 'Keep this business content',
    location: '',
    organizer: '',
    attendees: [],
    url: '',
    color: '#123456',
    calendarId: calendar.id,
    calendarSourceId: 'old-source-hash',
    calendarUid: 'uid-1',
    calendarOccurrenceId: 'uid-1-20260826T090000',
    calendarOccurrenceIdentity: occurrenceIdentity,
    calendarOccurrenceKey: `${calendar.id}:old-source-hash:${occurrenceIdentity}`,
    calendarRecurring: false,
    calendarSyncState: 'current',
    calendarMissingAt: '2026-08-01T00:00:00.000Z',
    associatedNote: '[[Calendar Events/2026-08-26/Calendar event--deadbeef]]',
    associatedNotePath: 'Calendar Events/2026-08-26/Calendar event--deadbeef.md',
    associatedNoteStrategy: 'occurrence-day',
    tags: ['calendar-event'],
    ...overrides,
  };
}

function canonicalFrontmatter(calendarEvent, id, path, overrides = {}) {
  return {
    tpsId: id,
    kind: 'calendar-event',
    title: calendarEvent.title,
    status: 'scheduled',
    scheduled: calendarEvent.startDate.toISOString(),
    end: calendarEvent.endDate.toISOString(),
    ...(calendarEvent.isAllDay ? { allDay: true } : {}),
    ...(calendarEvent.description ? { description: calendarEvent.description } : {}),
    ...(calendarEvent.location ? { location: calendarEvent.location } : {}),
    ...(calendarEvent.organizer ? { organizer: calendarEvent.organizer } : {}),
    ...(calendarEvent.attendees?.length ? { attendees: calendarEvent.attendees } : {}),
    ...(calendarEvent.url ? { url: calendarEvent.url } : {}),
    ...overrides,
  };
}

function assertNoRedundantFields(frontmatter) {
  for (const key of REDUNDANT_CALENDAR_RECORD_PROPERTIES) {
    assert.equal(Object.hasOwn(frontmatter, key), false, `${key} must not be persisted`);
  }
}

function assertNoPhysicalVirtualFields(frontmatter) {
  for (const key of ['tpsSchemaVersion', 'createdDate', 'modifiedDate']) {
    assert.equal(Object.hasOwn(frontmatter, key), false, `${key} must remain virtual`);
  }
}

function plannedUpdateKeys(entry) {
  return (entry?.updates || []).flatMap((updates) => Object.keys(updates));
}

test('canonical IDs are deterministic, privacy-safe, URL-independent, and contain the only persisted calendar identity', async () => {
  const firstEvent = event();
  const h = harness([firstEvent]);
  const first = await h.service.sync([calendar], '', true, false);
  assert.equal(first.created, 1);
  assert.equal(h.files.size, 1);
  const [path] = h.files.keys();
  const original = h.frontmatters.get(path);
  assert.equal(original.tpsId, canonicalId(calendar.id, firstEvent.occurrenceIdentity));
  assert.match(original.tpsId, /^calendar:v1:[A-Za-z0-9_-]{16}:[A-Za-z0-9_-]{27}$/u);
  assert.equal(original.tpsId.includes('work-calendar'), false);
  assert.equal(original.tpsId.includes('uid-1'), false);
  assertNoRedundantFields(original);
  assertNoPhysicalVirtualFields(original);
  assert.equal(Object.hasOwn(original, 'associatedNote'), false);
  assert.equal(original.title, firstEvent.title);
  assert.equal(Object.hasOwn(original, 'allDay'), false);
  assert.equal(Object.hasOwn(original, 'description'), false);
  assert.equal(Object.hasOwn(original, 'location'), false);
  assert.equal(Object.hasOwn(original, 'organizer'), false);
  assert.equal(Object.hasOwn(original, 'attendees'), false);
  assert.equal(Object.hasOwn(original, 'url'), false);
  assert.equal(Object.hasOwn(original, 'tags'), false);
  assert.deepEqual(Object.keys(original).sort(), ['end', 'scheduled', 'status', 'title', 'tpsId']);
  const projected = await h.api.resolve(original.tpsId);
  assert.equal(projected.frontmatter.tpsSchemaVersion, 1);
  assert.equal(projected.frontmatter.createdDate, '2023-11-14T22:13:20.000Z');
  assert.equal(projected.frontmatter.modifiedDate, '2023-11-14T22:13:21.000Z');

  const movedStart = futureDate(4, 13);
  h.setEvents([event({
    sourceUrl: 'https://rotated.example/private-token.ics',
    startDate: movedStart,
    endDate: new Date(movedStart.getTime() + 45 * 60_000),
  })]);
  const moved = await h.service.sync([{ ...calendar, url: calendar.url }], '', true, false);
  assert.equal(moved.created, 0);
  assert.equal(h.files.size, 1);
  const [movedPath] = h.files.keys();
  assert.equal(h.frontmatters.get(movedPath).tpsId, original.tpsId);
  assert.equal(h.frontmatters.get(movedPath).scheduled, movedStart.toISOString());
  assert.notEqual(movedPath, path);

  const repeat = await h.service.sync([calendar], '', true, false);
  assert.equal(repeat.created, 0);
  assert.equal(repeat.updated, 0);
  assert.equal(repeat.unchanged, 1);
});

test('equal occurrence UIDs are unlinkable across configured calendar sources', () => {
  const left = canonicalId('work-calendar', 'event-1');
  const right = canonicalId('personal-calendar', 'event-1');
  assert.notEqual(left, right);
  assert.notEqual(left.split(':')[3], right.split(':')[3], 'occurrence digest is keyed by stable config ID');
});

test('non-recurring UID fallback survives reschedule while recurring event-ID fallback separates occurrences', async () => {
  const firstStart = futureDate(2);
  const h = harness([event({ occurrenceIdentity: undefined, id: 'uid-1-old-start', startDate: firstStart })]);
  await h.service.sync([calendar], '', true, false);
  const originalId = [...h.frontmatters.values()][0].tpsId;
  assert.equal(originalId, canonicalId(calendar.id, 'uid-1'));

  const movedStart = futureDate(3, 11);
  h.setEvents([event({ occurrenceIdentity: undefined, id: 'uid-1-new-start', startDate: movedStart })]);
  await h.service.sync([calendar], '', true, false);
  assert.equal(h.frontmatters.size, 1);
  assert.equal([...h.frontmatters.values()][0].tpsId, originalId);

  const left = event({ occurrenceIdentity: undefined, id: 'series-20260826T090000', uid: 'series', isRecurring: true });
  const right = event({ occurrenceIdentity: undefined, id: 'series-20260827T090000', uid: 'series', isRecurring: true, startDate: futureDate(4) });
  const recurring = harness([left, right]);
  const result = await recurring.service.sync([calendar], '', true, false);
  assert.equal(result.created, 2);
  assert.deepEqual(new Set([...recurring.frontmatters.values()].map((value) => value.tpsId)), new Set([
    canonicalId(calendar.id, left.id),
    canonicalId(calendar.id, right.id),
  ]));
});

test('legacy occurrence fallback uses stable UID for nonrecurring records and occurrence ID for recurring records', async () => {
  const movedStart = futureDate(4, 13);
  const moved = event({
    occurrenceIdentity: undefined,
    id: 'uid-1-rescheduled-start',
    uid: 'uid-1',
    isRecurring: false,
    startDate: movedStart,
    endDate: new Date(movedStart.getTime() + 30 * 60_000),
  });
  const nonrecurring = harness([moved]);
  nonrecurring.seedRecordOnDisk('legacy-nonrecurring.md', legacyFrontmatter({
    path: 'legacy-nonrecurring.md',
    tpsId: 'legacy-nonrecurring',
    calendarOccurrenceIdentity: undefined,
    calendarOccurrenceId: 'uid-1-original-start',
    calendarUid: 'uid-1',
    calendarRecurring: false,
  }));
  const movedResult = await nonrecurring.service.sync([calendar], '', true, false);
  assert.equal(movedResult.created, 0);
  assert.equal(nonrecurring.frontmatters.size, 1);
  assert.equal(nonrecurring.mutationLog.filter((entry) => entry.type === 'reidentify').length, 1);
  assert.equal(nonrecurring.mutationLog.filter((entry) => entry.type === 'create').length, 0);
  assert.equal([...nonrecurring.frontmatters.values()][0].tpsId, canonicalId(calendar.id, 'uid-1'));
  assert.equal([...nonrecurring.frontmatters.values()][0].scheduled, movedStart.toISOString());

  const recurringEvent = event({
    occurrenceIdentity: undefined,
    id: 'series-20260828T090000',
    uid: 'series',
    isRecurring: true,
  });
  const recurring = harness([recurringEvent]);
  recurring.seedRecordOnDisk('legacy-recurring.md', legacyFrontmatter({
    path: 'legacy-recurring.md',
    tpsId: 'legacy-recurring',
    calendarOccurrenceIdentity: undefined,
    calendarOccurrenceId: recurringEvent.id,
    calendarUid: recurringEvent.uid,
    calendarRecurring: true,
  }));
  const recurringResult = await recurring.service.sync([calendar], '', true, false);
  assert.equal(recurringResult.created, 0);
  assert.equal(recurring.frontmatters.size, 1);
  assert.equal([...recurring.frontmatters.values()][0].tpsId, canonicalId(calendar.id, recurringEvent.id));
});

test('legacy occurrence fallback fails closed when recurrence state is absent', async () => {
  const h = harness([]);
  h.seedRecordOnDisk('legacy-ambiguous-recurrence.md', legacyFrontmatter({
    path: 'legacy-ambiguous-recurrence.md',
    tpsId: 'legacy-ambiguous-recurrence',
    calendarOccurrenceIdentity: undefined,
    calendarOccurrenceId: 'uid-1-start',
    calendarUid: 'uid-1',
    calendarRecurring: undefined,
  }));
  await assert.rejects(
    h.service.sync([{ ...calendar, enabled: false }], '', true, false),
    /has no occurrence identity/u,
  );
  assert.equal(h.mutationLog.length, 0);
  assert.equal(h.frontmatters.get('legacy-ambiguous-recurrence.md').tpsId, 'legacy-ambiguous-recurrence');
});

test('successful missing occurrence with nothing policy is a true business-field no-op', async () => {
  const h = harness([event()]);
  await h.service.sync([calendar], '', true, false);
  const [path] = h.files.keys();
  const before = structuredClone(h.frontmatters.get(path));
  const mutationCount = h.mutationLog.length;
  h.setEvents([]);
  const result = await h.service.sync([calendar], '', true, false);
  assert.equal(result.missing, 1);
  assert.equal(result.archived, 0);
  assert.deepEqual(h.frontmatters.get(path), before);
  assert.equal(h.mutationLog.length, mutationCount);
});

test('failed feed cannot delete or alter records while successful feed deletion remains source-scoped', async () => {
  const personal = { ...calendar, id: 'personal-calendar', url: 'https://calendar.example/personal.ics' };
  const workEvent = event({ uid: 'work', id: 'work', occurrenceIdentity: 'work' });
  const personalEvent = event({ uid: 'personal', id: 'personal', occurrenceIdentity: 'personal', sourceUrl: personal.url, startDate: futureDate(3) });
  const h = harness([]);
  h.setFeed(calendar.url, [workEvent], true);
  h.setFeed(personal.url, [personalEvent], true);
  await h.service.sync([calendar, personal], '', true, false);
  h.settings.syncOnEventDelete = 'archive';
  h.setFeed(calendar.url, [], false);
  h.setFeed(personal.url, [], true);
  const result = await h.service.sync([calendar, personal], '', true, false);
  assert.equal(result.failedFeeds, 1);
  assert.equal(result.archived, 1);
  const byId = new Map([...h.frontmatters.values()].map((frontmatter) => [frontmatter.tpsId, frontmatter]));
  assert.equal(byId.get(canonicalId(calendar.id, 'work')).archived, undefined);
  assert.equal(byId.get(canonicalId(personal.id, 'personal')).archived, true);
});

test('cancelled events use the configured status once and preserve a later user override', async () => {
  const h = harness([event()]);
  await h.service.sync([calendar], '', true, false);
  const [path] = h.files.keys();
  h.mutateBusinessFieldOnDisk(path, { status: 'complete' });
  h.settings.canceledStatusValue = 'called-off';
  h.setEvents([event({ isCancelled: true })]);
  const cancelled = await h.service.sync([calendar], '', true, false);
  assert.equal(cancelled.cancelled, 1);
  const id = h.frontmatters.get(path).tpsId;
  assert.equal(h.frontmatters.get(path).status, 'called-off');
  assert.deepEqual(h.settings.nativeCalendarCancellationState[id], {
    appliedStatus: 'called-off',
    previousStatusPresent: true,
    previousStatus: 'complete',
    canRestore: true,
    pendingApplication: false,
  });
  assert.equal(Object.hasOwn(h.frontmatters.get(path), 'nativeCalendarCancellationState'), false);

  h.mutateBusinessFieldOnDisk(path, { status: 'complete' });
  await h.service.sync([calendar], '', true, false);
  assert.equal(h.frontmatters.get(path).status, 'complete', 'an applied cancellation never reasserts over a user-completed status');

  h.setFetchOk(false);
  const before = structuredClone(h.frontmatters.get(path));
  const failed = await h.service.sync([calendar], '', true, false);
  assert.equal(failed.failedFeeds, 1);
  assert.deepEqual(h.frontmatters.get(path), before);

  h.setFeed(calendar.url, [event()], true);
  await h.service.sync([calendar], '', true, false);
  assert.equal(h.frontmatters.get(path).status, 'complete');
  assert.equal(Object.hasOwn(h.settings.nativeCalendarCancellationState, id), false);
});

test('active feed restores an exact plugin-owned cancellation, including blank and absent prior statuses', async () => {
  for (const prior of [
    { label: 'custom', present: true, value: 'in-progress' },
    { label: 'blank', present: true, value: '' },
    { label: 'null', present: true, value: null, restoredValue: '' },
    { label: 'absent', present: false, value: null },
  ]) {
    const incoming = event({ occurrenceIdentity: `restore-${prior.label}`, uid: `restore-${prior.label}`, id: `restore-${prior.label}` });
    const id = canonicalId(calendar.id, incoming.occurrenceIdentity);
    const path = `restore-${prior.label}.md`;
    const h = harness([{ ...incoming, isCancelled: true }]);
    const frontmatter = canonicalFrontmatter(incoming, id, path, { status: prior.value });
    if (!prior.present) delete frontmatter.status;
    h.seedRecordOnDisk(path, frontmatter);

    await h.service.sync([calendar], '', true, false);
    let synced = [...h.frontmatters.values()].find((candidate) => candidate.tpsId === id);
    assert.equal(synced.status, 'cancelled');
    h.setEvents([incoming]);
    await h.service.sync([calendar], '', true, false);
    synced = [...h.frontmatters.values()].find((candidate) => candidate.tpsId === id);
    if (prior.present) assert.equal(synced.status, prior.restoredValue ?? prior.value);
    else assert.equal(Object.hasOwn(synced, 'status'), false);
    assert.equal(Object.hasOwn(h.settings.nativeCalendarCancellationState, id), false);
  }
});

test('an already-cancelled legacy record is adopted without inventing a prior status', async () => {
  const incoming = event({ isCancelled: true });
  const id = canonicalId(calendar.id, incoming.occurrenceIdentity);
  const path = 'legacy-cancelled.md';
  const h = harness([incoming]);
  h.seedRecordOnDisk(path, canonicalFrontmatter(incoming, id, path, { status: 'cancelled' }));
  await h.service.sync([calendar], '', true, false);
  assert.equal(h.settings.nativeCalendarCancellationState[id].canRestore, false);
  h.setEvents([event()]);
  await h.service.sync([calendar], '', true, false);
  const synced = [...h.frontmatters.values()].find((candidate) => candidate.tpsId === id);
  assert.equal(synced.status, 'cancelled', 'unknown legacy status history is not guessed');
  assert.equal(Object.hasOwn(h.settings.nativeCalendarCancellationState, id), false);
});

test('cancellation intent save failure aborts before frontmatter mutation and rolls back memory', async () => {
  const h = harness([event()]);
  await h.service.sync([calendar], '', true, false);
  const [path] = h.files.keys();
  const mutationCount = h.mutationLog.length;
  h.setEvents([event({ isCancelled: true })]);
  h.setFailSettingsSave(true);
  await assert.rejects(h.service.sync([calendar], '', true, false), /settings-save-failed/u);
  assert.equal(h.frontmatters.get(path).status, 'scheduled');
  assert.deepEqual(h.settings.nativeCalendarCancellationState, {});
  assert.equal(h.mutationLog.length, mutationCount);
});

test('cancellation status and ownership inputs are frozen before asynchronous planning', async () => {
  const h = harness([event()]);
  await h.service.sync([calendar], '', true, false);
  const [path] = h.files.keys();
  h.mutateBusinessFieldOnDisk(path, { status: 'complete' });
  h.settings.canceledStatusValue = 'planned-cancel';
  h.setEvents([event({ isCancelled: true })]);
  h.setAfterPreflightHook(() => {
    h.settings.canceledStatusValue = 'next-cancel';
  });

  await h.service.sync([calendar], '', true, false);
  const frontmatter = [...h.frontmatters.values()][0];
  assert.equal(frontmatter.status, 'planned-cancel');
  assert.equal(h.settings.nativeCalendarCancellationState[frontmatter.tpsId].appliedStatus, 'planned-cancel');
  assert.equal(h.settings.canceledStatusValue, 'next-cancel');
});

test('a rejected cancellation plan changes neither status nor private ownership', async () => {
  const incoming = event({ isCancelled: true });
  const id = canonicalId(calendar.id, incoming.occurrenceIdentity);
  const h = harness([incoming], { conflictingStorageKeys: ['status'] });
  h.seedRecordOnDisk('rejected-cancel.md', canonicalFrontmatter(incoming, id, 'rejected-cancel.md', { status: 'complete' }));

  await assert.rejects(h.service.sync([calendar], '', true, false), /rejected the complete calendar identity plan/u);
  assert.equal([...h.frontmatters.values()][0].status, 'complete');
  assert.deepEqual(h.settings.nativeCalendarCancellationState, {});
  assert.equal(h.settingsSaveCount, 0);
});

test('a deleted cancelled record is recreated with its tracked cancellation status', async () => {
  const h = harness([event()]);
  await h.service.sync([calendar], '', true, false);
  h.setEvents([event({ isCancelled: true })]);
  await h.service.sync([calendar], '', true, false);
  const [path] = h.files.keys();
  const id = h.frontmatters.get(path).tpsId;
  h.deleteRecord(path);

  const recreated = await h.service.sync([calendar], '', true, false);
  const frontmatter = [...h.frontmatters.values()].find((candidate) => candidate.tpsId === id);
  assert.equal(recreated.created, 1);
  assert.equal(frontmatter.status, 'cancelled');
  assert.equal(h.settings.nativeCalendarCancellationState[id].pendingApplication, false);
});

test('partial cancellation batch records only confirmed applications and converges safely', async () => {
  const firstEvent = event({ occurrenceIdentity: 'cancel-first', uid: 'cancel-first', id: 'cancel-first', startDate: futureDate(2, 9), isCancelled: true });
  const secondEvent = event({ occurrenceIdentity: 'cancel-second', uid: 'cancel-second', id: 'cancel-second', startDate: futureDate(3, 9), isCancelled: true });
  const firstId = canonicalId(calendar.id, firstEvent.occurrenceIdentity);
  const secondId = canonicalId(calendar.id, secondEvent.occurrenceIdentity);
  const h = harness([firstEvent, secondEvent]);
  h.seedRecordOnDisk('first.md', canonicalFrontmatter(firstEvent, firstId, 'first.md'));
  h.seedRecordOnDisk('second.md', canonicalFrontmatter(secondEvent, secondId, 'second.md'));
  h.setAfterBatchEntryHook(() => h.seedPlainFile('unrelated-race.md'));

  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    await assert.rejects(h.service.sync([calendar], '', true, false), /interrupted the calendar batch/u);
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(h.settings.nativeCalendarCancellationState[firstId].pendingApplication, false);
  assert.equal(h.settings.nativeCalendarCancellationState[secondId].pendingApplication, true);
  const byIdAfterPartial = new Map([...h.frontmatters.values()].map((frontmatter) => [frontmatter.tpsId, frontmatter]));
  assert.equal(byIdAfterPartial.get(firstId).status, 'cancelled');
  assert.equal(byIdAfterPartial.get(secondId).status, 'scheduled');

  await h.service.sync([calendar], '', true, false);
  const byId = new Map([...h.frontmatters.values()].map((frontmatter) => [frontmatter.tpsId, frontmatter]));
  assert.equal(byId.get(firstId).status, 'cancelled');
  assert.equal(byId.get(secondId).status, 'cancelled');
  assert.equal(h.settings.nativeCalendarCancellationState[firstId].pendingApplication, false);
  assert.equal(h.settings.nativeCalendarCancellationState[secondId].pendingApplication, false);
});

test('filtered present occurrence remains seen under archive policy', async () => {
  const h = harness([event()]);
  await h.service.sync([calendar], '', true, false);
  h.settings.syncOnEventDelete = 'archive';
  const result = await h.service.sync([calendar], 'standup', true, false);
  assert.equal(result.archived, 0);
  assert.equal([...h.frontmatters.values()][0].archived, undefined);
});

test('legacy native record migrates once, strips redundant fields, and preserves business data', async () => {
  const path = '2026-08-26 - Standup.md';
  const h = harness([]);
  h.seedRecord(path, legacyFrontmatter({ path }));
  const disabled = { ...calendar, enabled: false };
  const result = await h.service.sync([disabled], '', true, false);
  assert.equal(result.updated, 1);
  assert.equal(h.frontmatters.size, 1);
  const migrated = h.frontmatters.get(path);
  assert.equal(migrated.tpsId, canonicalId(calendar.id, 'uid-1'));
  assertNoRedundantFields(migrated);
  assertNoPhysicalVirtualFields(migrated);
  assert.equal(migrated.title, 'Standup');
  assert.equal(Object.hasOwn(migrated, 'allDay'), false);
  assert.equal(Object.hasOwn(migrated, 'location'), false);
  assert.equal(Object.hasOwn(migrated, 'organizer'), false);
  assert.equal(Object.hasOwn(migrated, 'attendees'), false);
  assert.equal(Object.hasOwn(migrated, 'url'), false);
  assert.deepEqual(migrated.tags, ['calendar-event'], 'ordinary tags may be authored and are preserved');
  assert.equal(
    migrated.associatedNote,
    '[[Calendar Events/2026-08-26/Calendar event--deadbeef]]',
    'generic migration preserves unresolved relationships for Sync-delayed companions',
  );
  assert.equal(migrated.status, 'complete');
  assert.equal(migrated.description, 'Keep this business content');
  assert.equal(migrated.color, '#123456');
  assert.equal(h.preflightLog.length, 1);

  const mutationCount = h.mutationLog.length;
  const repeat = await h.service.sync([disabled], '', true, false);
  assert.equal(repeat.updated, 0);
  assert.equal(h.mutationLog.length, mutationCount);
});

test('active legacy migration and later refresh preserve workflow status and ordinary tags', async () => {
  const incoming = event({ description: 'First refresh' });
  const path = 'legacy-business-fields.md';
  const configured = { ...calendar, autoCreateTag: 'managed-work' };
  const h = harness([incoming]);
  h.seedRecordOnDisk(path, legacyFrontmatter({
    path,
    tpsId: 'legacy-business-fields',
    status: 'complete',
    tags: ['calendar-event', 'customer-important'],
  }));

  const migrated = await h.service.sync([configured], '', true, false);
  assert.equal(migrated.created, 0);
  let frontmatter = [...h.frontmatters.values()][0];
  assert.equal(frontmatter.status, 'complete');
  assert.deepEqual(new Set(frontmatter.tags), new Set(['calendar-event', 'customer-important']));

  h.setEvents([event({ description: 'Second refresh' })]);
  await h.service.sync([configured], '', true, false);
  frontmatter = [...h.frontmatters.values()][0];
  assert.equal(frontmatter.status, 'complete');
  assert.equal(frontmatter.description, 'Second refresh');
  assert.deepEqual(new Set(frontmatter.tags), new Set(['calendar-event', 'customer-important']));
});

test('ordinary active sync preserves an intentionally blank workflow status', async () => {
  const path = 'legacy-blank-status.md';
  const h = harness([event({ description: 'Refresh without workflow reset' })]);
  h.seedRecordOnDisk(path, legacyFrontmatter({
    path,
    tpsId: 'legacy-blank-status',
    status: '',
  }));

  const result = await h.service.sync([calendar], '', true, false);
  assert.equal(result.created, 0);
  assert.equal([...h.frontmatters.values()][0].status, '');
});

test('tag-profile legacy migration removes only its owned identity tag and preserves ordinary tags', async () => {
  const oldId = 'legacy-tag-profile';
  const path = 'legacy-tag-profile.md';
  const h = harness([event()]);
  h.seedRecordOnDisk(path, legacyFrontmatter({
    path,
    tpsId: undefined,
    status: 'in-progress',
    tags: [
      `tps/record/v1/calendar-event/${oldId}`,
      `project/calendar-event/${oldId}`,
      'customer-tag',
    ],
  }));

  const result = await h.service.sync([{ ...calendar, autoCreateTag: 'managed-tag' }], '', true, false);
  assert.equal(result.created, 0);
  const frontmatter = [...h.frontmatters.values()][0];
  assert.equal(frontmatter.tpsId, canonicalId(calendar.id, 'uid-1'));
  assert.equal(frontmatter.status, 'in-progress');
  assert.deepEqual(new Set(frontmatter.tags), new Set([
    `project/calendar-event/${oldId}`,
    'customer-tag',
  ]));
  assert.equal(frontmatter.tags.some((tag) => tag.startsWith('tps/record/v1/')), false);
  const plan = h.preflightLog[0].entries.find((entry) => entry.reference === oldId);
  const plannedTags = plan.updates.flatMap((updates) => Array.isArray(updates.tags) ? updates.tags : []);
  assert.equal(plannedTags.some((tag) => tag.startsWith('tps/record/v1/')), false);
});

test('retired calendar tag values never run during automatic sync', async () => {
  const configured = { ...calendar, autoCreateTag: 'planned-tag' };
  const h = harness([event()]);
  h.setAfterPreflightHook(() => { configured.autoCreateTag = 'next-sync-tag'; });
  await h.service.sync([configured], '', true, false);
  assert.equal([...h.frontmatters.values()][0].tags, undefined);
  assert.equal(h.preflightLog[0].entries.find(entry => entry.operation === 'create').properties.tags, undefined);
  await h.service.sync([configured], '', true, false);
  assert.equal([...h.frontmatters.values()][0].tags, undefined);
});

test('active missing-ID config backfills the historical fallback and migrates its old record', async () => {
  const rawCalendar = {
    ...calendar,
    id: '',
  };
  normalizeExternalCalendarsInPlace([rawCalendar], (path) => path);
  assert.equal(rawCalendar.id, legacyCalendarConfigIdForUrl(rawCalendar.url));
  const path = '2026-08-26 - Standup.md';
  const h = harness([event()]);
  h.seedRecord(path, legacyFrontmatter({
    path,
    tpsId: 'calendar-old-fallback-record',
    calendarId: rawCalendar.id,
    calendarOccurrenceKey: `${rawCalendar.id}:old-source-hash:uid-1`,
  }));
  const result = await h.service.sync([rawCalendar], '', true, false);
  assert.equal(result.created, 0);
  assert.equal(h.frontmatters.size, 1);
  const migrated = [...h.frontmatters.values()][0];
  assert.equal(migrated.tpsId, canonicalId(rawCalendar.id, 'uid-1'));
  assertNoRedundantFields(migrated);
});

test('authoritative disk discovery migrates a cache-null legacy occurrence instead of creating a duplicate', async () => {
  const path = 'cache-null-legacy.md';
  const h = harness([event()], { cacheNullPaths: [path] });
  h.seedRecordOnDisk(path, legacyFrontmatter({ path, tpsId: 'legacy-cache-null' }));
  assert.equal(h.service.recordsByPath.size, 0, 'MetadataCache-only startup discovery misses the fixture by design');

  const result = await h.service.sync([calendar], '', true, false);
  assert.equal(result.created, 0);
  assert.equal(h.frontmatters.size, 1);
  assert.equal(h.mutationLog.filter((entry) => entry.type === 'reidentify').length, 1);
  assert.equal(h.mutationLog.filter((entry) => entry.type === 'create').length, 0);
  assert.equal([...h.frontmatters.values()][0].tpsId, canonicalId(calendar.id, 'uid-1'));
});

test('authoritative snapshot after a pending feed sees a cache-null legacy arrival and migrates it', async () => {
  const path = 'arrived-during-fetch.md';
  const h = harness([], { cacheNullPaths: [path] });
  let markFetchStarted;
  const fetchStarted = new Promise((resolve) => { markFetchStarted = resolve; });
  let releaseFetch;
  const fetchReleased = new Promise((resolve) => { releaseFetch = resolve; });
  h.setFetchHook(async (url) => {
    markFetchStarted();
    await fetchReleased;
    return { ok: true, events: [event()], normalizedUrl: url, fromCache: false };
  });

  const sync = h.service.sync([calendar], '', true, false);
  await fetchStarted;
  h.seedRecordOnDisk(path, legacyFrontmatter({ path, tpsId: 'legacy-arrived-during-fetch' }));
  releaseFetch();
  const result = await sync;

  assert.equal(result.created, 0);
  assert.equal(h.frontmatters.size, 1);
  assert.equal(h.mutationLog.filter((entry) => entry.type === 'reidentify').length, 1);
  assert.equal(h.mutationLog.filter((entry) => entry.type === 'create').length, 0);
  assert.equal([...h.frontmatters.values()][0].tpsId, canonicalId(calendar.id, 'uid-1'));
});

test('snapshot-token preflight rejects a native record arriving after discovery before any sync write', async () => {
  const path = 'arrived-after-snapshot.md';
  const h = harness([event()], { cacheNullPaths: [path] });
  h.setAfterSnapshotHook(() => {
    h.seedRecordOnDisk(path, legacyFrontmatter({ path, tpsId: 'legacy-arrived-after-snapshot' }));
  });

  await assert.rejects(
    h.service.sync([calendar], '', true, false),
    /rejected the complete calendar identity plan/u,
  );
  assert.equal(h.preflightLog.length, 1);
  assert.equal(h.preflightLog[0].snapshotToken, 0);
  assert.equal(h.mutationLog.length, 0);
  assert.equal(h.mutationLog.filter((entry) => entry.type === 'create').length, 0);
  assert.equal(h.frontmatters.size, 1);
  assert.equal(h.frontmatters.get(path).tpsId, 'legacy-arrived-after-snapshot');
  assert.equal(h.service.syncPromise, null, 'rejected stale snapshot clears the single-flight guard');
});

test('snapshot-revision preflight preserves a business tag changed after authoritative discovery', async () => {
  const incoming = event({ description: 'Feed refresh must not overwrite the race' });
  const id = canonicalId(calendar.id, incoming.occurrenceIdentity);
  const path = 'business-race.md';
  const h = harness([incoming]);
  h.seedRecordOnDisk(path, canonicalFrontmatter(incoming, id, path, {
    description: 'Old description',
    tags: ['calendar-event', 'before-race'],
  }));
  h.setAfterSnapshotHook(() => {
    h.mutateBusinessFieldOnDisk(path, { tags: ['calendar-event', 'after-race'] });
  });

  await assert.rejects(
    h.service.sync([calendar], '', true, false),
    /rejected the complete calendar identity plan/u,
  );
  assert.equal(h.preflightLog[0].snapshotToken, 1);
  assert.equal(h.preflightLog[0].snapshotRevision, 1);
  assert.deepEqual(h.frontmatters.get(path).tags, ['calendar-event', 'after-race']);
  assert.equal(h.frontmatters.get(path).description, 'Old description');
  assert.equal(h.mutationLog.length, 0);
});

test('delayed stale MetadataCache delivery cannot poison authoritative sync payloads', async () => {
  const incoming = event({ description: 'Fresh feed description' });
  const id = canonicalId(calendar.id, incoming.occurrenceIdentity);
  const path = `${buildNativeCalendarRecordFileName(incoming)}.md`;
  const current = canonicalFrontmatter(incoming, id, path, {
    description: 'Old feed description',
    tags: ['calendar-event', 'current-disk-tag'],
  });
  const h = harness([incoming]);
  h.seedRecordOnDisk(path, current);
  h.setAfterAuthoritativeRebuildHook(() => {
    h.emitMetadataChanged(path, {
      ...current,
      tags: ['calendar-event', 'stale-cache-tag'],
    });
  });

  const result = await h.service.sync([{ ...calendar, autoCreateTag: 'managed-calendar' }], '', true, false);
  const synced = h.frontmatters.get(path);
  assert.equal(result.updated, 1);
  assert.equal(synced.description, 'Fresh feed description');
  assert.deepEqual(
    new Set(synced.tags),
    new Set(['calendar-event', 'current-disk-tag']),
  );
  assert.equal(synced.tags.includes('stale-cache-tag'), false);
});

test('authoritative discovery aborts duplicate legacy old identity before fetched occurrence can mutate or create', async () => {
  const h = harness([event()]);
  h.seedRecordOnDisk('duplicate-one.md', legacyFrontmatter({ path: 'duplicate-one.md', tpsId: 'legacy-duplicate' }));
  h.seedRecordOnDisk('duplicate-two.md', legacyFrontmatter({ path: 'duplicate-two.md', tpsId: 'legacy-duplicate' }));

  await assert.rejects(h.service.sync([calendar], '', true, false), /rejected duplicate identity legacy-duplicate/u);
  assert.equal(h.mutationLog.length, 0);
  assert.equal(h.mutationLog.filter((entry) => entry.type === 'create').length, 0);
  assert.equal(h.frontmatters.size, 2);
  assert.equal(h.service.syncPromise, null, 'rejected authoritative discovery clears the single-flight guard');
});

test('authoritative discovery aborts blocked legacy identity before fetched occurrence can mutate or create', async () => {
  const h = harness([event()], { blockedIds: ['legacy-blocked'] });
  h.seedRecordOnDisk('blocked.md', legacyFrontmatter({ path: 'blocked.md', tpsId: 'legacy-blocked' }));

  await assert.rejects(h.service.sync([calendar], '', true, false), /rejected blocked identity legacy-blocked/u);
  assert.equal(h.mutationLog.length, 0);
  assert.equal(h.mutationLog.filter((entry) => entry.type === 'create').length, 0);
  assert.equal(h.frontmatters.get('blocked.md').tpsId, 'legacy-blocked');
  assert.equal(h.service.syncPromise, null, 'rejected authoritative discovery clears the single-flight guard');
});

test('migration preserves real or unresolved user association, but never a self-association', async () => {
  const disabled = { ...calendar, enabled: false };
  const real = harness([]);
  real.seedPlainFile('Projects/Companion.md');
  real.seedRecord('real.md', legacyFrontmatter({
    path: 'real.md',
    tpsId: 'legacy-real',
    associatedNote: '[[Projects/Companion]]',
    associatedNotePath: 'Projects/Companion.md',
  }));
  await real.service.sync([disabled], '', true, false);
  assert.equal(real.frontmatters.get('real.md').associatedNote, '[[Projects/Companion]]');
  assert.equal(real.frontmatters.get('real.md').associatedNotePath, undefined);

  const uncertain = harness([]);
  uncertain.seedRecord('uncertain.md', legacyFrontmatter({
    path: 'uncertain.md',
    tpsId: 'legacy-uncertain',
    associatedNote: '[[Project companion]]',
    associatedNotePath: undefined,
  }));
  await uncertain.service.sync([disabled], '', true, false);
  assert.equal(uncertain.frontmatters.get('uncertain.md').associatedNote, '[[Project companion]]');

  const pathOnly = harness([]);
  pathOnly.seedRecord('path-only.md', legacyFrontmatter({
    path: 'path-only.md',
    tpsId: 'legacy-path-only',
    associatedNote: undefined,
    associatedNotePath: 'Projects/Delayed | companion.md',
  }));
  await pathOnly.service.sync([disabled], '', true, false);
  assert.equal(pathOnly.frontmatters.get('path-only.md').associatedNote, '[[Projects/Delayed \\| companion]]');
  assert.equal(pathOnly.frontmatters.get('path-only.md').associatedNotePath, undefined);

  const self = harness([]);
  self.seedRecord('self.md', legacyFrontmatter({
    path: 'self.md',
    tpsId: 'legacy-self',
    associatedNote: '[[self]]',
    associatedNotePath: 'self.md',
  }));
  await self.service.sync([disabled], '', true, false);
  assert.equal(self.frontmatters.get('self.md').associatedNote, undefined);

  const pathOnlySelf = harness([]);
  pathOnlySelf.seedRecord('path-only-self.md', legacyFrontmatter({
    path: 'path-only-self.md',
    tpsId: 'legacy-path-only-self',
    associatedNote: undefined,
    associatedNotePath: 'path-only-self.md',
  }));
  await pathOnlySelf.service.sync([disabled], '', true, false);
  assert.equal(pathOnlySelf.frontmatters.get('path-only-self.md').associatedNote, undefined);
});

test('manual calendar-event with calendar-looking ID but no legacy evidence is not adopted', async () => {
  const h = harness([event()]);
  h.seedRecord('manual.md', {
    tpsId: 'calendar-manual-note',
    tpsSchemaVersion: 1,
    kind: 'calendar-event',
    title: 'Manual event',
    status: 'idea',
    scheduled: futureDate(5).toISOString(),
  });
  const result = await h.service.sync([calendar], '', true, false);
  assert.equal(result.created, 1);
  assert.equal(h.frontmatters.get('manual.md').tpsId, 'calendar-manual-note');
  assert.equal(h.frontmatters.get('manual.md').status, 'idea');
});

test('manual noncanonical calendar record with cleanup-named fields remains byte-for-byte untouched', async () => {
  const h = harness([]);
  const manual = {
    tpsId: 'manual-calendar-record',
    tpsSchemaVersion: 1,
    kind: 'calendar-event',
    title: 'Manual event',
    associatedNotePath: 'Projects/Manual companion.md',
    associatedNoteStrategy: 'manual-workflow',
    calendarRecurring: true,
    calendarSyncState: 'user-owned-state',
    calendarMissingAt: 'user-authored-value',
    status: 'idea',
  };
  h.seedRecordOnDisk('manual-cleanup-fields.md', manual);
  const before = structuredClone(h.frontmatters.get('manual-cleanup-fields.md'));

  const result = await h.service.sync([{ ...calendar, enabled: false }], '', true, false);
  assert.equal(result.updated, 0);
  assert.equal(h.mutationLog.length, 0);
  assert.deepEqual(h.frontmatters.get('manual-cleanup-fields.md'), before);
});

test('whole-plan legacy collision fails before any mutation', async () => {
  const h = harness([]);
  h.seedRecord('one.md', legacyFrontmatter({ path: 'one.md', tpsId: 'legacy-one' }));
  h.seedRecord('two.md', legacyFrontmatter({ path: 'two.md', tpsId: 'legacy-two' }));
  await assert.rejects(
    h.service.sync([{ ...calendar, enabled: false }], '', true, false),
    /would collide/u,
  );
  assert.equal(h.mutationLog.length, 0);
  assert.equal(h.frontmatters.get('one.md').tpsId, 'legacy-one');
  assert.equal(h.frontmatters.get('two.md').tpsId, 'legacy-two');
});

test('whole-plan property preflight rejects a later case-duplicate legacy cleanup key before any migration', async () => {
  const h = harness([]);
  h.seedRecordOnDisk('first-legacy.md', legacyFrontmatter({
    path: 'first-legacy.md',
    tpsId: 'legacy-first-cleanup',
    calendarOccurrenceIdentity: 'first-cleanup',
    calendarOccurrenceId: 'first-cleanup',
    calendarUid: 'first-cleanup',
    calendarOccurrenceKey: `${calendar.id}:old-source-hash:first-cleanup`,
  }));
  h.seedRecordOnDisk('later-legacy.md', legacyFrontmatter({
    path: 'later-legacy.md',
    tpsId: 'legacy-later-cleanup',
    calendarOccurrenceIdentity: 'later-cleanup',
    calendarOccurrenceId: 'later-cleanup',
    calendarUid: 'later-cleanup',
    calendarOccurrenceKey: `${calendar.id}:old-source-hash:later-cleanup`,
    CalendarId: calendar.id,
  }));

  await assert.rejects(
    h.service.sync([{ ...calendar, enabled: false }], '', true, false),
    /rejected the complete calendar identity plan/u,
  );
  const laterPlan = h.preflightLog[0].entries.find((entry) => entry.reference === 'legacy-later-cleanup');
  assert.ok(plannedUpdateKeys(laterPlan).includes('calendarId'));
  assert.equal(h.mutationLog.length, 0);
  assert.equal(h.frontmatters.get('first-legacy.md').tpsId, 'legacy-first-cleanup');
  assert.equal(h.frontmatters.get('later-legacy.md').tpsId, 'legacy-later-cleanup');
});

test('configured native identity tags are discarded while ordinary migration proceeds', async () => {
  const h = harness([event()]);
  h.seedRecordOnDisk('first-legacy.md', legacyFrontmatter({
    path: 'first-legacy.md',
    tpsId: 'legacy-before-invalid-create-tag',
    calendarOccurrenceIdentity: 'legacy-before-invalid-create-tag',
    calendarOccurrenceId: 'legacy-before-invalid-create-tag',
    calendarUid: 'legacy-before-invalid-create-tag',
    calendarOccurrenceKey: `${calendar.id}:old-source-hash:legacy-before-invalid-create-tag`,
    scheduled: futureDate(90).toISOString(),
  }));

  const result = await h.service.sync([{ ...calendar, autoCreateTag: 'calendar-event tps/record/v1/task/injected' }], '', true, false);
  const createPlan = h.preflightLog[0].entries.find((entry) => entry.operation === 'create');
  assert.equal(createPlan.properties.tags, undefined);
  assert.equal(result.created, 1);
  assert.equal(result.updated, 1);
  assert.equal([...h.frontmatters.values()].some((frontmatter) =>
    Array.isArray(frontmatter.tags) && frontmatter.tags.some((tag) => String(tag).startsWith('tps/record/v1/'))), false);
});

test('exact event update payload rejects a custom storage-key collision before an earlier migration', async () => {
  const incoming = event({ description: 'Fresh description' });
  const target = canonicalId(calendar.id, incoming.occurrenceIdentity);
  const h = harness([incoming], { conflictingStorageKeys: ['description'] });
  h.seedRecordOnDisk('first-legacy.md', legacyFrontmatter({
    path: 'first-legacy.md',
    tpsId: 'legacy-before-storage-collision',
    calendarOccurrenceIdentity: 'legacy-before-storage-collision',
    calendarOccurrenceId: 'legacy-before-storage-collision',
    calendarUid: 'legacy-before-storage-collision',
    calendarOccurrenceKey: `${calendar.id}:old-source-hash:legacy-before-storage-collision`,
    scheduled: futureDate(90).toISOString(),
  }));
  h.seedRecordOnDisk('later-canonical.md', {
    tpsId: target,
    tpsSchemaVersion: 1,
    kind: 'calendar-event',
    title: 'Standup',
    eventTitle: 'Standup',
    status: 'scheduled',
    scheduled: incoming.startDate.toISOString(),
    end: incoming.endDate.toISOString(),
    durationMinutes: 30,
    allDay: false,
    description: 'Old description',
    tags: ['calendar-event'],
  });

  await assert.rejects(
    h.service.sync([calendar], '', true, false),
    /rejected the complete calendar identity plan/u,
  );
  const updatePlan = h.preflightLog[0].entries.find((entry) => entry.reference === target);
  assert.ok(plannedUpdateKeys(updatePlan).includes('description'));
  assert.equal(h.mutationLog.length, 0);
  assert.equal(h.frontmatters.get('first-legacy.md').tpsId, 'legacy-before-storage-collision');
  assert.equal(h.frontmatters.get('later-canonical.md').description, 'Old description');
});

test('whole-plan property preflight rejects a fetched record duplicate business key before an earlier migration', async () => {
  const incoming = event({ description: 'Fresh description' });
  const canonical = canonicalId(calendar.id, incoming.occurrenceIdentity);
  const h = harness([incoming]);
  h.seedRecordOnDisk('first-legacy.md', legacyFrontmatter({
    path: 'first-legacy.md',
    tpsId: 'legacy-before-fetched-update',
    calendarOccurrenceIdentity: 'legacy-before-fetched-update',
    calendarOccurrenceId: 'legacy-before-fetched-update',
    calendarUid: 'legacy-before-fetched-update',
    calendarOccurrenceKey: `${calendar.id}:old-source-hash:legacy-before-fetched-update`,
  }));
  h.seedRecordOnDisk('later-canonical.md', {
    tpsId: canonical,
    tpsSchemaVersion: 1,
    kind: 'calendar-event',
    title: 'Standup',
    eventTitle: 'Standup',
    status: 'scheduled',
    scheduled: incoming.startDate.toISOString(),
    end: incoming.endDate.toISOString(),
    durationMinutes: 30,
    allDay: false,
    description: 'Old description',
    Description: 'Conflicting source property',
    location: '',
    organizer: '',
    attendees: [],
    url: '',
    tags: ['calendar-event'],
  });

  await assert.rejects(
    h.service.sync([calendar], '', true, false),
    /rejected the complete calendar identity plan/u,
  );
  const fetchedPlan = h.preflightLog[0].entries.find((entry) => entry.reference === canonical);
  assert.ok(plannedUpdateKeys(fetchedPlan).includes('description'));
  assert.ok(plannedUpdateKeys(fetchedPlan).includes('eventTitle'), 'legacy duplicate-title storage is cleaned in the same source plan');
  assert.equal(h.mutationLog.length, 0);
  assert.equal(h.frontmatters.get('first-legacy.md').tpsId, 'legacy-before-fetched-update');
  assert.equal(h.frontmatters.get('later-canonical.md').description, 'Old description');
});

test('whole-plan property preflight reserves missing-event archive keys before any migration', async () => {
  const missingId = canonicalId(calendar.id, 'missing-archive');
  const h = harness([]);
  h.settings.syncOnEventDelete = 'archive';
  h.seedRecordOnDisk('first-legacy.md', legacyFrontmatter({
    path: 'first-legacy.md',
    tpsId: 'legacy-before-archive',
    calendarOccurrenceIdentity: 'legacy-before-archive',
    calendarOccurrenceId: 'legacy-before-archive',
    calendarUid: 'legacy-before-archive',
    calendarOccurrenceKey: `${calendar.id}:old-source-hash:legacy-before-archive`,
  }));
  h.seedRecordOnDisk('later-missing.md', {
    tpsId: missingId,
    tpsSchemaVersion: 1,
    kind: 'calendar-event',
    title: 'Missing event',
    eventTitle: 'Missing event',
    scheduled: futureDate(2).toISOString(),
    archived: false,
    Archived: true,
  });

  await assert.rejects(
    h.service.sync([calendar], '', true, false),
    /rejected the complete calendar identity plan/u,
  );
  const missingPlan = h.preflightLog[0].entries.find((entry) => entry.reference === missingId);
  assert.ok(plannedUpdateKeys(missingPlan).includes('archived'));
  assert.ok(plannedUpdateKeys(missingPlan).includes('archivedDate'));
  assert.equal(h.mutationLog.length, 0);
  assert.equal(h.frontmatters.get('first-legacy.md').tpsId, 'legacy-before-archive');
  assert.equal(h.frontmatters.get('later-missing.md').archived, false);
});

test('missing-event policy remains fixed when settings change after preflight', async () => {
  const missingId = canonicalId(calendar.id, 'missing-policy-snapshot');
  const h = harness([]);
  h.seedRecordOnDisk('first-legacy.md', legacyFrontmatter({
    path: 'first-legacy.md',
    tpsId: 'legacy-before-policy-flip',
    calendarOccurrenceIdentity: 'legacy-before-policy-flip',
    calendarOccurrenceId: 'legacy-before-policy-flip',
    calendarUid: 'legacy-before-policy-flip',
    calendarOccurrenceKey: `${calendar.id}:old-source-hash:legacy-before-policy-flip`,
    scheduled: futureDate(90).toISOString(),
  }));
  h.seedRecordOnDisk('later-missing.md', {
    tpsId: missingId,
    tpsSchemaVersion: 1,
    kind: 'calendar-event',
    title: 'Missing event',
    eventTitle: 'Missing event',
    scheduled: futureDate(2).toISOString(),
    archived: false,
    Archived: true,
  });
  h.setAfterPreflightHook(() => {
    h.settings.syncOnEventDelete = 'archive';
  });

  const result = await h.service.sync([calendar], '', true, false);
  const missingPlan = h.preflightLog[0].entries.find((entry) => entry.reference === missingId);
  assert.equal(plannedUpdateKeys(missingPlan).includes('archived'), false);
  assert.equal(result.archived, 0);
  assert.equal(result.missing, 1);
  assert.equal(h.mutationLog.some((entry) => entry.type === 'archive'), false);
  assert.equal(h.frontmatters.get('later-missing.md').archived, false);
  assert.equal(h.frontmatters.get('later-missing.md').Archived, true);
  assert.equal(h.settings.syncOnEventDelete, 'archive', 'the live setting still changes for the next sync');
  assert.equal(
    h.frontmatters.get('first-legacy.md').tpsId,
    canonicalId(calendar.id, 'legacy-before-policy-flip'),
    'the already-preflighted migration completes without a later unplanned archive failure',
  );
});

test('case-folded cross-kind destination collision fails before any mutation', async () => {
  const target = canonicalId(calendar.id, 'uid-1');
  const caseVariant = target.replace(/[A-Z]/u, (value) => value.toLocaleLowerCase());
  assert.notEqual(caseVariant, target);
  assert.equal(caseVariant.toLocaleLowerCase(), target.toLocaleLowerCase());
  const h = harness([]);
  h.seedRecord('legacy.md', legacyFrontmatter({ path: 'legacy.md', tpsId: 'legacy-source' }));
  h.seedRecord('task.md', {
    tpsId: caseVariant,
    tpsSchemaVersion: 1,
    kind: 'task',
    title: 'Unrelated native task',
  });
  await assert.rejects(
    h.service.sync([{ ...calendar, enabled: false }], '', true, false),
    /would collide/u,
  );
  assert.equal(h.mutationLog.length, 0);
});

test('GCM blocked-destination preflight fails the complete plan before mutation', async () => {
  const target = canonicalId(calendar.id, 'uid-1');
  const h = harness([], { blockedIds: [target] });
  h.seedRecord('legacy.md', legacyFrontmatter({ path: 'legacy.md', tpsId: 'legacy-source' }));
  await assert.rejects(
    h.service.sync([{ ...calendar, enabled: false }], '', true, false),
    /rejected the complete calendar identity plan/u,
  );
  assert.equal(h.preflightLog.length, 1);
  assert.equal(h.mutationLog.length, 0);
  assert.equal(h.frontmatters.get('legacy.md').tpsId, 'legacy-source');
});

test('authoritative list rejects cleanup-only duplicate global ownership before mutation', async () => {
  const target = canonicalId(calendar.id, 'uid-1');
  const caseVariant = target.replace(/[A-Z]/u, (value) => value.toLocaleLowerCase());
  const h = harness([]);
  h.seedRecord('calendar.md', {
    ...legacyFrontmatter({ path: 'calendar.md', tpsId: target }),
    tpsId: target,
  });
  h.seedRecord('other-kind.md', {
    tpsId: caseVariant,
    tpsSchemaVersion: 1,
    kind: 'task',
    title: 'Duplicate global owner',
  });
  await assert.rejects(
    h.service.sync([{ ...calendar, enabled: false }], '', true, false),
    /rejected duplicate identity/u,
  );
  assert.equal(h.preflightLog.length, 0);
  assert.equal(h.mutationLog.length, 0);
  assert.equal(h.frontmatters.get('calendar.md').calendarId, calendar.id);
});

test('fetched canonical-ID collision fails before a pending migration mutates anything', async () => {
  const duplicate = event();
  const h = harness([duplicate, { ...duplicate }]);
  h.seedRecord('legacy.md', legacyFrontmatter({ path: 'legacy.md', tpsId: 'legacy-source' }));
  await assert.rejects(h.service.sync([calendar], '', true, false), /Multiple fetched calendar occurrences/u);
  assert.equal(h.mutationLog.length, 0);
  assert.equal(h.frontmatters.get('legacy.md').tpsId, 'legacy-source');
});

test('canonical calendar identity stays owned when the user changes its public kind', async () => {
  const incoming = event();
  const target = canonicalId(calendar.id, incoming.occurrenceIdentity);
  const h = harness([incoming]);
  h.seedRecord('legacy.md', legacyFrontmatter({
    path: 'legacy.md',
    tpsId: 'legacy-other-occurrence',
    calendarUid: 'uid-other',
    calendarOccurrenceId: 'uid-other-20260826T090000',
    calendarOccurrenceIdentity: 'uid-other',
    calendarOccurrenceKey: `${calendar.id}:old-source-hash:uid-other`,
  }));
  h.seedRecord('task.md', {
    tpsId: target,
    tpsSchemaVersion: 1,
    kind: 'task',
    title: 'Occupied by a task',
    status: 'complete',
  });
  const result = await h.service.sync([calendar], '', true, false);
  assert.equal(result.created, 0);
  const owned = [...h.frontmatters.values()].find((record) => record.tpsId === target);
  assert.equal(owned.kind, 'task');
  assert.equal(owned.status, 'complete');
  assert.equal(owned.scheduled, incoming.startDate.toISOString());
  assert.equal([...h.frontmatters.values()].filter((record) => record.tpsId === target).length, 1);
});

test('authoritative path planning relocates an outside-root legacy record and keeps a plain title', async () => {
  const incoming = event({ title: 'Root migration' });
  const sourcePath = 'Imported/Old calendar record.md';
  const h = harness([incoming], { nativeRoot: 'TPS Records', nativeLayout: 'kind-folders' });
  h.seedRecordOnDisk(sourcePath, legacyFrontmatter({
    path: sourcePath,
    tpsId: 'legacy-outside-configured-root',
    eventTitle: incoming.title,
    title: recordLink(sourcePath, incoming.title),
  }));

  const result = await h.service.sync([calendar], '', true, false);
  const expectedPath = `TPS Records/calendar-events/${buildNativeCalendarRecordFileName(incoming)}.md`;
  assert.equal(result.created, 0);
  assert.equal(result.updated, 1);
  assert.equal(h.files.has(sourcePath), false);
  assert.equal(h.files.has(expectedPath), true);
  assert.equal(h.frontmatters.get(expectedPath).title, incoming.title);
  assert.equal(h.frontmatters.get(expectedPath).tpsId, canonicalId(calendar.id, incoming.occurrenceIdentity));
});

test('one ordered path batch allocates two converging renames and a create without divergence', async () => {
  const startDate = futureDate(4, 10);
  const endDate = new Date(startDate.getTime() + 30 * 60_000);
  const first = event({ id: 'shared-one', uid: 'shared-one', occurrenceIdentity: 'shared-one', title: 'Shared title', startDate, endDate });
  const second = event({ id: 'shared-two', uid: 'shared-two', occurrenceIdentity: 'shared-two', title: 'Shared title', startDate, endDate });
  const created = event({ id: 'shared-three', uid: 'shared-three', occurrenceIdentity: 'shared-three', title: 'Shared title', startDate, endDate });
  const firstId = canonicalId(calendar.id, first.occurrenceIdentity);
  const secondId = canonicalId(calendar.id, second.occurrenceIdentity);
  const createdId = canonicalId(calendar.id, created.occurrenceIdentity);
  const h = harness([first, second, created], { nativeRoot: 'TPS Records', nativeLayout: 'kind-folders' });
  h.seedRecordOnDisk('Imported/A.md', canonicalFrontmatter(first, firstId, 'Imported/A.md'));
  h.seedRecordOnDisk('Imported/B.md', canonicalFrontmatter(second, secondId, 'Imported/B.md'));

  const result = await h.service.sync([calendar], '', true, false);
  const basePath = `TPS Records/calendar-events/${buildNativeCalendarRecordFileName(first)}.md`;
  const secondPath = basePath.replace(/\.md$/u, ' (2).md');
  const thirdPath = basePath.replace(/\.md$/u, ' (3).md');
  const pathById = new Map([...h.frontmatters.entries()].map(([path, frontmatter]) => [frontmatter.tpsId, path]));
  assert.equal(result.updated, 2);
  assert.equal(result.created, 1);
  assert.equal(pathById.get(firstId), basePath);
  assert.equal(pathById.get(secondId), secondPath);
  assert.equal(pathById.get(createdId), thirdPath);
  assert.equal(h.frontmatters.get(basePath).title, first.title);
  assert.equal(h.frontmatters.get(secondPath).title, second.title);
  assert.equal(h.frontmatters.get(thirdPath).title, created.title);
});

test('ordered path planning reuses a path vacated by an earlier rename', async () => {
  const startDate = futureDate(5, 11);
  const endDate = new Date(startDate.getTime() + 30 * 60_000);
  const movingAway = event({ id: 'moving-away', uid: 'moving-away', occurrenceIdentity: 'moving-away', title: 'Beta', startDate, endDate });
  const movingIn = event({ id: 'moving-in', uid: 'moving-in', occurrenceIdentity: 'moving-in', title: 'Alpha', startDate, endDate });
  const alphaPath = `${buildNativeCalendarRecordFileName(movingIn)}.md`;
  const betaPath = `${buildNativeCalendarRecordFileName(movingAway)}.md`;
  const movingAwayId = canonicalId(calendar.id, movingAway.occurrenceIdentity);
  const movingInId = canonicalId(calendar.id, movingIn.occurrenceIdentity);
  const h = harness([movingAway, movingIn]);
  h.seedRecordOnDisk(alphaPath, canonicalFrontmatter(movingAway, movingAwayId, alphaPath, { eventTitle: 'Old alpha' }));
  h.seedRecordOnDisk('Z source.md', canonicalFrontmatter(movingIn, movingInId, 'Z source.md'));

  await h.service.sync([calendar], '', true, false);
  const pathById = new Map([...h.frontmatters.entries()].map(([path, frontmatter]) => [frontmatter.tpsId, path]));
  assert.equal(pathById.get(movingAwayId), betaPath);
  assert.equal(pathById.get(movingInId), alphaPath, 'the earlier source path is reused without a (2) suffix');
});

test('external interruption after a committed batch prefix refreshes state and the next sync converges', async () => {
  const h = harness([]);
  h.seedRecordOnDisk('A legacy.md', legacyFrontmatter({
    path: 'A legacy.md',
    tpsId: 'legacy-batch-first',
    calendarOccurrenceIdentity: 'batch-first',
    calendarOccurrenceId: 'batch-first',
    calendarUid: 'batch-first',
    calendarOccurrenceKey: `${calendar.id}:old-source-hash:batch-first`,
  }));
  h.seedRecordOnDisk('B legacy.md', legacyFrontmatter({
    path: 'B legacy.md',
    tpsId: 'legacy-batch-second',
    calendarOccurrenceIdentity: 'batch-second',
    calendarOccurrenceId: 'batch-second',
    calendarUid: 'batch-second',
    calendarOccurrenceKey: `${calendar.id}:old-source-hash:batch-second`,
  }));
  h.setAfterBatchEntryHook(() => {
    h.seedPlainFile('Unrelated external arrival.md');
  });

  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    await assert.rejects(
      h.service.sync([{ ...calendar, enabled: false }], '', true, false),
      /interrupted the calendar batch at entry 1/u,
    );
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(h.frontmatters.get('A legacy.md').tpsId, canonicalId(calendar.id, 'batch-first'));
  assert.equal(h.frontmatters.get('B legacy.md').tpsId, 'legacy-batch-second');
  assert.equal(h.service.recordsByPath.get('A legacy.md')?.id, canonicalId(calendar.id, 'batch-first'));
  assert.equal(h.service.syncPromise, null);

  const converged = await h.service.sync([{ ...calendar, enabled: false }], '', true, false);
  assert.equal(converged.updated, 1);
  assert.equal(h.frontmatters.get('B legacy.md').tpsId, canonicalId(calendar.id, 'batch-second'));
  assertNoRedundantFields(h.frontmatters.get('A legacy.md'));
  assertNoRedundantFields(h.frontmatters.get('B legacy.md'));
});

test('inactive legacy config without ID is irrelevant, while active config without ID fails closed', async () => {
  const h = harness([]);
  await h.service.sync([{ ...calendar, id: '', enabled: false }], '', true, false);
  await assert.rejects(
    h.service.sync([{ ...calendar, id: '', enabled: true }], '', true, false),
    /active external calendar requires a stable configuration ID/u,
  );
  assert.equal(h.mutationLog.length, 0);
});

test('native service requires GCM API v6 before any record mutation', async () => {
  const h = harness([event()], { apiVersion: 5 });
  await assert.rejects(h.service.sync([calendar], '', true, false), /nativeRecords API v6/u);
  assert.equal(h.mutationLog.length, 0);

  const missing = harness([event()], { apiVersion: undefined });
  await assert.rejects(missing.service.sync([calendar], '', true, false), /nativeRecords API v6/u);
  assert.equal(missing.mutationLog.length, 0);

  const nonNumeric = harness([event()], { apiVersion: 'six' });
  await assert.rejects(nonNumeric.service.sync([calendar], '', true, false), /nativeRecords API v6/u);
  assert.equal(nonNumeric.mutationLog.length, 0);

  const future = harness([event()], { apiVersion: 7 });
  await assert.rejects(future.service.sync([calendar], '', true, false), /nativeRecords API v6/u);
  assert.equal(future.mutationLog.length, 0);
});

test('canonical tag-identity records index without physical envelope properties', () => {
  const h = harness([]);
  const id = canonicalId(calendar.id, 'tag-occurrence');
  const encodedId = `hex-${Buffer.from(id, 'utf8').toString('hex')}`;
  const file = makeFile('calendar-tagged.md');
  h.service.indexFile(file, {
    tags: [`tps/record/v1/calendar-event/${encodedId}`],
    title: 'Tagged event',
  });
  assert.equal(h.service.recordsByPath.get(file.path)?.id, id);
});

test('calendar occurrence filenames use local date plus a safe readable title', () => {
  const startDate = new Date(2026, 7, 25, 9, 0, 0);
  assert.equal(
    buildNativeCalendarRecordFileName(event({ startDate, title: 'Standup / review: Q3?' })),
    '2026-08-25 - Standup - review- Q3',
  );
});

test('native calendar sync refuses template-protected records before planning or applying mutations', async () => {
  const incoming = event();
  const id = canonicalId(calendar.id, incoming.occurrenceIdentity);
  const h = harness([incoming], { canAutomaticallyMutate: async () => false });
  h.seedRecordOnDisk('protected-calendar.md', canonicalFrontmatter(incoming, id, 'protected-calendar.md'));

  await assert.rejects(
    h.service.sync([calendar], '', true, false),
    /template-protected record/u,
  );
  assert.ok(h.preflightLog.length > 0, 'non-mutating GCM planning may precede the protection decision');
  assert.equal(h.mutationLog.length, 0);
});

test('native calendar sync repeats the protection check at the GCM batch boundary', async () => {
  const incoming = event();
  const id = canonicalId(calendar.id, incoming.occurrenceIdentity);
  let checks = 0;
  const h = harness([incoming], {
    canAutomaticallyMutate: async () => {
      checks += 1;
      return checks === 1;
    },
  });
  h.seedRecordOnDisk('raced-calendar.md', canonicalFrontmatter(incoming, id, 'raced-calendar.md'));

  await assert.rejects(
    h.service.sync([calendar], '', true, false),
    /template-protected record/u,
  );
  assert.equal(checks, 2);
  assert.equal(h.mutationLog.length, 0);
});

test('native calendar sync ignores a protected physical no-op while creating an unrelated record', async () => {
  const incoming = event({ id: 'new-event', uid: 'new-event', occurrenceIdentity: 'new-event' });
  const unrelatedEvent = event({
    id: 'unrelated-event',
    uid: 'unrelated-event',
    occurrenceIdentity: 'unrelated-event',
    title: 'Unrelated protected record',
  });
  const unrelatedId = canonicalId('unconfigured-calendar', unrelatedEvent.occurrenceIdentity);
  let protectionChecks = 0;
  const h = harness([incoming], {
    canAutomaticallyMutate: async () => {
      protectionChecks += 1;
      return false;
    },
  });
  h.seedRecordOnDisk(
    'Unrelated protected record.md',
    canonicalFrontmatter(unrelatedEvent, unrelatedId, 'Unrelated protected record.md'),
  );

  const result = await h.service.sync([calendar], '', true, false);

  assert.equal(result.created, 1);
  assert.equal(protectionChecks, 0, 'same-ID, same-path, empty-update entries do not touch the note');
  assert.ok(h.mutationLog.some((entry) => entry.type === 'create'));
});

test('native calendar mutation classifier includes a case-only identity correction', () => {
  const incoming = event();
  const id = canonicalId(calendar.id, incoming.occurrenceIdentity);
  const caseVariant = id.replace(/[A-Z]/u, (value) => value.toLocaleLowerCase());
  assert.notEqual(caseVariant, id);
  assert.equal(caseVariant.toLocaleLowerCase(), id.toLocaleLowerCase());
  const path = `${buildNativeCalendarRecordFileName(incoming)}.md`;
  const h = harness([]);
  const file = h.seedRecord(path, canonicalFrontmatter(incoming, caseVariant, path));

  const records = h.service.automaticallyMutatedRecords({
    entries: [{
      operation: 'reidentify',
      reference: caseVariant,
      nextId: id,
      updates: [],
    }],
    plannedBatch: { entries: [{ expectedPath: path }] },
  });

  assert.deepEqual(records.map((record) => record.file), [file]);
});

test('native calendar sync protects an update-only record even when its path and identity are stable', async () => {
  const incoming = event();
  const id = canonicalId(calendar.id, incoming.occurrenceIdentity);
  const path = `${buildNativeCalendarRecordFileName(incoming)}.md`;
  const h = harness([incoming], { canAutomaticallyMutate: async () => false });
  h.seedRecordOnDisk(path, canonicalFrontmatter(incoming, id, path, { title: 'Stale title' }));

  await assert.rejects(
    h.service.sync([calendar], '', true, false),
    /template-protected record/u,
  );
  assert.equal(h.mutationLog.length, 0);
  assert.equal(h.frontmatters.get(path).title, 'Stale title');
});

test('new native calendar notes omit public kind without an explicit template kind', async () => {
  const incoming = event();
  const h = harness([incoming]);
  await h.service.sync([calendar], '', true, false);
  const [record] = h.frontmatters.values();
  assert.equal(Object.hasOwn(record, 'kind'), false);
  assert.equal(record.scheduled, incoming.startDate.toISOString());
  assert.equal(record.end, incoming.endDate.toISOString());
  const handle = await h.api.resolve(record.tpsId);
  assert.equal(handle.kind, 'calendar-event');
  assert.equal(Object.hasOwn(handle.frontmatter, 'kind'), false);
  assert.equal((await h.service.sync([calendar], '', true, false)).created, 0);
  assert.equal(h.files.size, 1);
});

test('native calendar template contributes public kind, defaults, body and variables but never source identity', async () => {
  const incoming = event({ title: 'Weekly 1:1' });
  const templatePath = 'Templates/Meeting.md';
  let preparations = 0;
  const h = harness([incoming], {
    templates: {
      [templatePath]: [
        '---', 'kind: Team Meeting', 'status: working', 'tags: [template, work, calendar-event]',
        'tpsId: source-template-id', 'tpsSchemaVersion: 1', 'calendarOccurrenceKey: never-copy',
        'externalId: old-provider-id', 'createdDate: 2026-01-01',
        'agenda: review', 'scheduled: 2000-01-01', '---',
        'Discuss {{title}}.', 'Starts {{start}} and ends {{end}}.', '',
      ].join('\n'),
    },
    prepareInstanceSource(source) {
      preparations += 1;
      return source.replace('[template, work, calendar-event]', '[work, calendar-event]');
    },
  });
  const configured = { ...calendar, autoCreateTemplate: templatePath, autoCreateTag: 'team' };
  const first = await h.service.sync([configured], '', true, false);
  assert.equal(first.created, 1);
  assert.equal(preparations, 1);
  const [path, record] = [...h.frontmatters.entries()][0];
  assert.equal(record.kind, 'Team Meeting');
  assert.equal(record.status, 'working');
  assert.equal(record.agenda, 'review');
  assert.equal(record.tpsId, canonicalId(calendar.id, incoming.occurrenceIdentity));
  assert.equal(record.scheduled, incoming.startDate.toISOString());
  assert.equal(record.end, incoming.endDate.toISOString());
  assert.deepEqual(record.tags, ['work', 'calendar-event']);
  for (const key of ['externalId', 'calendarOccurrenceKey', 'createdDate', 'tpsSchemaVersion']) {
    assert.equal(Object.hasOwn(record, key), false, key);
  }
  assert.equal(h.bodies.get(path), `Discuss Weekly 1:1.\nStarts ${incoming.startDate.toISOString()} and ends ${incoming.endDate.toISOString()}.\n`);
  assert.equal(h.preflightLog[0].entries[0].body, h.bodies.get(path));
  h.mutateBusinessFieldOnDisk(path, { kind: 'event', status: 'complete' });
  h.bodies.set(path, 'My private meeting notes.\n');
  await h.service.sync([{ ...configured, autoCreateTemplate: 'Templates/Now missing.md' }], '', true, false);
  assert.equal(preparations, 1, 'existing notes are not re-templated');
  const [updatedPath, updated] = [...h.frontmatters.entries()][0];
  assert.equal(updated.kind, 'event');
  assert.equal(updated.status, 'complete');
  assert.deepEqual(updated.tags, ['work', 'calendar-event']);
  assert.equal(h.bodies.get(updatedPath), 'My private meeting notes.\n');
  assert.equal(h.files.size, 1);
});

test('native calendar template without kind keeps it absent and preserves a blank authored status', async () => {
  const h = harness([event()], { templates: { 'Template.md': '---\nstatus: ""\n---\nBody\n' } });
  await h.service.sync([{ ...calendar, autoCreateTemplate: 'Template.md' }], '', true, false);
  const [record] = h.frontmatters.values();
  assert.equal(Object.hasOwn(record, 'kind'), false);
  assert.equal(record.status, '');
});

test('feed all-day state overrides conflicting template defaults on the first creation', async () => {
  for (const isAllDay of [false, true]) {
    const incoming = event({ isAllDay });
    const h = harness([incoming], {
      templates: { 'Template.md': `---\nallDay: ${!isAllDay}\n---\n` },
    });
    await h.service.sync([{ ...calendar, autoCreateTemplate: 'Template.md' }], '', true, false);
    const [record] = h.frontmatters.values();
    if (isAllDay) {
      assert.equal(record.allDay, true);
      assert.match(record.scheduled, /^\d{4}-\d{2}-\d{2}$/u);
    } else {
      assert.equal(Object.hasOwn(record, 'allDay'), false);
      assert.equal(record.scheduled, incoming.startDate.toISOString());
      assert.equal(record.end, incoming.endDate.toISOString());
    }
  }
});

test('native calendar handles empty template frontmatter without leaking delimiters into body', async () => {
  const h = harness([event()], { templates: { 'Template.md': '---\n---\nBody\n' } });
  await h.service.sync([{ ...calendar, autoCreateTemplate: 'Template.md' }], '', true, false);
  assert.equal([...h.bodies.values()][0], 'Body\n');
});

test('calendar template variables remain data when a feed title contains YAML punctuation', async () => {
  const incoming = event({ title: 'Planning "review"\nextra: unsafe' });
  const h = harness([incoming], { templates: { 'Template.md': '---\nlabel: "{{title}}"\n---\n{{title}}\n' } });
  await h.service.sync([{ ...calendar, autoCreateTemplate: 'Template.md' }], '', true, false);
  const [record] = h.frontmatters.values();
  assert.equal(record.label, incoming.title);
  assert.equal(Object.hasOwn(record, 'extra'), false);
  assert.equal([...h.bodies.values()][0], `${incoming.title}\n`);
});

test('cancelled template-created calendar events restore their authored initial workflow status', async () => {
  const incoming = event({ isCancelled: true });
  const h = harness([incoming], { templates: { 'Template.md': '---\nstatus: working\nkind: event\n---\n' } });
  const configured = { ...calendar, autoCreateTemplate: 'Template.md' };
  await h.service.sync([configured], '', true, false);
  assert.equal([...h.frontmatters.values()][0].status, 'cancelled');
  h.setEvents([{ ...incoming, isCancelled: false }]);
  await h.service.sync([configured], '', true, false);
  assert.equal([...h.frontmatters.values()][0].status, 'working');
  assert.equal([...h.frontmatters.values()][0].kind, 'event');
});

test('unsafe or missing native calendar templates abort before any create or migration', async () => {
  const cases = [
    { source: undefined, expected: /template was not found/u },
    { source: '---\nkind: [broken\n---\n', expected: /frontmatter is invalid/u },
    { source: '---\nkind: event\n', expected: /unclosed frontmatter/u },
    { source: '---\nkind: true\n---\n', expected: /kind must be text/u },
    { source: '---\nkind: event\nKind: task\n---\n', expected: /duplicate property/u },
    { source: '<% tp.date.now() %>', expected: /executable Templater/u },
    { source: 'Template content', prepareInstanceSource: () => null, expected: /GCM rejected/u },
  ];
  for (const fixture of cases) {
    const h = harness([event()], {
      templates: fixture.source === undefined ? {} : { 'Template.md': fixture.source },
      prepareInstanceSource: fixture.prepareInstanceSource,
    });
    h.seedRecord('legacy.md', legacyFrontmatter({
      tpsId: 'legacy-other-occurrence', calendarUid: 'other', calendarOccurrenceIdentity: 'other',
      calendarOccurrenceKey: `${calendar.id}:old-source-hash:other`,
    }));
    await assert.rejects(h.service.sync([{ ...calendar, autoCreateTemplate: 'Template.md' }], '', true, false), fixture.expected);
    assert.equal(h.mutationLog.length, 0);
    assert.equal(h.preflightLog.length, 0);
  }
});

test('native calendar refuses old GCM capabilities before injecting a fallback kind', async () => {
  const h = harness([event()], { calendarTemplateRecords: false });
  await assert.rejects(h.service.sync([calendar], '', true, false), /calendarTemplateRecords support/u);
  assert.equal(h.mutationLog.length, 0);
});

test('native calendar template setting remains reachable with a saved legacy task mode', () => {
  const source = readFileSync(new URL('../src/settings-tab.ts', import.meta.url), 'utf8');
  assert.match(source, /if \(this\.plugin\.settings\.calendarStorageMode === "native-records" \|\| \(calendar\.autoCreateMode \|\| "note"\) === "note"\) \{\s*new Setting\(acContent\)\s*\.setName\("Template"\)/u);
  assert.match(source, /Quote variables in YAML values/u);
  assert.match(source, /Executable Templater commands are not supported/u);
});

const preserveCalendar = { ...calendar, preserveNotesOnExternalReschedule: true };
const currentNotes = h => [...h.frontmatters.entries()].filter(([, fm]) => !fm.tpsCalendarSync?.retired);

test('external reschedule retains the original identity, path, authored body and properties; only the new note stays active', async () => {
  const h = harness([event()]);
  await h.service.sync([preserveCalendar], '', true, false);
  const [oldPath, oldFm] = currentNotes(h)[0];
  h.bodies.set(oldPath, 'Meeting notes and [[links]] stay here.');
  h.mutateBusinessFieldOnDisk(oldPath, { status: 'complete', project: 'A' });
  const original = structuredClone(h.frontmatters.get(oldPath));
  h.setEvents([event({ startDate: futureDate(4), title: 'Moved meeting' })]);
  const moved = await h.service.sync([preserveCalendar], '', true, false);
  assert.equal(moved.created, 1);
  assert.equal(h.files.size, 2);
  assert.deepEqual(h.frontmatters.get(oldPath), { ...original, tpsCalendarSync: { ...original.tpsCalendarSync, retired: true } });
  assert.equal(h.bodies.get(oldPath), 'Meeting notes and [[links]] stay here.');
  const [newPath, newFm] = currentNotes(h)[0];
  assert.notEqual(newPath, oldPath);
  assert.notEqual(newFm.tpsId, oldFm.tpsId);
  assert.equal(newFm.tpsCalendarSync.occurrenceId, oldFm.tpsId);
  assert.equal(newFm.scheduled, futureDate(4).toISOString());
  assert.equal(newFm.project, undefined);
  assert.notEqual(newFm.status, 'complete');
  h.service.recordsByPath.clear();
  h.service.pathsById.clear();
  const repeat = await h.service.sync([preserveCalendar], '', true, false);
  assert.equal(repeat.created, 0);
  assert.equal(repeat.updated, 0);
  assert.equal(h.files.size, 2);
});

test('local schedule edits and feed title-only edits never create history', async () => {
  const h = harness([event()]);
  await h.service.sync([preserveCalendar], '', true, false);
  const [path] = currentNotes(h)[0];
  h.mutateBusinessFieldOnDisk(path, { scheduled: futureDate(5).toISOString(), end: futureDate(6).toISOString(), allDay: true });
  h.setEvents([event({ title: 'Renamed only' })]);
  assert.equal((await h.service.sync([preserveCalendar], '', true, false)).created, 0);
  assert.equal(h.files.size, 1);
  assert.equal(currentNotes(h)[0][1].scheduled, event().startDate.toISOString());
  assert.equal(currentNotes(h)[0][1].title, 'Renamed only');
});

test('existing untracked notes establish a feed baseline without guessing at a prior reschedule', async () => {
  const h = harness([event()]);
  await h.service.sync([calendar], '', true, false);
  h.setEvents([event({ startDate: futureDate(3) })]);
  assert.equal((await h.service.sync([preserveCalendar], '', true, false)).created, 0);
  assert.equal(h.files.size, 1);
  assert.ok(currentNotes(h)[0][1].tpsCalendarSync);
  h.setEvents([event({ startDate: futureDate(4) })]);
  assert.equal((await h.service.sync([preserveCalendar], '', true, false)).created, 1);
});

test('end-only changes and all-day conversions create history, including a return to an earlier schedule', async () => {
  const original = event();
  const h = harness([original]);
  await h.service.sync([preserveCalendar], '', true, false);
  for (const next of [event({ endDate: new Date(original.endDate.getTime() + 60_000) }), event({ isAllDay: true }), original]) {
    h.setEvents([next]);
    assert.equal((await h.service.sync([preserveCalendar], '', true, false)).created, 1);
  }
  assert.equal(h.files.size, 4);
  assert.equal(currentNotes(h).length, 1);
  assert.equal(new Set([...h.frontmatters.values()].map(fm => fm.tpsId)).size, 4);
});

test('cancellation does not fork and later cancellation restoration only affects the current generation', async () => {
  const h = harness([event()]);
  await h.service.sync([preserveCalendar], '', true, false);
  h.setEvents([event({ startDate: futureDate(3), isCancelled: true })]);
  assert.equal((await h.service.sync([preserveCalendar], '', true, false)).created, 0);
  h.setEvents([event({ startDate: futureDate(3) })]);
  assert.equal((await h.service.sync([preserveCalendar], '', true, false)).created, 0);
  h.setEvents([event({ startDate: futureDate(4) })]);
  await h.service.sync([preserveCalendar], '', true, false);
  const history = [...h.frontmatters.entries()].find(([, fm]) => fm.tpsCalendarSync.retired);
  const saved = structuredClone(history[1]);
  h.setEvents([event({ startDate: futureDate(4), isCancelled: true })]);
  await h.service.sync([preserveCalendar], '', true, false);
  h.setEvents([event({ startDate: futureDate(4) })]);
  await h.service.sync([preserveCalendar], '', true, false);
  assert.equal(h.files.size, 2);
  assert.deepEqual(h.frontmatters.get(history[0]), saved);
});

test('disabling preservation still follows the current generation; filtering does not mark it missing', async () => {
  const h = harness([event()]);
  await h.service.sync([preserveCalendar], '', true, false);
  h.setEvents([event({ startDate: futureDate(3) })]);
  await h.service.sync([preserveCalendar], '', true, false);
  const currentId = currentNotes(h)[0][1].tpsId;
  const history = [...h.frontmatters.entries()].find(([, fm]) => fm.tpsCalendarSync.retired);
  const saved = structuredClone(history[1]);
  h.setEvents([event({ startDate: futureDate(4) })]);
  assert.equal((await h.service.sync([calendar], '', true, false)).created, 0);
  assert.equal(currentNotes(h)[0][1].tpsId, currentId);
  h.settings.syncOnEventDelete = 'archive';
  const filtered = await h.service.sync([calendar], 'standup', true, false);
  assert.equal(filtered.archived, 0);
  h.setEvents([]);
  assert.equal((await h.service.sync([calendar], '', true, false)).archived, 1);
  assert.deepEqual(h.frontmatters.get(history[0]), saved);
});

test('an interrupted retirement retries safely even if preservation was disabled before retry', async () => {
  const h = harness([event()]);
  await h.service.sync([preserveCalendar], '', true, false);
  h.setEvents([event({ startDate: futureDate(3) })]);
  h.setAfterBatchEntryHook(() => h.seedPlainFile('Unrelated interruption.md'));
  await assert.rejects(h.service.sync([preserveCalendar], '', true, false), /interrupted/u);
  assert.equal(currentNotes(h).length, 0);
  await h.service.sync([calendar], '', true, false);
  assert.equal(currentNotes(h).length, 1);
  assert.ok(currentNotes(h)[0][1].tpsCalendarSync);
  assert.equal((await h.service.sync([calendar], '', true, false)).created, 0);
  assert.equal(h.frontmatters.size, 2);
});

test('the new generation gets a fresh template and never inherits template sync ownership', async () => {
  const path = 'Templates/Meeting.md';
  const h = harness([event()], { templates: { [path]: '---\nstatus: planned\nproject: template\ntpsCalendarSync:\n  retired: true\n---\nAgenda for {{title}}' } });
  const config = { ...preserveCalendar, autoCreateTemplate: path };
  await h.service.sync([config], '', true, false);
  const [oldPath] = currentNotes(h)[0];
  h.bodies.set(oldPath, 'Completed agenda');
  h.setEvents([event({ startDate: futureDate(3), title: 'New appointment' })]);
  await h.service.sync([config], '', true, false);
  const [newPath, fm] = currentNotes(h)[0];
  assert.equal(h.bodies.get(oldPath), 'Completed agenda');
  assert.match(h.bodies.get(newPath), /Agenda for New appointment/u);
  assert.equal(fm.project, 'template');
  assert.equal(fm.tpsCalendarSync.retired, undefined);
});

test('invalid creation template rejects a reschedule before retiring or modifying the old note', async () => {
  const h = harness([event()]);
  await h.service.sync([preserveCalendar], '', true, false);
  const snapshot = structuredClone([...h.frontmatters]);
  h.setEvents([event({ startDate: futureDate(3) })]);
  await assert.rejects(h.service.sync([{ ...preserveCalendar, autoCreateTemplate: 'Missing.md' }], '', true, false), /not found/u);
  assert.deepEqual([...h.frontmatters], snapshot);
});

test('recurring exception reschedules retain only the matching occurrence', async () => {
  const first = event({ occurrenceIdentity: 'series#first', isRecurring: true });
  const second = event({ occurrenceIdentity: 'series#second', startDate: futureDate(3), isRecurring: true });
  const h = harness([first, second]);
  await h.service.sync([preserveCalendar], '', true, false);
  const secondId = canonicalId(calendar.id, second.occurrenceIdentity);
  const secondBefore = structuredClone([...h.frontmatters].find(([, fm]) => fm.tpsId === secondId));
  h.setEvents([{ ...first, startDate: futureDate(4), endDate: futureDate(4, 10) }, second]);
  assert.equal((await h.service.sync([preserveCalendar], '', true, false)).created, 1);
  assert.deepEqual([...h.frontmatters].find(([, fm]) => fm.tpsId === secondId), secondBefore);
  assert.equal(h.files.size, 3);
});

test('reschedule option persists as an explicit boolean and settings describe its scope', () => {
  const rows = normalizeExternalCalendarsInPlace([{ ...calendar }, { ...calendar, preserveNotesOnExternalReschedule: true }, { ...calendar, preserveNotesOnExternalReschedule: 'true' }], value => value);
  assert.deepEqual(rows.map(row => row.preserveNotesOnExternalReschedule), [false, true, false]);
  const ui = readFileSync(new URL('../src/settings-tab.ts', import.meta.url), 'utf8');
  assert.match(ui, /Keep old note when externally rescheduled/u);
  assert.match(ui, /Native event notes only/u);
  assert.match(ui, /Local date edits and title-only changes do not create another note/u);
});

test('duplicate active generations and cross-source tracking fail before changing any note', async () => {
  for (const foreign of [false, true]) {
    const h = harness([event()]);
    await h.service.sync([preserveCalendar], '', true, false);
    const [, fm] = currentNotes(h)[0];
    h.seedRecordOnDisk('Conflicting generation.md', { ...fm, tpsId: canonicalId(foreign ? 'different-calendar' : calendar.id, 'other-generation') });
    const snapshot = structuredClone([...h.frontmatters]);
    h.setEvents([event({ startDate: futureDate(3) })]);
    await assert.rejects(h.service.sync([preserveCalendar], '', true, false), foreign ? /different source/u : /More than one active/u);
    assert.deepEqual([...h.frontmatters], snapshot);
  }
});

test('malformed tracking does not break startup indexing but blocks sync before writes', async () => {
  const h = harness([event()]);
  const id = canonicalId(calendar.id, 'uid-1');
  assert.doesNotThrow(() => h.seedRecord('Malformed tracking.md', {
    ...canonicalFrontmatter(event(), id, 'Malformed tracking.md'), tpsCalendarSync: { retired: true },
  }));
  const before = structuredClone([...h.frontmatters]);
  await assert.rejects(h.service.sync([preserveCalendar], '', true, false), /Invalid calendar schedule tracking/u);
  assert.deepEqual([...h.frontmatters], before);
});

test('reschedule actions upsert previous/current properties once and retain unrelated user data', async () => {
  const config={...preserveCalendar,rescheduleActions:[{target:'previous',key:'status',value:'rescheduled'},{target:'previous',key:'reason',value:'Moved externally'},{target:'current',key:'review',value:'true'},{target:'current',key:'score',value:'2'}]};
  const h=harness([event()]);
  await h.service.sync([config],'',true,false);
  const [oldPath]=currentNotes(h)[0];
  assert.equal(h.frontmatters.get(oldPath).reason,undefined);
  h.setEvents([event({startDate:futureDate(3)})]);
  await h.service.sync([config],'',true,false);
  assert.equal(h.frontmatters.get(oldPath).status,'rescheduled');assert.equal(h.frontmatters.get(oldPath).reason,'Moved externally');
  const [path,fm]=currentNotes(h)[0];assert.equal(fm.review,true);assert.equal(fm.score,2);
  h.mutateBusinessFieldOnDisk(path,{review:false,score:99});
  const repeat=await h.service.sync([config],'',true,false);assert.equal(repeat.created,0);assert.equal(repeat.updated,0);
  assert.equal(h.frontmatters.get(path).score,99);
});
test('in-place reschedule actions need a baseline and ignore local/date and title-only edits', async()=>{
 const config={...calendar,rescheduleActions:[{target:'current',key:'status',value:'rescheduled'},{target:'current',key:'labels',value:'["moved","review"]'}]};
 const h=harness([event()]);await h.service.sync([config],'',true,false);const[path]=currentNotes(h)[0];
 h.mutateBusinessFieldOnDisk(path,{scheduled:futureDate(5).toISOString()});
 h.setEvents([event({title:'Renamed'})]);await h.service.sync([config],'',true,false);assert.equal(currentNotes(h)[0][1].labels,undefined);
 h.setEvents([event({startDate:futureDate(3)})]);const result=await h.service.sync([config],'',true,false);
 assert.equal(result.created,0);assert.equal(h.files.size,1);assert.equal(currentNotes(h)[0][1].status,'rescheduled');assert.deepEqual(currentNotes(h)[0][1].labels,['moved','review']);
});
test('interrupted retirement retries the exact generation identity and applies the new-note actions', async()=>{
 const config={...preserveCalendar,rescheduleActions:[{target:'current',key:'reason',value:'moved'}]};
 const h=harness([event()]);await h.service.sync([config],'',true,false);
 h.setEvents([event({startDate:futureDate(3)})]);h.setAfterBatchEntryHook(()=>h.seedPlainFile('Interrupt.md'));
 await assert.rejects(h.service.sync([config],'',true,false),/interrupted/);
 const intended=h.preflightLog.at(-1).entries.find(entry=>entry.operation==='create').nextId;
 await h.service.sync([config],'',true,false);
 assert.equal(currentNotes(h)[0][1].tpsId,intended);assert.equal(currentNotes(h)[0][1].reason,'moved');
});
test('invalid/reserved/duplicate reschedule keys fail before note mutation', async()=>{
 for(const actions of [
  [{target:'current',key:'tpsId',value:'oops'}], [{target:'current',key:'recurrenceRule',value:'FREQ=DAILY'}],
  [{target:'current',key:'scheduled',value:'2026-01-01'}], [{target:'current',key:'tpsCalendarSync',value:'oops'}],
  [{target:'current',key:'project',value:'a'},{target:'current',key:'Project',value:'b'}],
  [{target:'current',key:'project',value:'{"bad":true}'}],
 ]){const h=harness([event()]);await assert.rejects(h.service.sync([{...calendar,rescheduleActions:actions}],'',true,false));assert.equal(h.files.size,0);}
});
test('actions are frozen before fetch even when the settings editor changes the live object', async()=>{
 const config={...calendar,rescheduleActions:[{target:'current',key:'reason',value:'original'}]};
 const h=harness([event()]);await h.service.sync([config],'',true,false);
 h.setEvents([event({startDate:futureDate(3)})]);h.setFetchHook((url)=>{config.rescheduleActions[0].value='changed';return {ok:true,events:[event({startDate:futureDate(3)})],normalizedUrl:url,fromCache:false};});
 await h.service.sync([config],'',true,false);assert.equal(currentNotes(h)[0][1].reason,'original');
});
test('external instance templates and existing managed records cannot spawn a second local recurrence series', async()=>{
 const h=harness([event()]);await h.service.sync([calendar],'',true,false);
 const [path]=currentNotes(h)[0];h.mutateBusinessFieldOnDisk(path,{recurrenceRule:'FREQ=DAILY',recurrence:'daily',rrule:'FREQ=DAILY',project:'keep'});
 await h.service.sync([calendar],'',true,false);const fm=currentNotes(h)[0][1];
 assert.equal(fm.recurrenceRule,undefined);assert.equal(fm.recurrence,undefined);assert.equal(fm.rrule,undefined);assert.equal(fm.project,'keep');
});

test('stale feed revisions cannot move an occurrence back, rerun actions, or archive its active generation',async()=>{
 const config={...preserveCalendar,rescheduleActions:[{target:'current',key:'reason',value:'moved'}]};
 const first=event({sourceRevision:[1,0,100]});const h=harness([first]);await h.service.sync([config],'',true,false);
 h.setEvents([event({startDate:futureDate(3),sourceRevision:[2,0,200]})]);await h.service.sync([config],'',true,false);
 const snapshot=structuredClone([...h.frontmatters]);h.settings.syncOnEventDelete='archive';h.setEvents([first]);
 const result=await h.service.sync([config],'',true,false);assert.equal(result.created,0);assert.equal(result.archived,0);assert.deepEqual([...h.frontmatters].sort(([a],[b])=>a.localeCompare(b)),snapshot.sort(([a],[b])=>a.localeCompare(b)));
});


test('real recurring feed reconciliation creates only the moved generation and remains stable after reordering',async()=>{
 const stamp=date=>date.toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z');
 const start=futureDate(2), end=new Date(start.getTime()+3600000), original=new Date(start.getTime()+86400000), moved=new Date(original.getTime()+7200000);
 const vevent=fields=>['BEGIN:VEVENT','UID:integrated-series','DTSTAMP:20260901T000000Z',...fields,'END:VEVENT'].join('\r\n');
 const master=vevent([`DTSTART:${stamp(start)}`,`DTEND:${stamp(end)}`,'RRULE:FREQ=DAILY;COUNT=3','SUMMARY:Series','SEQUENCE:1']);
 const exception=vevent([`RECURRENCE-ID:${stamp(original)}`,`DTSTART:${stamp(moved)}`,`DTEND:${stamp(new Date(moved.getTime()+3600000))}`,'SUMMARY:Moved','SEQUENCE:2']);
 const parse=parts=>new ICalParserService().parseICalData(['BEGIN:VCALENDAR','VERSION:2.0',...parts,'END:VCALENDAR'].join('\r\n'),futureDate(0),futureDate(8),true,true);
 const config={...preserveCalendar,rescheduleActions:[{target:'previous',key:'status',value:'rescheduled'},{target:'current',key:'project',value:'xyz'}]};
 const h=harness(parse([master]));await h.service.sync([config],'',true,false);assert.equal(h.files.size,3);
 h.setEvents(parse([master,exception]));let result=await h.service.sync([config],'',true,false);assert.equal(result.created,1);assert.equal(h.files.size,4);
 const retired=[...h.frontmatters].filter(([,fm])=>fm.tpsCalendarSync?.retired);assert.equal(retired.length,1);assert.equal(retired[0][1].status,'rescheduled');assert.equal(currentNotes(h).filter(([,fm])=>fm.project==='xyz').length,1);
 const snapshot=structuredClone([...h.frontmatters]);h.setEvents(parse([exception,master,master]));result=await h.service.sync([config],'',true,false);
 assert.equal(result.created,0);assert.deepEqual([...h.frontmatters].sort(([a],[b])=>a.localeCompare(b)),snapshot.sort(([a],[b])=>a.localeCompare(b)));
});

test('template recurrence instructions are stripped before external occurrence creation',async()=>{
 const h=harness([event()],{templates:{'Templates/Recurring.md':'---\nrecurrenceRule: FREQ=DAILY\nrecurrence: daily\nrrule: FREQ=DAILY\nproject: keep\n---\nBody'}});
 await h.service.sync([{...calendar,autoCreateTemplate:'Templates/Recurring.md'}],'',true,false);
 const fm=currentNotes(h)[0][1];assert.equal(fm.project,'keep');assert.equal(fm.recurrenceRule,undefined);assert.equal(fm.recurrence,undefined);assert.equal(fm.rrule,undefined);
});
