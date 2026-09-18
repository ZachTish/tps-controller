/** Pure, command-only rule evaluation. Never observes or mutates the vault. */
export type RuleValue = string | number | boolean | string[];
export type RuleOperator = 'equals' | 'not-equals' | 'contains' | 'not-contains' | 'starts-with' | 'ends-with' | 'exists' | 'missing' | 'greater' | 'less';
export interface NoteRuleCondition { field: string; operator: RuleOperator; value: string; }
export interface NoteRuleAction { kind: 'title' | 'replace-title' | 'set-property' | 'remove-property' | 'add-tag' | 'remove-tag'; key: string; value: string; }
export interface NoteRule {
    id: string; name: string; enabled: boolean; match: 'all' | 'any';
    conditions: NoteRuleCondition[]; actions: NoteRuleAction[]; stop: boolean;
}
export interface NoteRuleSettings { version: 1; rules: NoteRule[]; legacyCalendarTagsMigrated?: boolean; }
export interface NoteRuleInput {
    name: string; path: string; title: string; calendar: string;
    properties: Record<string, unknown>; protectedKeys: string[]; protectedTagPrefixes?: string[];
}
export interface NoteRuleResult { title: string; rename: boolean; updates: Record<string, RuleValue>; removals: string[]; matched: string[]; }
export const emptyNoteRules = (): NoteRuleSettings => ({ version: 1, rules: [] });
export const NOTE_RULE_OPERATORS: Record<RuleOperator, string> = {
    equals: 'is', 'not-equals': 'is not', contains: 'contains', 'not-contains': 'does not contain',
    'starts-with': 'starts with', 'ends-with': 'ends with', exists: 'has a value', missing: 'is empty', greater: 'is greater than', less: 'is less than',
};
export const NOTE_RULE_ACTIONS: Record<NoteRuleAction['kind'], string> = {
    title: 'Set title and filename', 'replace-title': 'Replace text in title and filename',
    'set-property': 'Set property', 'remove-property': 'Remove property', 'add-tag': 'Add tag', 'remove-tag': 'Remove tag',
};
const reserved = new Set(['__proto__', 'prototype', 'constructor', 'tpsid', 'id', 'externalid', 'financeid', 'financeaccountid', 'providerid', 'sourceid', 'tpsschemaversion', 'financesecurityid', 'financeholdingid', 'providertransactionid', 'provideraccountid', 'providersecurityid', 'providerholdingid']);
function fail(message: string): never { throw new Error(`Note rules: ${message}`); }
export function validRuleKey(key: string): boolean {
    return /^[\p{L}_][\p{L}\p{N}_ /-]{0,79}$/u.test(key) && !reserved.has(key.toLowerCase());
}
export function validateNoteRules(settings: NoteRuleSettings): void {
    if (!settings || settings.version !== 1 || !Array.isArray(settings.rules)) fail('unsupported or damaged configuration.');
    if (settings.rules.length > 100) fail('use at most 100 rules.');
    const ids = new Set<string>();
    for (const rule of settings.rules) {
        if (!rule || typeof rule.id !== 'string' || !rule.id || ids.has(rule.id) || typeof rule.enabled !== 'boolean') fail('rule IDs must be unique.');
        ids.add(rule.id);
        if (!rule.enabled) continue;
        if (!['all', 'any'].includes(rule.match) || typeof rule.stop !== 'boolean') fail('invalid matching options.');
        if (!Array.isArray(rule.conditions) || !rule.conditions.length || rule.conditions.length > 30 || !Array.isArray(rule.actions) || !rule.actions.length || rule.actions.length > 30) fail('each enabled rule needs 1–30 conditions and actions.');
        for (const condition of rule.conditions) {
            if (!condition || typeof condition.field !== 'string' || !condition.field.trim() || condition.field.length > 100 || !Object.prototype.hasOwnProperty.call(NOTE_RULE_OPERATORS, condition.operator) || typeof condition.value !== 'string' || condition.value.length > 4000) fail('invalid condition.');
            if (condition.field.startsWith('property:') && !condition.field.slice(9).trim()) fail('choose a property name.');
            if (['greater', 'less'].includes(condition.operator) && (!condition.value.trim() || !Number.isFinite(Number(condition.value)))) fail('numeric conditions need a number.');
        }
        for (const action of rule.actions) {
            if (!action || !Object.prototype.hasOwnProperty.call(NOTE_RULE_ACTIONS, action.kind) || typeof action.key !== 'string' || typeof action.value !== 'string' || action.value.length > 4000) fail('invalid action.');
            if (action.kind.endsWith('property') && (!validRuleKey(action.key) || ['title', 'tags'].includes(action.key.toLowerCase()))) fail('use a custom property, or the title/tag action. IDs cannot be changed.');
            if (action.kind === 'title' && !action.value.trim()) fail('a title cannot be empty.');
            if (action.kind === 'replace-title' && !action.key) fail('title replacement needs text to find.');
            if (action.kind.endsWith('tag') && !/^#?[\p{L}\p{N}_/-]+$/u.test(action.value)) fail('enter one tag without spaces.');
            if (action.kind === 'set-property') parseRuleValue(action.value);
        }
    }
}
export function parseRuleValue(text: string): RuleValue {
    let value: unknown = text;
    if (/^(?:\[|\{|"|true$|false$|null$|-?\d)/u.test(text.trim())) {
        try { value = JSON.parse(text); } catch { value = text; }
    }
    if (typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) || (Array.isArray(value) && value.length <= 100 && value.every(item => typeof item === 'string'))) return value as RuleValue;
    return fail('values must be text, a number, true/false, or a JSON list of text.');
}
export function ruleProperty(fields: Record<string, unknown>, key: string): unknown {
    const found = Object.keys(fields).find(candidate => candidate.toLowerCase() === key.toLowerCase());
    return found ? fields[found] : undefined;
}
function matches(condition: NoteRuleCondition, input: NoteRuleInput): boolean {
    const special: Record<string, string> = { name: input.name, path: input.path, title: input.title, calendar: input.calendar };
    const raw = Object.prototype.hasOwnProperty.call(special, condition.field) ? special[condition.field] : ruleProperty(input.properties, condition.field.replace(/^property:/u, ''));
    const absent = raw == null || raw === '' || (Array.isArray(raw) && !raw.length);
    if (condition.operator === 'exists') return !absent;
    if (condition.operator === 'missing') return absent;
    if (absent) return false;
    if (condition.operator === 'greater' || condition.operator === 'less') {
        if (typeof raw !== 'number' && (typeof raw !== 'string' || !raw.trim())) return false;
        const value = Number(raw); if (!Number.isFinite(value)) return false;
        return condition.operator === 'greater' ? value > Number(condition.value) : value < Number(condition.value);
    }
    const values = (Array.isArray(raw) ? raw : [raw]).map(value => String(value).toLowerCase());
    const target = condition.value.toLowerCase();
    switch (condition.operator) {
        case 'equals': return values.some(value => value === target);
        case 'not-equals': return values.every(value => value !== target);
        case 'contains': return values.some(value => value.includes(target));
        case 'not-contains': return values.every(value => !value.includes(target));
        case 'starts-with': return values.some(value => value.startsWith(target));
        case 'ends-with': return values.some(value => value.endsWith(target));
    }
    return false;
}
/** A run captures rules once. Conditions always see the original note; later actions win. */
export function createNoteRuleSession(settings: NoteRuleSettings | undefined): { evaluate(input: NoteRuleInput): NoteRuleResult } {
    const snapshot = JSON.parse(JSON.stringify(settings || emptyNoteRules())) as NoteRuleSettings;
    validateNoteRules(snapshot);
    return { evaluate(input) {
        const result: NoteRuleResult = { title: input.title, rename: false, updates: Object.create(null), removals: [], matched: [] };
        const protectedKeys = new Set([...reserved, ...input.protectedKeys.map(key => key.toLowerCase())]);
        const storedTags = ruleProperty(input.properties, 'tags');
        let tags = (Array.isArray(storedTags) ? storedTags : typeof storedTags === 'string' ? storedTags.split(/[ ,]+/u) : []).map(String).map(tag => tag.replace(/^#/u, '')).filter(Boolean);
        for (const rule of snapshot.rules) {
            if (!rule.enabled) continue;
            const tests = rule.conditions.map(condition => matches(condition, input));
            if (!(rule.match === 'all' ? tests.every(Boolean) : tests.some(Boolean))) continue;
            result.matched.push(rule.id);
            for (const action of rule.actions) {
                if (action.kind.endsWith('property') && protectedKeys.has(action.key.toLowerCase())) fail(`“${rule.name}” targets a protected property (${action.key}).`);
                const candidates = [...Object.keys(input.properties), ...Object.keys(result.updates), ...result.removals];
                const key = candidates.find(key => key.toLowerCase() === action.key.toLowerCase()) || action.key;
                if (action.kind === 'title') { result.title = action.value.trim(); result.rename = true; }
                if (action.kind === 'replace-title') { result.title = result.title.split(action.key).join(action.value).trim(); result.rename = true; }
                if (action.kind === 'set-property') { result.updates[key] = parseRuleValue(action.value); result.removals = result.removals.filter(candidate => candidate !== key); }
                if (action.kind === 'remove-property') { delete result.updates[key]; if (!result.removals.includes(key)) result.removals.push(key); }
                if (action.kind === 'add-tag' || action.kind === 'remove-tag') {
                    if ((storedTags != null && !Array.isArray(storedTags) && typeof storedTags !== 'string') || (Array.isArray(storedTags) && storedTags.some(tag => typeof tag !== 'string'))) fail('existing tags have an unsupported value.');
                    const tag = action.value.replace(/^#/u, '');
                    if (['tps/record', ...(input.protectedTagPrefixes || [])].some(prefix => tag.toLowerCase().startsWith(prefix.replace(/^#|\/$/gu, '').toLowerCase() + '/'))) fail('record identity tags cannot be changed.');
                    if (action.kind === 'add-tag' && !tags.some(value => value.toLowerCase() === tag.toLowerCase())) tags.push(tag);
                    if (action.kind === 'remove-tag') tags = tags.filter(value => value.toLowerCase() !== tag.toLowerCase());
                    result.updates.tags = [...tags];
                }
            }
            if (rule.stop) break;
        }
        if (result.rename) validateNoteTitle(result.title);
        return result;
    } };
}
export function validateNoteTitle(title: string): void {
    if (!title || title.length > 180 || new TextEncoder().encode(title).byteLength > 240 || /[\\/:*?"<>|\x00-\x1f]/u.test(title) || /[. ]$/u.test(title) || title.startsWith('.') || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(title)) fail('the resulting filename is empty or unsafe.');
}
export function applyNoteRuleResult(properties: Record<string, unknown>, result: NoteRuleResult, titleKey: string): Record<string, unknown> {
    const output = { ...properties };
    const updates: Record<string, unknown> = { ...result.updates, ...(result.rename ? { [titleKey]: result.title } : {}) };
    for (const [key, value] of Object.entries(updates)) {
        for (const existing of Object.keys(output)) if (existing.toLowerCase() === key.toLowerCase()) delete output[existing];
        output[key] = value;
    }
    for (const key of result.removals) for (const existing of Object.keys(output)) if (existing.toLowerCase() === key.toLowerCase()) delete output[existing];
    return output;
}
export function migrateCalendarTagRules(settings: NoteRuleSettings | undefined, calendars: Array<{id: string; autoCreateTag?: string}>): NoteRuleSettings {
    const next = JSON.parse(JSON.stringify(settings || emptyNoteRules())) as NoteRuleSettings;
    validateNoteRules(next);
    if (next.legacyCalendarTagsMigrated) return next;
    for (const calendar of calendars) {
        const tag = String(calendar.autoCreateTag || '').trim().replace(/^#/u, '');
        if (!tag) continue;
        const id = `calendar-tag:${calendar.id}`;
        if (!next.rules.some(rule => rule.id === id)) {
            const migrated: NoteRule = { id, name: `Calendar tag · ${tag}`, enabled: true, match: 'all', conditions: [{ field: 'calendar', operator: 'equals', value: calendar.id }], actions: tag.split(/[ ,]+/u).filter(Boolean).map(value => ({ kind: 'add-tag', key: '', value })), stop: false };
            try { validateNoteRules({ version: 1, rules: [migrated] }); }
            catch { migrated.enabled = false; migrated.name += ' (review)'; }
            next.rules.push(migrated);
        }
    }
    validateNoteRules(next);
    next.legacyCalendarTagsMigrated = true;
    return next;
}
