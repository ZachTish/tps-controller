import type { App, TFile } from 'obsidian';
import { TPS_EVENTS, TPS_LEGACY_EVENTS } from './tps-contracts';
import type { ExternalCalendarEvent } from './types';

export interface GcmEventsApi {
  emitFilesUpdated?: (paths: string[], options?: { sourcePluginId?: string }) => void;
}

export interface GcmTaskRef {
  path: string;
  line?: number;
  lineNumber?: number;
  rawLine?: string;
  title?: string;
}

export interface GcmTaskMoveTarget {
  targetFile?: TFile;
  targetPath?: string;
  line?: number;
  lineNumber?: number;
  placement?: 'after-frontmatter' | 'line';
  sourcePolicy?: 'remove' | 'migrate-if-daily-note' | 'configured-daily-note';
  resolution?: 'default' | 'exact-or-identity';
}

export interface GcmTaskMutationCause {
  kind: 'user';
  sourcePluginId: string;
  surface: string;
  commandId?: string;
}

export interface GcmTaskMutationResult {
  ok: boolean;
  changed: boolean;
  task: {
    path: string;
    line: number;
    lineNumber: number;
    rawLine: string;
    title: string;
  } | null;
  error?: string;
}

export interface GcmTasksApi {
  version?: number;
  move?: (
    ref: GcmTaskRef,
    target: GcmTaskMoveTarget,
    cause?: GcmTaskMutationCause,
  ) => Promise<GcmTaskMutationResult>;
}

export interface GcmNativeRecordHandle {
  file: TFile;
  path: string;
  id: string;
  kind: string;
  frontmatter: Record<string, unknown>;
}

export interface GcmNativeRecordInspection {
  id: string;
  kind: string;
  schemaVersion: number;
  frontmatter: Record<string, unknown>;
  profile?: {
    identityTagPrefix?: string;
  };
}

export interface GcmNativeRecordSnapshot {
  token: number;
  revision: number;
  records: GcmNativeRecordHandle[];
}

export interface GcmNativeRecordsApi {
  version?: number;
  capabilities?: { calendarTemplateRecords?: boolean };
  isEnabled?: () => boolean;
  create?: (
    kind: 'calendar-event',
    properties: Record<string, unknown>,
    options?: Record<string, unknown>,
  ) => Promise<GcmNativeRecordHandle>;
  update?: (
    reference: TFile | string,
    updates: Record<string, unknown>,
    cause?: Record<string, unknown>,
  ) => Promise<GcmNativeRecordHandle | null>;
  rename?: (
    reference: TFile | string,
    fileName: string,
    cause?: Record<string, unknown>,
  ) => Promise<GcmNativeRecordHandle | null>;
  archive?: (
    reference: TFile | string,
    cause?: Record<string, unknown>,
  ) => Promise<GcmNativeRecordHandle | null>;
  inspect?: (frontmatter: unknown) => GcmNativeRecordInspection | null;
  /** API v6: authoritative on-disk enumeration; virtual compatibility fields may be projected in handles. */
  list?: (kind?: string) => Promise<GcmNativeRecordHandle[]>;
  /** API v6: authoritative records plus identity and mutation revisions for plan validation. */
  snapshot?: (kind?: string) => Promise<GcmNativeRecordSnapshot>;
  resolve?: (reference: TFile | string) => Promise<GcmNativeRecordHandle | null>;
  /** API v6: preflight exact ordered payloads against one authoritative index. */
  canApplyIdentityPlan?: (entries: Array<{
    operation: 'create';
    nextId: string;
    kind: 'calendar-event';
    properties: Record<string, unknown>;
    fileName?: string;
    body?: string;
  } | {
    operation: 'reidentify';
    nextId: string;
    reference: TFile | string;
    updates: Array<Record<string, unknown>>;
    fileName?: string;
  }>, snapshotToken?: number) => Promise<boolean>;
  /** API v6: exact payload plus ordered virtual path allocation, bound by the returned token. */
  planIdentityChanges?: (entries: Array<{
    operation: 'create';
    nextId: string;
    kind: 'calendar-event';
    properties: Record<string, unknown>;
    fileName?: string;
    body?: string;
  } | {
    operation: 'reidentify';
    nextId: string;
    reference: TFile | string;
    updates: Array<Record<string, unknown>>;
    fileName?: string;
  }>, snapshot: Pick<GcmNativeRecordSnapshot, 'token' | 'revision'>) => Promise<{
    token: number;
    revision: number;
    entries: Array<{ operation: 'create' | 'reidentify'; nextId: string; expectedPath: string | null }>;
  } | null>;
  /** API v6: applies one previously planned exact identity/property/path batch. */
  applyIdentityChanges?: (
    plannedBatch: {
      token: number;
      revision: number;
      entries: Array<{ operation: 'create' | 'reidentify'; nextId: string; expectedPath: string | null }>;
    },
    entries: Array<{
      operation: 'create';
      nextId: string;
      kind: 'calendar-event';
      properties: Record<string, unknown>;
      fileName?: string;
      body?: string;
    } | {
      operation: 'reidentify';
      nextId: string;
      reference: TFile | string;
      updates: Array<Record<string, unknown>>;
      fileName?: string;
    }>,
    cause?: Record<string, unknown>,
  ) => Promise<{
    ok: boolean;
    handles: GcmNativeRecordHandle[];
    failedIndex: number | null;
    error?: string;
  }>;
  /** API v6: non-mutating authoritative ownership/reservation preflight. */
  canReidentify?: (reference: TFile | string, newId: string) => Promise<boolean>;
  /** API v6: compare-and-swap the canonical identity without changing path/body/business fields. */
  reidentify?: (
    reference: TFile | string,
    newId: string,
    cause?: Record<string, unknown>,
    options?: { fileName?: string; expectedPath?: string; planToken?: number },
  ) => Promise<GcmNativeRecordHandle | null>;
}

