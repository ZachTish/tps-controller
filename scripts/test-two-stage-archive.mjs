import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const typesSource = readFileSync(new URL('../src/types.ts', import.meta.url), 'utf8');
const mainSource = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const settingsTabSource = readFileSync(new URL('../src/settings-tab.ts', import.meta.url), 'utf8');
const serviceSource = readFileSync(new URL('../src/services/two-stage-archive-service.ts', import.meta.url), 'utf8');

function normalizePathValue(value) {
  return String(value || '')
    .replaceAll('\\', '/')
    .replace(/\/+/g, '/');
}

function loadTwoStageArchiveService(stats) {
  const compiled = ts.transpileModule(serviceSource, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  });
  const module = { exports: {} };
  const noop = () => {};
  const normalizePath = (value) => {
    stats.normalizePathCalls += 1;
    if (value === 'Archive' || value === 'Archive/_archive') {
      stats.configuredRootNormalizations += 1;
    }
    return normalizePathValue(value);
  };
  const requireImpl = (specifier) => {
    if (specifier === 'obsidian') {
      return {
        App: class {},
        TFile: class {},
        normalizePath,
        moment: () => ({
          format: () => '2026-07-30',
        }),
      };
    }
    if (specifier === '../logger') {
      return {
        flow: noop,
        flowWarn: noop,
        flowError: noop,
      };
    }
    if (specifier === '../types') return {};
    throw new Error(`Unexpected two-stage archive import: ${specifier}`);
  };
  new Function('module', 'exports', 'require', compiled.outputText)(module, module.exports, requireImpl);
  return module.exports.TwoStageArchiveService;
}

function createArchiveHarness() {
  const files = [
    ...Array.from({ length: 80 }, (_, index) => ({
      path: `Archive/Batch/File ${String(index).padStart(3, '0')}.md`,
    })),
    ...Array.from({ length: 20 }, (_, index) => ({
      path: `Archive/_archive/Cold/File ${String(index).padStart(3, '0')}.md`,
    })),
    ...Array.from({ length: 450 }, (_, index) => ({
      path: `Outside/File ${String(index).padStart(3, '0')}.md`,
    })),
    ...Array.from({ length: 450 }, (_, index) => ({
      path: `Archive2/File ${String(index).padStart(3, '0')}.md`,
    })),
  ];
  const stats = {
    normalizePathCalls: 0,
    configuredRootNormalizations: 0,
  };
  const existingPaths = new Set([
    'Archive',
    'Archive/_archive',
    'Archive/_archive/Batch',
    'Archive/_archive/Batch/File 000.md',
  ]);
  const renamed = [];
  let saveCount = 0;
  const settings = {
    twoStageArchive: {
      enabled: true,
      sourceFolder: 'Archive',
      destinationFolder: 'Archive/_archive',
      cadence: 'daily',
      checkIntervalMinutes: 60,
      weeklyDay: 0,
      runTime: '23:55',
      lastRunKey: '',
    },
  };
  const app = {
    vault: {
      getFiles: () => files,
      getAbstractFileByPath: (path) => existingPaths.has(path) ? { path } : null,
      createFolder: async (path) => {
        existingPaths.add(path);
      },
      rename: async (file, targetPath) => {
        renamed.push([file.path, targetPath]);
        existingPaths.add(targetPath);
      },
    },
  };
  const TwoStageArchiveService = loadTwoStageArchiveService(stats);
  const service = new TwoStageArchiveService(
    app,
    () => settings,
    async () => {
      saveCount += 1;
    },
  );
  return {
    service,
    settings,
    stats,
    renamed,
    getSaveCount: () => saveCount,
  };
}

test('two-stage archive has safe Archive to _archive defaults', () => {
  assert.match(typesSource, /export interface TwoStageArchiveRule/);
  assert.match(typesSource, /twoStageArchive: TwoStageArchiveRule/);
  assert.match(typesSource, /enabled:\s*false/);
  assert.match(typesSource, /sourceFolder:\s*"Archive"/);
  assert.match(typesSource, /destinationFolder:\s*"_archive"/);
  assert.match(typesSource, /cadence:\s*"monthly-end"/);
  assert.match(typesSource, /runTime:\s*"23:55"/);
});

