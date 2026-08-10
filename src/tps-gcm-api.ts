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
  sourcePolicy?: 'remove' | 'migrate-if-daily-note';
  resolution?: 'default' | 'exact-or-identity';
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
  move?: (ref: GcmTaskRef, target: GcmTaskMoveTarget) => Promise<GcmTaskMutationResult>;
}

export interface GcmApi {
  events?: GcmEventsApi;
  tasks?: GcmTasksApi;
  dailyNotes?: {
    ensureForIsoDate?: (isoDate: string) => Promise<TFile | null>;
  };
  identity?: {
    buildCalendarExternalId?: (event: ExternalCalendarEvent) => string;
    ensureInternalIdInFrontmatter?: (frontmatter: Record<string, unknown>) => string;
    getExternalId?: (frontmatter: Record<string, unknown> | null | undefined) => string | null;
  };
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

/**
 * Use GCM's v2 task move transaction. Version 2 is the first public contract
 * that preserves Daily Note sources as migrated records instead of deleting
 * them. Callers must fail closed when this capability is unavailable.
 */
export async function moveTaskViaGcm(
  app: App,
  ref: GcmTaskRef,
  target: GcmTaskMoveTarget,
): Promise<GcmTaskMoveAttempt> {
  const tasks = getGcmApi(app)?.tasks;
  const version = Number(tasks?.version);
  if (!Number.isFinite(version) || version < 2 || typeof tasks?.move !== 'function') {
    return { available: false, result: null };
  }
  return {
    available: true,
    result: await tasks.move(ref, target),
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
