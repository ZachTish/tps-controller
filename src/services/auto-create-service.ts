import { App, Notice, TFile, normalizePath } from "obsidian";
import * as logger from "../logger";
import { ExternalCalendarEvent } from "../types";
import { ExternalCalendarService } from "./external-calendar-service";
import { createMeetingNoteFromExternalEvent } from "./external-event-modal";
import {
    formatDateTimeForFrontmatter,
    matchesExclusionPattern,
    normalizeCalendarUrl,
    normalizeComparablePath,
    parseFrontmatterDate,
} from "../utils";
import { normalizeTagValue } from "../utils/tag-utils";
import { buildCalendarExternalId, emitFilesUpdated, ensureInternalIdInFrontmatter, getExternalId } from "../tps-gcm-api";
import { cancelOpenInlineTaskLine } from "./external-calendar-cancellation";
import {
    addTagToInlineTaskLine,
    ensureInlineTaskTitle,
    findMarkdownBodyStartLine,
    findMarkdownCheckboxTaskLineIndexes,
    getVisibleInlineTaskText,
    insertTaskLineAfterLeadingTaskBlocks,
    isMarkdownCheckboxTaskLine,
    mutateExternalTaskLineContent,
    patchCanonicalInlineTaskMetadata,
    resolveInlineTaskTemporalValues,
    setInlineTaskFieldValue,
    type ExternalTaskLineMutationOutcome,
    type InlineTaskTemporalValues,
} from "./external-calendar-inline-task";

interface CalendarAutoCreateConfig {
    mode?: "note" | "task";
    taskDestination?: "daily-note" | "event-note";
    taskTargetPath?: string | null;
    typeFolder?: string | null;
    folder?: string | null;
    tag?: string | null;
    template?: string | null;
    autoCreateEnabled?: boolean;
}

export interface AutoCreateServiceConfig {
    startProperty: string;
    endProperty: string;
    useEndDuration: boolean;
    dateFormat?: string;
    noLossSyncMode: boolean;
    syncOnEventDelete: "delete" | "archive" | "nothing";
    archiveFolder: string;
    globalIgnorePaths: string[];
    canceledStatusValue: string | null;
    allowAutoCreate?: boolean;
    eventIdKey: string;
    uidKey: string;
    sourceUrlKey: string;
    titleKey: string;
    statusKey: string;
    previousStatusKey: string;
    orphanCandidateAtKey: string;
    orphanMissCountKey: string;
    orphanReasonKey: string;
    cancelledAtKey: string;
    scanRootFolders: string[];
}

interface VaultNote {
    file: TFile;
    isInlineTask: boolean;
    taskLineIndex?: number;
    taskRawLine?: string;
    externalId: string | null;
    eventId: string | null;
    uid: string;
    eventUrl: string | null;
    storedStart: string;
    storedEnd: string | number;
    storedTitle: string;
    storedLocation: string;
    storedAllDay: boolean | null;
    startDate: Date | null;
    sourceUrl: string | null;
    orphanCandidateAt: string | null;
    isArchived: boolean;
}

export class AutoCreateService {
    app: App;
    config: AutoCreateServiceConfig;
    private isSyncing = false;
    private readonly malformedFrontmatterWarnedPaths = new Set<string>();
    private orphanMissCount = new Map<string, number>();
    private orphanDeletionTombstones = new Map<string, number>();
    private static readonly ORPHAN_GRACE_CYCLES = 2;
    private static readonly ORPHAN_TOMBSTONE_TTL_MS = 6 * 60 * 60 * 1000;

    constructor(app: App) {
        this.app = app;
        this.config = {
            startProperty: "scheduled",
            endProperty: "timeEstimate",
            useEndDuration: true,
            noLossSyncMode: true,
            syncOnEventDelete: "nothing",
            archiveFolder: "",
            globalIgnorePaths: [],
            canceledStatusValue: null,
            allowAutoCreate: false,
            eventIdKey: "externalEventId",
            uidKey: "tpsCalendarUid",
            sourceUrlKey: "tpsCalendarSourceUrl",
            titleKey: "title",
            statusKey: "status",
            previousStatusKey: "tpsCalendarPrevStatus",
            orphanCandidateAtKey: "tpsCalendarOrphanCandidateAt",
            orphanMissCountKey: "tpsCalendarOrphanMissCount",
            orphanReasonKey: "tpsCalendarOrphanReason",
            cancelledAtKey: "tpsCalendarCancelledAt",
            scanRootFolders: [],
        };
    }

    updateConfig(config: Partial<AutoCreateServiceConfig>): void {
        this.config = { ...this.config, ...config };
    }

