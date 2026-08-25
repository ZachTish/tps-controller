import { App, TFile } from "obsidian";
import type { ExternalCalendarConfig, ExternalCalendarEvent, TPSControllerSettings } from "../types";
import { normalizeCalendarUrl } from "../utils";
import { buildExternalCalendarTaskNoteLink } from "./external-calendar-task-note";
import type { ExternalCalendarService } from "./external-calendar-service";
import * as logger from "../logger";

export const TPS_CONTROLLER_NATIVE_CALENDAR_RECORDS_VERSION = 1;

interface NativeRecordHandle {
    file: TFile;
    path: string;
    id: string;
    kind: string;
    frontmatter: Record<string, unknown>;
}

interface NativeRecordsApi {
    version: number;
    isEnabled(): boolean;
    create(kind: "calendar-event", properties: Record<string, unknown>, options?: Record<string, unknown>): Promise<NativeRecordHandle>;
    update(reference: TFile | string, updates: Record<string, unknown>, cause?: Record<string, unknown>): Promise<NativeRecordHandle | null>;
    rename(reference: TFile | string, fileName: string, cause?: Record<string, unknown>): Promise<NativeRecordHandle | null>;
    archive(reference: TFile | string, cause?: Record<string, unknown>): Promise<NativeRecordHandle | null>;
    inspect?(frontmatter: unknown): {
        id: string;
        kind: string;
        schemaVersion: number;
        frontmatter: Record<string, unknown>;
    } | null;
}

interface IndexedCalendarRecord {
    file: TFile;
    frontmatter: Record<string, unknown>;
    id: string;
    occurrenceKey: string;
}

export interface NativeCalendarSyncResult {
    fetched: number;
    created: number;
    updated: number;
    unchanged: number;
    cancelled: number;
    missing: number;
    archived: number;
    failedFeeds: number;
}

/** Controller-owned, one-file-per-occurrence calendar reconciliation. */
export class NativeCalendarRecordService {
    readonly version = TPS_CONTROLLER_NATIVE_CALENDAR_RECORDS_VERSION;
    private readonly recordsByPath = new Map<string, IndexedCalendarRecord>();
    private readonly pathsByOccurrenceKey = new Map<string, Set<string>>();
    private syncPromise: Promise<NativeCalendarSyncResult> | null = null;

    constructor(
        private readonly app: App,
        private readonly externalCalendarService: ExternalCalendarService,
        private readonly getSettings: () => TPSControllerSettings,
    ) {}

    setup(registerEvent: (event: unknown) => void): void {
        this.rebuild();
        registerEvent(this.app.metadataCache.on("changed", (file, _data, cache) => this.indexFile(file, cache?.frontmatter)));
        registerEvent(this.app.vault.on("create", (file) => {
            if (file instanceof TFile) this.indexFile(file);
        }));
        registerEvent(this.app.vault.on("delete", (file) => {
            if (file instanceof TFile) this.removePath(file.path);
        }));
        registerEvent(this.app.vault.on("rename", (file, oldPath) => {
            this.removePath(oldPath);
            if (file instanceof TFile) this.indexFile(file);
        }));
    }

    isEnabled(): boolean {
        return this.getSettings().calendarStorageMode === "native-records";
    }

    sync(calendars: ExternalCalendarConfig[], filter: string, force = false, backfillPastEvents = false): Promise<NativeCalendarSyncResult> {
        if (this.syncPromise) return this.syncPromise;
        const run = this.executeSync(calendars, filter, force, backfillPastEvents);
        this.syncPromise = run;
        void run.finally(() => {
            if (this.syncPromise === run) this.syncPromise = null;
        });
        return run;
    }

