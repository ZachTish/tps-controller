const fs = require('fs');

const path = '/Users/zachtisherman/Library/Mobile Documents/iCloud~md~obsidian/Documents/TishOS Testing Vault/.obsidian/plugins/TPS-Controller (Dev)/src/services/auto-create-service.ts';

const content = `import { App, TFile, normalizePath, Notice, parseYaml } from "obsidian";
import * as logger from "../logger";
import { ExternalCalendarService } from "./external-calendar-service";
import { ExternalCalendarEvent } from "../types";
import { createMeetingNoteFromExternalEvent } from "./external-event-modal";
import { formatDateTimeForFrontmatter } from "../utils";
import { mergeTagInputs, normalizeTagValue, parseTagInput } from "./tag-utils";

interface CalendarAutoCreateConfig {
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
    syncOnEventDelete: 'delete' | 'archive' | 'nothing';
    archiveFolder: string;
    canceledStatusValue: string | null;
    allowAutoCreate?: boolean;
    eventIdKey: string;
    uidKey: string;
    titleKey: string;
    statusKey: string;
    previousStatusKey: string;
}

interface VaultNoteIndex {
    file: TFile;
    eventId: string;
    uid: string;
    startDate: Date | null;
    isArchived: boolean;
}

export class AutoCreateService {
    app: App;
    config: AutoCreateServiceConfig;
    private isSyncing = false;

    constructor(app: App) {
        this.app = app;
        this.config = {
            startProperty: "scheduled",
            endProperty: "timeEstimate",
            useEndDuration: true,
            syncOnEventDelete: 'nothing',
            archiveFolder: "",
            canceledStatusValue: null,
            allowAutoCreate: false,
            eventIdKey: "externalEventId",
            uidKey: "tpsCalendarUid",
            titleKey: "title",
            statusKey: "status",
            previousStatusKey: "tpsCalendarPrevStatus",
        };
    }

    updateConfig(config: Partial<AutoCreateServiceConfig>) {
        this.config = { ...this.config, ...config };
    }

    async checkAndCreateMeetingNotes(
        externalCalendarService: ExternalCalendarService,
        urls: string[],
        externalCalendarFilter: string,
        calendarConfigs: Record<string, CalendarAutoCreateConfig>,
        forceRegenerate = false
    ) {
        if (this.config.allowAutoCreate === false || this.isSyncing) return;
        
        const hasAutoCreate = Object.values(calendarConfigs).some(config => (config?.autoCreateEnabled ?? true) !== false);
        if (!hasAutoCreate) return;

        this.isSyncing = true;
        logger.log('[AutoCreateService] Starting simplified 1:1 sync...');

        try {
            const start = new Date();
            start.setDate(start.getDate() - 7);
            const end = new Date();
            end.setDate(end.getDate() + 14);

            const filterTerms = externalCalendarFilter.split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
            const remoteEvents = await this.fetchAllRemoteEvents(externalCalendarService, urls, start, end);
            
            logger.log('[AutoCreateService] Building vault index...');
            const vaultIndex = await this.buildVaultIndex();

            let created = 0, updated = 0, deleted = 0;
            const processedEventIds = new Set<string>();
            const matchedFiles = new Set<string>();

            for (const event of remoteEvents) {
                if (processedEventIds.has(event.id)) continue;
                processedEventIds.add(event.id);

                try {
                    const result = await this.processEvent(
                        event,
                        vaultIndex,
                        calendarConfigs[event.sourceUrl || ""],
                        filterTerms,
                        forceRegenerate
                    );

                    if (result.action === 'created') created++;
                    if (result.action === 'updated') updated++;
                    if (result.action === 'deleted') deleted++;
                    if (result.file) matchedFiles.add(result.file.path);
                } catch (error) {
                    logger.error(\`[AutoCreateService] Error processing event "\${event.title}"\`, error);
                }
            }

            // Orphan Cleanup
            logger.log(\`[AutoCreateService] Checking for orphaned notes...\`);
            for (const note of vaultIndex) {
                 if (note.isArchived) continue;
                 if (matchedFiles.has(note.file.path)) continue;

                 const noteDate = note.startDate ?? this.getRecurrenceDateFromId(note.eventId);
                 if (noteDate && noteDate >= start && noteDate <= end) {
                     logger.warn(\`[AutoCreateService] 🗑️  Orphan detected: \${note.file.path}\`);
                     if (await this.deleteOrArchive(note.file)) {
                         deleted++;
                     }
                 }
            }

            if (created + updated + deleted > 0) {
                new Notice(\`Calendar Sync: \${created} created, \${updated} updated, \${deleted} archived/deleted\`);
            } else {
                logger.log('[AutoCreateService] No changes.');
            }

        } catch (e) {
            logger.error('[AutoCreateService] Sync failed:', e);
        } finally {
            this.isSyncing = false;
        }
    }

    private async fetchAllRemoteEvents(service: ExternalCalendarService, urls: string[], start: Date, end: Date): Promise<ExternalCalendarEvent[]> {
        const results: ExternalCalendarEvent[] = [];
        for (const url of urls) {
            try {
                results.push(...await service.fetchEvents(url, start, end, true, true));
            } catch (e) {
                logger.error(\`Failed to fetch \${url}\`, e);
            }
        }
        return results;
    }

    private async buildVaultIndex(): Promise<VaultNoteIndex[]> {
        const index: VaultNoteIndex[] = [];
        const files = this.app.vault.getMarkdownFiles();
        for (const file of files) {
            const isTrash = normalizePath(file.path).toLowerCase().startsWith(".trash");
            if (isTrash) continue;

            const fm = await this.getFrontmatterForFile(file);
            if (!fm) continue;

            const eventId = this.findKeyInsensitive(fm, this.config.eventIdKey);
            if (!eventId) continue;

            const uid = this.findKeyInsensitive(fm, this.config.uidKey) || this.extractUid(eventId) || eventId;
            let startDate: Date | null = null;
            const startVal = this.findKeyInsensitive(fm, this.config.startProperty) ?? this.findKeyInsensitive(fm, "scheduled");
            if (startVal) {
                const parsed = new Date(startVal);
                if (Number.isFinite(parsed.getTime())) startDate = parsed;
            }

            index.push({
                file,
                eventId,
                uid,
                startDate,
                isArchived: this.isArchivedNote(file)
            });
        }
        return index;
    }

    private async getFrontmatterForFile(file: TFile): Promise<Record<string, any> | null> {
        const cache = this.app.metadataCache.getFileCache(file);
        if (cache?.frontmatter) return cache.frontmatter;
        try {
            const content = await this.app.vault.cachedRead(file);
            const match = content.match(/^---\\r?\\n([\\s\\S]*?)\\r?\\n---(?:\\r?\\n|$)/);
            if (match) {
                const parsed = parseYaml(match[1]);
                if (typeof parsed === 'object') return parsed;
            }
        } catch {}
        return null;
    }

    private findKeyInsensitive(obj: Record<string, any>, key: string): any {
        const normalized = String(key || "").trim().toLowerCase();
        const found = Object.keys(obj).find(k => k.trim().toLowerCase() === normalized);
        return found ? obj[found] : undefined;
    }

    private isArchivedNote(file: TFile): boolean {
        const archive = this.config.archiveFolder;
        if (!archive) return false;
        const norm = normalizePath(archive);
        return file.path === norm || file.path.startsWith(\`\${norm}/\`);
    }

    private async processEvent(
        event: ExternalCalendarEvent,
        index: VaultNoteIndex[],
        calendarInfo: CalendarAutoCreateConfig | null,
        filterTerms: string[],
        forceRegenerate: boolean
    ): Promise<{ action: 'created' | 'updated' | 'deleted' | 'none', file?: TFile }> {
        // 1. Find Match
        const match = index.find(n => n.eventId === event.id);

        // 2. Process Match
        if (match) {
            if (match.isArchived) {
                logger.log(\`[AutoCreateService] ⏭️  Skipping previously archived event: \${event.title}\`);
                return { action: 'none', file: match.file };
            }

            if (event.isCancelled) {
                logger.log(\`[AutoCreateService] 🚫 Event CANCELLED: \${event.title}\`);
                await this.deleteOrArchive(match.file);
                return { action: 'deleted', file: match.file };
            }

            let updated = false;
            await this.app.fileManager.processFrontMatter(match.file, (fm) => {
                const currentTitle = fm[this.config.titleKey];
                if (currentTitle !== event.title) {
                    fm[this.config.titleKey] = event.title;
                    updated = true;
                }

                const expectedStart = formatDateTimeForFrontmatter(event.startDate);
                if (fm[this.config.startProperty] !== expectedStart) {
                    fm[this.config.startProperty] = expectedStart;
                    updated = true;
                }

                if (this.config.useEndDuration) {
                    const dur = Math.round((event.endDate.getTime() - event.startDate.getTime()) / 60000);
                    if (fm[this.config.endProperty] !== dur) {
                        fm[this.config.endProperty] = dur;
                        updated = true;
                    }
                } else {
                    const expectedEnd = formatDateTimeForFrontmatter(event.endDate);
                    if (fm[this.config.endProperty] !== expectedEnd) {
                        fm[this.config.endProperty] = expectedEnd;
                        updated = true;
                    }
                }
            });

            return { action: updated ? 'updated' : 'none', file: match.file };
        }

        // 3. Create Note if no match
        if (event.isCancelled) return { action: 'none' };
        if (filterTerms.some(t => event.title.toLowerCase().includes(t))) return { action: 'none' };
        if (calendarInfo?.autoCreateEnabled === false) return { action: 'none' };

        // Check if there is an archived version (so we don't resurrect it)
        const archivedMatch = index.find(n => n.isArchived && (n.eventId === event.id || n.uid === event.uid));
        if (archivedMatch) {
            logger.log(\`[AutoCreateService] ⏭️  Skipping creation (archived version exists): \${archivedMatch.file.path}\`);
            return { action: 'none' };
        }

        logger.log(\`[AutoCreateService] 📝 Creating new note for: \${event.title}\`);
        
        // Pass explicit paths from controller config
        const resolvedFolder = calendarInfo?.typeFolder || calendarInfo?.folder || "";
        const resolvedTemplate = calendarInfo?.template || null;

        const file = await createMeetingNoteFromExternalEvent(
            this.app,
            event,
            resolvedTemplate,
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
                titleKey: this.config.titleKey,
                statusKey: this.config.statusKey,
            }
        );

        return file ? { action: 'created', file } : { action: 'none' };
    }

    private async deleteOrArchive(file: TFile): Promise<boolean> {
        if (this.config.syncOnEventDelete === 'delete') {
            await this.app.vault.delete(file);
            return true;
        } else if (this.config.syncOnEventDelete === 'archive') {
            const folder = this.config.archiveFolder;
            if (folder && !this.isArchivedNote(file)) {
                await this.ensureFolder(folder);
                await this.app.vault.rename(file, normalizePath(\`\${folder}/\${file.name}\`));
                return true;
            }
        }
        return false;
    }

    private async ensureFolder(folderPath: string) {
        let current = "";
        for (const segment of normalizePath(folderPath).split('/').filter(Boolean)) {
            current = current ? \`\${current}/\${segment}\` : segment;
            if (!this.app.vault.getAbstractFileByPath(current)) {
                await this.app.vault.createFolder(current);
            }
        }
    }

    private extractUid(id: string): string | null {
        const match = id.match(/[-_]([^-_]+)$/);
        return match ? id.substring(0, match.index) : null;
    }

    private getRecurrenceDateFromId(id: string): Date | null {
        const match = id.match(/[-_]([^-_]+)$/);
        if (!match) return null;
        const suffix = match[1];
        if (/^\\d+$/.test(suffix)) return new Date(parseInt(suffix, 10));
        const iso = suffix.match(/^(\\d{4})(\\d{2})(\\d{2})T(\\d{2})(\\d{2})(\\d{2})Z$/);
        if (iso) return new Date(Date.UTC(+iso[1], +iso[2] - 1, +iso[3], +iso[4], +iso[5], +iso[6]));
        return null;
    }
}
`;

fs.writeFileSync(path, content, 'utf8');
console.log('Successfully rewrote auto-create-service.ts');
