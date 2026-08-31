import { App, TFile } from "obsidian";
import type { ExternalCalendarConfig, ExternalCalendarEvent, TPSControllerSettings } from "../types";
import { getGcmApi } from "../tps-gcm-api";
import type { GcmNativeRecordHandle, GcmNativeRecordSnapshot, GcmNativeRecordsApi } from "../tps-gcm-api";
import { normalizeCalendarUrl } from "../utils";
import {
    calendarEventOccurrenceIdentity,
    calendarRecordSourceScope,
    deriveCalendarRecordId,
    deriveCalendarRecordSourceScope,
    parseCalendarRecordId,
} from "./calendar-record-identity";
import type { ExternalCalendarService } from "./external-calendar-service";
import * as logger from "../logger";

export const TPS_CONTROLLER_NATIVE_CALENDAR_RECORDS_VERSION = 2;

/** Legacy Controller implementation details removed after canonical-ID migration. */
export const REDUNDANT_CALENDAR_RECORD_PROPERTIES = [
    "calendarId",
    "calendarSourceId",
    "calendarUid",
    "calendarOccurrenceId",
    "calendarOccurrenceIdentity",
    "calendarOccurrenceKey",
    "calendarRecurring",
    "calendarSyncState",
    "calendarMissingAt",
    "associatedNotePath",
    "associatedNoteStrategy",
] as const;

const LEGACY_IDENTITY_PROPERTIES = [
    "calendarId",
    "calendarSourceId",
    "calendarUid",
    "calendarOccurrenceId",
    "calendarOccurrenceIdentity",
    "calendarOccurrenceKey",
] as const;

interface IndexedCalendarRecord {
    file: TFile;
    frontmatter: Record<string, unknown>;
    id: string;
    identityTagPrefix?: string;
}

interface CalendarContext {
    calendar: ExternalCalendarConfig;
    configId: string;
    normalizedUrl: string;
    sourceScope: string;
}

interface PlannedCalendarOccurrence {
    context: CalendarContext;
    event: ExternalCalendarEvent;
    id: string;
    plannedCreateProperties?: Record<string, unknown>;
    plannedEventUpdates?: Record<string, unknown>;
    plannedRecordPath?: string;
    plannedSourcePath?: string;
}

interface PreparedCalendarSync {
    occurrences: PlannedCalendarOccurrence[];
    seenIds: Set<string>;
    successfulSourceScopes: Set<string>;
    fetched: number;
    failedFeeds: number;
}

interface PlannedLegacyMigration {
    record: IndexedCalendarRecord;
    targetId: string;
    updates: Record<string, unknown>;
}

type PlannedGcmIdentityEntry = {
    operation: "create";
    nextId: string;
    kind: "calendar-event";
    properties: Record<string, unknown>;
    fileName?: string;
} | {
    operation: "reidentify";
    nextId: string;
    reference: string;
    updates: Record<string, unknown>[];
    fileName?: string;
};

interface PlannedCalendarMutations {
    entries: PlannedGcmIdentityEntry[];
    expectedPathsById: Map<string, string>;
    plannedBatch: {
        token: number;
        revision: number;
        entries: Array<{ operation: "create" | "reidentify"; nextId: string; expectedPath: string | null }>;
    };
    selfLinkUpdatesById: Map<string, Record<string, unknown>>;
    archiveUpdatesById: Map<string, Record<string, unknown>>;
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
    private readonly pathsById = new Map<string, Set<string>>();
    private syncPromise: Promise<NativeCalendarSyncResult> | null = null;

    constructor(
        private readonly app: App,
        private readonly externalCalendarService: ExternalCalendarService,
        private readonly getSettings: () => TPSControllerSettings,
    ) {}