    private async executeSync(
        calendars: ExternalCalendarConfig[],
        filter: string,
        force: boolean,
        backfillPastEvents: boolean,
    ): Promise<NativeCalendarSyncResult> {
        const api = this.requireApi();
        // Controller can load before GCM has published API v2. Rebuild after
        // the required API is confirmed so tag-identified records missed by
        // the provisional startup pass are included before reconciliation.
        this.rebuild();
        const result: NativeCalendarSyncResult = {
            fetched: 0,
            created: 0,
            updated: 0,
            unchanged: 0,
            cancelled: 0,
            missing: 0,
            archived: 0,
            failedFeeds: 0,
        };
        const rangeStart = new Date();
        if (backfillPastEvents) rangeStart.setDate(rangeStart.getDate() - 14);
        else rangeStart.setHours(0, 0, 0, 0);
        const rangeEnd = new Date();
        rangeEnd.setDate(rangeEnd.getDate() + 60);
        const filterTerms = filter.split(",").map((value) => value.trim().toLocaleLowerCase()).filter(Boolean);
        const seenKeys = new Set<string>();
        const successfulCalendarIds = new Set<string>();
        const activeCalendars = calendars.filter((calendar) => calendar.enabled !== false && calendar.autoCreateEnabled !== false);

        for (const calendar of activeCalendars) {
            const normalizedUrl = normalizeCalendarUrl(calendar.url);
            if (!normalizedUrl) {
                result.failedFeeds += 1;
                continue;
            }
            const calendarId = this.calendarId(calendar, normalizedUrl);
            const fetched = await this.externalCalendarService.fetchEventsWithStatus(
                normalizedUrl,
                rangeStart,
                rangeEnd,
                true,
                force,
            );
            if (!fetched.ok) {
                result.failedFeeds += 1;
                continue;
            }
            successfulCalendarIds.add(calendarId);
            const events = [...fetched.events].sort((a, b) => (
                a.startDate.getTime() - b.startDate.getTime()
                || String(a.occurrenceIdentity || a.id).localeCompare(String(b.occurrenceIdentity || b.id))
            ));
            result.fetched += events.length;
            for (const event of events) {
                if (filterTerms.some((term) => event.title.toLocaleLowerCase().includes(term))) continue;
                const occurrenceKey = this.occurrenceKey(calendarId, normalizedUrl, event);
                if (seenKeys.has(occurrenceKey)) continue;
                seenKeys.add(occurrenceKey);
                const existing = this.findUniqueByOccurrenceKey(occurrenceKey);
                const properties = this.eventProperties(calendar, calendarId, normalizedUrl, event, occurrenceKey, existing);
                const fileName = buildNativeCalendarRecordFileName(event);
                if (!existing) {
                    const created = await api.create("calendar-event", properties, {
                        id: `calendar-${stableHash(occurrenceKey)}`,
                        now: event.startDate,
                        fileName,
                        cause: this.cause("controller-calendar-sync"),
                    });
                    this.trackHandle(created);
                    result.created += 1;
                    if (event.isCancelled) result.cancelled += 1;
                    continue;
                }
                const updates = changedProperties(existing.frontmatter, properties);
                let current: NativeRecordHandle = {
                    file: existing.file,
                    path: existing.file.path,
                    id: existing.id,
                    kind: "calendar-event",
                    frontmatter: existing.frontmatter,
                };
                let changed = false;
                if (Object.keys(updates).length) {
                    const updated = await api.update(existing.file, updates, this.cause("controller-calendar-sync"));
                    if (!updated) throw new Error("Calendar record changed before Controller could reconcile it.");
                    current = updated;
                    changed = true;
                }
                const renamed = await api.rename(current.file, fileName, this.cause("controller-calendar-sync"));
                if (!renamed) throw new Error("Calendar record changed before Controller could apply its readable filename.");
                if (renamed.path !== current.path) changed = true;
                this.trackHandle(renamed);
                if (changed) result.updated += 1;
                else result.unchanged += 1;
                if (event.isCancelled) result.cancelled += 1;
            }
        }

        const settings = this.getSettings();
        for (const record of [...this.recordsByPath.values()]) {
            const calendarId = String(record.frontmatter.calendarId || "");
            if (!successfulCalendarIds.has(calendarId) || seenKeys.has(record.occurrenceKey)) continue;
            const start = Date.parse(String(record.frontmatter.scheduled || ""));
            if (!Number.isFinite(start) || start < rangeStart.getTime() || start > rangeEnd.getTime()) continue;
            if (settings.syncOnEventDelete === "archive" || settings.syncOnEventDelete === "delete") {
                const archived = await api.archive(record.file, this.cause("controller-calendar-missing"));
                if (archived) {
                    this.trackHandle(archived);
                    result.archived += 1;
                }
                continue;
            }
            const updated = await api.update(record.file, {
                calendarSyncState: "missing",
                calendarMissingAt: new Date().toISOString(),
            }, this.cause("controller-calendar-missing"));
            if (updated) {
                this.trackHandle(updated);
                result.missing += 1;
            }
        }

        logger.flow("NativeCalendarRecords", "sync:done", {
            calendars: activeCalendars.length,
            fetched: result.fetched,
            created: result.created,
            updated: result.updated,
            unchanged: result.unchanged,
            cancelled: result.cancelled,
            missing: result.missing,
            archived: result.archived,
            failedFeeds: result.failedFeeds,
        });
        return result;
    }

