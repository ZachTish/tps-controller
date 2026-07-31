import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import ts from 'typescript';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = resolve(process.env.TPS_CONTROLLER_NOTIFICATION_SOURCE_ROOT || repositoryRoot);
const comparisonRoot = process.env.TPS_CONTROLLER_NOTIFICATION_COMPARE_ROOT
  ? resolve(process.env.TPS_CONTROLLER_NOTIFICATION_COMPARE_ROOT)
  : null;
const logger = { flow() {}, flowError() {} };
const exactBaseline = {
  commit: 'a8c13dbda82caa95807d4fce912334b8feb9583e',
  overdueSourceSha256: '6eb91fccf2aff0e35367dbc7cfd1cac81fc2ca818df8c7e9b8e449d5edf5ac04',
  version: '0.3.5',
};

function loadNotificationOpen(root) {
  const source = readFileSync(join(root, 'src/services/overdue-service.ts'), 'utf8');
  const notificationViewSource = readFileSync(join(root, 'src/views/notification-view.ts'), 'utf8');
  const viewTypeMatch = notificationViewSource.match(
    /export const NOTIFICATION_VIEW_TYPE\s*=\s*['"]([^'"]+)['"]/,
  );
  assert.ok(viewTypeMatch, `Could not find NOTIFICATION_VIEW_TYPE in ${root}`);
  const viewType = viewTypeMatch[1];
  const start = source.indexOf('    async openNotificationModal(): Promise<void> {');
  const end = source.indexOf('    async getOverdueItems(): Promise<OverdueItem[]> {', start);
  assert.notEqual(start, -1, `Could not find openNotificationModal in ${root}`);
  assert.notEqual(end, -1, `Could not find getOverdueItems in ${root}`);

  const methodSection = source.slice(start, end);
  const harnessSource = `
    const logger = injectedLogger;
    const performance = injectedPerformance;
    const NOTIFICATION_VIEW_TYPE = injectedViewType;
    class NotificationOpenHarness {
      constructor(app: any) {
        this.app = app;
      }
${methodSection}
    }
    module.exports = { NotificationOpenHarness };
  `;
  const compiled = ts.transpileModule(harnessSource, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2018,
    },
  });
  const module = { exports: {} };
  const load = new Function(
    'module',
    'exports',
    'injectedLogger',
    'injectedPerformance',
    'injectedViewType',
    compiled.outputText,
  );
  load(module, module.exports, logger, performance, viewType);
  return {
    NotificationOpenHarness: module.exports.NotificationOpenHarness,
    methodSection,
    source,
    viewType,
  };
}

function assertExactReleasedBaseline(root) {
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  const { source, viewType } = loadNotificationOpen(root);
  const sourceHash = createHash('sha256').update(source).digest('hex');
  const commit = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

  assert.equal(manifest.version, exactBaseline.version);
  assert.equal(sourceHash, exactBaseline.overdueSourceSha256);
  assert.equal(commit, exactBaseline.commit);
  assert.equal(viewType, 'tps-notification-view');
}