    async checkAndCreateMeetingNotes(
        externalCalendarService: ExternalCalendarService,
        urls: string[],
        externalCalendarFilter: string,
        calendarConfigs: Record<string, CalendarAutoCreateConfig>,
        forceRegenerate = false,
        options: { backfillPastEvents?: boolean } = {},
    ): Promise<void> {
        if (this.config.allowAutoCreate === false) {
            logger.flow("AutoCreate", "sync:skip-disabled", { urls: urls.length });
            return;
        }
        if (this.isSyncing) {
            logger.flowWarn("AutoCreate", "sync:skip-already-running", { urls: urls.length });
            return;
        }
        if (!Object.values(calendarConfigs).some((config) => (config?.autoCreateEnabled ?? true) !== false)) {
            logger.flowWarn("AutoCreate", "sync:skip-all-calendars-disabled", { configs: Object.keys(calendarConfigs).length });
            if (forceRegenerate) new Notice("Calendar Sync skipped: auto-create is disabled for all configured calendars.");
            return;
        }
        if (!this.getConfiguredScanRoots().length) {
            logger.flowWarn("AutoCreate", "sync:skip-no-scan-roots");
            if (forceRegenerate) new Notice("Calendar Sync skipped: no calendar note folder is configured.");
            return;
        }

        this.isSyncing = true;
        try {
            this.pruneOrphanDeletionTombstones();
            const rangeStart = new Date();
            if (options.backfillPastEvents) {
                rangeStart.setDate(rangeStart.getDate() - 14);
            } else {
                rangeStart.setHours(0, 0, 0, 0);
            }
            const rangeEnd = new Date();
            rangeEnd.setDate(rangeEnd.getDate() + 60);

            const filterTerms = externalCalendarFilter.split(",").map((term) => term.trim().toLowerCase()).filter(Boolean);
            logger.flow("AutoCreate", "sync:start", {
                urls: urls.length,
                configs: Object.keys(calendarConfigs).length,
                scanRoots: this.getConfiguredScanRoots().length,
                filterTerms: filterTerms.length,
                forceRegenerate,
                backfillPastEvents: options.backfillPastEvents === true,
                rangeStart: rangeStart.toISOString(),
                rangeEnd: rangeEnd.toISOString(),
            });
            const fetchResult = await logger.timeAsync("AutoCreate", "fetch-events", { urls: urls.length }, () =>
                this.fetchAllRemoteEvents(externalCalendarService, urls, rangeStart, rangeEnd)
            );
            logger.flow("AutoCreate", "fetch-events:result", {
                events: fetchResult.events.length,
                successfulUrls: fetchResult.successfulUrls.size,
                failedUrls: fetchResult.failedUrls.size,
            });
            const { byEventKey, byLegacyEventId, byUidStart, byTitleDay, byEventUrl, allNotes } = await logger.timeAsync("AutoCreate", "vault-index", {
                scanRoots: this.getConfiguredScanRoots().length,
            }, () => this.buildVaultIndex());
            logger.flow("AutoCreate", "vault-index:result", {
                notes: allNotes.length,
                eventKeys: byEventKey.size,
                legacyEventIds: byLegacyEventId.size,
                uidStartKeys: byUidStart.size,
                titleDayKeys: byTitleDay.size,
                eventUrls: byEventUrl.size,
            });
            const configuredUrlSet = new Set(urls.map((url) => normalizeCalendarUrl(url)).filter(Boolean));

            let created = 0;
            let updated = 0;
            let deleted = 0;
            let quarantined = 0;
            let restored = 0;
            let skippedDuplicate = 0;
            let processed = 0;
            const processedEventKeys = new Set<string>();
            const processedUidStartKeys = new Set<string>();
            const matchedFilePaths = new Set<string>();

            for (const event of this.sortEventsByStart(fetchResult.events)) {
                const eventKey = this.buildEventKeyForEvent(event);
                const uidStartKey = this.buildUidStartKey(event);
                if (processedEventKeys.has(eventKey) || processedUidStartKeys.has(uidStartKey)) {
                    skippedDuplicate++;
                    continue;
                }
                processedEventKeys.add(eventKey);
                processedUidStartKeys.add(uidStartKey);

                try {
                    processed++;
                    const result = await this.processEvent(
                        event,
                        byEventKey,
                        byLegacyEventId,
                        byUidStart,
                        byTitleDay,
                        byEventUrl,
                        calendarConfigs[event.sourceUrl || ""],
                        filterTerms,
                        forceRegenerate,
                    );
                    if (result.action === "created") created++;
                    if (result.action === "updated") updated++;
                    if (result.action === "deleted") deleted++;
                    if (result.file) matchedFilePaths.add(result.file.path);
                } catch (error) {
                    logger.flowError("AutoCreate", "event:failed", error, {
                        title: event.title,
                        sourceUrl: normalizeCalendarUrl(event.sourceUrl || ""),
                        startDate: event.startDate?.toISOString?.() || "",
                    });
                }
            }

            const skipOrphanCleanupBecauseNoRemoteEvents = fetchResult.events.length === 0;
            let orphanSkippedNoRemote = 0;
            let orphanSkippedNoId = 0;
            let orphanSkippedUnsafe = 0;
            let orphanSkippedOutOfRange = 0;
            let orphanGracePending = 0;
            for (const note of allNotes) {
                if (note.isArchived) continue;
                if (matchedFilePaths.has(note.file.path)) {
                    this.orphanMissCount.delete(note.file.path);
                    if (this.config.noLossSyncMode && note.orphanCandidateAt && await this.clearOrphanCandidate(note.file)) restored++;
                    continue;
                }
                if (!note.eventId || skipOrphanCleanupBecauseNoRemoteEvents) {
                    if (!note.eventId) orphanSkippedNoId++;
                    else orphanSkippedNoRemote++;
                    this.orphanMissCount.delete(note.file.path);
                    continue;
                }
                if (!this.canEvaluateOrphanForNote(note, configuredUrlSet, fetchResult.successfulUrls, fetchResult.failedUrls)) {
                    orphanSkippedUnsafe++;
                    this.orphanMissCount.delete(note.file.path);
                    continue;
                }
                const noteDate = note.startDate ?? this.getRecurrenceDateFromId(note.eventId);
                if (!noteDate || noteDate < rangeStart || noteDate > rangeEnd) {
                    orphanSkippedOutOfRange++;
                    continue;
                }

                const missCount = (this.orphanMissCount.get(note.file.path) || 0) + 1;
                this.orphanMissCount.set(note.file.path, missCount);
                if (missCount < AutoCreateService.ORPHAN_GRACE_CYCLES) {
                    orphanGracePending++;
                    continue;
                }

                if (this.config.noLossSyncMode) {
                    if (await this.markOrphanCandidate(note, missCount)) quarantined++;
                } else if (await this.deleteOrArchive(note.file)) {
                    deleted++;
                    this.recordOrphanDeletion(note.eventId);
                }
                this.orphanMissCount.delete(note.file.path);
            }

            const summary = [`${created} created`, `${updated} updated`, `${deleted} archived/deleted`];
            if (quarantined > 0) summary.push(`${quarantined} quarantined`);
            if (restored > 0) summary.push(`${restored} restored`);
            if (created + updated + deleted + quarantined + restored > 0) {
                new Notice(`Calendar Sync: ${summary.join(", ")}`);
            } else if (forceRegenerate) {
                new Notice(`Calendar Sync: ${summary.join(", ")}`);
            }
            logger.flow("AutoCreate", "sync:done", {
                remoteEvents: fetchResult.events.length,
                processed,
                skippedDuplicate,
                created,
                updated,
                deleted,
                quarantined,
                restored,
                matchedFiles: matchedFilePaths.size,
                orphanSkippedNoRemote,
                orphanSkippedNoId,
                orphanSkippedUnsafe,
                orphanSkippedOutOfRange,
                orphanGracePending,
            });
        } catch (error) {
            logger.flowError("AutoCreate", "sync:failed", error, { urls: urls.length });
            if (forceRegenerate) new Notice("Calendar Sync failed. Check the developer console for details.");
        } finally {
            this.isSyncing = false;
        }
    }

    public async getOrphanCandidateFiles(): Promise<TFile[]> {
        const candidates: TFile[] = [];
        for (const file of await this.getScopedMarkdownFiles()) {
            const fm = await this.getFrontmatterForFile(file);
            if (!fm) continue;
            if (this.normalizeIdentityValue(this.findKeyInsensitive(fm, this.config.orphanCandidateAtKey))) {
                candidates.push(file);
            }
        }
        return candidates.sort((a, b) => a.path.localeCompare(b.path));
    }

    private async fetchAllRemoteEvents(
        service: ExternalCalendarService,
        urls: string[],
        start: Date,
        end: Date,
    ): Promise<{ events: ExternalCalendarEvent[]; successfulUrls: Set<string>; failedUrls: Set<string> }> {
        const events: ExternalCalendarEvent[] = [];
        const successfulUrls = new Set<string>();
        const failedUrls = new Set<string>();
        for (const url of urls) {
            const normalizedUrl = normalizeCalendarUrl(url);
            if (!normalizedUrl) {
                failedUrls.add(url);
                continue;
            }
            const result = await service.fetchEventsWithStatus(normalizedUrl, start, end, true, true);
            if (result.ok) {
                successfulUrls.add(normalizedUrl);
                events.push(...result.events);
            } else {
                failedUrls.add(normalizedUrl);
                logger.warn(`[AutoCreateService] Fetch failed for ${normalizedUrl}`, result.error ?? result.statusCode ?? "unknown error");
            }
        }
        return { events, successfulUrls, failedUrls };
    }

    private async buildVaultIndex(): Promise<{
        byEventKey: Map<string, VaultNote>;
        byLegacyEventId: Map<string, VaultNote[]>;
        byUidStart: Map<string, VaultNote>;
        byTitleDay: Map<string, VaultNote>;
        byEventUrl: Map<string, VaultNote>;
        allNotes: VaultNote[];
    }> {
        const byEventKey = new Map<string, VaultNote>();
        const byLegacyEventId = new Map<string, VaultNote[]>();
        const byUidStart = new Map<string, VaultNote>();
        const byTitleDay = new Map<string, VaultNote>();
        const byEventUrl = new Map<string, VaultNote>();
        const allNotes: VaultNote[] = [];

        for (const file of this.app.vault.getMarkdownFiles()) {
            if (normalizePath(file.path).toLowerCase().startsWith(".trash")) continue;
            const normPath = normalizeComparablePath(file.path);
            const normBase = normalizeComparablePath(file.basename);
            const inSyncScope = this.isInConfiguredSyncScope(file);
            const ignoredForSync = (this.config.globalIgnorePaths || []).some((pattern) => matchesExclusionPattern(normPath, normBase, pattern));
            const includeInOrphanSweep = inSyncScope && !ignoredForSync;

            const fm = await this.getFrontmatterForFile(file);
            const inlineNotes = await this.getInlineExternalTaskNotes(file);
            for (const note of inlineNotes) {
                // Inline events share a note with unrelated content. They must never
                // enter note-level orphan cleanup, which can archive/delete the file.
                if (note.externalId) this.setPreferredEventKey(byEventKey, note.externalId, note);
                if (note.eventId) {
                    const scopedEventKey = this.buildEventKey(note.eventId, note.sourceUrl);
                    if (scopedEventKey) this.setPreferredEventKey(byEventKey, scopedEventKey, note);
                    this.addLegacyEventId(byLegacyEventId, note.eventId, note);
                }
                if (note.uid && note.startDate && Number.isFinite(note.startDate.getTime())) {
                    const key = this.buildUidStartKeyFromParts(note.uid, note.startDate, note.sourceUrl);
                    if (!byUidStart.has(key)) byUidStart.set(key, note);
                }
                if (note.storedTitle && note.startDate && Number.isFinite(note.startDate.getTime())) {
                    const key = this.buildTitleDayKey(note.storedTitle.trim().toLowerCase(), note.startDate, note.sourceUrl);
                    if (!byTitleDay.has(key)) byTitleDay.set(key, note);
                }
            }
            if (!fm) continue;
            const eventId = this.normalizeIdentityValue(this.findKeyInsensitive(fm, this.config.eventIdKey));
            const externalId = getExternalId(this.app, fm);
            const uidRaw = this.normalizeIdentityValue(this.findKeyInsensitive(fm, this.config.uidKey));
            const uid = uidRaw || (eventId ? this.extractUid(eventId) || eventId : "");
            const eventUrl = this.normalizeEventUrl(this.findKeyInsensitive(fm, "url"));
            if (!externalId && !uid && !eventId && !eventUrl) continue;

            const storedStartRaw = this.findKeyInsensitive(fm, this.config.startProperty) ?? this.findKeyInsensitive(fm, "scheduled");
            const storedStart = storedStartRaw != null ? String(storedStartRaw).trim() : "";
            const storedEndRaw = this.findKeyInsensitive(fm, this.config.endProperty);
            const storedEnd = storedEndRaw != null ? (typeof storedEndRaw === "number" ? storedEndRaw : String(storedEndRaw).trim()) : "";
            const sourceUrl = this.normalizeSourceUrl(this.findKeyInsensitive(fm, this.config.sourceUrlKey))
                || this.extractSourceUrlFromCalendarExternalId(externalId);
            const startDate = storedStart ? parseFrontmatterDate(storedStart) : null;
            const note: VaultNote = {
                file,
                isInlineTask: false,
                externalId,
                eventId,
                uid,
                eventUrl,
                storedStart,
                storedEnd,
                storedTitle: String(this.findKeyInsensitive(fm, this.config.titleKey) ?? "").trim(),
                storedLocation: String(this.findKeyInsensitive(fm, "location") ?? "").trim(),
                storedAllDay: this.normalizeBooleanValue(this.findKeyInsensitive(fm, "allDay")),
                startDate,
                sourceUrl,
                orphanCandidateAt: this.normalizeIdentityValue(this.findKeyInsensitive(fm, this.config.orphanCandidateAtKey)),
                isArchived: this.isArchivedNote(file),
            };
            if (includeInOrphanSweep) allNotes.push(note);
            if (externalId) this.setPreferredEventKey(byEventKey, externalId, note);
            if (eventId) {
                const scopedEventKey = this.buildEventKey(eventId, sourceUrl);
                if (scopedEventKey) this.setPreferredEventKey(byEventKey, scopedEventKey, note);
                this.addLegacyEventId(byLegacyEventId, eventId, note);
            }
            if (uid && startDate && Number.isFinite(startDate.getTime())) {
                const key = this.buildUidStartKeyFromParts(uid, startDate, sourceUrl);
                if (!byUidStart.has(key)) byUidStart.set(key, note);
            }
            if (note.storedTitle && startDate && Number.isFinite(startDate.getTime())) {
                const key = this.buildTitleDayKey(note.storedTitle.trim().toLowerCase(), startDate, sourceUrl);
                if (!byTitleDay.has(key)) byTitleDay.set(key, note);
            }
            if (eventUrl && !byEventUrl.has(eventUrl)) {
                byEventUrl.set(eventUrl, note);
            }
        }

        return { byEventKey, byLegacyEventId, byUidStart, byTitleDay, byEventUrl, allNotes };
    }

