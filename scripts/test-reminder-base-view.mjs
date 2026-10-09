import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { load as parseYaml } from 'js-yaml';

const source = readFileSync(new URL('../src/services/reminder-base-view-service.ts', import.meta.url), 'utf8');

class TFile {
    constructor(path) {
        this.path = path;
        this.extension = path.split('.').at(-1);
    }
}

function loadService() {
    const compiled = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018 },
    });
    const module = { exports: {} };
    new Function('module', 'exports', 'require', compiled.outputText)(module, module.exports, (id) => {
        if (id === 'obsidian') return {
            TFile,
            parseYaml,
            normalizePath: (path) => path.replace(/\\/gu, '/').replace(/\/{2,}/gu, '/'),
        };
        throw new Error(`Unexpected dependency: ${id}`);
    });
    return module.exports;
}

const service = loadService();
const base = (views = [{ type: 'table', name: 'Due', filters: 'status != "done"' }], extra = {}) => ({ views, ...extra });
const reminder = (extra = {}) => ({
    id: 'reminder', enabled: true, property: 'scheduled', selectionMode: 'base-view',
    basePath: 'Tasks.base', baseView: 'Due', offsetMinutes: 5, ...extra,
});

function makeApp({ definitions = { 'Tasks.base': base() }, notes = ['Inbox/Task.md'], outputs = {}, queryError, capability = true } = {}) {
    const files = new Map();
    const sources = new Map();
    for (const [path, definition] of Object.entries(definitions)) {
        files.set(path, new TFile(path));
        sources.set(path, typeof definition === 'string' ? definition : JSON.stringify(definition));
    }
    for (const path of notes) files.set(path, new TFile(path));
    const reads = [];
    const queries = [];
    const app = {
        vault: {
            getAbstractFileByPath(path) { return files.get(path) ?? null; },
            async cachedRead(file) {
                reads.push(file.path);
                assert.equal(file.extension, 'base', 'Base membership must never read a Markdown body');
                if (!sources.has(file.path)) throw new Error('Unreadable fixture');
                return sources.get(file.path);
            },
        },
    };
    if (capability) app.cli = {
        handlers: new Map([['base:query', {
            async handler(parameters) {
                queries.push(parameters);
                // Core's query implementation reads its Base definition once.
                await app.vault.cachedRead(files.get(parameters.path));
                if (queryError) throw queryError;
                const key = `${parameters.path}#${parameters.view}`;
                return Object.hasOwn(outputs, key) ? outputs[key] : notes.join('\n');
            },
        }]]),
    };
    return { app, files, reads, queries };
}

test('ordinary reminder selection remains unchanged and needs no Bases capability', async () => {
    const rule = reminder({ selectionMode: 'rules', requiredStatuses: ['open'] });
    const { app, reads, queries } = makeApp({ capability: false });
    assert.equal(service.isBaseViewReminder(rule), false);
    assert.equal(service.getReminderMatchingPolicy(rule), rule);
    assert.equal(service.reminderMatchesBaseView(rule, 'external-event', '', new Map()), true);
    assert.deepEqual([...await service.resolveReminderBaseViews(app, [rule])], []);
    assert.deepEqual(reads, []);
    assert.deepEqual(queries, []);
});

test('Base membership replaces only manual selection fields and does not mutate saved settings', () => {
    const rule = reminder({
        requiredStatuses: ['open'], requiredPaths: ['Inbox'], ignorePaths: ['Archive'],
        ignoreTags: ['quiet'], ignoreStatuses: ['done'], stopConditions: ['status=done'],
        repeatUntilComplete: true, allDayFilter: 'false', sourceTypes: ['file'],
        smartOffsetProperty: 'travel', requiredCheckboxStates: [' '],
    });
    const copy = structuredClone(rule);
    const policy = service.getReminderMatchingPolicy(rule);
    for (const key of ['requiredStatuses', 'requiredPaths', 'ignorePaths', 'ignoreTags', 'ignoreStatuses']) {
        assert.equal(Object.hasOwn(policy, key), false);
    }
    for (const key of ['property', 'offsetMinutes', 'stopConditions', 'repeatUntilComplete', 'allDayFilter', 'sourceTypes', 'smartOffsetProperty', 'requiredCheckboxStates']) {
        assert.deepEqual(policy[key], rule[key], `${key} must retain its configured behavior`);
    }
    assert.deepEqual(rule, copy);
});

