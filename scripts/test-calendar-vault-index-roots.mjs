import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import ts from "typescript";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_ROOT = process.env.TPS_CONTROLLER_SOURCE_ROOT
    ? resolve(process.cwd(), process.env.TPS_CONTROLLER_SOURCE_ROOT)
    : REPOSITORY_ROOT;
const EXPECT_LEGACY_ROOT_REBUILDS = process.env.TPS_EXPECT_LEGACY_ROOT_REBUILDS === "1";

function normalizePathValue(value) {
    return String(value || "")
        .replaceAll("\\", "/")
        .replace(/\/+/g, "/");
}

function normalizeComparablePath(value) {
    return normalizePathValue(value).replace(/^\/+|\/+$/g, "").trim().toLowerCase();
}

function matchesExclusionPattern(path, basename, pattern) {
    const normalizedPattern = normalizeComparablePath(pattern);
    if (!normalizedPattern) return false;
    return path === normalizedPattern
        || path.startsWith(`${normalizedPattern}/`)
        || basename === normalizedPattern;
}

function readCaseInsensitive(record, key) {
    const normalizedKey = String(key || "").trim().toLowerCase();
    const found = Object.keys(record || {}).find((candidate) => candidate.trim().toLowerCase() === normalizedKey);
    return found ? record[found] : undefined;
}

function loadAutoCreateService(stats) {
    const source = readFileSync(join(SOURCE_ROOT, "src/services/auto-create-service.ts"), "utf8");
    const compiled = ts.transpileModule(source, {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2020,
        },
    });
    const module = { exports: {} };
    const noop = () => {};
    const asyncNoop = async () => {};
    const normalizePath = (value) => {
        stats.normalizePathCalls += 1;
        if (stats.configuredRootInputs.has(String(value))) stats.configuredRootNormalizations += 1;
        return normalizePathValue(value);
    };
    const requireImpl = (specifier) => {
        if (specifier === "obsidian") {
            return {
                App: class {},
                Notice: class {},
                TFile: class {},
                normalizePath,
            };
        }
        if (specifier === "../logger") {
            return {
                flow: noop,
                flowWarn: noop,
                flowError: noop,
                warn: noop,
                timeAsync: async (_scope, _event, _data, action) => action(),
            };
        }
        if (specifier === "../types") return {};
        if (specifier === "./external-calendar-service") return { ExternalCalendarService: class {} };
        if (specifier === "./external-event-modal") return { createMeetingNoteFromExternalEvent: asyncNoop };
        if (specifier === "../utils") {
            return {
                formatDateTimeForFrontmatter: (value) => String(value || ""),
                matchesExclusionPattern,
                normalizeCalendarUrl: (value) => {
                    const normalized = String(value || "").trim();
                    return normalized.startsWith("webcal://") ? `https://${normalized.slice(9)}` : normalized;
                },
                normalizeComparablePath,
                parseFrontmatterDate: (value) => {
                    const parsed = new Date(String(value || ""));
                    return Number.isFinite(parsed.getTime()) ? parsed : null;
                },
            };
        }
        if (specifier === "../utils/tag-utils") {
            return { normalizeTagValue: (value) => String(value || "").trim().replace(/^#+/, "") };
        }
        if (specifier === "../tps-gcm-api") {
            return {
                buildCalendarExternalId: () => null,
                emitFilesUpdated: noop,
                ensureDailyNoteForIsoDateViaGcm: async () => ({ available: false, file: null }),
                ensureInternalIdInFrontmatter: asyncNoop,
                getExternalId: (_app, frontmatter) => {
                    const value = readCaseInsensitive(frontmatter, "externalId");
                    return typeof value === "string" && value.trim() ? value.trim() : null;
                },
            };
        }
        if (specifier === "./daily-note-template") {
            return { applyDailyNoteTemplateVariables: (value) => String(value || "") };
        }
        if (specifier === "./external-calendar-cancellation") {
            return { cancelOpenInlineTaskLine: () => null };
        }
        if (specifier === "./external-calendar-inline-task") {
            return {
                addTagToInlineTaskLine: (line) => line,
                ensureInlineTaskTitle: (line) => line,
                findMarkdownBodyStartLine: () => 0,
                findMarkdownCheckboxTaskLineIndexes: (lines) => lines
                    .map((line, index) => (/^\s*(?:[-*+]|\d+[.)])\s+\[[^\]\r\n]?\]\s+/.test(line) ? index : -1))
                    .filter((index) => index >= 0),
                getVisibleInlineTaskText: (line) => line,
                insertTaskLineAfterLeadingTaskBlocks: (content) => content,
                isMarkdownCheckboxTaskLine: (line) => /^\s*(?:[-*+]|\d+[.)])\s+\[[^\]\r\n]?\]\s+/.test(line),
                mutateExternalTaskLineContent: () => ({ content: "", outcome: "not-found", lineIndex: -1 }),
                patchCanonicalInlineTaskMetadata: (line) => line,
                resolveInlineTaskTemporalValues: () => ({ start: "", end: "" }),
                setInlineTaskFieldValue: (line) => line,
            };
        }
        throw new Error(`Unexpected auto-create service import: ${specifier}`);
    };
    new Function("module", "exports", "require", compiled.outputText)(module, module.exports, requireImpl);
    return { AutoCreateService: module.exports.AutoCreateService, source };
}

