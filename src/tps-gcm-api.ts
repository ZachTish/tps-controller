import { App } from 'obsidian';
import { TPS_EVENTS, TPS_LEGACY_EVENTS } from './tps-contracts';
import type { ExternalCalendarEvent } from './types';

export interface GcmEventsApi {
  emitFilesUpdated?: (paths: string[], options?: { sourcePluginId?: string }) => void;
}

export interface GcmApi {
  events?: GcmEventsApi;
  identity?: {
    buildCalendarExternalId?: (event: ExternalCalendarEvent) => string;
    ensureInternalIdInFrontmatter?: (frontmatter: Record<string, unknown>) => string;
    getExternalId?: (frontmatter: Record<string, unknown> | null | undefined) => string | null;
  };
}

export function getGcmApi(app: App): GcmApi | null {
  const plugins = (app as any)?.plugins;
  const plugin = plugins?.getPlugin?.('tps-global-context-menu')
    || plugins?.plugins?.['tps-global-context-menu']
    || plugins?.getPlugin?.('TPS-Global-Context-Menu (Dev)')
    || plugins?.plugins?.['TPS-Global-Context-Menu (Dev)'];
  return plugin?.api || null;
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