function createLifecycleScenario(viewType, {
  dataset = Array.from({ length: 1_000 }, (_, index) => ({ path: `Reminder-${index}.md`, due: index })),
  datasetAfterInitial = null,
  existingLeaves = 2,
  explicitRefreshError = null,
  initialRefreshError = null,
  revealError = null,
} = {}) {
  const metrics = {
    activeCalls: 0,
    detachCalls: 0,
    explicitRefreshes: 0,
    getRightLeafCalls: 0,
    initialScans: 0,
    internalReveals: 0,
    itemVisits: 0,
    layoutSaves: 0,
    loadIfDeferredCalls: 0,
    onOpenCalls: 0,
    rightSplitExpands: 0,
    revealCalls: 0,
    setViewStateCalls: 0,
    tabSelections: 0,
  };
  let leaves = Array.from({ length: existingLeaves }, (_, index) => ({ stale: index }));
  let createdLeaf = null;
  let ensureRequest = null;
  let renderedFingerprint = '';
  let visibleDataset = dataset;

  const scan = async (kind) => {
    if (kind === 'initial') metrics.initialScans += 1;
    else metrics.explicitRefreshes += 1;
    if (initialRefreshError && kind === 'initial') throw initialRefreshError;
    if (explicitRefreshError && kind === 'explicit') throw explicitRefreshError;

    let checksum = 0;
    for (const item of visibleDataset) {
      checksum = (checksum + item.path.length * 31 + item.due) >>> 0;
    }
    metrics.itemVisits += visibleDataset.length;
    renderedFingerprint = `${visibleDataset.length}:${checksum}:${visibleDataset[0]?.path || ''}:${visibleDataset.at(-1)?.path || ''}`;
    if (kind === 'initial' && datasetAfterInitial) visibleDataset = datasetAfterInitial;
  };

  const rightSplit = {
    collapsed: true,
    expand() {
      metrics.rightSplitExpands += 1;
      this.collapsed = false;
    },
  };

  const loadViewIfDeferred = async (leaf) => {
    if (leaf.loaded) return;
    leaf.loaded = true;
    metrics.onOpenCalls += 1;
    await scan('initial');
  };

  const revealLeaf = async (leaf, internal) => {
    if (internal) metrics.internalReveals += 1;
    else metrics.revealCalls += 1;
    if (revealError) throw revealError;
    rightSplit.collapsed = false;
    await loadViewIfDeferred(leaf);
  };

  const workspace = {
    rightSplit,
    getLeavesOfType() {
      return leaves;
    },
    detachLeavesOfType() {
      metrics.detachCalls += 1;
      leaves = [];
    },
    async ensureSideLeaf(type, side, options) {
      assert.equal(type, viewType);
      assert.equal(side, 'right');
      ensureRequest = { options, side, type };

      const parent = {
        children: [],
        currentTab: -1,
        selectTabIndex(index) {
          metrics.tabSelections += 1;
          this.currentTab = index;
        },
      };
      createdLeaf = {
        loaded: false,
        parent,
        view: {
          async refresh() {
            await scan('explicit');
          },
        },
        async setViewState() {
          metrics.setViewStateCalls += 1;
        },
        async loadIfDeferred() {
          metrics.loadIfDeferredCalls += 1;
          await loadViewIfDeferred(this);
        },
      };
      parent.children.push(createdLeaf);
      leaves = [createdLeaf];
      if (options?.reveal) await revealLeaf(createdLeaf, true);
      return createdLeaf;
    },
    getRightLeaf() {
      metrics.getRightLeafCalls += 1;
      return createdLeaf;
    },
    async revealLeaf(leaf) {
      await revealLeaf(leaf, false);
    },
    setActiveLeaf(_leaf, options) {
      metrics.activeCalls += 1;
      metrics.focus = options?.focus;
    },
    requestSaveLayout() {
      metrics.layoutSaves += 1;
    },
  };

  return {
    app: { workspace },
    get createdLeaf() {
      return createdLeaf;
    },
    get leaves() {
      return leaves;
    },
    get ensureRequest() {
      return ensureRequest;
    },
    metrics,
    get renderedFingerprint() {
      return renderedFingerprint;
    },
    rightSplit,
  };
}

async function runOpen(root, options) {
  const { NotificationOpenHarness, viewType } = loadNotificationOpen(root);
  const scenario = createLifecycleScenario(viewType, options);
  await new NotificationOpenHarness(scenario.app).openNotificationModal();
  return scenario;
}