function makeFile(path) {
    const name = path.split("/").at(-1);
    const extension = name.includes(".") ? name.split(".").at(-1) : "";
    const basename = extension ? name.slice(0, -(extension.length + 1)) : name;
    return { path, name, extension, basename };
}

function createIndexHarness({
    files,
    frontmatter = {},
    contents = {},
    scanRootFolders,
    archiveFolder = "",
    globalIgnorePaths = [],
    onCachedRead = null,
}) {
    const stats = {
        normalizePathCalls: 0,
        configuredRootNormalizations: 0,
        configuredRootInputs: new Set((scanRootFolders || []).filter((value) => typeof value === "string")),
        rootBuilds: 0,
        metadataReads: new Map(),
        contentReads: new Map(),
    };
    const { AutoCreateService, source } = loadAutoCreateService(stats);
    const app = {
        vault: {
            getMarkdownFiles: () => files,
            cachedRead: async (file) => {
                stats.contentReads.set(file.path, (stats.contentReads.get(file.path) || 0) + 1);
                if (onCachedRead) await onCachedRead(file);
                return contents[file.path] || "";
            },
        },
        metadataCache: {
            getFileCache: (file) => {
                stats.metadataReads.set(file.path, (stats.metadataReads.get(file.path) || 0) + 1);
                return Object.hasOwn(frontmatter, file.path)
                    ? { frontmatter: frontmatter[file.path] }
                    : null;
            },
        },
    };
    const service = new AutoCreateService(app);
    service.updateConfig({ scanRootFolders, archiveFolder, globalIgnorePaths });
    const getConfiguredScanRoots = service.getConfiguredScanRoots.bind(service);
    service.getConfiguredScanRoots = () => {
        stats.rootBuilds += 1;
        return getConfiguredScanRoots();
    };
    return {
        service,
        source,
        stats,
        async run() {
            const roots = service.getConfiguredScanRoots();
            const index = await service.buildVaultIndex(roots);
            return { roots, index };
        },
    };
}

function projectIndex(index) {
    return {
        byEventKey: Array.from(index.byEventKey, ([key, note]) => [key, note.file.path]),
        byLegacyEventId: Array.from(index.byLegacyEventId, ([key, notes]) => [key, notes.map((note) => note.file.path)]),
        byUidStart: Array.from(index.byUidStart, ([key, note]) => [key, note.file.path]),
        byTitleDay: Array.from(index.byTitleDay, ([key, note]) => [key, note.file.path]),
        byEventUrl: Array.from(index.byEventUrl, ([key, note]) => [key, note.file.path]),
        allNotes: index.allNotes.map((note) => note.file.path),
    };
}

function assertRootBuildBudget(rootBuilds, minimumLegacyBuilds) {
    if (EXPECT_LEGACY_ROOT_REBUILDS) {
        assert.ok(rootBuilds >= minimumLegacyBuilds, `expected legacy root rebuilding, received ${rootBuilds}`);
        return;
    }
    assert.equal(rootBuilds, 1, "one vault-index invocation must compile its scan roots exactly once");
}

