import { App, Modal, Notice, Setting } from 'obsidian';
import { NOTE_RULE_ACTIONS, NOTE_RULE_OPERATORS, emptyNoteRules, validateNoteRules, type NoteRule, type NoteRuleAction, type NoteRuleCondition, type NoteRuleSettings } from './note-rules';
import { NoteRuleRunner, type NoteRulePlan, type NoteRuleScope } from './note-rule-runner';

function button(parent: HTMLElement, text: string, action: () => void, primary = false): HTMLButtonElement {
    const el = parent.createEl('button', { text, attr: { type: 'button' }, cls: primary ? 'mod-cta' : '' });
    el.setAttr('data-note-rule-focus', 'button-' + text.toLowerCase().replace(/[^a-z0-9]+/gu, '-'));
    el.addEventListener('click', action); return el;
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export class NoteRuleEditor {
    private draft: NoteRuleSettings;
    private baseline: string;
    private selected = '';
    private container: HTMLElement;
    private status: HTMLElement;
    private saving = false;
    constructor(private readonly read: () => NoteRuleSettings, private readonly save: (settings: NoteRuleSettings) => Promise<void>, private readonly preview: () => void, private readonly reload: () => Promise<void>) {
        this.reset();
    }
    private reset(): void { this.draft = clone(this.read() || emptyNoteRules()); this.baseline = JSON.stringify(this.read()); }
    private changed(): void { if (this.status) this.status.textContent = 'Unsaved changes'; }
    render(container: HTMLElement): void {
        this.container = container;
        const focus = container.ownerDocument.activeElement?.getAttribute('data-note-rule-focus');
        container.empty(); container.addClass('tps-controller-note-rules');
        container.createEl('h2', { text: 'Note rules' });
        container.createEl('p', { text: 'Run from a command. Preview changes before applying.' });
        if (this.draft.version !== 1 || !Array.isArray(this.draft.rules) || this.draft.rules.some(rule => !rule || !Array.isArray(rule.conditions) || !Array.isArray(rule.actions))) { container.createEl('p', { text: 'Rules configuration is unsupported or damaged. It has been preserved.' }); return; }
        const toolbar = container.createDiv({ cls: 'tps-controller-rule-toolbar' });
        button(toolbar, 'Add rule', () => {
            const rule: NoteRule = { id: crypto.randomUUID(), name: 'New rule', enabled: true, match: 'all', conditions: [{ field: 'property:type', operator: 'equals', value: '' }], actions: [{ kind: 'title', key: '', value: '' }], stop: false };
            this.draft.rules.push(rule); this.selected = rule.id; this.render(container); this.changed();
            container.querySelector<HTMLInputElement>('[data-note-rule-focus="rule-name"]')?.focus();
        });
        const saveButton = button(toolbar, 'Save rules', () => { void (async () => {
            if (this.saving) return;
            this.saving = true; saveButton.disabled = true;
            try {
                validateNoteRules(this.draft);
                if (JSON.stringify(this.read()) !== this.baseline) throw new Error('Rules changed elsewhere. Reload saved rules before editing.');
                await this.save(clone(this.draft)); this.baseline = JSON.stringify(this.read()); this.status.textContent = JSON.stringify(this.draft) === this.baseline ? 'Saved' : 'Unsaved changes';
            } catch (error) { this.status.textContent = message(error); }
            finally { this.saving = false; saveButton.disabled = false; }
        })(); }, true);
        saveButton.disabled = this.saving;
        button(toolbar, 'Reload saved rules', () => { void this.reload().then(() => { this.reset(); this.render(container); }).catch(error => { this.status.textContent = message(error); }); });
        button(toolbar, 'Preview saved rules', this.preview);
        this.status = container.createDiv({ cls: 'tps-controller-rule-status', attr: { role: 'status', 'aria-live': 'polite' } });
        if (JSON.stringify(this.draft) !== this.baseline) this.changed();
        const list = container.createDiv({ cls: 'tps-controller-rule-list', attr: { role: 'group', 'aria-label': 'Rules in execution order' } });
        for (const [index, rule] of this.draft.rules.entries()) {
            const row = list.createDiv({ cls: 'tps-controller-rule-card' });
            const select = button(row, `${index + 1}. ${rule.name || 'Untitled rule'}${rule.enabled ? '' : ' · Off'}`, () => { this.selected = rule.id; this.render(container); container.querySelector<HTMLInputElement>('[data-note-rule-focus="rule-name"]')?.focus(); });
            select.setAttr('aria-pressed', String(this.selected === rule.id));
            for (const [label, offset] of [['Move up', -1], ['Move down', 1]] as const) {
                const move = button(row, label, () => { const other = index + offset; [this.draft.rules[index], this.draft.rules[other]] = [this.draft.rules[other], this.draft.rules[index]]; this.render(container); this.changed(); });
                move.disabled = index + offset < 0 || index + offset >= this.draft.rules.length;
                move.setAttr('aria-label', `${label}: ${rule.name}`);
                move.setAttr('data-note-rule-focus', `move-${offset}-${rule.id}`);
            }
        }
        const rule = this.draft.rules.find(rule => rule.id === this.selected);
        if (!rule) { if (!this.draft.rules.length) container.createEl('p', { text: 'No rules yet.' }); return; }
        const editor = container.createDiv({ cls: 'tps-controller-rule-editor' });
        new Setting(editor).setName('Rule name').addText(text => {
            text.setValue(rule.name).onChange(value => { rule.name = value; this.changed(); });
            text.inputEl.setAttr('data-note-rule-focus', 'rule-name');
            text.inputEl.setAttr('aria-label', 'Rule name');
        });
        new Setting(editor).setName('Enabled').addToggle(toggle => toggle.setValue(rule.enabled).onChange(value => { rule.enabled = value; this.changed(); }));
        new Setting(editor).setName('Match').addDropdown(drop => drop.addOptions({ all: 'All conditions', any: 'Any condition' }).setValue(rule.match).onChange(value => { rule.match = value as 'all' | 'any'; this.changed(); }));
        button(editor, 'Add condition', () => { rule.conditions.push({ field: 'name', operator: 'contains', value: '' }); this.render(container); this.changed(); });
        const conditions = editor.createDiv({ cls: 'tps-controller-rule-conditions' });
        rule.conditions.forEach((condition, index) => this.condition(conditions, rule, condition, index));
        editor.createEl('h3', { text: 'Then' });
        button(editor, 'Add action', () => { rule.actions.push({ kind: 'add-tag', key: '', value: '' }); this.render(container); this.changed(); });
        const actions = editor.createDiv({ cls: 'tps-controller-rule-actions' });
        rule.actions.forEach((action, index) => this.action(actions, rule, action, index));
        new Setting(editor).setName('Stop after this rule matches').addToggle(toggle => toggle.setValue(rule.stop).onChange(value => { rule.stop = value; this.changed(); }));
        button(editor, 'Delete rule', () => { this.draft.rules = this.draft.rules.filter(candidate => candidate !== rule); this.selected = ''; this.render(container); this.changed(); });
        if (focus) Array.from(container.querySelectorAll<HTMLElement>('[data-note-rule-focus]')).find(element => element.getAttribute('data-note-rule-focus') === focus)?.focus();
    }
    private text(parent: HTMLElement, value: string, label: string, update: (value: string) => void): HTMLInputElement {
        const input = parent.createEl('input', { attr: { type: 'text', 'aria-label': label, placeholder: label } });
        input.value = value; input.addEventListener('input', () => { update(input.value); this.changed(); }); return input;
    }
    private condition(parent: HTMLElement, rule: NoteRule, condition: NoteRuleCondition, index: number): void {
        const row = parent.createDiv({ cls: 'tps-controller-rule-fields' });
        const field = row.createEl('select', { attr: { 'aria-label': `Condition ${index + 1} field`, 'data-note-rule-focus': `condition-${index}` } });
        const options = { name: 'Note name', title: 'Title property', path: 'Note path', calendar: 'Calendar source ID', property: 'Property' };
        for (const [value, label] of Object.entries(options)) field.createEl('option', { text: label, value });
        field.value = condition.field.startsWith('property:') ? 'property' : condition.field;
        field.addEventListener('change', () => { condition.field = field.value === 'property' ? 'property:type' : field.value; this.render(this.container); this.changed(); });
        if (field.value === 'property') this.text(row, condition.field.slice(9), 'Property name', value => { condition.field = `property:${value}`; });
        const operator = row.createEl('select', { attr: { 'aria-label': `Condition ${index + 1} comparison`, 'data-note-rule-focus': `operator-${index}` } });
        for (const [value, text] of Object.entries(NOTE_RULE_OPERATORS)) operator.createEl('option', { value, text });
        operator.value = condition.operator;
        operator.addEventListener('change', () => { condition.operator = operator.value as NoteRuleCondition['operator']; this.render(this.container); this.changed(); });
        if (!['exists', 'missing'].includes(condition.operator)) this.text(row, condition.value, 'Match value', value => { condition.value = value; });
        button(row, 'Remove', () => { rule.conditions.splice(index, 1); this.render(this.container); this.changed(); }).setAttr('aria-label', `Remove condition ${index + 1}`);
    }
    private action(parent: HTMLElement, rule: NoteRule, action: NoteRuleAction, index: number): void {
        const row = parent.createDiv({ cls: 'tps-controller-rule-fields' });
        const select = row.createEl('select', { attr: { 'aria-label': `Action ${index + 1}`, 'data-note-rule-focus': `action-${index}` } });
        for (const [value, text] of Object.entries(NOTE_RULE_ACTIONS)) select.createEl('option', { value, text });
        select.value = action.kind;
        select.addEventListener('change', () => { action.kind = select.value as NoteRuleAction['kind']; this.render(this.container); this.changed(); });
        if (action.kind.endsWith('property') || action.kind === 'replace-title') this.text(row, action.key, action.kind === 'replace-title' ? 'Find text (case-sensitive)' : 'Property name', value => { action.key = value; });
        if (action.kind !== 'remove-property') this.text(row, action.value, action.kind.endsWith('tag') ? 'Tag' : 'New value', value => { action.value = value; });
        button(row, 'Remove', () => { rule.actions.splice(index, 1); this.render(this.container); this.changed(); }).setAttr('aria-label', `Remove action ${index + 1}`);
    }
}

export class NoteRulePreviewModal extends Modal {
    private plan: NoteRulePlan | null = null;
    private selected = new Set<string>();
    private opened = false;
    private results: HTMLElement;
    private status: HTMLElement;
    private applyButton: HTMLButtonElement;
    private previewButton: HTMLButtonElement;
    constructor(app: App, private readonly runner: NoteRuleRunner, private noteScope: NoteRuleScope) { super(app); }
    onOpen(): void {
        this.opened = true;
        this.modalEl.addClass('tps-controller-rule-modal');
        this.contentEl.createEl('h2', { text: 'Run note rules' });
        const controls = this.contentEl.createDiv({ cls: 'tps-controller-rule-toolbar' });
        const current = this.app.workspace.getActiveFile();
        const select = controls.createEl('select', { attr: { 'aria-label': 'Notes to preview' } });
        for (const [value, text] of Object.entries({ note: 'Current note', folder: 'Folder', vault: 'Entire vault' })) select.createEl('option', { value, text });
        select.value = this.noteScope.kind;
        const folder = controls.createEl('input', { attr: { type: 'text', placeholder: 'Folder path (empty = vault root)', 'aria-label': 'Folder path' } });
        folder.value = this.noteScope.kind === 'folder' ? this.noteScope.path : current?.parent?.path || '';
        if (folder.value === '/') folder.value = '';
        folder.hidden = this.noteScope.kind !== 'folder';
        const invalidate = () => { this.plan = null; this.results?.empty(); if (this.applyButton) this.applyButton.disabled = true; };
        select.addEventListener('change', () => { this.noteScope = select.value === 'vault' ? { kind: 'vault' } : select.value === 'folder' ? { kind: 'folder', path: folder.value } : { kind: 'note', path: current?.path || '' }; folder.hidden = this.noteScope.kind !== 'folder'; invalidate(); });
        folder.addEventListener('input', () => { this.noteScope = { kind: 'folder', path: folder.value }; invalidate(); });
        this.previewButton = button(controls, 'Preview', () => { void this.preview(); }, true);
        this.applyButton = button(controls, 'Apply selected', () => { void this.apply(); }); this.applyButton.disabled = true;
        this.status = this.contentEl.createDiv({ attr: { role: 'status', 'aria-live': 'polite' } });
        this.results = this.contentEl.createDiv({ cls: 'tps-controller-rule-results' });
        void this.preview();
    }
    onClose(): void { this.opened = false; }
    private async preview(): Promise<void> {
        this.previewButton.disabled = true; this.applyButton.disabled = true;
        this.plan = null; this.results.empty(); this.status.textContent = 'Scanning…';
        const scope = { ...this.noteScope };
        try {
            const plan = await this.runner.preview(scope, count => { if (this.opened) this.status.textContent = `Scanned ${count} notes…`; });
            if (!this.opened) return;
            if (JSON.stringify(scope) !== JSON.stringify(this.noteScope)) { this.status.textContent = 'Scope changed. Preview again.'; return; }
            this.plan = plan; this.selected = new Set(plan.changes.filter(change => !change.error).map(change => change.path));
            this.status.textContent = `${plan.changes.length} changed · ${plan.scanned} scanned · ${plan.skipped.length} skipped`;
            this.renderResults();
        } catch (error) { if (this.opened) this.status.textContent = message(error); }
        finally { this.previewButton.disabled = false; }
    }
    private renderResults(): void {
        this.results.empty(); if (!this.plan) return;
        const toolbar = this.results.createDiv({ cls: 'tps-controller-rule-toolbar' });
        button(toolbar, 'Select all', () => { this.selected = new Set(this.plan!.changes.filter(change => !change.error).map(change => change.path)); this.renderResults(); });
        button(toolbar, 'Select none', () => { this.selected.clear(); this.renderResults(); });
        const list = this.results.createDiv();
        let shown = 0;
        const showMore = button(this.results, 'Show more', () => append());
        const append = () => {
            const end = Math.min(shown + 50, this.plan!.changes.length);
            for (const change of this.plan!.changes.slice(shown, end)) {
                const card = list.createDiv({ cls: 'tps-controller-rule-preview-card' });
                const label = card.createEl('label');
                const check = label.createEl('input', { attr: { type: 'checkbox' } });
                check.checked = this.selected.has(change.path); check.disabled = !!change.error;
                label.createSpan({ text: change.path });
                check.addEventListener('change', () => { if (check.checked) this.selected.add(change.path); else this.selected.delete(change.path); this.updateApply(); });
                if (change.nextPath !== change.path) card.createEl('p', { text: `→ ${change.nextPath}` });
                for (const key of new Set([...Object.keys(change.before), ...Object.keys(change.after)])) {
                    if (JSON.stringify(change.before[key]) === JSON.stringify(change.after[key])) continue;
                    card.createDiv({ text: `${key}: ${JSON.stringify(change.before[key]) ?? '—'} → ${JSON.stringify(change.after[key]) ?? 'removed'}` });
                }
                if (change.error) card.createDiv({ text: change.error, cls: 'tps-controller-rule-error' });
            }
            shown = end; showMore.hidden = shown === this.plan!.changes.length;
        };
        append();
        if (this.plan.skipped.length) {
            const details = this.results.createEl('details');
            details.createEl('summary', { text: 'Skipped notes' });
            for (const item of this.plan.skipped) details.createDiv({ text: `${item.path}: ${item.reason}` });
        }
        this.updateApply();
    }
    private updateApply(): void { this.applyButton.textContent = `Apply ${this.selected.size} ${this.selected.size === 1 ? 'note' : 'notes'}`; this.applyButton.disabled = !this.selected.size; }
    private async apply(): Promise<void> {
        if (!this.plan) return;
        this.applyButton.disabled = true; this.previewButton.disabled = true;
        try {
            const result = await this.runner.apply(this.plan, this.selected);
            this.plan = null;
            const summary = `${result.applied.length} applied · ${result.failed.length} unfinished`;
            if (!this.opened) { new Notice(summary); return; }
            this.status.textContent = summary; this.results.empty();
            for (const failure of result.failed) this.results.createDiv({ text: `${failure.path}: ${failure.reason}` });
        } catch (error) { if (this.opened) this.status.textContent = message(error); }
        finally { this.previewButton.disabled = false; }
    }
}
