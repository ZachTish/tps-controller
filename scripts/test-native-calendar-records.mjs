import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash, webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', { value: webcrypto });

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
  return { path, name, basename: name.replace(/\.md$/u, ''), extension: 'md' };
}

function recordLink(path, alias) {
  const target = path.replace(/\.md$/u, '').replace(/([#^|\]])/gu, '\\$1');
  const label = alias.replace(/\|/gu, '\\|').replace(/\]/gu, '\\]');
  return `[[${target}|${label}]]`;
}

function harness(initialEvents = [], options = {}) {
  const files = new Map();
  const frontmatters = new Map();
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
  const settings = { calendarStorageMode: 'native-records', syncOnEventDelete: 'nothing' };
  feedStates.set(calendar.url, { ok: true, events: initialEvents });

  const identity = (frontmatter) => {
    const propertyId = String(frontmatter?.tpsId || '').trim();
    if (propertyId) return { id: propertyId, kind: String(frontmatter.kind || ''), schemaVersion: Number(frontmatter.tpsSchemaVersion) };
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
      ? { file, path, id: inspected.id, kind: inspected.kind, frontmatter: { ...frontmatter, tpsId: inspected.id, tpsSchemaVersion: 1, kind: inspected.kind } }
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

  const api = {
    version: options.apiVersion || 5,
    isEnabled: () => true,
    inspect(frontmatter) {
      const inspected = identity(frontmatter);
      return inspected?.id && inspected.kind && inspected.schemaVersion === 1
        ? {
          ...inspected,
          frontmatter: { ...frontmatter, tpsId: inspected.id, tpsSchemaVersion: 1, kind: inspected.kind },
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
          const now = new Date().toISOString();
          const file = makeFile(expectedPath);
          const frontmatter = {
            ...structuredClone(entry.properties),
            tpsId: entry.nextId,
            tpsSchemaVersion: 1,
            kind: entry.kind,
            createdDate: now,
            modifiedDate: now,
          };
          nextFiles.set(expectedPath, file);
          nextFrontmatters.set(expectedPath, frontmatter);
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
        if (frontmatter.tpsId) frontmatter.tpsId = entry.nextId;
        else {
          frontmatter.tags = Array.isArray(frontmatter.tags)
            ? frontmatter.tags.filter((tag) => !String(tag).toLocaleLowerCase().startsWith('tps/record/v1/'))
            : frontmatter.tags;
          frontmatter.tpsId = entry.nextId;
          frontmatter.tpsSchemaVersion = 1;
          frontmatter.kind = inspected.kind;
        }
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
        if (changed) frontmatter.modifiedDate = new Date().toISOString();
        const file = nextFiles.get(sourcePath);
        nextFiles.delete(sourcePath);
        nextFrontmatters.delete(sourcePath);
        Object.assign(file, makeFile(expectedPath));
        nextFiles.set(expectedPath, file);
        nextFrontmatters.set(expectedPath, frontmatter);
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
      const frontmatter = {
        ...properties,
        tpsId: id,
        tpsSchemaVersion: 1,
        kind,
        createdDate: new Date().toISOString(),
        modifiedDate: new Date().toISOString(),
      };
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
      frontmatter.modifiedDate = new Date().toISOString();
      frontmatters.set(path, frontmatter);
      authoritativeToken += 1;
      mutationRevision += 1;
      return toHandle(path);
    },
    async reidentify(reference, nextId) {
      const path = resolvePath(reference);
      if (!path || !isFreeIdentity(nextId, path)) return null;
      mutationLog.push({ type: 'reidentify', path, nextId });
      const frontmatter = { ...frontmatters.get(path) };
      const inspected = identity(frontmatter);
      if (frontmatter.tpsId) frontmatter.tpsId = nextId;
      else if (Array.isArray(frontmatter.tags)) {
        frontmatter.tags = frontmatter.tags.filter((tag) => !String(tag).startsWith('tps/record/v1/'));
        frontmatter.tpsId = nextId;
        frontmatter.tpsSchemaVersion = 1;
        frontmatter.kind = inspected.kind;
      }
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
    plugins: { getPlugin: (id) => id === 'tps-global-context-menu' ? { api: { nativeRecords: api } } : null },
    vault: {
      getMarkdownFiles: () => [...files.values()],
      getAbstractFileByPath: (path) => files.get(path) || null,
      getFileByPath: (path) => files.get(path) || null,
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
  const service = new NativeCalendarRecordService(app, external, () => settings);
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
    mutationLog,
    preflightLog,
    api,
    seedRecord,
    seedRecordOnDisk,
    seedPlainFile,
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
    description: 'Keep this business content',
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
    tpsSchemaVersion: 1,
    kind: 'calendar-event',
    title: recordLink(path, calendarEvent.title),
    eventTitle: calendarEvent.title,
    status: 'scheduled',
    scheduled: calendarEvent.startDate.toISOString(),
    end: calendarEvent.endDate.toISOString(),
    durationMinutes: Math.round((calendarEvent.endDate - calendarEvent.startDate) / 60_000),
    allDay: calendarEvent.isAllDay,
    description: calendarEvent.description,
    location: calendarEvent.location || '',
    organizer: calendarEvent.organizer || '',
    attendees: calendarEvent.attendees || [],
    url: calendarEvent.url || '',
    tags: ['calendar-event'],
    ...overrides,
  };
}

function assertNoRedundantFields(frontmatter) {
  for (const key of REDUNDANT_CALENDAR_RECORD_PROPERTIES) {
    assert.equal(Object.hasOwn(frontmatter, key), false, `${key} must not be persisted`);
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
  assert.equal(Object.hasOwn(original, 'associatedNote'), false);

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

test('cancelled events update in place and a later feed failure preserves cancellation', async () => {
  const h = harness([event()]);
  await h.service.sync([calendar], '', true, false);
  h.setEvents([event({ isCancelled: true })]);
  const cancelled = await h.service.sync([calendar], '', true, false);
  assert.equal(cancelled.cancelled, 1);
  const [path] = h.files.keys();
  assert.equal(h.frontmatters.get(path).status, 'cancelled');
  h.setFetchOk(false);
  const before = structuredClone(h.frontmatters.get(path));
  const failed = await h.service.sync([calendar], '', true, false);
  assert.equal(failed.failedFeeds, 1);
  assert.deepEqual(h.frontmatters.get(path), before);
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
  assert.deepEqual(new Set(frontmatter.tags), new Set(['calendar-event', 'customer-important', 'managed-work']));

  h.setEvents([event({ description: 'Second refresh' })]);
  await h.service.sync([configured], '', true, false);
  frontmatter = [...h.frontmatters.values()][0];
  assert.equal(frontmatter.status, 'complete');
  assert.equal(frontmatter.description, 'Second refresh');
  assert.deepEqual(new Set(frontmatter.tags), new Set(['calendar-event', 'customer-important', 'managed-work']));
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
    'calendar-event',
    'managed-tag',
  ]));
  assert.equal(frontmatter.tags.some((tag) => tag.startsWith('tps/record/v1/')), false);
  const plan = h.preflightLog[0].entries.find((entry) => entry.reference === oldId);
  const plannedTags = plan.updates.flatMap((updates) => Array.isArray(updates.tags) ? updates.tags : []);
  assert.equal(plannedTags.some((tag) => tag.startsWith('tps/record/v1/')), false);
});

test('calendar configuration values are snapshotted before async work and apply changes next sync', async () => {
  const configured = { ...calendar, autoCreateTag: 'planned-tag' };
  const h = harness([event()]);
  h.setAfterPreflightHook(() => {
    configured.autoCreateTag = 'next-sync-tag';
  });

  await h.service.sync([configured], '', true, false);
  let frontmatter = [...h.frontmatters.values()][0];
  assert.ok(frontmatter.tags.includes('planned-tag'));
  assert.equal(frontmatter.tags.includes('next-sync-tag'), false);
  const createPlan = h.preflightLog[0].entries.find((entry) => entry.operation === 'create');
  assert.deepEqual(createPlan.properties.tags, ['calendar-event', 'planned-tag']);

  await h.service.sync([configured], '', true, false);
  frontmatter = [...h.frontmatters.values()][0];
  assert.ok(frontmatter.tags.includes('planned-tag'));
  assert.ok(frontmatter.tags.includes('next-sync-tag'));
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
    new Set(['calendar-event', 'current-disk-tag', 'managed-calendar']),
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

test('exact create payload rejects a reserved identity tag before an earlier migration', async () => {
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

  await assert.rejects(
    h.service.sync([{ ...calendar, autoCreateTag: 'tps/record/v1/task/injected' }], '', true, false),
    /rejected the complete calendar identity plan/u,
  );
  const createPlan = h.preflightLog[0].entries.find((entry) => entry.operation === 'create');
  assert.ok(createPlan.properties.tags.includes('tps/record/v1/task/injected'));
  assert.equal(h.mutationLog.length, 0);
  assert.equal(h.frontmatters.get('first-legacy.md').tpsId, 'legacy-before-invalid-create-tag');
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
  assert.ok(plannedUpdateKeys(fetchedPlan).includes('title'), 'self-link title is reserved in the same source plan');
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

test('fetched create target occupied by another native kind fails before migration writes', async () => {
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
  });
  await assert.rejects(
    h.service.sync([calendar], '', true, false),
    /rejected the complete calendar identity plan/u,
  );
  assert.equal(h.preflightLog.length, 1);
  assert.equal(h.mutationLog.length, 0);
  assert.equal(h.frontmatters.get('legacy.md').tpsId, 'legacy-other-occurrence');
});

test('authoritative path planning relocates an outside-root legacy record and links the final path', async () => {
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
  assert.equal(h.frontmatters.get(expectedPath).title, recordLink(expectedPath, incoming.title));
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
  assert.equal(h.frontmatters.get(basePath).title, recordLink(basePath, first.title));
  assert.equal(h.frontmatters.get(secondPath).title, recordLink(secondPath, second.title));
  assert.equal(h.frontmatters.get(thirdPath).title, recordLink(thirdPath, created.title));
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

test('native service requires GCM API v5 before any record mutation', async () => {
  const h = harness([event()], { apiVersion: 4 });
  await assert.rejects(h.service.sync([calendar], '', true, false), /nativeRecords API v5/u);
  assert.equal(h.mutationLog.length, 0);
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
