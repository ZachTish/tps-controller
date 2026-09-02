import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

class FakeFile {
  constructor(path) {
    this.path = path;
    this.name = path.split("/").pop();
    this.basename = this.name.replace(/\.md$/iu, "");
    this.extension = "md";
    this.parent = { path: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "" };
  }
}

function normalizePath(value) {
  return String(value || "").replace(/\\/gu, "/").replace(/\/+/gu, "/").replace(/^\/|\/$/gu, "");
}

function loadModule(options = {}) {
  const sourceText = readFileSync(new URL("../src/services/external-event-modal.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(sourceText, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  const module = { exports: {} };
  const logger = {
    errorSummary: (error) => String(error?.message || error),
    flow() {},
    flowError() {},
    flowWarn() {},
    warn() {},
  };
  const requireImpl = (specifier) => {
    if (specifier === "obsidian") {
      return {
        App: class {},
        Modal: class {},
        Notice: class {},
        TFile: FakeFile,
        moment: () => ({ format: () => "2027-01-25", isValid: () => false }),
        normalizePath,
      };
    }
    if (specifier === "../types") return {};
    if (specifier === "../logger") return logger;
    if (specifier === "../utils") {
      return { formatDateTimeForFrontmatter: (date) => date.toISOString() };
    }
    if (specifier === "./parent-child-link") return { createBidirectionalLink: async () => {} };
    if (specifier === "../utils/template-variable-service") {
      return {
        applyTemplateVars: (source) => String(source).replace("{{event}}", "Rendered event"),
        buildExternalEventTemplateVars: () => ({}),
      };
    }
    if (specifier === "../utils/template-resolution-service") {
      return { resolveTemplateFile: async () => options.templateFile || null };
    }
    if (specifier === "../utils/tag-utils") {
      return {
        mergeTagInputs: (existing, tag) => [existing, tag].flat().filter(Boolean),
        normalizeTagValue: (value) => String(value || "").trim(),
      };
    }
    if (specifier === "../core") {
      return {
        getErrorMessage: (error) => String(error?.message || error),
        getPluginById: (app, id) => app.plugins?.getPlugin?.(id) || null,
      };
    }
    if (specifier === "../tps-gcm-api") {
      return {
        buildCalendarExternalId: () => "calendar:protected-test",
        canAutomaticallyMutateSourceViaGcm: (_app, source) => (
          typeof options.canAutomaticallyMutateSource === "function"
            ? options.canAutomaticallyMutateSource(source)
            : true
        ),
        canAutomaticallyMutateViaGcm: async (_app, file) => (
          typeof options.canAutomaticallyMutate === "function"
            ? options.canAutomaticallyMutate(file)
            : true
        ),
        ensureInternalIdInFrontmatter: () => "test-id",
        getExternalId: () => null,
        prepareInstanceSourceViaGcm: (_app, source) => (
          typeof options.prepareInstanceSource === "function"
            ? options.prepareInstanceSource(source)
            : source
        ),
      };
    }
    throw new Error(`Unexpected external-event import: ${specifier}`);
  };
  new Function("module", "exports", "require", compiled.outputText)(module, module.exports, requireImpl);
  return module.exports;
}

function createHarness({ templateSource, templaterTransform = (source) => source } = {}) {
  const files = new Map();
  const folders = new Set([""]);
  const templateFile = templateSource == null ? null : new FakeFile("Templates/Event.md");
  if (templateFile) files.set(templateFile.path, templateSource);
  let creates = 0;
  let frontmatterWrites = 0;
  const app = {
    plugins: {
      getPlugin(id) {
        if (id !== "templater-obsidian") return null;
        return {
          templater: {
            async overwrite_file_commands(file) {
              files.set(file.path, await templaterTransform(files.get(file.path)));
            },
          },
        };
      },
    },
    metadataCache: { getFileCache: () => ({}) },
    workspace: { trigger() {} },
    fileManager: {
      async processFrontMatter() {
        frontmatterWrites += 1;
      },
    },
    vault: {
      configDir: ".obsidian",
      adapter: { fs: { sanitize: (value) => value } },
      getMarkdownFiles: () => [...files.keys()].map((path) => new FakeFile(path)),
      getAbstractFileByPath(path) {
        const normalized = normalizePath(path);
        if (files.has(normalized)) return new FakeFile(normalized);
        return folders.has(normalized) ? { path: normalized } : null;
      },
      async createFolder(path) {
        folders.add(normalizePath(path));
      },
      async create(path, content) {
        const normalized = normalizePath(path);
        creates += 1;
        files.set(normalized, content);
        return new FakeFile(normalized);
      },
      async read(file) {
        return files.get(file.path) ?? "";
      },
      async cachedRead(file) {
        return files.get(file.path) ?? "";
      },
      async process(file, processor) {
        files.set(file.path, processor(files.get(file.path) ?? ""));
      },
    },
  };
  return {
    app,
    files,
    templateFile,
    get creates() { return creates; },
    get frontmatterWrites() { return frontmatterWrites; },
  };
}

function event() {
  return {
    id: "event-1",
    uid: "uid-1",
    title: "Template-safe meeting",
    description: "",
    location: "",
    organizer: "",
    attendees: [],
    url: "",
    sourceUrl: "",
    startDate: new Date("2027-01-25T15:00:00.000Z"),
    endDate: new Date("2027-01-25T15:30:00.000Z"),
    isAllDay: false,
  };
}

test("external event instances strip the template marker before expansion and after Templater", async () => {
  let prepareCalls = 0;
  const templateSource = "---\ntags:\n  - template\n  - keep\n---\n\n{{event}}\n";
  const harness = createHarness({
    templateSource,
    templaterTransform: (source) => source.replace("  - keep", "  - template\n  - keep"),
  });
  const module = loadModule({
    templateFile: harness.templateFile,
    prepareInstanceSource(source) {
      prepareCalls += 1;
      return String(source).replace(/^\s*-\s*template\s*$\r?\n?/gmu, "");
    },
  });

  const file = await module.createMeetingNoteFromExternalEvent(
    harness.app,
    event(),
    harness.templateFile.path,
    "Calendar Events",
    "scheduled",
    "durationMinutes",
    true,
  );

  assert.equal(file.path, "Calendar Events/Template-safe meeting.md");
  assert.equal(harness.creates, 1);
  assert.equal(harness.frontmatterWrites, 1);
  assert.ok(prepareCalls >= 2);
  assert.match(harness.files.get(file.path), /Rendered event/u);
  assert.match(harness.files.get(file.path), /^\s*-\s*keep\s*$/mu);
  assert.doesNotMatch(harness.files.get(file.path), /^\s*-\s*template\s*$/mu);
});

test("external event creation aborts before file creation when GCM rejects template bytes", async () => {
  const templateSource = "---\ntags: [template]\n---\n";
  const harness = createHarness({ templateSource });
  let prepareCalls = 0;
  const module = loadModule({
    templateFile: harness.templateFile,
    prepareInstanceSource: (source) => {
      prepareCalls += 1;
      return prepareCalls === 1 ? null : source;
    },
  });

  await assert.rejects(
    () => module.createMeetingNoteFromExternalEvent(
      harness.app,
      event(),
      harness.templateFile.path,
      "Calendar Events",
      "scheduled",
      "durationMinutes",
      true,
    ),
    /TPS GCM rejected template-derived content/u,
  );
  assert.equal(prepareCalls, 1, "a compatible rejection must not be retried through raw fallback");
  assert.equal(harness.creates, 0);
  assert.equal(harness.frontmatterWrites, 0);
});

test("external event reuse honors current-source protection at the write boundary", async () => {
  const harness = createHarness();
  const existing = new FakeFile("Templates/Existing.md");
  harness.files.set(existing.path, "");
  const module = loadModule({
    canAutomaticallyMutate: async () => true,
    canAutomaticallyMutateSource: () => false,
  });

  const file = await module.createMeetingNoteFromExternalEvent(
    harness.app,
    event(),
    null,
    null,
    "scheduled",
    "durationMinutes",
    true,
    null,
    null,
    undefined,
    undefined,
    undefined,
    existing,
  );

  assert.equal(file, null);
  assert.equal(harness.files.get(existing.path), "");
  assert.equal(harness.frontmatterWrites, 0);
});
