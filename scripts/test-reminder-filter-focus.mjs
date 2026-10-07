import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// Actual settings renderer, with only Obsidian controls/DOM replaced by a bounded facade.
let activeElement = null;
class Element {
    constructor(tag = 'div', options = {}) {
        this.tag = tag; this.className = options.cls || ''; this.textContent = options.text || '';
        this.children = []; this.dataset = {}; this.style = {}; this.listeners = {};
        this.attributes = {}; this.parent = null; this.value = ''; this.open = false;
        this.selectionStart = 0; this.selectionEnd = 0; this.empties = 0;
    }
    all() { return [this, ...this.children.flatMap(child => child.all())]; }
    createEl(tag, options) { const child = new Element(tag, options); child.parent = this; this.children.push(child); return child; }
    createDiv(options) { return this.createEl('div', options); }
    createSpan(options) { return this.createEl('span', options); }
    setAttr(key, value) { this.attributes[key] = value; if (key === 'open') this.open = true; }
    addEventListener(key, handler) { (this.listeners[key] ||= []).push(handler); }
    dispatch(key) { for (const handler of this.listeners[key] || []) handler({ preventDefault() {}, stopPropagation() {} }); }
    focus() { activeElement = this; }
    empty() {
        if (this.children.some(child => child.all().includes(activeElement))) activeElement = null;
        this.children = []; this.empties++;
    }
    querySelectorAll(selector) {
        const [tag, cls] = selector.split('.');
        return this.all().slice(1).filter(el => (!tag || el.tag === tag) && (!cls || el.className.split(' ').includes(cls)));
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}
class Setting {
    constructor(parent) { parent.createDiv({ cls: 'setting-item' }); }
    setName() { return this; } setDesc() { return this; }
    // Field callbacks are not entered: filtering never changes their values or calls providers.
    addText() { return this; } addToggle() { return this; } addDropdown() { return this; } addButton() { return this; }
}
const obsidian = new Proxy({ Setting, PluginSettingTab: class {}, normalizePath: path => path }, {
    get(target, key) { return target[key] || class {}; },
});
const baseline = process.env.TPS_FILTER_BASELINE === '1';
const entry = fileURLToPath(new URL('../src/settings-tab.ts', import.meta.url));
const output = await build({
    ...(baseline ? { stdin: { contents: execFileSync('git', ['show', '3.1.6:src/settings-tab.ts'], { encoding: 'utf8' }), loader: 'ts', resolveDir: fileURLToPath(new URL('../src/', import.meta.url)) } } : { entryPoints: [entry] }),
    bundle: true, write: false, format: 'cjs', platform: 'node', external: ['obsidian'], logLevel: 'silent',
});
const module = { exports: {} };
const require = createRequire(import.meta.url);
new Function('module', 'exports', 'require', output.outputFiles[0].text)(module, module.exports, id => {
    return id === 'obsidian' ? obsidian : require(id);
});
const rules = () => [
    { id: 'morning', label: 'Morning', property: 'scheduled', enabled: true, offsetMinutes: -15, requiredStatuses: ['active'], requiredPaths: ['Inbox'] },
    { id: 'finish', label: 'Finished', property: 'completedDate', enabled: false, offsetMinutes: 0 },
];
function fixture() {
    const tab = Object.create(module.exports.TPSControllerSettingTab.prototype);
    const stats = { saves: 0, loops: 0 };
    tab.plugin = { settings: { reminders: rules() }, saveSettings() { stats.saves++; }, restartReminderLoop() { stats.loops++; } };
    tab.reminderRuleFilterQuery = ''; tab.reminderRuleViewState = new Map();
    const root = new Element(); tab.renderReminderRules(root);
    return { tab, root, stats, input: root.querySelector('.tps-reminder-rules-filter') };
}

test('a typing burst keeps the same input, selection, toolbar and listeners mounted', () => {
    const { root, input, stats } = fixture();
    input.focus(); const toolbar = root.querySelector('.tps-reminder-rules-toolbar'); const initialEmpties = root.empties;
    for (const query of ['m', 'mo', 'mor', 'morn', 'morning']) {
        input.value = query; input.selectionStart = input.selectionEnd = query.length; input.dispatch('input');
        assert.equal(root.querySelector('.tps-reminder-rules-filter'), input);
        assert.equal(activeElement, input); assert.equal(input.selectionStart, query.length);
        assert.equal(root.querySelector('.tps-reminder-rules-toolbar'), toolbar);
    }
    assert.equal(root.empties, initialEmpties); assert.equal(input.listeners.input.length, 1);
    assert.equal(root.querySelectorAll('details.tps-controller-reminder-rule').length, 1);
    assert.deepEqual(stats, { saves: 0, loops: 0 });
    assert.equal(input.attributes['aria-label'], 'Filter reminder rules');
});

test('composition, a no-match query and clearing never detach the filter', () => {
    const { root, input } = fixture(); input.focus();
    for (const query of ['日', '日本', 'no-match', '']) {
        input.value = query; input.dispatch('input'); assert.equal(activeElement, input);
        assert.equal(root.querySelector('.tps-reminder-rules-filter'), input);
        assert.equal(root.querySelectorAll('details.tps-controller-reminder-rule').length, query ? 0 : 2);
    }
});

test('filter fields and rule disclosure state survive results replacement', () => {
    const { tab, root, input } = fixture();
    const morning = root.querySelectorAll('details.tps-controller-reminder-rule')[0];
    morning.open = true; morning.dispatch('toggle');
    for (const query of ['Inbox', 'active', 'scheduled', 'rule 1']) {
        input.value = query; input.dispatch('input');
        const current = root.querySelectorAll('details.tps-controller-reminder-rule');
        assert.equal(current.length, 1); assert.equal(current[0].dataset.ruleId, 'morning'); assert.equal(current[0].open, true);
    }
    assert.equal(tab.reminderRuleViewState.get('morning'), true);
});

test('empty rule list and a later added rule retain existing empty-state behavior', () => {
    const { tab, root } = fixture(); tab.plugin.settings.reminders = [];
    tab.renderReminderRules(root); assert.equal(root.querySelector('.tps-reminder-rules-filter'), null);
    assert.equal(root.children[0].textContent, 'No reminder rules configured.');
    tab.plugin.settings.reminders = rules(); tab.renderReminderRules(root);
    assert.equal(root.children.some(el => el.textContent === 'No reminder rules configured.'), false);
    assert.equal(root.querySelectorAll('.tps-reminder-rules-filter').length, 1);
    assert.equal(root.querySelectorAll('details.tps-controller-reminder-rule').length, 2);
});
