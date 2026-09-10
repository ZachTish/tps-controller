import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import builtins from "builtin-modules";
import ts from "typescript";
import { build } from "esbuild";
import { webcrypto } from "node:crypto";

const root = fileURLToPath(new URL("../", import.meta.url));
const configuration = readFileSync(new URL("../esbuild.config.mjs", import.meta.url), "utf8");
const syntax = ts.createSourceFile("esbuild.config.mjs", configuration, ts.ScriptTarget.ES2020, true, ts.ScriptKind.JS);
let optionsSyntax;
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(syntax) === "esbuild.context") optionsSyntax = node.arguments[0];
  ts.forEachChild(node, visit);
}
visit(syntax);
assert.ok(optionsSyntax && ts.isObjectLiteralExpression(optionsSyntax), "the production build must declare inspectable esbuild options");
// Read the real production options, but never import/run the configuration or its deployment plugin.
const productionOptions = vm.runInNewContext(`(${optionsSyntax.getText(syntax)})`, {
  banner: "", prod: true, builtins, sourceFolder: "TPS-Controller (Dev)",
  runtimeDeployPlugin: () => ({ name: "disabled-runtime-deployment" }),
});

function loadOnMobile(source) {
  class ObsidianBase { constructor(app, manifest) { this.app = app; this.manifest = manifest; } }
  const obsidian = {
    Plugin: ObsidianBase, PluginSettingTab: ObsidianBase, Modal: ObsidianBase,
    FuzzySuggestModal: ObsidianBase, SuggestModal: ObsidianBase, ItemView: ObsidianBase,
    TextFileView: ObsidianBase, TFile: ObsidianBase, TFolder: ObsidianBase,
    Platform: { isMobile: true, isDesktop: false, isIosApp: true },
    normalizePath: path => path,
  };
  const module = { exports: {} }, imports = [];
  const sandbox = {
    module, exports: module.exports, Buffer: undefined, process: undefined,
    TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, DataView, URL, URLSearchParams,
    AbortController, crypto: webcrypto, console,
    require: name => {
      imports.push(name);
      if (name === "obsidian") return obsidian;
      throw new Error(`Mobile module load requested forbidden dependency: ${name}`);
    },
  };
  sandbox.window = sandbox;
  vm.runInNewContext(source, sandbox, { filename: "controller-mobile.js", timeout: 5000 });
  assert.equal(typeof module.exports.default, "function", "the complete Controller plugin is exported");
  assert.ok(module.exports.default.prototype instanceof ObsidianBase);
  assert.deepEqual([...new Set(imports)], ["obsidian"], "mobile initialization needs only the Obsidian host module");
  assert.equal(sandbox.Buffer, undefined);
  assert.equal(sandbox.process, undefined);
  return module.exports.default;
}

test("the complete production Controller module loads on mobile without Node globals or modules", async () => {
  assert.equal(productionOptions.platform, "browser");
  assert.equal(productionOptions.minify, true);
  assert.equal(productionOptions.format, "cjs");
  const result = await build({ ...productionOptions, absWorkingDir: root, write: false, plugins: [], logLevel: "silent" });
  const Controller = loadOnMobile(result.outputFiles[0].text);
  const plugin = new Controller({}, { id: "tps-controller", version: "fixture" });
  assert.equal(plugin.manifest.id, "tps-controller");
});