test('two-stage archive runs only from Controller automation and can be triggered manually', () => {
  assert.match(mainSource, /new TwoStageArchiveService\(this\.app, \(\) => this\.settings, \(\) => this\.saveSettings\(\)\)/);
  assert.match(mainSource, /startTwoStageArchiveLoop\(\)/);
  assert.match(mainSource, /stopTwoStageArchiveLoop\(\)/);
  assert.match(mainSource, /run-two-stage-archive-now/);
  assert.match(mainSource, /Two-stage archive runs on the Controller device/);
  assert.match(mainSource, /this\.settings\.twoStageArchive\?\.enabled/);
  assert.match(mainSource, /this\.twoStageArchiveService\.runIfDue\(\)/);
  assert.match(mainSource, /this\.twoStageArchiveService\.getCheckIntervalMs\(\)/);
});

test('two-stage archive preserves folder structure and does not overwrite collisions', () => {
  assert.match(serviceSource, /isDue\(rule: TwoStageArchiveRule/);
  assert.match(serviceSource, /rule\.lastRunKey === runKey/);
  assert.match(serviceSource, /now\.date\(\) === now\.daysInMonth\(\)/);
  assert.match(serviceSource, /file\.path\.slice\(sourceFolder\.length \+ 1\)/);
  assert.match(serviceSource, /normalizePath\(`\$\{destinationFolder\}\/\$\{relativePath\}`\)/);
  assert.match(serviceSource, /getAvailableTargetPath/);
  assert.match(serviceSource, /while \(this\.app\.vault\.getAbstractFileByPath\(candidate\)\)/);
  assert.match(serviceSource, /candidate = `\$\{withoutExtension\} \$\{counter\}\$\{extension\}`/);
  assert.match(serviceSource, /rule\.lastRunKey = runKey/);
});

test('two-stage archive does not reprocess files already under a nested destination', () => {
  assert.match(serviceSource, /let destinationSkipCount = 0/);
  assert.match(serviceSource, /const sourcePrefix = `\$\{sourceFolder\}\/`/);
  assert.match(serviceSource, /const destinationPrefix = `\$\{destinationFolder\}\/`/);
  assert.match(serviceSource, /const filePath = normalizePath\(file\.path\)/);
  assert.match(serviceSource, /if \(!filePath\.startsWith\(sourcePrefix\)\) return false/);
  assert.match(serviceSource, /if \(filePath\.startsWith\(destinationPrefix\)\) \{/);
  assert.match(serviceSource, /destinationSkipCount \+= 1/);
  assert.match(serviceSource, /logger\.flow\("TwoStageArchive", "run:destination-skip"/);
});

test('two-stage archive normalizes each vault path once while preserving moves, skips, collisions, and cadence', async () => {
  const harness = createArchiveHarness();
  const result = await harness.service.runNow(0);

  assert.deepEqual(result, {
    movedCount: 80,
    skippedCount: 20,
    runKey: '2026-07-30',
    sourceFolder: 'Archive',
    destinationFolder: 'Archive/_archive',
  });
  assert.equal(harness.renamed.length, 80);
  assert.deepEqual(harness.renamed[0], [
    'Archive/Batch/File 000.md',
    'Archive/_archive/Batch/File 000 1.md',
  ]);
  assert.deepEqual(harness.renamed.at(-1), [
    'Archive/Batch/File 079.md',
    'Archive/_archive/Batch/File 079.md',
  ]);
  assert.equal(harness.settings.twoStageArchive.lastRunKey, '2026-07-30');
  assert.equal(harness.getSaveCount(), 1);
  assert.ok(
    harness.stats.normalizePathCalls <= 1_163
      && harness.stats.configuredRootNormalizations <= 3,
    'one archive pass should use at most 1,163 path normalizations and three configured-root normalizations; '
      + `received ${harness.stats.normalizePathCalls} and ${harness.stats.configuredRootNormalizations}`,
  );
});

test('two-stage archive settings expose the monthly Archive to _archive workflow', () => {
  assert.match(settingsTabSource, /Two-Stage Archive/);
  assert.match(settingsTabSource, /Enable Two-Stage Archive/);
  assert.match(settingsTabSource, /Source Folder/);
  assert.match(settingsTabSource, /Destination Folder/);
  assert.match(settingsTabSource, /End of month/);
  assert.match(settingsTabSource, /Run Two-Stage Archive Now/);
  assert.match(settingsTabSource, /Two-stage archive runs on the Controller device/);
  assert.match(settingsTabSource, /restartTwoStageArchiveLoop\(\)/);
});