test('notification command opens one fresh focused sidebar leaf with one initial scan', async () => {
  const scenario = await runOpen(sourceRoot);
  assert.equal(scenario.leaves.length, 1);
  assert.equal(scenario.leaves[0], scenario.createdLeaf);
  assert.equal(scenario.rightSplit.collapsed, false);
  assert.deepEqual(scenario.metrics, {
    activeCalls: 1,
    detachCalls: 1,
    explicitRefreshes: 0,
    focus: true,
    getRightLeafCalls: 0,
    initialScans: 1,
    internalReveals: 0,
    itemVisits: 1_000,
    layoutSaves: 1,
    loadIfDeferredCalls: 0,
    onOpenCalls: 1,
    rightSplitExpands: 0,
    revealCalls: 1,
    setViewStateCalls: 0,
    tabSelections: 0,
  });
  assert.deepEqual(scenario.ensureRequest, {
    options: { active: true, state: {} },
    side: 'right',
    type: 'tps-notification-view',
  });

  const { methodSection } = loadNotificationOpen(sourceRoot);
  assert.match(methodSection, /ensureSideLeaf\(NOTIFICATION_VIEW_TYPE, "right"/);
  assert.match(methodSection, /await workspace\.revealLeaf\(leaf\)/);
  assert.match(methodSection, /workspace\.setActiveLeaf\(leaf, \{ focus: true \}\)/);
  assert.match(methodSection, /void workspace\.requestSaveLayout\(\)/);
  for (const unsupportedOrRedundantPath of [
    'getRightLeaf',
    'setViewState',
    'rightSplit',
    'activateLeafTab',
    'loadIfDeferred',
    'view as any',
  ]) {
    assert.equal(
      methodSection.includes(unsupportedOrRedundantPath),
      false,
      `Notification open path still uses ${unsupportedOrRedundantPath}`,
    );
  }

});

test('notification command propagates initial view and reveal failures', async () => {
  await assert.rejects(
    runOpen(sourceRoot, { initialRefreshError: new Error('initial-refresh-failed') }),
    /initial-refresh-failed/,
  );
  await assert.rejects(
    runOpen(sourceRoot, { revealError: new Error('reveal-failed') }),
    /reveal-failed/,
  );
});

function percentile(values, ratio) {
  return [...values].sort((left, right) => left - right)[Math.floor((values.length - 1) * ratio)];
}

async function benchmarkOpen(root, dataset, iterations = 300) {
  const { NotificationOpenHarness, viewType } = loadNotificationOpen(root);
  const durations = [];
  let itemVisits = 0;
  let initialScans = 0;
  let explicitRefreshes = 0;
  let onOpenCalls = 0;
  let fingerprint = '';

  for (let index = 0; index < iterations + 20; index += 1) {
    const scenario = createLifecycleScenario(viewType, { dataset });
    const started = performance.now();
    await new NotificationOpenHarness(scenario.app).openNotificationModal();
    const duration = performance.now() - started;
    if (index >= 20) durations.push(duration);
    itemVisits += scenario.metrics.itemVisits;
    initialScans += scenario.metrics.initialScans;
    explicitRefreshes += scenario.metrics.explicitRefreshes;
    onOpenCalls += scenario.metrics.onOpenCalls;
    fingerprint = scenario.renderedFingerprint;
  }

  return {
    explicitRefreshes,
    fingerprint,
    initialScans,
    itemVisits,
    medianMs: percentile(durations, 0.5),
    onOpenCalls,
    p95Ms: percentile(durations, 0.95),
    totalMs: durations.reduce((sum, value) => sum + value, 0),
  };
}

test('notification open candidate is observably equivalent with half the scan work', {
  skip: comparisonRoot == null,
}, async () => {
  assertExactReleasedBaseline(comparisonRoot);
  assert.equal(loadNotificationOpen(comparisonRoot).viewType, loadNotificationOpen(sourceRoot).viewType);
  const dataset = Array.from(
    { length: 20_000 },
    (_, index) => ({ path: `Synthetic/Reminder-${index}.md`, due: (index * 17) % 10_000 }),
  );
  const before = await benchmarkOpen(comparisonRoot, dataset);
  const after = await benchmarkOpen(sourceRoot, dataset);

  assert.equal(after.fingerprint, before.fingerprint);
  assert.equal(before.initialScans, after.initialScans);
  assert.equal(before.onOpenCalls, after.onOpenCalls);
  assert.equal(before.explicitRefreshes, after.initialScans);
  assert.equal(before.itemVisits, after.itemVisits * 2);
  assert.equal(after.explicitRefreshes, 0);

  process.stdout.write(`${JSON.stringify({ before, after })}\n`);
});

async function capturedFailure(root, options) {
  try {
    await runOpen(root, options);
    return null;
  } catch (error) {
    return {
      message: error instanceof Error ? error.message : String(error),
      name: error instanceof Error ? error.name : typeof error,
    };
  }
}

test('exact baseline and candidate share lifecycle failures while the redundant-refresh failure is removed', {
  skip: comparisonRoot == null,
}, async () => {
  assertExactReleasedBaseline(comparisonRoot);
  for (const options of [
    { initialRefreshError: new Error('initial-refresh-failed') },
    { revealError: new Error('reveal-failed') },
  ]) {
    assert.deepEqual(
      await capturedFailure(sourceRoot, options),
      await capturedFailure(comparisonRoot, options),
    );
  }

  const redundantFailure = { explicitRefreshError: new Error('redundant-refresh-failed') };
  assert.deepEqual(
    await capturedFailure(comparisonRoot, redundantFailure),
    { message: 'redundant-refresh-failed', name: 'Error' },
  );
  assert.equal(await capturedFailure(sourceRoot, redundantFailure), null);
});

test('comparison documents the narrower post-initial-scan freshness window', {
  skip: comparisonRoot == null,
}, async () => {
  assertExactReleasedBaseline(comparisonRoot);
  const initial = [{ path: 'Initial.md', due: 1 }];
  const afterInitial = [...initial, { path: 'Added-during-open.md', due: 2 }];
  const before = await runOpen(comparisonRoot, { dataset: initial, datasetAfterInitial: afterInitial });
  const after = await runOpen(sourceRoot, { dataset: initial, datasetAfterInitial: afterInitial });

  assert.match(before.renderedFingerprint, /^2:/);
  assert.match(after.renderedFingerprint, /^1:/);
});