export interface GcmApi {
  events?: GcmEventsApi;
  tasks?: GcmTasksApi;
  nativeRecords?: GcmNativeRecordsApi;
  templates?: {
    version?: number;
    canAutomaticallyMutate?: (file: TFile) => Promise<boolean>;
    canAutomaticallyMutateSource?: (source: string) => boolean;
    prepareInstanceSource?: (source: string) => string | null;
  };
  dailyNotes?: {
    version?: number;
    ensureForIsoDate?: (isoDate: string) => Promise<TFile | null>;
    getTaskSchedulePolicy?: (file: Pick<TFile, 'path' | 'basename'>) => {
      isDailyNote: boolean;
      inheritUnscheduled: boolean;
    };
  };
  identity?: {
    buildCalendarExternalId?: (event: ExternalCalendarEvent) => string;
    ensureInternalIdInFrontmatter?: (frontmatter: Record<string, unknown>) => string;
    getExternalId?: (frontmatter: Record<string, unknown> | null | undefined) => string | null;
  };
}

type GcmTemplatesApi = NonNullable<GcmApi['templates']>;

export interface GcmDailyNoteTaskSchedulePolicy {
  available: boolean;
  isDailyNote: boolean;
  inheritUnscheduled: boolean;
}

export interface GcmDailyNoteEnsureAttempt {
  available: boolean;
  file: TFile | null;
}

export interface GcmTaskMoveAttempt {
  available: boolean;
  result: GcmTaskMutationResult | null;
}

export function getGcmApi(app: App): GcmApi | null {
  const plugins = (app as any)?.plugins;
  const plugin = plugins?.getPlugin?.('tps-global-context-menu')
    || plugins?.plugins?.['tps-global-context-menu']
    || plugins?.getPlugin?.('TPS-Global-Context-Menu (Dev)')
    || plugins?.plugins?.['TPS-Global-Context-Menu (Dev)'];
  return plugin?.api || null;
}

/**
 * Preserve compatibility with GCM releases that predate templates API v1.
 * Once a callable v1 method is present, however, a rejection or exception is
 * authoritative and automatic Controller work must fail closed.
 */
export async function canAutomaticallyMutateViaGcm(app: App, file: TFile): Promise<boolean> {
  const method = getCompatibleGcmTemplatesApi(app)?.canAutomaticallyMutate;
  if (typeof method !== 'function') return true;
  try {
    return await method(file) === true;
  } catch {
    return false;
  }
}

/** Current-source mutation-boundary companion to canAutomaticallyMutateViaGcm. */
export function canAutomaticallyMutateSourceViaGcm(app: App, source: string): boolean {
  const method = getCompatibleGcmTemplatesApi(app)?.canAutomaticallyMutateSource;
  if (typeof method !== 'function') return true;
  try {
    return method(String(source ?? '')) === true;
  } catch {
    return false;
  }
}

/**
 * Strip template-only identity from bytes copied into a new note. Older GCM
 * releases retain the original source; a v1 rejection/exception aborts the
 * creation path instead of leaving a generated note classified as a template.
 */
export function prepareInstanceSourceViaGcm(app: App, source: string): string | null {
  const raw = String(source ?? '');
  const method = getCompatibleGcmTemplatesApi(app)?.prepareInstanceSource;
  if (typeof method !== 'function') return raw;
  try {
    const prepared = method(raw);
    return typeof prepared === 'string' ? prepared : null;
  } catch {
    return null;
  }
}

function getCompatibleGcmTemplatesApi(app: App): GcmTemplatesApi | null {
  const templates = getGcmApi(app)?.templates;
  return Number(templates?.version) >= 1 ? templates ?? null : null;
}