    private async getInlineExternalTaskNotes(file: TFile): Promise<VaultNote[]> {
        const content = await this.app.vault.cachedRead(file);
        const lines = content.split(/\r\n|\n|\r/);
        const bodyStartLine = findMarkdownBodyStartLine(lines);
        if (bodyStartLine < 0) {
            logger.flowWarn("AutoCreate", "inline-task-index:unsafe-frontmatter", {
                path: file.path,
            });
            return [];
        }
        const footnoteMetadata = this.parseInlineMetadataFootnotes(lines);
        const notes: VaultNote[] = [];
        for (const lineIndex of findMarkdownCheckboxTaskLineIndexes(lines)) {
            const line = lines[lineIndex] || "";
            const props = this.parseInlineDataviewProperties(line, footnoteMetadata);
            const externalId = this.normalizeIdentityValue(props.get("externalid"));
            const eventId = this.normalizeIdentityValue(props.get(this.config.eventIdKey.toLowerCase()) || props.get("externaleventid"));
            const uid = this.normalizeIdentityValue(props.get(this.config.uidKey.toLowerCase()) || props.get("tpscalendaruid"))
                || (eventId ? this.extractUid(eventId) || eventId : "");
            const sourceUrl = this.normalizeSourceUrl(props.get(this.config.sourceUrlKey.toLowerCase()) || props.get("tpscalendarsourceurl"));
            if (!externalId && !eventId && !uid) continue;
            const storedStart = String(props.get(this.config.startProperty.toLowerCase()) || props.get("scheduled") || "").trim();
            const storedEndRaw = props.get(this.config.endProperty.toLowerCase()) || props.get("timeestimate") || "";
            const startDate = storedStart ? parseFrontmatterDate(storedStart) : null;
            notes.push({
                file,
                isInlineTask: true,
                taskLineIndex: lineIndex,
                taskRawLine: line,
                externalId,
                eventId,
                uid: uid || "",
                eventUrl: this.normalizeEventUrl(props.get("url")),
                storedStart,
                storedEnd: storedEndRaw && !Number.isNaN(Number(storedEndRaw)) ? Number(storedEndRaw) : storedEndRaw,
                storedTitle: this.cleanInlineTaskTitle(line),
                storedLocation: String(props.get("location") || "").trim(),
                storedAllDay: this.normalizeBooleanValue(props.get("allday")),
                startDate,
                sourceUrl,
                orphanCandidateAt: null,
                isArchived: this.isArchivedNote(file),
            });
        }
        return notes;
    }