    private eventProperties(
        calendar: ExternalCalendarConfig,
        calendarId: string,
        normalizedUrl: string,
        event: ExternalCalendarEvent,
        occurrenceKey: string,
        existing: IndexedCalendarRecord | null,
    ): Record<string, unknown> {
        const strategy = calendar.autoCreateTaskNoteStrategy || "occurrence-day";
        const folder = calendar.autoCreateTaskNoteFolder || "Calendar Events";
        const priorPath = String(existing?.frontmatter.associatedNotePath || "");
        const note = buildExternalCalendarTaskNoteLink(event, strategy, folder, priorPath || undefined);
        const scheduled = event.isAllDay ? localDateKey(event.startDate) : event.startDate.toISOString();
        const end = event.isAllDay ? localDateKey(event.endDate) : event.endDate.toISOString();
        const status = event.isCancelled ? "cancelled" : "scheduled";
        return {
            title: markdownLink(note.notePath, event.title),
            eventTitle: event.title,
            status,
            scheduled,
            end,
            durationMinutes: Math.max(0, Math.round((event.endDate.getTime() - event.startDate.getTime()) / 60_000)),
            allDay: event.isAllDay,
            description: event.description,
            location: event.location || "",
            organizer: event.organizer || "",
            attendees: event.attendees || [],
            url: event.url || "",
            calendarId,
            calendarSourceId: stableHash(normalizedUrl),
            calendarUid: event.uid,
            calendarOccurrenceId: event.id,
            calendarOccurrenceIdentity: event.occurrenceIdentity || event.id,
            calendarOccurrenceKey: occurrenceKey,
            calendarRecurring: event.isRecurring === true,
            calendarSyncState: event.isCancelled ? "cancelled" : "current",
            associatedNotePath: note.notePath,
            associatedNote: `[[${note.notePath.replace(/\.md$/iu, "")}]]`,
            associatedNoteStrategy: strategy,
            tags: ["calendar-event", ...(calendar.autoCreateTag ? [calendar.autoCreateTag.replace(/^#/u, "")] : [])],
        };
    }

    private requireApi(): NativeRecordsApi {
        const api = this.getApi();
        if (!api || Number(api.version) < 3 || api.isEnabled?.() !== true || typeof api.rename !== "function") {
            throw new Error("Controller readable native calendar records require TPS GCM native-record mode and nativeRecords API v3.");
        }
        return api as NativeRecordsApi;
    }

    private getApi(): NativeRecordsApi | null {
        const plugins = (this.app as any).plugins;
        const gcm = plugins?.getPlugin?.("tps-global-context-menu") || plugins?.plugins?.["tps-global-context-menu"];
        return (gcm?.api?.nativeRecords || null) as NativeRecordsApi | null;
    }

    private rebuild(): void {
        this.recordsByPath.clear();
        this.pathsByOccurrenceKey.clear();
        for (const file of this.app.vault.getMarkdownFiles()) this.indexFile(file);
    }

    private indexFile(file: TFile, frontmatter?: Record<string, unknown> | null): void {
        this.removePath(file.path);
        const resolved = frontmatter || this.app.metadataCache.getFileCache(file)?.frontmatter;
        const api = this.getApi();
        const inspected = Number(api?.version) >= 2 && typeof api?.inspect === "function"
            ? api.inspect(resolved)
            : null;
        const canonical = inspected?.frontmatter || resolved;
        if (String(inspected?.kind || resolved?.kind || "") !== "calendar-event"
            || Number(inspected?.schemaVersion || resolved?.tpsSchemaVersion) !== 1) return;
        const id = String(inspected?.id || resolved?.tpsId || "").trim();
        const occurrenceKey = String(canonical?.calendarOccurrenceKey || "").trim();
        if (!id || !occurrenceKey) return;
        this.recordsByPath.set(file.path, { file, frontmatter: { ...canonical }, id, occurrenceKey });
        const paths = this.pathsByOccurrenceKey.get(occurrenceKey) || new Set<string>();
        paths.add(file.path);
        this.pathsByOccurrenceKey.set(occurrenceKey, paths);
    }

    private removePath(path: string): void {
        const existing = this.recordsByPath.get(path);
        this.recordsByPath.delete(path);
        if (!existing) return;
        const paths = this.pathsByOccurrenceKey.get(existing.occurrenceKey);
        paths?.delete(path);
        if (!paths?.size) this.pathsByOccurrenceKey.delete(existing.occurrenceKey);
    }

    private findUniqueByOccurrenceKey(key: string): IndexedCalendarRecord | null {
        const paths = [...(this.pathsByOccurrenceKey.get(key) || [])];
        if (paths.length !== 1) return null;
        return this.recordsByPath.get(paths[0]) || null;
    }

    private trackHandle(handle: NativeRecordHandle): void {
        this.indexFile(handle.file, handle.frontmatter);
    }

    private calendarId(calendar: ExternalCalendarConfig, normalizedUrl: string): string {
        return String(calendar.id || `calendar-${stableHash(normalizedUrl)}`);
    }

    private occurrenceKey(calendarId: string, normalizedUrl: string, event: ExternalCalendarEvent): string {
        return `${calendarId}:${stableHash(normalizedUrl)}:${String(event.occurrenceIdentity || event.id || event.uid)}`;
    }

    private cause(surface: string): Record<string, unknown> {
        return { kind: "automation", sourcePluginId: "tps-controller", surface };
    }
}

function changedProperties(before: Record<string, unknown>, after: Record<string, unknown>): Record<string, unknown> {
    const changed: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(after)) {
        if (JSON.stringify(before[key]) !== JSON.stringify(value)) changed[key] = value;
    }
    return changed;
}

function localDateKey(value: Date): string {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

export function buildNativeCalendarRecordFileName(event: Pick<ExternalCalendarEvent, "startDate" | "title">): string {
    const title = String(event.title || "Untitled event")
        .replace(/[\\/:*?"<>|#^\[\]]+/gu, "-")
        .replace(/\s+/gu, " ")
        .replace(/^[.\s-]+|[.\s-]+$/gu, "")
        .slice(0, 150)
        || "Untitled event";
    return `${localDateKey(event.startDate)} - ${title}`;
}

function markdownLink(path: string, alias: string): string {
    const target = path.replace(/\.md$/iu, "").replace(/\|/gu, "\\|");
    const label = alias.replace(/\|/gu, "\\|").replace(/\]/gu, "\\]");
    return `[[${target}|${label}]]`;
}

function stableHash(value: string): string {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
    return (hash >>> 0).toString(36);
}