test('same saved view is queried once per run, including normalized path aliases', async () => {
    const { app, reads, queries } = makeApp({ definitions: { 'Folder/Tasks.base': base() } });
    const rules = [
        reminder({ id: 'one', basePath: ' Folder//Tasks.base ' }),
        reminder({ id: 'two', basePath: 'Folder/Tasks.base' }),
        reminder({ id: 'disabled', enabled: false, basePath: '../invalid.base' }),
    ];
    const memberships = await service.resolveReminderBaseViews(app, rules);
    assert.equal(queries.length, 1);
    assert.deepEqual(queries[0], { path: 'Folder/Tasks.base', view: 'Due', format: 'paths' });
    assert.deepEqual(reads, ['Folder/Tasks.base', 'Folder/Tasks.base']);
    assert.equal(memberships.get('one'), memberships.get('two'));
    assert.equal(memberships.has('disabled'), false);
    assert.equal(service.reminderMatchesBaseView(rules[0], 'file', 'Inbox/Task.md', memberships), true);
    assert.equal(service.reminderMatchesBaseView(rules[0], 'file', 'Inbox/Other.md', memberships), false);
    assert.equal(service.reminderMatchesBaseView(rules[0], 'external-event', 'Inbox/Task.md', memberships), false);
    assert.equal(service.reminderMatchesBaseView(rules[0], 'file', 'Inbox/Task.md', new Map()), false);
    await service.resolveReminderBaseViews(app, rules);
    assert.equal(queries.length, 2, 'there is no persistent cross-run membership cache');
});

test('different views reuse one Base validation read and each get a native query', async () => {
    const { app, reads, queries } = makeApp({
        definitions: { 'Tasks.base': base([{ type: 'table', name: 'Due' }, { type: 'table', name: 'Later' }], {
            filters: { and: ['file.ext == "md"', { not: ['status == "done"'] }] },
            formulas: { overdue: 'scheduled < now()' },
        }) },
        outputs: { 'Tasks.base#Due': 'Inbox/Task.md\r\nInbox/Task.md\r\n', 'Tasks.base#Later': '' },
    });
    const result = await service.resolveReminderBaseViews(app, [reminder(), reminder({ id: 'later', baseView: 'Later' })]);
    assert.deepEqual([...result.get('reminder')], ['Inbox/Task.md']);
    assert.equal(result.get('later').size, 0);
    assert.deepEqual(reads, ['Tasks.base', 'Tasks.base', 'Tasks.base']);
    assert.equal(queries.length, 2);
});

test('saved view list does not query notes or reject another view\'s context-dependent filters', async () => {
    const { app, reads, queries } = makeApp({ definitions: {
        'Tasks.base': base([{ type: 'table', name: 'Due' }, { type: 'table', name: 'Embedded', filters: 'file.hasLink(this.file)' }]),
    } });
    assert.deepEqual(await service.readReminderBaseViews(app, 'Tasks.base'), ['Due', 'Embedded']);
    assert.deepEqual(reads, ['Tasks.base']);
    assert.deepEqual(queries, []);
    await service.resolveReminderBaseViews(app, [reminder()]);
    assert.equal(queries.length, 1);
    await assert.rejects(service.resolveReminderBaseViews(app, [reminder({ baseView: 'Embedded' })]), /context-dependent this/u);
});

test('Base capability is feature-detected without falling back to all files', async () => {
    for (const cli of [undefined, {}, { handlers: {} }, { handlers: new Map() }, { handlers: new Map([['base:query', {}]]) }]) {
        const { app, reads } = makeApp();
        app.cli = cli;
        await assert.rejects(service.resolveReminderBaseViews(app, [reminder()]), /native Bases query capability/u);
        assert.equal(reads.length, 0);
    }
});

test('disabled Base reminders require no file or core query', async () => {
    const { app, reads } = makeApp({ capability: false });
    assert.equal((await service.resolveReminderBaseViews(app, [reminder({ enabled: false, basePath: 'Missing.base' })])).size, 0);
    assert.equal(reads.length, 0);
});

test('unsafe and non-Base paths are rejected before reading', async () => {
    const { app, reads } = makeApp();
    for (const path of ['', '/Tasks.base', '../Tasks.base', 'Folder/../Tasks.base', './Tasks.base', 'C:\\Tasks.base', 'https://host/Tasks.base', 'Tasks.md', 'Tasks.base#Due', 'Tasks\n.base']) {
        await assert.rejects(service.readReminderBaseViews(app, path), /vault-relative .base/u);
    }
    assert.equal(reads.length, 0);
});

test('missing Base, YAML errors and invalid or ambiguous saved view declarations are explicit', async () => {
    const cases = [
        [{}, /was not found/u],
        [{ 'Tasks.base': 'views: [' }, /invalid YAML/u],
        [{ 'Tasks.base': { views: [] } }, /must contain saved views/u],
        [{ 'Tasks.base': base([{ type: 'table', name: '' }]) }, /invalid saved view/u],
        [{ 'Tasks.base': base([{ name: 'Due' }]) }, /invalid saved view/u],
        [{ 'Tasks.base': base([{ type: 'table', name: 'Due' }, { type: 'cards', name: 'Due' }]) }, /duplicate view name/u],
    ];
    for (const [definitions, expected] of cases) {
        const { app, queries } = makeApp({ definitions });
        await assert.rejects(service.readReminderBaseViews(app, 'Tasks.base'), expected);
        assert.equal(queries.length, 0);
    }
});