    setup(registerEvent: (event: unknown) => void): void {
        this.rebuild();
        registerEvent(this.app.metadataCache.on("changed", (file, _data, cache) => {
            // A sync rebuilds this index from GCM's authoritative disk snapshot.
            // MetadataCache can deliver an older queued event afterward without
            // advancing GCM's mutation revision. Do not let that stale cache
            // payload replace the snapshot-backed planning state.
            if (!this.syncPromise) this.indexFile(file, cache?.frontmatter);
        }));
        registerEvent(this.app.vault.on("create", (file) => {
            if (!this.syncPromise && file instanceof TFile) this.indexFile(file);
        }));
        registerEvent(this.app.vault.on("delete", (file) => {
            if (!this.syncPromise && file instanceof TFile) this.removePath(file.path);
        }));
        registerEvent(this.app.vault.on("rename", (file, oldPath) => {
            if (this.syncPromise) return;
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
        const clear = () => {
            if (this.syncPromise === run) this.syncPromise = null;
        };
        void run.then(clear, clear);
        return run;
    }

    private async executeSync(
        calendars: ExternalCalendarConfig[],
        filter: string,
        force: boolean,
        backfillPastEvents: boolean,
    ): Promise<NativeCalendarSyncResult> {
        const api = this.requireApi();
        // One sync uses one missing-event policy from plan through execution.
        // A live settings edit must not introduce archive writes that were not
        // included in the token-bound property/identity preflight.
        const missingEventPolicy = this.getSettings().syncOnEventDelete;
        const plannedAtIso = new Date().toISOString();
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
        const contexts = await this.prepareCalendarContexts(calendars);
        const filterTerms = filter.split(",").map((value) => value.trim().toLocaleLowerCase()).filter(Boolean);

        // Fetch and validate the complete occurrence and migration plans before
        // changing any note. A collision or ambiguous legacy owner therefore
        // fails closed with zero vault mutation.
        const prepared = await this.prepareFetchedSync(contexts, filterTerms, rangeStart, rangeEnd, force);
        result.fetched = prepared.fetched;
        result.failedFeeds = prepared.failedFeeds;
        // Refresh authoritative disk state after the potentially slow network
        // fetch and immediately before the complete migration/create plan. A
        // legacy note that arrives through Sync while fetching is therefore
        // migrated instead of duplicated under the canonical ID.
        const authoritativeSnapshot = await api.snapshot!();
        this.rebuildFromHandles(authoritativeSnapshot.records);
        const migrationPlan = await this.prepareLegacyMigration(contexts, authoritativeSnapshot.records);
        const mutationPlan = await this.preflightIdentityPlan(
            api,
            migrationPlan,
            prepared,
            rangeStart,
            rangeEnd,
            missingEventPolicy,
            plannedAtIso,
            authoritativeSnapshot,
        );

        if (mutationPlan.entries.length) {
            const appliedResult = await api.applyIdentityChanges!(
                mutationPlan.plannedBatch,
                mutationPlan.entries,
                this.cause("controller-calendar-sync"),
            );
            if (!appliedResult.ok || appliedResult.handles.length !== mutationPlan.entries.length) {
                const recoverySnapshot = await api.snapshot!();
                this.rebuildFromHandles(recoverySnapshot.records);
                const possiblyPartial = appliedResult.ok
                    || appliedResult.handles.length > 0
                    || appliedResult.failedIndex !== null;
                const failurePoint = appliedResult.failedIndex === null
                    ? "result validation"
                    : `entry ${appliedResult.failedIndex}`;
                const error = new Error(possiblyPartial
                    ? `TPS GCM interrupted the calendar batch at ${failurePoint}; authoritative state was refreshed and the next sync can converge it.`
                    : "TPS GCM rejected the calendar batch before applying it; authoritative state was refreshed.");
                logger.flowError("NativeCalendarRecords", "sync:batch-interrupted", error, {
                    completedEntries: appliedResult.handles.length,
                    failedIndex: appliedResult.failedIndex,
                    gcmError: appliedResult.error || "unknown",
                    retryable: true,
                });
                throw error;
            }
            const applied = appliedResult.handles;
            // Refresh first so even an impossible contract mismatch below does
            // not leave Controller's incremental index pointed at pre-batch
            // paths or identities.
            const appliedSnapshot = await api.snapshot!();
            this.rebuildFromHandles(appliedSnapshot.records);
            for (let index = 0; index < applied.length; index += 1) {
                const handle = applied[index];
                const entry = mutationPlan.entries[index];
                const expectedPath = mutationPlan.expectedPathsById.get(identityKey(entry.nextId));
                if (identityKey(handle.id) !== identityKey(entry.nextId)
                    || !expectedPath
                    || normalizePathForComparison(handle.path) !== normalizePathForComparison(expectedPath)) {
                    throw new Error("TPS GCM returned a calendar batch result that differs from its authoritative plan.");
                }
            }
        }

        const preReconciledIds = new Set<string>();
        result.updated += migrationPlan.length;
        for (const migration of migrationPlan) preReconciledIds.add(identityKey(migration.targetId));
        for (const id of mutationPlan.selfLinkUpdatesById.keys()) {
            if (!preReconciledIds.has(id)) result.updated += 1;
            preReconciledIds.add(id);
        }

        for (const occurrence of prepared.occurrences) {
            const { event, id } = occurrence;
            const existing = this.findUniqueById(id);
            if (!existing) throw new Error(`Calendar record ${id} was absent after TPS GCM applied its validated batch.`);
            if (occurrence.plannedCreateProperties) {
                result.created += 1;
                if (event.isCancelled) result.cancelled += 1;
                continue;
            }
            const changed = normalizePathForComparison(occurrence.plannedSourcePath)
                !== normalizePathForComparison(occurrence.plannedRecordPath)
                || Object.keys(occurrence.plannedEventUpdates || {}).length > 0;
            const idKey = identityKey(id);
            if (changed && !preReconciledIds.has(idKey)) result.updated += 1;
            else if (!changed && !preReconciledIds.has(idKey)) result.unchanged += 1;
            if (event.isCancelled) result.cancelled += 1;
        }

        for (const record of [...this.recordsByPath.values()]) {
            const sourceScope = calendarRecordSourceScope(record.id);
            if (!sourceScope
                || !prepared.successfulSourceScopes.has(sourceScope)
                || prepared.seenIds.has(identityKey(record.id))) continue;
            const start = Date.parse(String(record.frontmatter.scheduled || ""));
            if (!Number.isFinite(start) || start < rangeStart.getTime() || start > rangeEnd.getTime()) continue;
            if (missingEventPolicy === "archive" || missingEventPolicy === "delete") {
                if (!mutationPlan.archiveUpdatesById.has(identityKey(record.id))) {
                    throw new Error(`Calendar archive payload ${record.id} was not included in the validated identity plan.`);
                }
                result.archived += 1;
                continue;
            }
            // `nothing` is a real no-op. In particular, do not replace a user
            // or workflow-owned business status merely because an occurrence
            // disappeared from an otherwise successful feed.
            result.missing += 1;
        }

        logger.flow("NativeCalendarRecords", "sync:done", {
            calendars: contexts.filter((context) => isActiveCalendar(context.calendar)).length,
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

    private async prepareCalendarContexts(calendars: ExternalCalendarConfig[]): Promise<CalendarContext[]> {
        const contexts: CalendarContext[] = [];
        const configIds = new Set<string>();
        const configIdsByScope = new Map<string, string>();
        for (const calendar of calendars) {
            // Settings editors may replace or mutate their live calendar row
            // while network work is pending. Freeze every value used by this
            // sync so exact preflight payloads remain the execution payloads.
            const calendarSnapshot: ExternalCalendarConfig = { ...calendar };
            const configId = String(calendarSnapshot.id || "").trim();
            if (!configId) {
                if (!isActiveCalendar(calendarSnapshot)) continue;
                throw new Error("Every active external calendar requires a stable configuration ID for canonical record identity.");
            }
            if (configIds.has(configId)) throw new Error(`External calendar configuration ID is duplicated: ${configId}`);
            configIds.add(configId);
            const sourceScope = await deriveCalendarRecordSourceScope(configId);
            const priorConfigId = configIdsByScope.get(sourceScope);
            if (priorConfigId && priorConfigId !== configId) {
                throw new Error("Two external calendar configuration IDs produced the same canonical source scope; no records were changed.");
            }
            configIdsByScope.set(sourceScope, configId);
            contexts.push({
                calendar: calendarSnapshot,
                configId,
                normalizedUrl: normalizeCalendarUrl(calendarSnapshot.url),
                sourceScope,
            });
        }
        return contexts;
    }

    private async prepareFetchedSync(
        contexts: CalendarContext[],
        filterTerms: string[],
        rangeStart: Date,
        rangeEnd: Date,
        force: boolean,
    ): Promise<PreparedCalendarSync> {
        const occurrences: PlannedCalendarOccurrence[] = [];
        const seenIds = new Set<string>();
        const successfulSourceScopes = new Set<string>();
        let fetchedCount = 0;
        let failedFeeds = 0;
        for (const context of contexts.filter((candidate) => isActiveCalendar(candidate.calendar))) {
            if (!context.normalizedUrl) {
                failedFeeds += 1;
                continue;
            }
            const fetched = await this.externalCalendarService.fetchEventsWithStatus(
                context.normalizedUrl,
                rangeStart,
                rangeEnd,
                true,
                force,
            );
            if (!fetched.ok) {
                failedFeeds += 1;
                continue;
            }
            successfulSourceScopes.add(context.sourceScope);
            const events = [...fetched.events].sort((left, right) => (
                left.startDate.getTime() - right.startDate.getTime()
                || calendarEventOccurrenceIdentity(left).localeCompare(calendarEventOccurrenceIdentity(right))
            ));
            fetchedCount += events.length;
            for (const fetchedEvent of events) {
                const event: ExternalCalendarEvent = {
                    ...fetchedEvent,
                    startDate: new Date(fetchedEvent.startDate.getTime()),
                    endDate: new Date(fetchedEvent.endDate.getTime()),
                    attendees: fetchedEvent.attendees ? [...fetchedEvent.attendees] : undefined,
                };
                const id = await deriveCalendarRecordId(context.configId, calendarEventOccurrenceIdentity(event));
                const idKey = identityKey(id);
                if (seenIds.has(idKey)) {
                    throw new Error(`Multiple fetched calendar occurrences resolve to canonical ID ${id}; no records were changed.`);
                }
                seenIds.add(idKey);
                // A filtered occurrence is still present in a successful feed.
                if (filterTerms.some((term) => event.title.toLocaleLowerCase().includes(term))) continue;
                occurrences.push({ context, event, id });
            }
        }
        return { occurrences, seenIds, successfulSourceScopes, fetched: fetchedCount, failedFeeds };
    }

    private async prepareLegacyMigration(
        contexts: CalendarContext[],
        authoritativeRecords: GcmNativeRecordHandle[],
    ): Promise<PlannedLegacyMigration[]> {
        this.assertUniqueIndexedIds();
        const contextByConfigId = new Map(contexts.map((context) => [context.configId, context]));
        const plans: PlannedLegacyMigration[] = [];

        for (const record of [...this.recordsByPath.values()].sort((left, right) => left.file.path.localeCompare(right.file.path))) {
            const canonical = parseCalendarRecordId(record.id);
            const legacyManaged = isLegacyManagedRecord(record);
            // Cleanup keys are Controller implementation details only after
            // canonical ownership or positive legacy identity evidence. A
            // manual calendar-event record may legitimately reuse similarly
            // named properties and must remain completely outside migration.
            if (!canonical && !legacyManaged) continue;
            let targetId = record.id;
            if (!canonical) {
                const configId = legacyCalendarConfigId(record.frontmatter);
                if (!configId) {
                    throw new Error(`Legacy calendar record ${record.file.path} has no unambiguous calendar configuration ID; no records were changed.`);
                }
                const context = contextByConfigId.get(configId);
                if (!context) {
                    throw new Error(`Legacy calendar record ${record.file.path} belongs to unknown calendar configuration ${configId}; no records were changed.`);
                }
                const occurrenceIdentity = legacyOccurrenceIdentity(record.frontmatter);
                if (!occurrenceIdentity) {
                    throw new Error(`Legacy calendar record ${record.file.path} has no occurrence identity; no records were changed.`);
                }
                targetId = await deriveCalendarRecordId(context.configId, occurrenceIdentity);
            }
            const updates = this.legacyCleanupUpdates(record);
            if (targetId !== record.id || Object.keys(updates).length) plans.push({ record, targetId, updates });
        }

        // Preflight against every GCM native-record kind, not only calendar
        // records. This mirrors GCM's case-folded global identity namespace and
        // catches duplicate/blocked ownership before the first reidentify call.
        const ownersByTarget = this.allNativeRecordOwners(authoritativeRecords);
        const plannedOwnerByTarget = new Map<string, string>();
        for (const plan of plans) {
            if (plan.targetId === plan.record.id) continue;
            const targetKey = identityKey(plan.targetId);
            const priorPlannedPath = plannedOwnerByTarget.get(targetKey);
            const existingPaths = [...(ownersByTarget.get(targetKey) || [])]
                .filter((path) => path !== plan.record.file.path);
            if ((priorPlannedPath && priorPlannedPath !== plan.record.file.path) || existingPaths.length) {
                throw new Error(`Calendar record identity migration would collide at ${plan.targetId}; no records were changed.`);
            }
            plannedOwnerByTarget.set(targetKey, plan.record.file.path);
        }
        return plans;
    }

    private async preflightIdentityPlan(
        api: GcmNativeRecordsApi,
        migrations: PlannedLegacyMigration[],
        prepared: PreparedCalendarSync,
        rangeStart: Date,
        rangeEnd: Date,
        missingPolicy: TPSControllerSettings["syncOnEventDelete"],
        plannedAtIso: string,
        snapshot: Pick<GcmNativeRecordSnapshot, "token" | "revision">,
    ): Promise<PlannedCalendarMutations> {
        const migrationsByTarget = new Map<string, PlannedLegacyMigration>();
        const migrationsByPath = new Map<string, PlannedLegacyMigration>();
        for (const migration of migrations) {
            migrationsByTarget.set(identityKey(migration.targetId), migration);
            migrationsByPath.set(migration.record.file.path, migration);
        }
        const occurrencesById = new Map(
            prepared.occurrences.map((occurrence) => [identityKey(occurrence.id), occurrence]),
        );
        const records = [...this.recordsByPath.values()]
            .sort((left, right) => left.file.path.localeCompare(right.file.path));

        const buildEntries = (expectedPathsById?: Map<string, string>): {
            entries: PlannedGcmIdentityEntry[];
            selfLinkUpdatesById: Map<string, Record<string, unknown>>;
            archiveUpdatesById: Map<string, Record<string, unknown>>;
        } => {
            const entriesByDestination = new Map<string, PlannedGcmIdentityEntry>();
            const selfLinkUpdatesById = new Map<string, Record<string, unknown>>();
            const archiveUpdatesById = new Map<string, Record<string, unknown>>();
            const projectedByPath = new Map<string, IndexedCalendarRecord>();
            const addEntry = (entry: PlannedGcmIdentityEntry): void => {
                const key = identityKey(entry.nextId);
                const existing = entriesByDestination.get(key);
                if (!existing) {
                    entriesByDestination.set(key, entry);
                    return;
                }
                if (existing.operation === "reidentify"
                    && entry.operation === "reidentify"
                    && identityKey(existing.reference) === identityKey(entry.reference)) {
                    existing.updates.push(...entry.updates);
                    if (entry.fileName) {
                        if (existing.fileName && existing.fileName !== entry.fileName) {
                            throw new Error(`Calendar identity plan contains conflicting filenames for ${entry.nextId}; no records were changed.`);
                        }
                        existing.fileName = entry.fileName;
                    }
                    return;
                }
                throw new Error(`Calendar identity plan contains more than one owner for ${entry.nextId}; no records were changed.`);
            };

            // Migration order is path-sorted by prepareLegacyMigration and is
            // retained as the first part of the one GCM virtual path batch.
            for (const migration of migrations) {
                const updates = Object.keys(migration.updates).length
                    ? [clonePropertyPayload(migration.updates)]
                    : [];
                const occurrence = occurrencesById.get(identityKey(migration.targetId));
                addEntry({
                    operation: "reidentify",
                    reference: migration.record.id,
                    nextId: migration.targetId,
                    updates,
                    ...(occurrence ? { fileName: buildNativeCalendarRecordFileName(occurrence.event) } : {}),
                });
                const projectedFrontmatter = applyCaseInsensitiveUpdates(
                    migration.record.frontmatter,
                    migration.updates,
                );
                if (migration.targetId !== migration.record.id || updates.length) {
                    removeOwnedNativeIdentityTag(
                        projectedFrontmatter,
                        migration.record.id,
                        "calendar-event",
                        migration.record.identityTagPrefix,
                    );
                }
                projectedByPath.set(migration.record.file.path, {
                    file: migration.record.file,
                    id: migration.targetId,
                    frontmatter: projectedFrontmatter,
                    identityTagPrefix: migration.record.identityTagPrefix,
                });
            }

            // Every canonical source participates, including same-ID/no-op
            // records, so GCM validates global ownership and exact source layout
            // for the complete batch. Fetched records get their final title in
            // the event payload after authoritative path preview.
            for (const record of records) {
                const migration = migrationsByPath.get(record.file.path);
                const targetId = migration?.targetId || record.id;
                if (!parseCalendarRecordId(targetId)) continue;
                const occurrence = occurrencesById.get(identityKey(targetId));
                let projected = projectedByPath.get(record.file.path) || {
                    file: record.file,
                    id: targetId,
                    frontmatter: clonePropertyPayload(record.frontmatter),
                    identityTagPrefix: record.identityTagPrefix,
                };
                if (!migration) {
                    addEntry({
                        operation: "reidentify",
                        reference: record.id,
                        nextId: targetId,
                        updates: [],
                        ...(occurrence ? { fileName: buildNativeCalendarRecordFileName(occurrence.event) } : {}),
                    });
                }
                if (!occurrence) {
                    const plannedPath = expectedPathsById?.get(identityKey(targetId)) || projected.file.path;
                    const linkedTitle = markdownLink(plannedPath, calendarRecordDisplayTitle(projected));
                    if (String(projected.frontmatter.title || "") !== linkedTitle) {
                        const updates = { title: linkedTitle };
                        addEntry({
                            operation: "reidentify",
                            reference: record.id,
                            nextId: targetId,
                            updates: [updates],
                        });
                        selfLinkUpdatesById.set(identityKey(targetId), updates);
                        projected = {
                            ...projected,
                            file: projectedCalendarFile(projected.file, plannedPath),
                            frontmatter: applyCaseInsensitiveUpdates(projected.frontmatter, updates),
                        };
                    }
                }
                projectedByPath.set(record.file.path, projected);
            }

            for (const occurrence of prepared.occurrences) {
                const idKey = identityKey(occurrence.id);
                const migration = migrationsByTarget.get(idKey);
                const existing = this.findUniqueById(occurrence.id);
                const source = migration?.record || existing;
                const fileName = buildNativeCalendarRecordFileName(occurrence.event);
                const plannedPath = expectedPathsById?.get(idKey);
                if (source) {
                    const projected = projectedByPath.get(source.file.path);
                    if (!projected) throw new Error(`Calendar record ${source.file.path} was not projected for exact payload planning.`);
                    const recordPath = plannedPath || source.file.path;
                    const atPlannedPath: IndexedCalendarRecord = {
                        ...projected,
                        file: projectedCalendarFile(projected.file, recordPath),
                    };
                    const properties = this.eventProperties(
                        occurrence.context.calendar,
                        occurrence.event,
                        atPlannedPath,
                        recordPath,
                    );
                    const eventUpdates = clonePropertyPayload(changedProperties(projected.frontmatter, properties));
                    occurrence.plannedCreateProperties = undefined;
                    occurrence.plannedEventUpdates = eventUpdates;
                    occurrence.plannedSourcePath = source.file.path;
                    occurrence.plannedRecordPath = recordPath;
                    addEntry({
                        operation: "reidentify",
                        reference: source.id,
                        nextId: migration?.targetId || source.id,
                        updates: Object.keys(eventUpdates).length ? [eventUpdates] : [],
                        fileName,
                    });
                    continue;
                }
                const properties = clonePropertyPayload(this.eventProperties(
                    occurrence.context.calendar,
                    occurrence.event,
                    null,
                    plannedPath,
                ));
                occurrence.plannedCreateProperties = properties;
                occurrence.plannedEventUpdates = undefined;
                occurrence.plannedSourcePath = undefined;
                occurrence.plannedRecordPath = plannedPath;
                addEntry({
                    operation: "create",
                    nextId: occurrence.id,
                    kind: "calendar-event",
                    properties,
                    fileName,
                });
            }

            if (missingPolicy === "archive" || missingPolicy === "delete") {
                for (const record of records) {
                    const migration = migrationsByPath.get(record.file.path);
                    const targetId = migration?.targetId || record.id;
                    const sourceScope = calendarRecordSourceScope(targetId);
                    if (!sourceScope
                        || !prepared.successfulSourceScopes.has(sourceScope)
                        || prepared.seenIds.has(identityKey(targetId))) continue;
                    const start = Date.parse(String(record.frontmatter.scheduled || ""));
                    if (!Number.isFinite(start) || start < rangeStart.getTime() || start > rangeEnd.getTime()) continue;
                    const updates = { archived: true, archivedDate: plannedAtIso };
                    addEntry({
                        operation: "reidentify",
                        reference: record.id,
                        nextId: targetId,
                        updates: [updates],
                    });
                    archiveUpdatesById.set(identityKey(targetId), updates);
                }
            }

            return {
                entries: [...entriesByDestination.values()],
                selfLinkUpdatesById,
                archiveUpdatesById,
            };
        };

        const previewEntries = buildEntries().entries;
        const plannedBatch = await api.planIdentityChanges!(previewEntries, snapshot);
        if (!plannedBatch || plannedBatch.entries.length !== previewEntries.length) {
            throw new Error("TPS GCM rejected the complete calendar identity plan; no records were changed.");
        }
        const expectedPathsById = new Map<string, string>();
        for (let index = 0; index < plannedBatch.entries.length; index += 1) {
            const preview = previewEntries[index];
            const planned = plannedBatch.entries[index];
            if (planned.operation !== preview.operation
                || identityKey(planned.nextId) !== identityKey(preview.nextId)
                || !String(planned.expectedPath || "").trim()) {
                throw new Error("TPS GCM returned an invalid authoritative calendar path plan; no records were changed.");
            }
            expectedPathsById.set(identityKey(preview.nextId), String(planned.expectedPath));
        }
        const exact = buildEntries(expectedPathsById);
        if (exact.entries.length !== plannedBatch.entries.length) {
            throw new Error("Calendar payload planning changed the identity batch shape; no records were changed.");
        }
        for (let index = 0; index < exact.entries.length; index += 1) {
            if (exact.entries[index].operation !== plannedBatch.entries[index].operation
                || identityKey(exact.entries[index].nextId) !== identityKey(plannedBatch.entries[index].nextId)) {
                throw new Error("Calendar payload planning changed the identity batch order; no records were changed.");
            }
        }
        return {
            entries: exact.entries,
            expectedPathsById,
            plannedBatch,
            selfLinkUpdatesById: exact.selfLinkUpdatesById,
            archiveUpdatesById: exact.archiveUpdatesById,
        };
    }

    private allNativeRecordOwners(records: GcmNativeRecordHandle[]): Map<string, Set<string>> {
        const owners = new Map<string, Set<string>>();
        for (const record of records) {
            const id = String(record.id || "").trim();
            if (id) addOwner(owners, identityKey(id), record.path);
        }
        return owners;
    }

    private legacyCleanupUpdates(record: IndexedCalendarRecord): Record<string, unknown> {
        const updates: Record<string, unknown> = {};
        for (const key of REDUNDANT_CALENDAR_RECORD_PROPERTIES) {
            if (hasPropertyCaseInsensitive(record.frontmatter, key)) updates[key] = null;
        }
        const associatedNote = this.existingAssociatedNote(record);
        if (associatedNote) {
            if (String(readPropertyCaseInsensitive(record.frontmatter, "associatedNote") || "") !== associatedNote) {
                updates.associatedNote = associatedNote;
            }
        } else if (hasPropertyCaseInsensitive(record.frontmatter, "associatedNote")) {
            updates.associatedNote = null;
        }
        return updates;
    }

    private existingAssociatedNote(record: IndexedCalendarRecord): string | null {
        const rawLink = String(readPropertyCaseInsensitive(record.frontmatter, "associatedNote") || "").trim();
        const rawPath = String(readPropertyCaseInsensitive(record.frontmatter, "associatedNotePath") || "").trim();
        const linkTarget = wikiLinkTarget(rawLink);
        if (rawLink && linkTarget) {
            const resolved = this.resolveAssociatedNote(linkTarget, record.file.path);
            if (resolved) {
                return normalizePathForComparison(resolved.path) === normalizePathForComparison(record.file.path)
                    ? null
                    : rawLink;
            }
            if (pathsReferToSameMarkdown(linkTarget, record.file.path)) return null;
            // Cache lag, Sync delay, or an ambiguous short link is not proof
            // that a user relationship is dangling. Vault-specific cleanup
            // may remove links only after an explicit backup and inventory.
            return rawLink;
        }
        if (rawPath) {
            if (pathsReferToSameMarkdown(rawPath, record.file.path)) return null;
            const resolved = this.resolveAssociatedNote(rawPath, record.file.path);
            if (resolved && normalizePathForComparison(resolved.path) !== normalizePathForComparison(record.file.path)) {
                return unresolvedMarkdownLink(resolved.path);
            }
            // A missing cache entry or delayed Sync arrival is not proof that a
            // path-only relationship is dangling. Convert it to the surviving
            // public link field before removing Controller's old path field.
            return unresolvedMarkdownLink(rawPath);
        }
        return null;
    }

    private resolveAssociatedNote(target: string, sourcePath: string): TFile | null {
        const cleanTarget = String(target || "").trim().replace(/\\([#^|\]])/gu, "$1").split("#", 1)[0];
        if (!cleanTarget) return null;
        const fromCache = asMarkdownFile((this.app.metadataCache as any).getFirstLinkpathDest?.(cleanTarget, sourcePath));
        if (fromCache) return fromCache;
        const normalized = cleanTarget.toLowerCase().endsWith(".md") ? cleanTarget : `${cleanTarget}.md`;
        const direct = (this.app.vault as any).getAbstractFileByPath?.(normalized)
            || (this.app.vault as any).getFileByPath?.(normalized);
        return asMarkdownFile(direct);
    }

    private eventProperties(
        calendar: ExternalCalendarConfig,
        event: ExternalCalendarEvent,
        existing: IndexedCalendarRecord | null,
        recordPath?: string | null,
    ): Record<string, unknown> {
        const scheduled = event.isAllDay ? localDateKey(event.startDate) : event.startDate.toISOString();
        const end = event.isAllDay ? localDateKey(event.endDate) : event.endDate.toISOString();
        const displayTitle = normalizeCalendarEventTitle(event.title);
        const associatedNote = existing ? this.existingAssociatedNote(existing) : null;
        return {
            title: recordPath ? markdownLink(recordPath, displayTitle) : displayTitle,
            eventTitle: displayTitle,
            ...(event.isCancelled
                ? { status: "cancelled" }
                : existing
                    ? {}
                    : { status: "scheduled" }),
            scheduled,
            end,
            durationMinutes: Math.max(0, Math.round((event.endDate.getTime() - event.startDate.getTime()) / 60_000)),
            allDay: event.isAllDay,
            description: event.description,
            location: event.location || "",
            organizer: event.organizer || "",
            attendees: event.attendees || [],
            url: event.url || "",
            ...(associatedNote ? { associatedNote } : {}),
            tags: mergeCalendarRecordTags(
                readPropertyCaseInsensitive(existing?.frontmatter || {}, "tags"),
                calendar.autoCreateTag,
            ),
        };
    }

    private requireApi(): GcmNativeRecordsApi {
        const api = getGcmApi(this.app)?.nativeRecords;
        if (!api
            || Number(api.version) < 5
            || api.isEnabled?.() !== true
            || typeof api.inspect !== "function"
            || typeof api.snapshot !== "function"
            || typeof api.planIdentityChanges !== "function"
            || typeof api.applyIdentityChanges !== "function") {
            throw new Error("Canonical calendar records require TPS GCM native-record mode and nativeRecords API v5.");
        }
        return api;
    }

    private getApi(): GcmNativeRecordsApi | null {
        return getGcmApi(this.app)?.nativeRecords || null;
    }

    private rebuild(): void {
        this.recordsByPath.clear();
        this.pathsById.clear();
        for (const file of this.app.vault.getMarkdownFiles()) this.indexFile(file);
    }

    private rebuildFromHandles(handles: GcmNativeRecordHandle[]): void {
        this.recordsByPath.clear();
        this.pathsById.clear();
        for (const handle of handles) {
            if (handle.kind === "calendar-event") this.indexFile(handle.file, handle.frontmatter);
        }
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
        if (!id) return;
        this.recordsByPath.set(file.path, {
            file,
            frontmatter: { ...canonical },
            id,
            identityTagPrefix: String(inspected?.profile?.identityTagPrefix || "").trim() || undefined,
        });
        const key = identityKey(id);
        const paths = this.pathsById.get(key) || new Set<string>();
        paths.add(file.path);
        this.pathsById.set(key, paths);
    }

    private removePath(path: string): void {
        const existing = this.recordsByPath.get(path);
        this.recordsByPath.delete(path);
        if (!existing) return;
        const key = identityKey(existing.id);
        const paths = this.pathsById.get(key);
        paths?.delete(path);
        if (!paths?.size) this.pathsById.delete(key);
    }

    private assertUniqueIndexedIds(): void {
        for (const [id, paths] of this.pathsById.entries()) {
            if (paths.size > 1) throw new Error(`Calendar record ID ${id} is owned by multiple notes; no records were changed.`);
        }
    }

    private findUniqueById(id: string): IndexedCalendarRecord | null {
        const paths = [...(this.pathsById.get(identityKey(id)) || [])];
        if (paths.length > 1) throw new Error(`Calendar record ID ${id} is owned by multiple notes.`);
        if (paths.length === 0) return null;
        return this.recordsByPath.get(paths[0]) || null;
    }

    private cause(surface: string): Record<string, unknown> {
        return { kind: "automation", sourcePluginId: "tps-controller", surface };
    }
}

function isActiveCalendar(calendar: ExternalCalendarConfig): boolean {
    return calendar.enabled !== false && calendar.autoCreateEnabled !== false;
}

function identityKey(value: unknown): string {
    return String(value || "").trim().toLocaleLowerCase();
}

function addOwner(owners: Map<string, Set<string>>, id: string, path: string): void {
    const paths = owners.get(id) || new Set<string>();
    paths.add(path);
    owners.set(id, paths);
}

function asMarkdownFile(value: unknown): TFile | null {
    if (value instanceof TFile) return value;
    const candidate = value as { path?: unknown; extension?: unknown } | null | undefined;
    return String(candidate?.path || "").trim() && String(candidate?.extension || "").toLocaleLowerCase() === "md"
        ? value as TFile
        : null;
}

function normalizePathForComparison(value: unknown): string {
    return String(value || "").trim().replace(/\\/gu, "/").replace(/^\/+|\/+$/gu, "").toLocaleLowerCase();
}

function pathsReferToSameMarkdown(left: unknown, right: unknown): boolean {
    const normalize = (value: unknown): string => normalizePathForComparison(value).replace(/\.md$/iu, "");
    const leftPath = normalize(left);
    return Boolean(leftPath) && leftPath === normalize(right);
}

function isLegacyManagedRecord(record: IndexedCalendarRecord): boolean {
    if (parseCalendarRecordId(record.id)) return false;
    return LEGACY_IDENTITY_PROPERTIES.some((key) => hasPropertyCaseInsensitive(record.frontmatter, key));
}

function legacyCalendarConfigId(frontmatter: Record<string, unknown>): string | null {
    const explicit = String(readPropertyCaseInsensitive(frontmatter, "calendarId") || "").trim();
    const occurrenceKey = String(readPropertyCaseInsensitive(frontmatter, "calendarOccurrenceKey") || "").trim();
    const fromKey = occurrenceKey.includes(":") ? occurrenceKey.slice(0, occurrenceKey.indexOf(":")) : "";
    if (explicit && fromKey && explicit !== fromKey) return null;
    return explicit || fromKey || null;
}

function legacyOccurrenceIdentity(frontmatter: Record<string, unknown>): string | null {
    const explicit = String(readPropertyCaseInsensitive(frontmatter, "calendarOccurrenceIdentity") || "").trim();
    if (explicit) return explicit;
    const recurring = readPropertyCaseInsensitive(frontmatter, "calendarRecurring");
    if (recurring !== true && recurring !== false) return null;
    const occurrenceId = String(readPropertyCaseInsensitive(frontmatter, "calendarOccurrenceId") || "").trim();
    const uid = String(readPropertyCaseInsensitive(frontmatter, "calendarUid") || "").trim();
    return recurring ? occurrenceId || uid || null : uid || occurrenceId || null;
}

function hasPropertyCaseInsensitive(frontmatter: Record<string, unknown>, key: string): boolean {
    const normalized = key.toLocaleLowerCase();
    return Object.keys(frontmatter).some((candidate) => candidate.trim().toLocaleLowerCase() === normalized);
}

function readPropertyCaseInsensitive(frontmatter: Record<string, unknown>, key: string): unknown {
    const normalized = key.toLocaleLowerCase();
    const actual = Object.keys(frontmatter).find((candidate) => candidate.trim().toLocaleLowerCase() === normalized);
    return actual ? frontmatter[actual] : undefined;
}

function applyCaseInsensitiveUpdates(
    frontmatter: Record<string, unknown>,
    updates: Record<string, unknown>,
): Record<string, unknown> {
    const projected = { ...frontmatter };
    for (const [key, value] of Object.entries(updates)) {
        const normalized = key.toLocaleLowerCase();
        const matches = Object.keys(projected)
            .filter((candidate) => candidate.trim().toLocaleLowerCase() === normalized);
        for (const match of matches) delete projected[match];
        if (value !== null && value !== undefined) projected[key] = value;
    }
    return projected;
}

function clonePropertyPayload(payload: Record<string, unknown>): Record<string, unknown> {
    const cloneValue = (value: unknown): unknown => {
        if (value instanceof Date) return new Date(value.getTime());
        if (Array.isArray(value)) return value.map(cloneValue);
        if (value && typeof value === "object") {
            return Object.fromEntries(Object.entries(value as Record<string, unknown>)
                .map(([key, entry]) => [key, cloneValue(entry)]));
        }
        return value;
    };
    return Object.fromEntries(Object.entries(payload).map(([key, value]) => [key, cloneValue(value)]));
}

function readCalendarTagValues(value: unknown): string[] {
    if (Array.isArray(value)) return value.flatMap(readCalendarTagValues);
    return String(value ?? "")
        .split(/[\s,]+/gu)
        .map((tag) => tag.trim().replace(/^#+/u, ""))
        .filter(Boolean);
}

function mergeCalendarRecordTags(existing: unknown, configuredTag: unknown): string[] {
    const tags = [
        ...readCalendarTagValues(existing),
        "calendar-event",
        ...readCalendarTagValues(configuredTag),
    ];
    const seen = new Set<string>();
    return tags.filter((tag) => {
        const key = tag.toLocaleLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function removeOwnedNativeIdentityTag(
    frontmatter: Record<string, unknown>,
    id: string,
    kind: string,
    identityTagPrefix?: string,
): void {
    const tagsKey = Object.keys(frontmatter)
        .find((key) => key.trim().toLocaleLowerCase() === "tags");
    if (!tagsKey) return;
    const rawId = String(id || "").trim();
    if (!rawId) return;
    const utf8Hex = [...new TextEncoder().encode(rawId)]
        .map((value) => value.toString(16).padStart(2, "0"))
        .join("");
    const prefix = String(identityTagPrefix || "tps/record").trim().replace(/^#+|\/+$/gu, "");
    if (!prefix) return;
    const rawTag = `${prefix}/v1/${kind}/${rawId}`.toLocaleLowerCase();
    const hexTag = `${prefix}/v1/${kind}/hex-${utf8Hex}`.toLocaleLowerCase();
    const tags = readCalendarTagValues(frontmatter[tagsKey]).filter((tag) => {
        const normalized = tag.toLocaleLowerCase();
        return normalized !== rawTag && normalized !== hexTag;
    });
    if (tags.length) frontmatter[tagsKey] = tags;
    else delete frontmatter[tagsKey];
}

function projectedCalendarFile(file: TFile, path: string): TFile {
    const name = path.split("/").pop() || path;
    return {
        path,
        name,
        basename: name.replace(/\.md$/iu, ""),
        extension: "md",
    } as TFile;
}

function wikiLinkTarget(value: string): string | null {
    if (!value.startsWith("[[") || !value.endsWith("]]")) return null;
    const body = value.slice(2, -2);
    for (let index = 0; index < body.length; index += 1) {
        if (body[index] !== "|") continue;
        let precedingSlashes = 0;
        for (let cursor = index - 1; cursor >= 0 && body[cursor] === "\\"; cursor -= 1) precedingSlashes += 1;
        if (precedingSlashes % 2 === 0) return body.slice(0, index);
    }
    return body;
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
    const title = normalizeCalendarEventTitle(event.title)
        .replace(/[\\/:*?"<>|#^\[\]]+/gu, "-")
        .replace(/\s+/gu, " ")
        .replace(/^[.\s-]+|[.\s-]+$/gu, "")
        .slice(0, 150)
        || "Untitled event";
    return `${localDateKey(event.startDate)} - ${title}`;
}

function markdownLink(path: string, alias: string): string {
    const target = path.replace(/\.md$/iu, "").replace(/([#^|\]])/gu, "\\$1");
    const label = alias.replace(/\|/gu, "\\|").replace(/\]/gu, "\\]");
    return `[[${target}|${label}]]`;
}

function unresolvedMarkdownLink(path: string): string {
    const target = String(path || "").trim().replace(/\.md$/iu, "").replace(/([#^|\]])/gu, "\\$1");
    return target ? `[[${target}]]` : "";
}

function calendarRecordDisplayTitle(record: IndexedCalendarRecord): string {
    const eventTitle = String(record.frontmatter.eventTitle || "").trim();
    if (eventTitle) return normalizeCalendarEventTitle(eventTitle);
    const linkedAlias = markdownLinkAlias(String(record.frontmatter.title || ""));
    if (linkedAlias) return normalizeCalendarEventTitle(linkedAlias);
    return normalizeCalendarEventTitle(record.file.basename.replace(/^\d{4}-\d{2}-\d{2}\s+-\s+/u, ""));
}

function markdownLinkAlias(value: string): string {
    if (!value.startsWith("[[") || !value.endsWith("]]")) return "";
    for (let index = value.length - 3; index >= 2; index -= 1) {
        if (value[index] !== "|") continue;
        let precedingSlashes = 0;
        for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) precedingSlashes += 1;
        if (precedingSlashes % 2 !== 0) continue;
        return value.slice(index + 1, -2).replace(/\\([|\]])/gu, "$1");
    }
    return "";
}

function normalizeCalendarEventTitle(value: unknown): string {
    return String(value || "").replace(/[\r\n]+/gu, " ").replace(/\s+/gu, " ").trim() || "Untitled event";
}