test("vault indexing preserves identity, scope, ignore, inline, trash, archive, and traversal contracts", async () => {
    const filePaths = [
        "Outside/First.md",
        "Calendar/In Scope.md",
        "Calendar/Archive/First.md",
        "Outside/Unarchived.md",
        "Outside/Unarchived Scope.md",
        "Calendar/Archive/In Scope Archived.md",
        "Calendar2/Prefix Sibling.md",
        "Projects/Events/Ignored.md",
        "Projects/Events/Included.md",
        ".trash/Trash.md",
        "Other/Moved.md",
        "Calendar/Unique.md",
        "Outside/Identity Full.md",
        "Calendar/Identity Duplicate.md",
        "Outside/Inline First.md",
        "Calendar/Inline Preferred.md",
    ];
    const files = filePaths.map(makeFile);
    const frontmatter = {
        "Outside/First.md": { externalId: "dup-scope" },
        "Calendar/In Scope.md": { externalId: "dup-scope" },
        "Calendar/Archive/First.md": { externalId: "dup-archive" },
        "Outside/Unarchived.md": { externalId: "dup-archive" },
        "Outside/Unarchived Scope.md": { externalId: "dup-scope-over-archive" },
        "Calendar/Archive/In Scope Archived.md": { externalId: "dup-scope-over-archive" },
        "Calendar2/Prefix Sibling.md": { externalId: "prefix-sibling" },
        "Projects/Events/Ignored.md": { externalId: "ignored-identity" },
        "Projects/Events/Included.md": { externalId: "included-identity" },
        ".trash/Trash.md": { externalId: "trash-identity" },
        "Other/Moved.md": { externalId: "moved-identity" },
        "Calendar/Unique.md": { externalId: "unique-identity" },
        "Outside/Identity Full.md": {
            externalEventId: "legacy-123",
            tpsCalendarUid: "uid-123",
            tpsCalendarSourceUrl: "https://calendar.example/feed.ics",
            scheduled: "2026-07-30T14:00:00.000Z",
            title: "Full Identity",
            url: "https://event.example/item/",
        },
        "Calendar/Identity Duplicate.md": {
            externalEventId: "legacy-123",
            tpsCalendarUid: "uid-123",
            tpsCalendarSourceUrl: "https://calendar.example/feed.ics",
            scheduled: "2026-07-30T14:00:00.000Z",
            title: "Full Identity",
            url: "https://event.example/item/",
        },
    };
    const contents = {
        "Outside/Inline First.md": "- [ ] First inline [externalId:: inline-duplicate]",
        "Calendar/Inline Preferred.md": "- [ ] Preferred inline [externalId:: inline-duplicate]",
    };
    const harness = createIndexHarness({
        files,
        frontmatter,
        contents,
        scanRootFolders: [" Calendar/ ", "/Calendar", "Projects/Events/", "Calendar", 42],
        archiveFolder: "Calendar/Archive",
        globalIgnorePaths: ["Projects/Events/Ignored.md"],
    });
    const { roots, index } = await harness.run();

    assert.deepEqual(roots, ["Calendar/", "Calendar", "Projects/Events"]);
    assert.deepEqual(projectIndex(index), {
        byEventKey: [
            ["dup-scope", "Calendar/In Scope.md"],
            ["dup-archive", "Outside/Unarchived.md"],
            ["dup-scope-over-archive", "Calendar/Archive/In Scope Archived.md"],
            ["prefix-sibling", "Calendar2/Prefix Sibling.md"],
            ["ignored-identity", "Projects/Events/Ignored.md"],
            ["included-identity", "Projects/Events/Included.md"],
            ["moved-identity", "Other/Moved.md"],
            ["unique-identity", "Calendar/Unique.md"],
            ["https://calendar.example/feed.ics::legacy-123", "Calendar/Identity Duplicate.md"],
            ["inline-duplicate", "Calendar/Inline Preferred.md"],
        ],
        byLegacyEventId: [[
            "legacy-123",
            ["Outside/Identity Full.md", "Calendar/Identity Duplicate.md"],
        ]],
        byUidStart: [[
            "https://calendar.example/feed.ics::uid-123|1785420000000",
            "Outside/Identity Full.md",
        ]],
        byTitleDay: [[
            "https://calendar.example/feed.ics::full identity|2026-07-30",
            "Outside/Identity Full.md",
        ]],
        byEventUrl: [["https://event.example/item", "Outside/Identity Full.md"]],
        allNotes: [
            "Calendar/In Scope.md",
            "Calendar/Archive/First.md",
            "Calendar/Archive/In Scope Archived.md",
            "Projects/Events/Included.md",
            "Calendar/Unique.md",
            "Calendar/Identity Duplicate.md",
        ],
    });
    assert.equal(harness.stats.metadataReads.has(".trash/Trash.md"), false);
    assert.equal(harness.stats.contentReads.has(".trash/Trash.md"), false);
    for (const file of files.filter((candidate) => candidate.path !== ".trash/Trash.md")) {
        assert.equal(harness.stats.metadataReads.get(file.path), 1, `metadata read count for ${file.path}`);
        assert.equal(harness.stats.contentReads.get(file.path), 1, `content read count for ${file.path}`);
    }
    assertRootBuildBudget(harness.stats.rootBuilds, files.length);

    if (!EXPECT_LEGACY_ROOT_REBUILDS) {
        assert.match(harness.source, /const scanRoots = this\.getConfiguredScanRoots\(\);/);
        assert.match(harness.source, /this\.buildVaultIndex\(scanRoots\)/);
        assert.match(harness.source, /private async buildVaultIndex\(scanRoots: readonly string\[\]\)/);
        assert.match(harness.source, /private isInConfiguredSyncScope\(file: TFile, roots: readonly string\[\]\)/);
        assert.doesNotMatch(harness.source, /isInConfiguredSyncScope\(file: TFile\): boolean/);
    }
});