    private parseInlineDataviewProperties(line: string, footnoteMetadata?: Map<string, string>): Map<string, string> {
        const props = new Map<string, string>();
        const regex = /\[([^\[\]:]+)::\s*([^\]]+)\]/g;
        let match: RegExpExecArray | null;
        const visibleLine = getVisibleInlineTaskText(line);
        while ((match = regex.exec(visibleLine)) !== null) {
            props.set(match[1].trim().toLowerCase(), match[2].trim());
        }
        this.mergeEncodedInlineMetadata(props, props.get("tpsinlineprops") || props.get("tps-inline-props") || "");
        props.delete("tpsinlineprops");
        props.delete("tps-inline-props");
        const hiddenRegex = /(?:<span\b[^>]*data-tps-inline-props="([^"]*)"[^>]*>\s*<\/span>|<!--\s*tps-inline-props:([\s\S]*?)\s*-->|\s*%%\s*tps-inline-props:([\s\S]*?)\s*%%)/g;
        let hiddenMatch: RegExpExecArray | null;
        while ((hiddenMatch = hiddenRegex.exec(line)) !== null) {
            this.mergeEncodedInlineMetadata(props, hiddenMatch[1] || hiddenMatch[2] || hiddenMatch[3] || "", !hiddenMatch[1]);
        }
        const refMatch = line.match(/\[\^tps-inline:([^\]]+)]/);
        const encoded = refMatch ? footnoteMetadata?.get(refMatch[1]) : "";
        if (encoded) {
            this.mergeEncodedInlineMetadata(props, encoded);
        }
        return props;
    }

    private mergeEncodedInlineMetadata(props: Map<string, string>, raw: string, alreadyJson = false): void {
        if (!raw) return;
        try {
            const parsed = JSON.parse(alreadyJson ? raw : decodeURIComponent(raw));
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
            for (const [key, value] of Object.entries(parsed)) {
                props.set(String(key).trim().toLowerCase(), String(value ?? "").trim());
            }
        } catch {
            // Ignore malformed hidden metadata.
        }
    }

    private parseInlineMetadataFootnotes(lines: string[]): Map<string, string> {
        const metadata = new Map<string, string>();
        for (const line of lines) {
            const match = line.match(/^\[\^tps-inline:([^\]]+)]:\s*(\S+)\s*$/);
            if (match) metadata.set(match[1], match[2]);
        }
        return metadata;
    }

    private cleanInlineTaskTitle(line: string): string {
        return line
            .replace(/^\s*(?:[-*+]|\d+[.)])\s+\[[^\]\r\n]?\]\s+/, "")
            .replace(/(?:<span\b[^>]*data-tps-inline-props="[^"]*"[^>]*>\s*<\/span>|<!--\s*tps-inline-props:[\s\S]*?\s*-->|\s*%%\s*tps-inline-props:[\s\S]*?\s*%%)/g, "")
            .replace(/\[\^tps-inline:[^\]]+]/g, "")
            .replace(/\[[^\[\]:]+::\s*[^\]]+\]/g, "")
            .replace(/#[A-Za-z0-9_/-]+/g, "")
            .replace(/\s+/g, " ")
            .trim();
    }

    private async processEvent(
        event: ExternalCalendarEvent,
        byEventKey: Map<string, VaultNote>,
        byLegacyEventId: Map<string, VaultNote[]>,
        byUidStart: Map<string, VaultNote>,
        byTitleDay: Map<string, VaultNote>,
        byEventUrl: Map<string, VaultNote>,
        calendarInfo: CalendarAutoCreateConfig | null,
        filterTerms: string[],
        forceRegenerate: boolean,
    ): Promise<{ action: "created" | "updated" | "deleted" | "none"; file?: TFile }> {
        const eventKey = this.buildEventKeyForEvent(event);
        const normalizedSourceUrl = this.normalizeSourceUrl(event.sourceUrl);
        const normalizedEventUrl = this.normalizeEventUrl(event.url);
        const vaultMatch = this.findVaultNoteForEvent(event, byEventKey, byLegacyEventId, byUidStart, byTitleDay, byEventUrl);
        const match = vaultMatch.note;

        if (match) {
            if (match.isArchived) return { action: "none", file: match.file };
            if (event.isCancelled) {
                const action = match.isInlineTask
                    ? (await this.markInlineTaskCancelled(match, event) ? "updated" : "none")
                    : await this.handleCancelledMatch(match.file);
                logger.flow("AutoCreate", "event:cancelled", {
                    action,
                    route: match.isInlineTask ? "inline-task" : "note",
                    path: match.file.path,
                });
                return { action, file: match.file };
            }

            const inlineTemporal = this.getInlineTaskTemporalValues(event);
            const expectedStart = match.isInlineTask
                ? inlineTemporal.start
                : formatDateTimeForFrontmatter(event.startDate);
            const expectedEnd = match.isInlineTask
                ? inlineTemporal.end
                : this.config.useEndDuration
                    ? Math.round((event.endDate.getTime() - event.startDate.getTime()) / 60000)
                    : formatDateTimeForFrontmatter(event.endDate);
            const startChanged = match.storedStart !== expectedStart;
            const endChanged = match.storedEnd !== expectedEnd;
            const titleMissing = !match.storedTitle && !!event.title;
            const locationMissing = !match.storedLocation && !!event.location;
            const sourceChanged = !!normalizedSourceUrl && match.sourceUrl !== normalizedSourceUrl;
            const urlChanged = !!normalizedEventUrl && match.eventUrl !== normalizedEventUrl;
            const allDayChanged = match.storedAllDay === null ? event.isAllDay : match.storedAllDay !== event.isAllDay;

            if (!startChanged && !endChanged && !titleMissing && !locationMissing && !sourceChanged && !urlChanged && !allDayChanged && !vaultMatch.repairedEventId && !forceRegenerate) {
                return { action: "none", file: match.file };
            }

            if (match.isInlineTask) {
                const didUpdate = await this.updateExistingInlineTask(match, event, {
                    expectedStart,
                    expectedEnd,
                    startChanged,
                    endChanged,
                    titleMissing,
                    locationMissing,
                    sourceChanged,
                    urlChanged,
                    allDayChanged,
                    repairedEventId: vaultMatch.repairedEventId,
                });
                if (didUpdate) this.orphanDeletionTombstones.delete(event.id);
                return { action: didUpdate ? "updated" : "none", file: match.file };
            }

            let didUpdate = false;
            await this.processFrontmatterSafely(match.file, "update-existing-event", (fm) => {
                const expectedExternalId = buildCalendarExternalId(this.app, event);
                if (expectedExternalId && getExternalId(this.app, fm) !== expectedExternalId) {
                    ensureInternalIdInFrontmatter(this.app, fm);
                    fm.externalId = expectedExternalId;
                    this.deleteLegacyCalendarIdentityFields(fm);
                    didUpdate = true;
                }
                if (vaultMatch.repairedEventId) {
                    ensureInternalIdInFrontmatter(this.app, fm);
                    fm.externalId = expectedExternalId;
                    this.deleteLegacyCalendarIdentityFields(fm);
                    didUpdate = true;
                }
                if (titleMissing) {
                    fm[this.config.titleKey] = event.title;
                    didUpdate = true;
                }
                if (locationMissing) {
                    fm.location = event.location;
                    didUpdate = true;
                }
                if (sourceChanged && normalizedSourceUrl) {
                    ensureInternalIdInFrontmatter(this.app, fm);
                    fm.externalId = expectedExternalId;
                    this.deleteLegacyCalendarIdentityFields(fm);
                    didUpdate = true;
                }
                if (urlChanged && normalizedEventUrl) {
                    fm.url = normalizedEventUrl;
                    didUpdate = true;
                }
                if (allDayChanged) {
                    if (event.isAllDay) {
                        const allDayKey = Object.keys(fm).find((key) => key.trim().toLowerCase() === "allday") || "allDay";
                        fm[allDayKey] = true;
                    } else {
                        this.deleteFrontmatterKeyIfPresent(fm, "allDay");
                    }
                    didUpdate = true;
                }
                if (startChanged) {
                    fm[this.config.startProperty] = expectedStart;
                    didUpdate = true;
                }
                if (endChanged) {
                    fm[this.config.endProperty] = expectedEnd;
                    didUpdate = true;
                }
            });
            if (didUpdate && vaultMatch.repairedEventId) {
                match.externalId = buildCalendarExternalId(this.app, event);
                byEventKey.set(match.externalId, match);
            }
            if (didUpdate) this.orphanDeletionTombstones.delete(event.id);
            return { action: didUpdate ? "updated" : "none", file: match.file };
        }

        if (event.isCancelled) return { action: "none" };
        if (filterTerms.some((term) => event.title.toLowerCase().includes(term))) return { action: "none" };
        if (calendarInfo?.autoCreateEnabled === false) return { action: "none" };
        if (!forceRegenerate && this.hasRecentOrphanDeletion(event.id)) return { action: "none" };
        const archivedMatch = byEventKey.get(eventKey) || this.findLegacyEventMatch(event, byLegacyEventId, true);
        if (archivedMatch?.isArchived) return { action: "none" };

        const resolvedFolder = calendarInfo?.typeFolder || calendarInfo?.folder || "";
        if (normalizePath(resolvedFolder).split("/").filter(Boolean).some((segment) => segment.startsWith("_"))) {
            logger.warn(`[AutoCreateService] Refusing to create in protected path "${resolvedFolder || "(vault root)"}" for: ${event.title}`);
            return { action: "none" };
        }

        if (calendarInfo?.mode === "task") {
            const result = await this.createTaskInTaskNote(event, calendarInfo);
            return result || { action: "none" };
        }

        const file = await createMeetingNoteFromExternalEvent(
            this.app,
            event,
            calendarInfo?.template || null,
            resolvedFolder,
            this.config.startProperty,
            this.config.endProperty,
            this.config.useEndDuration,
            calendarInfo?.tag || null,
            undefined,
            undefined,
            undefined,
            {
                eventIdKey: this.config.eventIdKey,
                uidKey: this.config.uidKey,
                sourceUrlKey: this.config.sourceUrlKey,
                titleKey: this.config.titleKey,
                statusKey: this.config.statusKey,
            },
        );
        return file ? { action: "created", file } : { action: "none" };
    }

    private async updateExistingInlineTask(
        match: VaultNote,
        event: ExternalCalendarEvent,
        changes: {
            expectedStart: string;
            expectedEnd: string | number;
            startChanged: boolean;
            endChanged: boolean;
            titleMissing: boolean;
            locationMissing: boolean;
            sourceChanged: boolean;
            urlChanged: boolean;
            allDayChanged: boolean;
            repairedEventId: boolean;
        },
    ): Promise<boolean> {
        const expectedExternalId = buildCalendarExternalId(this.app, event);
        const expectedSourceUrl = this.normalizeSourceUrl(event.sourceUrl);
        const expectedEventUrl = this.normalizeEventUrl(event.url);
        const expectedUid = event.uid || this.extractUid(event.id) || "";
        const metadataUpdates: Record<string, unknown | null> = {};

        if (changes.repairedEventId || changes.sourceChanged || match.externalId !== expectedExternalId) {
            metadataUpdates.externalId = expectedExternalId;
            metadataUpdates[this.config.eventIdKey] = event.id;
            metadataUpdates[this.config.uidKey] = expectedUid;
            metadataUpdates[this.config.sourceUrlKey] = expectedSourceUrl || "";
        }
        if (changes.locationMissing && event.location) metadataUpdates.location = event.location;
        if (changes.urlChanged) metadataUpdates.url = expectedEventUrl || null;
        if (changes.allDayChanged) metadataUpdates.allDay = event.isAllDay ? true : null;

        const mutationState: { outcome: ExternalTaskLineMutationOutcome; lineIndex: number } = {
            outcome: "not-found",
            lineIndex: -1,
        };
        let metadataPatchUnavailable = false;
        try {
            await this.app.vault.process(match.file, (content) => {
                const lines = content.split(/\r\n|\n|\r/);
                const footnoteMetadata = this.parseInlineMetadataFootnotes(lines);
                const candidateExternalIds = new Set(
                    [match.externalId, expectedExternalId]
                        .map((value) => this.normalizeIdentityValue(value))
                        .filter(Boolean),
                );
                const mutation = mutateExternalTaskLineContent(
                    content,
                    (line, currentLineIndex) => {
                        if (
                            typeof match.taskLineIndex === "number"
                            && currentLineIndex === match.taskLineIndex
                            && line === match.taskRawLine
                        ) {
                            return true;
                        }
                        const props = this.parseInlineDataviewProperties(line, footnoteMetadata);
                        const lineExternalId = this.normalizeIdentityValue(props.get("externalid"));
                        if (lineExternalId && candidateExternalIds.has(lineExternalId)) return true;
                        const lineEventId = this.normalizeIdentityValue(
                            props.get(this.config.eventIdKey.toLowerCase()) || props.get("externaleventid"),
                        );
                        if (!lineEventId || lineEventId !== event.id) return false;
                        const lineSourceUrl = this.normalizeSourceUrl(
                            props.get(this.config.sourceUrlKey.toLowerCase()) || props.get("tpscalendarsourceurl"),
                        );
                        return !expectedSourceUrl || lineSourceUrl === expectedSourceUrl;
                    },
                    (line) => {
                        let nextLine = line;
                        if (Object.keys(metadataUpdates).length > 0) {
                            const metadataPatch = patchCanonicalInlineTaskMetadata(nextLine, metadataUpdates);
                            if (!metadataPatch.patched) {
                                metadataPatchUnavailable = true;
                                return line;
                            }
                            nextLine = metadataPatch.line;
                        }
                        if (changes.titleMissing) nextLine = ensureInlineTaskTitle(nextLine, event.title);
                        if (changes.startChanged) {
                            nextLine = setInlineTaskFieldValue(nextLine, this.config.startProperty, changes.expectedStart);
                        }
                        if (changes.endChanged) {
                            nextLine = setInlineTaskFieldValue(nextLine, this.config.endProperty, changes.expectedEnd);
                        }
                        return nextLine;
                    },
                );
                mutationState.outcome = mutation.outcome;
                mutationState.lineIndex = mutation.lineIndex;
                return mutation.content;
            });
        } catch (error) {
            logger.flowError("AutoCreate", "inline-task-update:failed", error, {
                path: match.file.path,
                expectedLine: (match.taskLineIndex ?? -1) + 1,
            });
            return false;
        }

        if (metadataPatchUnavailable) {
            logger.flowWarn("AutoCreate", "inline-task-update:metadata-format-unsupported", {
                path: match.file.path,
                line: mutationState.lineIndex + 1,
                keys: Object.keys(metadataUpdates).sort(),
            });
        }
        if (
            mutationState.outcome === "not-found"
            || mutationState.outcome === "ambiguous"
            || mutationState.outcome === "invalid-result"
            || mutationState.outcome === "unsafe-frontmatter"
        ) {
            logger.flowWarn("AutoCreate", "inline-task-update:skipped", {
                path: match.file.path,
                outcome: mutationState.outcome,
                expectedLine: (match.taskLineIndex ?? -1) + 1,
            });
            return false;
        }
        if (mutationState.outcome !== "changed") return false;

        emitFilesUpdated(this.app, [match.file.path], "tps-controller");
        logger.flow("AutoCreate", "inline-task-update:done", {
            path: match.file.path,
            line: mutationState.lineIndex + 1,
            startChanged: changes.startChanged,
            endChanged: changes.endChanged,
            metadataKeys: Object.keys(metadataUpdates).sort(),
        });
        return true;
    }

    private async createTaskInTaskNote(
        event: ExternalCalendarEvent,
        calendarInfo: CalendarAutoCreateConfig | null,
    ): Promise<{ action: "created" | "updated" | "none"; file: TFile } | null> {
        const file = calendarInfo?.taskTargetPath
            ? await this.ensureTaskTargetFile(calendarInfo.taskTargetPath)
            : await this.ensureDailyNoteFile(event.startDate);
        const externalId = buildCalendarExternalId(this.app, event);
        const taskLine = this.buildExternalEventTaskLine(event, calendarInfo, externalId);
        const tag = normalizeTagValue(calendarInfo?.tag || "");
        const state: {
            action: "created" | "updated" | "none";
            outcome: ExternalTaskLineMutationOutcome | "inserted";
            lineIndex: number;
        } = {
            action: "none",
            outcome: "not-found",
            lineIndex: -1,
        };

        try {
            await this.app.vault.process(file, (content) => {
                const lines = content.split(/\r\n|\n|\r/);
                const footnoteMetadata = this.parseInlineMetadataFootnotes(lines);
                const existingTask = mutateExternalTaskLineContent(
                    content,
                    (line) => {
                        const props = this.parseInlineDataviewProperties(line, footnoteMetadata);
                        return this.normalizeIdentityValue(props.get("externalid")) === externalId;
                    },
                    (line) => tag ? addTagToInlineTaskLine(line, tag) : line,
                );
                state.outcome = existingTask.outcome;
                state.lineIndex = existingTask.lineIndex;
                if (existingTask.outcome === "changed") {
                    state.action = "updated";
                    return existingTask.content;
                }
                if (existingTask.outcome === "unchanged") {
                    state.action = "none";
                    return content;
                }
                if (existingTask.outcome !== "not-found") {
                    return content;
                }

                const insertion = this.insertExternalCalendarTaskLine(content, taskLine);
                if (insertion.unsafeFrontmatter) {
                    state.outcome = "unsafe-frontmatter";
                    return content;
                }
                state.action = insertion.inserted ? "created" : "none";
                state.outcome = insertion.inserted ? "inserted" : "unchanged";
                state.lineIndex = insertion.lineIndex;
                return insertion.content;
            });
        } catch (error) {
            logger.flowError("AutoCreate", "calendar-task-upsert:failed", error, {
                path: file.path,
            });
            return null;
        }

        if (state.action === "created" || state.action === "updated") {
            emitFilesUpdated(this.app, [file.path], "tps-controller");
            logger.flow("AutoCreate", "calendar-task-upsert:done", {
                action: state.action,
                path: file.path,
                line: state.lineIndex + 1,
            });
        } else if (
            state.outcome === "ambiguous"
            || state.outcome === "invalid-result"
            || state.outcome === "unsafe-frontmatter"
        ) {
            logger.flowWarn("AutoCreate", "calendar-task-upsert:skipped", {
                path: file.path,
                outcome: state.outcome,
            });
        }
        return { action: state.action, file };
    }

    private async ensureTaskTargetFile(rawPath: string): Promise<TFile> {
        const path = this.normalizeTaskTargetPath(rawPath);
        const existing = this.app.vault.getAbstractFileByPath(path);
        if (existing instanceof TFile) {
            await this.cleanTaskTargetFrontmatter(existing);
            return existing;
        }
        const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
        if (folder) await this.ensureFolder(folder);
        return await this.app.vault.create(path, "---\n---\n\n");
    }

    private async cleanTaskTargetFrontmatter(file: TFile): Promise<void> {
        await this.app.fileManager.processFrontMatter(file, (fm) => {
            if (typeof fm.title !== "string" || !fm.title.trim()) {
                fm.title = file.basename.replace(/^\d{4}-\d{2}-\d{2}\s+/, "").trim() || file.basename;
            }
            for (const key of [
                this.config.startProperty,
                this.config.endProperty,
                "scheduled",
                "timeEstimate",
                "allDay",
                "externalId",
                this.config.eventIdKey,
                this.config.uidKey,
                this.config.sourceUrlKey,
                "location",
                "url",
            ]) {
                if (key && Object.prototype.hasOwnProperty.call(fm, key)) delete fm[key];
            }
        });
    }

    private normalizeTaskTargetPath(rawPath: string): string {
        const value = normalizePath(String(rawPath || "").trim()
            .replace(/^\[\[|\]\]$/g, "")
            .replace(/^"+|"+$/g, "")
            .replace(/^\/+/, ""));
        return value.toLowerCase().endsWith(".md") ? value : `${value}.md`;
    }

    private sortEventsByStart(events: ExternalCalendarEvent[]): ExternalCalendarEvent[] {
        return [...events].sort((left, right) => {
            const startDelta = left.startDate.getTime() - right.startDate.getTime();
            if (startDelta !== 0) return startDelta;
            return (left.title || "").localeCompare(right.title || "", undefined, { sensitivity: "base" });
        });
    }

    private insertExternalCalendarTaskLine(
        content: string,
        taskLine: string,
    ): { content: string; lineIndex: number; inserted: boolean; unsafeFrontmatter: boolean } {
        const lines = content.split(/\r\n|\n|\r/);
        const footnoteMetadata = this.parseInlineMetadataFootnotes(lines);
        return insertTaskLineAfterLeadingTaskBlocks(
            content,
            taskLine,
            (line) => this.isExternalCalendarTaskLine(line, footnoteMetadata),
        );
    }

    private isExternalCalendarTaskLine(line: string, footnoteMetadata?: Map<string, string>): boolean {
        if (!isMarkdownCheckboxTaskLine(line)) return false;
        const props = this.parseInlineDataviewProperties(line, footnoteMetadata);
        return !!(
            this.normalizeIdentityValue(props.get("externalid"))
            || this.normalizeIdentityValue(props.get(this.config.eventIdKey.toLowerCase()) || props.get("externaleventid"))
            || this.normalizeIdentityValue(props.get(this.config.uidKey.toLowerCase()) || props.get("tpscalendaruid"))
        );
    }

    private buildExternalEventTaskLine(
        event: ExternalCalendarEvent,
        calendarInfo: CalendarAutoCreateConfig | null,
        externalId: string,
    ): string {
        const temporal = this.getInlineTaskTemporalValues(event);
        const parts = [
            `- [ ] ${event.title || "External calendar event"}`,
            `[${this.config.startProperty}:: ${temporal.start}]`,
        ];
        if (temporal.end !== "") {
            parts.push(`[${this.config.endProperty}:: ${temporal.end}]`);
        }
        const hiddenProps: Record<string, unknown> = {
            externalId,
            [this.config.eventIdKey]: event.id,
            [this.config.uidKey]: event.uid || this.extractUid(event.id) || "",
            [this.config.sourceUrlKey]: event.sourceUrl || "",
        };
        const tag = normalizeTagValue(calendarInfo?.tag || "");
        if (tag) parts.push(`#${tag}`);
        if (event.location) hiddenProps.location = event.location;
        if (event.url) hiddenProps.url = event.url;
        if (event.isAllDay) hiddenProps.allDay = true;
        return `${parts.join(" ")} %% tps-inline-props:${JSON.stringify(hiddenProps)} %%`;
    }

    private formatAllDayDate(date: Date): string {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, "0");
        const day = String(date.getDate()).padStart(2, "0");
        return `${year}-${month}-${day}`;
    }

    private getInlineTaskTemporalValues(event: ExternalCalendarEvent): InlineTaskTemporalValues {
        return resolveInlineTaskTemporalValues({
            isAllDay: event.isAllDay,
            useEndDuration: this.config.useEndDuration,
            allDayStart: this.formatAllDayDate(event.startDate),
            timedStart: formatDateTimeForFrontmatter(event.startDate),
            timedEnd: formatDateTimeForFrontmatter(event.endDate),
            durationMinutes: (event.endDate.getTime() - event.startDate.getTime()) / 60000,
        });
    }

    private async ensureDailyNoteFile(date: Date): Promise<TFile> {
        const dailyNoteTarget = await this.getDailyNoteTarget(date);
        const path = dailyNoteTarget.path;
        const folder = dailyNoteTarget.folder;
        const existing = this.app.vault.getAbstractFileByPath(path);
        if (existing instanceof TFile) return existing;
        if (folder) await this.ensureFolder(folder);
        return await this.app.vault.create(path, `---\nscheduled: ${formatDateTimeForFrontmatter(new Date(date.getFullYear(), date.getMonth(), date.getDate()))}\ntags:\n  - context/scheduled\n---\n\n`);
    }

    private async getDailyNoteTarget(date: Date): Promise<{ path: string; folder: string }> {
        const { format, folder } = await this.getDailyNoteSettings();
        const moment = (window as any).moment;
        const basename = typeof moment === "function"
            ? moment(date).format(format)
            : `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
        return {
            folder,
            path: normalizePath(folder ? `${folder}/${basename}.md` : `${basename}.md`),
        };
    }

    private async getDailyNoteSettings(): Promise<{ format: string; folder: string }> {
        let format = "YYYY-MM-DD";
        let folder = "";

        try {
            const dailyNotesPlugin = (this.app as any).internalPlugins?.getPluginById?.("daily-notes")
                || (this.app as any).internalPlugins?.plugins?.["daily-notes"];
            const options = dailyNotesPlugin?.instance?.options;
            if (typeof options?.format === "string" && options.format.trim()) format = options.format.trim();
            if (typeof options?.folder === "string" && options.folder.trim()) folder = normalizePath(options.folder.trim()).replace(/^\/+|\/+$/g, "");
        } catch {
            // Fall through to persisted config/defaults.
        }

        try {
            const configDir = (this.app.vault as any)?.configDir || ".obsidian";
            const raw = await this.app.vault.adapter.read(normalizePath(`${configDir}/daily-notes.json`));
            const parsed = JSON.parse(raw);
            if (format === "YYYY-MM-DD" && typeof parsed?.format === "string" && parsed.format.trim()) {
                format = parsed.format.trim();
            }
            if (!folder && typeof parsed?.folder === "string" && parsed.folder.trim()) {
                folder = normalizePath(parsed.folder.trim()).replace(/^\/+|\/+$/g, "");
            }
        } catch {
            // Daily Notes may not have a persisted config yet.
        }

        return { format, folder };
    }

    private getConfiguredScanRoots(): string[] {
        const roots = new Set<string>();
        for (const rawRoot of this.config.scanRootFolders || []) {
            if (typeof rawRoot !== "string") continue;
            if (!rawRoot.trim()) {
                roots.add("");
                continue;
            }
            const normalized = normalizePath(rawRoot).replace(/^\/+|\/+$/g, "").trim();
            if (!normalized || normalized === "." || normalized === "/") {
                roots.add("");
                continue;
            }
            roots.add(normalized);
        }
        return Array.from(roots);
    }

    private async getScopedMarkdownFiles(): Promise<TFile[]> {
        const roots = this.getConfiguredScanRoots();
        if (!roots.length) return [];
        if (roots.includes("")) return this.app.vault.getMarkdownFiles();

        const filesByPath = new Map<string, TFile>();
        for (const root of roots) {
            for (const file of this.app.vault.getMarkdownFiles()) {
                const normalizedPath = normalizePath(file.path);
                if (normalizedPath === root || normalizedPath.startsWith(`${root}/`)) {
                    filesByPath.set(file.path, file);
                }
            }
        }
        return Array.from(filesByPath.values());
    }

    private async getVaultIndexMarkdownFiles(): Promise<TFile[]> {
        const roots = this.getConfiguredScanRoots();
        if (!roots.length) return this.app.vault.getMarkdownFiles();
        return this.getScopedMarkdownFiles();
    }

    private isInConfiguredSyncScope(file: TFile): boolean {
        const roots = this.getConfiguredScanRoots();
        if (!roots.length || roots.includes("")) return true;
        const normalizedPath = normalizePath(file.path);
        return roots.some((root) => normalizedPath === root || normalizedPath.startsWith(`${root}/`));
    }

    private async handleCancelledMatch(file: TFile): Promise<"deleted" | "updated" | "none"> {
        if (!this.config.noLossSyncMode) return (await this.deleteOrArchive(file)) ? "deleted" : "none";
        if (this.config.syncOnEventDelete === "archive" || this.config.syncOnEventDelete === "delete") {
            if (await this.archiveFile(file)) return "deleted";
        }
        return (await this.markCancelledWithoutDelete(file)) ? "updated" : "none";
    }

    private async markInlineTaskCancelled(note: VaultNote, event: ExternalCalendarEvent): Promise<boolean> {
        const expectedExternalId = buildCalendarExternalId(this.app, event);
        const normalizedSourceUrl = this.normalizeSourceUrl(event.sourceUrl);
        const state: { outcome: ExternalTaskLineMutationOutcome; lineIndex: number } = {
            outcome: "not-found",
            lineIndex: -1,
        };
        try {
            await this.app.vault.process(note.file, (content) => {
                const lines = content.split(/\r\n|\n|\r/);
                const footnoteMetadata = this.parseInlineMetadataFootnotes(lines);
                const mutation = mutateExternalTaskLineContent(
                    content,
                    (line, currentLineIndex) => {
                        if (
                            typeof note.taskLineIndex === "number"
                            && currentLineIndex === note.taskLineIndex
                            && line === note.taskRawLine
                        ) {
                            return true;
                        }
                        const props = this.parseInlineDataviewProperties(line, footnoteMetadata);
                        const externalId = this.normalizeIdentityValue(props.get("externalid"));
                        if (expectedExternalId && externalId === expectedExternalId) return true;
                        const eventId = this.normalizeIdentityValue(
                            props.get(this.config.eventIdKey.toLowerCase()) || props.get("externaleventid"),
                        );
                        const sourceUrl = this.normalizeSourceUrl(
                            props.get(this.config.sourceUrlKey.toLowerCase()) || props.get("tpscalendarsourceurl"),
                        );
                        return eventId === event.id && (!normalizedSourceUrl || sourceUrl === normalizedSourceUrl);
                    },
                    (line) => cancelOpenInlineTaskLine(line) || line,
                );
                state.outcome = mutation.outcome;
                state.lineIndex = mutation.lineIndex;
                return mutation.content;
            });
        } catch (error) {
            logger.flowError("AutoCreate", "event:cancelled-inline-task-failed", error, {
                path: note.file.path,
            });
            return false;
        }

        if (state.outcome === "unchanged") return false;
        if (state.outcome !== "changed") {
            logger.flowWarn("AutoCreate", "event:cancelled-inline-task-skipped", {
                path: note.file.path,
                outcome: state.outcome,
            });
            return false;
        }
        emitFilesUpdated(this.app, [note.file.path], "tps-controller");
        logger.flow("AutoCreate", "event:cancelled-inline-task-done", {
            path: note.file.path,
            line: state.lineIndex + 1,
        });
        return true;
    }

    private async markCancelledWithoutDelete(file: TFile): Promise<boolean> {
        const cancelledStatus = this.normalizeIdentityValue(this.config.canceledStatusValue) || "cancelled";
        const cancelledAt = new Date().toISOString();
        let didUpdate = false;
        await this.processFrontmatterSafely(file, "mark-cancelled", (fm) => {
            const currentStatus = this.normalizeIdentityValue(this.findKeyInsensitive(fm, this.config.statusKey));
            const previousStatus = this.normalizeIdentityValue(this.findKeyInsensitive(fm, this.config.previousStatusKey));
            if (currentStatus && currentStatus.toLowerCase() !== cancelledStatus.toLowerCase() && !previousStatus) {
                fm[this.config.previousStatusKey] = currentStatus;
                didUpdate = true;
            }
            if (currentStatus !== cancelledStatus) {
                fm[this.config.statusKey] = cancelledStatus;
                didUpdate = true;
            }
            if (!this.normalizeIdentityValue(this.findKeyInsensitive(fm, this.config.cancelledAtKey))) {
                fm[this.config.cancelledAtKey] = cancelledAt;
                didUpdate = true;
            }
            didUpdate = this.deleteFrontmatterKeyIfPresent(fm, this.config.orphanCandidateAtKey) || didUpdate;
            didUpdate = this.deleteFrontmatterKeyIfPresent(fm, this.config.orphanMissCountKey) || didUpdate;
            didUpdate = this.deleteFrontmatterKeyIfPresent(fm, this.config.orphanReasonKey) || didUpdate;
        });
        return didUpdate;
    }

    private async markOrphanCandidate(note: VaultNote, missCount: number): Promise<boolean> {
        const now = new Date().toISOString();
        let didUpdate = false;
        await this.processFrontmatterSafely(note.file, "mark-orphan-candidate", (fm) => {
            if (!this.normalizeIdentityValue(this.findKeyInsensitive(fm, this.config.orphanCandidateAtKey))) {
                fm[this.config.orphanCandidateAtKey] = now;
                didUpdate = true;
            }
            if (Number(this.findKeyInsensitive(fm, this.config.orphanMissCountKey)) !== missCount) {
                fm[this.config.orphanMissCountKey] = missCount;
                didUpdate = true;
            }
            if (this.normalizeIdentityValue(this.findKeyInsensitive(fm, this.config.orphanReasonKey)) !== "missing-from-source") {
                fm[this.config.orphanReasonKey] = "missing-from-source";
                didUpdate = true;
            }
        });
        return didUpdate;
    }

    private async clearOrphanCandidate(file: TFile): Promise<boolean> {
        let didUpdate = false;
        await this.processFrontmatterSafely(file, "clear-orphan-candidate", (fm) => {
            didUpdate = this.deleteFrontmatterKeyIfPresent(fm, this.config.orphanCandidateAtKey) || didUpdate;
            didUpdate = this.deleteFrontmatterKeyIfPresent(fm, this.config.orphanMissCountKey) || didUpdate;
            didUpdate = this.deleteFrontmatterKeyIfPresent(fm, this.config.orphanReasonKey) || didUpdate;
        });
        return didUpdate;
    }

    private async deleteOrArchive(file: TFile): Promise<boolean> {
        try {
            if (this.config.syncOnEventDelete === "delete") {
                await this.app.vault.delete(file);
                return true;
            }
            if (this.config.syncOnEventDelete === "archive") return this.archiveFile(file);
        } catch (error) {
            logger.error(`[AutoCreateService] Failed to delete/archive ${file.path}:`, error);
        }
        return false;
    }

    private async archiveFile(file: TFile): Promise<boolean> {
        const folder = this.config.archiveFolder;
        if (!folder || this.isArchivedNote(file)) return false;
        await this.ensureFolder(folder);
        let newPath = normalizePath(`${folder}/${file.name}`);
        let counter = 1;
        while (this.app.vault.getAbstractFileByPath(newPath)) {
            newPath = normalizePath(`${folder}/${file.basename} (${counter}).${file.extension}`);
            counter++;
        }
        await this.app.vault.rename(file, newPath);
        return true;
    }

    private async ensureFolder(folderPath: string): Promise<void> {
        let current = "";
        for (const segment of normalizePath(folderPath).split("/").filter(Boolean)) {
            current = current ? `${current}/${segment}` : segment;
            if (!this.app.vault.getAbstractFileByPath(current)) {
                await this.app.vault.createFolder(current);
            }
        }
    }

    private async getFrontmatterForFile(file: TFile): Promise<Record<string, any> | null> {
        return this.app.metadataCache.getFileCache(file)?.frontmatter || null;
    }

    private async processFrontmatterSafely(
        file: TFile,
        reason: string,
        mutate: (fm: Record<string, any>) => void,
    ): Promise<boolean> {
        try {
            await this.app.fileManager.processFrontMatter(file, (fm) => mutate((fm ?? {}) as Record<string, any>));
            this.malformedFrontmatterWarnedPaths.delete(file.path);
            return true;
        } catch (error) {
            if (!this.malformedFrontmatterWarnedPaths.has(file.path)) {
                this.malformedFrontmatterWarnedPaths.add(file.path);
                new Notice(`Skipped frontmatter update for "${file.basename}".`);
            }
            logger.warn(`[AutoCreateService] Frontmatter mutation failed (${reason})`, { file: file.path, error });
            return false;
        }
    }

    private findKeyInsensitive(obj: Record<string, any>, key: string): any {
        const normalized = String(key || "").trim().toLowerCase();
        const found = Object.keys(obj).find((candidate) => candidate.trim().toLowerCase() === normalized);
        return found ? obj[found] : undefined;
    }

    private deleteFrontmatterKeyIfPresent(obj: Record<string, any>, key: string): boolean {
        const normalized = String(key || "").trim().toLowerCase();
        const found = Object.keys(obj).find((candidate) => candidate.trim().toLowerCase() === normalized);
        if (!found) return false;
        delete obj[found];
        return true;
    }

    private deleteLegacyCalendarIdentityFields(obj: Record<string, any>): void {
        this.deleteFrontmatterKeyIfPresent(obj, this.config.eventIdKey);
        this.deleteFrontmatterKeyIfPresent(obj, this.config.uidKey);
        this.deleteFrontmatterKeyIfPresent(obj, this.config.sourceUrlKey);
        this.deleteFrontmatterKeyIfPresent(obj, "externalEventId");
        this.deleteFrontmatterKeyIfPresent(obj, "tpsCalendarUid");
        this.deleteFrontmatterKeyIfPresent(obj, "tpsCalendarSourceUrl");
    }

    private isArchivedNote(file: TFile): boolean {
        const archive = normalizePath(this.config.archiveFolder || "");
        return !!archive && (file.path === archive || file.path.startsWith(`${archive}/`));
    }

    private buildEventKey(eventId: string | null | undefined, sourceUrl: unknown): string | null {
        const normalizedEventId = this.normalizeIdentityValue(eventId);
        if (!normalizedEventId) return null;
        return `${this.normalizeSourceUrl(sourceUrl) || ""}::${normalizedEventId}`;
    }

    private buildEventKeyForEvent(event: ExternalCalendarEvent): string {
        return buildCalendarExternalId(this.app, event) || this.buildEventKey(event.id, event.sourceUrl) || `::${event.id || ""}`;
    }

    private setPreferredEventKey(index: Map<string, VaultNote>, key: string, note: VaultNote): void {
        const existing = index.get(key);
        if (!existing) {
            index.set(key, note);
            return;
        }
        if (existing.isArchived && !note.isArchived) {
            index.set(key, note);
            return;
        }
        if (this.isInConfiguredSyncScope(existing.file) && !this.isInConfiguredSyncScope(note.file)) return;
        if (!this.isInConfiguredSyncScope(existing.file) && this.isInConfiguredSyncScope(note.file)) {
            index.set(key, note);
        }
    }

    private addLegacyEventId(index: Map<string, VaultNote[]>, eventId: string | null | undefined, note: VaultNote): void {
        const normalizedEventId = this.normalizeIdentityValue(eventId);
        if (!normalizedEventId) return;
        const existing = index.get(normalizedEventId) || [];
        if (!existing.some((candidate) => candidate.file.path === note.file.path)) {
            existing.push(note);
            index.set(normalizedEventId, existing);
        }
    }

    private findLegacyEventMatch(event: ExternalCalendarEvent, byLegacyEventId: Map<string, VaultNote[]>, allowArchived = false): VaultNote | null {
        const normalizedEventId = this.normalizeIdentityValue(event.id);
        if (!normalizedEventId) return null;
        const candidates = (byLegacyEventId.get(normalizedEventId) || []).filter((note) => allowArchived || !note.isArchived);
        if (!candidates.length) return null;
        const eventSource = this.normalizeSourceUrl(event.sourceUrl);
        if (!eventSource) return candidates.length === 1 ? candidates[0] : null;
        const sourceMatches = candidates.filter((note) => note.sourceUrl === eventSource);
        if (sourceMatches.length === 1) return sourceMatches[0];
        const legacyWithoutSource = candidates.filter((note) => !note.sourceUrl);
        return legacyWithoutSource.length === 1 ? legacyWithoutSource[0] : null;
    }

    private findVaultNoteForEvent(
        event: ExternalCalendarEvent,
        byEventKey: Map<string, VaultNote>,
        byLegacyEventId: Map<string, VaultNote[]>,
        byUidStart: Map<string, VaultNote>,
        byTitleDay: Map<string, VaultNote>,
        byEventUrl: Map<string, VaultNote>,
    ): { note: VaultNote | null; repairedEventId: boolean } {
        const exactMatch = byEventKey.get(this.buildEventKeyForEvent(event));
        let match = exactMatch && !exactMatch.isArchived ? exactMatch : this.findLegacyEventMatch(event, byLegacyEventId);
        let repairedEventId = false;
        if (!match) {
            const fallback = byUidStart.get(this.buildUidStartKey(event));
            if (fallback && !fallback.isArchived) {
                match = fallback;
                repairedEventId = true;
            }
        }
        if (!match) {
            const eventUrl = this.normalizeEventUrl(event.url);
            const urlFallback = eventUrl ? byEventUrl.get(eventUrl) : null;
            if (urlFallback && !urlFallback.isArchived) {
                match = urlFallback;
                repairedEventId = true;
            }
        }
        if (!match) {
            const key = this.buildTitleDayKey(event.title.trim().toLowerCase(), event.startDate, event.sourceUrl);
            const titleFallback = byTitleDay.get(key);
            if (titleFallback && !titleFallback.isArchived) {
                match = titleFallback;
                repairedEventId = true;
            }
        }
        return { note: match || null, repairedEventId };
    }

    private buildUidStartKey(event: ExternalCalendarEvent): string {
        return this.buildUidStartKeyFromParts(event.uid || this.extractUid(event.id) || event.id || "", event.startDate, event.sourceUrl);
    }

    private buildUidStartKeyFromParts(uid: string | null | undefined, startDate: Date | null | undefined, sourceUrl: unknown): string {
        const normalizedUid = this.normalizeIdentityValue(uid) || "";
        const ts = Number.isFinite(startDate?.getTime?.()) ? Math.round(startDate!.getTime() / 60000) * 60000 : 0;
        return `${this.normalizeSourceUrl(sourceUrl) || ""}::${normalizedUid}|${ts}`;
    }

    private buildTitleDayKey(title: string, startDate: Date, sourceUrl: unknown): string {
        return `${this.normalizeSourceUrl(sourceUrl) || ""}::${title}|${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, "0")}-${String(startDate.getDate()).padStart(2, "0")}`;
    }

    private extractUid(id: string): string | null {
        const match = id.match(/[-_](?:dup[-_])?(?:\d{4}\d{2}\d{2}T\d{2}\d{2}\d{2}|\d{13,})$/);
        return match && match.index && match.index > 0 ? id.substring(0, match.index) : null;
    }

    private getRecurrenceDateFromId(id: string): Date | null {
        const stableMatch = id.match(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/);
        if (stableMatch) return new Date(+stableMatch[1], +stableMatch[2] - 1, +stableMatch[3], +stableMatch[4], +stableMatch[5], +stableMatch[6]);
        const msMatch = id.match(/[-_](\d{13,})$/);
        return msMatch ? new Date(parseInt(msMatch[1], 10)) : null;
    }

    private normalizeIdentityValue(value: any): string | null {
        if (typeof value !== "string") return null;
        const normalized = value.trim();
        if (!normalized) return null;
        const lower = normalized.toLowerCase();
        return ["null", "undefined", "none", "n/a"].includes(lower) ? null : normalized;
    }

    private normalizeBooleanValue(value: any): boolean | null {
        if (typeof value === "boolean") return value;
        if (typeof value === "number") return value === 1 ? true : value === 0 ? false : null;
        if (typeof value !== "string") return null;
        const normalized = value.trim().toLowerCase().split(/\s+/)[0];
        if (["true", "yes", "y", "1"].includes(normalized)) return true;
        if (["false", "no", "n", "0"].includes(normalized)) return false;
        return null;
    }

    private normalizeSourceUrl(value: unknown): string | null {
        if (typeof value !== "string") return null;
        return normalizeCalendarUrl(value) || null;
    }

    private normalizeEventUrl(value: unknown): string | null {
        if (typeof value !== "string") return null;
        const trimmed = value.trim();
        if (!trimmed) return null;
        return trimmed.replace(/\/+$/, "") || null;
    }

    private extractSourceUrlFromCalendarExternalId(externalId: string | null | undefined): string | null {
        const value = this.normalizeIdentityValue(externalId);
        if (!value || !value.startsWith("calendar:")) return null;
        const separatorIndex = value.indexOf("#");
        if (separatorIndex <= "calendar:".length) return null;
        return this.normalizeSourceUrl(value.slice("calendar:".length, separatorIndex));
    }

    private pruneOrphanDeletionTombstones(now = Date.now()): void {
        for (const [eventId, ts] of this.orphanDeletionTombstones.entries()) {
            if (now - ts > AutoCreateService.ORPHAN_TOMBSTONE_TTL_MS) this.orphanDeletionTombstones.delete(eventId);
        }
    }

    private recordOrphanDeletion(eventId: string | null): void {
        if (eventId) this.orphanDeletionTombstones.set(eventId, Date.now());
    }

    private hasRecentOrphanDeletion(eventId: string | null): boolean {
        if (!eventId) return false;
        const deletedAt = this.orphanDeletionTombstones.get(eventId);
        if (!deletedAt) return false;
        if (Date.now() - deletedAt > AutoCreateService.ORPHAN_TOMBSTONE_TTL_MS) {
            this.orphanDeletionTombstones.delete(eventId);
            return false;
        }
        return true;
    }

    private canEvaluateOrphanForNote(
        note: VaultNote,
        configuredUrlSet: Set<string>,
        successfulUrls: Set<string>,
        failedUrls: Set<string>,
    ): boolean {
        if (!note.sourceUrl) return configuredUrlSet.size > 0 && successfulUrls.size === configuredUrlSet.size && failedUrls.size === 0;
        if (!configuredUrlSet.has(note.sourceUrl)) return false;
        return successfulUrls.has(note.sourceUrl);
    }
}
