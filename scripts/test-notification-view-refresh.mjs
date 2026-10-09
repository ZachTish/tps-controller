import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { load as parseYaml } from 'js-yaml';

class Element {
  constructor(options = {}) { this.className = options.cls || ''; this.textContent = options.text || ''; this.children = []; this.style = {}; this.attributes = {}; }
  createDiv(options = {}) { const child = new Element(options); child.parent = this; this.children.push(child); return child; }
  querySelector(selector) { const cls = selector.slice(1); return this.children.find(child => child.className.split(' ').includes(cls)) || null; }
  prepend(child) { child.remove(); child.parent = this; this.children.unshift(child); }
  setAttr(key, value) { this.attributes[key] = value; }
  setText(value) { this.textContent = value; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
  empty() { this.children = []; }
}

function loadView() {
  const logs = []; const scheduled = [];
  function compile(path, requireStub) {
    const source = readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');
    const module = { exports: {} };
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
    new Function('module', 'exports', 'require', code)(module, module.exports, requireStub);
    return module.exports;
  }
  const obsidian = {
    ItemView: class {
      constructor(leaf) { this.app = leaf.app; this.contentEl = new Element(); }
      addAction() {} registerEvent() {} registerInterval() {}
    },
    Modal: class {}, TFile: class {}, normalizePath: value => value, parseYaml,
    debounce: callback => () => scheduled.push(callback),
  };
  const policy = compile('services/reminder-base-view-service.ts', id => {
    assert.equal(id, 'obsidian'); return obsidian;
  });
  const signature = compile('views/notification-view-signature.ts', id => { throw new Error(`Unexpected signature dependency ${id}`); });
  const { NotificationView } = compile('views/notification-view.ts', id => {
    if (id === 'obsidian') return obsidian;
    if (id === '../modals/snooze-modal') return { SnoozeModal: class {} };
    if (id === '../logger') return { flowError: (...args) => logs.push(args), warn() {} };
    if (id === '../tps-contracts') return { TPS_EVENTS: {}, TPS_LEGACY_EVENTS: {} };
    if (id === '../tps-gcm-api') return { emitFilesUpdated() {} };
    if (id === './notification-view-signature') return signature;
    if (id === '../services/reminder-base-view-service') return policy;
    throw new Error(`Unexpected view dependency ${id}`);
  });
  const item = { sourceKey: 'Inbox/Selected.md', file: { path: 'Inbox/Selected.md', basename: 'Selected' }, reminder: { id: 'one', property: 'scheduled' }, title: 'Retained note', diff: '1 min' };
  const app = { metadataCache: { on() {} }, vault: { on() {} }, workspace: { on() {} } };
  const plugin = { settings: {}, getOverdueItems: async () => [item] };
  const view = new NotificationView({ app }, plugin);
  view.items = [item]; view.lastRenderedSignature = signature.buildNotificationItemsSignature([item]);
  const list = view.contentEl.createDiv({ cls: 'tps-notification-list', text: 'Retained note' });
  let draws = 0;
  // Rendering is unchanged by this fix; retain a bounded draw boundary and
  // exercise the actual refresh/error/status methods against the DOM facade.
  view.draw = () => { draws++; view.contentEl.empty(); view.contentEl.createDiv({ cls: 'tps-notification-list', text: view.items.map(value => value.title).join(', ') }); };
  return { view, item, plugin, logs, scheduled, list, draws: () => draws };
}

test('notification status actions use Base selection policy while retaining terminal/stop behavior', () => {
  const h = loadView();
  h.item.reminder.ignoreStatuses = ['working'];
  assert.equal(h.view.statusHidesItem(h.item, 'working', new Set()), true);
  h.item.reminder.selectionMode = 'base-view';
  assert.equal(h.view.statusHidesItem(h.item, 'working', new Set()), false);
  assert.equal(h.view.statusHidesItem(h.item, 'complete', new Set(['complete'])), true);
  h.item.reminder.stopConditions = ['status:working'];
  assert.equal(h.view.statusHidesItem(h.item, 'working', new Set()), true);
  assert.deepEqual(h.item.reminder.ignoreStatuses, ['working'], 'the mode switch preserves saved custom filters');
});

test('invalid Base refresh keeps the existing list and shows one concise error without rejecting', async () => {
  const h = loadView();
  h.plugin.getOverdueItems = async () => { throw new Error('Reminder Base "Inbox/Missing.base" was not found.'); };
  await assert.doesNotReject(h.view.refresh());
  await assert.doesNotReject(h.view.refresh());
  assert.deepEqual(h.view.items, [h.item]);
  assert.equal(h.view.contentEl.querySelector('.tps-notification-list'), h.list);
  const errors = h.view.contentEl.children.filter(child => child.className === 'tps-notification-error');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].attributes.role, 'alert');
  assert.match(errors[0].textContent, /Notifications could not refresh.*Missing\.base/);
  assert.equal(h.draws(), 0);
  assert.equal(h.logs.length, 1, 'identical errors do not add repeated logging or UI elements');
  assert.equal(h.scheduled.length, 0, 'failure does not create a retry loop');
});

