import { App, TFile, parseYaml, stringifyYaml } from 'obsidian';
import { canAutomaticallyMutateSourceViaGcm, canAutomaticallyMutateViaGcm, getExternalId, getGcmApi } from '../tps-gcm-api';
import { calendarRecordSourceScope, deriveCalendarRecordSourceScope } from './calendar-record-identity';
import { applyNoteRuleResult, createNoteRuleSession, ruleProperty, validRuleKey } from './note-rules';
import type { TPSControllerSettings } from '../types';

export interface NoteRuleChange {
    path: string; nextPath: string; fingerprint: string;
    before: Record<string, unknown>; after: Record<string, unknown>; matched: string[];
    error?: string;
}
export interface NoteRulePlan { signature: string; changes: NoteRuleChange[]; scanned: number; skipped: Array<{path: string; reason: string}>; }
export interface NoteRuleRunResult { applied: string[]; failed: Array<{path: string; reason: string}>; }
export type NoteRuleScope = { kind: 'note'; path: string } | { kind: 'folder'; path: string } | { kind: 'vault' };
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const pathKey = (path: string) => path.normalize('NFC').toLowerCase();
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);

export function isRuleNotePath(path: string): boolean {
    return path.toLowerCase().endsWith('.md') && !path.split('/').some(segment => segment.startsWith('.') || ['Plugin Development', 'node_modules', '_archive', '_trash'].includes(segment));
}
export function parseRuleNote(content: string): { properties: Record<string, unknown>; body: string; eol: string; bom: string } {
    const bom = content.startsWith('\ufeff') ? '\ufeff' : '';
    const source = bom ? content.slice(1) : content;
    const eol = source.includes('\r\n') ? '\r\n' : '\n';
    if (!/^---(?:\r?\n|$)/u.test(source)) return { properties: {}, body: source, eol, bom };
    const match = source.match(/^---\r?\n([\s\S]*?)^---(?:\r?\n|$)/mu);
    if (!match) throw new Error('Frontmatter is incomplete.');
    const properties = parseYaml(match[1]) ?? {};
    if (typeof properties !== 'object' || Array.isArray(properties)) throw new Error('Frontmatter must be a property map.');
    const keys = Object.keys(properties);
    if (new Set(keys.map(key => key.toLowerCase())).size !== keys.length) throw new Error('Ambiguous property names differ only by case.');
    if (keys.some(key => ['__proto__', 'constructor', 'prototype'].includes(key.toLowerCase()))) throw new Error('Unsafe property name.');
    return { properties, body: source.slice(match[0].length), eol, bom };
}
export function writeRuleNote(content: string, properties: Record<string, unknown>): string {
    const parsed = parseRuleNote(content);
    const yaml = stringifyYaml(properties).trimEnd().replace(/\r?\n/gu, parsed.eol);
    return `${parsed.bom}---${parsed.eol}${yaml}${parsed.eol}---${parsed.eol}${parsed.body}`;
}
async function fingerprint(content: string): Promise<string> {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
    return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Explicit preview/apply only. No startup scan, import callback, watcher or timer. */
export class NoteRuleRunner {
    busy = false;
    private disposed = false;
    private issuedPlans = new WeakMap<NoteRulePlan, string>();
    constructor(private readonly app: App, private readonly settings: () => TPSControllerSettings, private readonly readSavedRules?: () => Promise<unknown>) {}
    private async assertSavedRules(): Promise<void> {
        if (this.readSavedRules && JSON.stringify(await this.readSavedRules()) !== JSON.stringify(this.settings().noteRules)) throw new Error('Saved rules changed on disk. Reload saved rules in Controller settings, then preview again.');
    }
    dispose(): void { this.disposed = true; }
    private signature(): string {
        const settings = this.settings();
        return JSON.stringify({ rules: settings.noteRules, title: settings.titleKey, calendars: settings.externalCalendars, identity: this.identityKeys(), identityTags: this.identityTags() });
    }
    private identityKeys(): string[] {
        const gcm = (this.app as any).plugins?.plugins?.['tps-global-context-menu']?.settings;
        const aliases = Array.isArray(gcm?.nativeRecordStorageAliases) ? gcm.nativeRecordStorageAliases : [];
        return [gcm?.nativeRecordIdentityPropertyKey || 'tpsId', gcm?.nativeRecordSchemaPropertyKey, ...aliases.flatMap((profile: any) => [profile.identityPropertyKey, profile.schemaPropertyKey]), gcm?.integrationNotePropertyKeys?.externalId || 'externalId', this.settings().eventIdKey, this.settings().uidKey, 'subitemId'].filter(Boolean);
    }
    private identityTags(): string[] {
        const gcm = (this.app as any).plugins?.plugins?.['tps-global-context-menu']?.settings;
        return [gcm?.nativeRecordIdentityTagPrefix, ...(gcm?.nativeRecordStorageAliases || []).map((profile: any) => profile.identityTagPrefix)].filter(Boolean);
    }
    private assertAvailable(): void {
        if (this.disposed) throw new Error('Controller was reloaded; open a new preview.');
    }
    private file(path: string): TFile {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile) || !isRuleNotePath(path)) throw new Error('Note is missing, moved, or excluded.');
        return file;
    }
    async preview(scope: NoteRuleScope, progress: (count: number) => void = () => {}): Promise<NoteRulePlan> {
        this.assertAvailable();
        if (this.busy) throw new Error('Another rules operation is running.');
        this.busy = true;
        try {
            await this.assertSavedRules();
            const signature = this.signature();
            const settings = this.settings();
            const session = createNoteRuleSession(settings.noteRules);
            if (!validRuleKey(settings.titleKey) || ['tags', ...this.identityKeys()].some(key => key.toLowerCase() === settings.titleKey.toLowerCase())) throw new Error('Configure a valid title property in Advanced that is separate from tags and record IDs.');
            const folder = scope.kind === 'folder' ? scope.path.trim().replace(/^\/+|\/+$/gu, '') : '';
            if (folder.split('/').some(segment => segment === '..' || segment === '.')) throw new Error('Use a vault-relative folder.');
            const files = this.app.vault.getMarkdownFiles().filter(file => scope.kind === 'note' ? file.path === scope.path : scope.kind === 'vault' || !folder || file.path.startsWith(`${folder}/`)).sort((a, b) => a.path.localeCompare(b.path));
            if (scope.kind === 'note' && !files.length) throw new Error('Open a Markdown note first.');
            const calendars = await Promise.all((settings.externalCalendars || []).map(async calendar => ({ id: calendar.id, url: String(calendar.url || '').replace(/\/+$/u, ''), scope: await deriveCalendarRecordSourceScope(calendar.id) })));
            const plan: NoteRulePlan = { signature, changes: [], scanned: 0, skipped: [] };
            for (const file of files) {
                this.assertAvailable();
                plan.scanned++;
                try {
                    if (!isRuleNotePath(file.path)) continue;
                    if (file.stat.size > 2 * 1024 * 1024) throw new Error('Note is larger than the 2 MiB preview limit.');
                    if (!(await canAutomaticallyMutateViaGcm(this.app, file))) throw new Error('Protected template.');
                    const content = await this.app.vault.read(file);
                    if (content.length > 2 * 1024 * 1024) throw new Error('Note is larger than the preview limit.');
                    if (!canAutomaticallyMutateSourceViaGcm(this.app, content)) throw new Error('Protected template.');
                    const before = parseRuleNote(content).properties;
                    const nativeId = getGcmApi(this.app)?.nativeRecords?.inspect?.(before)?.id || ruleProperty(before, this.identityKeys()[0]);
                    const sourceScope = calendarRecordSourceScope(nativeId);
                    const externalId = getExternalId(this.app, before);
                    const owners = calendars.filter(calendar => sourceScope === calendar.scope || (calendar.url && externalId?.startsWith(`calendar:${calendar.url}#`)));
                    const storedTitle = ruleProperty(before, settings.titleKey);
                    const result = session.evaluate({ name: file.basename, path: file.path, title: storedTitle == null || storedTitle === '' ? file.basename : String(storedTitle), calendar: owners.length === 1 ? owners[0].id : '', properties: before, protectedKeys: [...this.identityKeys(), settings.titleKey], protectedTagPrefixes: this.identityTags() });
                    if (!result.matched.length) continue;
                    const after = applyNoteRuleResult(before, result, settings.titleKey);
                    const prefix = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/') + 1) : '';
                    const nextPath = result.rename ? `${prefix}${result.title}.md` : file.path;
                    if (same(before, after) && nextPath === file.path) continue;
                    plan.changes.push({ path: file.path, nextPath, before, after, fingerprint: await fingerprint(content), matched: result.matched });
                } catch (error) { plan.skipped.push({ path: file.path, reason: errorText(error) }); }
                if (plan.scanned % 20 === 0) { progress(plan.scanned); await new Promise(resolve => setTimeout(resolve, 0)); }
            }
            this.checkDestinations(plan.changes);
            if (signature !== this.signature()) throw new Error('Rules or field settings changed during preview; preview again.');
            this.issuedPlans.set(plan, JSON.stringify(plan));
            return plan;
        } finally { this.busy = false; }
    }
    private checkDestinations(changes: NoteRuleChange[]): void {
        const all = this.app.vault.getAllLoadedFiles();
        const destinations = new Map<string, NoteRuleChange[]>();
        for (const change of changes) {
            delete change.error;
            const key = pathKey(change.nextPath);
            const group = destinations.get(key) || []; group.push(change); destinations.set(key, group);
            if (change.nextPath !== change.path && all.some(file => pathKey(file.path) === key && file.path !== change.path)) change.error = 'Destination already exists (including case or Unicode variants).';
            if (change.nextPath !== change.path && pathKey(change.path) === key) change.error = 'Case-only renames require an intermediate manual name.';
        }
        for (const group of destinations.values()) if (group.length > 1) for (const change of group) change.error = 'Multiple notes would receive the same filename.';
    }
    async apply(plan: NoteRulePlan, selectedPaths: Set<string>): Promise<NoteRuleRunResult> {
        this.assertAvailable();
        if (this.busy) throw new Error('Another rules operation is running.');
        if (this.issuedPlans.get(plan) !== JSON.stringify(plan) || plan.signature !== this.signature()) throw new Error('Preview expired; preview again.');
        this.busy = true;
        const changes = plan.changes.filter(change => selectedPaths.has(change.path));
        const result: NoteRuleRunResult = { applied: [], failed: [] };
        try {
            await this.assertSavedRules();
            this.checkDestinations(changes);
            // Complete preflight before the first write. Any stale selected note rejects the run.
            for (const change of changes) {
                if (change.error) throw new Error(`${change.path}: ${change.error}`);
                const file = this.file(change.path);
                if (await fingerprint(await this.app.vault.read(file)) !== change.fingerprint) throw new Error(`${change.path} changed since preview. Preview again.`);
                if (!(await canAutomaticallyMutateViaGcm(this.app, file))) throw new Error(`${change.path} is now protected.`);
            }
            this.issuedPlans.delete(plan); // A partial run cannot replay stale instructions.
            for (const change of changes) {
                let propertiesApplied = false;
                try {
                    this.assertAvailable();
                    if (plan.signature !== this.signature()) throw new Error('Rules changed during application.');
                    const file = this.file(change.path);
                    const current = await this.app.vault.read(file);
                    if (await fingerprint(current) !== change.fingerprint) throw new Error('Note changed during application.');
                    if (!(await canAutomaticallyMutateViaGcm(this.app, file))) throw new Error('Note is now protected.');
                    this.checkDestinations([change]);
                    if (change.error) throw new Error(change.error);
                    if (!same(change.before, change.after)) await this.app.vault.process(file, content => {
                        this.assertAvailable();
                        if (content !== current || !canAutomaticallyMutateSourceViaGcm(this.app, content)) throw new Error('Note changed or became protected before write.');
                        return writeRuleNote(content, change.after);
                    });
                    propertiesApplied = !same(change.before, change.after);
                    if (change.nextPath !== change.path) {
                        this.assertAvailable();
                        const expected = propertiesApplied ? writeRuleNote(current, change.after) : current;
                        if (file.path !== change.path || await this.app.vault.read(file) !== expected) throw new Error('Note changed before rename. Preview again.');
                        await this.app.fileManager.renameFile(file, change.nextPath);
                    }
                    result.applied.push(change.nextPath);
                } catch (error) {
                    result.failed.push({ path: change.path, reason: `${propertiesApplied ? 'Properties saved; rename unfinished. ' : ''}${errorText(error)}` });
                }
            }
            return result;
        } finally { this.busy = false; }
    }
}