/**
 * Ask GCM's canonical daily-note service to resolve or create a date.
 * `available: false` means Controller may use its standalone fallback.
 * Errors and available-but-null results remain distinct so callers can fail
 * closed instead of creating a competing, incomplete daily note.
 */
export async function ensureDailyNoteForIsoDateViaGcm(
  app: App,
  isoDate: string,
): Promise<GcmDailyNoteEnsureAttempt> {
  const ensureForIsoDate = getGcmApi(app)?.dailyNotes?.ensureForIsoDate;
  if (typeof ensureForIsoDate !== 'function') {
    return { available: false, file: null };
  }
  const file = await ensureForIsoDate(String(isoDate || '').trim());
  return { available: true, file: file ?? null };
}

export function getDailyNoteTaskSchedulePolicyViaGcm(
  app: App,
  file: Pick<TFile, 'path' | 'basename'>,
): GcmDailyNoteTaskSchedulePolicy {
  const dailyNotes = getGcmApi(app)?.dailyNotes;
  const version = Number(dailyNotes?.version);
  if (!Number.isFinite(version) || version < 2 || typeof dailyNotes?.getTaskSchedulePolicy !== 'function') {
    return { available: false, isDailyNote: false, inheritUnscheduled: true };
  }
  const policy = dailyNotes.getTaskSchedulePolicy(file);
  return {
    available: true,
    isDailyNote: policy?.isDailyNote === true,
    inheritUnscheduled: policy?.inheritUnscheduled !== false,
  };
}

/**
 * Use GCM's v3 task move transaction. Version 3 adds the configured Daily Note
 * source policy and explicit user-action cause. Callers must fail closed when
 * this capability is unavailable; older APIs treat an unknown source policy as
 * remove-source behavior.
 */
export async function moveTaskViaGcm(
  app: App,
  ref: GcmTaskRef,
  target: GcmTaskMoveTarget,
  cause?: GcmTaskMutationCause,
): Promise<GcmTaskMoveAttempt> {
  const tasks = getGcmApi(app)?.tasks;
  const version = Number(tasks?.version);
  if (!Number.isFinite(version) || version < 3 || typeof tasks?.move !== 'function') {
    return { available: false, result: null };
  }
  return {
    available: true,
    result: await tasks.move(ref, target, cause),
  };
}

export function emitFilesUpdated(app: App, paths: string[], sourcePluginId: string): void {
  const normalized = paths.map((path) => String(path || '').trim()).filter(Boolean);
  if (!normalized.length) return;
  const api = getGcmApi(app);
  if (typeof api?.events?.emitFilesUpdated === 'function') {
    api.events.emitFilesUpdated(normalized, { sourcePluginId });
    return;
  }
  (app.workspace as any).trigger(TPS_LEGACY_EVENTS.GCM_FILES_UPDATED, normalized);
  (app.workspace as any).trigger(TPS_EVENTS.FILES_UPDATED, {
    sourcePluginId,
    timestamp: Date.now(),
    paths: normalized,
  });
}

export function buildCalendarExternalId(app: App | null | undefined, event: ExternalCalendarEvent): string {
  const api = app ? getGcmApi(app) : null;
  if (typeof api?.identity?.buildCalendarExternalId === 'function') {
    return api.identity.buildCalendarExternalId(event);
  }
  const eventId = String(event.id || '').trim();
  const sourceUrl = String(event.sourceUrl || '').trim().replace(/\/+$/, '');
  if (eventId) return `calendar:${sourceUrl}#${eventId}`;
  return String(event.url || '').trim();
}

export function ensureInternalIdInFrontmatter(app: App | null | undefined, frontmatter: Record<string, unknown>): string {
  const api = app ? getGcmApi(app) : null;
  if (typeof api?.identity?.ensureInternalIdInFrontmatter === 'function') {
    return api.identity.ensureInternalIdInFrontmatter(frontmatter);
  }
  const existingKey = Object.keys(frontmatter || {}).find((key) => key.trim().toLowerCase() === 'tpsid' || key.trim().toLowerCase() === 'subitemid');
  const existing = existingKey ? String(frontmatter[existingKey] ?? '').trim() : '';
  if (existing) return existing;
  const cryptoApi = (globalThis as any).crypto;
  const raw = typeof cryptoApi?.randomUUID === 'function'
    ? cryptoApi.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const id = `item_${raw.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  frontmatter.tpsId = id;
  return id;
}

export function getExternalId(app: App | null | undefined, frontmatter: Record<string, unknown> | null | undefined): string | null {
  const api = app ? getGcmApi(app) : null;
  if (typeof api?.identity?.getExternalId === 'function') {
    return api.identity.getExternalId(frontmatter);
  }
  if (!frontmatter) return null;
  const key = Object.keys(frontmatter).find((candidate) => candidate.trim().toLowerCase() === 'externalid');
  const value = key ? String(frontmatter[key] ?? '').trim() : '';
  return value || null;
}