test('a valid unchanged list clears the error without a redundant render', async () => {
  const h = loadView();
  h.plugin.getOverdueItems = async () => { throw new Error('Invalid saved view.'); };
  await h.view.refresh();
  const nextItem = { ...h.item };
  h.plugin.getOverdueItems = async () => [nextItem];
  await h.view.refresh();
  assert.equal(h.view.contentEl.querySelector('.tps-notification-error'), null);
  assert.equal(h.view.contentEl.querySelector('.tps-notification-list'), h.list);
  assert.equal(h.view.items[0], nextItem);
  assert.equal(h.draws(), 0);
});

for (const staleResult of ['list', 'error']) {
  test(`a superseded ${staleResult} refresh cannot replace the current list or error`, async () => {
    const h = loadView();
    let resolveFirst; let rejectFirst; let calls = 0;
    const pending = new Promise((resolve, reject) => { resolveFirst = resolve; rejectFirst = reject; });
    const latest = { ...h.item, title: 'Latest valid result' };
    h.plugin.getOverdueItems = () => ++calls === 1 ? pending : Promise.resolve([latest]);
    const first = h.view.refresh();
    await h.view.refresh();
    assert.equal(calls, 1, 'concurrent calls retain the existing serial queue');
    if (staleResult === 'list') resolveFirst([{ ...h.item, title: 'Stale result' }]);
    else rejectFirst(new Error('Stale invalid Base.'));
    await first;
    assert.equal(h.view.items[0], h.item);
    assert.equal(h.draws(), 0);
    assert.equal(h.view.contentEl.querySelector('.tps-notification-error'), null);
    assert.equal(h.scheduled.length, 1, 'one existing debounced follow-up is queued');
    await h.view.refresh();
    assert.equal(calls, 2);
    assert.equal(h.view.items[0], latest);
    assert.equal(h.draws(), 1);
    assert.equal(h.view.contentEl.querySelector('.tps-notification-error'), null);
  });
}

test('closing a notification view prevents pending errors or queued work from touching its DOM', async () => {
  const h = loadView();
  let reject;
  h.plugin.getOverdueItems = () => new Promise((_resolve, rejectPromise) => { reject = rejectPromise; });
  const pending = h.view.refresh();
  await h.view.refresh();
  await h.view.onClose();
  reject(new Error('Invalid Base after close.'));
  await assert.doesNotReject(pending);
  await h.view.refresh();
  assert.equal(h.view.contentEl.querySelector('.tps-notification-list'), h.list);
  assert.equal(h.view.contentEl.querySelector('.tps-notification-error'), null);
  assert.equal(h.scheduled.length, 0);
  assert.equal(h.logs.length, 0);
});

test('a view closed during initial refresh does not register a post-close interval', async () => {
  const h = loadView(); let resolve; let intervals = 0;
  h.plugin.getOverdueItems = () => new Promise(resolvePromise => { resolve = resolvePromise; });
  const oldWindow = globalThis.window;
  globalThis.window = { setInterval() { intervals++; return intervals; } };
  try {
    const opened = h.view.onOpen();
    await h.view.onClose(); resolve([h.item]); await opened;
    assert.equal(intervals, 0);
    assert.equal(h.view.contentEl.querySelector('.tps-notification-list'), h.list);
  } finally { globalThis.window = oldWindow; }
});