test("event-key duplicate preference keeps its released archive and scope ordering in both directions", () => {
    const harness = createIndexHarness({
        files: [],
        scanRootFolders: ["Calendar"],
        archiveFolder: "Calendar/Archive",
    });
    const note = (path, { archived = false, inScope = path.startsWith("Calendar/") } = {}) => ({
        file: makeFile(path),
        isArchived: archived,
        inSyncScope: inScope,
    });
    const cases = [
        {
            name: "later active replaces archived even when it is outside scope",
            existing: note("Calendar/Archive/Existing.md", { archived: true }),
            incoming: note("Outside/Incoming.md"),
            winner: "Outside/Incoming.md",
        },
        {
            name: "later archived in-scope replaces active out-of-scope",
            existing: note("Outside/Existing.md"),
            incoming: note("Calendar/Archive/Incoming.md", { archived: true }),
            winner: "Calendar/Archive/Incoming.md",
        },
        {
            name: "later out-of-scope active does not replace in-scope active",
            existing: note("Calendar/Existing.md"),
            incoming: note("Outside/Incoming.md"),
            winner: "Calendar/Existing.md",
        },
        {
            name: "later in-scope active replaces out-of-scope active",
            existing: note("Outside/Existing.md"),
            incoming: note("Calendar/Incoming.md"),
            winner: "Calendar/Incoming.md",
        },
        {
            name: "same-scope and archive state remains first-wins",
            existing: note("Calendar/Existing.md"),
            incoming: note("Calendar/Incoming.md"),
            winner: "Calendar/Existing.md",
        },
    ];
    for (const fixture of cases) {
        const index = new Map([["shared", fixture.existing]]);
        harness.service.setPreferredEventKey(index, "shared", fixture.incoming);
        assert.equal(index.get("shared").file.path, fixture.winner, fixture.name);
    }
});

test("empty, whole-vault, normalized, boundary, and case-sensitive root semantics remain stable", async () => {
    const files = [
        makeFile("Calendar/Inside.md"),
        makeFile("Calendarish/Prefix.md"),
        makeFile("calendar/Case.md"),
        makeFile("Other/Outside.md"),
    ];
    const frontmatter = Object.fromEntries(files.map((file) => [file.path, { externalId: file.basename }]));
    const cases = [
        { roots: [], expectedRoots: [], allNotes: files.map((file) => file.path) },
        { roots: ["", " / ", ".", "\\"], expectedRoots: [""], allNotes: files.map((file) => file.path) },
        {
            roots: ["Calendar", "Calendar/", "/Calendar/", "Calendar\\"],
            expectedRoots: ["Calendar"],
            allNotes: ["Calendar/Inside.md"],
        },
        { roots: ["calendar"], expectedRoots: ["calendar"], allNotes: ["calendar/Case.md"] },
    ];

    for (const fixture of cases) {
        const harness = createIndexHarness({
            files,
            frontmatter,
            scanRootFolders: fixture.roots,
        });
        const { roots, index } = await harness.run();
        assert.deepEqual(roots, fixture.expectedRoots);
        assert.deepEqual(index.allNotes.map((note) => note.file.path), fixture.allNotes);
        assert.equal(index.byEventKey.size, files.length, "identity matching must remain whole-vault");
        assertRootBuildBudget(harness.stats.rootBuilds, files.length + 1);
    }
});

