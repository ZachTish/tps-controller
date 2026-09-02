import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

function loadModule() {
  const sourceText = readFileSync(new URL("../src/tps-gcm-api.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(sourceText, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  const module = { exports: {} };
  const requireImpl = (specifier) => {
    if (specifier === "./tps-contracts") {
      return { TPS_EVENTS: {}, TPS_LEGACY_EVENTS: {} };
    }
    if (specifier === "./types") return {};
    throw new Error(`Unexpected template-protection import: ${specifier}`);
  };
  new Function("module", "exports", "require", compiled.outputText)(module, module.exports, requireImpl);
  return module.exports;
}

function createApp(api) {
  return {
    plugins: {
      getPlugin(id) {
        return id === "tps-global-context-menu" && api ? { api } : null;
      },
      plugins: {},
    },
  };
}

test("Controller preserves legacy behavior when GCM template methods are unavailable", async () => {
  const {
    canAutomaticallyMutateSourceViaGcm,
    canAutomaticallyMutateViaGcm,
    prepareInstanceSourceViaGcm,
  } = loadModule();
  const file = { path: "Templates/Daily.md" };
  const source = "---\ntags: [template]\n---\n";

  assert.equal(await canAutomaticallyMutateViaGcm(createApp(null), file), true);
  assert.equal(canAutomaticallyMutateSourceViaGcm(createApp({ templates: {} }), source), true);
  assert.equal(prepareInstanceSourceViaGcm(createApp({ templates: {} }), source), source);

  const olderApp = createApp({
    templates: {
      version: 0,
      canAutomaticallyMutate: async () => false,
      canAutomaticallyMutateSource: () => false,
      prepareInstanceSource: () => null,
    },
  });
  assert.equal(await canAutomaticallyMutateViaGcm(olderApp, file), true);
  assert.equal(canAutomaticallyMutateSourceViaGcm(olderApp, source), true);
  assert.equal(prepareInstanceSourceViaGcm(olderApp, source), source);
});

test("Controller treats compatible GCM template rejections as authoritative", async () => {
  const {
    canAutomaticallyMutateSourceViaGcm,
    canAutomaticallyMutateViaGcm,
    prepareInstanceSourceViaGcm,
  } = loadModule();
  const file = { path: "Templates/Daily.md" };
  const app = createApp({
    templates: {
      version: 1,
      canAutomaticallyMutate: async (candidate) => candidate.path !== file.path,
      canAutomaticallyMutateSource: () => false,
      prepareInstanceSource: () => null,
    },
  });

  assert.equal(await canAutomaticallyMutateViaGcm(app, file), false);
  assert.equal(canAutomaticallyMutateSourceViaGcm(app, "protected"), false);
  assert.equal(prepareInstanceSourceViaGcm(app, "protected"), null);
});

test("Controller fails closed when compatible GCM template methods throw or return invalid values", async () => {
  const {
    canAutomaticallyMutateSourceViaGcm,
    canAutomaticallyMutateViaGcm,
    prepareInstanceSourceViaGcm,
  } = loadModule();
  const file = { path: "Templates/Daily.md" };
  const throwingApp = createApp({
    templates: {
      version: 1,
      canAutomaticallyMutate: async () => { throw new Error("lookup failed"); },
      canAutomaticallyMutateSource: () => { throw new Error("parse failed"); },
      prepareInstanceSource: () => { throw new Error("prepare failed"); },
    },
  });
  assert.equal(await canAutomaticallyMutateViaGcm(throwingApp, file), false);
  assert.equal(canAutomaticallyMutateSourceViaGcm(throwingApp, "source"), false);
  assert.equal(prepareInstanceSourceViaGcm(throwingApp, "source"), null);

  const invalidApp = createApp({
    templates: {
      version: 1,
      canAutomaticallyMutate: async () => "yes",
      canAutomaticallyMutateSource: () => 1,
      prepareInstanceSource: () => ({ source: "no" }),
    },
  });
  assert.equal(await canAutomaticallyMutateViaGcm(invalidApp, file), false);
  assert.equal(canAutomaticallyMutateSourceViaGcm(invalidApp, "source"), false);
  assert.equal(prepareInstanceSourceViaGcm(invalidApp, "source"), null);
});
