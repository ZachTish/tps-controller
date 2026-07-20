import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const sourceRoot = fileURLToPath(new URL("../src", import.meta.url));

function collectTypeScriptSources(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collectTypeScriptSources(path);
    if (entry.isFile() && extname(entry.name) === ".ts") return [path];
    return [];
  });
}

const sources = collectTypeScriptSources(sourceRoot).map((path) => ({
  path,
  text: readFileSync(path, "utf8"),
}));

test("Controller leaves Notebook Navigator and Obsidian leaf-opening behavior unpatched", () => {
  for (const source of sources) {
    assert.doesNotMatch(
      source.text,
      /\.getLeaf\s*=/,
      `${source.path} must not replace Workspace.getLeaf`,
    );
    assert.doesNotMatch(
      source.text,
      /WorkspaceLeaf\s*(?:\.prototype|\[\s*["']prototype["']\s*\])/,
      `${source.path} must not access the WorkspaceLeaf prototype`,
    );
    assert.doesNotMatch(
      source.text,
      /Object\.getPrototypeOf\([^)]*\)\.(?:openFile|setViewState)\s*=/,
      `${source.path} must not replace leaf methods through a derived prototype`,
    );
    assert.doesNotMatch(
      source.text,
      /installNotebookNavigatorOpenPatch|isNotebookNavigatorOpenRequest|notebookNavigatorPendingOpenRedirect/,
      `${source.path} must not restore the retired Notebook Navigator shim`,
    );
    assert.doesNotMatch(
      source.text,
      /\.closest\(["']\.notebook-navigator["']\)|stack\.includes\(["']notebook-navigator["']\)/,
      `${source.path} must not infer Notebook Navigator ownership from DOM or stack heuristics`,
    );
  }
});