test("one index uses a coherent root snapshot and the next index observes later settings", async () => {
    const files = [makeFile("First/A.md"), makeFile("Other/B.md")];
    const frontmatter = {
        "First/A.md": { externalId: "first" },
        "Other/B.md": { externalId: "other" },
    };
    let harness;
    let changed = false;
    harness = createIndexHarness({
        files,
        frontmatter,
        scanRootFolders: ["First"],
        onCachedRead: async (file) => {
            if (!changed && file.path === "First/A.md") {
                changed = true;
                harness.service.updateConfig({ scanRootFolders: ["Other"] });
            }
        },
    });
    const first = await harness.run();
    const firstPaths = first.index.allNotes.map((note) => note.file.path);
    if (EXPECT_LEGACY_ROOT_REBUILDS) {
        assert.deepEqual(firstPaths, ["First/A.md", "Other/B.md"]);
    } else {
        assert.deepEqual(firstPaths, ["First/A.md"]);
    }

    const second = await harness.run();
    assert.deepEqual(second.index.allNotes.map((note) => note.file.path), ["Other/B.md"]);
    if (EXPECT_LEGACY_ROOT_REBUILDS) {
        assert.ok(harness.stats.rootBuilds > 2);
    } else {
        assert.equal(harness.stats.rootBuilds, 2);
    }
});

function percentile(sorted, fraction) {
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

async function runBenchmark() {
    const fileCount = Number(process.env.TPS_INDEX_BENCHMARK_FILES || 20_000);
    const rootCount = Number(process.env.TPS_INDEX_BENCHMARK_ROOTS || 40);
    const warmups = Number(process.env.TPS_INDEX_BENCHMARK_WARMUPS || 5);
    const iterations = Number(process.env.TPS_INDEX_BENCHMARK_ITERATIONS || 35);
    const scanRootFolders = Array.from({ length: rootCount }, (_, index) => `Calendars/Root-${index}`);
    const files = Array.from({ length: fileCount }, (_, index) => makeFile(
        index % 167 === 0
            ? `Calendars/Root-${index % rootCount}/Event-${index}.md`
            : `Notes/Batch-${Math.floor(index / 1000)}/Note-${index}.md`,
    ));
    const harness = createIndexHarness({ files, scanRootFolders });
    const samples = [];
    const counters = [];
    for (let iteration = 0; iteration < warmups + iterations; iteration += 1) {
        const rootBuildsBefore = harness.stats.rootBuilds;
        const rootNormalizationsBefore = harness.stats.configuredRootNormalizations;
        const started = performance.now();
        await harness.run();
        const elapsed = performance.now() - started;
        if (iteration >= warmups) {
            samples.push(elapsed);
            counters.push({
                rootBuilds: harness.stats.rootBuilds - rootBuildsBefore,
                rootNormalizations: harness.stats.configuredRootNormalizations - rootNormalizationsBefore,
            });
        }
    }
    const sorted = samples.toSorted((left, right) => left - right);
    process.stdout.write(`${JSON.stringify({
        sourceRoot: SOURCE_ROOT,
        mode: EXPECT_LEGACY_ROOT_REBUILDS ? "released" : "candidate",
        fileCount,
        rootCount,
        iterations,
        medianMs: percentile(sorted, 0.5),
        p95Ms: percentile(sorted, 0.95),
        rootBuildsPerInvocation: counters[0]?.rootBuilds ?? 0,
        rootNormalizationsPerInvocation: counters[0]?.rootNormalizations ?? 0,
    })}\n`);
}

if (process.env.TPS_INDEX_BENCHMARK === "1" || process.argv.includes("--benchmark")) {
    await runBenchmark();
}