test('chosen view must exist with its exact saved name', async () => {
    const { app, queries } = makeApp();
    for (const name of ['', 'due', ' Due ', 'Missing']) {
        await assert.rejects(service.resolveReminderBaseViews(app, [reminder({ baseView: name })]), /Choose a saved view|no saved view named/u);
    }
    assert.equal(queries.length, 0);
});

test('unreadable Base cannot become an empty successful result', async () => {
    const { app, queries } = makeApp();
    app.vault.cachedRead = async () => { throw new Error('private file detail'); };
    await assert.rejects(service.resolveReminderBaseViews(app, [reminder()]), /^Error: Cannot read reminder Base "Tasks.base"\.$/u);
    assert.equal(queries.length, 0);
});

test('invalid global or selected-view filter structures are blocked before native query', async () => {
    for (const filters of ['', [], null, 42, { unknown: [] }, { and: 'status' }, { and: [], or: [] }, { not: ['status', 42] }]) {
        for (const global of [false, true]) {
            const definition = global ? base(undefined, { filters }) : base([{ type: 'table', name: 'Due', filters }]);
            const { app, queries } = makeApp({ definitions: { 'Tasks.base': definition } });
            await assert.rejects(service.resolveReminderBaseViews(app, [reminder()]), /invalid filter|and\/or\/not list/u);
            assert.equal(queries.length, 0);
        }
    }
    const { app } = makeApp({ definitions: { 'Tasks.base': base([{ type: 'table', name: 'Due', filters: { and: [] } }]) } });
    assert.equal((await service.resolveReminderBaseViews(app, [reminder()])).get('reminder').size, 1);
});

test('context-dependent this in selected/global filters or formulas is blocked, without inspecting other views', async () => {
    for (const expression of ['file.hasLink(this.file)', 'owner == this', 'this["scheduled"] < now()', 'THIS.file.name == file.name', 'if(true, this, null)']) {
        const definitions = [
            base([{ type: 'table', name: 'Due', filters: expression }]),
            base(undefined, { filters: expression }),
            base(undefined, { formulas: { context: expression } }),
        ];
        for (const definition of definitions) {
            const { app, queries } = makeApp({ definitions: { 'Tasks.base': definition } });
            await assert.rejects(service.resolveReminderBaseViews(app, [reminder()]), /context-dependent this/u);
            assert.equal(queries.length, 0);
        }
    }
});

test('quoted this, escaped strings, identifiers and note properties named this remain valid', async () => {
    for (const expression of [
        'title == "this"', 'title == \'this\'', 'title == "escaped \\\" this"',
        'title == \'escaped \\\' this\'', 'note.this == "value"', 'note. this == "value"',
        'note["this"] == "value"', 'somethingThis == "value"', '$this == "value"',
        'file.properties.this == "value"',
    ]) {
        const { app } = makeApp({ definitions: { 'Tasks.base': base([{ type: 'table', name: 'Due', filters: expression }]) } });
        assert.equal((await service.resolveReminderBaseViews(app, [reminder()])).get('reminder').size, 1, expression);
    }
});

test('invalid formula definitions are rejected and no formula/filter clone runs locally', async () => {
    for (const formulas of [null, [], 'formula', { bad: 42 }, { empty: '' }]) {
        const { app, queries } = makeApp({ definitions: { 'Tasks.base': base(undefined, { formulas }) } });
        await assert.rejects(service.resolveReminderBaseViews(app, [reminder()]), /invalid formula/u);
        assert.equal(queries.length, 0);
    }
    const { app, queries } = makeApp({ definitions: { 'Tasks.base': base(undefined, { formulas: { deadline: 'date(scheduled) + "1d"' } }) } });
    await service.resolveReminderBaseViews(app, [reminder()]);
    assert.equal(queries.length, 1);
});

test('native query failure is surfaced without leaking payloads or replacing membership', async () => {
    const { app } = makeApp({ queryError: new Error('private native payload') });
    await assert.rejects(service.resolveReminderBaseViews(app, [reminder()]), /^Error: Obsidian could not query reminder Base "Tasks.base", view "Due"\.$/u);
});

test('malformed native output and paths that are missing or not Markdown are rejected', async () => {
    for (const output of [null, [], {}, '[{"path":"Inbox/Task.md"}]', 'Missing.md', 'Tasks.base', ' Inbox/Task.md', '../Inbox/Task.md']) {
        const { app } = makeApp({ outputs: { 'Tasks.base#Due': output } });
        await assert.rejects(service.resolveReminderBaseViews(app, [reminder()]), /returned invalid paths/u);
    }
});

test('service imports no polling, event subscriptions, body readers or custom evaluator', () => {
    assert.doesNotMatch(source, /setInterval|setTimeout|registerEvent|\.vault\.read\(|\.vault\.modify\(|getMarkdownFiles|tps-base-formula|evaluateLogBaseFilter/u);
});
